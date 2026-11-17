#!/usr/bin/env node
// S9 service latency and capacity under the §6 concurrency protocol (docs/quality/rubrics/performance.md §3 S9, §5,
// §6 "Concurrency"): four browser tabs on different surfaces, one CLI `export_diagram` and one agent write
// (`write_diagram` over MCP, after `read_diagram` for its expectedRevision), all at once, for N rounds.
//
//   node tools/perf/service-load.mjs [--sandbox <running sandbox> | --name <new sandbox name>] [--rounds 5]
//        [--pause-ms 2000] [--sample-ms 1000] [--out <dir>] [--seed-fault lag] [--timeout 60000]
//
// Without --sandbox it starts its own devkit sandbox (ARCHER_DEBUG=1, the production page ui/dist) and stops it at
// the end. Per run:
//   1. compile and thumbnail cold/warm: two GETs of one embedded diagram (api/notes/diagram, the `compile` phase) and
//      two of one thumbnail at a revision just written (api/thumbnails, `render` on a miss, `fs` on a hit);
//   2. POST /-/debug/reset, then /-/debug/metrics (the service's own token) every --sample-ms, with the service
//      process's CPU ticks from /proc/<pid>/stat, during the rounds and the pauses between them;
//   3. tabs on projects, project-folders, a diagram and a note of project `awkward` (4 event streams: the cap is 8 per
//      grant, ts/src/service/streams.ts); each round reloads all four while the CLI export and the agent write run;
//   4. every response's Server-Timing from the browser (Playwright response headers), rounds only (opening the tabs is
//      warm-up): per route n/p50/p95 of `total` and phase coverage (lib/service-load.mjs COVERAGE).
// Writes <out>/service-load.json and service-load.md. Exit 0 ok; 1 a route lacks phase coverage (or a response has no Server-Timing total: NOT EVALUATED) or event-loop lag
// passed the service's own warning threshold (100 ms); 2 error; 3 interrupted. Regression against the last release
// is the paired estimator's call (lib/compare.mjs, fed by pairingMetrics in the JSON), not this exit code.
//
// --seed-fault lag: a known failing case. The tool starts its own sandbox with NODE_OPTIONS=--import <out>/fault-lag.mjs,
// a preload that, in the `archer serve` process only, blocks the event loop for 200 ms every second. Lag must rise
// over the threshold and the run exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { down, readRecord, sandboxEnv, up } from "../devkit/sandbox.mjs";
import { cliCall, mcpSession } from "../devkit/security/lib/agent-clients.mjs";
import { parseServerTiming } from "./lib/report.mjs";
import {
  dropReplays,
  markdown,
  metricsSummary,
  pairingMetrics,
  phaseCoverage,
  routeStats,
} from "./lib/service-load.mjs";
import { resolveTargets } from "./page-load.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const require = createRequire(join(REPO, "package.json"));
const PROJECT = "awkward";
const NOTE = "notes/auth.md";
const DIAGRAM = "diagrams/flow-styled.mmd";
const EXPORT_VIEW = "flow-styled";
const COMPILE_ADDRESS = "notes/embedded-families.md#er";
const SCRATCH = "perf-scratch";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cleanups = new Set();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (interrupted) process.exit(3);
    interrupted = true;
    process.stderr.write(`\nservice-load: ${signal}; tearing down\n`);
    Promise.allSettled([...cleanups].map((cleanup) => cleanup())).finally(() => process.exit(3));
  });
}

/** The preload of --seed-fault lag: only the service process (`archer … serve --foreground`) is slowed. */
const FAULT_LAG = `// service-load.mjs --seed-fault lag: block the event loop 200 ms every second, in the archer service only.
if (process.argv.includes("serve") && process.argv.includes("--foreground")) {
  setInterval(() => { const end = performance.now() + 200; while (performance.now() < end) { /* busy */ } }, 1000).unref();
}
`;

/** Load and pressure of the host (§5 "Quiet host"): recorded before and after, never judged here. */
function hostState() {
  const pressure = {};
  for (const kind of ["cpu", "memory", "io"]) {
    try {
      pressure[kind] = readFileSync(`/proc/pressure/${kind}`, "utf8").trim().split("\n")[0];
    } catch {
      pressure[kind] = null;
    }
  }
  return { at: new Date().toISOString(), loadavg: loadavg().map((v) => Math.round(v * 100) / 100), pressure };
}

/** utime + stime of `pid` in clock ticks (/proc/<pid>/stat fields 14 and 15), or null. */
function cpuTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return null;
  }
}

const clkTck = () => Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim()) || 100;

/** GET or POST a debug route with the sandbox service's own token (never printed). */
async function debugCall(record, name, method = "GET") {
  const res = await fetch(`${record.origin}/-/debug/${name}`, {
    method,
    headers: {
      authorization: `Bearer ${record.ownerToken}`,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${method} /-/debug/${name} answered ${res.status}`);
  return res.json();
}

/** Samples /-/debug/metrics and the process's CPU every `everyMs` until stopped. */
function startSampler(record, everyMs) {
  const samples = [],
    errors = [];
  let stopped = false;
  const take = async () => {
    try {
      const m = await debugCall(record, "metrics");
      samples.push({
        at: Date.now(),
        cpuTicks: cpuTicks(record.pid),
        rssMb: m.memory?.now?.rssMb ?? null,
        eventLoop: m.eventLoop?.delayMs ?? null,
        series: m.eventLoop?.series ?? [],
        streamsOpen: m.streamsOpen ?? null,
      });
      return m;
    } catch (error) {
      errors.push(String(error.message ?? error));
      return null;
    }
  };
  const loop = (async () => {
    while (!stopped) {
      await take();
      await sleep(everyMs);
    }
  })();
  return {
    samples,
    errors,
    take,
    async stop() {
      stopped = true;
      await loop;
      return take();
    },
  };
}

/** Waits (up to `timeoutMs`) until the service's thumbnail drawing count is unchanged over 2 s; how long it took. */
async function settle(record, timeoutMs) {
  const started = Date.now();
  let last = -1,
    stableSince = Date.now();
  while (Date.now() - started < timeoutMs) {
    const m = await debugCall(record, "metrics");
    const count = m.thumbnails?.render?.count ?? 0;
    if (count !== last) {
      last = count;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 2000)
      return { waitedMs: Date.now() - started, drawings: count, quiet: true };
    await sleep(250);
  }
  return { waitedMs: Date.now() - started, drawings: last, quiet: false };
}

/** One GET with the context's cookie; its status and Server-Timing. */
async function timedGet(context, url) {
  const started = performance.now();
  const res = await context.request.get(url, { failOnStatusCode: false });
  const wallMs = Math.round((performance.now() - started) * 10) / 10;
  return {
    status: res.status(),
    wallMs,
    phases: Object.fromEntries(
      Object.entries(parseServerTiming(res.headers()["server-timing"])).filter(([k]) => k !== "total"),
    ),
    total: parseServerTiming(res.headers()["server-timing"]).total ?? null,
  };
}

/** The scratch diagram the agent writes; the source toggles a label so every write is a change. */
const scratchSource = (n) =>
  `%% description: perf scratch (service-load.mjs)\nflowchart LR\n  a[Agent write ${n}]\n  b[B]\n  a a_b@--> b\n`;

async function agentWrite(agent, n) {
  const started = performance.now();
  const read = await agent.call("read_diagram", { viewId: SCRATCH });
  if (!read.admitted) return { ok: false, code: read.code, wallMs: null };
  const write = await agent.call("write_diagram", {
    viewId: SCRATCH,
    source: scratchSource(n),
    expectedRevision: read.result.sourceRevision,
  });
  return {
    ok: write.admitted,
    code: write.code,
    wallMs: Math.round(performance.now() - started),
    modelRevision: write.result?.modelRevision ?? null,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      sandbox: { type: "string" },
      name: { type: "string", default: "perf-svc-load" },
      rounds: { type: "string", default: "5" },
      "pause-ms": { type: "string", default: "2000" },
      "sample-ms": { type: "string", default: "1000" },
      out: { type: "string" },
      "seed-fault": { type: "string" },
      timeout: { type: "string", default: "60000" },
    },
  });
  const rounds = Math.max(1, Number(values.rounds) || 5),
    pauseMs = Number(values["pause-ms"]),
    sampleMs = Number(values["sample-ms"]),
    timeout = Number(values.timeout);
  const fault = values["seed-fault"] ?? null;
  if (fault !== null && fault !== "lag") throw new Error("--seed-fault takes: lag");
  if (fault !== null && values.sandbox) throw new Error("--seed-fault starts its own sandbox; drop --sandbox");
  const out = resolve(
    values.out ?? join(HERE, "out", `service-load-${new Date().toISOString().replace(/[:.]/g, "-")}`),
  );
  mkdirSync(out, { recursive: true });
  const before = hostState();

  // The sandbox: an existing one, or our own (with the fault preloaded when asked).
  let record,
    ours = false;
  if (values.sandbox) {
    record = readRecord(values.sandbox);
    if (record === null || !record.origin || !record.ownerToken)
      throw new Error(`no running sandbox ${values.sandbox} with an owner token`);
  } else {
    const saved = process.env.NODE_OPTIONS;
    if (fault === "lag") {
      const preload = join(out, "fault-lag.mjs");
      writeFileSync(preload, FAULT_LAG);
      process.env.NODE_OPTIONS = `${saved ?? ""} --import ${pathToFileURL(preload).href}`.trim();
    }
    const stop = async () => {
      await down({ name: values.name }).catch(() => {});
    };
    cleanups.add(stop);
    try {
      record = await up({ name: values.name });
      ours = true;
    } finally {
      if (saved === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = saved;
    }
  }
  const project = record.projects.find((p) => p.slug === PROJECT || p.corpus === PROJECT);
  if (!project) throw new Error(`the sandbox has no project ${PROJECT}`);
  const env = sandboxEnv(record);
  delete env.NODE_OPTIONS; // the CLI and the agent are never slowed by the seeded fault

  const { chromium } = require("playwright");
  let browser = null,
    agent = null;
  const closeAll = async () => {
    agent?.close();
    agent = null;
    await browser?.close().catch(() => {});
    browser = null;
  };
  cleanups.add(closeAll);
  try {
    // A scratch diagram for the agent's writes (the sandbox project is a throwaway copy).
    const scratchPath = join(project.root, ".archer", "diagrams", `${SCRATCH}.mmd`);
    if (!existsSync(scratchPath)) writeFileSync(scratchPath, scratchSource(0));
    agent = await mcpSession({ cwd: project.root, env });
    for (let i = 0; i < 20; i++) {
      const r = await agent.call("read_diagram", { viewId: SCRATCH });
      if (r.admitted && r.result?.modelRevision) break;
      await sleep(500);
    }

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const login = await context.newPage();
    await login.goto(record.link, { waitUntil: "load", timeout });
    await login.close();
    const targets = await resolveTargets(context, {
      base: record.origin,
      project: project.slug,
      diagram: DIAGRAM,
      timeout,
    });
    const surfaces = {
      projects: targets.paths.projects,
      "project-folders": targets.paths["project-folders"],
      diagram: targets.paths.diagram,
      note: `/projects/${project.slug}/${NOTE}`,
    };

    // 1. Compile and thumbnail, cold then warm, on a quiet service (the MCP session's start and the scratch file's
    // reload otherwise land inside the first request's time). The counters are reset around this step so the
    // service's own histograms hold only its drawings and compiles.
    const p = `${record.origin}/p/${project.slug}/api`;
    const inventory = await (await context.request.get(`${p}/diagrams`)).json();
    // A fresh service is still drawing every view's thumbnails: wait until its drawing count holds still for 2 s.
    const quiet = await settle(record, timeout);
    await debugCall(record, "reset", "POST");
    const compileUrl = `${p}/notes/diagram?address=${encodeURIComponent(COMPILE_ADDRESS)}`;
    const compile = { cold: await timedGet(context, compileUrl), warm: await timedGet(context, compileUrl) };
    // The service draws a new revision's thumbnails (both themes) in the background 150 ms after a change
    // (service.ts WARM_BACKGROUND_DELAY_MS), so the first request after the write usually finds the drawing made:
    // the drawing's own cost is the service's render histogram (metrics.thumbnails.render), read after it settles.
    const written = await agentWrite(agent, `cold ${Date.now()}`);
    const thumbUrl = `${p}/thumbnails/${SCRATCH}?rev=${written.modelRevision}&theme=dark&v=${inventory.thumbnailVersion}`;
    const thumbnail = { cold: await timedGet(context, thumbUrl), warm: await timedGet(context, thumbUrl) };
    await sleep(1500);
    const settled = await debugCall(record, "metrics");
    const render = settled.thumbnails?.render ?? null;
    const coldWarm = {
      compile: { address: COMPILE_ADDRESS, ...compile, service: settled.compile ?? null },
      thumbnail: {
        view: SCRATCH,
        theme: "dark",
        ...thumbnail,
        coldRendered: "render" in (thumbnail.cold.phases ?? {}),
        cache: settled.thumbnails?.cache ?? null,
      },
      "thumbnail drawing": {
        cold:
          render && render.count > 0
            ? { total: render.mean, phases: { render: render.max }, count: render.count }
            : null,
        warm: null,
      },
    };

    // 3. Tabs open (warm-up, not measured).
    const pages = {};
    for (const [surface, path] of Object.entries(surfaces)) {
      const page = await context.newPage();
      await page.goto(`${record.origin}${path}`, { waitUntil: "load", timeout });
      pages[surface] = page;
    }
    await sleep(1500);

    // 2. Reset the service's counters, then sample through the rounds.
    await debugCall(record, "reset", "POST");
    const windowStart = Date.now();
    const sampler = startSampler(record, sampleMs);

    let round = 0;
    const samples = [],
      pending = new Map();
    context.on("response", async (res) => {
      if (round === 0 || !res.url().startsWith(record.origin)) return;
      const req = res.request();
      let headers = {};
      try {
        headers = await res.allHeaders();
      } catch {
        /* page gone */
      }
      const sample = {
        round,
        requestId: headers["x-archer-request-id"] ?? null,
        method: req.method(),
        url: res.url(),
        status: res.status(),
        serverTiming: parseServerTiming(headers["server-timing"]),
        streaming: String(headers["content-type"] ?? "").startsWith("text/event-stream"),
        wallMs: null,
      };
      samples.push(sample);
      pending.set(req, sample);
    });
    context.on("requestfinished", (req) => {
      const sample = pending.get(req);
      if (!sample) return;
      pending.delete(req);
      const t = req.timing();
      if (t.responseEnd >= 0) sample.wallMs = Math.round(t.responseEnd * 10) / 10;
    });

    const clients = [];
    for (round = 1; round <= rounds; round++) {
      const started = performance.now();
      const [, exportResult, writeResult] = await Promise.all([
        Promise.all(
          Object.values(pages).map(async (page) => {
            await page.reload({ waitUntil: "load", timeout });
            await page.waitForTimeout(1500);
          }),
        ),
        (async () => {
          const t = performance.now();
          const r = await cliCall("export_diagram", { viewId: EXPORT_VIEW }, { cwd: project.root, env });
          return { ok: r.admitted, code: r.code, wallMs: Math.round(performance.now() - t) };
        })(),
        agentWrite(agent, round),
      ]);
      clients.push({
        round,
        roundMs: Math.round(performance.now() - started),
        export: exportResult,
        write: { ok: writeResult.ok, code: writeResult.code, wallMs: writeResult.wallMs },
      });
      process.stderr.write(
        `round ${round}/${rounds}: ${Math.round(performance.now() - started)} ms, export ${exportResult.ok ? "ok" : exportResult.code}, write ${writeResult.ok ? "ok" : writeResult.code}\n`,
      );
      await sleep(pauseMs);
    }
    const lastRound = round - 1;
    round = 0;
    const finalMetrics = await sampler.stop();
    const streamsOpen = sampler.samples.at(-1)?.streamsOpen ?? null;
    await closeAll();
    cleanups.delete(closeAll);

    const { kept: timed, replays } = dropReplays(samples.filter((s) => s.round >= 1 && s.round <= lastRound));
    const routes = routeStats(timed),
      coverage = phaseCoverage(timed);
    const metrics = metricsSummary(sampler.samples, { clkTck: clkTck(), from: windowStart });
    const failed = clients.filter((c) => !c.export.ok || !c.write.ok);
    const after = hostState();
    const report = {
      schema: "archer-service-load/1",
      generatedAt: new Date().toISOString(),
      fault,
      rounds,
      pauseMs,
      sampleMs,
      sandbox: { origin: record.origin, pid: record.pid, ours },
      surfaces,
      host: { before, after },
      routes,
      coverage,
      metrics,
      coldWarm,
      settle: quiet,
      clients,
      streamsOpen,
      cacheReplays: replays,
      samplerErrors: sampler.errors,
      serverRoutes: finalMetrics?.routes ?? null,
      pairing: pairingMetrics({ routes, metrics, coldWarm }),
      samples: timed,
    };
    writeFileSync(join(out, "service-load.json"), `${JSON.stringify(report, null, 2)}\n`);
    const wall = (list) => list.filter(Number.isFinite).sort((a, b) => a - b);
    const exportWall = wall(clients.map((c) => c.export.wallMs)),
      writeWall = wall(clients.map((c) => c.write.wallMs));
    const md = markdown({
      routes,
      coverage,
      metrics,
      coldWarm,
      header: [
        `# Service load (S9)${fault ? ` — seeded fault: ${fault}` : ""}`,
        "",
        `${rounds} rounds of: 4 tabs reloaded (${Object.keys(surfaces).join(", ")}), CLI export_diagram ${EXPORT_VIEW}, agent read_diagram + write_diagram ${SCRATCH}; ${pauseMs} ms between rounds; metrics every ${sampleMs} ms.`,
        `Route times are the service's Server-Timing \`total\` (ms). Streams open at the end: ${streamsOpen}. Browser cache replays dropped: ${replays}. Waited ${quiet.waitedMs} ms for background drawing to settle (${quiet.quiet ? "quiet" : "NOT quiet"}). Client wall: CLI export ${exportWall.join(", ")} ms; agent write ${writeWall.join(", ")} ms.`,
        `Host before: load ${before.loadavg.join(" ")}, ${before.pressure.cpu}; after: load ${after.loadavg.join(" ")}, ${after.pressure.cpu}.`,
        `Thumbnail: the first request after the write ${coldWarm.thumbnail.coldRendered ? "drew it (`render` phase)" : "found the drawing already made in the background (no `render` phase)"}; "thumbnail drawing" is the service's render histogram over that step (mean ms; max under phases; ${coldWarm["thumbnail drawing"].cold?.count ?? 0} drawings).`,
        ...(failed.length ? [`Client failures: ${JSON.stringify(failed)}`] : []),
      ],
    });
    writeFileSync(join(out, "service-load.md"), md);
    process.stdout.write(md);
    process.stdout.write(`\n${join(out, "service-load.md")}\n`);
    if (failed.length || !coverage.ok || metrics.lagOverWarn) process.exitCode = 1;
  } finally {
    await closeAll();
    if (ours) {
      await down({ name: values.name }).catch(() => {});
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(2);
  });
}
