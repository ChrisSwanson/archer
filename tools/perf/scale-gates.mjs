#!/usr/bin/env node
// Scale count gates (docs/proposals/performance-plan.md, slice 1): deterministic counts on the debug page, run
// against the S (today's corpus) and M (250 views, 1k notes, 200 threads) sandboxes by default. L (1,000 views,
// 4k notes, a 257-view project with 2k threads, a 200-node dense diagram) is opt-in because it is slow.
//
//   node tools/perf/scale-gates.mjs [--sizes S,M] [--l | ARCHER_SCALE_L=1] [--page <debug page>] [--out <dir>]
//        [--budget tools/perf/scale-budgets.json] [--write-budget <file>] [--seed N]
//
// Per size: a fresh sandbox over the generated corpus (tools/devkit/corpus/scale.mjs), then
//   - the first-request compression probe: one GET of the page right after the sandbox starts, before any other
//     load, must carry content-encoding (slice 4);
//   - cold loads of the project tree, the notes view and a diagram of the largest project: API requests, comment
//     fetches with the inbox closed, catalog bytes, DOM nodes, React commits (every root's, counted by
//     page-load.mjs's COMMIT_COUNTER_SCRIPT DevTools hook, on all three pages);
//   - on the diagram: the canvas's `archer:interactive` mark, and Event Timing (input to next paint) for a node
//     click and an arrow key.
// Counts gate against scale-budgets.json (and the S->M growth ratio); timings only warn (decision D5).
// Exit 0 ok, 1 over budget, 2 error. Writes <out>/scale-report.json and scale-report.md.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { DEFAULT_SEED, writeCorpus } from "../devkit/corpus/scale.mjs";
import { buildDebugPage, down, up } from "../devkit/sandbox.mjs";
import { readServiceLog } from "../devkit/lib/service-log.mjs";
import { PROFILES, urlPattern } from "./lib/report.mjs";
import { COMMIT_COUNTER_SCRIPT, VITALS_SCRIPT, instrument, measure, resolveTargets } from "./page-load.mjs";
import { countsOf, inputToPaint, judge, markdown } from "./lib/scale.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const require = createRequire(join(REPO, "package.json"));
export const MEASURED_PAGES = ["project-folders", "project-notes", "diagram"];

/**
 * Cleanups for what this process has started (sandbox, browser, temp dirs). A normal exit runs them in `finally`;
 * SIGINT, SIGTERM and SIGHUP (release-check stopping the gate) run them here, then exit 3.
 */
const cleanups = new Set();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (interrupted) process.exit(3);
    interrupted = true;
    process.stderr.write(`\nscale-gates: ${signal}; tearing down\n`);
    Promise.allSettled([...cleanups].map((cleanup) => cleanup())).finally(() => process.exit(3));
  });
}

/** One GET of `url` with the cookie of a login link, asking for br and gzip; the encoding it came back in. */
export function probePage(link) {
  const get = (url, headers = {}) =>
    new Promise((done, fail) => {
      const req = request(url, { headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", fail);
      req.end();
    });
  return (async () => {
    const login = await get(link);
    const cookie = String(login.headers["set-cookie"]?.[0] ?? "").split(";")[0];
    const target = new URL(login.headers.location ?? "/projects/", link).href;
    const started = Date.now();
    const page = await get(target, { cookie, "accept-encoding": "gzip, deflate, br" });
    const encoding = page.headers["content-encoding"];
    const decoded =
      encoding === "gzip" ? gunzipSync(page.body) : encoding === "br" ? brotliDecompressSync(page.body) : page.body;
    return {
      status: page.status,
      contentEncoding: encoding ?? "identity",
      bytes: page.body.length,
      decodedBytes: decoded.length,
      ms: Date.now() - started,
    };
  })();
}

async function interact(page, timeoutMs) {
  const mark = await page
    .waitForFunction(() => performance.getEntriesByName("archer:interactive").length > 0, null, { timeout: timeoutMs })
    .then(
      () => true,
      () => false,
    );
  // Read after the wait: a dense diagram lays out after the load has settled.
  const interactiveMs = await page.evaluate(() => {
    const m = performance.getEntriesByName("archer:interactive").at(-1);
    return m ? Math.round(m.startTime) : null;
  });
  await page.evaluate(() => {
    window.__events = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__events.push({ name: e.name, duration: e.duration });
    }).observe({ type: "event", durationThreshold: 16 });
  });
  const node = page.locator(".react-flow__node").first();
  if ((await node.count()) > 0) await node.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(600);
  const events = await page.evaluate(() => window.__events ?? []);
  const click = inputToPaint(events, ["pointerdown", "pointerup", "click"]),
    key = inputToPaint(events, ["keydown"]);
  return {
    interactiveMs,
    marked: mark,
    clickToPaintMs: Math.round(Math.max(0, ...Object.values(click))) || null,
    keyToPaintMs: Math.round(Math.max(0, ...Object.values(key))) || null,
  };
}

/** Run one size end to end. */
async function measureSize(size, { pagePath, seed, chromium, timeout }) {
  const work = mkdtempSync(join(tmpdir(), `archer-scale-${size.toLowerCase()}-`));
  const name = `sg-${size.toLowerCase()}-${Math.random().toString(16).slice(2, 8)}`;
  let sandbox = null,
    browser = null,
    tornDown = false,
    starting = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    cleanups.delete(teardown);
    await browser?.close().catch(() => {});
    if (starting)
      await down({ name }).catch((error) =>
        process.stderr.write(
          `teardown of ${name} failed: ${error.message}; run node tools/devkit/sandbox.mjs down --name ${name}\n`,
        ),
      );
    rmSync(work, { recursive: true, force: true });
  };
  cleanups.add(teardown);
  try {
    const summary = writeCorpus(size, join(work, "corpus"), seed);
    // L's big project has 257 diagrams on purpose: it must attach (F1, fixed in slice 2).
    // A sandbox that is interrupted while starting is torn down by name: `up` records it before it spawns.
    starting = true;
    sandbox = await up({ name, corpus: join(work, "corpus"), page: pagePath });
    const probe = await probePage(sandbox.link);
    // The service's own warnings while it is measured (svc.event-loop-lag at M…), for the release check's budget.
    const logStart = await readServiceLog(sandbox.origin, sandbox.ownerToken, "level=warn&limit=1");
    browser = await chromium.launch({ headless: true });
    const newContext = async () => {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
      await context.addInitScript(VITALS_SCRIPT);
      await context.addInitScript(COMMIT_COUNTER_SCRIPT);
      const login = await context.newPage();
      await login.goto(sandbox.link, { waitUntil: "load", timeout });
      await login.close();
      return context;
    };
    const first = await newContext();
    // S's largest project opens on a sequence diagram; every size measures a flowchart on the canvas.
    const targets = await resolveTargets(first, {
      base: sandbox.origin,
      timeout,
      ...(size === "S" ? { diagram: "diagrams/flow-styled.mmd" } : {}),
    });
    // L: the dense diagram (200 nodes, 400 labelled edges) is its own row.
    const dense =
      size === "L"
        ? await resolveTargets(first, {
            base: sandbox.origin,
            timeout,
            project: "dense",
            diagram: "diagrams/d0000.mmd",
          })
        : null;
    // One unmeasured load, then a pause: the service's start-up work (file watcher settling on the fresh git
    // snapshot, saved layouts being seeded) otherwise lands in the first measured window as extra reads.
    const warm = await first.newPage();
    await warm
      .goto(`${sandbox.origin}${targets.paths["project-folders"]}`, { waitUntil: "load", timeout })
      .catch(() => {});
    await warm.waitForTimeout(2500);
    await first.close();
    const rows = [
      ...MEASURED_PAGES.map((name) => ({ name, path: targets.paths[name], canvas: name === "diagram" })),
      ...(dense ? [{ name: "diagram-dense", path: dense.paths.diagram, canvas: true }] : []),
    ];
    const pages = {},
      timings = {},
      requestLog = {};
    for (const row of rows) {
      if (!row.path) continue;
      const context = await newContext(),
        page = await context.newPage();
      try {
        const probeRequests = await instrument(page, PROFILES.default, false);
        await probeRequests.cdp.send("Network.clearBrowserCache");
        const load = await measure(page, probeRequests, `${sandbox.origin}${row.path}`, { timeout });
        // `dom`: the page's shape (shell, rows, elements per row), report only: not a count, so never capped or seeded.
        pages[row.name] = {
          ...countsOf({
            requests: load.requests,
            domNodes: load.metrics.domNodes,
            commits: load.commits,
            apiRequests: load.budgetRow.apiRequests,
          }),
          dom: load.metrics.dom,
        };
        // What each load asked for, so two runs that differ can be diffed.
        requestLog[row.name] = load.requests
          .map((r) => `${r.method} ${urlPattern(r.url)} ${r.type}${r.fromCache ? " (cache)" : ""}`)
          .sort();
        if (row.canvas) {
          const suffix = row.name === "diagram" ? "" : `:${row.name}`;
          const moves = await interact(page, timeout);
          for (const [key, value] of Object.entries(moves)) timings[`${key}${suffix}`] = value;
        }
      } finally {
        await context.close();
      }
      process.stderr.write(`scale ${size}: measured ${row.name}\n`);
    }
    const logEnd = logStart.unreadable
      ? logStart
      : await readServiceLog(sandbox.origin, sandbox.ownerToken, `level=warn&limit=1000&since=${logStart.seq ?? 0}`);
    const service = logEnd.unreadable
      ? { unreadable: logEnd.unreadable }
      : { warnings: logEnd.entries.filter((e) => e.source !== "client").map((e) => ({ code: e.code, msg: e.msg })) };
    return {
      ...summary,
      project: targets.project,
      diagram: targets.diagram,
      probe,
      pages,
      timings,
      requestLog,
      service,
    };
  } finally {
    await teardown();
  }
}

/** The highest of each count across runs (a cap must hold for the noisiest run seen). */
export function maxOfRuns(runs) {
  const best = structuredClone(runs[0]);
  for (const run of runs.slice(1)) {
    for (const [page, counts] of Object.entries(run.pages)) {
      for (const [field, value] of Object.entries(counts))
        if (typeof value === "number") best.pages[page][field] = Math.max(best.pages[page][field] ?? 0, value);
    }
  }
  return best;
}

/** Caps from a run: today's counts with head-room, max(v + 5, ceil(1.1 v)), so a late poll or reconnect does not flap a gate. */
export const seedCap = (v) => Math.max(v + 5, Math.ceil(v * 1.1));

export function seedBudgets(measured, previous = {}) {
  const sizes = {};
  for (const [size, result] of Object.entries(measured)) {
    if (size === "L") continue;
    sizes[size] = Object.fromEntries(
      Object.entries(result.pages).map(([page, c]) => [
        page,
        Object.fromEntries(
          Object.entries(c)
            .filter(([, v]) => typeof v === "number")
            .map(([k, v]) => [k, seedCap(v)]),
        ),
      ]),
    );
  }
  return { ...previous, sizes };
}

async function main() {
  const { values } = parseArgs({
    options: {
      sizes: { type: "string", default: "S,M" },
      l: { type: "boolean" },
      page: { type: "string" },
      out: { type: "string" },
      budget: { type: "string", default: join(HERE, "scale-budgets.json") },
      "write-budget": { type: "string" },
      seed: { type: "string" },
      runs: { type: "string", default: "1" },
      timeout: { type: "string", default: "90000" },
    },
  });
  const sizes = values.sizes
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if ((values.l || process.env.ARCHER_SCALE_L === "1") && !sizes.includes("L")) sizes.push("L");
  for (const s of sizes) if (!["S", "M", "L"].includes(s)) throw new Error(`unknown size ${s}`);
  const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
  const { chromium } = require("playwright");
  // One debug page for every size, built here unless the caller (release-check) hands one over.
  let pageDir = null,
    pagePath = values.page === undefined ? undefined : resolve(values.page);
  if (pagePath === undefined) {
    pageDir = mkdtempSync(join(tmpdir(), "archer-scale-page-"));
    pagePath = buildDebugPage(pageDir);
  }
  const measured = {};
  const removePage = async () => {
    if (pageDir) rmSync(pageDir, { recursive: true, force: true });
  };
  cleanups.add(removePage);
  try {
    // --runs N repeats each size and keeps the highest counts: how caps are seeded (the last run's timings stay).
    for (const size of sizes) {
      const runs = [];
      for (let i = 0; i < Math.max(1, Number(values.runs) || 1); i++)
        runs.push(await measureSize(size, { pagePath, seed, chromium, timeout: Number(values.timeout) }));
      measured[size] = {
        ...maxOfRuns(runs),
        timings: runs.at(-1).timings,
        requestLog: runs.at(-1).requestLog,
        service: runs.at(-1).service,
      };
    }
  } finally {
    await removePage();
    cleanups.delete(removePage);
  }
  const budgets = JSON.parse(readFileSync(values.budget, "utf8"));
  const verdict = judge(measured, budgets);
  const out = resolve(values.out ?? join(HERE, "out", `scale-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "scale-report.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), seed, measured, ...verdict }, null, 2)}\n`,
  );
  writeFileSync(join(out, "scale-report.md"), markdown(measured, verdict));
  if (values["write-budget"])
    writeFileSync(values["write-budget"], `${JSON.stringify(seedBudgets(measured, budgets), null, 2)}\n`);
  process.stdout.write(`${join(out, "scale-report.md")}\n`);
  for (const w of verdict.warnings) process.stderr.write(`warn: ${w}\n`);
  if (verdict.failures.length) {
    process.stderr.write(`over budget:\n${verdict.failures.map((f) => `  ${f}`).join("\n")}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(2);
  });
}
