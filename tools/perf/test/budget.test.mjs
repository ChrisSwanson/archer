// node --test tools/perf/test/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDGET_SCHEMA, budgetResults, countCodes, pageBudget } from "../lib/budget.mjs";
import { initiatorOf, summariseLoad } from "../lib/report.mjs";
import { diagramTargets, labBudget } from "../page-load.mjs";

test("pageBudget: event streams left out, a scheduled poll's tick is no duplicate, bytes summed", () => {
  const req = (url, startMs, over = {}) => ({
    url,
    method: "GET",
    type: "Fetch",
    startMs,
    transferBytes: 5,
    status: 200,
    ...over,
  });
  const view = "http://h/p/a/api/browser-projects";
  const p = pageBudget({
    key: "k",
    url: "/x",
    requests: [
      req(view, 0),
      req(view, 100),
      req(view, 15100, { poll: "project-catalog#1" }),
      req("http://h/x.js", 0, { status: 404 }),
      req("http://h/p/a/api/events", 0, { type: "EventSource" }),
    ],
  });
  assert.deepEqual(
    [p.requests, p.apiRequests, p.duplicateRequests, p.pollTicks, p.transferBytes, p.failedRequests],
    [4, 3, 1, 1, 20, 1],
  );
  assert.equal(
    pageBudget({ key: "k", url: "/", requests: [{ url: "http://h/a", method: "GET", at: 0 }] }).transferBytes,
    null,
    "no byte data → null, not 0",
  );
});

test("pageBudget: a cancelled request (navigation, abort) is not a failed one; no response otherwise is", () => {
  const req = (over) => ({ url: "http://h/p/a/api/a", method: "GET", type: "Fetch", startMs: 0, ...over });
  const p = pageBudget({
    key: "k",
    url: "/x",
    requests: [
      req({ status: null, error: "net::ERR_ABORTED" }),
      req({ url: "http://h/p/a/api/b", status: null, canceled: true, error: "" }),
      req({ url: "http://h/p/a/api/c", status: null, failure: "net::ERR_ABORTED" }),
      req({ url: "http://h/p/a/api/d", status: null, error: "net::ERR_CONNECTION_REFUSED" }),
      req({ url: "http://h/p/a/api/e", status: null }),
      req({ url: "http://h/p/a/api/f", status: 503 }),
      req({ url: "http://h/p/a/api/g", status: 304 }),
    ],
  });
  assert.equal(p.failedRequests, 3);
});

test("budgetResults totals and warnings", () => {
  const b = budgetResults({
    source: "page-load",
    name: "n",
    generatedAt: "t",
    pages: [
      { requests: 3, apiRequests: 2, duplicateRequests: 1, transferBytes: 10, failedRequests: 0 },
      { requests: 5, apiRequests: 4, duplicateRequests: 0, transferBytes: 20, failedRequests: 1 },
    ],
    warnings: countCodes(["a", "b", "a"]),
    overBudget: [],
  });
  assert.equal(b.schema, BUDGET_SCHEMA);
  assert.deepEqual(b.totals, {
    pages: 2,
    requests: 8,
    apiRequests: 6,
    duplicateRequests: 1,
    transferBytes: 30,
    failedRequests: 1,
    maxApiRequestsPerPage: 4,
    maxDuplicateRequestsPerPage: 1,
  });
  assert.deepEqual(b.warnings, { total: 3, byCode: { a: 2, b: 1 } });
  assert.deepEqual(b.overBudget, []);
  assert.equal(b.failures, undefined, "the lab has no invariants");
});

test("initiatorOf names the app call site behind fetch wrappers, async parents included", () => {
  const f = (functionName, url = "http://h/projects/a/x.mmd", lineNumber = 9, columnNumber = 4) => ({
    functionName,
    url,
    lineNumber,
    columnNumber,
  });
  const initiator = {
    type: "script",
    stack: {
      callFrames: [f("Ute.window.fetch"), f("browserFetch")],
      parent: { callFrames: [f("loadComments", "http://h/projects/a/x.mmd", 19, 0)] },
    },
  };
  assert.equal(initiatorOf(initiator), "loadComments x.mmd:20:1");
  assert.equal(initiatorOf({ type: "parser" }), "parser");
  const m = summariseLoad({
    requests: [1, 2].map((i) => ({
      url: "http://h/p/a/api/c",
      method: "GET",
      type: "Fetch",
      status: 200,
      startMs: i,
      endMs: i + 1,
      initiator: i === 1 ? "A x:1:1" : "B x:2:1",
    })),
    page: {},
    wallMs: 1,
  });
  assert.deepEqual(m.duplicates[0].initiators, [
    { site: "A x:1:1", count: 1 },
    { site: "B x:2:1", count: 1 },
  ]);
});

test("labBudget: rows keyed like budgets.json, errors kept, telemetry warnings summed", () => {
  const row = (page, state, dup) => ({
    page,
    path: `/${page}`,
    profile: "default",
    state,
    metrics: { wallMs: 1, lcpMs: 2, longTaskMs: 3, decodedBytes: 4, telemetryWarnings: { "ui.long-task": 1 } },
    budgetRow: {
      key: "x",
      url: "u",
      requests: 2,
      apiRequests: 1,
      duplicateRequests: dup,
      transferBytes: 9,
      failedRequests: 0,
      duplicates: [],
    },
  });
  const b = labBudget(
    {
      project: "p",
      generatedAt: "t",
      results: [
        row("diagram", "cold", 2),
        row("diagram", "warm", 0),
        { page: "new-diagram", profile: "default", state: "cold", error: "boom" },
      ],
    },
    [],
  );
  assert.deepEqual(
    b.pages.map((p) => p.key),
    ["diagram/default/cold", "diagram/default/warm"],
  );
  assert.equal(b.totals.duplicateRequests, 2);
  assert.deepEqual(b.warnings.byCode, { "ui.long-task": 2 });
  assert.deepEqual(b.errors, [{ key: "new-diagram/default/cold", error: "boom" }]);
});

test("diagramTargets: diagrams are measured at their canonical address; the project-path form keeps its own row (perf #3)", () => {
  const project = {
    slug: "shop",
    views: [
      { id: "notes/a.md#x", registration: "embedded", sourcePath: "notes/a.md" },
      { id: "flow", registration: "durable", sourcePath: "diagrams/flow.mmd" },
    ],
    documents: { documents: [{ source: { path: ".archer/diagrams/flow.mmd" }, legacy: { viewId: "flow" } }] },
  };
  const t = diagramTargets(project, undefined);
  assert.equal(t.diagram, "diagrams/flow.mmd");
  assert.equal(t.paths.diagram, "/projects/shop/diagrams/flow.mmd");
  assert.equal(t.paths["diagram-edit"], "/projects/shop/diagrams/flow.mmd?edit");
  assert.equal(t.paths["diagram-folder-path"], "/projects/shop/.archer/diagrams/flow.mmd");
  // --diagram may name the file by its project path: still measured canonically.
  assert.equal(diagramTargets(project, ".archer/diagrams/flow.mmd").paths.diagram, "/projects/shop/diagrams/flow.mmd");
  assert.equal(diagramTargets(project, "./diagrams/flow.mmd").paths.diagram, "/projects/shop/diagrams/flow.mmd");
  // Without a documents catalog there is no project-path row.
  assert.equal(diagramTargets({ slug: "shop", views: project.views }, undefined).paths["diagram-folder-path"], null);
});

test("pageBudget: thumbnail images are counted apart from API requests (cached a year, fetched ahead at low priority)", () => {
  const req = (url, startMs, over = {}) => ({ url, method: "GET", type: "Fetch", startMs, status: 200, ...over });
  const p = pageBudget({
    key: "k",
    url: "/x",
    requests: [
      req("http://h/p/a/api/diagrams", 0),
      req("http://h/p/a/api/thumbnails/v1?rev=r&theme=light&v=1", 10, { type: "Image" }),
      req("http://h/p/b/api/thumbnails/v2?rev=r&theme=light&v=1", 20, { type: "Image" }),
    ],
  });
  assert.deepEqual([p.requests, p.apiRequests, p.thumbnailRequests], [3, 1, 2]);
  // The same thumbnail twice is still a duplicate.
  const twice = pageBudget({
    key: "k",
    url: "/x",
    requests: [
      req("http://h/p/a/api/thumbnails/v1?rev=r", 0, { type: "Image" }),
      req("http://h/p/a/api/thumbnails/v1?rev=r", 5, { type: "Image" }),
    ],
  });
  assert.equal(twice.duplicateRequests, 1);
});

test("pageBudget: a thumbnail asked for again later is no API poll tick (Codex review)", () => {
  const req = (url, startMs, over = {}) => ({ url, method: "GET", type: "Fetch", startMs, status: 200, ...over });
  const api = Array.from({ length: 41 }, (_, i) => req(`http://h/p/a/api/r${i}`, i));
  const p = pageBudget({
    key: "k",
    url: "/x",
    requests: [
      ...api,
      req("http://h/p/a/api/thumbnails/v?rev=1", 0, { type: "Image" }),
      req("http://h/p/a/api/thumbnails/v?rev=1", 1000, { type: "Image" }),
    ],
  });
  assert.equal(p.apiRequests - p.pollTicks, 41);
});

test("pageBudget: a read again whose answer changed (another ETag) is a refresh after a change, not a duplicate", () => {
  const req = (startMs, etag) => ({
    url: "http://h/p/a/api/diagrams/v1",
    method: "GET",
    type: "Fetch",
    startMs,
    status: 200,
    ...(etag ? { etag } : {}),
  });
  assert.equal(
    pageBudget({ key: "k", url: "/x", requests: [req(0, 'W/"a"'), req(400, 'W/"b"')] }).duplicateRequests,
    0,
  );
  // The same answer twice, or no ETag to tell: still a duplicate.
  assert.equal(
    pageBudget({ key: "k", url: "/x", requests: [req(0, 'W/"a"'), req(400, 'W/"a"')] }).duplicateRequests,
    1,
  );
  assert.equal(pageBudget({ key: "k", url: "/x", requests: [req(0), req(400)] }).duplicateRequests, 1);
});

test("pageBudget: only a tagged scheduled poll is a poll tick; any other repeat in a load is a duplicate", () => {
  const req = (url, startMs, over = {}) => ({ url, method: "GET", type: "Fetch", startMs, status: 200, ...over });
  // Bootstrap read twice, 1 s apart: once passed as a poll tick.
  const boot = pageBudget({
    key: "k",
    url: "/x",
    requests: [req("http://h/p/a/api/bootstrap", 0), req("http://h/p/a/api/bootstrap", 1000)],
  });
  assert.deepEqual([boot.pollTicks, boot.duplicateRequests], [0, 1]);
  // The project catalog's 15 s tick carries its tag; an untagged repeat 15 s later is no tick.
  const catalog = "http://h/api/browser-projects";
  assert.deepEqual(
    ((p) => [p.pollTicks, p.duplicateRequests])(
      pageBudget({
        key: "k",
        url: "/x",
        requests: [req(catalog, 0), req(catalog, 15000, { poll: "project-catalog#1" })],
      }),
    ),
    [1, 0],
  );
  assert.deepEqual(
    ((p) => [p.pollTicks, p.duplicateRequests])(
      pageBudget({ key: "k", url: "/x", requests: [req(catalog, 0), req(catalog, 15000)] }),
    ),
    [0, 1],
  );
  // Nothing re-reads a diagram on a timer: a real double read one second apart is a duplicate (Claude pass-1
  // review, finding 3).
  const view = "http://h/p/a/api/diagrams/flow";
  assert.deepEqual(
    ((p) => [p.pollTicks, p.duplicateRequests])(
      pageBudget({ key: "k", url: "/x", requests: [req(view, 0), req(view, 1000)] }),
    ),
    [0, 1],
  );
});

test("pageBudget: a read again after a person's input (harness `invalidations`) is no duplicate; a changed step number alone is (Codex 5)", () => {
  const req = (startMs, step) => ({
    url: "http://h/p/a/api/authoring",
    method: "GET",
    type: "Fetch",
    startMs,
    status: 200,
    step,
  });
  assert.equal(pageBudget({ key: "k", url: "/x", requests: [req(0, 3), req(10, 4)] }).duplicateRequests, 1);
  assert.equal(
    pageBudget({ key: "k", url: "/x", requests: [req(0, 3), req(1800, 13)], invalidations: [900] }).duplicateRequests,
    0,
  );
  assert.equal(pageBudget({ key: "k", url: "/x", requests: [req(0, 3), req(1800, 3)] }).duplicateRequests, 1);
});

test("pageBudget: committed edits are counted apart from API requests (each is a person's change; the cap is about reads)", () => {
  const edit = (i) => ({ url: "http://h/p/a/api/authoring/edit", method: "POST", at: i, body: `b${i}`, status: 200 });
  const read = (path, i) => ({ url: `http://h/p/a/api/${path}`, method: "GET", at: 100 + i, status: 200 });
  const preview = { url: "http://h/p/a/api/authoring/preview", method: "POST", at: 200, body: "p", status: 200 };
  const p = pageBudget({
    key: "k",
    url: "/e",
    requests: [
      ...Array.from({ length: 45 }, (_, i) => edit(i)),
      ...["bootstrap", "diagrams", "compile"].map(read),
      preview,
    ],
  });
  assert.deepEqual([p.requests, p.apiRequests, p.editRequests], [49, 4, 45]);
});
