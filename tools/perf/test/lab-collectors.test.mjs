// Pure halves of the lab's rubric collectors: readiness (S7), cache on the wire (G5), TLS mode (G5), coverage (S2),
// main-thread deltas (S3), redaction (§9), seeded faults (§8). Each with a passing and a failing case.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readinessVerdict,
  routeMatches,
  readyScript,
  READY_KIND,
  cellCompleteness,
  runSamples,
  RUBRIC_SAMPLES,
} from "../lib/readiness.mjs";
import { cacheOnWire, bodyOnWire } from "../lib/cache.mjs";
import { tlsSetup } from "../lib/tls.mjs";
import { usedRanges, unionBytes, scriptCoverage, coverageSummary, coverageCell, runRange } from "../lib/coverage.mjs";
import { workDelta, redact, maxOverRuns, seedFaultScript, PAGES } from "../page-load.mjs";

const O = "https://127.0.0.1:4000";

test("readiness: a complete row passes; timeout, no ready, wrong route and empty page fail", () => {
  const ok = {
    ready: { at: 300, source: "dom" },
    finalUrl: `${O}/projects/awkward/diagrams/x.mmd?edit&draftId=drf_1`,
    domNodes: 400,
  };
  assert.deepEqual(readinessVerdict(ok, "/projects/awkward/diagrams/x.mmd?edit"), { complete: true, reasons: [] });
  const bad = readinessVerdict(
    { timedOut: true, ready: null, finalUrl: `${O}/projects/`, domNodes: 12 },
    "/projects/awkward/notes/auth.md",
  );
  assert.equal(bad.complete, false);
  assert.equal(bad.reasons.length, 4);
  assert.equal(routeMatches("/projects/awkward/?tab=notes", `${O}/projects/awkward/?tab=diagrams`), false);
});

test("readiness: every measured page has a rule, and the script names it", () => {
  for (const p of PAGES) assert.ok(READY_KIND[p], p);
  assert.match(readyScript("graph"), /archer:interactive/);
  for (const kind of ["sequence", "rows", "cards", "notes-table", "note"])
    assert.match(readyScript(kind), /archer:route-ready/);
});

// Runs the watcher in a stub page: `frames` is one state per animation frame (rows shown, marks taken so far).
function watch(kind, { scriptText, frames, elements = {} }) {
  const window = {},
    marks = [],
    queue = [];
  let frame = 0,
    rows = 0;
  const env = {
    window,
    innerHeight: 900,
    innerWidth: 1440,
    performance: { now: () => frame * 16, getEntriesByName: (n) => marks.filter((m) => m.name === n) },
    requestAnimationFrame: (f) => queue.push(f),
    document: {
      readyState: "complete",
      scripts: [{ src: "", text: scriptText }],
      getElementsByTagName: () => [],
      querySelectorAll: (sel) => (sel === "main [role=row]" ? Array(rows).fill({}) : (elements[sel] ?? [])),
      querySelector: () => null,
    },
  };
  new Function(...Object.keys(env), readyScript(kind))(...Object.values(env));
  for (const f of frames) {
    frame += 1;
    rows = f.rows;
    for (const m of f.marks ?? []) marks.push({ ...m, startTime: frame * 16 });
    const run = queue.splice(0);
    for (const g of run) g();
    if (window.__perfReady) return window.__perfReady;
  }
  return window.__perfReady ?? null;
}

test("readiness: a build with the marks is timed by its mark, not by rows that show first; one without falls back", () => {
  const frames = [
    { rows: 3 },
    { rows: 3 },
    { rows: 3, marks: [{ name: "archer:route-ready", detail: { kind: "list" } }] },
  ];
  const marked = watch("rows", { scriptText: 'performance.mark("archer:route-ready")', frames });
  assert.equal(marked.source, "mark");
  assert.equal(marked.at, 48);
  const old = watch("rows", { scriptText: "an earlier release", frames });
  assert.equal(old.source, "dom");
  assert.equal(old.at, 16);
});

test("G5 PASS: warm shell 304, worker from cache, only no-store API bodies", () => {
  const rows = [
    { type: "Document", url: `${O}/projects/`, status: 200, wireStatus: 304, decodedBytes: 2e6, transferBytes: 680 },
    {
      type: "Script",
      worker: true,
      url: `${O}/-/page-assets/elk-layout-worker-AbCdEf12.js`,
      transferBytes: 0,
      decodedBytes: 1.5e6,
      fromCache: true,
    },
    {
      type: "Fetch",
      method: "GET",
      url: `${O}/api/connection`,
      decodedBytes: 300,
      transferBytes: 800,
      cacheControl: "no-store",
    },
    { type: "Image", method: "GET", url: `${O}/p/a/api/thumbnails/x`, fromCache: true, decodedBytes: 2e4 },
  ];
  assert.equal(cacheOnWire(rows, { tlsMode: "spki-scoped" }).verdict, "PASS");
});

test("G5 FAIL: a re-downloaded shell, a worker body and a cacheable API body each fail; ignored TLS is NOT EVALUATED", () => {
  const rows = [
    { type: "Document", url: `${O}/projects/`, status: 200, wireStatus: 200, decodedBytes: 2e6, transferBytes: 580000 },
    {
      type: "Script",
      worker: true,
      url: `${O}/-/page-assets/elk-layout-worker-AbCdEf12.js`,
      transferBytes: 355000,
      decodedBytes: 1.5e6,
    },
    {
      type: "Fetch",
      method: "GET",
      url: `${O}/api/catalog`,
      decodedBytes: 300,
      transferBytes: 800,
      cacheControl: "private, max-age=60",
    },
  ];
  const c = cacheOnWire(rows, { tlsMode: "spki-scoped" });
  assert.equal(c.verdict, "FAIL");
  assert.equal(c.problems.length, 3);
  assert.equal(cacheOnWire(rows, { tlsMode: "ignore-https-errors" }).verdict, "NOT EVALUATED");
  assert.equal(bodyOnWire({ type: "EventSource", url: `${O}/p/a/api/events`, transferBytes: 10 }), false);
});

test("TLS: plain HTTP needs nothing; HTTPS without a CA or pin falls back to the cache-distorting mode, named", async () => {
  assert.equal((await tlsSetup({ base: "http://127.0.0.1:1" })).mode, "http");
  assert.equal((await tlsSetup({ base: "https://127.0.0.1:1" })).mode, "ignore-https-errors");
  const pinned = await tlsSetup({ base: "https://127.0.0.1:1", tlsSpki: "abc=" });
  assert.deepEqual(
    [pinned.mode, pinned.ignoreHTTPSErrors, pinned.launchArgs[0]],
    ["spki-scoped", false, "--ignore-certificate-errors-spki-list=abc="],
  );
});

test("coverage: the innermost block decides; nested ranges are not counted twice", () => {
  const source = "a".repeat(100);
  // The function ran (0–100) but an inner block 40–60 did not.
  const fns = [
    {
      ranges: [
        { startOffset: 0, endOffset: 100, count: 1 },
        { startOffset: 40, endOffset: 60, count: 0 },
      ],
    },
  ];
  assert.deepEqual(usedRanges(fns), [
    [0, 40],
    [60, 100],
  ]);
  assert.equal(
    unionBytes(source, [
      [0, 50],
      [40, 60],
    ]),
    60,
  );
  const s = scriptCoverage("x.js", source, fns);
  assert.deepEqual([s.usedBytes, s.unusedBytes, s.largestUnused.bytes], [80, 20, 20]);
  assert.equal(coverageSummary({ scripts: [s] }).mainJs.unusedShare, 0.2);
});

test("S3: deltas within a document; a value that went down means a new document", () => {
  assert.equal(
    workDelta({ TaskDuration: 0.1, LayoutCount: 2 }, { TaskDuration: 0.4, LayoutCount: 12 }).layoutCount,
    10,
  );
  const warm = workDelta({ TaskDuration: 0.4, LayoutCount: 12 }, { TaskDuration: 0.25, LayoutCount: 9 });
  assert.deepEqual([warm.taskDurationMs, warm.layoutCount], [250, 9]);
});

test("redaction strips tokens from URLs and bodies", () => {
  assert.equal(redact(`${O}/projects/?token=0123456789abcdef&x=1`), `${O}/projects/?token=REDACTED&x=1`);
});

test("max over runs flags variation (rubric §5: variation is a finding)", () => {
  const c = (n) => ({
    pass: true,
    draftPass: true,
    requests: n,
    byPhase: { data: n },
    kinds: 3,
    unmatched: [],
    wrongTarget: [],
    overCount: [],
    proposedUsed: [],
  });
  assert.equal(maxOverRuns([c(3), c(3)]).varied, false);
  assert.deepEqual(maxOverRuns([c(3), c(4)]).varied, [3, 4]);
});

test("seeded faults are known and unknown ones refuse", () => {
  assert.match(seedFaultScript("wrong-target", "awkward"), /emphasis\/state-crlf/);
  assert.throws(() => seedFaultScript("nope", "awkward"), /unknown --seed-fault/);
});

test("--write-budget writes caps from a report, and refuses a broken row leaving the file as it was", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { writeBudgetFile } = await import("../page-load.mjs");
  const dir = mkdtempSync(join(tmpdir(), "perf-wb-")),
    file = join(dir, "b.json");
  const metrics = {
    transferBytes: 1e6,
    decodedBytes: 2e6,
    requests: 20,
    duplicateRequests: 0,
    lcpMs: 300,
    wallMs: 2000,
    longTaskMs: 100,
    domNodes: 400,
    cachedRequests: 0,
    failedRequests: 0,
  };
  const report = {
    generatedAt: "t",
    base: "http://x",
    results: [{ page: "projects", profile: "default", state: "cold", metrics }],
  };
  assert.equal(writeBudgetFile(report, file, { note: "n" }), null);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).budgets["projects/default/cold"]);
  writeFileSync(file, '{"keep":1}\n');
  const refused = writeBudgetFile(
    { ...report, results: [{ ...report.results[0], metrics: { ...metrics, domNodes: 3 } }] },
    file,
    { note: "n" },
  );
  assert.ok(refused?.length);
  assert.equal(readFileSync(file, "utf8"), '{"keep":1}\n');
});

// A stub element at vertical position `top` (height 200), for the in-view snapshot.
const el = (top, attrs = {}) => ({
  getBoundingClientRect: () => ({ top, bottom: top + 200, left: 100, right: 700, width: 600, height: 200 }),
  getAttribute: (k) => attrs[k] ?? null,
  ...attrs,
});

test("readiness: the snapshot at route-ready names the note figures and thumbnails in the viewport, not those below", () => {
  const frames = [{ rows: 0, marks: [{ name: "archer:route-ready", detail: { kind: "list" } }] }];
  const elements = {
    "figure.archer-note-figure": [
      el(300, { "aria-label": "login-flow, flowchart" }),
      el(818, { "aria-label": "refresh, sequence" }),
      el(1200, { "aria-label": "tokens, flowchart" }),
    ],
    img: [
      el(200, { src: `${O}/p/awkward/api/thumbnails/a?rev=1` }),
      el(1500, { src: `${O}/p/awkward/api/thumbnails/b?rev=1` }),
      el(100, { src: `${O}/logo.png` }),
    ],
  };
  const ready = watch("rows", { scriptText: "archer:route-ready", frames, elements });
  assert.deepEqual(ready.inView, {
    figures: ["login-flow", "refresh"],
    thumbnails: [`${O}/p/awkward/api/thumbnails/a?rev=1`],
  });
});

// codex-03: a run that throws must leave a failed sample, and fewer than the design's 3 cannot be complete.
const okVerdict = { complete: true, reasons: [] };
const sample =
  (failOn = new Set(), afterCold = false) =>
  async (run, done) => {
    if (failOn.has(run) && !afterCold) throw new Error(`navigation ${run} failed ?token=secret`);
    done("cold", okVerdict);
    if (failOn.has(run)) throw new Error(`warm ${run} failed`);
    done("warm", okVerdict);
  };

test("samples: 3 complete runs make a complete cell (known pass)", async () => {
  const { verdicts } = await runSamples({ runs: 3, attempt: sample() });
  for (const state of ["cold", "warm"]) {
    const c = cellCompleteness({ verdicts: verdicts[state], required: 3, minimum: RUBRIC_SAMPLES });
    assert.equal(c.complete, true);
    assert.deepEqual(c.samples, { required: 3, valid: 3, attempted: 3, minimum: 3 });
  }
});

test("samples: a run that throws leaves the cell incomplete in both states, never 2-of-3 complete (known fail)", async () => {
  const redactText = (t) => t.replace(/token=[^&\s]+/, "token=REDACTED");
  const { verdicts, note } = await runSamples({ runs: 3, attempt: sample(new Set([1])), redactText });
  assert.match(note, /token=REDACTED/);
  for (const state of ["cold", "warm"]) {
    assert.equal(verdicts[state].length, 3);
    const c = cellCompleteness({ verdicts: verdicts[state], required: 3, minimum: 3 });
    assert.equal(c.complete, false);
    assert.equal(c.samples.valid, 2);
    assert.match(c.reasons.join("; "), /run 1 failed/);
  }
  // A throw after the cold load: cold keeps its sample, warm gets the failure.
  const half = await runSamples({ runs: 3, attempt: sample(new Set([2]), true) });
  assert.equal(cellCompleteness({ verdicts: half.verdicts.cold, required: 3, minimum: 3 }).complete, true);
  assert.equal(cellCompleteness({ verdicts: half.verdicts.warm, required: 3, minimum: 3 }).complete, false);
});

test("samples: a 1-run collection cannot be complete under the rubric's 3-sample design; ad hoc it can", () => {
  assert.equal(cellCompleteness({ verdicts: [okVerdict], required: 1, minimum: 3 }).complete, false);
  assert.match(cellCompleteness({ verdicts: [okVerdict], required: 1, minimum: 3 }).reasons[0], /needs 3 per cell/);
  assert.equal(cellCompleteness({ verdicts: [okVerdict], required: 1 }).complete, true);
  assert.equal(cellCompleteness({ verdicts: [okVerdict, okVerdict], required: 3, minimum: 3 }).complete, false);
});

// codex-04: coverage errors were reduced to zero bytes, and one sample stood for the 3-sample design.
test("coverage: an unreadable script, worker or sheet is NOT EVALUATED, never zero unused bytes", () => {
  const good = scriptCoverage("a.js", "abcdefghij", [
    {
      ranges: [
        { startOffset: 0, endOffset: 10, count: 1 },
        { startOffset: 5, endOffset: 10, count: 0 },
      ],
    },
  ]);
  const ok = coverageSummary({ scripts: [good], styles: [{ url: "x.css", totalBytes: 100, unusedBytes: 40 }] });
  assert.equal(ok.complete, true);
  const bad = coverageSummary({
    scripts: [good, { url: "http://x/", error: "Debugger.getScriptSource: No script for id" }],
    workers: [{ url: "w.js", error: "Target closed" }],
  });
  assert.equal(bad.complete, false);
  assert.equal(bad.mainJs.unusedBytes, 5);
  assert.match(bad.mainJs.notEvaluated[0], /No script for id/);
  assert.equal(bad.reasons.length, 2);
});

test("coverage cell: max of 3 complete samples; a failed or incomplete sample, or fewer than 3, is NOT EVALUATED", () => {
  const s = (mainUnused, cssUnused) => ({
    complete: true,
    mainJs: { totalBytes: 1000, unusedBytes: mainUnused },
    workerJs: { totalBytes: 0, unusedBytes: 0 },
    css: { totalBytes: 500, unusedBytes: cssUnused },
  });
  const cell = coverageCell([s(700, 300), s(720, 290), s(710, 310)], { required: 3, minimum: 3 });
  assert.equal(cell.verdict, "complete");
  assert.deepEqual([cell.summary.mainJs.unusedBytes, cell.summary.css.unusedBytes], [720, 310]);
  const failed = coverageCell([s(700, 300), { error: "page.waitForFunction: Timeout" }, s(710, 310)], {
    required: 3,
    minimum: 3,
  });
  assert.equal(failed.verdict, "NOT EVALUATED");
  assert.match(failed.reasons[0], /run 1: page.waitForFunction/);
  assert.equal(
    coverageCell([s(700, 300), { ...s(1, 1), complete: false, reasons: ["css x.css: gone"] }, s(710, 310)], {
      required: 3,
      minimum: 3,
    }).complete,
    false,
  );
  assert.equal(coverageCell([s(700, 300)], { required: 1, minimum: 3 }).complete, false);
  assert.equal(coverageCell([s(700, 300), s(700, 300)], { required: 3, minimum: 3 }).complete, false);
});

// claude-01: the note's mark came before any figure in view was drawn (5 figures waiting, 0 SVG at the mark).
test("note mark: rejected when an in-view figure is waiting or drawing at the mark, or absent then and in view later", async () => {
  const { noteMarkProblems } = await import("../lib/readiness.mjs");
  const at = (states) => ({ figures: states.map(([name, state, inView]) => ({ name, state, inView })) });
  const early = noteMarkProblems(
    at([
      ["login-flow", "waiting", true],
      ["refresh", "drawing", true],
      ["tokens", "waiting", false],
    ]),
    [],
  );
  assert.equal(early.length, 1);
  assert.match(early[0], /login-flow waiting, refresh drawing/);
  // Drawn, or an explicit completed failure, in view: valid. Below the fold waiting: fine.
  assert.deepEqual(
    noteMarkProblems(
      at([
        ["login-flow", "drawn", true],
        ["broken", "failing", true],
        ["tokens", "waiting", false],
      ]),
      [],
    ),
    [],
  );
  // No figures committed at the mark, three in view once settled: the mark was before the figures existed.
  assert.match(
    noteMarkProblems(at([]), [
      { name: "login-flow", inView: true },
      { name: "tokens", inView: false },
    ])[0],
    /before its in-view figures existed \(login-flow\)/,
  );
  assert.match(noteMarkProblems(null)[0], /no snapshot/);
  // The row is then incomplete (its S7 and DOM-at-ready values are not valid).
  const v = readinessVerdict(
    {
      ready: { at: 300, source: "mark" },
      finalUrl: `${O}/projects/awkward/notes/auth.md`,
      domNodes: 300,
      markProblems: early,
    },
    "/projects/awkward/notes/auth.md",
  );
  assert.equal(v.complete, false);
});

test("readiness: the snapshot is taken inside the page's own performance.mark call, and the DOM anchor is kept on a build with marks", () => {
  const window = {},
    marks = [],
    queue = [];
  let frame = 0,
    figureState = "waiting";
  const fig = {
    getBoundingClientRect: () => ({ top: 300, bottom: 500, left: 100, right: 700, width: 600, height: 200 }),
    getAttribute: (k) => (k === "aria-label" ? "login-flow, flowchart" : k === "data-state" ? figureState : null),
    querySelector: () => null,
    querySelectorAll: () => (figureState === "drawn" ? [{}] : []),
  };
  const host = {
    getBoundingClientRect: fig.getBoundingClientRect,
    querySelector: (sel) => (sel === "figure.archer-note-figure" ? fig : null),
  };
  const article = {
    textContent: "Body",
    hidden: false,
    closest: () => null,
    querySelectorAll: (sel) => (sel === ".archer-note-figure-host" ? [host] : sel === "pre > code" ? [] : [fig]),
  };
  const performance = {
    now: () => frame * 16,
    getEntriesByName: (n) => marks.filter((m) => m.name === n),
    mark(name, options) {
      const m = { name, detail: options?.detail, startTime: frame * 16 };
      marks.push(m);
      return m;
    },
  };
  const env = {
    window,
    innerHeight: 900,
    innerWidth: 1440,
    performance,
    requestAnimationFrame: (f) => queue.push(f),
    document: {
      readyState: "complete",
      scripts: [{ src: "", text: "archer:route-ready" }],
      getElementsByTagName: () => Array(234),
      querySelectorAll: (sel) => (sel === "figure.archer-note-figure" ? [fig] : []),
      querySelector: (sel) => (sel === "main article.primary-note-reader .archer-note-body" ? article : null),
    },
  };
  new Function(...Object.keys(env), readyScript("note"))(...Object.values(env));
  const step = () => {
    frame += 1;
    for (const g of queue.splice(0)) g();
  };
  step();
  // The product marks while the figure still waits, then draws it a frame later.
  performance.mark("archer:route-ready", { detail: { kind: "note" } });
  figureState = "drawn";
  step();
  step();
  assert.equal(window.__perfReady.source, "mark");
  assert.deepEqual(window.__perfAtMark.figures, [
    { name: "login-flow", state: "waiting", inView: true, drawing: false },
  ]);
  assert.equal(window.__perfReady.domElements, 234);
  assert.ok(window.__perfReadyDom, "the DOM predicate's anchor is recorded on a build with marks");
  assert.equal(
    window.__perfReadyDom.figures[0].state,
    "drawn",
    "the DOM anchor waits for the figure in view to settle",
  );
});

test("readiness: the note DOM predicate does not fire on an empty figure host or a mermaid fence still shown", () => {
  const run = ({ hostFigure, fence }) => {
    const window = {},
      queue = [];
    let frame = 0;
    const rect = () => ({ top: 300, bottom: 500, left: 100, right: 700, width: 600, height: 200 });
    const host = { getBoundingClientRect: rect, querySelector: () => hostFigure };
    const pre = { hidden: false, getBoundingClientRect: rect };
    const code = { className: "language-mermaid", parentElement: pre };
    const article = {
      textContent: "Body",
      hidden: false,
      closest: () => null,
      querySelectorAll: (sel) =>
        sel === ".archer-note-figure-host" ? [host] : sel === "pre > code" ? (fence ? [code] : []) : [],
    };
    const performance = { now: () => frame * 16, getEntriesByName: () => [], mark: () => ({}) };
    const env = {
      window,
      innerHeight: 900,
      innerWidth: 1440,
      performance,
      requestAnimationFrame: (f) => queue.push(f),
      document: {
        readyState: "complete",
        scripts: [],
        getElementsByTagName: () => Array(10),
        querySelectorAll: () => [],
        querySelector: (sel) => (sel === "main article.primary-note-reader .archer-note-body" ? article : null),
      },
    };
    new Function(...Object.keys(env), readyScript("note"))(...Object.values(env));
    for (let i = 0; i < 3; i += 1) {
      frame += 1;
      for (const g of queue.splice(0)) g();
    }
    return window.__perfReadyDom;
  };
  const drawn = { getAttribute: (k) => (k === "data-state" ? "drawn" : null), querySelectorAll: () => [{}] };
  assert.equal(
    run({ hostFigure: null, fence: false }),
    undefined,
    "an empty host is not ready (the 230 ms vacuous anchor)",
  );
  assert.equal(run({ hostFigure: drawn, fence: true }), undefined, "a fence still shown as code is not ready");
  assert.ok(run({ hostFigure: drawn, fence: false }), "a drawn figure in its host is ready");
});

test("worker messages: the init script counts each postMessage to a worker by command, with a layout's top-level ids (O216)", async () => {
  const { WORKER_MESSAGES_SCRIPT, workerMessageSummary } = await import("../lib/coverage.mjs");
  const sent = [];
  class Worker {
    postMessage(m) {
      sent.push(m);
    }
  }
  const window = {};
  new Function("window", "Worker", "performance", WORKER_MESSAGES_SCRIPT)(window, Worker, { now: () => 5 });
  const w = new Worker();
  w.postMessage({ cmd: "register" });
  w.postMessage({
    cmd: "layout",
    graph: { id: "root", children: [{ id: "__archer_group__g" }, { id: "d" }, { id: "e" }] },
  });
  w.postMessage({ nest: { id: 1 } });
  assert.equal(sent.length, 3, "messages still reach the worker");
  const s = workerMessageSummary(window.__perfWorkerMessages);
  assert.deepEqual(s.byCmd, { register: 1, layout: 1, nest: 1 });
  assert.deepEqual(s.layouts, [{ nodes: 3, ids: ["__archer_group__g", "d", "e"] }]);
  assert.equal(workerMessageSummary(null), null);
});

// claude-303: V8 sometimes reports a worker without its top level (2,783 functions against 11,254 on the ELK
// worker); the module body's bytes then read as unused (+193.5 KB) though the worker ran it and answered the same
// layouts. Such a sample is invalid: never counted, and the run is retaken.
test("coverage: a worker report without its top-level function is an invalid sample, the other two shapes are valid", () => {
  const source = "x".repeat(1000);
  const fn = (s, e, count = 1) => ({ functionName: "", ranges: [{ startOffset: s, endOffset: e, count }] });
  const inner = [fn(700, 760, 3), fn(100, 160, 0)];
  // The three shapes seen on both builds: module and body (1–1507096, 610–1420506), plus the wrapper (0–1507100), none.
  const shapes = {
    module: [fn(1, 996), fn(1, 940), ...inner],
    wrapper: [fn(0, 1000), fn(1, 996), fn(1, 940), ...inner],
    none: inner,
  };
  const summary = (fns) => coverageSummary({ workers: [scriptCoverage("w.js", source, fns)] });
  assert.equal(summary(shapes.module).complete, true);
  assert.equal(summary(shapes.wrapper).complete, true);
  const bad = summary(shapes.none);
  assert.equal(bad.complete, false);
  assert.match(bad.invalid[0], /no top-level function \(2 functions\)/);
  // An uncalled top-level range is no evidence of a run either.
  assert.equal(summary([fn(0, 1000, 0), ...inner]).complete, false);
  // A cell holding an invalid sample is NOT EVALUATED, its run marked, and the A/A range refuses it.
  const ok = summary(shapes.module);
  const cell = coverageCell([ok, bad, ok], {
    required: 3,
    minimum: 3,
    retakes: [{ run: 1, state: "warm", try: 1, reasons: bad.invalid }],
  });
  assert.equal(cell.verdict, "NOT EVALUATED");
  assert.equal(cell.perRun[1].invalid, true);
  assert.equal(cell.retakes.length, 1);
  assert.equal(runRange(cell.perRun, "workerJs"), null);
  assert.notEqual(runRange(coverageCell([ok, ok, ok]).perRun, "workerJs"), null);
});
