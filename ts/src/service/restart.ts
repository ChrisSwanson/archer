// Controlled replacement, preserving the browser's address and durable project state: a warm
// hand-over (ADR 0032). The replacement starts first, warms its compilers and waits; only then is
// the running service asked to hand over, and the replacement takes its locks, port, socket and
// token as soon as it lets go. A replacement that cannot start is a rollback: the running service
// is left as it was. The gap is the old service's stop plus a bind; it does not promise
// transactional write replay.
import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, statSync, unlinkSync } from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isAbsolute, join } from "node:path";
import {
  connectIfRunning,
  connectService,
  defaultServeCommand,
  ServiceCallError,
  ServiceUnavailableError,
  type ServiceClient,
} from "./client.ts";
import { claimRestart, clearRestartMarker, HANDOVER_WAIT_MS } from "./restart-marker.ts";
import { SERVICE_NAME_PATTERN, type RestartConfiguration } from "./protocol.ts";
import { prepareTransport } from "./transport.ts";
import type { Env } from "./paths.ts";

const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "ARCHER_CONFIG", "ARCHER_OPEN_BROWSER"] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A fixed-depth check: never traverses nested values supplied by another process. */
export function parseRestartConfiguration(value: unknown): RestartConfiguration {
  const invalid = (): never => {
    throw new ServiceUnavailableError(
      "The running service returned invalid restart settings; it has not been stopped.",
    );
  };
  if (!object(value)) return invalid();
  const text = (key: string): string => {
    const field = value[key];
    return typeof field === "string" && field.length > 0 && field.length <= 4096 && !field.includes("\0")
      ? field
      : invalid();
  };
  const serviceName = text("serviceName"),
    stateDir = text("stateDir"),
    socketPath = text("socketPath"),
    host = text("host");
  if (!SERVICE_NAME_PATTERN.test(serviceName) || !isAbsolute(stateDir) || !isAbsolute(socketPath) || host.length > 253)
    return invalid();
  const port = value["port"],
    restoreState = value["restoreState"],
    pagePath = value["pagePath"],
    servedPage = value["servedPage"],
    retainedPage = value["retainedPage"];
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof restoreState !== "boolean" ||
    !object(value["launchEnv"])
  )
    return invalid();
  const absolute = (path: unknown): path is string | undefined =>
    path === undefined || (typeof path === "string" && path.length <= 4096 && !path.includes("\0") && isAbsolute(path));
  if (!absolute(pagePath) || !absolute(servedPage) || !absolute(retainedPage)) return invalid();
  const launchEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  for (const key of ENV_KEYS) {
    const field = value["launchEnv"][key];
    if (field !== undefined) {
      if (typeof field !== "string" || field.length > 4096 || field.includes("\0")) return invalid();
      launchEnv[key] = field;
    }
  }
  const raw = value["transport"];
  let transport: RestartConfiguration["transport"];
  if (raw !== undefined) {
    if (!object(raw)) return invalid();
    if (raw["scheme"] === "http" && typeof raw["forceHttp"] === "boolean")
      transport = { scheme: "http", forceHttp: raw["forceHttp"] };
    else if (
      raw["scheme"] === "https" &&
      typeof raw["tlsCert"] === "string" &&
      typeof raw["tlsKey"] === "string" &&
      [raw["tlsCert"], raw["tlsKey"]].every((p) => p.length <= 4096 && !p.includes("\0") && isAbsolute(p))
    )
      transport = { scheme: "https", tlsCert: raw["tlsCert"], tlsKey: raw["tlsKey"] };
    else return invalid();
  }
  return {
    serviceName,
    stateDir,
    socketPath,
    host,
    port,
    restoreState,
    ...(transport === undefined ? {} : { transport }),
    ...(pagePath === undefined ? {} : { pagePath }),
    ...(servedPage === undefined ? {} : { servedPage }),
    ...(retainedPage === undefined ? {} : { retainedPage }),
    launchEnv,
  };
}

/**
 * The running build's page and the previous one it still serves: the replacement keeps the assets of whichever
 * is not its own page (ADR 0032), so a same-build restart keeps the previous build's assets too.
 */
export function handoverPageEnv(
  configuration: RestartConfiguration,
): Partial<Record<"ARCHER_HANDOVER_PREVIOUS_PAGE" | "ARCHER_HANDOVER_RETAINED_PAGE", string>> {
  return {
    ...(configuration.servedPage === undefined ? {} : { ARCHER_HANDOVER_PREVIOUS_PAGE: configuration.servedPage }),
    ...(configuration.retainedPage === undefined ? {} : { ARCHER_HANDOVER_RETAINED_PAGE: configuration.retainedPage }),
  };
}

async function bounded<T>(promise: Promise<T>, deadline: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ServiceUnavailableError(`Archer restart timed out while ${phase}.`)),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RestartResult {
  readonly homeUrl: string;
  readonly version: string;
  readonly gapMs: number;
}

export async function restartService(env: Env, timeoutMs = 15_000): Promise<RestartResult> {
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let stateDir: string | undefined;
  let readyPath: string | undefined;
  try {
    let old;
    try {
      old = await connectIfRunning({ env, signal: controller.signal, exact: true });
    } catch (error) {
      if (controller.signal.aborted) throw new ServiceUnavailableError("Archer restart timed out while connecting.");
      throw error;
    }
    if (old === null) throw new ServiceUnavailableError("Archer is not running; use archer serve to start it.");
    let configuration: RestartConfiguration;
    let replacement: Replacement | undefined;
    let handedOver = false,
      handoverStarted = 0;
    let expectedUrl: string;
    let expectedProjects: readonly string[];
    let launchEnv: Record<string, string | undefined>;
    try {
      configuration = parseRestartConfiguration(
        await bounded(old.call("restartConfiguration", {}), deadline, "checking restart support"),
      );
      if (configuration.transport === undefined)
        throw new ServiceUnavailableError(
          "The running service has no explicit transport policy; choose HTTPS or explicitly force HTTP during manual upgrade. It has not been stopped.",
        );
      // Automatic HTTP stays automatic: the replacement checks again that it is loopback, and the address it binds.
      const transportOptions =
        configuration.transport.scheme === "http"
          ? configuration.transport.forceHttp
            ? { forceHttp: true }
            : {}
          : { tlsCert: configuration.transport.tlsCert, tlsKey: configuration.transport.tlsKey };
      prepareTransport(transportOptions, configuration.host);
      expectedUrl = (await bounded(old.call("hello", { protocolVersion: 1 }), deadline, "checking identity")).homeUrl;
      if (configuration.transport.scheme === "https")
        prepareTransport(transportOptions, new URL(expectedUrl).hostname.replace(/^\[|\]$/g, ""));
      expectedProjects = (await bounded(old.call("listProjects", {}), deadline, "checking projects")).projects
        .map((p) => p.root)
        .sort();
      if (!configuration.restoreState && expectedProjects.length > 0)
        throw new ServiceUnavailableError(
          "Restart requires state restoration to preserve attached projects. The service has not been stopped.",
        );
      if (configuration.pagePath !== undefined) {
        try {
          accessSync(configuration.pagePath, constants.R_OK);
          if (!statSync(configuration.pagePath).isFile()) throw new Error("page is not a file");
        } catch {
          throw new ServiceUnavailableError(
            "The configured Archer page cannot be read; the service has not been stopped.",
          );
        }
      }
      launchEnv = { ...env };
      for (const key of ENV_KEYS) launchEnv[key] = configuration.launchEnv[key];
      Object.assign(launchEnv, {
        ARCHER_FORCE_HTTP:
          configuration.transport.scheme === "http" && configuration.transport.forceHttp ? "true" : "false",
        ARCHER_TLS_CERT: configuration.transport.scheme === "https" ? configuration.transport.tlsCert : undefined,
        ARCHER_TLS_KEY: configuration.transport.scheme === "https" ? configuration.transport.tlsKey : undefined,
      });
      Object.assign(launchEnv, {
        ARCHER_HOST: configuration.host,
        ARCHER_STATE_DIR: configuration.stateDir,
        ARCHER_SOCKET: configuration.socketPath,
        ARCHER_RESTORE_STATE: String(configuration.restoreState),
      });
      const [executable, ...targetArgs] = defaultServeCommand().slice(0, -2);
      if (executable === undefined)
        throw new ServiceUnavailableError("The replacement command is missing; the service has not been stopped.");
      await new Promise<void>((resolve, reject) => {
        execFile(
          executable,
          [...targetArgs, "--version"],
          { env: launchEnv, timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL", maxBuffer: 4096 },
          (error, stdout) => {
            if (error !== null || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/u.test(stdout))
              reject(
                new ServiceUnavailableError(
                  "The replacement Archer executable failed its version preflight; the service has not been stopped.",
                ),
              );
            else resolve();
          },
        );
      });
      await new Promise<void>((resolve, reject) => {
        execFile(
          executable,
          [...targetArgs, "--help"],
          { env: launchEnv, timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL", maxBuffer: 16 * 1024 },
          (error, stdout) => {
            if (
              error !== null ||
              (configuration.transport?.scheme === "http"
                ? !stdout.includes("--force-http")
                : !stdout.includes("--tls-cert") || !stdout.includes("--tls-key")) ||
              !stdout.includes("archer restart") ||
              !stdout.includes("--port") ||
              !stdout.includes("--service") ||
              (configuration.pagePath !== undefined && !stdout.includes("--page"))
            )
              reject(
                new ServiceUnavailableError(
                  "The replacement Archer executable does not advertise compatible restart options; the service has not been stopped.",
                ),
              );
            else resolve();
          },
        );
      });
      // One restart at a time; front doors wait for the hand-over rather than start a service of their own.
      if (!claimRestart(configuration.stateDir, deadline + HANDOVER_WAIT_MS))
        throw new ServiceUnavailableError(
          "Archer: another restart is under way; try again when it finishes. The service has not been stopped.",
        );
      stateDir = configuration.stateDir;
      readyPath = join(stateDir, `handover-${process.pid}-${randomBytes(4).toString("hex")}.ready`);
      const command = [
        ...defaultServeCommand(),
        "--port",
        String(configuration.port),
        "--service",
        configuration.serviceName,
      ];
      if (configuration.pagePath !== undefined) command.push("--page", configuration.pagePath);
      replacement = startReplacement(
        command,
        {
          ...launchEnv,
          ARCHER_HANDOVER_READY: readyPath,
          ARCHER_HANDOVER_WAIT_MS: String(Math.max(1, deadline - Date.now())),
          ...handoverPageEnv(configuration),
        },
        stateDir,
      );
      const failed = await replacement.ready(readyPath, deadline);
      if (failed !== null)
        throw new ServiceUnavailableError(
          `The replacement Archer could not start (${failed}); the running service was left as it was. See ${join(stateDir, "service.log")}.`,
        );
      if (deadline - Date.now() < 1_000)
        throw new ServiceUnavailableError(
          "Archer restart ran out of time before the hand-over; the running service was left as it was.",
        );
      handoverStarted = performance.now();
      // From here the old service may be stopping: the replacement is kept whatever the reply. If the old
      // one never stops, the replacement gives up its own bounded wait and exits; nothing else changes.
      handedOver = true;
      try {
        await bounded(old.call("handover", {}), deadline, "handing over");
      } catch (error) {
        if (error instanceof ServiceCallError) {
          handedOver = false;
          throw error;
        }
      }
      // Until it lets go the old service still answers a new connection's hello (it is draining relayed
      // calls, ADR 0035 §6), so dialing now could reach it, not the replacement, and lose that connection
      // when it ends (O181). It ends this connection when it lets go: wait for that, then dial.
      await bounded(old.ended?.() ?? Promise.resolve(), deadline, "waiting for the running service to hand over").catch(
        () => undefined,
      );
    } catch (error) {
      if (!handedOver) replacement?.kill();
      throw error;
    } finally {
      old.close();
    }
    // The replacement takes the locks, port and socket as soon as the old service lets go.
    let client: ServiceClient | null = null;
    while (client === null) {
      try {
        client = await connectService(configuration.socketPath, configuration.serviceName, controller.signal);
      } catch (error) {
        if (!(error instanceof ServiceUnavailableError || error instanceof ServiceCallError)) throw error;
        const exited = replacement!.exited();
        if (exited !== null)
          throw new ServiceUnavailableError(
            `The replacement Archer stopped after the hand-over (exit ${exited}); run archer serve, and see ${join(configuration.stateDir, "service.log")}.`,
          );
        if (Date.now() >= deadline)
          throw new ServiceUnavailableError(
            "Archer restart timed out waiting for the replacement to answer; see the service log.",
          );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const gapMs = Math.round(performance.now() - handoverStarted);
    try {
      const hello = await bounded(
        client.call("hello", { protocolVersion: 1 }),
        deadline,
        "checking replacement readiness",
      );
      const projects = (await bounded(client.call("listProjects", {}), deadline, "checking restored projects")).projects
        .map((p) => p.root)
        .sort();
      if (hello.homeUrl !== expectedUrl || JSON.stringify(projects) !== JSON.stringify(expectedProjects))
        throw new ServiceUnavailableError(
          "Archer restarted, but its URL or restored projects differ; inspect the service log before continuing.",
        );
      return { homeUrl: hello.homeUrl, version: hello.version, gapMs };
    } finally {
      client.close();
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (readyPath !== undefined) {
      try {
        unlinkSync(readyPath);
      } catch {
        /* not written */
      }
    }
    if (stateDir !== undefined) clearRestartMarker(stateDir);
  }
}

class Replacement {
  #exit: string | null = null;
  constructor(private readonly child: ChildProcess) {
    child.once("exit", (code, signal) => {
      this.#exit = signal ?? String(code ?? -1);
    });
    child.once("error", (error) => {
      this.#exit = error.message;
    });
    child.unref();
  }
  exited(): string | null {
    return this.#exit;
  }
  kill(): void {
    if (this.#exit === null) this.child.kill();
  }
  /** Waits for the replacement to say it is warm; null when it is, else why it is not. */
  async ready(path: string, deadline: number): Promise<string | null> {
    while (!existsSync(path)) {
      if (this.#exit !== null) return `it exited (${this.#exit}) before it was ready`;
      if (Date.now() >= deadline) return "it was not ready in time";
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  }
}

/** Starts the replacement detached, logging to the state directory's service.log as ensureService does. */
function startReplacement(
  command: readonly string[],
  env: Record<string, string | undefined>,
  stateDir: string,
): Replacement {
  const logFd = openSync(
    join(stateDir, "service.log"),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(logFd).isFile()) throw new ServiceUnavailableError("the service log is not a file");
    const [executable, ...args] = command;
    return new Replacement(spawn(executable!, args, { detached: true, stdio: ["ignore", logFd, logFd], env }));
  } finally {
    closeSync(logFd);
  }
}
