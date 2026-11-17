// The front doors' way to the service: connect to the one running, or start
// one detached and wait until it answers `hello`. The client itself (one per
// connection, newline-delimited JSON) lives in service-client.ts, shared by
// every adapter without a dependency on a transport.
//
// Every URL a front door shows comes from the service over the socket (hello,
// attach, present), never from the state file: only the service knows which
// port it actually holds.
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { HANDOVER_WAIT_MS, restartInProgress } from "./restart-marker.ts";
import {
  connectService,
  InstanceChoiceError,
  ProtocolMismatchError,
  ServiceCallError,
  ServiceStartError,
  ServiceUnavailableError,
  type InstanceChoice,
  type InstanceChoiceOption,
  type RunningCopy,
  type ServiceClient,
} from "./service-client.ts";
import { checkSocketPath, ensureServiceDir, serviceDirs, type Env } from "./paths.ts";
import { compareVersions, instanceKind, listInstances, type InstanceEntry } from "./instances.ts";
import { readPreferences, type InstancesMode } from "../config/preferences.ts";
import { PROTOCOL_VERSION, type Results } from "./protocol.ts";
import { version as currentVersion } from "../version.ts";
import { isSandboxRefusal, withSandboxHint } from "./sandbox.ts";

export {
  connectService,
  InstanceChoiceError,
  ServiceCallError,
  ServiceStartError,
  ServiceUnavailableError,
  type EnsureService,
  type InstanceChoice,
  type ServiceClient,
} from "./service-client.ts";

export interface EnsureOptions {
  readonly env?: Env;
  /** Identity the socket must report when one is selected explicitly. */
  readonly serviceName?: string;
  /** Overrides the state directory; the socket is then `<stateDir>/archer.sock` unless given. */
  readonly stateDir?: string;
  readonly socketPath?: string;
  /** The command that runs the service in the foreground; `defaultServeCommand()` otherwise. */
  readonly command?: readonly string[];
  readonly timeoutMs?: number;
  /** Cancels pending socket handshakes and an unready child owned by this call. */
  readonly signal?: AbortSignal;
  /** Explicit true overrides ARCHER_AUTO_START=false for a user-requested start. */
  readonly autoStart?: boolean;
  /** Only this state directory's socket: no other running copy is considered (restart). */
  readonly exact?: boolean;
  /** This front door's version, compared with the running main one's; this build's by default. */
  readonly version?: string;
}

/**
 * The command that starts the service: `node <bundle> serve --foreground`
 * from the bundle, or this repository's development entry under tsx.
 */
export function defaultServeCommand(): string[] {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith(".ts")) {
    const tsx = join(createRequire(import.meta.url).resolve("tsx/package.json"), "..", "dist", "loader.mjs");
    return [
      process.execPath,
      "--import",
      pathToFileURL(tsx).href,
      fileURLToPath(new URL("./entry.ts", import.meta.url)),
      "serve",
      "--foreground",
    ];
  }
  // esbuild may put this shared module beside the entry or in chunks/.
  // process.argv[1] belongs to the importing application when used through api.js.
  const candidates = ["./archer.js", "../archer.js"].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  );
  const entry = candidates.find((candidate) => existsSync(candidate));
  if (entry === undefined)
    throw new ServiceUnavailableError("cannot locate Archer's bundled entry; supply an explicit service command");
  return [process.execPath, serveEntryFor(entry), "serve", "--foreground"];
}

/**
 * The bundle a service is started from. An installed copy (`<data>/versions/<id>/dist/archer.js`) starts
 * the one installed now, `<data>/current`, by its version folder: a session's relay may run an older copy,
 * and a service started from it would be an older build the version check reuses, or a removed folder (O45).
 */
export function serveEntryFor(entry: string): string {
  const dist = dirname(entry),
    copy = dirname(dist),
    versions = dirname(copy);
  if (dist.split(/[\\/]/).pop() !== "dist" || versions.split(/[\\/]/).pop() !== "versions") return entry;
  try {
    return realpathSync(join(dirname(versions), "current", "dist", "archer.js"));
  } catch {
    return entry;
  }
}

function locate(options: EnsureOptions): { stateDir: string; socketPath: string } {
  const dirs = serviceDirs(options.env ?? process.env);
  const stateDir = options.stateDir ?? dirs.stateDir;
  const socketPath =
    options.socketPath ?? (options.stateDir === undefined ? dirs.socketPath : join(stateDir, "archer.sock"));
  return { stateDir, socketPath };
}

/** A client on the service at this caller's socket, or null when none answers. */
async function connectHere(
  options: EnsureOptions,
  socketPath = locate(options).socketPath,
): Promise<ServiceClient | null> {
  try {
    return await connectService(socketPath, options.serviceName, options.signal);
  } catch (error) {
    // A refused connect (a sandbox) is not an absent service: starting another would only fail too.
    if (
      error instanceof ServiceUnavailableError &&
      /cannot reach/.test(error.message) &&
      !isSandboxRefusal(error.message)
    )
      return null;
    // A service handing over or stopping is as good as gone: its replacement, or a new start, answers next.
    if (error instanceof ServiceCallError && error.error.code === "service_stopping") return null;
    throw error;
  }
}

/**
 * While `archer restart` hands over (its marker in the state directory, ADR 0032), the replacement
 * this caller's socket will answer on, waiting at most HANDOVER_WAIT_MS; null when no restart is under way.
 */
async function awaitHandOver(options: EnsureOptions): Promise<ServiceClient | null> {
  const { stateDir } = locate(options);
  const until = Date.now() + HANDOVER_WAIT_MS;
  if (!restartInProgress(stateDir)) return null;
  while (Date.now() < until && !options.signal?.aborted) {
    const client = await connectHere(options);
    if (client !== null) return client;
    if (!restartInProgress(stateDir)) return connectHere(options);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new ServiceUnavailableError(
    "Archer is restarting and its replacement has not answered yet; try again in a moment.",
  );
}

/**
 * A client on the running service, or null when none answers; never starts one and never asks.
 * The main socket as before (an older build too); with `instances: reuse-any`, another main copy.
 */
export async function connectIfRunning(options: EnsureOptions = {}): Promise<ServiceClient | null> {
  const here = (await connectHere(options)) ?? (await awaitHandOver(options));
  if (here !== null || isolatedCaller(options)) return here;
  const env = options.env ?? process.env;
  if (readPreferences(env).instances !== "reuse-any") return null;
  return reuseOther(options, otherCopies(options));
}

/** An explicit state directory or socket (tests, evals, demos, restart) gets its own instance only. */
function isolatedCaller(options: EnsureOptions): boolean {
  const env = options.env ?? process.env;
  const socketOverride = env["ARCHER_SOCKET"];
  return (
    options.exact === true ||
    options.socketPath !== undefined ||
    (socketOverride !== undefined && isAbsolute(socketOverride)) ||
    instanceKind(locate(options).stateDir, env) === "isolated"
  );
}

/** Compatible main copies on another default state directory, newest version first. */
function otherCopies(options: EnsureOptions): InstanceEntry[] {
  const mine = resolve(locate(options).stateDir);
  return listInstances(options.env ?? process.env)
    .filter(
      (entry) =>
        entry.kind === "main" &&
        entry.protocolVersion === PROTOCOL_VERSION &&
        resolve(entry.stateDir) !== mine &&
        (options.serviceName === undefined || entry.serviceName === options.serviceName),
    )
    .sort((a, b) => compareVersions(b.version, a.version) || b.startedAt.localeCompare(a.startedAt));
}

async function reuseOther(options: EnsureOptions, copies: readonly InstanceEntry[]): Promise<ServiceClient | null> {
  for (const copy of copies) {
    try {
      return await connectService(copy.socketPath, options.serviceName, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
  }
  return null;
}

const copyOf = (entry: InstanceEntry): RunningCopy => ({
  kind: entry.kind,
  version: entry.version,
  protocolVersion: entry.protocolVersion,
  stateDir: entry.stateDir,
  url: entry.url,
  pid: entry.pid,
  registered: true,
});

/**
 * ADR 0031's rules for a front door that may start the service: the client to use, null to start
 * this caller's own, or InstanceChoiceError when the choice is the person's.
 */
async function discover(options: EnsureOptions): Promise<ServiceClient | null> {
  if (isolatedCaller(options)) return connectHere(options);
  const env = options.env ?? process.env;
  const mine = options.version ?? currentVersion();
  const { stateDir, socketPath } = locate(options);
  let main: ServiceClient | null;
  let incompatible: ProtocolMismatchError | null = null;
  try {
    main = await connectHere(options);
  } catch (error) {
    if (!(error instanceof ProtocolMismatchError)) throw error;
    main = null;
    incompatible = error;
  }
  const preferences = readPreferences(env);
  const mode = preferences.instances;
  const mainCopy = (hello: { version: string; protocolVersion: number }): RunningCopy => {
    const registered = listInstances(env).find((entry) => resolve(entry.socketPath) === resolve(socketPath));
    return registered !== undefined
      ? copyOf(registered)
      : { kind: "main", version: hello.version, protocolVersion: hello.protocolVersion, stateDir, registered: false };
  };
  const choose = (reason: InstanceChoice["reason"], running: RunningCopy[], choices: InstanceChoiceOption[]): never => {
    const details: InstanceChoice = {
      reason,
      mode,
      running,
      options: choices,
      preferences: preferences.path,
      warnings: preferences.warnings,
    };
    throw new InstanceChoiceError(choiceText(details, mine), details);
  };
  const record = (to: InstancesMode): string => `archer preferences set instances ${to} --note "<the person's words>"`;
  if (main !== null) {
    let hello: Results["hello"];
    try {
      hello = await main.call("hello", { protocolVersion: PROTOCOL_VERSION });
    } catch (error) {
      main.close();
      throw error;
    }
    if (compareVersions(hello.version, mine) >= 0 || mode !== "ask") return main;
    main.close();
    return choose(
      "main_older",
      [mainCopy(hello)],
      [
        { id: "reuse-main", label: `keep using the running main Archer (${hello.version})`, run: record("reuse-main") },
        {
          id: "restart-main",
          label: `replace it with this version (${mine}), keeping its address and projects`,
          run: "archer restart",
        },
      ],
    );
  }
  // A hand-over under way: its replacement comes on this socket (awaitHandOver); no other copy is a choice.
  if (incompatible === null && restartInProgress(stateDir)) return null;
  const others = otherCopies(options);
  if (incompatible !== null) {
    if (mode === "reuse-any") {
      const reused = await reuseOther(options, others);
      if (reused !== null) return reused;
    }
    return choose(
      "main_incompatible",
      [mainCopy(incompatible.hello), ...others.map(copyOf)],
      [
        {
          id: "stop-main",
          label: `stop the main Archer (${incompatible.hello.version}, protocol ${incompatible.hello.protocolVersion}) so this version starts`,
          run: "archer stop --stale --include-main",
        },
        ...(others.length === 0
          ? []
          : [{ id: "reuse-any" as const, label: "use another running copy listed here", run: record("reuse-any") }]),
      ],
    );
  }
  if (others.length === 0 || mode === "reuse-main") return null;
  if (mode === "reuse-any") return reuseOther(options, others);
  return choose("other_copies", others.map(copyOf), [
    { id: "reuse-any", label: "use the running copy listed here", run: record("reuse-any") },
    { id: "start-new", label: `start this one on ${stateDir}`, run: record("reuse-main") },
  ]);
}

const REASONS: Record<InstanceChoice["reason"], (running: RunningCopy, mine: string) => string> = {
  main_older: (copy, mine) => `the main Archer running is ${copy.version}, older than this one (${mine})`,
  main_incompatible: (copy) =>
    `the main Archer running (${copy.version}) speaks protocol ${copy.protocolVersion}, not ${PROTOCOL_VERSION}`,
  other_copies: () => "Archer is not running on this state directory, but another copy is",
};

function choiceText(choice: InstanceChoice, mine: string): string {
  const running = choice.running.map(
    (copy) =>
      `- ${copy.kind} ${copy.version}${copy.url === undefined ? "" : ` at ${copy.url}`} (state ${copy.stateDir}${copy.pid === undefined ? "" : `, pid ${copy.pid}`})`,
  );
  const options = choice.options.map((option) => `- ${option.label}: ${option.run}`);
  return [
    `instance_choice_needed: ${REASONS[choice.reason](choice.running[0]!, mine)}. Ask the person which they want, run the command for their choice, then try again; follow ${choice.preferences} from then on.`,
    ...running,
    "Options:",
    ...options,
    ...choice.warnings.map((warning) => `Warning (${choice.preferences}): ${warning}`),
  ].join("\n");
}

/**
 * A client on the user's service, starting one first if none answers: the
 * service runs detached, logging to `service.log` in the state directory,
 * and this waits until it answers `hello`. Two front doors racing to start it
 * end on the same service: the second one to bind refuses and exits.
 */
export async function ensureService(options: EnsureOptions = {}): Promise<ServiceClient> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(new StartDeadline()), timeoutMs);
  const signal =
    options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
  try {
    return await ensureServiceWithinDeadline({ ...options, signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The abort reason when ensureService's own deadline passes, rather than its caller's signal. */
class StartDeadline extends Error {}

async function ensureServiceWithinDeadline(options: EnsureOptions): Promise<ServiceClient> {
  const checkCancelled = (): void => {
    if (options.signal?.aborted) throw new ServiceStartError("Archer service startup was cancelled or timed out");
  };
  checkCancelled();
  const running = (await discover(options)) ?? (await awaitHandOver(options));
  if (running !== null) return running;
  checkCancelled();

  const { stateDir, socketPath } = locate(options);
  const env = options.env ?? process.env;
  const configured = env["ARCHER_AUTO_START"];
  if (
    options.autoStart === undefined &&
    configured !== undefined &&
    configured !== "" &&
    !["true", "false", "1", "0"].includes(configured)
  )
    throw new ServiceUnavailableError("ARCHER_AUTO_START must be true, false, 1 or 0");
  if (!(options.autoStart ?? (configured !== "false" && configured !== "0")))
    throw new ServiceUnavailableError(
      "Archer automatic startup is disabled; run start_service or archer serve to start it explicitly.",
    );
  // The service refuses this path too, but only in its log: say so now rather than wait out the deadline.
  try {
    checkSocketPath(socketPath);
  } catch (error) {
    throw new ServiceUnavailableError((error as Error).message);
  }
  ensureServiceDir(stateDir, env, "the state directory");
  ensureServiceDir(dirname(socketPath), env, "the socket's directory");
  const logPath = join(stateDir, "service.log");
  const logFd = openSync(
    logPath,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  // The log is append-only: a failure reports what this start wrote, not earlier runs' lines.
  const logStart = fstatSync(logFd).size;
  const [command, ...args] = options.command ?? defaultServeCommand();
  if (command === undefined) throw new Error("no command to start the service with");
  checkCancelled();
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...env,
      ...(options.stateDir === undefined ? {} : { ARCHER_STATE_DIR: stateDir }),
      ...(options.socketPath === undefined ? {} : { ARCHER_SOCKET: socketPath }),
    },
  });
  closeSync(logFd);
  let exited: number | null = null;
  child.once("exit", (code) => (exited = code ?? -1));
  child.once("error", () => (exited = -1));
  child.unref();
  const cancelChild = (): void => {
    child.kill();
  };
  options.signal?.addEventListener("abort", cancelChild, { once: true });

  // One deadline, one message (O30): it names the log and what this start wrote to it.
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timedOut = (): ServiceStartError => {
    const written = tail(logPath, logStart);
    return new ServiceStartError(
      `the Archer service did not answer within ${timeoutMs} ms${written === "" ? `; see ${logPath}` : `:\n${written}\n(full log: ${logPath})`}`,
    );
  };
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      checkCancelled();
      const answered = await connectHere(options, socketPath);
      if (answered !== null) return answered;
      if (exited !== null) {
        // Another front door may have won the race to start it.
        const raced = await connectHere(options, socketPath);
        if (raced !== null) return raced;
        throw new ServiceStartError(
          withSandboxHint(
            `the Archer service exited (${exited}) before answering:\n${tail(logPath, logStart)}\n(full log: ${logPath})`,
          ),
        );
      }
      await new Promise((ok) => setTimeout(ok, 50));
    }
    child.kill();
    throw timedOut();
  } catch (error) {
    child.kill();
    // Whichever step the deadline cut short (a connect, the exit it caused), the deadline is the cause.
    if (options.signal?.reason instanceof StartDeadline) throw timedOut();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancelChild);
  }
}

/** The last lines written from byte `from` on, each distinct line once. */
function tail(path: string, from: number): string {
  try {
    const lines = readFileSync(path)
      .subarray(from)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    return [...new Set(lines)].slice(-20).join("\n");
  } catch {
    return "";
  }
}
