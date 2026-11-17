// node --test tools/perf/test/service-load.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COVERAGE,
  dropReplays,
  LAG_WARN_MS,
  markdown,
  metricsSummary,
  pairingMetrics,
  pairsFrom,
  percentile,
  phaseCoverage,
  routeKey,
  routeStats,
  sampleCoverage,
} from "../lib/service-load.mjs";

const H = "http://127.0.0.1:1";
const s = (url, serverTiming, extra = {}) => ({ method: "GET", url: `${H}${url}`, serverTiming, ...extra });

test("routeKey folds project, view, page address and asset into placeholders", () => {
  assert.equal(
    routeKey("GET", `${H}/p/awkward/api/thumbnails/flow-styled?rev=sha256:ab&theme=light&v=3`),
    "GET /p/:project/api/thumbnails/:view?rev&theme&v",
  );
  assert.equal(routeKey("GET", `${H}/p/journeys/api/diagrams/flow-a`), "GET /p/:project/api/diagrams/:view");
  assert.equal(
    routeKey("GET", `${H}/p/awkward/api/notes/content?path=notes/auth.md`),
    "GET /p/:project/api/notes/content?path",
  );
  assert.equal(routeKey("GET", `${H}/projects/`), "GET /projects/");
  assert.equal(routeKey("GET", `${H}/projects/awkward/`), "GET /projects/:project/");
  assert.equal(routeKey("GET", `${H}/projects/awkward/diagrams/flow-styled.mmd`), "GET /projects/:project/*");
  assert.equal(routeKey("GET", `${H}/-/page-assets/elk-layout-worker-CiN6taPO.js`), "GET /-/page-assets/:asset");
  assert.equal(routeKey("POST", `${H}/p/awkward/api/authoring/preview`), "POST /p/:project/api/authoring/preview");
});

test("percentile is nearest-rank; p95 of 1..20 is 19, of 1..100 is 95", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(twenty, 0.95), 19);
  assert.equal(percentile(twenty, 0.5), 10);
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, i) => 100 - i),
      0.95,
    ),
    95,
  );
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([], 0.5), null);
});

test("routeStats: p50/p95 per route over Server-Timing total; streams counted, not timed", () => {
  const rows = [];
  for (let i = 1; i <= 20; i++) rows.push(s(`/p/a/api/diagrams/v${i}`, { auth: 0.1, total: i }, { wallMs: i + 1 }));
  rows.push(s("/p/a/api/events", { auth: 0.1, total: 0.4 }, { streaming: true }));
  const stats = routeStats(rows);
  const d = stats.find((r) => r.route === "GET /p/:project/api/diagrams/:view");
  assert.deepEqual(
    { n: d.n, p50: d.p50, p95: d.p95, max: d.max, wallP95: d.wallP95, phases: d.phases },
    { n: 20, p50: 10, p95: 19, max: 20, wallP95: 20, phases: ["auth"] },
  );
  const e = stats.find((r) => r.route === "GET /p/:project/api/events");
  assert.deepEqual({ n: e.n, streams: e.streams, p95: e.p95 }, { n: 0, streams: 1, p95: null });
});

test("sampleCoverage: share or slack", () => {
  assert.equal(sampleCoverage({ auth: 0.2, compile: 9, total: 10 }).covered, true); // 92%
  assert.equal(sampleCoverage({ auth: 0.2, total: 1.9 }).covered, true); // 1.7 ms unnamed ≤ 2 ms slack
  assert.equal(sampleCoverage({ auth: 0.2, fs: 3.8, total: 10 }).covered, false); // 40%, 6 ms unnamed
  assert.equal(sampleCoverage({ auth: 1 }), null);
});

test("phaseCoverage passes when phases account for the handler time", () => {
  const rows = Array.from({ length: 10 }, () =>
    s("/p/a/api/notes/diagram?address=x", { auth: 0.2, compile: 9.5, total: 10 }),
  );
  rows.push(s("/p/a/api/bootstrap", { auth: 0.1, total: 0.4 }));
  const c = phaseCoverage(rows);
  assert.equal(c.ok, true);
  assert.deepEqual(c.uncovered, []);
  assert.deepEqual(c.tolerance, { ...COVERAGE });
});

test("phaseCoverage fails a route whose phases cover only 40% of its total", () => {
  const rows = Array.from({ length: 10 }, () =>
    s("/p/a/api/notes/content?path=n.md", { auth: 0.5, fs: 3.5, total: 10 }),
  );
  rows.push(s("/p/a/api/bootstrap", { auth: 0.1, total: 0.4 }));
  const c = phaseCoverage(rows);
  assert.equal(c.ok, false);
  assert.deepEqual(c.uncovered, ["GET /p/:project/api/notes/content?path"]);
  const row = c.routes.find((r) => r.route === "GET /p/:project/api/notes/content?path");
  assert.deepEqual({ coveredShare: row.coveredShare, gapMax: row.gapMax }, { coveredShare: 0, gapMax: 6 });
});

test("phaseCoverage forgives one outlier in ten but not two", () => {
  const good = { auth: 0.1, total: 0.5 },
    bad = { auth: 0.1, total: 30 };
  const one = [...Array(9).fill(good), bad].map((t) => s("/p/a/api/diagrams", t));
  assert.equal(phaseCoverage(one).ok, true);
  const two = [...Array(8).fill(good), bad, bad].map((t) => s("/p/a/api/diagrams", t));
  assert.equal(phaseCoverage(two).ok, false);
});

test("metricsSummary: lag from the last cumulative histogram and the series, CPU per interval, RSS max", () => {
  const loop = (p99, max) => ({ mean: 10, p50: 10.1, p90: 10.2, p99, max });
  const samples = [
    { at: 0, cpuTicks: 100, rssMb: 120, eventLoop: loop(10.5, 11), series: [] },
    { at: 1000, cpuTicks: 150, rssMb: 140, eventLoop: loop(11, 12), series: [{ at: 900, maxMs: 15, p99Ms: 11 }] },
    { at: 2000, cpuTicks: 160, rssMb: 130, eventLoop: loop(12, 13), series: [] },
  ];
  const m = metricsSummary(samples, { clkTck: 100 });
  assert.deepEqual(m.lag, { p50: 10.1, p99: 12, max: 15 });
  assert.deepEqual(m.cpu, { mean: 30, max: 50 }); // 0.5 s and 0.1 s of CPU in 1 s windows
  assert.deepEqual(m.rssMb, { first: 120, max: 140 });
  assert.equal(m.lagOverWarn, false);
});

test("metricsSummary flags lag over the service's warning threshold (a 200 ms block)", () => {
  const samples = [
    {
      at: 0,
      cpuTicks: 0,
      rssMb: 100,
      eventLoop: { mean: 30, p50: 10, p90: 200, p99: 205, max: 210 },
      series: [{ at: 0, maxMs: 210, p99Ms: 205 }],
    },
  ];
  const m = metricsSummary(samples);
  assert.equal(m.lag.max, 210);
  assert.equal(m.lagOverWarn, true);
  assert.ok(m.lag.max > LAG_WARN_MS);
  assert.deepEqual(m.cpu, { mean: null, max: null });
});

test("pairingMetrics and pairsFrom shape runs for the paired estimator; a missing side is counted", () => {
  const run = (p95, lag) =>
    pairingMetrics({
      routes: [{ route: "GET /p/:project/api/diagrams", p50: 1, p95 }],
      metrics: { lag: { p50: 10, p99: lag, max: lag }, cpu: { mean: 5, max: 9 }, rssMb: { first: 100, max: 120 } },
      coldWarm: { compile: { cold: { total: 4 }, warm: { total: 1 } } },
    });
  const a = [run(2, 11), run(3, 12)],
    b = [run(4, 30), { "lag:p99": 31 }];
  assert.equal(a[0]["route:GET /p/:project/api/diagrams:p95"], 2);
  assert.equal(a[0]["compile:cold"], 4);
  assert.deepEqual(pairsFrom(a, b, "route:GET /p/:project/api/diagrams:p95"), { pairs: [{ a: 2, b: 4 }], missing: 1 });
  assert.deepEqual(pairsFrom(a, b, "lag:p99"), {
    pairs: [
      { a: 11, b: 30 },
      { a: 12, b: 31 },
    ],
    missing: 0,
  });
});

test("markdown marks an uncovered route", () => {
  const rows = Array.from({ length: 3 }, () => s("/p/a/api/notes/content?path=n", { auth: 0.5, fs: 3.5, total: 10 }));
  const md = markdown({ routes: routeStats(rows), coverage: phaseCoverage(rows), metrics: metricsSummary([]) });
  assert.match(md, /`GET \/p\/:project\/api\/notes\/content\?path` \| 3 \| 10 \| 10 \| auth, fs \| \*\*FAIL\*\*/);
  assert.match(md, /1 route\(s\) uncovered/);
});

test("dropReplays keeps one sample per service request id (a cached replay repeats the id)", () => {
  const a = s("/-/page-assets/w.js", { auth: 0.2, total: 61 }, { requestId: "x-1" });
  const out = dropReplays([
    a,
    { ...a },
    { ...a },
    s("/p/a/api/bootstrap", { total: 0.2 }, { requestId: "x-2" }),
    s("/p/a/api/bootstrap", { total: 0.2 }),
  ]);
  assert.equal(out.replays, 2);
  assert.equal(out.kept.length, 3);
});

// codex-07: a route without a Server-Timing total disappeared from the coverage, which then passed with zero routes.
test("phaseCoverage: a response without a Server-Timing total is NOT EVALUATED, never a pass with the route left out", () => {
  const vacuous = phaseCoverage([s("/p/awkward/api/authoring", {})]);
  assert.equal(vacuous.ok, false);
  assert.equal(vacuous.verdict, "NOT EVALUATED");
  assert.deepEqual(vacuous.untimed, ["GET /p/:project/api/authoring"]);
  // One untimed sample among covered ones keeps the route NOT EVALUATED.
  const rows = Array.from({ length: 10 }, () => s("/p/a/api/bootstrap", { auth: 0.1, total: 0.4 }));
  assert.equal(phaseCoverage(rows).verdict, "PASS");
  const mixed = phaseCoverage([...rows, s("/p/a/api/bootstrap", { auth: 0.1 })]);
  assert.equal(mixed.verdict, "NOT EVALUATED");
  assert.equal(mixed.routes[0].untimed, 1);
  // An uncovered route still FAILs whatever else is missing; nothing judged at all is NOT EVALUATED.
  assert.equal(
    phaseCoverage([
      ...Array.from({ length: 10 }, () => s("/p/a/api/notes/content?path=n.md", { auth: 0.5, total: 10 })),
      s("/p/a/api/authoring", {}),
    ]).verdict,
    "FAIL",
  );
  assert.equal(phaseCoverage([]).verdict, "NOT EVALUATED");
  assert.equal(phaseCoverage([s("/p/a/api/events", {}, { streaming: true })]).verdict, "NOT EVALUATED");
  assert.match(
    markdown({
      routes: routeStats(vacuous.routes.length ? [s("/p/awkward/api/authoring", {})] : []),
      coverage: vacuous,
      metrics: metricsSummary([]),
    }),
    /NOT EVALUATED/,
  );
});
