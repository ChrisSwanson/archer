import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkBudgets,
  checkWarnings,
  checkFailedRequests,
  classifyVitest,
  checkPageSize,
  requestPath,
} from "../lib/gate.mjs";

const page = (over = {}) => ({
  key: "doc1",
  url: "/projects/x/",
  requests: 20,
  apiRequests: 18,
  pollTicks: 0,
  duplicateRequests: 0,
  duplicates: [],
  transferBytes: 1000,
  failedRequests: 0,
  ...over,
});
const budget = (pages, over = {}) => ({
  schema: "archer-budget/1",
  source: "harness",
  name: "j",
  totals: { duplicateWrites: 0 },
  warnings: { total: 0, byCode: {} },
  pages,
  ...over,
});
const config = {
  maxDuplicateRequestsPerPage: 0,
  allowedDuplicates: [],
  maxApiRequestsPerPage: 40,
  maxTransferBytesPerPage: 5000,
};

test("requestPath drops the origin and the login token", () => {
  assert.equal(requestPath("GET http://127.0.0.1:3/p/a/api/x?token=abc&b=1"), "GET /p/a/api/x?token=…&b=1");
});

test("a duplicate request fails unless an allow-list entry explains it", () => {
  const dup = page({
    duplicateRequests: 1,
    duplicates: [{ request: "GET http://127.0.0.1:9/p/j/api/comments/pending", count: 2 }],
  });
  const failing = checkBudgets([{ run: "j", budget: budget([dup]) }], config);
  const dupCheck = failing.find((c) => c.id === "duplicate-requests");
  assert.equal(dupCheck.ok, false);
  assert.match(dupCheck.details.join("\n"), /comments\/pending ×2/);
  const allowed = checkBudgets([{ run: "j", budget: budget([dup]) }], {
    ...config,
    allowedDuplicates: [{ match: "^GET /p/[^/]+/api/comments/pending$", reason: "r" }],
  });
  assert.equal(allowed.find((c) => c.id === "duplicate-requests").ok, true);
});

test("an allow-list entry caps the copies it explains", () => {
  const dup = page({ duplicateRequests: 2, duplicates: [{ request: "GET http://h/p/j/api/a", count: 3 }] });
  const r = checkBudgets([{ run: "j", budget: budget([dup]) }], {
    ...config,
    allowedDuplicates: [{ match: "/api/a$", maxCopies: 2, reason: "r" }],
  });
  assert.equal(r.find((c) => c.id === "duplicate-requests").ok, false);
});

test("duplicates beyond the top-10 list still count", () => {
  const dup = page({ duplicateRequests: 3, duplicates: [{ request: "GET http://h/p/j/api/a", count: 2 }] });
  const r = checkBudgets([{ run: "j", budget: budget([dup]) }], {
    ...config,
    allowedDuplicates: [{ match: "/api/a$", reason: "r" }],
  });
  const c = r.find((x) => x.id === "duplicate-requests");
  assert.equal(c.ok, false);
  assert.match(c.details.join("\n"), /2 not listed/);
});

test("API requests per page exclude poll ticks; bytes and duplicate writes are capped", () => {
  const busy = page({ apiRequests: 50, pollTicks: 15, transferBytes: 9000 });
  const r = checkBudgets([{ run: "j", budget: budget([busy], { totals: { duplicateWrites: 1 } }) }], config);
  assert.equal(r.find((c) => c.id === "api-requests-per-page").ok, true);
  assert.equal(r.find((c) => c.id === "transfer-bytes-per-page").ok, false);
  assert.equal(r.find((c) => c.id === "duplicate-writes").ok, false);
  const r2 = checkBudgets([{ run: "j", budget: budget([page({ apiRequests: 45 })]) }], config);
  assert.equal(r2.find((c) => c.id === "api-requests-per-page").ok, false);
});

test("a warm lab reload that re-downloads the page fails (caching headers)", () => {
  const lab = budget([page({ key: "diagram/default/warm", transferBytes: 3_000_000 })], { source: "page-load" });
  const c = checkBudgets([{ run: "lab", budget: lab }], {
    ...config,
    maxTransferBytesPerPage: 5_000_000,
    maxWarmTransferBytes: 1_000_000,
  }).find((x) => x.id === "transfer-bytes-per-page");
  assert.equal(c.ok, false);
  assert.match(c.details[0], /warm reload/);
});

test("lab rows: over-budget values and errors fail", () => {
  const over = [
    { key: "projects/default/cold", field: "lcpMs", value: 2000, cap: 1200 },
    { key: "projects/default/cold", field: "longTaskMs", value: 2500, cap: 1200 },
    { key: "projects/default/warm", field: "domNodes", value: 500, cap: 300 },
  ];
  const lab = budget([page({ key: "projects/default/cold" })], {
    source: "page-load",
    overBudget: over,
    errors: [{ key: "diagram/default/warm", error: "timeout" }],
  });
  const r = checkBudgets([{ run: "lab", budget: lab }], config);
  const c = r.find((x) => x.id === "lab-budget");
  assert.equal(c.ok, false);
  const text = c.details.join("\n");
  assert.match(text, /longTaskMs 2500 > 1200 \(over 2× the cap\)/);
  assert.match(text, /domNodes 500 > 300/);
  assert.match(text, /timeout/);
  assert.doesNotMatch(text, /lcpMs/);
  const t = r.find((x) => x.id === "lab-timing");
  assert.equal(t.ok, true);
  assert.equal(t.warn, true);
  assert.match(t.details[0], /lcpMs 2000 > 1200 \(warn/);
  // timingFailFactor null: timings never fail, however far over (a shared host).
  const lenient = checkBudgets([{ run: "lab", budget: lab }], { ...config, timingFailFactor: null });
  assert.doesNotMatch(lenient.find((x) => x.id === "lab-budget").details.join("\n"), /longTaskMs/);
  assert.equal(lenient.find((x) => x.id === "lab-timing").details.length, 2);
});

test("every ui./svc. warning fails unless allow-listed; match narrows by message; max caps the count", () => {
  const warnings = [
    { run: "a", code: "svc.duplicate-request", msg: "POST /p/j/api/authoring/edit 3× within 2000 ms" },
    { run: "a", code: "svc.duplicate-request", msg: "GET /p/j/api/comments/pending 3× within 2000 ms" },
    { run: "a", code: "ui.render-storm", msg: "editor committed 31 times" },
    { run: "a", code: "svc.request-burst", msg: "x" },
    { run: "a", code: "svc.request-burst", msg: "x" },
    { run: "a", code: "harness.telemetry-gap", msg: "ring wrapped" },
  ];
  const allow = [
    { code: "svc.duplicate-request", match: "^POST ", reason: "distinct writes share a URL" },
    { code: "svc.request-burst", max: 1, reason: "journeys navigate fast" },
  ];
  const r = checkWarnings(warnings, allow);
  assert.equal(r.ok, false);
  const text = r.details.join("\n");
  assert.match(text, /svc\.duplicate-request ×1 not allowed.*comments\/pending/);
  assert.match(text, /ui\.render-storm ×1 not allowed/);
  assert.match(text, /svc\.request-burst ×2 over its allowance of 1/);
  assert.doesNotMatch(text, /harness\./);
  assert.equal(r.allowed.find((a) => a.code === "svc.duplicate-request").count, 1);
  assert.equal(checkWarnings(warnings.slice(0, 1), allow).ok, true);
});

test("a run-scoped entry covers only the runs it names", () => {
  const allow = [
    { code: "svc.duplicate-request", match: "^GET /projects/", run: "^lab$", reason: "cold + warm reload" },
  ];
  assert.equal(
    checkWarnings([{ run: "lab", code: "svc.duplicate-request", msg: "GET /projects/ 3× within 2000 ms" }], allow).ok,
    true,
  );
  assert.equal(
    checkWarnings(
      [{ run: "editor-entry", code: "svc.duplicate-request", msg: "GET /projects/ 3× within 2000 ms" }],
      allow,
    ).ok,
    false,
  );
});

test("a match entry cannot allow a warning whose message is unknown (lab codes)", () => {
  const r = checkWarnings(
    [{ run: "lab", code: "svc.duplicate-request", msg: null }],
    [{ code: "svc.duplicate-request", match: "^POST ", reason: "r" }],
  );
  assert.equal(r.ok, false);
});

test("failed requests: aborted ones are not failures; allow-list by method + path", () => {
  const reqs = [
    { method: "POST", url: "http://h/p/j/api/selection", status: null, error: "net::ERR_ABORTED" },
    { method: "GET", url: "http://h/p/j/api/views/zzz", status: 404 },
    { method: "GET", url: "http://h/p/j/api/x", status: 500 },
    { method: "GET", url: "http://h/p/j/api/y", status: null, error: "net::ERR_CONNECTION_REFUSED" },
    { method: "GET", url: "http://h/p/j/-/debug/log", status: 500 },
  ];
  const r = checkFailedRequests(
    [{ run: "j", requests: reqs }],
    [{ match: "^GET /p/j/api/views/", reason: "missing-view journey" }],
  );
  assert.equal(r.ok, false);
  const text = r.details.join("\n");
  assert.match(text, /500 GET \/p\/j\/api\/x/);
  assert.match(text, /ERR_CONNECTION_REFUSED/);
  assert.doesNotMatch(text, /selection|views|debug/);
});

test("vitest: rg ENOENT failures are an environment gap, anything else fails", () => {
  const result = (msgs) => ({
    numFailedTests: msgs.length,
    numPassedTests: 10,
    numPendingTests: 1,
    testResults: [
      {
        name: "/r/test/a.test.ts",
        assertionResults: msgs.map((m, i) => ({ fullName: `t${i}`, status: "failed", failureMessages: [m] })),
      },
    ],
  });
  assert.equal(classifyVitest(result([]), { exitCode: 0 }).status, "PASS");
  const gap = classifyVitest(result(["Error: spawnSync rg ENOENT\n at x"]), { exitCode: 1, rgOnPath: false });
  assert.equal(gap.status, "WARN");
  assert.match(gap.details.join("\n"), /ripgrep/);
  const named = classifyVitest(
    result(["Error: ripgrep (rg) is not installed: the retrieval evaluation runs the real rg"]),
    { exitCode: 1, rgOnPath: false },
  );
  assert.equal(named.status, "WARN");
  assert.equal(classifyVitest(result(["Error: spawnSync rg ENOENT"]), { exitCode: 1, rgOnPath: true }).status, "FAIL");
  assert.equal(
    classifyVitest(result(["Error: spawnSync rg ENOENT", "AssertionError: expected 1"]), {
      exitCode: 1,
      rgOnPath: false,
    }).status,
    "FAIL",
  );
  assert.equal(classifyVitest(null, { exitCode: 1 }).status, "FAIL");
  // A suite that failed to load has no assertion results but is still a failure.
  assert.equal(
    classifyVitest(
      {
        numFailedTests: 0,
        numFailedTestSuites: 1,
        testResults: [{ name: "/r/b.test.ts", status: "failed", message: "SyntaxError", assertionResults: [] }],
      },
      { exitCode: 1 },
    ).status,
    "FAIL",
  );
});

test("page size: raw and compressed caps", () => {
  assert.equal(
    checkPageSize({ raw: 100, gzip: 30, brotli: 20 }, { maxRawBytes: 120, maxGzipBytes: 40, maxBrotliBytes: 25 }).ok,
    true,
  );
  const r = checkPageSize({ raw: 130, gzip: 30, brotli: 20 }, { maxRawBytes: 120 });
  assert.equal(r.ok, false);
  assert.match(r.details.join("\n"), /raw 130 B > 120 B/);
  // What is measured is named, and an over-cap value is given exactly, with the margin.
  const over = checkPageSize(
    { raw: 4_090_000, gzip: 1_198_812, brotli: 950_000 },
    { maxGzipBytes: 1_195_700 },
    "MCP single file",
  );
  assert.match(over.title, /^MCP single file /);
  assert.deepEqual(over.details, ["gzip 1,198,812 B > 1,195,700 B (+3,112 B)"]);
});

test("pages are built without uncommitted ui/index.html injections (dev-only script tags)", async () => {
  const { cleanPage } = await import("../lib/gate.mjs");
  const head =
    '<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n';
  const work =
    '<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.tsx"></script>\n  <!-- impeccable-live-start -->\n<script src="http://localhost:8401/live.js?token=abc"></script>\n<!-- impeccable-live-end -->\n</body>\n</html>\n';
  const built =
    '<body><div id="root"></div><script type="module">/*app*/</script>\n  <!-- impeccable-live-start -->\n<script src="http://localhost:8401/live.js?token=abc"></script>\n<!-- impeccable-live-end -->\n</body></html>';
  const r = cleanPage(built, { head, work });
  assert.equal(r.removed.length, 3);
  assert.doesNotMatch(r.html, /live\.js|impeccable/);
  assert.deepEqual(r.external, []);
  // An external script nobody committed that survives the strip is reported, not shipped silently.
  const r2 = cleanPage('<script src="https://cdn.example/x.js"></script>', { head, work: head });
  assert.deepEqual(r2.external, ["https://cdn.example/x.js"]);
});

test("thumbnail images have their own per-page cap, apart from API requests", () => {
  const gallery = page({ apiRequests: 20, thumbnailRequests: 70 });
  const r = checkBudgets([{ run: "j", budget: budget([gallery]) }], { ...config, maxThumbnailRequestsPerPage: 72 });
  assert.equal(r.find((c) => c.id === "api-requests-per-page").ok, true);
  assert.equal(r.find((c) => c.id === "thumbnail-requests-per-page").ok, true);
  const flood = checkBudgets([{ run: "j", budget: budget([page({ thumbnailRequests: 90 })]) }], {
    ...config,
    maxThumbnailRequestsPerPage: 72,
  });
  assert.equal(flood.find((c) => c.id === "thumbnail-requests-per-page").ok, false);
});
