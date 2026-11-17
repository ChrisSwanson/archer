// Smoke-test harness: drive Archer in Chromium like a user, against a devkit sandbox, and keep
// machine-readable evidence for every step. One run = one directory:
//
//   tools/devkit/runs/<timestamp>-<name>/
//     summary.json   steps, invariant results, warnings, timings, artifact paths  <- read this first
//     trace.zip      Playwright trace (screenshots, DOM snapshots, sources)
//     network.har.zip every request/response (har.har + bodies stored once by hash)
//     requests.jsonl one line per request: status, ms, Server-Timing, request id, step
//     console.jsonl  console, pageerror, requestfailed, in order
//     service-log.jsonl / client-events.jsonl  /-/debug/log entries for the run (when ARCHER_DEBUG routes exist)
//     shots/         screenshot per failed step + final
//
//   import { openSandbox, withPage } from "./index.mjs";
//   const sb = openSandbox("smoke");
//   await withPage(async ({ ui, step, page }) => { await ui.openDiagram("journeys", "diagrams/flow.mmd"); … }, { name: "x", sandbox: sb });
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRecord } from "../sandbox.mjs";
import { readServiceLog } from "../lib/service-log.mjs";
import { resolveInvariants, runInvariants, summaryVitals, probe as probeState } from "./invariants.mjs";
import { createUi } from "./actions.mjs";
import { agentFaults, flowsActions, installFaults } from "./flows-state.mjs";
import { installRevealWatch } from "./flow-metrics.mjs";
import { navigationCensus } from "./navigations.mjs";
import { errorCensus, issueMessage } from "./errors.mjs";
import { createAgent } from "./agent.mjs";
import { splitProfile } from "./cpu.mjs";
import { keyRecorder } from "./key-recorder.mjs";
import { budgetResults, pageBudget } from "../../perf/lib/budget.mjs";
import { POLL_HEADER, invalidates, isCommittedEdit, tickOf } from "../../perf/lib/requests.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNS = resolve(HERE, "../runs");
export { expect };

/** The sandbox record written by `sandbox.mjs up` (url, link, projects…). */
export function openSandbox(name) {
  const record = readRecord(name);
  if (record === null)
    throw new Error(`no sandbox named ${name}; start one with: node tools/devkit/sandbox.mjs up --name ${name}`);
  if (!record.link) throw new Error(`sandbox ${name} did not finish starting (no link); run down and up again`);
  return record;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
const CDP_METRICS = [
  "JSHeapUsedSize",
  "JSHeapTotalSize",
  "Nodes",
  "Documents",
  "JSEventListeners",
  "LayoutCount",
  "RecalcStyleCount",
  "LayoutDuration",
  "RecalcStyleDuration",
  "ScriptDuration",
  "TaskDuration",
];

/** Service debug surface (ARCHER_DEBUG=1, contract /-/debug/*). Every call degrades to null. */
function serviceDebug(origin, link, ownerToken) {
  // The log and metrics need the service's own token (record.ownerToken); without it only health answers (a loopback peer).
  const token =
    ownerToken ??
    (() => {
      try {
        return new URL(link).searchParams.get("token") ?? "";
      } catch {
        return "";
      }
    })();
  let available = null;
  const get = async (path) => {
    try {
      const res = await fetch(origin + path, {
        signal: AbortSignal.timeout(3000),
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404) {
        available ??= false;
        return null;
      }
      if (!res.ok) return null;
      available = true;
      return await res.json();
    } catch {
      return null;
    }
  };
  const entries = (body) =>
    Array.isArray(body) ? body : (body?.entries ?? body?.events ?? body?.log ?? body?.items ?? []);
  return {
    get available() {
      return available;
    },
    health: () => get("/-/debug/health"),
    metrics: () => get("/-/debug/metrics"),
    /** Why the log could not be read last time (null when it could): the run reports it, never an empty log. */
    unreadable: null,
    async logSince(seq) {
      const read = await readServiceLog(origin, ownerToken, `since=${seq}&limit=1000&level=debug`, { timeoutMs: 3000 });
      this.unreadable = read.unreadable ?? null;
      return read.entries ?? [];
    },
    async lastSeq() {
      const read = await readServiceLog(origin, ownerToken, "limit=1&level=debug", { timeoutMs: 3000 });
      this.unreadable = read.unreadable ?? null;
      const s = read.entries?.at(-1)?.seq ?? read.seq;
      return typeof s === "number" ? s : 0;
    },
  };
}

/** A journey's deadline when it names none: a page frozen under load once hung a release check for 10+ min. */
export const DEFAULT_JOURNEY_MS = 5 * 60_000;
/** The whole-journey deadline: --max-minutes, else the journey's `maxMs`, else the default or room for three of its slowest actions. */
export function journeyDeadlineMs(meta = {}, maxMinutes) {
  if (maxMinutes) return maxMinutes * 60_000;
  if (meta.maxMs) return meta.maxMs;
  return Math.max(DEFAULT_JOURNEY_MS, 3 * (meta.timeoutMs ?? 0));
}

/**
 * Run `fn` with a logged-in page and full evidence capture.
 * fn receives {page, context, ui, step, expect, sandbox, log, run}.
 * Options: name, sandbox (record or name), headed, viewport, invariants (config, see invariants.mjs),
 * stopOnFailure (default true: an action error ends the journey), slowMo, signal (an AbortSignal: abort ends the
 * run at once, closes the browser and still writes summary.json), maxMs (a deadline for the whole journey),
 * profile (true: a CPU profile per step, split into app / harness / browser time: step.cpu), entryShots
 * (default true: one screenshot per editor family, viewport and theme the first time an editor opens),
 * traceSnapshots (default true; false keeps the trace's DOM snapshots out of the page's main thread when measuring).
 * outDir (explicit artifact directory), ignoreHTTPSErrors (default false, local TLS measurements),
 * login (default true; false lets measurement journeys visit their own access URL, recording refusals).
 * Resolves to the summary (also written to summary.json). Never throws for journey failures.
 */
export async function withPage(fn, options = {}) {
  const sandbox =
    typeof options.sandbox === "string" || options.sandbox === undefined
      ? openSandbox(options.sandbox ?? process.env.ARCHER_SANDBOX ?? "smoke")
      : options.sandbox;
  const name = (options.name ?? "journey").replace(/[^A-Za-z0-9_-]+/g, "-");
  const dir = options.outDir ? resolve(options.outDir) : join(RUNS, `${stamp()}-${name}`);
  mkdirSync(join(dir, "shots"), { recursive: true });
  const invariantConfig = resolveInvariants(options.invariants);
  const started = Date.now();
  const svc = serviceDebug(sandbox.origin, sandbox.link, sandbox.ownerToken);
  const summary = {
    name,
    ok: false,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    dir,
    sandbox: {
      name: sandbox.name,
      url: sandbox.url,
      page: sandbox.page,
      debugUi: sandbox.debugUi,
      ...(sandbox.pageWarning ? { pageWarning: sandbox.pageWarning } : {}),
    },
    steps: [],
    failures: [],
    warnings: [],
    invariantTotals: {},
    surfaces: { serviceDebug: null, browserTelemetry: null },
    perf: {},
    service: {},
    artifacts: {
      summary: join(dir, "summary.json"),
      trace: join(dir, "trace.zip"),
      har: join(dir, "network.har.zip"),
      console: join(dir, "console.jsonl"),
      requests: join(dir, "requests.jsonl"),
      shots: join(dir, "shots"),
    },
    howTo: {
      trace: `npx playwright show-trace ${join(dir, "trace.zip")}`,
      traceNote:
        "Opens the timeline: per-action screenshots, DOM snapshots (inspect selectors), console, network, source.",
      requests:
        "requests.jsonl: one line per request (t ms since start, method, url, status, ms, serverTiming, requestId, step index); grep/jq it before opening the HAR.",
      har: `network.har.zip = har.har + bodies stored once by hash. Extract: python3 -m zipfile -e ${join(dir, "network.har.zip")} ${join(dir, "har")}/ ; then import har/har.har into Chrome DevTools (Network > Import HAR) or jq it.`,
      console: "console.jsonl: one JSON event per line (console, pageerror, requestfailed) with ms since run start.",
    },
  };
  const consoleLog = summary.artifacts.console;
  const record = (event) => appendFileSync(consoleLog, JSON.stringify({ t: Date.now() - started, ...event }) + "\n");
  writeFileSync(consoleLog, "");

  const browser = await chromium.launch({
    headless: !options.headed,
    ...(options.slowMo ? { slowMo: options.slowMo } : {}),
  });
  // Whatever throws before the run's own try (a context option, a reporter, ui.agent: O151) closes the browser: an open
  // one keeps the process alive, and the caller never ends.
  try {
    return await (async () => {
      const context = await browser.newContext({
        ignoreHTTPSErrors: options.ignoreHTTPSErrors ?? false,
        viewport: options.viewport ?? { width: 1440, height: 900 },
        // .zip + attach: bodies stored once by hash (the 5 MB page is not repeated per navigation).
        recordHar: { path: summary.artifacts.har, content: "attach" },
        permissions: ["clipboard-read", "clipboard-write"],
      });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: sandbox.origin });
      // DOM snapshots in the trace cost main-thread time on every action (Playwright's snapshotter walks the whole DOM:
      // ~70 ms per action on the 150-node flow-large, the largest share of harness time). Measuring? traceSnapshots: false.
      await context.tracing.start({
        screenshots: true,
        snapshots: options.traceSnapshots ?? true,
        sources: true,
        title: name,
      });
      // Reports from inside every document (they survive navigations): CSP violations are a browser report,
      // not a console.error, so only a securitypolicyviolation listener sees all of them.
      const contexts = [context];
      const installReporter = async (ctx) => {
        await ctx
          .exposeFunction("__harnessReport", (e) => {
            if (e && e.kind === "csp") {
              ev.csp.push({ ...e, at: Date.now() });
              record({ kind: "csp", ...e });
            } else if (e && e.kind === "key") {
              ev.keys.push({ ...e, at: Date.now() });
              record(e);
            }
          })
          .catch(() => {});
        // What makes a read again legitimate (tools/perf/lib/requests.mjs `invalidations`): a person's input in the
        // first page, at page time (the same clock as the request rows, and earlier than any request it causes).
        await ctx
          .exposeBinding("__harnessInput", (source, at) => {
            if (source.page === page && typeof at === "number") ev.invalidations.push(at);
          })
          .catch(() => {});
        await ctx.addInitScript(() => {
          let wheel = 0;
          // Focus counts only for the window (a person coming back to the tab), not the page moving focus itself.
          const input = (e) => {
            try {
              if (e.type === "focus" && e.target !== window) return;
              if (e.type === "wheel") {
                if (Date.now() - wheel < 100) return;
                wheel = Date.now();
              }
              window.__harnessInput?.(Date.now());
            } catch {
              /* page closing */
            }
          };
          for (const type of ["pointerdown", "keydown", "wheel", "input", "change", "focus"])
            addEventListener(type, input, { capture: true, passive: true });
          document.addEventListener("visibilitychange", input, true);
          document.addEventListener(
            "securitypolicyviolation",
            (e) => {
              try {
                window.__harnessReport?.({
                  kind: "csp",
                  directive: e.violatedDirective,
                  blocked: e.blockedURI,
                  sample: (e.sample || "").slice(0, 80),
                  disposition: e.disposition,
                  document: location.pathname,
                });
              } catch {
                /* page closing */
              }
            },
            true,
          );
        });
        await ctx.addInitScript(keyRecorder);
      };
      const ev = {
        pageErrors: [],
        console: [],
        failed: [],
        responses: [],
        requests: [],
        csp: [],
        navigations: [],
        keys: [],
        dialogs: [],
        invalidations: [],
      };
      // Driver robustness (TG-m2): a closed browser, an abort signal (smoke.mjs wires SIGINT/SIGTERM/SIGHUP and a dead
      // parent to it) or the journey deadline end the run at once. Every later step is skipped without waiting out a
      // timeout, and summary.json is still written, with `aborted`.
      let aborted = null,
        finishing = false;
      const abort = (reason) => {
        if (aborted || finishing) return;
        aborted = { reason, at: new Date().toISOString(), afterSteps: summary.steps.length };
        record({ kind: "aborted", reason });
        void browser.close().catch(() => {}); // an action in flight rejects now instead of after its timeout
      };
      if (options.signal) {
        if (options.signal.aborted) abort(String(options.signal.reason ?? "aborted"));
        else
          options.signal.addEventListener("abort", () => abort(String(options.signal.reason ?? "aborted")), {
            once: true,
          });
      }
      const deadline = options.maxMs
        ? setTimeout(() => abort(`journey deadline of ${options.maxMs} ms reached`), options.maxMs)
        : null;
      deadline?.unref?.();
      browser.on("disconnected", () => abort("the browser disconnected"));
      // progress.json: rewritten after every step, so a watchdog (or a person) can tell a run is alive, and which pid to stop.
      const progressPath = join(dir, "progress.json");
      const progress = (extra = {}) => {
        try {
          writeFileSync(
            progressPath + ".tmp",
            JSON.stringify({
              pid: process.pid,
              name,
              steps: summary.steps.length,
              last: summary.steps.at(-1)?.title ?? null,
              at: new Date().toISOString(),
              ...extra,
            }),
          );
          renameSync(progressPath + ".tmp", progressPath);
        } catch {
          /* best effort */
        }
      };
      await installReporter(context);
      await installFaults({ context, sandbox }); // user-flows seeded faults (ARCHER_FLOWS_FAULT), none by default
      // §5 "Unrequested reloads": every document load in every page of the run, issued by the journey or not (navigations.mjs).
      let currentStep = null;
      const census = navigationCensus({ stepTitle: () => currentStep });
      census.watch(context);
      // §5 "Unseeded errors": every alert, error notice, refusal, failed request and console error, seeded or not (errors.mjs).
      const errors = errorCensus({ stepTitle: () => currentStep });
      await errors.watch(context);
      const page = await context.newPage();
      installRevealWatch(page); // flow.act records the scrolls Playwright's actions make by themselves (flow-metrics.mjs)
      page.setDefaultTimeout(options.timeoutMs ?? 10_000);

      // Evidence streams. Each step slices them by index. Every page of every context the journey opens
      // (ui.newTab / openContext) feeds the same streams; `tab` says which. Only the first page counts for the
      // per-view request budget and the per-step invariant probes.
      const newView = (url) => ({ url, count: 0, byPath: new Map(), last: new Map(), ticks: new Set() });
      let view = newView(null);
      let tabs = 0;
      const WRITE = /^(POST|PUT|PATCH|DELETE)$/;
      // Requests that are never "work the view did": telemetry uploads, the event stream, deliberate polls.
      const isNoise = (url) => /\/-\/debug\//.test(url) || /\/events(\?|$)/.test(url);
      const entries = new WeakMap(); // request → its ev.requests entry (status and bytes are filled in when it finishes)
      const attach = (pg, tab) => {
        const primary = tab === 0;
        census.name(pg, tab);
        errors.name(pg, tab);
        const tag = (x) => (primary ? x : { ...x, tab });
        // A modal dialog blocks every page.evaluate, so nothing may leave one open. A beforeunload prompt (a dirty editor
        // being left by page.goto/reload) is accepted, as a person choosing "Leave"; alert/confirm/prompt are dismissed.
        // Both are evidence: step.dialogs and console.jsonl.
        pg.on("dialog", (d) => {
          const x = tag({ type: d.type(), message: d.message().slice(0, 300), at: Date.now(), url: pg.url() });
          ev.dialogs.push(x);
          record({ kind: "dialog", ...x });
          void (
            d.type() === "beforeunload" && (options.beforeunload ?? "accept") === "accept" ? d.accept() : d.dismiss()
          ).catch(() => {});
        });
        if (primary) pg.on("close", () => abort("the page closed"));
        // First of the page's request listeners, so each request has its document before the others read it.
        const docs = primary
          ? trackDocuments(pg, {
              onCommit: (url) => {
                view = newView(url);
              },
            })
          : null;
        pg.on("pageerror", (e) => {
          const x = tag({ message: e.message, stack: e.stack?.split("\n").slice(0, 8).join("\n") });
          ev.pageErrors.push(x);
          record({ kind: "pageerror", ...x });
        });
        pg.on("console", (m) => {
          const x = tag({ type: m.type(), text: m.text().slice(0, 2000), location: m.location() });
          ev.console.push(x);
          record({ kind: "console", ...x });
        });
        pg.on("requestfailed", (r) => {
          const x = tag({ url: r.url(), method: r.method(), failure: r.failure()?.errorText });
          ev.failed.push(x);
          record({ kind: "requestfailed", ...x });
        });
        pg.on("request", (r) => {
          const isDoc = r.isNavigationRequest() && r.frame() === pg.mainFrame();
          // `step`: the step it started in, so the budget can tell a read again after a person's step from a duplicate.
          const poll = r.headers()[POLL_HEADER];
          const x = tag({
            url: r.url(),
            method: r.method(),
            at: Date.now(),
            type: r.resourceType(),
            doc: primary ? docs.of(r) : `t${tab}`,
            step: summary.steps.length + (depth > 0 ? 1 : 0),
            ...(poll ? { poll } : {}),
          });
          // A write's identity is its whole body (operation id, base revision, payload): the same body twice is a duplicate write.
          if (WRITE.test(x.method)) {
            const body = r.postData();
            if (body) x.body = createHash("sha1").update(body).digest("hex").slice(0, 16);
          }
          ev.requests.push(x);
          entries.set(r, x);
          if (!primary) return;
          if (isDoc) return;
          // A committed edit is a person's change, not a read (requests.mjs isCommittedEdit): not counted against the cap.
          else if (["fetch", "xhr", "eventsource"].includes(x.type) && !isNoise(x.url) && !isCommittedEdit(x)) {
            // A scheduled poll's tick (the shared classifier, tools/perf/lib/requests.mjs) is not new work, once per tick.
            const key = `${x.method} ${x.url}`,
              prev = view.last.get(key),
              tick = tickOf(x);
            view.last.set(key, x.at);
            const firstOfTick = tick !== null && !view.ticks.has(`${tick} ${key}`);
            if (tick !== null) view.ticks.add(`${tick} ${key}`);
            if (prev !== undefined && firstOfTick) return;
            view.count++;
            const path = new URL(x.url).pathname;
            view.byPath.set(path, (view.byPath.get(path) ?? 0) + 1);
          }
        });
        pg.on("framenavigated", (f) => {
          if (!primary || f !== pg.mainFrame()) return;
          ev.navigations.push({ at: Date.now(), url: f.url() });
        });
        pg.on("requestfinished", (r) => void finished(r));
        pg.on("requestfailed", (r) => void finished(r, r.failure()?.errorText ?? "failed"));
        pg.on("response", (r) => {
          const x = tag({ url: r.url(), status: r.status(), method: r.request().method() });
          ev.responses.push(x);
          if (x.status >= 400) record({ kind: "http-error", ...x });
        });
      };
      // requests.jsonl: one line per finished/failed request with server-side timing, no unzip needed.
      const requestsLog = join(dir, "requests.jsonl");
      writeFileSync(requestsLog, "");
      const finished = async (r, failure) => {
        try {
          const res = failure ? null : await r.response();
          const h = res ? await res.allHeaders() : {};
          const t = r.timing();
          const entry = entries.get(r);
          if (entry) {
            entry.status = res?.status() ?? null;
            // Kept so the budget can tell a cancelled request (net::ERR_ABORTED) from a failed one (tools/perf/lib/budget.mjs `failed`).
            if (failure) entry.failure = failure;
            const sz = failure ? null : await r.sizes().catch(() => null);
            if (sz) entry.transferBytes = Math.max(0, sz.responseBodySize) + Math.max(0, sz.responseHeadersSize);
            // Kept so the budget can tell a read again after a change (another ETag) from a duplicate.
            if (h.etag) entry.etag = h.etag;
          }
          appendFileSync(
            requestsLog,
            JSON.stringify({
              t: Math.round((t.startTime || Date.now()) - started),
              method: r.method(),
              url: r.url(),
              type: r.resourceType(),
              status: res?.status() ?? null,
              ms: t.responseEnd >= 0 ? Math.round(t.responseEnd) : null,
              ...(failure ? { failure } : {}),
              ...(h["server-timing"] ? { serverTiming: h["server-timing"] } : {}),
              ...(h["x-archer-request-id"] ? { requestId: h["x-archer-request-id"] } : {}),
              step: summary.steps.length + (depth > 0 ? 1 : 0),
            }) + "\n",
          );
        } catch {
          /* page closing */
        }
      };
      attach(page, tabs++);
      const viewRequests = () => ({
        url: view.url,
        count: view.count,
        reported: view.reported === true,
        top: [...view.byPath].sort((a, b) => b[1] - a[1]).slice(0, 8),
      });
      const markViewReported = () => {
        view.reported = true;
      };

      let cdp = null;
      try {
        cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");
      } catch {
        cdp = null;
      }
      // A message on the page's event stream (a write by anyone, the service's own news) is a reason to read again;
      // a heartbeat carries no data and is not (the shared classifier's `invalidates`).
      if (cdp) {
        cdp.on("Network.eventSourceMessageReceived", (e) => {
          if (invalidates(e.eventName)) ev.invalidations.push(Date.now());
        });
        await cdp.send("Network.enable").catch(() => {});
      }
      const metrics = async () => {
        if (!cdp) return null;
        try {
          const { metrics: m } = await cdp.send("Performance.getMetrics");
          return Object.fromEntries(m.filter((x) => CDP_METRICS.includes(x.name)).map((x) => [x.name, x.value]));
        } catch {
          return null;
        }
      };
      const delta = (a, b) =>
        a && b
          ? Object.fromEntries(Object.keys(b).map((k) => [k, Math.round((b[k] - (a[k] ?? 0)) * 1000) / 1000]))
          : null;

      // Browser telemetry (dev builds): window.__archerTelemetry.
      // The page's buffer is a sliding ring (2000 events), so "how many warnings I have seen" is no cursor: once the
      // ring is full a new warning replaces an old one at the same count. Each warning object gets a monotonic
      // harness id (`hid`, stamped the first time a poll sees it; the object identity is stable while it is in the
      // ring), and a step consumes warnings with hid > the last consumed one. A poll that finds the ring full and
      // its oldest event newer than the previous poll may have missed events: that is reported, not hidden.
      const telemetry = async () =>
        page
          .evaluate(() => {
            const t = window.__archerTelemetry;
            if (!t) return null;
            const safe = (f) => {
              try {
                return f();
              } catch {
                return null;
              }
            };
            const events = safe(() => t.events()) ?? [],
              warnings = safe(() => t.warnings()) ?? [];
            let n = window.__harnessSeq ?? 0;
            const stamped = warnings.map((e) => {
              if (!Object.hasOwn(e, "__hid")) Object.defineProperty(e, "__hid", { value: ++n, enumerable: false });
              return { hid: e.__hid, ...e };
            });
            window.__harnessSeq = n;
            const previousPoll = window.__harnessPollAt ?? 0;
            window.__harnessPollAt = Date.now();
            return {
              warnings: stamped,
              events,
              requests: safe(() => t.requests()) ?? [],
              vitals: safe(() => t.vitals()) ?? {},
              ring: { size: events.length, oldestAt: events[0]?.at ?? null, previousPoll },
            };
          })
          .catch(() => null);
      let lastHid = 0,
        telemetryDoc = null; // lastHid: highest warning id consumed in this document
      const newTelemetryWarnings = async () => {
        const t = await telemetry();
        if (t === null) {
          summary.surfaces.browserTelemetry ??= false;
          return [];
        }
        summary.surfaces.browserTelemetry = true;
        // One telemetry buffer per document; pushState (in-place ?edit) keeps the same document.
        const doc = await page.evaluate(() => performance.timeOrigin).catch(() => 0);
        if (doc !== telemetryDoc) {
          telemetryDoc = doc;
          lastHid = 0;
        }
        const fresh = t.warnings.filter((w) => w.hid > lastHid);
        lastHid = Math.max(lastHid, ...t.warnings.map((w) => w.hid));
        const out = fresh.map(({ hid, ...w }) => ({ source: "browser", hid, ...w }));
        if (
          t.ring.size >= 2000 &&
          t.ring.previousPoll > 0 &&
          t.ring.oldestAt !== null &&
          t.ring.oldestAt > t.ring.previousPoll
        ) {
          out.push({
            source: "harness",
            level: "warn",
            code: "harness.telemetry-gap",
            msg: "the page's 2000-event telemetry ring wrapped between two polls; warnings in between may be lost (use a shorter step)",
          });
        }
        return out;
      };
      let serviceSeq = await svc.lastSeq();
      summary.service.metricsBefore = await svc.metrics();
      summary.surfaces.serviceDebug = svc.available ?? false;
      const serviceLogPath = join(dir, "service-log.jsonl");
      const newServiceEntries = async () => {
        const list = await svc.logSince(serviceSeq);
        if (svc.unreadable !== null && summary.surfaces.serviceLog === undefined) {
          summary.surfaces.serviceLog = svc.unreadable;
          summary.warnings.push({
            step: "(run)",
            kind: "service-log",
            details: `service log unreadable, so its svc.* warnings are not judged: ${svc.unreadable}`,
          });
        }
        if (list.length) {
          serviceSeq = Math.max(serviceSeq, ...list.map((e) => e.seq ?? 0));
          for (const e of list) appendFileSync(serviceLogPath, JSON.stringify(e) + "\n");
          summary.artifacts.serviceLog = serviceLogPath;
        }
        return list;
      };

      let depth = 0,
        failed = false,
        outerMeta = {};
      /** Wraps one user-visible action. Nested steps run inside their parent's window. */
      async function step(title, action, meta = {}) {
        if (aborted && depth === 0) {
          summary.steps.push({ title, skipped: `run aborted: ${aborted.reason}` });
          return undefined;
        }
        if (depth > 0 || (failed && (options.stopOnFailure ?? true))) {
          if (depth === 0) {
            summary.steps.push({ title, skipped: "an earlier step failed" });
            return undefined;
          }
          // A ui.* helper called inside a journey's own step: its exemptions (a rename's labelEdit…) apply to that step.
          for (const k of ["labelEdit", "selectionMayChange", "leavesEditor"]) if (meta[k]) outerMeta[k] = true;
          return census.declared(meta.navigates, () => errors.declared(meta.expects, action, title), title);
        }
        outerMeta = meta = { ...meta };
        depth++;
        census.stepStarted();
        errors.stepStarted();
        currentStep = title;
        const mark = {
          pageErrors: ev.pageErrors.length,
          console: ev.console.length,
          failed: ev.failed.length,
          responses: ev.responses.length,
          requests: ev.requests.length,
          csp: ev.csp.length,
          navigations: ev.navigations.length,
          keys: ev.keys.length,
          dialogs: ev.dialogs.length,
        };
        const beforeState = await probeState(page);
        const s = { title, startedMs: Date.now() - started, ok: true, durationMs: 0 };
        const before = await metrics();
        // Tag every request of this step for the service log (contract: X-Archer-Client-Action).
        // The service accepts [A-Za-z0-9._:-]{1,64}; log lines then carry data.action.
        const action_tag = `s${String(summary.steps.length + 1).padStart(2, "0")}:${title}`
          .replace(/[^A-Za-z0-9._:-]+/g, "-")
          .replace(/-+$/, "")
          .slice(0, 64);
        await page.setExtraHTTPHeaders({ "x-archer-client-action": action_tag }).catch(() => {});
        s.clientAction = action_tag;
        let value;
        const profiling =
          cdp &&
          (options.profile || meta.profile) &&
          (await cdp
            .send("Profiler.enable")
            .then(() => cdp.send("Profiler.setSamplingInterval", { interval: 250 }))
            .then(() => cdp.send("Profiler.start"))
            .then(
              () => true,
              () => false,
            ));
        try {
          if (typeof context.tracing.group === "function") await context.tracing.group(title);
          try {
            value = await census.declared(meta.navigates, () => errors.declared(meta.expects, action, title), title);
          } finally {
            await context.tracing.groupEnd?.().catch?.(() => {});
          }
        } catch (error) {
          s.ok = false;
          failed = true;
          if (aborted) s.aborted = aborted.reason;
          s.error = String(error.message ?? error)
            .split("\n")
            .slice(0, 12)
            .join("\n");
          const shot = join(
            dir,
            "shots",
            `${String(summary.steps.length + 1).padStart(2, "0")}-${title.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60)}.png`,
          );
          await page
            .screenshot({ path: shot, fullPage: false })
            .then(() => {
              s.screenshot = shot;
            })
            .catch(() => {});
        }
        s.durationMs = Date.now() - started - s.startedMs;
        if (profiling) {
          const p = await cdp.send("Profiler.stop").catch(() => null);
          if (p?.profile) s.cpu = splitProfile(p.profile, sandbox.origin);
        }
        s.url = page.url();
        s.perf = delta(before, await metrics());
        // A key's report is posted at its keyup, the next keydown or a setTimeout(0) (key-recorder.mjs): give the last one a moment to arrive.
        if (!aborted) await page.evaluate(() => new Promise((r) => setTimeout(r, 30))).catch(() => {});
        // An error alert a seeded condition absorbed and the page still shows after it ended (PC-601).
        if (!aborted) await errors.stepEnded().catch(() => {});
        const win = {
          pageErrors: ev.pageErrors.slice(mark.pageErrors),
          console: ev.console.slice(mark.console),
          failed: ev.failed.slice(mark.failed),
          responses: ev.responses.slice(mark.responses),
          requests: ev.requests.slice(mark.requests),
          csp: ev.csp.slice(mark.csp),
          navigations: ev.navigations.slice(mark.navigations),
          keys: ev.keys.slice(mark.keys).filter((k) => k.tab === undefined),
          dialogs: ev.dialogs.slice(mark.dialogs),
        };
        if (win.dialogs.length) s.dialogs = win.dialogs.map(({ type, message, url }) => ({ type, message, url }));
        s.requests = win.requests.filter((r) => ["fetch", "xhr", "eventsource", "document"].includes(r.type)).length;
        const svcEntries = aborted ? [] : await newServiceEntries();
        // Client events echoed into the service log are already counted from window.__archerTelemetry.
        const svcWarnings = svcEntries
          .filter((e) => (e.level === "warn" || e.level === "error") && e.source !== "client")
          .map((e) => ({
            source: "service",
            code: e.code,
            level: e.level,
            msg: e.msg,
            route: e.route,
            requestId: e.requestId,
            data: e.data,
          }));
        const warnings = [...(await newTelemetryWarnings()), ...svcWarnings];
        // Refused edits are info-level in the service log; keep them with the step that caused them.
        const refusals = svcEntries
          .filter((e) => e.code === "svc.edit-refused" || e.code === "svc.edit-postcondition")
          .map((e) => ({ code: e.code, msg: e.msg, refusal: e.data?.code, op: e.data?.op, family: e.data?.family }));
        if (refusals.length) {
          s.refusals = refusals;
          errors.refusals(refusals, meta.expects);
        }
        s.invariants = aborted
          ? []
          : await runInvariants(
              {
                page,
                window: win,
                viewRequests,
                markViewReported,
                warnings,
                refusals,
                before: beforeState,
                meta: { ...meta },
              },
              invariantConfig,
            );
        const bad = s.invariants.filter((r) => !r.ok);
        s.invariantFailures = bad.filter((r) => r.severity === "fail").map((r) => r.name);
        s.invariantWarnings = bad.filter((r) => r.severity === "warn").map((r) => r.name);
        if (warnings.length) s.warnings = warnings;
        for (const r of s.invariants) {
          const t = (summary.invariantTotals[r.name] ??= { pass: 0, fail: 0, warn: 0, skipped: 0 });
          if (r.skipped) t.skipped++;
          else if (r.ok) t.pass++;
          else t[r.severity === "warn" ? "warn" : "fail"]++;
        }
        if (!s.ok)
          summary.failures.push({
            step: title,
            kind: "action",
            error: s.error,
            message: issueMessage({ error: s.error }),
            screenshot: s.screenshot,
          });
        for (const r of bad)
          (r.severity === "fail" ? summary.failures : summary.warnings).push({
            step: title,
            kind: "invariant",
            invariant: r.name,
            details: r.details,
            message: issueMessage({ invariant: r.name, details: r.details }),
          });
        summary.steps.push(s);
        depth--;
        currentStep = null;
        progress();
        if (!s.ok && (options.stopOnFailure ?? true)) return undefined;
        return value;
      }

      const notes = [];
      const log = (...args) => {
        notes.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      };
      const ui = createUi({ page, sandbox, step, expect, run: summary, entryShots: options.entryShots ?? true });
      // A restarted service (ui.restartService) starts its log again: read it from the start.
      const onRestart = () => {
        serviceSeq = 0;
      };
      Object.assign(ui, flowsActions({ page, context, sandbox, step, expect, run: summary, onRestart, errors }));
      /**
       * A second tab in the same browser context (same cookies), or, with `fresh: true` / a `link`, a new
       * context with its own cookie jar (a reader, a second person). Its requests, console and CSP reports
       * feed the same evidence streams (tagged `tab`); step invariants still probe the first page.
       * `within: ctx` opens the tab in that (already signed-in) context, as a further tab of a fresh one.
       * Returns {page, ui, context}. `reader: true` issues an ordinary access link first (sandbox.mjs link --reader; it may still edit).
       */
      const openContext = async ({ fresh = false, reader = false, link, login = true, within } = {}) => {
        const { issueLink } = await import("../sandbox.mjs");
        let ctx = within ?? context;
        if (!within && (fresh || reader || link)) {
          ctx = await browser.newContext({
            viewport: options.viewport ?? { width: 1440, height: 900 },
            ignoreHTTPSErrors: options.ignoreHTTPSErrors ?? false,
            permissions: ["clipboard-read", "clipboard-write"],
          });
          contexts.push(ctx);
          await installReporter(ctx);
          await installFaults({ context: ctx, sandbox });
          census.watch(ctx);
          await errors.watch(ctx);
        }
        const pg = await ctx.newPage();
        pg.setDefaultTimeout(options.timeoutMs ?? 10_000);
        attach(pg, tabs++);
        const target = link ?? (reader ? issueLink({ name: sandbox.name, reader: true }).url : sandbox.link);
        if (login && ((ctx !== context && !within) || link || reader)) {
          const res = await pg.goto(target);
          if (!res || res.status() >= 400) throw new Error(`login link answered ${res?.status()}`);
        }
        return {
          page: pg,
          context: ctx,
          link: target,
          ui: Object.assign(
            createUi({ page: pg, sandbox, step, expect }),
            flowsActions({ page: pg, context: ctx, sandbox, step, expect, run: summary, onRestart, errors }),
          ),
        };
      };
      /**
       * Duplicates `from` as the browser's Duplicate tab does: `window.open(location.href)` from that page, which copies its
       * sessionStorage (and with it the tab's owner id, draft-tabs.ts) into the new tab. Returns {page, ui, context}.
       */
      const duplicateTab = async (from) => {
        const ctx = from.context();
        // The new tab's load is the journey's own (the browser's Duplicate tab), declared so the census counts it issued.
        const [pg] = await census.declared(
          true,
          () =>
            Promise.all([
              ctx.waitForEvent("page"),
              from.evaluate(() => {
                window.open(location.href);
              }),
            ]),
          "duplicate tab",
        );
        pg.setDefaultTimeout(options.timeoutMs ?? 10_000);
        attach(pg, tabs++);
        await pg.waitForLoadState("domcontentloaded").catch(() => {});
        return {
          page: pg,
          context: ctx,
          ui: Object.assign(
            createUi({ page: pg, sandbox, step, expect }),
            flowsActions({ page: pg, context: ctx, sandbox, step, expect, run: summary, onRestart, errors }),
          ),
        };
      };
      ui.duplicateTab = duplicateTab;
      ui.newTab = (opts = {}) => openContext(opts);
      ui.openContext = openContext;
      ui.readerContext = (opts = {}) => openContext({ ...opts, reader: true });
      /** `archer call <op>` as the agent, with the sandbox env (agent.mjs); logged in run.agentCalls. */
      ui.agent = agentFaults(createAgent({ sandbox, run: summary })); // follow-presented-link (ARCHER_FLOWS_FAULT), none by default
      const perfStart = await metrics();
      // The harness's own CDP session buffers every response it saw (DevTools' network records): a long journey that
      // measures the heap (perf/leak-navigation) empties that buffer between loops. The event stream is listened to again
      // at once; an event in between is not counted as an invalidation.
      const devtools = {
        clearNetworkRecords: async () => {
          if (!cdp) return false;
          await cdp.send("Network.disable");
          await cdp.send("Network.enable");
          return true;
        },
      };
      try {
        if (options.login !== false) await ui.login();
        await fn({ page, context, ui, step, expect, sandbox, log, run: summary, openContext, devtools });
      } catch (error) {
        // Outside any step (journey code itself threw).
        summary.failures.push({
          step: "(journey)",
          kind: "journey",
          error: String(error.stack ?? error)
            .split("\n")
            .slice(0, 12)
            .join("\n"),
        });
      }
      if (deadline) clearTimeout(deadline);
      if (aborted) {
        summary.aborted = aborted;
        summary.failures.push({ step: "(run)", kind: "aborted", error: aborted.reason });
      }
      summary.perf = { start: perfStart, end: aborted ? null : await metrics() };
      summary.perf.delta = delta(perfStart, summary.perf.end);
      const t = aborted ? null : await telemetry();
      if (t) {
        writeFileSync(join(dir, "browser-telemetry.json"), JSON.stringify(t, null, 2));
        summary.artifacts.browserTelemetry = join(dir, "browser-telemetry.json");
      }
      // A production page has no __archerTelemetry: the journey INP comes from the interaction-latency records then.
      summary.vitals = summaryVitals(t?.vitals ?? null, summary.steps);
      if (!aborted) await page.screenshot({ path: join(dir, "shots", "final.png") }).catch(() => {});
      await newServiceEntries();
      summary.service.metricsAfter = await svc.metrics();
      summary.service.health = await svc.health();
      if (svc.available) {
        writeFileSync(
          join(dir, "service-metrics.json"),
          JSON.stringify(
            {
              before: summary.service.metricsBefore,
              after: summary.service.metricsAfter,
              health: summary.service.health,
            },
            null,
            2,
          ),
        );
        summary.artifacts.serviceMetrics = join(dir, "service-metrics.json");
        summary.service = {
          health: summary.service.health && {
            warnings: summary.service.health.warnings,
            heapUsedMb: summary.service.health.heapUsedMb,
            eventLoopLagMs: summary.service.health.eventLoopLagMs,
          },
        };
      } else
        summary.service = {
          note: "service /-/debug/* routes not available (ARCHER_DEBUG=1 service telemetry not built yet?)",
        };
      summary.surfaces.serviceDebug = svc.available ?? false;
      if (summary.surfaces.browserTelemetry === null) summary.surfaces.browserTelemetry = false;
      if (!summary.surfaces.browserTelemetry)
        summary.surfacesNote =
          "window.__archerTelemetry absent: the sandbox page is a production build. Start the sandbox with --debug-ui for ui.* warnings.";
      finishing = true; // closing the browser below is not an abort
      await context.tracing.stop({ path: summary.artifacts.trace }).catch(() => {});
      for (const extra of contexts.slice(1)) await extra.close().catch(() => {});
      await context.close().catch(() => {}); // flushes the HAR
      await browser.close().catch(() => {});
      summary.notes = notes;
      // Every failure and warning says what it was in words (PC-18), whatever pushed it.
      for (const w of [...summary.failures, ...summary.warnings])
        if (w && typeof w === "object" && !w.message) w.message = issueMessage(w);
      summary.navigations = census.summary();
      summary.errors = errors.summary({ failures: summary.failures });
      summary.durationMs = Date.now() - started;
      summary.ok = summary.failures.length === 0 && summary.steps.every((s) => s.ok !== false);
      // Roll-up: each distinct warning code once, with how many times and in which steps.
      const codes = {};
      for (const st of summary.steps)
        for (const w of st.warnings ?? []) {
          const c = (codes[w.code ?? "(none)"] ??= { count: 0, steps: [], example: w.msg });
          c.count++;
          if (!c.steps.includes(st.title)) c.steps.push(st.title);
        }
      summary.warningCodes = codes;
      summary.counts = {
        steps: summary.steps.length,
        failedSteps: summary.steps.filter((s) => s.ok === false).length,
        failures: summary.failures.length,
        warnings: summary.warnings.length,
      };
      summary.budget = budgetFromEvidence({ name, ev, summary, origin: sandbox.origin });
      summary.artifactsRelative = Object.fromEntries(
        Object.entries(summary.artifacts).map(([k, v]) => [k, relative(process.cwd(), v)]),
      );
      writeFileSync(
        summary.artifacts.summary,
        JSON.stringify(summary, (k, v) => (v instanceof RegExp ? String(v) : v), 2),
      );
      progress({ done: true, ok: summary.ok, ...(aborted ? { aborted: aborted.reason } : {}) });
      return summary;
    })();
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/**
 * Which document the first page's requests belong to: the one that issued them. A navigation request of the main
 * frame opens the next document (each redirect hop is one of its own), but the outgoing page keeps issuing requests
 * until the new one commits (its `pagehide` runs then): a late request of the old page filed under the new one read
 * as a duplicate there (O23, the ELK worker fetched twice). So requests move to the new document only at its commit:
 * `framenavigated` at the address it asked for, once its answer has arrived. A navigation that cannot commit (it
 * failed or was cancelled, or answered 204/205) is dropped, so a later same-document change of the page that stayed
 * (a hash, `pushState`) never commits it. `of(request)` is the request's document; `onCommit(url)` runs at each commit.
 */
export function trackDocuments(pg, { onCommit = () => {} } = {}) {
  const docs = new WeakMap();
  let current = 0,
    opened = 0,
    pending = null;
  const bare = (url) => url.split("#")[0];
  const isDocument = (r) => r.isNavigationRequest() && r.frame() === pg.mainFrame();
  pg.on("request", (r) => {
    if (!isDocument(r)) {
      docs.set(r, current);
      return;
    }
    pending = { id: ++opened, request: r, answered: false };
    docs.set(r, opened);
  });
  pg.on("response", (res) => {
    if (pending === null || res.request() !== pending.request) return;
    const status = res.status();
    if (status === 204 || status === 205) pending = null;
    else if (status < 300 || status >= 400) pending.answered = true;
  });
  pg.on("requestfailed", (r) => {
    if (pending !== null && r === pending.request) pending = null;
  });
  pg.on("framenavigated", (f) => {
    if (f !== pg.mainFrame() || pending === null || !pending.answered || bare(f.url()) !== bare(pending.request.url()))
      return;
    current = pending.id;
    const url = pending.request.url();
    pending = null;
    onCommit(url);
  });
  return { of: (r) => docs.get(r) ?? current };
}

/**
 * summary.budget (schema archer-budget/1, tools/perf/lib/budget.mjs): one row per document the first page loaded,
 * with its requests (telemetry uploads left out), API requests, duplicate requests (the shared classifier: tagged
 * poll ticks, and reads again after a person's input or an event-stream message, excluded), transfer bytes; run totals; warnings by code; failures by invariant. A release check gates on this.
 */
export function budgetFromEvidence({ name, ev, summary, origin }) {
  const primary = ev.requests.filter((r) => r.tab === undefined && !/\/-\/debug\//.test(r.url));
  const docs = new Map();
  for (const r of primary) (docs.get(r.doc) ?? docs.set(r.doc, []).get(r.doc)).push(r);
  const pages = [...docs].map(([doc, reqs]) => {
    const document = reqs.find((r) => r.type === "document");
    const url = (document?.url ?? reqs[0]?.url ?? "").replace(origin, "").replace(/([?&]token=)[^&#]+/, "$1…");
    return pageBudget({
      key: `doc${doc}`,
      url,
      requests: reqs.map((r) => ({ ...r, body: r.body })),
      invalidations: ev.invalidations,
    });
  });
  const warnings = {};
  for (const [code, c] of Object.entries(summary.warningCodes ?? {})) warnings[code] = c.count;
  return budgetResults({
    source: "harness",
    name,
    generatedAt: summary.startedAt,
    pages,
    warnings,
    failures: summary.failures,
    duplicateWrites: summary.invariantTotals?.["duplicate-writes"]?.fail ?? 0,
  });
}
