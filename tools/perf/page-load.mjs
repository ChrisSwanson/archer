#!/usr/bin/env node
// Archer page-load lab: cold and warm loads of the main pages, measured in Chromium (Playwright + CDP).
//
//   node tools/perf/page-load.mjs --base https://host:40399 --login 'https://host:40399/projects/?token=…'
//        [--project <slug>] [--diagram <source path>] [--pages projects,project-folders,…]
//        [--profiles default,remote-link] [--runs 1] [--out <dir>] [--budget tools/release-check/lab-budgets.json]
//        [--write-budget <file> [--accept-drop]] [--lighthouse] [--allow-writes] [--timeout 60000] [--headed] [--initiators]
//        [--fixture rubric] [--flow <source path>] [--note <note path>]
//        [--manifest tools/perf/manifests.json [--allow-proposed]] [--write-manifest <file>]
//        [--tls-ca <ca.pem> | --tls-spki <base64>] [--coverage] [--chain] [--no-commits] [--require-complete]
//
// Writes <out>/perf-report.json, <out>/perf-report.md and <out>/summary.json (the `budget` block, schema
// archer-budget/1, shared with the smoke harness). With --budget, exits 1 when a measured value is over its cap.
// --write-budget seeds caps from this run, all or nothing: a row that failed, drew an all-but-empty page, came from
// the cache on a cold load, or would cut a DOM/request cap of the file it replaces by more than half is refused, the
// file is left as it was and the exit is 1 (--accept-drop takes such drops as real).
// --initiators records the JS call stack that issued each request (CDP initiator + async stacks; S1's chain depth
// needs the async stacks, lib/chain.mjs, and is an upper bound without them), so duplicates
// and top patterns name their call sites; use an unminified page for readable names (docs/devkit/browser-telemetry.md). Read-only by default: every /api/ request that could change something is refused
// in the browser before it leaves (see READ_ONLY_POSTS), so it is safe against a person's own service.
// docs/devkit/browser-telemetry.md explains the output.
//
// Performance rubric (docs/quality/rubrics/performance.md) collectors:
//   --fixture rubric   the §1 matrix: project awkward, fixture-seq-full (sequence), flow-styled (graph), notes/auth.md
//   --manifest <file>  G1: every request in each load's window matches an entry for its surface and state
//                      (lib/manifest.mjs); exit 1 on a miss. --allow-proposed counts entries not yet approved.
//   --write-manifest   writes entries from this run with EMPTY reasons (they fail until a reviewer fills them)
//   rows always carry the response ETag, Cache-Control and the wire status from responseReceivedExtraInfo (G2, G5)
//   --tls-ca/--tls-spki trust exactly the sandbox's leaf certificate (lib/tls.mjs) instead of ignoring TLS errors,
//                      which stops Chromium caching; warm rows then get the G5 cache-on-wire check (lib/cache.mjs)
//   --coverage         S2: --runs extra cold+warm loads per page and profile with V8 block coverage (page and
//                      auto-attached workers, before they run) and CSS rule usage (lib/coverage.mjs); never mixed
//                      with timing runs. Max of the runs; a script, worker or sheet that cannot be read, or a run
//                      that fails, makes the cell's coverage NOT EVALUATED (never zero bytes)
//   --chain            S1: --runs extra cold+warm loads per page and profile with async stacks (debugger on, so
//                      never timed), reduced to the request dependency depth on the critical path (lib/chain.mjs)
//   every load: route-ready (lib/readiness.mjs, S7) closes the window's start, then 1.5 s quiet; Performance.getMetrics
//   deltas (TaskDuration, LayoutCount, RecalcStyleCount, S3) taken before any lab probe; React commits (--no-commits
//   turns the counter off); a row that timed out, never got ready, is empty or on the wrong route is incomplete,
//   and so is a cell short of its --runs samples (a run that threw) or, under --fixture rubric, with fewer than 3.
//   An incomplete cell makes summary.json ok false; with --fixture rubric or --require-complete the exit is 1.
//   <out>/requests.jsonl: every request of every run (tokens redacted), and <out>/loads.jsonl: each load's
//   route-ready (rows' clock) and in-view identities, for offline checks (manifest-tool.mjs check --loads).
//   G1 measures each row's phase itself (lib/manifest.mjs measuredPhase) and checks it against the entry's; a
//   project page's read of another project is `other`; thumbnails and note figures in view at route-ready are
//   `data`, the rest `prefetch`.
//   --seed-fault duplicate-read|extra-request|wrong-target|failed-request|no-revalidate|fail-sample: a known bad case injected
//                      by the lab (never the product), to show each gate failing (rubric §8)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { request as httpsRequest } from "node:https";
import {
  DOM_SHAPE_SCRIPT,
  PROFILES,
  domShape,
  firstLoadBytes,
  initiatorOf,
  markdown,
  medianOf,
  overBudget,
  parseServerTiming,
  seedBudgets,
  summariseLoad,
} from "./lib/report.mjs";
import { budgetResults, pageBudget } from "./lib/budget.mjs";
import { invalidates, pollTagOf } from "./lib/requests.mjs";
import {
  MANIFEST_SCHEMA,
  RUBRIC_FIXTURE,
  anchorPhases,
  checkLoad,
  entriesFor,
  inViewIdentities,
  seedEntries,
  shownFor,
  validateManifest,
} from "./lib/manifest.mjs";
import {
  READY_KIND,
  RUBRIC_SAMPLES,
  cellCompleteness,
  noteMarkProblems,
  readinessVerdict,
  readyScript,
  runSamples,
} from "./lib/readiness.mjs";
import { tlsSetup } from "./lib/tls.mjs";
import {
  WORKER_MESSAGES_SCRIPT,
  coverageCell,
  coverageSummary,
  scriptCoverage,
  styleCoverage,
  workerMessageSummary,
} from "./lib/coverage.mjs";
import { CHAIN_GAP_MS, chainDepth, chainInitiator } from "./lib/chain.mjs";
import { cacheOnWire } from "./lib/cache.mjs";
import { VITALS_SCRIPT, loafSummary, shiftElements, shiftSignature, shiftsAfter } from "./lib/vitals.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const require = createRequire(join(REPO, "package.json"));

export const PAGES = [
  "projects",
  "project-folders",
  "project-diagrams",
  "project-notes",
  "diagram",
  "flow-diagram",
  "diagram-edit",
  "new-diagram",
  "note",
  "diagram-folder-path",
  "note-alias",
];
const KNOWN_BASELINE =
  "before this lab: a 5 MB uncompressed page on an uncached load; ~150 comment requests per project page; the Diagrams tab ~2.25 MB and 5–7 s over a remote link.";

/** POSTs under /api/ that only read (compile, preview, search, open). Every other non-GET is refused. */
const READ_ONLY_POSTS = [
  /\/api\/compile$/,
  /\/api\/search$/,
  /\/api\/browser-search$/,
  /\/api\/authoring\/(open|preview|edit|snapshot)$/,
];
/** `POST api/operations` runs a named operation; these only read (thumbnails, comparisons). */
const READ_ONLY_OPERATIONS = new Set([
  "export_diagram",
  "compare_diagrams",
  "list_stale_diagrams",
  "read_diagram_at_commit",
]);
/** `POST api/authoring/presentation` reads or saves a layout, by `op`. */
const bodyField = (postData, field) => {
  try {
    return JSON.parse(postData ?? "{}")[field];
  } catch {
    return undefined;
  }
};

/** Whether the lab lets a request through in read-only mode. */
export function readOnlyAllows(method, path, postData) {
  if (method === "GET" || method === "HEAD") return true;
  if (method !== "POST") return false;
  if (READ_ONLY_POSTS.some((p) => p.test(path))) return true;
  if (/\/api\/operations$/.test(path)) return READ_ONLY_OPERATIONS.has(bodyField(postData, "name"));
  if (/\/api\/authoring\/presentation$/.test(path)) return bodyField(postData, "op") === "read";
  return false;
}

// The in-page vitals observer (paint, LCP, CLS with shift sources, long tasks, LoAF, Event Timing): lib/vitals.mjs.
export { VITALS_SCRIPT };

/**
 * Counts React commits in any root (an install-before-React DevTools hook: react-dom calls `onCommitFiberRoot` on
 * every commit, in production builds too). Opt in with `context.addInitScript`; the lab itself does not install it.
 */
export const COMMIT_COUNTER_SCRIPT = `(() => {
  window.__archerCommitCount = 0;
  const hook = { supportsFiber: true, renderers: new Map(), inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    onCommitFiberRoot() { window.__archerCommitCount++; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {} };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true });
})();`;

function options() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      login: { type: "string" },
      project: { type: "string" },
      diagram: { type: "string" },
      pages: { type: "string" },
      profiles: { type: "string", default: "default,remote-link" },
      runs: { type: "string", default: "1" },
      out: { type: "string" },
      budget: { type: "string" },
      "write-budget": { type: "string" },
      "accept-drop": { type: "boolean" },
      lighthouse: { type: "boolean" },
      "allow-writes": { type: "boolean" },
      timeout: { type: "string", default: "60000" },
      headed: { type: "boolean" },
      help: { type: "boolean" },
      initiators: { type: "boolean" },
      fixture: { type: "string" },
      "require-complete": { type: "boolean" },
      flow: { type: "string" },
      note: { type: "string" },
      manifest: { type: "string" },
      "write-manifest": { type: "string" },
      "allow-proposed": { type: "boolean" },
      "tls-ca": { type: "string" },
      "seed-fault": { type: "string" },
      chain: { type: "boolean" },
      "tls-spki": { type: "string" },
      coverage: { type: "boolean" },
      "no-commits": { type: "boolean" },
    },
  });
  if (values.help || !values.base) {
    process.stderr.write(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 18)
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n") + "\n",
    );
    process.exit(values.help ? 0 : 2);
  }
  const profiles = values.profiles
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of profiles)
    if (!PROFILES[p]) throw new Error(`unknown profile ${p} (have ${Object.keys(PROFILES).join(", ")})`);
  const pages = (values.pages ?? PAGES.join(","))
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of pages) if (!PAGES.includes(p)) throw new Error(`unknown page ${p} (have ${PAGES.join(", ")})`);
  // The rubric's matrix (§1): one fixed project and the three pages it names, unless given explicitly.
  if (values.fixture === "rubric")
    Object.assign(values, {
      project: values.project ?? RUBRIC_FIXTURE.project,
      diagram: values.diagram ?? "diagrams/fixture-seq-full.mmd",
      flow: values.flow ?? "diagrams/flow-styled.mmd",
      note: values.note ?? RUBRIC_FIXTURE.note,
    });
  else if (values.fixture !== undefined) throw new Error(`unknown --fixture ${values.fixture} (have: rubric)`);
  return {
    ...values,
    base: values.base.replace(/\/$/, ""),
    profiles,
    pages,
    runs: Math.max(1, Number(values.runs) || 1),
    timeout: Number(values.timeout) || 60000,
  };
}

/** The content-encoding the service answers a br-capable reader of `url` with (warm-up only; body discarded). */
export function documentCoding(url, caPath, cookie) {
  return new Promise((resolveCoding) => {
    const req = httpsRequest(
      url,
      { ca: readFileSync(caPath), headers: { cookie, "accept-encoding": "br, gzip" }, timeout: 10000 },
      (res) => {
        res.resume();
        resolveCoding(res.headers["content-encoding"] ?? null);
      },
    );
    req.on("error", () => resolveCoding(null));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

/** The project and diagram to measure, from the service's own project list. */
export async function resolveTargets(context, opts) {
  // Read through the browser, not Node: with scoped TLS (--tls-ca) only Chromium trusts the sandbox's certificate.
  const page = await context.newPage();
  let answer;
  try {
    await page.goto(`${opts.base}/projects/`, { waitUntil: "domcontentloaded", timeout: opts.timeout });
    answer = await page.evaluate(async () => {
      const r = await fetch("/api/browser-projects");
      return { status: r.status, json: r.ok ? await r.json() : null };
    });
  } finally {
    await page.close();
  }
  if (answer.status !== 200)
    throw new Error(`GET /api/browser-projects returned ${answer.status}; is the login link valid?`);
  const projects = answer.json.projects ?? [];
  const project = opts.project
    ? projects.find((p) => p.slug === opts.project)
    : [...projects].sort((a, b) => (b.views?.length ?? 0) - (a.views?.length ?? 0))[0];
  if (!project) throw new Error(opts.project ? `no project ${opts.project}` : "the service lists no projects");
  const targets = diagramTargets(project, opts.diagram, { flow: opts.flow, note: opts.note });
  return { project: project.slug, ...targets };
}

const encodedPath = (path) => path.split("/").map(encodeURIComponent).join("/");

/**
 * The page addresses to measure for one catalog project (pure). A diagram is measured at its canonical address,
 * `/projects/<name>/<folder-relative path>`: the one the page's own links and the agent hand out. `--diagram` may
 * name it either way (`diagrams/x.mmd` or `.archer/diagrams/x.mmd`). `diagram-folder-path` keeps a row for the
 * project-path form (`/projects/<name>/.archer/diagrams/x.mmd`), which once loaded the page twice (perf #3).
 */
export function diagramTargets(project, requested, { flow, note } = {}) {
  const views = (project.views ?? []).filter((v) => v.registration !== "embedded" && typeof v.sourcePath === "string");
  const documents = Array.isArray(project.documents) ? project.documents : (project.documents?.documents ?? []);
  // The project path of a view's file, from the documents catalog (`legacy.viewId` names the view).
  const projectPathOf = (view) => documents.find((d) => d.legacy?.viewId === view.id)?.source?.path ?? null;
  const strip = (path) => path.replace(/^\.\//, "");
  let view = null;
  if (requested === undefined) view = views.find((v) => v.sourcePath.endsWith(".mmd")) ?? null;
  else
    view = views.find((v) => strip(v.sourcePath) === strip(requested) || projectPathOf(v) === strip(requested)) ?? null;
  const diagram = view === null ? (requested === undefined ? null : strip(requested)) : strip(view.sourcePath);
  const folderPath = view === null ? null : projectPathOf(view);
  const root = `/projects/${project.slug}/`,
    file = diagram ? `${root}${encodedPath(diagram)}` : null;
  // The graph page (§1 "flow-diagram"): the view named by --flow, else the first freeform (flowchart) view.
  const flowView =
    flow !== undefined
      ? views.find((v) => strip(v.sourcePath) === strip(flow) || projectPathOf(v) === strip(flow) || v.id === flow)
      : views.find((v) => v.kind === "freeform");
  // The note page: --note (a folder-relative note path), else the first note document with an embedded figure.
  const noteDocs = documents.filter((d) => d.kind === "markdown" && typeof d.legacy?.notePath === "string");
  const noteDoc =
    note !== undefined
      ? noteDocs.find((d) => d.legacy.notePath === strip(note) || d.source?.path === strip(note))
      : noteDocs[0];
  const paths = {
    projects: "/projects/",
    "project-folders": root,
    "project-diagrams": `${root}?tab=diagrams`,
    "project-notes": `${root}?tab=notes`,
    diagram: file,
    "diagram-edit": file ? `${file}?edit` : null,
    "new-diagram": `${root}-/edit/`,
    "diagram-folder-path": folderPath !== null && folderPath !== diagram ? `${root}${encodedPath(folderPath)}` : null,
    "flow-diagram": flowView ? `${root}${encodedPath(strip(flowView.sourcePath))}` : null,
    note: noteDoc ? `${root}${encodedPath(noteDoc.legacy.notePath)}` : null,
    "note-alias":
      noteDoc?.source?.path && noteDoc.source.path !== noteDoc.legacy.notePath
        ? `${root}${encodedPath(noteDoc.source.path)}`
        : null,
  };
  // What each page shows, for the manifest's targets: the view ids and note path behind these addresses.
  const shown = {
    diagram: view?.id ?? null,
    flow: flowView?.id ?? null,
    note: noteDoc?.legacy.notePath ?? null,
    diagramKind: view?.kind ?? null,
  };
  // Where each address should end: aliases redirect to the canonical page.
  const canonical = { ...paths, "diagram-folder-path": paths.diagram, "note-alias": paths.note };
  return { diagram, paths, shown, canonical };
}

/** Records every request the page makes through CDP, and refuses writes when read-only. */
/**
 * The read-only guard on one page's CDP session: an /api/ request `readOnlyAllows` goes on, any other fails
 * (BlockedByClient) and is named in `blocked`. Every page the lab loads in read-only mode has it, the unmeasured
 * warm-up included: a write there (the reader's selection, saved as the project's remembered view) changed what
 * the next surface's page showed, so a row depended on the surfaces run before it.
 */
export async function guardReadOnly(cdp, blocked) {
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] });
  cdp.on("Fetch.requestPaused", (e) => {
    const { method, url } = e.request,
      path = new URL(url).pathname;
    if (readOnlyAllows(method, path, e.request.postData))
      void cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
    else {
      blocked.push(`${method} ${path}`);
      void cdp.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }
  });
}

/**
 * With --initiators: the requests dedicated workers make (their Network domain is the worker target's, not this
 * session's), as finished rows marked `fromWorker`, with their initiators, for the chain depth (S1). Workers start
 * paused until their Network and async stacks are on. They do not hold the load's quiet window open.
 */
async function recordWorkerRequests(cdp, rows) {
  let next = 0;
  const open = new Map(),
    scriptOf = new Map();
  cdp.on("Target.attachedToTarget", (e) => {
    if (e.targetInfo.type !== "worker") return;
    scriptOf.set(e.sessionId, e.targetInfo.url);
    const send = (method, params = {}) =>
      cdp
        .send("Target.sendMessageToTarget", {
          sessionId: e.sessionId,
          message: JSON.stringify({ id: ++next, method, params }),
        })
        .catch(() => {});
    void (async () => {
      await send("Network.enable");
      await send("Debugger.enable");
      await send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
      await send("Runtime.runIfWaitingForDebugger");
    })();
  });
  cdp.on("Target.receivedMessageFromTarget", (e) => {
    let m;
    try {
      m = JSON.parse(e.message);
    } catch {
      return;
    }
    const p = m.params ?? {},
      key = `${e.sessionId}:${p.requestId}`;
    if (m.method === "Network.requestWillBeSent")
      open.set(key, {
        requestId: `worker:${key}`,
        fromWorker: true,
        url: p.request.url,
        method: p.request.method,
        type: p.type ?? "Other",
        status: null,
        startMs: p.timestamp * 1000,
        endMs: p.timestamp * 1000,
        transferBytes: 0,
        decodedBytes: 0,
        fromCache: false,
        serverTiming: {},
        initiatorType: p.initiator?.type ?? null,
        initiatorInfo: chainInitiator(p.initiator),
      });
    else if (m.method === "Network.responseReceived" && open.has(key))
      open.get(key).status = p.response?.status ?? null;
    // Under host load the worker's requestWillBeSent can be missing while its answer arrives (O219: the live worker
    // control lost /w-data 2 of 3 runs): the row is rebuilt from the answer, its start from the response timing on
    // the same clock, its initiator the worker's own script, the method unknown (never guessed), and marked. The
    // worker's own script is not rebuilt: the page's session records it (a second row made the control's depth 4).
    else if (m.method === "Network.responseReceived" && p.response?.url && p.response.url !== scriptOf.get(e.sessionId))
      open.set(key, {
        requestId: `worker:${key}`,
        fromWorker: true,
        recoveredFrom: "responseReceived",
        url: p.response.url,
        method: null,
        type: p.type ?? "Other",
        status: p.response.status ?? null,
        startMs: (p.response.timing?.requestTime ?? p.timestamp) * 1000,
        endMs: p.timestamp * 1000,
        transferBytes: 0,
        decodedBytes: 0,
        fromCache: false,
        serverTiming: {},
        initiatorType: "script",
        initiatorInfo: {
          type: "script",
          url: null,
          frameUrl: scriptOf.get(e.sessionId) ?? null,
          async: false,
          asyncKind: null,
        },
      });
    else if ((m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") && open.has(key)) {
      const r = open.get(key);
      open.delete(key);
      Object.assign(r, {
        endMs: p.timestamp * 1000,
        ...(m.method === "Network.loadingFinished"
          ? { transferBytes: p.encodedDataLength ?? 0 }
          : { error: p.errorText }),
      });
      rows.push(r);
    }
  });
  await cdp
    .send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
      filter: [{ type: "worker", exclude: false }, { exclude: true }],
    })
    .catch(() => {});
}

export async function instrument(page, profile, readOnly, initiators = false, seedFault = null) {
  const cdp = await page.context().newCDPSession(page);
  const requests = new Map(),
    done = [],
    blocked = [],
    invalidations = [],
    workerRows = [];
  let networkEmulation = null;
  let lastActivity = Date.now();
  const inFlight = new Set();
  // The first request to the service API (not the page, not a static asset): the app has started. Under a throttled
  // CPU the 5 MB document can take seconds to parse and compile; no quiet window may start before this.
  let apiSeen = false,
    loadedAt = null;
  // A request repeating one already made in this load (a poll, a duplicate) neither holds the load
  // open nor counts as activity: otherwise a 1 s poll would keep a page from ever settling.
  const seen = new Set();
  const wireById = new Map();
  const finish = (id, patch) => {
    const r = requests.get(id);
    if (!r) return;
    Object.assign(r, patch);
    requests.delete(id);
    if (inFlight.delete(id)) lastActivity = Date.now();
    done.push(r);
  };
  cdp.on("Network.requestWillBeSent", (e) => {
    if (e.redirectResponse && requests.has(e.requestId))
      finish(e.requestId, {
        status: e.redirectResponse.status,
        endMs: e.timestamp * 1000,
        transferBytes: e.redirectResponse.encodedDataLength ?? 0,
      });
    if (/^(?:data|blob):/.test(e.request.url) || e.request.url.includes("/-/debug/")) return;
    // A dedicated worker's script (no loader): its response and size reach the worker's own target, never this
    // session, so it must not hold the load open. Its bytes come from Resource Timing (measure).
    const worker = e.type === "Script" && !e.loaderId;
    const poll = pollTagOf({ headers: e.request.headers });
    const row = {
      requestId: e.requestId,
      ...(worker ? { worker: true } : {}),
      ...(poll ? { poll } : {}),
      url: e.request.url,
      method: e.request.method,
      ...(e.request.postData ? { body: e.request.postData.slice(0, 200) } : {}),
      ...(initiators ? { initiator: initiatorOf(e.initiator) } : {}),
      initiatorType: e.initiator?.type ?? null,
      initiatorInfo: chainInitiator(e.initiator),
      priority: e.request.initialPriority ?? null,
      type: e.type ?? "Other",
      status: null,
      startMs: e.timestamp * 1000,
      endMs: e.timestamp * 1000,
      transferBytes: 0,
      decodedBytes: 0,
      fromCache: false,
      serverTiming: {},
    };
    // The wire's own answer (304 or 200) can arrive before or after responseReceived: kept by request id (G5).
    const wire = wireById.get(e.requestId);
    if (wire && !e.redirectResponse) Object.assign(row, wire);
    requests.set(e.requestId, row);
    if (/\/api\//.test(e.request.url)) apiSeen = true;
    const key = `${e.request.method} ${e.request.url} ${e.request.postData ?? ""}`;
    if (e.type !== "EventSource" && !worker && !seen.has(key)) {
      inFlight.add(e.requestId);
      lastActivity = Date.now();
    }
    seen.add(key);
  });
  // The status on the wire, before the cache answered for it: a revalidated shell is 304 here and 200 in responseReceived.
  cdp.on("Network.responseReceivedExtraInfo", (e) => {
    const wire = {
      wireStatus: e.statusCode,
      wireCacheControl: Object.entries(e.headers ?? {}).find(([k]) => k.toLowerCase() === "cache-control")?.[1] ?? null,
    };
    const r = requests.get(e.requestId) ?? done.findLast((x) => x.requestId === e.requestId);
    if (r) Object.assign(r, wire);
    else wireById.set(e.requestId, wire);
  });
  cdp.on("Network.requestServedFromCache", (e) => {
    const r = requests.get(e.requestId);
    if (r) r.fromCache = true;
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = requests.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    if (e.response.fromDiskCache || e.response.fromPrefetchCache || e.response.fromServiceWorker) r.fromCache = true;
    const header = Object.entries(e.response.headers ?? {}).find(([k]) => k.toLowerCase() === "server-timing")?.[1];
    r.serverTiming = parseServerTiming(header);
    // ETag (the classifier's "changed answer", G2) and the caching headers (G5) on every row.
    const h = (name) => Object.entries(e.response.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
    r.etag = h("etag");
    r.cacheControl = h("cache-control");
    r.contentEncoding = h("content-encoding");
    r.protocol = e.response.protocol ?? null;
    if (r.type === "EventSource") {
      inFlight.delete(e.requestId);
    }
  });
  // An event-stream message is a reason to read again (the shared classifier's `invalidations`, on the rows' clock);
  // a heartbeat carries no data and is not.
  cdp.on("Network.eventSourceMessageReceived", (e) => {
    if (invalidates(e.eventName)) invalidations.push(e.timestamp * 1000);
  });
  cdp.on("Network.dataReceived", (e) => {
    const r = requests.get(e.requestId);
    if (r) r.decodedBytes += e.dataLength;
  });
  cdp.on("Network.loadingFinished", (e) =>
    finish(e.requestId, { endMs: e.timestamp * 1000, transferBytes: e.encodedDataLength }),
  );
  cdp.on("Network.loadingFailed", (e) =>
    finish(e.requestId, { endMs: e.timestamp * 1000, error: e.errorText, ...(e.canceled ? { canceled: true } : {}) }),
  );
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  // Async parents make `fetch` inside an async function name the code that awaited it, not only the microtask.
  // Runtime.setAsyncCallStackDepth alone records no async parent: the stacks come from the Debugger domain (checked
  // on the live chain controls, tools/perf/test/chain-live.test.mjs). The debugger slows the page's scripts, so the
  // round measures S1 in its own --chain loads, never in the timed ones.
  let asyncStacks = false;
  if (initiators) {
    await cdp.send("Runtime.setAsyncCallStackDepth", { maxDepth: 32 }).catch(() => {});
    asyncStacks = await cdp
      .send("Debugger.enable")
      .then(() => cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 }))
      .then(
        () => true,
        () => false,
      );
    await recordWorkerRequests(cdp, workerRows);
  }
  // Per-request rules (emulateNetworkConditions is deprecated, CDP Network.pdl); the old call only where rules are missing.
  // The empty pattern matches every request ("*" matches none: measured 7 ms vs 210 ms on a 200 ms rule).
  if (profile.network) {
    try {
      await cdp.send("Network.emulateNetworkConditionsByRule", {
        offline: false,
        matchedNetworkConditions: [{ urlPattern: "", ...profile.network }],
      });
      networkEmulation = "emulateNetworkConditionsByRule";
    } catch {
      await cdp.send("Network.emulateNetworkConditions", { offline: false, ...profile.network });
      networkEmulation = "emulateNetworkConditions (deprecated; ByRule unavailable)";
    }
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  // --seed-fault no-revalidate (G5 demo): the browser's HTTP cache is switched off for this page, so the warm shell
  // and the worker cross the wire again, as under baseline B's ignoreHTTPSErrors. (Rewriting the document's headers
  // in Fetch does not do it: Chromium keeps the validator it got from the network and still revalidates.)
  if (seedFault === "no-revalidate") await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (readOnly) await guardReadOnly(cdp, blocked);
  return {
    cdp,
    get networkEmulation() {
      return networkEmulation;
    },
    asyncStacks,
    reset() {
      requests.clear();
      done.length = 0;
      workerRows.length = 0;
      invalidations.length = 0;
      inFlight.clear();
      seen.clear();
      wireById.clear();
      lastActivity = Date.now();
      apiSeen = false;
      loadedAt = null;
    },
    /** Call once `load` has fired: the quiet window counts from here at the earliest, not from before the navigation. */
    markLoaded() {
      loadedAt = Date.now();
      lastActivity = Math.max(lastActivity, loadedAt);
    },
    /** Everything recorded, the still-open requests (an SSE stream) included. */
    snapshot: () => [...done, ...requests.values(), ...workerRows],
    invalidations,
    blocked,
    /** Settled: nothing in flight (open event streams aside) for `quietMs`, or the timeout. */
    async settle(quietMs, timeoutMs, isReady = null) {
      const start = Date.now();
      let readyAt = isReady ? null : start;
      for (;;) {
        await new Promise((r) => setTimeout(r, 100));
        // The window (§1) is navigation → route-ready, then quietMs without network activity: no quiet before ready.
        if (readyAt === null && (await isReady().catch(() => false))) {
          readyAt = Date.now();
          lastActivity = Math.max(lastActivity, readyAt);
        }
        if (readyAt === null) {
          if (Date.now() - start > timeoutMs)
            return { timedOut: true, settledAt: Date.now(), open: ["route-ready never reached"] };
          continue;
        }
        // Not settled before DOMContentLoaded + load have happened (markLoaded) and the first /api/ request was issued:
        // otherwise the window "settles" while the document is still compiling and the row reports a 3-request load.
        if (loadedAt !== null && apiSeen && inFlight.size === 0 && Date.now() - lastActivity >= quietMs)
          return { timedOut: false, settledAt: lastActivity };
        if (loadedAt !== null && !apiSeen && Date.now() - loadedAt > Math.min(timeoutMs, 15000))
          return { timedOut: false, noApiRequest: true, settledAt: Date.now() };
        if (Date.now() - start > timeoutMs)
          return {
            timedOut: true,
            settledAt: Date.now(),
            open: [...inFlight]
              .map((id) => requests.get(id))
              .filter(Boolean)
              .map((r) => `${r.method} ${r.url} (${r.type})`)
              .slice(0, 5),
          };
      }
    },
  };
}

/**
 * Heap after two forced garbage collections, in bytes: the page's main thread and (with a browser CDP session)
 * every dedicated worker running now, summed; null where it could not be read. Report only.
 */
export async function heapAfterGc(cdp, browserCdp) {
  const settled = async (send) => {
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
    return (await send("Runtime.getHeapUsage")).usedSize;
  };
  const main = await settled((method) => cdp.send(method)).catch(() => null);
  if (!browserCdp) return { main, workers: null };
  let workers = 0,
    id = 0;
  const replies = new Map(),
    listen = (e) => {
      const m = JSON.parse(e.message);
      replies.get(m.id)?.(m.result ?? {});
    };
  browserCdp.on("Target.receivedMessageFromTarget", listen);
  try {
    for (const t of (await browserCdp.send("Target.getTargets")).targetInfos.filter((x) => x.type === "worker")) {
      const { sessionId } = await browserCdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: false });
      const send = (method) =>
        new Promise((resolve) => {
          const n = ++id;
          replies.set(n, resolve);
          void browserCdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: n, method }) });
        });
      workers += await settled(send);
      await browserCdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
    return { main, workers };
  } catch {
    return { main, workers: null };
  } finally {
    browserCdp.off("Target.receivedMessageFromTarget", listen);
  }
}

/** Performance.getMetrics as {name: value}. */
const metricsOf = async (cdp) =>
  Object.fromEntries(
    ((await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }))).metrics ?? []).map((m) => [
      m.name,
      m.value,
    ]),
  );
/**
 * The main-thread work of one load (S3), durations in ms. CDP's Performance metrics restart with each document
 * (a warm load's values fall below the cold load's), so a value that went down is read as since-document-start;
 * otherwise the delta from before the navigation.
 */
export function workDelta(before, after) {
  const reset =
    typeof after.TaskDuration === "number" &&
    typeof before.TaskDuration === "number" &&
    after.TaskDuration < before.TaskDuration;
  const d = (k) =>
    typeof after[k] !== "number" ? null : reset || typeof before[k] !== "number" ? after[k] : after[k] - before[k];
  const ms = (k) => {
    const v = d(k);
    return v === null ? null : Math.round(v * 10000) / 10;
  };
  return {
    taskDurationMs: ms("TaskDuration"),
    scriptDurationMs: ms("ScriptDuration"),
    layoutDurationMs: ms("LayoutDuration"),
    recalcStyleDurationMs: ms("RecalcStyleDuration"),
    layoutCount: d("LayoutCount"),
    recalcStyleCount: d("RecalcStyleCount"),
  };
}

export async function measure(page, probe, url, opts) {
  probe.reset();
  const started = Date.now();
  const before = await metricsOf(probe.cdp);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeout });
  await page.waitForLoadState("load", { timeout: opts.timeout });
  probe.markLoaded();
  const isReady = opts.readyKind ? () => page.evaluate(() => Boolean(window.__perfReady)) : null;
  const settled = await probe.settle(1500, opts.timeout, isReady);
  // Taken before any lab probe below (DOM shape, heap, forced GC), so the probes do not count as the page's work.
  const after = await metricsOf(probe.cdp);
  const lab = await page.evaluate(() => ({
    ...Object.fromEntries(
      Object.entries(window.__perfLab ?? {}).filter(
        ([k, v]) => typeof v !== "function" && !["events", "inputs"].includes(k),
      ),
    ),
    ready: window.__perfReady ?? null,
    atMark: window.__perfAtMark ?? null,
    readyDom: window.__perfReadyDom ?? null,
    figuresSettled: typeof window.__perfFigures === "function" ? window.__perfFigures() : [],
    finalUrl: location.href,
    domNodes: document.getElementsByTagName("*").length,
    // React commits since the document started, when the caller installed COMMIT_COUNTER_SCRIPT.
    commits: typeof window.__archerCommitCount === "number" ? window.__archerCommitCount : null,
    debugPage: Boolean(window.__archerTelemetry),
    telemetryWarnings: window.__archerTelemetry ? window.__archerTelemetry.warnings().map((w) => w.code) : undefined,
    resources: [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")].map(
      (e) => ({
        name: e.name,
        entryType: e.entryType,
        initiatorType: e.initiatorType,
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize,
        responseStatus: e.responseStatus,
      }),
    ),
  }));
  const dom = domShape(await page.evaluate(DOM_SHAPE_SCRIPT));
  const heap = await probe.cdp.send("Runtime.getHeapUsage").catch(() => null);
  const gc = await heapAfterGc(probe.cdp, opts.browserCdp);
  const page_ = {
    ttfb: lab.ttfb,
    fcp: lab.fcp,
    lcp: lab.lcp,
    cls: lab.cls,
    longTasks: lab.longTasks,
    domNodes: lab.domNodes,
    heapUsedBytes: heap?.usedSize ?? null,
    heapAfterGcBytes: gc.main,
    workerHeapAfterGcBytes: gc.workers,
    ...(lab.telemetryWarnings ? { telemetryWarnings: countBy(lab.telemetryWarnings) } : {}),
  };
  const requests = probe.snapshot();
  for (const r of requests.filter((x) => x.worker)) {
    const timing = lab.resources.find((e) => e.name === r.url);
    if (timing)
      Object.assign(r, {
        status: r.status ?? (timing.responseStatus || 200),
        transferBytes: timing.transferSize,
        decodedBytes: timing.decodedBodySize,
        fromCache: timing.transferSize === 0 && timing.decodedBodySize > 0,
      });
  }
  const firstLoad = firstLoadBytes(lab.resources);
  const invalidations = [...probe.invalidations];
  const work = workDelta(before, after);
  // Route-ready on the rows' clock (CDP ms): the document request's start plus the page's own time to ready.
  const docRow = requests.find((r) => r.type === "Document");
  const readyMs = lab.ready && docRow ? docRow.startMs + lab.ready.at : null;
  // S6: CLS and every shift after route-ready (with its sources); S5: long animation frames in the window.
  const shifts = lab.shifts ?? [],
    late = lab.ready ? shiftsAfter(shifts, lab.ready.at) : [];
  // The DOM predicate's anchor, on every build: a release without marks is compared with the candidate here.
  const lateDom = lab.readyDom ? shiftsAfter(shifts, lab.readyDom.at) : [];
  // A note's anchor is valid only when its in-view figures were settled then (noteMarkProblems, for the mark and for
  // the DOM predicate alike); an invalid anchor is kept out of the comparisons and named.
  const isNote = opts.readyKind === "note";
  const markProblems =
    isNote && lab.ready
      ? noteMarkProblems(lab.ready.source === "mark" ? lab.atMark : lab.ready, lab.figuresSettled)
      : [];
  const domProblems = isNote && lab.readyDom ? noteMarkProblems(lab.readyDom, lab.figuresSettled) : [];
  // Per anchor: the late shifts' labels (reports) and each element's movement with its geometry (S6 identity, O215);
  // times unrounded, so a shift and the anchor in one frame keep their order.
  // `earlyShiftElements`: the movements before the anchor, so S6 can say when a "new" late movement is one the other
  // build makes too, before its anchor (O228; reported, not scored).
  const early = (at) => shiftElements(shifts.filter((x) => !x.hadRecentInput && x.startTime <= at));
  const anchors = {
    ...(lab.ready && markProblems.length === 0
      ? {
          [lab.ready.source]: {
            at: lab.ready.at,
            domElements: lab.ready.domElements,
            lateShifts: late.map(shiftSignature),
            lateShiftElements: shiftElements(late),
            earlyShiftElements: early(lab.ready.at),
          },
        }
      : {}),
    ...(lab.readyDom && domProblems.length === 0
      ? {
          dom: {
            at: lab.readyDom.at,
            domElements: lab.readyDom.domElements,
            lateShifts: lateDom.map(shiftSignature),
            lateShiftElements: shiftElements(lateDom),
            earlyShiftElements: early(lab.readyDom.at),
          },
        }
      : {}),
  };
  // Each valid anchor on the rows' clock with what was in view then, so the requests are phased at every anchor and
  // two builds compare at the one they share (lib/manifest.mjs anchorPhases, O213).
  const anchorClock = {};
  if (docRow && lab.ready && anchors[lab.ready.source] && lab.ready.source !== "dom")
    anchorClock[lab.ready.source] = { readyMs, inView: lab.ready.inView ?? null };
  if (docRow && anchors.dom) {
    const d = lab.readyDom && domProblems.length === 0 ? lab.readyDom : lab.ready;
    anchorClock.dom = { readyMs: docRow.startMs + d.at, inView: d.inView ?? null };
  }
  const invalidAnchors = [
    ...(markProblems.length ? [`${lab.ready.source}: ${markProblems.join("; ")}`] : []),
    ...(domProblems.length ? [`dom: ${domProblems.join("; ")}`] : []),
  ];
  const loafAll = lab.loaf ? loafSummary(lab.loaf, {}) : null;
  const loaf = loafAll
    ? {
        count: loafAll.count,
        blockingMs: loafAll.blockingMs,
        longestMs: loafAll.longestMs,
        unattributed: loafAll.unattributed.length,
      }
    : null;
  const metrics = {
    ...summariseLoad({ requests, page: page_, wallMs: settled.settledAt - started, invalidations }),
    firstLoad,
    dom,
    ...work,
    commits: lab.commits,
    routeReadyMs: lab.ready ? Math.round(lab.ready.at) : null,
    readySource: lab.ready?.source ?? null,
    readyDomElements: lab.ready?.domElements ?? null,
    readyAnchors: anchors,
    ...(invalidAnchors.length ? { invalidAnchors } : {}),
    shiftsAfterReady: late.length,
    lateShifts: late.slice(0, 5),
    clsShifts: shifts
      .filter((x) => !x.hadRecentInput)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5),
    lcpElement: lab.lcpElement ?? null,
    longFrames: loaf,
  };
  // S7 for a note (claude-01): its route-ready is valid only if the figures in view were drawn when it was taken.
  const readiness = readinessVerdict(
    {
      timedOut: settled.timedOut,
      noApiRequest: settled.noApiRequest,
      ready: opts.readyKind ? lab.ready : { at: 0 },
      finalUrl: lab.finalUrl,
      domNodes: lab.domNodes,
      markProblems,
    },
    opts.expectedPath,
  );
  // The budget row counts what the load requested, scheduled poll ticks apart from duplicates. First-load bytes,
  // the DOM's shape and the heap after GC ride along, report only.
  const budgetRow = pageBudget({
    key: url,
    url,
    requests,
    invalidations,
    extra: { firstLoad, dom, heapAfterGc: { mainMb: metrics.heapAfterGcMb, workerMb: metrics.workerHeapAfterGcMb } },
  });
  return {
    metrics,
    budgetRow,
    requests,
    readyMs,
    inView: lab.ready?.inView ?? null,
    anchorClock,
    readiness,
    debugPage: lab.debugPage,
    finalUrl: lab.finalUrl,
    commits: lab.commits,
    ...(settled.noApiRequest
      ? { note: "the page made no /api/ request within 15 s of load; this row measures the document only" }
      : {}),
    ...(settled.timedOut
      ? {
          note: `did not settle within ${opts.timeout} ms; still open: ${settled.open.join(", ") || "none (new requests kept starting)"}`,
        }
      : {}),
  };
}

const countBy = (list) => list.reduce((acc, item) => ({ ...acc, [item]: (acc[item] ?? 0) + 1 }), {});

/** Optional: a Lighthouse desktop run of the page, with the browser's session cookie. */
function lighthouse(url, cookieHeader, chromePath) {
  const dir = mkdtempSync(join(tmpdir(), "archer-perf-lh-")),
    output = join(dir, "lh.json");
  try {
    const r = spawnSync(
      "npx",
      [
        "--yes",
        "lighthouse@13.5.0",
        url,
        "--preset=desktop",
        "--output=json",
        `--output-path=${output}`,
        "--quiet",
        "--only-categories=performance",
        "--chrome-flags=--headless=new --ignore-certificate-errors --no-sandbox",
        `--extra-headers=${JSON.stringify({ Cookie: cookieHeader })}`,
      ],
      { env: { ...process.env, CHROME_PATH: chromePath }, encoding: "utf8", timeout: 240_000 },
    );
    if (r.status !== 0) return { error: (r.stderr || r.stdout || "lighthouse failed").slice(-400) };
    const lh = JSON.parse(readFileSync(output, "utf8")),
      a = lh.audits;
    return {
      score: Math.round((lh.categories.performance.score ?? 0) * 100),
      fcpMs: Math.round(a["first-contentful-paint"]?.numericValue ?? 0),
      lcpMs: Math.round(a["largest-contentful-paint"]?.numericValue ?? 0),
      tbtMs: Math.round(a["total-blocking-time"]?.numericValue ?? 0),
      cls: a["cumulative-layout-shift"]?.numericValue ?? null,
      totalByteWeight: a["total-byte-weight"]?.numericValue ?? null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Seeded faults (rubric §8: every collector shown failing on a known bad case), injected by the lab into the page
 * it measures, never into the product: `duplicate-read` asks for the connection twice (G2 duplicate, G1
 * over-count); `extra-request` one read no entry names (G1 unmatched); `wrong-target` a read of a view the page
 * does not show (G1 wrong-target); `failed-request` a read that answers 404 (G3). `no-revalidate` is applied to
 * the document's answer in instrument() (G5).
 */
export function seedFaultScript(fault, project) {
  const reads = {
    "duplicate-read": `fetch("/p/${project}/api/connection"); fetch("/p/${project}/api/connection");`,
    "extra-request": `fetch("/p/${project}/api/diagrams?seeded=extra");`,
    "wrong-target": `fetch("/p/${project}/api/emphasis/state-crlf");`,
    "failed-request": `fetch("/p/${project}/api/seeded-missing-route");`,
  };
  if (fault === "fail-sample") return "";
  if (!reads[fault])
    throw new Error(
      `unknown --seed-fault ${fault} (have: ${[...Object.keys(reads), "no-revalidate", "fail-sample"].join(", ")})`,
    );
  return `addEventListener("load", () => setTimeout(() => { ${reads[fault]} }, 50));`;
}

/** Tokens out of anything recorded (§9 Secrets): query `token=` values and grant-like path segments. */
export const redact = (text) =>
  typeof text === "string" ? text.replace(/([?&]token=)[^&#\s"]+/gi, "$1REDACTED") : text;

/** One request row as written to requests.jsonl: what the manifest and reviewers need, tokens redacted. */
export const rowRecord = (r, extra) => ({
  ...extra,
  method: r.method,
  url: redact(r.url),
  type: r.type,
  status: r.status,
  wireStatus: r.wireStatus ?? null,
  ...(r.body ? { body: redact(r.body) } : {}),
  startMs: Math.round(r.startMs * 10) / 10,
  endMs: Math.round(r.endMs * 10) / 10,
  transferBytes: r.transferBytes,
  decodedBytes: r.decodedBytes,
  fromCache: r.fromCache,
  etag: r.etag ?? null,
  cacheControl: r.cacheControl ?? null,
  contentEncoding: r.contentEncoding ?? null,
  protocol: r.protocol ?? null,
  priority: r.priority ?? null,
  initiatorType: r.initiatorType ?? null,
  ...(r.initiatorInfo
    ? {
        initiatorInfo: {
          ...r.initiatorInfo,
          url: redact(r.initiatorInfo.url),
          frameUrl: redact(r.initiatorInfo.frameUrl),
        },
      }
    : {}),
  ...(r.requestId ? { requestId: r.requestId } : {}),
  ...(r.initiator ? { initiator: r.initiator } : {}),
  ...(r.poll ? { poll: r.poll } : {}),
  ...(r.worker ? { worker: true } : {}),
  ...(r.fromWorker ? { fromWorker: true } : {}),
  ...(r.error ? { error: r.error } : {}),
  ...(r.canceled ? { canceled: true } : {}),
});

/** S1 chain depth over runs: the max, each run's depth, the longest chain (patterns) and the method. */
export function chainOverRuns(list) {
  const deepest = list.reduce((b, c) => (b === null || c.depth > b.depth ? c : b), null);
  return {
    depth: deepest.depth,
    perRun: list.map((c) => c.depth),
    varied: new Set(list.map((c) => c.depth)).size > 1,
    chain: deepest.chain.map((u) => redact(u)),
    method: deepest.method,
    gapMs: deepest.gapMs,
  };
}

/** Max over runs of each count (rubric §5: "max of 3 runs; variation is a finding"), and whether the runs varied. */
export function maxOverRuns(checks) {
  if (checks.length === 0) return null;
  const max = (f) => Math.max(...checks.map(f));
  const byPhase = Object.fromEntries(Object.keys(checks[0].byPhase).map((p) => [p, max((c) => c.byPhase[p])]));
  const requests = checks.map((c) => c.requests);
  return {
    pass: checks.every((c) => c.pass),
    draftPass: checks.every((c) => c.draftPass),
    requests: max((c) => c.requests),
    byPhase,
    kinds: max((c) => c.kinds),
    unmatched: max((c) => c.unmatched.length),
    wrongTarget: max((c) => c.wrongTarget.length),
    wrongPhase: max((c) => (c.wrongPhase ?? []).length),
    overCount: max((c) => c.overCount.length),
    proposed: max((c) => c.proposedUsed.length),
    ...(checks.some((c) => c.notEvaluated) ? { notEvaluated: checks.find((c) => c.notEvaluated).notEvaluated } : {}),
    varied: new Set(requests).size > 1 ? requests : false,
    failing: [
      ...new Map(
        checks
          .flatMap((c) => [...c.wrongTarget, ...c.unmatched, ...(c.wrongPhase ?? []), ...c.overCount])
          .map((r) => [
            `${r.verdict} ${r.pattern} ${r.target} ${r.phase}`,
            {
              verdict: r.verdict,
              pattern: r.pattern,
              target: r.target,
              phase: r.phase,
              ...(r.entryPhases ? { entryPhases: r.entryPhases } : {}),
              url: redact(r.url),
            },
          ]),
      ).values(),
    ],
  };
}

/**
 * S2: one coverage sample of a page, a cold and a warm load with V8 block coverage of the page and its workers, and
 * CSS rule usage, under `profile`'s network and CPU emulation. Only scripts parsed by the load being measured are
 * read (a warm load's coverage still lists the cold document's scripts, whose ids are gone: they were the 33
 * "No script for id" errors in round 1 and are now skipped and counted as `previousDocument`). A script, worker or
 * stylesheet that cannot be read is an `{url, error}` entry, which coverageSummary reports NOT EVALUATED.
 */
/** How many times an invalid coverage sample is taken again before its cell is left NOT EVALUATED (claude-303). */
const COVERAGE_RETAKES = 3;

async function coverageLoads(context, url, opts, profile = PROFILES.default) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const out = {};
  try {
    let next = 0;
    const pending = new Map(),
      workers = new Map(),
      parsed = new Set();
    cdp.on("Target.receivedMessageFromTarget", (e) => {
      const m = JSON.parse(e.message);
      const x = m.id ? pending.get(m.id) : null;
      if (x) {
        pending.delete(m.id);
        m.error ? x.reject(new Error(m.error.message)) : x.resolve(m.result);
      }
    });
    const send = (sessionId, method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        cdp
          .send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) })
          .catch(reject);
      });
    // Workers are paused at start until coverage is on, so their first line is counted (§8 S2 "auto-attach before execution").
    cdp.on("Target.attachedToTarget", (e) => {
      if (e.targetInfo.type !== "worker") return;
      workers.set(e.sessionId, {
        url: e.targetInfo.url,
        ready: (async () => {
          await send(e.sessionId, "Profiler.enable");
          await send(e.sessionId, "Debugger.enable");
          await send(e.sessionId, "Profiler.startPreciseCoverage", { callCount: true, detailed: true });
          await send(e.sessionId, "Runtime.runIfWaitingForDebugger");
        })(),
      });
    });
    cdp.on("Debugger.scriptParsed", (e) => parsed.add(e.scriptId));
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
      filter: [{ type: "worker", exclude: false }, { exclude: true }],
    });
    await cdp.send("Network.enable");
    await cdp.send("Network.clearBrowserCache");
    if (profile.network)
      await cdp
        .send("Network.emulateNetworkConditionsByRule", {
          offline: false,
          matchedNetworkConditions: [{ urlPattern: "", ...profile.network }],
        })
        .catch(() => cdp.send("Network.emulateNetworkConditions", { offline: false, ...profile.network }));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu ?? 1 });
    for (const m of ["Profiler.enable", "Debugger.enable", "DOM.enable", "CSS.enable"]) await cdp.send(m);
    for (const state of ["cold", "warm"]) {
      workers.clear();
      parsed.clear();
      const sheets = new Map(),
        onSheet = (e) => sheets.set(e.header.styleSheetId, e.header);
      cdp.on("CSS.styleSheetAdded", onSheet);
      await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
      await cdp.send("CSS.startRuleUsageTracking");
      await page.goto(url, { waitUntil: "load", timeout: opts.timeout });
      if (opts.readyKind)
        await page.waitForFunction(() => Boolean(window.__perfReady), null, { timeout: opts.timeout });
      await page.waitForTimeout(1500);
      // What the page asked its workers to do in this load (O216): kept with the sample, read before coverage stops.
      const workerMessages = workerMessageSummary(
        await page.evaluate(() => window.__perfWorkerMessages ?? null).catch(() => null),
      );
      const js = await cdp.send("Profiler.takePreciseCoverage");
      await cdp.send("Profiler.stopPreciseCoverage");
      const css = await cdp.send("CSS.stopRuleUsageTracking");
      cdp.off("CSS.styleSheetAdded", onSheet);
      const origin = new URL(url).origin,
        scripts = [],
        styles = [],
        workerScripts = [];
      let previousDocument = 0;
      for (const sc of js.result) {
        if (!sc.url.startsWith(origin)) continue;
        if (!parsed.has(sc.scriptId)) {
          previousDocument++;
          continue;
        }
        try {
          const { scriptSource } = await cdp.send("Debugger.getScriptSource", { scriptId: sc.scriptId });
          scripts.push(scriptCoverage(redact(sc.url), scriptSource, sc.functions));
        } catch (error) {
          scripts.push({ url: redact(sc.url), error: String(error.message ?? error) });
        }
      }
      for (const [sessionId, w] of workers) {
        try {
          await w.ready;
          const raw = await send(sessionId, "Profiler.takePreciseCoverage");
          for (const sc of raw.result) {
            if (!sc.url.startsWith(origin)) continue;
            const { scriptSource } = await send(sessionId, "Debugger.getScriptSource", { scriptId: sc.scriptId });
            workerScripts.push(scriptCoverage(redact(sc.url), scriptSource, sc.functions));
          }
          await send(sessionId, "Profiler.stopPreciseCoverage");
        } catch (error) {
          workerScripts.push({ url: redact(w.url), error: String(error.message ?? error) });
        }
      }
      for (const [id, h] of sheets) {
        try {
          const { text } = await cdp.send("CSS.getStyleSheetText", { styleSheetId: id });
          styles.push(
            styleCoverage(
              h.sourceURL || (h.isInline ? "(inline)" : ""),
              text,
              css.ruleUsage.filter((r) => r.styleSheetId === id),
            ),
          );
        } catch (error) {
          styles.push({
            url: redact(h.sourceURL || (h.isInline ? "(inline)" : "")),
            error: String(error.message ?? error),
          });
        }
      }
      out[state] = {
        summary: { ...coverageSummary({ scripts, workers: workerScripts, styles }), previousDocument, workerMessages },
        scripts,
        workers: workerScripts,
        styles: styles.filter((x) => x.error || x.totalBytes > 0),
      };
    }
  } finally {
    await page.close();
  }
  return out;
}

async function main() {
  const opts = options();
  const { chromium } = require("playwright");
  const tls = await tlsSetup({ base: opts.base, tlsCa: opts["tls-ca"], tlsSpki: opts["tls-spki"] });
  const browser = await chromium.launch({ headless: !opts.headed, args: tls.launchArgs });
  // Worker heaps (heapAfterGc) are read through the browser's own session: a page session does not reach them.
  opts.browserCdp = await browser.newBrowserCDPSession().catch(() => null);
  const manifest = opts.manifest ? JSON.parse(readFileSync(opts.manifest, "utf8")) : null;
  const manifestProblems = manifest ? validateManifest(manifest) : [];
  // The link is opened once and its session cookie handed to every later context: the service paces sign-ins to 20
  // a minute per grant (MAX_SESSION_MINTS_PER_MINUTE, C-27), and a full matrix opens more contexts than that, so the
  // later rows were the "open the link Archer gave you" page (a 404, the row incomplete). Each context still starts
  // with an empty HTTP cache, and its cold load clears it again.
  let session = null;
  const newContext = async () => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: tls.ignoreHTTPSErrors,
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript(VITALS_SCRIPT);
    if (!opts["no-commits"]) await context.addInitScript(COMMIT_COUNTER_SCRIPT);
    if (opts.login && session !== null) await context.addCookies(session);
    else if (opts.login) {
      const p = await context.newPage();
      await p.goto(opts.login, { waitUntil: "load", timeout: opts.timeout });
      await p.close();
      session = await context.cookies();
      await awaitBrotliPage(context, p.url());
    }
    return context;
  };
  /**
   * A page that was not packaged with its compressed copies (a sandbox's debug page) is brotli-compressed only once a
   * br-capable reader has asked, in the background (seconds at q11), and is served gzip until then. The sign-in above
   * is that first reader. Every measured row is a later visitor, so wait for the br copy before measuring: otherwise
   * the first cold row measures the service's first-ever page answer, not a cold load (0.15.0: 740 KB gzip against
   * 596 KB br, over the projects/default/cold budget). Before 0.15.0 the sign-in landed on a small token home page and
   * the first measured row happened to start the compression instead.
   */
  async function awaitBrotliPage(context, pageUrl) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const answer = await context.request
        .get(pageUrl, { headers: { "accept-encoding": "br, gzip" } })
        .catch(() => null);
      const coding = answer?.headers()["content-encoding"];
      if (coding === "br" || (answer !== null && coding === undefined)) return; // br ready, or served uncompressed
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.stderr.write("page-load: the page's br copy was not ready within 30 s; the first cold row may be gzip\n");
  }
  const results = [],
    records = [],
    loadRecords = [],
    seedLoads = {};
  let targets,
    networkEmulation = null;
  try {
    const first = await newContext();
    targets = await resolveTargets(first, opts);
    await first.close();
    const fixture = {
      project: targets.project,
      diagram: targets.shown?.diagram,
      flow: targets.shown?.flow,
      note: targets.shown?.note,
    };
    for (const name of opts.pages) {
      const path = targets.paths[name];
      // An alias row exists only where the catalog names a project path: elsewhere it is skipped, not failed.
      if (!path && (name === "diagram-folder-path" || name === "note-alias")) {
        process.stderr.write(`${name}: the catalog names no project path; skipped\n`);
        continue;
      }
      if (!path) {
        results.push({
          page: name,
          profile: "-",
          state: "-",
          error: `no ${name === "note" ? "note" : "diagram"} in this project`,
        });
        continue;
      }
      // The diagram rows draw whatever view the project offers: a sequence canvas has no mark, a graph does.
      const readyKind =
        READY_KIND[name] === "sequence" && targets.shown?.diagramKind !== "sequence"
          ? "graph"
          : (READY_KIND[name] ?? null);
      const pageOpts = { ...opts, readyKind, expectedPath: targets.canonical?.[name] ?? path };
      const shown = shownFor(name, fixture);
      // §1 "cold": the service's caches are warmed by an unmeasured load first (precompression, compile caches), so
      // the first measured run does not pay for a cold service. An unpackaged build makes the page's brotli copy
      // (q11, seconds) only after the first br-capable request and answers gzip until then (http.ts startBrotli).
      // Chromium hides content-encoding from Playwright, so the document's coding is asked in Node (verified
      // against the sandbox CA, the context's cookies), every 500 ms for at most 20 s, until it is br.
      {
        const context = await newContext(),
          page = await context.newPage();
        try {
          // Read-only like the measured loads: what it would write would change the next surface's rows.
          if (!opts["allow-writes"]) await guardReadOnly(await context.newCDPSession(page), []);
          await page.goto(`${opts.base}${path}`, { waitUntil: "load", timeout: opts.timeout });
          if (opts.base.startsWith("https:") && opts["tls-ca"]) {
            const cookie = (await context.cookies(opts.base)).map((c) => `${c.name}=${c.value}`).join("; ");
            for (
              let i = 0;
              i < 40 && (await documentCoding(`${opts.base}${path}`, opts["tls-ca"], cookie)) !== "br";
              i++
            )
              await page.waitForTimeout(500);
          }
          await page.waitForTimeout(1500);
        } catch {
          /* the measured runs report it */
        } finally {
          await context.close();
        }
      }
      for (const profileName of opts.profiles) {
        const cold = [],
          warm = [],
          coldRows = [],
          warmRows = [],
          checks = { cold: [], warm: [] },
          chains = { cold: [], warm: [] },
          caches = [];
        let blocked = [],
          note,
          debugPage = null;
        // One verdict per state per run, a run that threw included, so the cell cannot be emitted complete from the
        // runs that succeeded (codex-03; lib/readiness.mjs runSamples, cellCompleteness).
        const sampled = await runSamples({
          runs: opts.runs,
          redactText: redact,
          attempt: async (run, done) => {
            const context = await newContext(),
              page = await context.newPage();
            try {
              if (pageOpts.readyKind) await page.addInitScript(readyScript(pageOpts.readyKind));
              if (opts["seed-fault"] && opts["seed-fault"] !== "no-revalidate")
                await page.addInitScript(seedFaultScript(opts["seed-fault"], targets.project));
              if (opts["seed-fault"] === "fail-sample" && run === opts.runs - 1)
                throw new Error("seeded fault: this run's navigation failed (fail-sample)");
              const probe = await instrument(
                page,
                PROFILES[profileName],
                !opts["allow-writes"],
                opts.initiators,
                opts["seed-fault"] ?? null,
              );
              networkEmulation = probe.networkEmulation ?? networkEmulation;
              await probe.cdp.send("Network.clearBrowserCache");
              for (const state of ["cold", "warm"]) {
                const m = await measure(page, probe, `${opts.base}${path}`, pageOpts);
                // Requests by phase at each readiness anchor (G4 compares two builds at the anchor they share).
                const atAnchors = anchorPhases({
                  rows: m.requests,
                  shown,
                  anchors: Object.fromEntries(
                    Object.entries(m.anchorClock).map(([k, a]) => [
                      k,
                      { readyMs: a.readyMs, inView: inViewIdentities(a.inView, shown) },
                    ]),
                  ),
                });
                for (const [k, v] of Object.entries(atAnchors))
                  if (m.metrics.readyAnchors[k]) Object.assign(m.metrics.readyAnchors[k], v);
                (state === "cold" ? cold : warm).push(m.metrics);
                (state === "cold" ? coldRows : warmRows).push(m.budgetRow);
                debugPage = m.debugPage;
                for (const r of m.requests)
                  records.push(rowRecord(r, { page: name, profile: profileName, state, run }));
                const inView = inViewIdentities(m.inView, shown),
                  variant = m.debugPage ? "debug" : "production";
                loadRecords.push({
                  page: name,
                  profile: profileName,
                  state,
                  run,
                  variant,
                  readyMs: m.readyMs === null ? null : Math.round(m.readyMs * 10) / 10,
                  inView,
                });
                const check = checkLoad({
                  rows: m.requests,
                  entries: entriesFor(manifest, name, state),
                  shown,
                  readyMs: m.readyMs,
                  inView,
                  variant,
                  allowProposed: opts["allow-proposed"] === true,
                  problems: manifestProblems,
                });
                checks[state].push(check);
                // S1: the load's dependency depth on the critical path (lib/chain.mjs), prefetches by measured phase.
                const prefetched = new Set(check.rows.filter((x) => x.phase === "prefetch").map((x) => x.requestId));
                if (opts.initiators)
                  chains[state].push(
                    chainDepth(m.requests, {
                      readyMs: m.readyMs,
                      isPrefetch: (x) => prefetched.has(x.requestId),
                      asyncStacks: probe.asyncStacks,
                      gapMs: CHAIN_GAP_MS * (PROFILES[profileName].cpu ?? 1),
                    }),
                  );
                ((seedLoads[name] ??= {})[state] ??= []).push({ rows: m.requests, shown, readyMs: m.readyMs, inView });
                if (state === "warm") caches.push(cacheOnWire(m.requests, { tlsMode: tls.mode }));
                note = m.note ?? note;
                done(state, m.readiness);
              }
              blocked = [...new Set([...blocked, ...probe.blocked])];
            } finally {
              await context.close();
            }
          },
        });
        const ready = sampled.verdicts;
        note = sampled.note ?? note;
        for (const [state, runs, rows] of [
          ["cold", cold, coldRows],
          ["warm", warm, warmRows],
        ]) {
          if (runs.length === 0) {
            results.push({ page: name, path, profile: profileName, state, error: note ?? "no run completed" });
            continue;
          }
          // The budget row of the run with the most duplicate requests: a gate wants the worst case, not the median.
          const worst = [...rows].sort((a, b) => b.duplicateRequests - a.duplicateRequests)[0];
          const cell = cellCompleteness({
            verdicts: ready[state],
            required: opts.runs,
            minimum: opts.fixture === "rubric" ? RUBRIC_SAMPLES : 1,
          });
          results.push({
            page: name,
            path,
            profile: profileName,
            state,
            variant: debugPage ? "debug" : "production",
            metrics: medianOf(runs),
            budgetRow: worst,
            perRun: runs.map((m) => ({
              requests: m.requests,
              transferBytes: m.transferBytes,
              lcpMs: m.lcpMs,
              routeReadyMs: m.routeReadyMs,
              taskDurationMs: m.taskDurationMs,
              layoutCount: m.layoutCount,
              recalcStyleCount: m.recalcStyleCount,
              commits: m.commits,
              domNodes: m.domNodes,
              readyDomElements: m.readyDomElements,
              readySource: m.readySource,
              readyAnchors: m.readyAnchors,
            })),
            manifest: {
              ...maxOverRuns(checks[state]),
              ...(manifest ? {} : { note: "no --manifest: counts by guessed phase only" }),
            },
            readiness: { complete: cell.complete, reasons: cell.reasons, samples: cell.samples },
            ...(chains[state].length ? { chain: chainOverRuns(chains[state]) } : {}),
            ...(state === "warm"
              ? {
                  cache: caches.length
                    ? {
                        verdict: caches.every((c) => c.verdict === "PASS")
                          ? "PASS"
                          : caches.some((c) => c.verdict === "NOT EVALUATED")
                            ? "NOT EVALUATED"
                            : "FAIL",
                        problems: [...new Set(caches.flatMap((c) => c.problems))],
                        shell: caches[0].shell,
                        workers: caches[0].workers,
                      }
                    : null,
                }
              : {}),
            ...(blocked.length ? { blockedWrites: blocked } : {}),
            ...(note ? { note } : {}),
          });
        }
        process.stderr.write(`measured ${name} (${profileName})\n`);
      }
      if (opts.chain) {
        // S1: --runs extra cold+warm loads per profile with async stacks (the debugger is on, so they are not timed),
        // each reduced to its dependency depth on the critical path (lib/chain.mjs). Replaces any chain from above.
        for (const profileName of opts.profiles) {
          const chains = { cold: [], warm: [] };
          const sampled = await runSamples({
            runs: opts.runs,
            redactText: redact,
            attempt: async (run, done) => {
              const context = await newContext(),
                page = await context.newPage();
              try {
                if (pageOpts.readyKind) await page.addInitScript(readyScript(pageOpts.readyKind));
                const probe = await instrument(page, PROFILES[profileName], !opts["allow-writes"], true);
                await probe.cdp.send("Network.clearBrowserCache");
                for (const state of ["cold", "warm"]) {
                  const m = await measure(page, probe, `${opts.base}${path}`, pageOpts);
                  const check = checkLoad({
                    rows: m.requests,
                    entries: entriesFor(manifest, name, state),
                    shown,
                    readyMs: m.readyMs,
                    inView: inViewIdentities(m.inView, shown),
                    variant: m.debugPage ? "debug" : "production",
                  });
                  const prefetched = new Set(check.rows.filter((x) => x.phase === "prefetch").map((x) => x.requestId));
                  chains[state].push(
                    chainDepth(m.requests, {
                      readyMs: m.readyMs,
                      isPrefetch: (x) => prefetched.has(x.requestId),
                      asyncStacks: probe.asyncStacks,
                      gapMs: CHAIN_GAP_MS * (PROFILES[profileName].cpu ?? 1),
                    }),
                  );
                  done(state, m.readiness);
                }
              } finally {
                await context.close();
              }
            },
          });
          for (const state of ["cold", "warm"]) {
            const row = results.find((r) => r.page === name && r.state === state && r.profile === profileName);
            const cell = cellCompleteness({
              verdicts: sampled.verdicts[state],
              required: opts.runs,
              minimum: opts.fixture === "rubric" ? RUBRIC_SAMPLES : 1,
            });
            if (row)
              row.chain = {
                ...(chains[state].length ? chainOverRuns(chains[state]) : { depth: null }),
                complete: cell.complete && chains[state].every((c) => c.method.startsWith("initiators + async")),
                reasons: cell.reasons,
              };
          }
          process.stderr.write(`chain ${name} (${profileName})\n`);
        }
      }
      if (opts.coverage) {
        // S2: --runs samples per cell on every profile (§5 max of 3), each in a fresh context; a run or a part of it
        // that fails is NOT EVALUATED, not zero bytes (codex-04).
        for (const profileName of opts.profiles) {
          const samples = { cold: [], warm: [] },
            retakes = { cold: [], warm: [] };
          let detail = null;
          await runSamples({
            runs: opts.runs,
            redactText: redact,
            attempt: async (run, done) => {
              // A sample V8 reported without a worker's top level is invalid (claude-303): the run is taken again, in
              // a fresh context, up to COVERAGE_RETAKES times, and each state keeps its first valid sample. The
              // retake is recorded; an invalid sample is never counted, and one still invalid leaves the cell NOT
              // EVALUATED.
              const got = {};
              for (
                let attemptNo = 0;
                attemptNo <= COVERAGE_RETAKES && !(got.cold && got.warm && !got.cold.invalid && !got.warm.invalid);
                attemptNo++
              ) {
                const context = await newContext();
                try {
                  if (pageOpts.readyKind) await context.addInitScript(readyScript(pageOpts.readyKind));
                  await context.addInitScript(WORKER_MESSAGES_SCRIPT);
                  const cov = await coverageLoads(context, `${opts.base}${path}`, pageOpts, PROFILES[profileName]);
                  for (const state of ["cold", "warm"]) {
                    if (got[state] && !got[state].invalid) continue;
                    if (got[state]?.invalid)
                      retakes[state].push({ run, state, try: attemptNo, reasons: got[state].invalid });
                    got[state] = cov[state].summary;
                    if (!cov[state].summary.invalid) detail ??= cov;
                  }
                } catch (error) {
                  for (const state of ["cold", "warm"])
                    if (samples[state].length <= run)
                      samples[state].push({ error: redact(String(error?.message ?? error).split("\n")[0]) });
                  throw error;
                } finally {
                  await context.close();
                }
              }
              for (const state of ["cold", "warm"]) {
                samples[state].push(got[state]);
                done(state, { complete: true, reasons: [] });
              }
            },
          });
          for (const state of ["cold", "warm"]) {
            const row = results.find((r) => r.page === name && r.state === state && r.profile === profileName);
            const cell = coverageCell(samples[state], {
              required: opts.runs,
              minimum: opts.fixture === "rubric" ? RUBRIC_SAMPLES : 1,
              retakes: retakes[state],
            });
            if (row)
              row.coverage = {
                ...cell,
                ...(detail
                  ? { scripts: detail[state].scripts, workers: detail[state].workers, styles: detail[state].styles }
                  : {}),
              };
          }
          process.stderr.write(`coverage ${name} (${profileName})\n`);
        }
      }
    }
    if (opts.lighthouse) {
      const context = await newContext();
      const cookies = (await context.cookies(opts.base)).map((c) => `${c.name}=${c.value}`).join("; ");
      await context.close();
      for (const name of opts.pages) {
        const path = targets.paths[name];
        if (!path) continue;
        const row =
          results.find((r) => r.page === name && r.profile === "default" && r.state === "cold") ??
          results.find((r) => r.page === name);
        if (row) row.lighthouse = lighthouse(`${opts.base}${path}`, cookies, chromium.executablePath());
      }
    }
  } finally {
    await browser.close();
  }

  const environment = {
    node: process.version,
    platform: process.platform,
    browser: browser.version?.() ?? null,
    playwright: require("playwright/package.json").version,
    tlsMode: tls.mode,
    networkEmulation,
    commitCounter: !opts["no-commits"],
  };
  const report = {
    generatedAt: new Date().toISOString(),
    base: opts.base,
    project: targets?.project,
    diagram: targets?.diagram,
    shown: targets?.shown,
    runs: opts.runs,
    profiles: Object.fromEntries(opts.profiles.map((p) => [p, PROFILES[p]])),
    environment,
    ...(manifest
      ? {
          manifest: { file: opts.manifest, problems: manifestProblems, allowProposed: opts["allow-proposed"] === true },
        }
      : {}),
    knownBaseline: KNOWN_BASELINE,
    results,
  };
  const failures = opts.budget ? overBudget(report, JSON.parse(readFileSync(opts.budget, "utf8"))) : [];
  const manifestFailures = manifest
    ? results.filter((r) => r.manifest && !(opts["allow-proposed"] ? r.manifest.draftPass : r.manifest.pass))
    : [];
  const out = resolve(opts.out ?? join(HERE, "out", report.generatedAt.replace(/[:.]/g, "-")));
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "perf-report.json"),
    JSON.stringify({ ...report, ...(opts.budget ? { budget: opts.budget, overBudget: failures } : {}) }, null, 2) +
      "\n",
  );
  writeFileSync(join(out, "perf-report.md"), markdown(report, failures) + manifestMarkdown(report));
  writeFileSync(join(out, "requests.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Per load: route-ready on the rows' clock and the in-view identities, so manifest-tool.mjs can re-check offline.
  writeFileSync(join(out, "loads.jsonl"), loadRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // A cell is incomplete when a sample is missing or invalid, or (with --coverage) its coverage is NOT EVALUATED.
  const incomplete = results.filter(
    (r) =>
      r.error ||
      (r.readiness && !r.readiness.complete) ||
      (opts.coverage && r.metrics && !r.coverage?.complete) ||
      (opts.chain && r.metrics && !r.chain?.complete),
  );
  writeFileSync(
    join(out, "summary.json"),
    JSON.stringify(
      {
        ok: failures.length === 0 && manifestFailures.length === 0 && incomplete.length === 0,
        complete: incomplete.length === 0,
        incomplete: incomplete.map((r) => `${r.page}/${r.profile}/${r.state}`),
        report: join(out, "perf-report.json"),
        budget: labBudget(report, failures),
      },
      null,
      2,
    ) + "\n",
  );
  if (opts["write-budget"]) {
    const refused = writeBudgetFile(report, opts["write-budget"], {
      note: `Seeded from a run against ${opts.base}; caps carry head-room for noise. ${KNOWN_BASELINE}`,
      acceptDrop: opts["accept-drop"] === true,
    });
    if (refused) {
      process.stderr.write(
        `budget NOT written to ${opts["write-budget"]}; rows that look broken:\n${refused.map((r) => `  ${r.key}: ${r.reason}`).join("\n")}\n`,
      );
      process.exitCode = 1;
    }
  }
  if (opts["write-manifest"]) {
    const surfaces = Object.fromEntries(
      Object.entries(seedLoads).map(([page, states]) => [
        page,
        Object.fromEntries(Object.entries(states).map(([state, loads]) => [state, seedEntries(loads)])),
      ]),
    );
    writeFileSync(
      opts["write-manifest"],
      JSON.stringify(
        {
          schema: MANIFEST_SCHEMA,
          $comment: `Written by page-load.mjs --write-manifest against ${opts.base} on ${report.generatedAt}. Every reason is empty on purpose: the file fails validation until a reviewer gives each entry its reason or PERF-EX id (rubric §6).`,
          exceptions: [],
          surfaces,
        },
        null,
        2,
      ) + "\n",
    );
  }
  process.stdout.write(`${join(out, "perf-report.md")}\n`);
  if (manifestFailures.length)
    process.stderr.write(
      `manifest:\n${manifestFailures.map((r) => `  ${r.page}/${r.profile}/${r.state}: ${r.manifest.unmatched} unmatched, ${r.manifest.wrongTarget} wrong-target, ${r.manifest.wrongPhase} wrong-phase, ${r.manifest.overCount} over-count, ${r.manifest.proposed} proposed${r.manifest.notEvaluated ? `, NOT EVALUATED (${r.manifest.notEvaluated})` : ""}`).join("\n")}\n`,
    );
  if (failures.length)
    process.stderr.write(
      `over budget:\n${failures.map((f) => `  ${f.key} ${f.field} ${f.value} > ${f.cap}`).join("\n")}\n`,
    );
  if (incomplete.length)
    process.stderr.write(
      `incomplete cells (NOT EVALUATED):\n${incomplete.map((r) => `  ${r.page}/${r.profile}/${r.state}: ${r.error ?? [...r.readiness.reasons, ...(opts.coverage && !r.coverage?.complete ? [`coverage NOT EVALUATED: ${(r.coverage?.reasons ?? ["not collected"]).slice(0, 3).join("; ")}`] : [])].join("; ")}`).join("\n")}\n`,
    );
  // A rubric collection (--fixture rubric) or --require-complete cannot exit 0 with a cell short of its samples.
  const requireComplete = opts.fixture === "rubric" || opts["require-complete"] === true;
  if (failures.length || manifestFailures.length || (requireComplete && incomplete.length)) process.exit(1);
}

/**
 * --write-budget: seeds caps from `report` into `file`, all or nothing (a file with a row left out would silently
 * stop gating that page). Returns null when written, else the refused rows; the file is then left as it was.
 */
export function writeBudgetFile(report, file, { note, acceptDrop = false }) {
  let previous;
  try {
    previous = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    previous = undefined;
  }
  const seeded = seedBudgets(report, note, { previous, acceptDrop });
  if (seeded.refused) return seeded.refused;
  writeFileSync(file, JSON.stringify(seeded, null, 2) + "\n");
  return null;
}

/** The manifest, readiness and cache sections of perf-report.md (G1, S7, G5). */
export function manifestMarkdown(report) {
  const rows = report.results.filter((r) => r.manifest);
  if (rows.length === 0) return "";
  const lines = [
    "",
    "## Request manifest, readiness and cache (rubric G1, S7, G5)",
    "",
    "Counts are the max over runs (§5). Phases: document / boot / data / stream / prefetch / idle.",
    "",
    "| page | profile | load | variant | requests | by phase | kinds | unmatched | wrong-target | wrong-phase | over | proposed | G1 | ready ms | complete | cache |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const m = r.manifest,
      phases = Object.values(m.byPhase ?? {}).join("/");
    lines.push(
      `| ${r.page} | ${r.profile} | ${r.state} | ${r.variant} | ${m.requests}${m.varied ? ` (runs ${m.varied.join(",")})` : ""} | ${phases} | ${m.kinds} | ${m.unmatched} | ${m.wrongTarget} | ${m.wrongPhase ?? 0} | ${m.overCount} | ${m.proposed} | ${report.manifest ? (m.notEvaluated ? "NOT EVALUATED" : m.pass ? "PASS" : m.draftPass ? "pending approval" : "FAIL") : "—"} | ${r.metrics?.routeReadyMs ?? "—"} | ${r.readiness?.complete ? "yes" : `NO: ${r.readiness?.reasons.join("; ")}`} | ${r.cache?.verdict ?? ""} |`,
    );
  }
  const failing = rows.filter((r) => r.manifest.failing?.length);
  if (failing.length) {
    lines.push("", "### Requests without an entry", "");
    for (const r of failing)
      for (const f of r.manifest.failing)
        lines.push(
          `- ${r.page}/${r.profile}/${r.state}: ${f.verdict} \`${f.pattern}\` target ${f.target} phase ${f.phase}${f.entryPhases ? ` (entries: ${f.entryPhases.join(", ")})` : ""}`,
        );
  }
  const cacheProblems = rows.filter((r) => r.cache?.problems?.length);
  if (cacheProblems.length) {
    lines.push("", "### Cache on the wire (warm)", "");
    for (const r of cacheProblems) for (const p of r.cache.problems) lines.push(`- ${r.page}/${r.profile}: ${p}`);
  }
  return lines.join("\n") + "\n";
}

/** summary.json's `budget` (archer-budget/1): one page row per page/profile/load, keyed like budgets.json. */
export function labBudget(report, failures = []) {
  const ok = report.results.filter((r) => r.metrics && r.budgetRow);
  const pages = ok.map((r) => ({
    ...r.budgetRow,
    key: `${r.page}/${r.profile}/${r.state}`,
    url: r.path,
    // The lab's own fields, for gates that already use budgets.json names.
    wallMs: r.metrics.wallMs,
    lcpMs: r.metrics.lcpMs,
    longTaskMs: r.metrics.longTaskMs,
    decodedBytes: r.metrics.decodedBytes,
    ...(r.metrics.telemetryWarnings ? { warnings: r.metrics.telemetryWarnings } : {}),
  }));
  const warnings = {};
  for (const p of pages)
    for (const [code, n] of Object.entries(p.warnings ?? {})) warnings[code] = (warnings[code] ?? 0) + n;
  const errors = report.results
    .filter((r) => r.error)
    .map((r) => ({ key: `${r.page}/${r.profile}/${r.state}`, error: r.error }));
  return {
    ...budgetResults({
      source: "page-load",
      name: report.project ?? "page-load",
      generatedAt: report.generatedAt,
      pages,
      warnings,
      overBudget: failures,
    }),
    ...(errors.length ? { errors } : {}),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(2);
  });
}
