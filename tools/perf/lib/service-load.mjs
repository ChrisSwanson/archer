// S9 "Service latency and capacity" (docs/quality/rubrics/performance.md §3 S9, §5, §6 "Concurrency"), pure: no
// I/O, no clock. Used by tools/perf/service-load.mjs; tested by tools/perf/test/service-load.test.mjs.
//
// - routeKey / routeStats: per-route p50/p95 of the service's own `Server-Timing` total (handler time), with the
//   client-observed wall time alongside.
// - phaseCoverage: "each route's Server-Timing phases account for its handler time".
// - metricsSummary: event-loop lag, CPU and RSS over the samples taken during the protocol.
// - pairingMetrics / pairsFrom: flat per-run numbers for the paired estimator in lib/compare.mjs (not the estimator).
import { urlPattern } from "./report.mjs";

/**
 * Coverage tolerance. A sample's named phases (every Server-Timing entry except `total`) cover its handler time when
 * they add up to at least `share` of `total`, or leave at most `slackMs` unnamed. The slack exists because a fast
 * handler's fixed cost (routing, JSON encoding, header writing) is a large share of a 1 ms total and is not worth a
 * phase; 2 ms is under the 10 ms resolution of the service's own event-loop histogram, so anything the slack hides is
 * below what S9 can see elsewhere. A route is covered when at least `minCovered` of its samples are (one GC pause in
 * one sample does not fail a route; a route whose handler is unnamed most of the time does).
 */
export const COVERAGE = Object.freeze({ share: 0.9, slackMs: 2, minCovered: 0.9 });

/**
 * The service's warning threshold for event-loop lag (ts/src/telemetry/telemetry.ts THRESHOLDS.eventLoopLagMs): a
 * single run whose lag max passes it is flagged. Regression itself is the paired estimator's call (§5).
 */
export const LAG_WARN_MS = 100;

/** Segments after `/api/<name>/` that are a view id, not a route name. */
const VIEW_APIS = new Set(["diagrams", "thumbnails", "emphasis", "diagram-source", "walkthroughs"]);

/**
 * Method + URL pattern. `urlPattern` (lib/report.mjs) drops query values and hex/number ids; on top of it a project
 * slug, a view id and a page address become placeholders, so one route is one row however many diagrams a page shows.
 * @param {string} method
 * @param {string} url absolute
 * @returns {string} e.g. `GET /p/:project/api/thumbnails/:view?rev&theme&v`
 */
export function routeKey(method, url) {
  const pattern = urlPattern(url);
  const [path, query] = pattern.split("?");
  const parts = path.split("/");
  if (parts[1] === "p" && parts.length > 2) {
    parts[2] = ":project";
    if (parts[3] === "api" && VIEW_APIS.has(parts[4]) && parts.length > 5 && parts[5] !== "old")
      parts.splice(5, parts.length - 5, ":view");
  } else if (parts[1] === "projects" && parts.length > 3 && parts[2] !== "") {
    parts.splice(2, parts.length - 2, ":project", parts.length > 4 || parts[3] !== "" ? "*" : "");
  } else if (parts[1] === "-" && parts[2] === "page-assets" && parts.length > 3) {
    parts.splice(3, parts.length - 3, ":asset");
  }
  return `${method} ${parts.join("/")}${query ? `?${query}` : ""}`;
}

/**
 * Nearest-rank percentile (the smallest value with at least q of the samples at or below it).
 * @param {number[]} values
 * @param {number} q in (0, 1]
 * @returns {number|null} null for no values
 */
export function percentile(values, q) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

const round = (v, places = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** places) / 10 ** places);

/**
 * @typedef {{method: string, url: string, status?: number, serverTiming: Record<string, number>, wallMs?: number|null,
 *   streaming?: boolean, source?: string}} Sample one response: Server-Timing parsed by lib/report.mjs parseServerTiming
 */

/**
 * Drops responses the browser replayed from its cache: they carry the original response's headers, Server-Timing and
 * `x-archer-request-id` included, so they would count one service request many times. The first sample of each
 * request id is kept; samples without an id are kept.
 * @param {Array<Sample & {requestId?: string|null}>} samples
 * @returns {{kept: Sample[], replays: number}}
 */
export function dropReplays(samples) {
  const seen = new Set(),
    kept = [];
  let replays = 0;
  for (const s of samples) {
    if (s.requestId) {
      if (seen.has(s.requestId)) {
        replays++;
        continue;
      }
      seen.add(s.requestId);
    }
    kept.push(s);
  }
  return { kept, replays };
}

/**
 * Per-route counts and p50/p95 of the Server-Timing `total` (the handler's time to its header) and of the client wall
 * time where known. Streams (text/event-stream) are counted but not timed: their header is written when they open.
 * @param {Sample[]} samples
 * @returns {Array<{route: string, n: number, streams: number, p50: number|null, p95: number|null, max: number|null,
 *   wallP50: number|null, wallP95: number|null, phases: string[]}>} sorted by p95, slowest first
 */
export function routeStats(samples) {
  const by = new Map();
  for (const s of samples) {
    const key = routeKey(s.method, s.url);
    const row = by.get(key) ?? by.set(key, { totals: [], walls: [], streams: 0, phases: new Set() }).get(key);
    if (s.streaming) {
      row.streams++;
      continue;
    }
    if (Number.isFinite(s.serverTiming?.total)) row.totals.push(s.serverTiming.total);
    if (Number.isFinite(s.wallMs)) row.walls.push(s.wallMs);
    for (const name of Object.keys(s.serverTiming ?? {})) if (name !== "total") row.phases.add(name);
  }
  return [...by]
    .map(([route, r]) => ({
      route,
      n: r.totals.length,
      streams: r.streams,
      p50: round(percentile(r.totals, 0.5)),
      p95: round(percentile(r.totals, 0.95)),
      max: round(percentile(r.totals, 1)),
      wallP50: round(percentile(r.walls, 0.5)),
      wallP95: round(percentile(r.walls, 0.95)),
      phases: [...r.phases].sort(),
    }))
    .sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1));
}

/**
 * Whether one sample's named phases account for its total (see COVERAGE).
 * @param {Record<string, number>} serverTiming
 * @param {{share?: number, slackMs?: number}} [tolerance]
 * @returns {{covered: boolean, total: number, named: number, gapMs: number}|null} null when there is no total
 */
export function sampleCoverage(serverTiming, { share = COVERAGE.share, slackMs = COVERAGE.slackMs } = {}) {
  const total = serverTiming?.total;
  if (!Number.isFinite(total)) return null;
  const named = Object.entries(serverTiming)
    .filter(([k, v]) => k !== "total" && Number.isFinite(v))
    .reduce((sum, [, v]) => sum + v, 0);
  const gapMs = Math.max(0, total - named);
  return { covered: gapMs <= slackMs || named >= share * total, total, named, gapMs };
}

/**
 * "Each route's Server-Timing phases account for its handler time" (§3 S9). Per route: the share of its timed
 * samples that are covered, the median and worst unnamed gap, and the verdict. Streams are not judged. A non-stream
 * response without a finite `total` cannot show its phases: its route is listed in `untimed` and the result is NOT
 * EVALUATED, never a pass with that route left out (codex-07); so is a run with no timed sample at all.
 * `verdict`: FAIL when a judged route is uncovered, else NOT EVALUATED when a route is untimed or nothing was
 * judged, else PASS. `ok` is verdict PASS.
 * @param {Sample[]} samples
 * @param {{tolerance?: {share?: number, slackMs?: number, minCovered?: number}}} [options]
 * @returns {{ok: boolean, verdict: "PASS"|"FAIL"|"NOT EVALUATED", tolerance: {share: number, slackMs: number, minCovered: number},
 *   routes: Array<{route: string, n: number, untimed: number, coveredShare: number|null, gapP50: number|null, gapMax: number|null, covered: boolean}>,
 *   uncovered: string[], untimed: string[]}}
 */
export function phaseCoverage(samples, { tolerance = {} } = {}) {
  const t = { ...COVERAGE, ...tolerance };
  const by = new Map();
  for (const s of samples) {
    if (s.streaming) continue;
    const key = routeKey(s.method, s.url);
    const r = by.get(key) ?? by.set(key, { timed: [], untimed: 0 }).get(key);
    const c = sampleCoverage(s.serverTiming, t);
    if (c === null) r.untimed++;
    else r.timed.push(c);
  }
  const routes = [...by]
    .map(([route, { timed: list, untimed }]) => {
      const coveredShare = list.length ? list.filter((c) => c.covered).length / list.length : null;
      const gaps = list.map((c) => c.gapMs);
      return {
        route,
        n: list.length,
        untimed,
        coveredShare: coveredShare === null ? null : round(coveredShare, 2),
        gapP50: list.length ? round(percentile(gaps, 0.5)) : null,
        gapMax: list.length ? round(percentile(gaps, 1)) : null,
        covered: untimed === 0 && coveredShare !== null && coveredShare >= t.minCovered,
      };
    })
    .sort((a, b) => (b.gapMax ?? 0) - (a.gapMax ?? 0));
  const uncovered = routes.filter((r) => r.n > 0 && r.coveredShare < t.minCovered).map((r) => r.route);
  const untimed = routes.filter((r) => r.untimed > 0).map((r) => r.route);
  const verdict = uncovered.length ? "FAIL" : untimed.length || routes.length === 0 ? "NOT EVALUATED" : "PASS";
  return { ok: verdict === "PASS", verdict, tolerance: t, routes, uncovered, untimed };
}

/**
 * @typedef {{at: number, cpuTicks?: number|null, rssMb?: number|null,
 *   eventLoop?: {mean: number, p50: number, p90: number, p99: number, max: number}|null,
 *   series?: Array<{at: number, maxMs: number, p99Ms: number}>}} MetricsSample
 *   one sample: wall time (ms), the service process's utime+stime (clock ticks, /proc/<pid>/stat), its RSS, and
 *   `/-/debug/metrics` eventLoop.delayMs (cumulative since the protocol's reset) and eventLoop.series
 */

/**
 * Event-loop lag, CPU and RSS over the protocol window. Lag p50/p99 come from the service's cumulative histogram at
 * the last sample (the whole window, since the reset at its start); lag max is the larger of that histogram's max and
 * the worst 5 s series entry inside the window. CPU % is per interval between consecutive samples (100 = one core).
 * @param {MetricsSample[]} samples in time order
 * @param {{clkTck?: number, from?: number}} [options] clkTck: clock ticks per second (getconf CLK_TCK); from: window start
 * @returns {{n: number, lag: {p50: number|null, p99: number|null, max: number|null}, cpu: {mean: number|null, max: number|null},
 *   rssMb: {first: number|null, max: number|null}, lagOverWarn: boolean}}
 */
export function metricsSummary(samples, { clkTck = 100, from = -Infinity } = {}) {
  const list = samples.filter((s) => s.at >= from);
  const last = [...list].reverse().find((s) => s.eventLoop) ?? null;
  const seriesMax = Math.max(
    -Infinity,
    ...list.flatMap((s) => (s.series ?? []).filter((e) => e.at >= from).map((e) => e.maxMs)),
  );
  const lagMax = last ? Math.max(last.eventLoop.max, seriesMax) : Number.isFinite(seriesMax) ? seriesMax : null;
  const cpu = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1],
      b = list[i];
    if (!Number.isFinite(a.cpuTicks) || !Number.isFinite(b.cpuTicks) || b.at <= a.at) continue;
    cpu.push(((b.cpuTicks - a.cpuTicks) / clkTck / ((b.at - a.at) / 1000)) * 100);
  }
  const rss = list.map((s) => s.rssMb).filter(Number.isFinite);
  return {
    n: list.length,
    lag: { p50: round(last?.eventLoop.p50 ?? null), p99: round(last?.eventLoop.p99 ?? null), max: round(lagMax) },
    cpu: {
      mean: round(cpu.length ? cpu.reduce((x, y) => x + y, 0) / cpu.length : null),
      max: round(cpu.length ? Math.max(...cpu) : null),
    },
    rssMb: { first: round(rss[0] ?? null), max: round(rss.length ? Math.max(...rss) : null) },
    lagOverWarn: lagMax !== null && lagMax > LAG_WARN_MS,
  };
}

/**
 * One run's numbers as a flat map for the paired estimator (lib/compare.mjs pairedEstimate takes [{a, b}]): per route
 * p50/p95, lag, CPU, RSS and the compile/thumbnail cold/warm totals. A metric missing from a run is absent, never 0.
 * @param {{routes: ReturnType<typeof routeStats>, metrics: ReturnType<typeof metricsSummary>,
 *   coldWarm?: Record<string, {cold?: {total?: number}|null, warm?: {total?: number}|null}>}} run
 * @returns {Record<string, number>} keys like `route:GET /p/:project/api/diagrams/:view:p95`, `lag:p99`, `cpu:mean`
 */
export function pairingMetrics({ routes, metrics, coldWarm = {} }) {
  const out = {};
  const put = (key, v) => {
    if (Number.isFinite(v)) out[key] = v;
  };
  for (const r of routes) {
    put(`route:${r.route}:p50`, r.p50);
    put(`route:${r.route}:p95`, r.p95);
  }
  put("lag:p50", metrics.lag.p50);
  put("lag:p99", metrics.lag.p99);
  put("lag:max", metrics.lag.max);
  put("cpu:mean", metrics.cpu.mean);
  put("cpu:max", metrics.cpu.max);
  put("rss:max", metrics.rssMb.max);
  for (const [name, cw] of Object.entries(coldWarm)) {
    put(`${name}:cold`, cw.cold?.total);
    put(`${name}:warm`, cw.warm?.total);
  }
  return out;
}

/**
 * Pairs for one metric from runs of A and B made back to back (run i of A with run i of B). A pair with either side
 * missing is left out and counted, so the caller can call the cell NOT EVALUATED.
 * @param {Array<Record<string, number>>} runsA pairingMetrics of each A run
 * @param {Array<Record<string, number>>} runsB pairingMetrics of each B run
 * @param {string} key
 * @returns {{pairs: Array<{a: number, b: number}>, missing: number}}
 */
export function pairsFrom(runsA, runsB, key) {
  const pairs = [];
  let missing = 0;
  for (let i = 0; i < Math.min(runsA.length, runsB.length); i++) {
    const a = runsA[i]?.[key],
      b = runsB[i]?.[key];
    if (Number.isFinite(a) && Number.isFinite(b)) pairs.push({ a, b });
    else missing++;
  }
  return { pairs, missing };
}

/**
 * The short report: route table with coverage, then metrics and cold/warm.
 * @param {{routes: ReturnType<typeof routeStats>, coverage: ReturnType<typeof phaseCoverage>,
 *   metrics: ReturnType<typeof metricsSummary>, coldWarm?: Record<string, any>, header?: string[]}} report
 * @returns {string}
 */
export function markdown({ routes, coverage, metrics, coldWarm = {}, header = [] }) {
  const cov = new Map(coverage.routes.map((r) => [r.route, r]));
  const lines = [
    ...header,
    "",
    "| route | n | p50 ms | p95 ms | phases | phase coverage |",
    "|---|---:|---:|---:|---|---|",
  ];
  for (const r of routes) {
    const c = cov.get(r.route);
    const untimed = c?.untimed ? `; **${c.untimed} without a Server-Timing total: NOT EVALUATED**` : "";
    const cell =
      r.n === 0 && !c
        ? `stream ×${r.streams}`
        : c && c.n > 0
          ? `${c.covered ? "ok" : c.coveredShare < coverage.tolerance.minCovered ? "**FAIL**" : "NOT EVALUATED"} (${Math.round(c.coveredShare * 100)}%, gap max ${c.gapMax} ms${untimed})`
          : c
            ? `**NOT EVALUATED** (${c.untimed} without a Server-Timing total)`
            : "—";
    lines.push(
      `| \`${r.route}\` | ${r.n} | ${r.p50 ?? "—"} | ${r.p95 ?? "—"} | ${r.phases.join(", ") || "—"} | ${cell} |`,
    );
  }
  lines.push(
    "",
    `Phase coverage: ${coverage.verdict ?? (coverage.ok ? "PASS" : "FAIL")}: ${coverage.ok ? "every route covered" : [coverage.uncovered.length ? `${coverage.uncovered.length} route(s) uncovered` : null, coverage.untimed?.length ? `${coverage.untimed.length} route(s) without a Server-Timing total (${coverage.untimed.join(", ")})` : null, coverage.routes.length === 0 ? "no timed route" : null].filter(Boolean).join("; ")} (named phases ≥ ${coverage.tolerance.share * 100}% of total or ≤ ${coverage.tolerance.slackMs} ms unnamed, in ≥ ${coverage.tolerance.minCovered * 100}% of samples).`,
  );
  lines.push(
    "",
    "| metric | value |",
    "|---|---:|",
    `| event-loop lag p50 / p99 / max (ms) | ${metrics.lag.p50} / ${metrics.lag.p99} / ${metrics.lag.max}${metrics.lagOverWarn ? ` **over ${LAG_WARN_MS}**` : ""} |`,
    `| CPU % mean / max (one core = 100) | ${metrics.cpu.mean} / ${metrics.cpu.max} |`,
    `| RSS MB first / max | ${metrics.rssMb.first} / ${metrics.rssMb.max} |`,
    `| metrics samples | ${metrics.n} |`,
  );
  if (Object.keys(coldWarm).length) {
    lines.push("", "| cold/warm | cold total ms (phases) | warm total ms (phases) |", "|---|---|---|");
    const fmt = (x) =>
      x
        ? `${x.total} (${
            Object.entries(x.phases ?? {})
              .map(([k, v]) => `${k} ${v}`)
              .join(", ") || "—"
          })`
        : "—";
    for (const [name, cw] of Object.entries(coldWarm)) lines.push(`| ${name} | ${fmt(cw.cold)} | ${fmt(cw.warm)} |`);
  }
  return lines.join("\n") + "\n";
}
