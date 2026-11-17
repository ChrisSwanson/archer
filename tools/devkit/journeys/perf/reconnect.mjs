#!/usr/bin/env node
// perf: reconnect cost (performance rubric §3 S8, §5 reconnect row). A standalone Playwright script, not a
// harness journey: it restarts the service under the open pages, and the harness's invariants count the
// failed requests a fault phase makes on purpose (G3 excludes reconnect fault phases).
//
//   node tools/devkit/journeys/perf/reconnect.mjs [--sandbox <name>] [--phases offline,restart,both]
//        [--offline-ms 6000] [--headed] [--keep] [--name perf-reconnect] [--baseline <reconnect.json>]
//   node tools/devkit/journeys/perf/reconnect.mjs --analyse <reconnect.json> [--baseline <reconnect.json>]
//
//   --sandbox <name>  use a running sandbox (`sandbox.mjs up`); without it the script brings up its own
//                     (--name, default `perf-reconnect`; production page) and takes it down at the end (--keep leaves it up)
//   --baseline        the last release's reconnect.json: S8's level then includes "no worse than last release"
//   --jitter <v>      a lab control (O217): pins the pages' Math.random to v (0 ≤ v < 1) before they start, so the
//                     reconnect delays' equal jitter is the same on every capture and both builds; attempts are
//                     compared across releases only between captures with the same --jitter. Without it the
//                     page's own randomness runs (recorded as jitter "native") and attempts are NOT EVALUATED
//   --analyse         re-summarize a saved run's captures (no browser, no sandbox) and print its level
//   PERF_OUT          output directory (default /tmp); writes reconnect.json
//   PERF_SEED_FAULT   a seeded fault, to prove the checks fail:
//                       second-stream  the diagram tab opens a second EventSource on its stream URL after it
//                                      reconnects (fails "one stream per tab": level 0)
//                       no-backoff     during the fault the diagram tab also asks its connection route every
//                                      100 ms (page.evaluate), as a page with no backoff would: fails backoff
//                                      and bound (level 0)
//                       slow-retry     during the fault and 6 s after, the diagram tab's stream URL answers
//                                      200 `retry: 5000` and closes (Playwright route): fails "no sooner than retry"
//
// Phases, each with its own capture: (a) offline — context.setOffline(true) for --offline-ms, then back;
// (b) restart — the sandbox service stops and starts on the same port, state and links; (c) both — offline,
// the service restarts meanwhile, online after --offline-ms. Two tabs in one context: a diagram page and
// the project page. Requests, stream answers and stream events come from CDP Network events
// (requestWillBeSent, responseReceived, loadingFinished, loadingFailed, eventSourceMessageReceived).
//
// The capture shape and the analysis are tools/perf/lib/reconnect.mjs (shared with the user-flows J8
// journeys: import `attachCapture` from here and `summarize` from there).
//
// Restart: `restart` from tools/devkit/sandbox.mjs when it exports one; otherwise this script's own:
// it stops only the pid the sandbox record names, after `ownsProcess` confirms it, and starts the same
// argv, environment and working directory (read from /proc before the stop) with ARCHER_RESTORE_STATE=true,
// then updates the record so `sandbox.mjs down` stops the new process.
import { closeSync, mkdirSync, openSync, readFileSync, readlinkSync, writeFileSync, chmodSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { SCHEMA, classifyPath, s8Level, summarize } from "../../../perf/lib/reconnect.mjs";
import * as sandboxes from "../../sandbox.mjs";

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const SEED_FAULTS = ["second-stream", "no-backoff", "slow-retry"];
const DIAGRAM = "/projects/awkward/diagrams/fixture-seq-full.mmd";
const PROJECT = "/projects/awkward/";

/**
 * Record one tab's requests and stream events into `store` (the capture's rows and events), on the store's
 * clock (ms since store.t0). Returns the CDP session.
 * @param {import("playwright").Page} page
 * @param {string} tab
 * @param {{t0: number, origin: string, rows: object[], events: object[], lastActivity: number, onEvent?: Function}} store
 */
export async function attachCapture(page, tab, store) {
  const cdp = await page.context().newCDPSession(page);
  let offset = null; // wall ms − CDP monotonic ms, from the first request
  const at = (ts) => Math.round((ts * 1000 + (offset ?? 0) - store.t0) * 10) / 10;
  const byId = new Map();
  const touch = () => {
    store.lastActivity = Date.now();
  };
  cdp.on("Network.requestWillBeSent", (e) => {
    offset ??= e.wallTime * 1000 - e.timestamp * 1000;
    let url;
    try {
      url = new URL(e.request.url);
    } catch {
      return;
    }
    if (url.origin !== store.origin) return;
    const prior = byId.get(e.requestId);
    if (prior && e.redirectResponse) {
      prior.end = at(e.timestamp);
      prior.status = e.redirectResponse.status;
      prior.response ??= prior.end;
      prior.id += "#redirected";
    }
    const row = {
      tab,
      id: `${tab}:${e.requestId}`,
      method: e.request.method,
      path: url.pathname,
      kind: classifyPath(url.pathname, e.request.method),
      type: e.type,
      start: at(e.timestamp),
    };
    byId.set(e.requestId, row);
    store.rows.push(row);
    touch();
  });
  cdp.on("Network.responseReceived", (e) => {
    const row = byId.get(e.requestId);
    if (!row) return;
    row.response = at(e.timestamp);
    row.status = e.response.status;
    const headers = Object.fromEntries(Object.entries(e.response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const seq = Number(headers["x-archer-event-seq"]);
    if (Number.isSafeInteger(seq)) row.seq = seq;
    touch();
  });
  cdp.on("Network.loadingFinished", async (e) => {
    const row = byId.get(e.requestId);
    if (!row) return;
    row.end = at(e.timestamp);
    touch();
    if (row.kind === "stream") {
      // A finished stream's body says which `retry:` it carried (the service's "opening" answer sends one).
      try {
        const { body } = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
        row.retryMs = retryOf(body);
      } catch {
        /* not kept */
      }
    }
  });
  cdp.on("Network.loadingFailed", (e) => {
    const row = byId.get(e.requestId);
    if (!row) return;
    row.end = at(e.timestamp);
    row.failed = true;
    row.errorText = e.errorText;
    if (e.canceled) row.canceled = true;
    touch();
  });
  cdp.on("Network.eventSourceMessageReceived", (e) => {
    const row = byId.get(e.requestId);
    if (!row) return;
    const event = {
      tab,
      row: row.id,
      at: at(e.timestamp),
      name: e.eventName ?? "",
      data: String(e.data ?? "").slice(0, 200),
    };
    store.events.push(event);
    store.onEvent?.(event, row);
  });
  await cdp.send("Network.enable");
  return cdp;
}

/** The last `retry:` value in an event-stream body, or null. */
export function retryOf(body) {
  let value = null;
  for (const line of String(body ?? "").split(/\r\n|\r|\n/)) {
    const m = /^retry:\s?(\d+)$/.exec(line);
    if (m) value = Number(m[1]);
  }
  return value;
}

/** One phase's capture: the rows and events of the window, clipped to its end (tools/perf/lib/reconnect.mjs). */
export function sliceCapture(store, { phase, start, end, fault, retryMs, tabs }) {
  const s = start - store.t0,
    e = end - store.t0;
  const rows = store.rows
    .filter((r) => r.start <= e && (r.end === undefined || r.end >= s))
    .map((r) => {
      const row = { ...r };
      if (row.end !== undefined && row.end > e) delete row.end;
      if (row.response !== undefined && row.response > e) {
        delete row.response;
        delete row.status;
      }
      return row;
    });
  const ids = new Set(rows.map((r) => r.id));
  const events = store.events.filter((x) => ids.has(x.row) && x.at <= e);
  return {
    schema: SCHEMA,
    phase,
    t0: store.t0,
    start: s,
    end: e,
    fault: { start: fault.start - store.t0, end: fault.end - store.t0, kinds: fault.kinds },
    retryMs,
    tabs,
    rows,
    events,
  };
}

/** The `retry:` the live stream starts with (Node fetch with the page's cookie, read until `standing`). */
async function probeRetry(origin, path, cookie) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  let text = "";
  try {
    const res = await fetch(origin + path, {
      headers: { cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });
    const reader = res.body.getReader(),
      dec = new TextDecoder();
    while (!/event: standing\n/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
  } catch {
    /* timed out: what arrived is what there is */
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return {
    retryMs: retryOf(text),
    prefix: text
      .split("\n")
      .filter((l) => !l.startsWith("data:"))
      .slice(0, 6)
      .join("\\n"),
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stop and start the sandbox's service (same argv, env, cwd, port and state); waits until every project answers. */
async function restartService(name, cookie) {
  if (typeof sandboxes.restart === "function") {
    const r = await sandboxes.restart({ name });
    return { via: "sandbox.mjs restart", pid: r.pid, ms: r.lastRestartMs };
  }
  const record = sandboxes.readRecord(name);
  if (record === null || !sandboxes.ownsProcess(record))
    throw new Error(`sandbox ${name}: pid ${record?.pid} is not its service; nothing restarted`);
  const pid = record.pid,
    started = Date.now();
  const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  if (!argv.includes("serve") || argv[argv.indexOf("--port") + 1] !== String(record.port))
    throw new Error(`pid ${pid}'s argv is not \`serve --port ${record.port}\`; nothing restarted`);
  const env = Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
  );
  if (env.ARCHER_STATE_DIR !== record.stateDir)
    throw new Error(`pid ${pid} does not use the sandbox's state directory; nothing restarted`);
  const cwd = readlinkSync(`/proc/${pid}/cwd`);
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    }
  };
  signal("SIGTERM");
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(50);
  if (alive(pid)) {
    signal("SIGKILL");
    await sleep(200);
  }
  const stoppedAt = Date.now();
  const fd = openSync(record.logPath, "a");
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: { ...env, ARCHER_RESTORE_STATE: "true" },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  // The record names the new process at once, so `sandbox.mjs down` stops it even if this script dies.
  const write = (rec) => {
    const p = sandboxes.registryPath(name);
    const { ownerToken: _o, ...kept } = rec;
    writeFileSync(p, JSON.stringify(kept, null, 2), { mode: 0o600 });
    chmodSync(p, 0o600);
  };
  Object.assign(record, { pid: child.pid, restarts: (record.restarts ?? 0) + 1 });
  delete record.process;
  write(record);
  const until = Date.now() + 60_000;
  let listening = null;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`restarted service exited (${child.exitCode})`);
    try {
      await fetch(record.origin + "/", { redirect: "manual", signal: AbortSignal.timeout(1000) });
      listening = Date.now();
      break;
    } catch {
      /* not yet */
    }
    if (Date.now() > until) throw new Error("restarted service did not listen within 60 s");
    await sleep(100);
  }
  const identity = sandboxes.processIdentity(child.pid);
  if (identity !== null) {
    record.process = identity;
    write(record);
  }
  for (const p of record.projects ?? []) {
    for (;;) {
      try {
        const res = await fetch(`${record.origin}/p/${p.slug}/api/diagrams`, {
          headers: { cookie },
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) break;
      } catch {
        /* not yet */
      }
      if (Date.now() > until) throw new Error(`restarted service: project ${p.slug} did not answer within 60 s`);
      await sleep(100);
    }
  }
  return {
    via: "reconnect.mjs fallback (no sandbox.mjs restart)",
    pid: child.pid,
    stoppedMs: stoppedAt - started,
    listeningMs: listening - started,
    ms: Date.now() - started,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      analyse: { type: "string" },
      sandbox: { type: "string" },
      phases: { type: "string", default: "offline,restart,both" },
      "offline-ms": { type: "string", default: "6000" },
      headed: { type: "boolean" },
      keep: { type: "boolean" },
      baseline: { type: "string" },
      name: { type: "string", default: "perf-reconnect" },
      jitter: { type: "string" },
    },
  });
  const baseline = values.baseline
    ? JSON.parse(readFileSync(values.baseline, "utf8")).captures.map((c) => summarize(c))
    : undefined;
  if (values.analyse) {
    const run = JSON.parse(readFileSync(values.analyse, "utf8"));
    const summaries = run.captures.map((c) => summarize(c));
    process.stdout.write(
      JSON.stringify({ file: values.analyse, level: s8Level(summaries, baseline), phases: brief(summaries) }, null, 1) +
        "\n",
    );
    return;
  }
  const jitterValue = values.jitter === undefined ? null : Number(values.jitter);
  if (jitterValue !== null && !(jitterValue >= 0 && jitterValue < 1))
    throw new Error(`--jitter ${values.jitter}: a number in [0, 1)`);
  const jitter = jitterValue === null ? "native" : `fixed ${jitterValue}`;
  const seed = process.env.PERF_SEED_FAULT || null;
  if (seed !== null && !SEED_FAULTS.includes(seed))
    throw new Error(`PERF_SEED_FAULT=${seed}; known: ${SEED_FAULTS.join(", ")}`);
  const phases = values.phases
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of phases) if (!["offline", "restart", "both"].includes(p)) throw new Error(`unknown phase ${p}`);
  const offlineMs = Number(values["offline-ms"]);
  const out = process.env.PERF_OUT ?? "/tmp";
  mkdirSync(out, { recursive: true });

  let name = values.sandbox,
    own = false;
  if (!name) {
    name = values.name;
    own = true;
    process.stderr.write(`bringing up sandbox ${name}…\n`);
    await sandboxes.up({ name });
  }
  const record = sandboxes.readRecord(name);
  const origin = record.origin;
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: !values.headed });
  const store = { t0: Date.now(), origin, rows: [], events: [], lastActivity: Date.now(), waiters: [] };
  store.onEvent = (event, row) => {
    store.waiters = store.waiters.filter(
      (w) => !(w.tab === event.tab && row.start >= w.after && (w.resolve(event), true)),
    );
  };
  const firstEventAfter = (tab, after, timeoutMs) => {
    const hit = store.events.find((e) => e.tab === tab && store.rows.find((r) => r.id === e.row)?.start >= after);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const w = { tab, after, resolve };
      store.waiters.push(w);
      setTimeout(() => {
        store.waiters = store.waiters.filter((x) => x !== w);
        resolve(null);
      }, timeoutMs);
    });
  };
  const rel = () => Date.now() - store.t0;
  const quiet = async (idleMs = 1500, capMs = 15_000) => {
    const until = Date.now() + capMs;
    for (;;) {
      const idle = Date.now() - store.lastActivity;
      if (idle >= idleMs || Date.now() >= until) return;
      await sleep(idleMs - idle);
    }
  };

  const result = {
    schema: "archer.perf.reconnect-run/1",
    target: {
      commit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
      sandbox: name,
      page: record.page,
      seedFault: seed,
      offlineMs,
      phases,
      jitter,
    },
    probes: {},
    restarts: [],
    captures: [],
    summaries: [],
  };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (jitterValue !== null) await context.addInitScript(`Math.random = () => ${jitterValue};`);
    const login = await context.newPage();
    const res = await login.goto(record.link);
    if (!res || res.status() >= 400) throw new Error(`login link answered ${res?.status()}`);
    await login.close();
    const cookie = (await context.cookies())
      .filter((c) => /^archer-\d+$/.test(c.name))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const tabs = [
      { id: "diagram", path: DIAGRAM },
      { id: "project", path: PROJECT },
    ];
    const pages = {};
    for (const t of tabs) {
      const page = await context.newPage();
      await attachCapture(page, t.id, store);
      const ready = firstEventAfter(t.id, rel(), 30_000);
      await page.goto(origin + t.path, { waitUntil: "load" });
      if ((await ready) === null) process.stderr.write(`warning: tab ${t.id} got no stream event within 30 s\n`);
      pages[t.id] = page;
    }
    await quiet();
    const streamPath = store.rows.find((r) => r.tab === "diagram" && r.kind === "stream")?.path;
    if (!streamPath) throw new Error("the diagram tab opened no event stream");
    const probe = await probeRetry(origin, streamPath, cookie);
    result.probes.normalStream = probe;
    process.stderr.write(`stream ${streamPath}: retry ${probe.retryMs ?? "(none sent)"}; starts "${probe.prefix}"\n`);

    for (const phase of phases) {
      process.stderr.write(`phase ${phase}…\n`);
      await quiet();
      const start = Date.now();
      await sleep(1500);
      const fault = { start: Date.now(), end: null, kinds: [] };
      let route = null;
      if (seed === "no-backoff") {
        const url = streamPath.replace(/events$/, "connection");
        await pages.diagram.evaluate((u) => {
          window.__perfLoop = setInterval(() => {
            fetch(u, { cache: "no-store" }).catch(() => {});
          }, 100);
        }, url);
      }
      if (seed === "slow-retry") {
        const retry = 5000;
        route = { retry, hits: [], on: rel(), off: null };
        await pages.diagram.route(`**${streamPath}`, (r) => {
          route.hits.push(rel());
          return r.fulfill({
            status: 200,
            headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
            body: `retry: ${retry}\n\n`,
          });
        });
        fault.kinds.push("route");
      }
      if (phase === "offline" || phase === "both") {
        fault.kinds.push("offline");
        await context.setOffline(true);
      }
      if (phase === "restart" || phase === "both") {
        fault.kinds.push("restart");
        const r = await restartService(name, cookie);
        result.restarts.push({ phase, ...r });
        process.stderr.write(`  restarted via ${r.via} in ${r.ms} ms\n`);
      }
      if (phase === "offline" || phase === "both") {
        await sleep(fault.start + offlineMs - Date.now());
        await context.setOffline(false);
      }
      if (route) {
        await sleep(6000);
        await pages.diagram.unroute(`**${streamPath}`);
        route.off = rel();
      }
      if (seed === "no-backoff") await pages.diagram.evaluate(() => clearInterval(window.__perfLoop));
      fault.end = Date.now();
      const after = fault.start - store.t0;
      // A tab whose stream outlived the fault has nothing to recover (Chromium's offline emulation keeps an open
      // stream); every other tab is waited for until a new stream speaks.
      const survived = (tab) =>
        store.rows.some(
          (r) => r.tab === tab && r.kind === "stream" && r.start < after && r.end === undefined && r.status === 200,
        );
      await Promise.all(tabs.map((t) => (survived(t.id) ? null : firstEventAfter(t.id, after, 45_000))));
      await quiet();
      if (seed === "second-stream") {
        await pages.diagram.evaluate((p) => {
          window.__perfSecondStream = new EventSource(p);
        }, streamPath);
        await firstEventAfter("diagram", rel() - 1, 5000);
        await sleep(1000);
        await pages.diagram.evaluate(() => window.__perfSecondStream?.close());
        await quiet();
      }
      const end = Date.now();
      const capture = { ...sliceCapture(store, { phase, start, end, fault, retryMs: probe.retryMs, tabs }), jitter };
      if (route)
        for (const r of capture.rows)
          if (
            r.tab === "diagram" &&
            r.kind === "stream" &&
            r.start >= route.on &&
            r.start <= route.off &&
            r.retryMs === undefined
          )
            r.retryMs = route.retry;
      result.captures.push(capture);
      const s = summarize(capture);
      result.summaries.push(s);
      for (const t of s.tabs) {
        process.stderr.write(
          `  ${t.tab}: streams≤${t.maxStreams} attempts ${t.attempts} gaps [${t.timeline.attempts.map((a) => `${Math.round(a.gapMs ?? NaN)}${a.wake ? "w" : ""}`).join(", ")}] ms, reads after ${t.reads.count} (invalidated ${t.reads.invalidated}, 304 ${t.reads.notModified}, negotiations ${t.reads.negotiations}), first event ${t.timeToFirstEvent.fromFaultEndMs === null ? "-" : Math.round(t.timeToFirstEvent.fromFaultEndMs)} ms after the fault — ${t.ok ? "ok" : t.failures.join("; ")}\n`,
        );
      }
    }
    result.level = s8Level(result.summaries, baseline);
    await context.close();
  } finally {
    await browser.close();
    if (own && !values.keep) {
      const d = await sandboxes.down({ name });
      process.stderr.write(`sandbox ${name} down: ${d.stopped}\n`);
    }
  }
  const file = join(out, "reconnect.json");
  writeFileSync(file, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify({ file, level: result.level, phases: brief(result.summaries) }, null, 1) + "\n");
}

/** The per-tab numbers S8 compares, one line per tab. */
function brief(summaries) {
  return summaries.map((s) => ({
    phase: s.phase,
    ok: s.ok,
    tabs: s.tabs.map((t) => ({
      tab: t.tab,
      maxStreams: t.maxStreams,
      attempts: t.attempts,
      attemptRequests: t.attemptRequests,
      gapsMs: t.timeline.attempts.map((a) => (a.gapMs === null ? null : Math.round(a.gapMs))),
      readsAfter: t.reads.count,
      invalidated: t.reads.invalidated,
      ttfeMs: t.timeToFirstEvent.fromFaultEndMs === null ? null : Math.round(t.timeToFirstEvent.fromFaultEndMs),
      failures: t.failures,
    })),
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
