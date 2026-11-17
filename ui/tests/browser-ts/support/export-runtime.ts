import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { testPage } from "./page-path";

const TS_ROOT = resolve(import.meta.dirname, "../../../../ts");
const PAGE = testPage();
const BOOTSTRAP = `
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
const [servicePath, optionsPath] = process.argv.slice(2);
const {startService} = await import(pathToFileURL(servicePath).href);
const service = await startService(JSON.parse(readFileSync(optionsPath, "utf8")));
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try { await service.close(); process.exitCode = 0; }
  catch (error) { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; }
};
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
process.stdin.resume();
process.stdin.once("end", () => { void close(); });
console.log("READY");
`;

type Client = {
  call(method: string, params: unknown): Promise<unknown>;
  close(): void;
};

export type ExportProject = {
  readonly url: string;
  readonly dir: string;
  readonly runtimeIdentity: string;
  readonly servicePid: number;
  readonly socketPath: string;
  disconnectLifetime(): void;
  waitForServiceExit(timeoutMs?: number): Promise<boolean>;
  breakSource(): Promise<void>;
  stop(): Promise<void>;
};

export type ExportRuntime = {
  readonly identity: string;
  startProject(options?: { readonly gitHistory?: boolean }): Promise<ExportProject>;
  expectSetupFailureAfterServiceStart(): Promise<{
    readonly dir: string;
    readonly servicePid: number;
    readonly socketPath: string;
  }>;
  close(): Promise<void>;
};

type StartOptions = {
  readonly gitHistory?: boolean;
  readonly failAfterServiceStart?: boolean;
};

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const exited = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", exited);
    };
    child.once("exit", exited);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 5_000))) throw new Error("the export test service did not exit after SIGKILL");
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "",
      stderr = "";
    const timer = setTimeout(
      () => finish(new Error(`export test service readiness timed out: ${stderr.slice(-2000)}`)),
      15_000,
    );
    const finish = (failure?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", output);
      child.stderr?.off("data", error);
      child.off("error", failed);
      child.off("exit", exited);
      if (failure === undefined) {
        child.stdout?.on("data", () => {});
        child.stderr?.on("data", () => {});
        resolveReady();
      } else rejectReady(failure);
    };
    const output = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.split(/\r?\n/).includes("READY")) finish();
    };
    const error = (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `export test service exited before readiness (code=${code}, signal=${signal}): ${stderr.slice(-2000)}`,
        ),
      );
    const failed = (failure: Error) => finish(failure);
    child.stdout?.on("data", output);
    child.stderr?.on("data", error);
    child.once("error", failed);
    child.once("exit", exited);
  });
}

export async function createExportRuntime(): Promise<ExportRuntime> {
  const directory = mkdtempSync(join(tmpdir(), "archer-ui-export-runtime-"));
  const runtime = join(directory, "bundle");
  try {
    const { buildOptions, builtPages, SHIPPED } = (await import(
      pathToFileURL(join(TS_ROOT, "scripts/bundle.ts")).href
    )) as {
      buildOptions(path: string): Record<string, unknown>;
      builtPages(pages: string): unknown;
      SHIPPED: readonly (readonly [string, string])[];
    };
    // The runtime ships this checkout's built pages: without them, say so (`npm run build`), not a bare ENOENT.
    builtPages(dirname(PAGE));
    await build({ ...buildOptions(runtime), entryPoints: { service: join(TS_ROOT, "src/service/service.ts") } });
    writeFileSync(join(runtime, "package.json"), '{"type":"module"}');
    for (const [from, to] of SHIPPED) {
      mkdirSync(dirname(join(runtime, to)), { recursive: true });
      copyFileSync(join(TS_ROOT, from), join(runtime, to));
    }
    const bootstrap = join(directory, "bootstrap.mjs");
    writeFileSync(bootstrap, BOOTSTRAP);
    const identity = createHash("sha256")
      .update(readFileSync(join(runtime, "service.js")))
      .digest("hex");
    const { connectService } = (await import(pathToFileURL(join(TS_ROOT, "src/service/service-client.ts")).href)) as {
      connectService(path: string): Promise<Client>;
    };
    const active = new Set<() => Promise<void>>();
    let lastFailure: { dir: string; servicePid: number; socketPath: string } | undefined;
    let closed = false;

    const start = async (options: StartOptions = {}): Promise<ExportProject> => {
      if (closed) throw new Error("the export test runtime is closed");
      const dir = mkdtempSync(join(tmpdir(), "archer-ui-export-"));
      const root = join(dir, "project"),
        state = join(dir, "state");
      const socketPath = join(state, "archer.sock");
      const configPath = join(dir, "instance.archer.toml");
      const source = join(root, ".archer/flow.mmd");
      let child: ChildProcess | undefined;
      let client: Client | undefined;
      let stopPromise: Promise<void> | undefined;
      const stop = () =>
        (stopPromise ??= (async () => {
          try {
            client?.close();
          } finally {
            try {
              if (child !== undefined) await stopChild(child);
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        })().finally(() => active.delete(stop)));
      try {
        writeFileSync(configPath, "version = 1\n", { mode: 0o600 });
        mkdirSync(join(root, ".archer"), { recursive: true });
        mkdirSync(join(root, "src"));
        writeFileSync(
          join(root, "archer.toml"),
          'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Shop"\nsource = ".archer/flow.mmd"\ncovers = ["src/**"]\n',
        );
        writeFileSync(source, "flowchart LR\n a[Customer]:::external e1@--> b[Shop]\n");
        writeFileSync(join(root, "src/api.ts"), "export const version = 1;\n");
        if (options.gitHistory !== false) {
          const git = (...args: string[]) =>
            execFileSync(
              "git",
              [
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Archer test",
                "-c",
                "user.email=archer-test@example.invalid",
                ...args,
              ],
              {
                cwd: root,
                env: Object.fromEntries(
                  Object.entries({
                    PATH: process.env.PATH,
                    TMPDIR: process.env.TMPDIR,
                    HOME: dir,
                    XDG_CONFIG_HOME: join(dir, ".config"),
                    GIT_CONFIG_GLOBAL: "/dev/null",
                  }).filter((entry): entry is [string, string] => entry[1] !== undefined),
                ),
              },
            );
          git("init", "-q");
          git("add", ".");
          git("commit", "-qm", "Diagram baseline");
          writeFileSync(join(root, "src/api.ts"), "export const version = 2;\n");
        }
        const serviceOptions = join(dir, "service-options.json");
        writeFileSync(
          serviceOptions,
          JSON.stringify({
            forceHttp: true,
            env: {
              HOME: dir,
              XDG_CONFIG_HOME: join(dir, ".config"),
              ARCHER_CONFIG: configPath,
              ARCHER_OPEN_BROWSER: "never",
            },
            stateDir: state,
            socketPath,
            pagePath: PAGE,
          }),
        );
        const childEnv = Object.fromEntries(
          Object.entries({
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, ".config"),
            ARCHER_CONFIG: configPath,
            ARCHER_OPEN_BROWSER: "never",
          }).filter((entry): entry is [string, string] => entry[1] !== undefined),
        );
        child = spawn(process.execPath, [bootstrap, join(runtime, "service.js"), serviceOptions], {
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnv,
        });
        active.add(stop);
        await waitForReady(child);
        if (options.failAfterServiceStart) throw new Error("injected export fixture setup failure");
        client = await connectService(socketPath);
        const { url } = (await client.call("attach", { root })) as { url: string };
        await client.call("present", { root, viewId: "flow", annotation: "Customer checkout" });
        await client.call("setEmphasis", {
          root,
          viewId: "flow",
          emphases: [
            {
              id: "focus",
              title: "Checkout flow",
              groups: [{ id: "customers", label: "customers", nodes: ["a"], edges: ["e1"], style: "flow" }],
            },
          ],
        });
        return {
          url,
          dir,
          runtimeIdentity: identity,
          servicePid: child.pid!,
          socketPath,
          disconnectLifetime() {
            child!.stdin?.end();
          },
          waitForServiceExit(timeoutMs = 5_000) {
            return waitForExit(child!, timeoutMs);
          },
          async breakSource() {
            writeFileSync(source, "flowchart LR\n broken???\n");
            await client!.call("getModel", { root, viewId: "flow" });
          },
          stop,
        };
      } catch (failure) {
        if (child?.pid !== undefined) lastFailure = { dir, servicePid: child.pid, socketPath };
        await stop();
        throw failure;
      }
    };

    return {
      identity,
      startProject: (options) => start(options),
      async expectSetupFailureAfterServiceStart() {
        try {
          await start({ gitHistory: false, failAfterServiceStart: true });
        } catch (failure) {
          if (!(failure instanceof Error) || failure.message !== "injected export fixture setup failure") throw failure;
          if (lastFailure === undefined) throw new Error("the failed setup did not start a service process");
          return lastFailure;
        }
        throw new Error("the injected export fixture setup failure did not fail");
      },
      async close() {
        if (closed) return;
        closed = true;
        const failures = await Promise.allSettled([...active].map((stop) => stop()));
        try {
          const rejected = failures.find((result) => result.status === "rejected");
          if (rejected?.status === "rejected") throw rejected.reason;
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (failure) {
    rmSync(directory, { recursive: true, force: true });
    throw failure;
  }
}
