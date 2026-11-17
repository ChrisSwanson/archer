// node --test tools/perf/test/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  markdown,
  medianOf,
  overBudget,
  parseServerTiming,
  seedBudgets,
  summariseLoad,
  urlPattern,
} from "../lib/report.mjs";
import { guardReadOnly, readOnlyAllows } from "../page-load.mjs";

const req = (over) => ({
  url: "https://h/p/a/api/views",
  method: "GET",
  type: "Fetch",
  status: 200,
  startMs: 0,
  endMs: 10,
  transferBytes: 100,
  decodedBytes: 200,
  fromCache: false,
  serverTiming: {},
  ...over,
});

test("summarises a load: totals, duplicates, polls, slowest, server timing; event streams left out", () => {
  const requests = [
    req({ url: "https://h/projects/", type: "Document", transferBytes: 5000, decodedBytes: 5000 }),
    ...Array.from({ length: 6 }, (_, i) =>
      req({
        url: "https://h/p/a/api/browser-projects",
        startMs: i * 1000,
        endMs: i * 1000 + 5,
        serverTiming: { total: 2 },
        ...(i ? { poll: `project-catalog#${i}` } : {}),
      }),
    ),
    ...[0, 400].map((startMs) => req({ url: "https://h/p/a/api/bootstrap", startMs, endMs: startMs + 1 })),
    req({ url: "https://h/p/a/api/comments?target=a", endMs: 900, status: 500 }),
    req({
      method: "POST",
      url: "https://h/p/a/api/operations",
      body: '{"name":"export_diagram","arguments":{"viewId":"a"}}',
    }),
    req({
      method: "POST",
      url: "https://h/p/a/api/operations",
      body: '{"name":"export_diagram","arguments":{"viewId":"b"}}',
    }),
    req({ url: "https://h/p/a/api/events", type: "EventSource", endMs: 99_999 }),
  ];
  const m = summariseLoad({
    requests,
    page: {
      fcp: 100.4,
      lcp: 200,
      cls: 0.12345,
      longTasks: [60, 90],
      heapUsedBytes: 10 * 1048576,
      domNodes: 500,
      ttfb: 5,
    },
    wallMs: 1234.5,
  });
  assert.equal(m.requests, 12);
  assert.equal(m.transferBytes, 5000 + 11 * 100);
  assert.equal(m.documentDecodedBytes, 5000);
  assert.equal(m.failedRequests, 1);
  assert.equal(
    m.duplicateRequests,
    1,
    "five tagged poll ticks are none, the untagged bootstrap repeat is one; two POSTs with different bodies are none",
  );
  assert.deepEqual(
    m.duplicates.map((d) => [d.request, d.count]),
    [["GET https://h/p/a/api/bootstrap", 2]],
  );
  assert.deepEqual(m.polls, [
    { poll: "project-catalog", request: "GET https://h/p/a/api/browser-projects", count: 5, intervalMs: 1000 },
  ]);
  assert.equal(m.slowest[0].request, "GET /p/a/api/comments?target");
  assert.deepEqual(m.serverTimingMs, { total: 12 });
  assert.deepEqual(
    [m.fcpMs, m.lcpMs, m.cls, m.longTasks, m.longTaskMs, m.heapUsedMb, m.wallMs],
    [100, 200, 0.123, 2, 150, 10, 1235],
  );
});

test("heap after GC is reported in MB, main thread and workers apart; null when not read", () => {
  const m = summariseLoad({
    requests: [],
    page: { heapAfterGcBytes: 5 * 1048576, workerHeapAfterGcBytes: 0 },
    wallMs: 1,
  });
  assert.deepEqual([m.heapAfterGcMb, m.workerHeapAfterGcMb], [5, 0]);
  assert.deepEqual(
    ((x) => [x.heapAfterGcMb, x.workerHeapAfterGcMb])(summariseLoad({ requests: [], page: {}, wallMs: 1 })),
    [null, null],
  );
});

test("median across runs", () => {
  const runs = [
    { wallMs: 10, requests: 5, x: "a" },
    { wallMs: 30, requests: 9, x: "b" },
    { wallMs: 20, requests: 7, x: "c" },
  ];
  assert.deepEqual(medianOf(runs), { wallMs: 20, requests: 7, x: "c", runs: 3 });
});

test("budgets are seeded with head-room and catch a regression", () => {
  const report = {
    generatedAt: "t",
    base: "b",
    results: [
      {
        page: "project-diagrams",
        profile: "default",
        state: "cold",
        metrics: { transferBytes: 2_000_000, requests: 100, lcpMs: 1000, wallMs: 5000 },
      },
    ],
  };
  const budget = seedBudgets(report);
  assert.ok(budget.budgets["project-diagrams/default/cold"].transferBytes > 2_000_000);
  assert.deepEqual(overBudget(report, budget), []);
  const worse = {
    ...report,
    results: [{ ...report.results[0], metrics: { ...report.results[0].metrics, requests: 200 } }],
  };
  assert.deepEqual(
    overBudget(worse, budget).map((f) => f.field),
    ["requests"],
  );
  assert.match(markdown(worse, overBudget(worse, budget)), /Over budget/);
});

test("a duplicate-request cap is seeded exactly: zero measured duplicates seed zero, never the 2 that contradicted maxDuplicateRequestsPerPage", () => {
  const report = (duplicateRequests) => ({
    generatedAt: "t",
    base: "b",
    results: [
      {
        page: "projects",
        profile: "default",
        state: "cold",
        metrics: { requests: 40, wallMs: 900, domNodes: 400, duplicateRequests },
        budgetRow: { apiRequests: 6 },
      },
    ],
  });
  assert.equal(seedBudgets(report(0)).budgets["projects/default/cold"].duplicateRequests, 0);
  assert.equal(seedBudgets(report(3)).budgets["projects/default/cold"].duplicateRequests, 3);
});

test("a broken row (failed, no API request, an all-but-empty page) seeds no budget and is named", () => {
  const row = (page, over = {}) => ({
    page,
    profile: "default",
    state: "cold",
    metrics: { requests: 9, wallMs: 900, domNodes: 400, ...over.metrics },
    budgetRow: { apiRequests: 6, ...over.budgetRow },
    ...(over.error ? { error: over.error } : {}),
  });
  const budget = seedBudgets({
    generatedAt: "t",
    base: "b",
    results: [
      row("ok"),
      row("blank", { metrics: { domNodes: 12 } }),
      row("offline", { budgetRow: { apiRequests: 0 } }),
      row("failed", { error: "timeout" }),
    ],
  });
  assert.deepEqual(Object.keys(budget.budgets), ["ok/default/cold"]);
  assert.deepEqual(
    budget.refused.map((r) => r.key),
    ["blank/default/cold", "offline/default/cold", "failed/default/cold"],
  );
  assert.equal(seedBudgets({ generatedAt: "t", base: "b", results: [row("ok")] }).refused, undefined);
});

test("a row far below the budget it would replace is refused unless the drop is accepted (a half-applied change drew 9 DOM nodes)", () => {
  const row = (page, metrics) => ({
    page,
    profile: "default",
    state: "warm",
    metrics: { requests: 12, wallMs: 900, domNodes: 400, ...metrics },
    budgetRow: { apiRequests: 6 },
  });
  const previous = {
    budgets: {
      "editor/default/warm": { domNodes: 2000, requests: 15 },
      "list/default/warm": { domNodes: 530, requests: 16 },
    },
  };
  const report = {
    generatedAt: "t",
    base: "b",
    results: [row("editor", { domNodes: 300 }), row("list", { domNodes: 420 }), row("new", {})],
  };
  const refused = seedBudgets(report, undefined, { previous });
  assert.deepEqual(
    refused.refused.map((r) => r.key),
    ["editor/default/warm"],
  );
  assert.match(refused.refused[0].reason, /domNodes.*2000/);
  assert.deepEqual(Object.keys(refused.budgets), ["list/default/warm", "new/default/warm"]);
  assert.equal(seedBudgets(report, undefined, { previous, acceptDrop: true }).refused, undefined);
});

test("a cold row that moved less than a tenth of its document came from the cache and seeds nothing", () => {
  const cold = {
    page: "p",
    profile: "default",
    state: "cold",
    metrics: { requests: 9, domNodes: 400, transferBytes: 60_000, documentDecodedBytes: 4_000_000 },
    budgetRow: { apiRequests: 6 },
  };
  assert.match(seedBudgets({ generatedAt: "t", base: "b", results: [cold] }).refused[0].reason, /cache/);
  const real = { ...cold, metrics: { ...cold.metrics, transferBytes: 1_000_000 } };
  assert.equal(seedBudgets({ generatedAt: "t", base: "b", results: [real] }).refused, undefined);
});

test("summariseLoad: a cancelled request is not a failed one", () => {
  const r = (url, over) => ({ url, method: "GET", type: "Fetch", startMs: 0, endMs: 1, ...over });
  const m = summariseLoad({
    requests: [
      r("http://h/a", { status: null, error: "net::ERR_ABORTED", canceled: true }),
      r("http://h/b", { status: null, error: "net::ERR_FAILED" }),
      r("http://h/c", { status: 200 }),
    ],
    page: {},
    wallMs: 1,
  });
  assert.equal(m.failedRequests, 1);
});

test("read-only mode lets reads through and refuses writes", () => {
  const cases = [
    ["GET", "/p/a/api/comments", undefined, true],
    ["POST", "/p/a/api/compile", "{}", true],
    ["POST", "/p/a/api/authoring/preview", "{}", true],
    ["POST", "/p/a/api/operations", '{"name":"export_diagram"}', true],
    ["POST", "/p/a/api/operations", '{"name":"write_diagram"}', false],
    ["POST", "/p/a/api/authoring/presentation", '{"op":"read"}', true],
    ["POST", "/p/a/api/authoring/presentation", '{"op":"save"}', false],
    ["POST", "/p/a/api/authoring", "{}", false],
    ["POST", "/p/a/api/selection", "{}", false],
    ["POST", "/p/a/api/comments", "{}", false],
    ["DELETE", "/p/a/api/comments/x", undefined, false],
  ];
  for (const [method, path, body, allowed] of cases)
    assert.equal(readOnlyAllows(method, path, body), allowed, `${method} ${path} ${body}`);
});

test("url patterns and Server-Timing", () => {
  assert.equal(
    urlPattern("https://h/p/a/api/thumbnails/0123456789abcdef?rev=1&theme=l"),
    "/p/a/api/thumbnails/:id?rev&theme",
  );
  assert.deepEqual(parseServerTiming("auth;dur=1, total;dur=3.5"), { auth: 1, total: 3.5 });
});

test("firstLoadBytes: the page, scripts, workers, styles and fonts a load transferred, from Resource Timing; API reads left out", async () => {
  const { firstLoadBytes } = await import("../lib/report.mjs");
  const e = (name, initiatorType, transferSize, decodedBodySize = transferSize * 3, entryType = "resource") => ({
    name,
    initiatorType,
    transferSize,
    decodedBodySize,
    entryType,
  });
  const f = firstLoadBytes([
    e("https://h/projects/", "navigation", 1000, 4000, "navigation"),
    e("https://h/assets/index-abc.js", "script", 300),
    e("https://h/assets/elk-worker-abc.js", "other", 500),
    e("https://h/assets/index-abc.css", "link", 40),
    e("https://h/assets/inter-abc.woff2", "css", 50),
    e("https://h/p/a/api/bootstrap", "fetch", 2000),
    e("https://h/p/a/api/thumbnails/x?rev=1", "img", 900),
  ]);
  assert.deepEqual(f, {
    page: 1000,
    scripts: 300,
    workers: 500,
    styles: 40,
    fonts: 50,
    total: 1890,
    decoded: 4000 + 900 + 1500 + 120 + 150,
    files: 5,
  });
  assert.equal(firstLoadBytes([]), null, "no entries (an old browser, a blocked evaluate) → null, not zeros");
});

test("domShape: elements per row and per header, the shell outside <main>, and the rest", async () => {
  const { domShape } = await import("../lib/report.mjs");
  const d = domShape({ total: 1000, main: 800, rows: [20, 22, 21, 30], headers: [12] });
  assert.deepEqual(d, {
    total: 1000,
    shell: 200,
    rows: 4,
    rowElements: 93,
    perRow: 23.3,
    maxPerRow: 30,
    headers: 1,
    headerElements: 12,
    otherInMain: 695,
  });
  assert.deepEqual(domShape({ total: 50, main: null, rows: [], headers: [] }), {
    total: 50,
    shell: null,
    rows: 0,
    rowElements: 0,
    perRow: null,
    maxPerRow: null,
    headers: 0,
    headerElements: 0,
    otherInMain: null,
  });
});

test("the read-only guard: what the lab allows goes on, a write fails and is named (warm-up and measured loads alike)", async () => {
  const sent = [],
    handlers = {};
  const cdp = {
    send: async (method, params) => {
      sent.push([method, params]);
    },
    on: (event, handler) => {
      handlers[event] = handler;
    },
  };
  const blocked = [];
  await guardReadOnly(cdp, blocked);
  assert.deepEqual(sent[0], ["Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] }]);
  const pause = (requestId, method, url, postData) =>
    handlers["Fetch.requestPaused"]({ requestId, request: { method, url, postData } });
  pause("1", "GET", "http://h/p/a/api/diagrams");
  // The reader's selection, which a warm-up once saved as the project's remembered view (recovery): the next
  // surface's page then restored it, and new-diagram after flow-diagram laid a flowchart out behind the editor.
  pause("2", "POST", "http://h/p/a/api/selection", "{}");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.slice(1), [
    ["Fetch.continueRequest", { requestId: "1" }],
    ["Fetch.failRequest", { requestId: "2", errorReason: "BlockedByClient" }],
  ]);
  assert.deepEqual(blocked, ["POST /p/a/api/selection"]);
});
