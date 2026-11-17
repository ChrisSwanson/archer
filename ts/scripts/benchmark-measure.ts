/** Reproducible observation, not a timing assertion. Requires a self-contained bundle and leaves only the JSON report. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { connectService, type ServiceClient } from "../src/service/service-client.ts";
import { PROTOCOL_VERSION } from "../src/service/protocol.ts";
import type { OperationResult } from "../src/application/index.ts";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const rounded = (n: number) => Number(n.toFixed(3));
function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
  return {
    count: values.length,
    min: at(0),
    median: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    max: at(1),
    samples: values.map(rounded),
  };
}
async function timed<T>(run: () => Promise<T>): Promise<{ milliseconds: number; result: T }> {
  const start = performance.now();
  const result = await run();
  return { milliseconds: rounded(performance.now() - start), result };
}
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((yes, no) => server.close((error) => (error ? no(error) : yes())));
  return port;
}
function rpc(child: ChildProcessWithoutNullStreams) {
  let next = 0,
    buffer = "";
  const waiting = new Map<
    number,
    { accept: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  const refuse = (error: Error) => {
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    waiting.clear();
  };
  child.on("error", refuse);
  child.on("exit", (code) => refuse(new Error(`MCP relay exited ${code}`)));
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown };
      const pending = message.id === undefined ? undefined : waiting.get(message.id);
      if (!pending) continue;
      waiting.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.accept(message.result!);
    }
  });
  return {
    notify(method: string) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    request(method: string, params: object) {
      const id = ++next;
      return new Promise<Record<string, unknown>>((accept, reject) => {
        waiting.set(id, {
          accept,
          reject,
          timer: setTimeout(() => {
            waiting.delete(id);
            reject(new Error(`${method} exceeded 30s benchmark guard`));
          }, 30_000),
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}
export async function benchmarkMeasurement(
  bundle = join(ROOT, ".scratch-page/dist"),
  out = join(ROOT, ".shots/layout-runtime-benchmark.json"),
) {
  const entry = join(bundle, "archer.js"),
    api = join(bundle, "api.js");
  if (!existsSync(entry) || !existsSync(api)) throw new Error(`Build the bundle first: ${bundle}`);
  const scratch = mkdtempSync("/private/tmp/archer-measure-bench-");
  const project = join(scratch, "project"),
    state = join(scratch, "state");
  mkdirSync(join(project, ".archer"), { recursive: true });
  mkdirSync(state, { mode: 0o700 });
  const heartbeat = readFileSync(join(ROOT, "examples/archer-tour/.archer/diagrams/heartbeat.mmd"), "utf8");
  const heavy = readFileSync(join(ROOT, "tools/devkit/corpus/awkward/.archer/diagrams/flow-large.mmd"), "utf8");
  writeFileSync(join(project, ".archer/heartbeat.mmd"), heartbeat);
  writeFileSync(join(project, ".archer/heavy.mmd"), heavy);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("ARCHER_")),
  );
  Object.assign(env, {
    ARCHER_HOME: join(scratch, "home"),
    XDG_CONFIG_HOME: join(scratch, "config"),
    ARCHER_WRITERS_DIR: join(scratch, "writers"),
    ARCHER_STATE_DIR: state,
    ARCHER_SOCKET: join(scratch, "s.sock"),
    ARCHER_FORCE_HTTP: "true",
    ARCHER_DEBUG: "1",
    ARCHER_AUTO_START: "false",
  });
  let service: ChildProcessWithoutNullStreams | undefined,
    relay: ChildProcessWithoutNullStreams | undefined,
    client: ServiceClient | undefined;
  let serviceLog = "";
  let relayStderrBytes = 0;
  let probing = false;
  let probe: Promise<void> | undefined;
  try {
    const memoryBeforeImport = process.memoryUsage();
    const imported = await timed(
      () =>
        import(pathToFileURL(api).href) as Promise<{
          createApplication(options: object): {
            call(name: string, args: object): Promise<OperationResult>;
            close(): void;
          };
        }>,
    );
    const app = imported.result.createApplication({
      cwd: project,
      env,
      ensureService: () => {
        throw new Error("offline benchmark must stay offline");
      },
    });
    let offline: Record<string, unknown>;
    try {
      const cold = await timed(() => app.call("measure_diagram", { viewId: "heartbeat" }));
      const memoryAfterCold = process.memoryUsage();
      const cache: number[] = [],
        uncached: number[] = [],
        outcomes: unknown[] = [];
      for (let i = 0; i < 10; i++)
        cache.push((await timed(() => app.call("measure_diagram", { viewId: "heartbeat" }))).milliseconds);
      for (let i = 0; i < 10; i++) {
        const source = heartbeat.replace("Question or Idea", `Question ${i} with different context`);
        const sample = await timed(() => app.call("measure_diagram", { viewId: "heartbeat", source }));
        uncached.push(sample.milliseconds);
        outcomes.push(sample.result.structured.status);
      }
      offline = {
        importApiMs: imported.milliseconds,
        coldFirstMeasureMs: cold.milliseconds,
        coldStatus: cold.result.structured.status,
        warmSameRevisionCacheMs: distribution(cache),
        warmWorkerUniqueCandidateRevisionMs: distribution(uncached),
        uniqueCandidateStatuses: outcomes,
        memoryBytes: {
          beforeApiImport: memoryBeforeImport,
          afterColdMeasure: memoryAfterCold,
          afterUncachedMeasures: process.memoryUsage(),
        },
      };
    } finally {
      app.close();
    }
    const port = await freePort();
    service = spawn(process.execPath, [entry, "serve", "--foreground", "--force-http", "--port", String(port)], {
      cwd: project,
      env,
      stdio: "pipe",
    });
    service.stderr.on("data", (chunk: Buffer) => {
      serviceLog += chunk.toString();
    });
    service.stdout.on("data", (chunk: Buffer) => {
      serviceLog += chunk.toString();
    });
    const deadline = Date.now() + 20_000;
    while (!client && Date.now() < deadline) {
      try {
        client = await connectService(env["ARCHER_SOCKET"]!);
      } catch {
        await delay(25);
      }
      if (service.exitCode !== null) throw new Error(`benchmark service exited ${service.exitCode}: ${serviceLog}`);
    }
    if (!client) throw new Error(`benchmark service did not start: ${serviceLog}`);
    const attached = await client.call("attach", { root: project });
    const url = new URL(attached.url),
      token = url.searchParams.get("token")!;
    const metrics = async () => {
      const response = await fetch(`${url.origin}/-/debug/metrics`, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`debug metrics ${response.status}`);
      return (await response.json()) as Record<string, unknown>;
    };
    relay = spawn(process.execPath, [entry, "mcp"], { cwd: project, env, stdio: "pipe" });
    relay.stderr.on("data", (chunk: Buffer) => {
      relayStderrBytes += chunk.byteLength;
    });
    const mcp = rpc(relay);
    await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "layout-benchmark", version: "1" },
    });
    mcp.notify("notifications/initialized");
    const operation = async (name: string, args: object) => {
      const result = await mcp.request("tools/call", { name, arguments: args });
      if (result["isError"] === true) throw new Error(`operation ${name} refused: ${JSON.stringify(result)}`);
      return result["structuredContent"] as Record<string, unknown>;
    };
    await fetch(`${url.origin}/-/debug/reset`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const serviceBefore = await metrics();
    const hello: number[] = [];
    probing = true;
    probe = (async () => {
      while (probing) {
        const sample = await timed(() => client!.call("hello", { protocolVersion: PROTOCOL_VERSION }));
        hello.push(sample.milliseconds);
        await delay(10);
      }
    })();
    const coldService = await timed(() => operation("measure_diagram", { viewId: "heartbeat" }));
    const cached: number[] = [],
      uncached: number[] = [],
      writes: { milliseconds: number; status: unknown; layoutStatus: unknown }[] = [];
    for (let i = 0; i < 10; i++)
      cached.push((await timed(() => operation("measure_diagram", { viewId: "heartbeat" }))).milliseconds);
    for (let i = 0; i < 5; i++)
      uncached.push(
        (
          await timed(() =>
            operation("measure_diagram", {
              viewId: "heartbeat",
              source: heartbeat.replace("Question or Idea", `Service question ${i} and new context`),
            }),
          )
        ).milliseconds,
      );
    const read = await operation("read_diagram", { viewId: "heavy" });
    let revision = read["sourceRevision"];
    for (let i = 0; i < 12; i++) {
      const source = `${heavy}\n%% benchmark revision ${i}\n`;
      const sample = await timed(() =>
        operation("write_diagram", { viewId: "heavy", source, expectedRevision: revision }),
      );
      revision = sample.result["sourceRevision"];
      writes.push({
        milliseconds: sample.milliseconds,
        status: sample.result["status"],
        layoutStatus: (sample.result["layoutReview"] as { status?: unknown } | undefined)?.status,
      });
    }
    const final = await timed(() => operation("measure_diagram", { viewId: "heavy", expectedRevision: revision }));
    probing = false;
    await probe;
    const serviceAfter = await metrics();
    const result = {
      version: 1,
      bundle: relativePath(bundle),
      bundleSha256: Object.fromEntries(
        ["archer.js", "api.js", "layout-worker.js"].map((file) => [
          file,
          createHash("sha256")
            .update(readFileSync(join(bundle, file)))
            .digest("hex"),
        ]),
      ),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      offline,
      service: {
        transport: "bundled MCP relay to bundled foreground service; concurrent management hello",
        relayStderrBytes,
        coldFirstMeasureMs: coldService.milliseconds,
        coldStatus: coldService.result["status"],
        warmSameRevisionCacheMs: distribution(cached),
        warmWorkerUniqueCandidateRevisionMs: distribution(uncached),
        repeatedHeavyWrites: writes,
        finalHeavyMeasureMs: final.milliseconds,
        finalHeavyMeasureStatus: final.result["status"],
        concurrentHelloMs: distribution(hello),
        before: serviceBefore,
        after: serviceAfter,
      },
      limitations: [
        "One local sequential observation, not a throughput guarantee or timing test.",
        "Warm cache uses the exact same revision. Uncached warm-worker candidates alter a visible label and have distinct revisions.",
        "Heavy writes preserve source semantics and alter only a comment; source revisions change and automatic jobs may supersede each other.",
        "Memory RSS includes every worker in that process; driver memory also includes tsx. It is not isolated worker heap or peak memory.",
        "Service event-loop delay is production debug telemetry; a 10ms hello probe is an observer load.",
      ],
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    probing = false;
    await probe?.catch(() => undefined);
    relay?.stdin.end();
    relay?.kill("SIGTERM");
    if (client) {
      try {
        await client.call("stop", {});
      } catch {
        /* Child termination below is the final bound. */
      }
      client.close();
    }
    if (service && service.exitCode === null) {
      service.kill("SIGTERM");
      await Promise.race([once(service, "exit"), delay(5_000)]);
      if (service.exitCode === null) service.kill("SIGKILL");
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}
function relativePath(path: string): string {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const result = await benchmarkMeasurement(
    process.argv[2] ? resolve(process.argv[2]) : undefined,
    process.argv[3] ? resolve(process.argv[3]) : undefined,
  );
  process.stdout.write(
    `${JSON.stringify(result, (key, value: unknown) => (key === "samples" || key === "before" ? undefined : value), 2)}\n`,
  );
}
