// Unused code on first load (performance rubric S2): V8 precise block coverage for the page and its dedicated
// workers (auto-attached before they run a line), and CSS rule usage, reduced to used/unused UTF-8 bytes per
// script and stylesheet. Pure reductions here; the CDP plumbing is in page-load.mjs `--coverage`.

/**
 * The executed ranges of one script from its coverage `functions`: V8 nests block ranges, and the innermost range
 * covering a span decides whether it ran (summing nested blocks would count bytes twice). Returns [[start, end]]
 * in UTF-16 offsets of the script source.
 */
export function usedRanges(functions) {
  const all = functions.flatMap((f) => f.ranges);
  const ends = [...new Set(all.flatMap((r) => [r.startOffset, r.endOffset]))].sort((a, b) => a - b);
  const used = [];
  for (let i = 1; i < ends.length; i++) {
    const a = ends[i - 1],
      b = ends[i];
    let inner = null;
    for (const r of all)
      if (
        r.startOffset <= a &&
        r.endOffset >= b &&
        (inner === null || r.endOffset - r.startOffset < inner.endOffset - inner.startOffset)
      )
        inner = r;
    if (inner && inner.count > 0) {
      const prev = used[used.length - 1];
      if (prev && prev[1] === a) prev[1] = b;
      else used.push([a, b]);
    }
  }
  return used;
}

/** UTF-8 bytes of `source` inside the union of `ranges` (UTF-16 offsets; overlaps counted once). */
export function unionBytes(source, ranges) {
  let end = 0,
    total = 0;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (b > end) total += Buffer.byteLength(source.slice(Math.max(end, a), b));
    end = Math.max(end, b);
  }
  return total;
}

/**
 * Whether V8's report holds the script's top level: a called function whose range spans at least 90% of the
 * source (the script itself, 0 to its end, or an ES module's body). A script that ran always has one. V8 sometimes
 * leaves the top-level entries out of a worker's precise coverage (claude-303): the report then lists only the
 * functions called later, the module body's bytes read as unused (+193.5 KB on the ELK worker, 2,783 functions
 * reported against 11,254) and the sample says nothing about the code.
 */
export function hasTopLevel(source, functions) {
  const length = source.length;
  return functions.some((f) => {
    const r = f.ranges?.[0];
    return r && r.count > 0 && length > 0 && r.endOffset - r.startOffset >= 0.9 * length;
  });
}

/** One script's figures: total, used and unused UTF-8 bytes, and the largest unused block (for the split/keep decision). */
export function scriptCoverage(url, source, functions) {
  const used = usedRanges(functions);
  const total = Buffer.byteLength(source),
    usedBytes = unionBytes(source, used);
  let largest = { bytes: 0, start: 0, end: 0 },
    at = 0;
  for (const [a, b] of [...used, [source.length, source.length]]) {
    if (a > at) {
      const bytes = Buffer.byteLength(source.slice(at, a));
      if (bytes > largest.bytes) largest = { bytes, start: at, end: a };
    }
    at = Math.max(at, b);
  }
  return {
    url,
    totalBytes: total,
    usedBytes,
    unusedBytes: total - usedBytes,
    largestUnused: largest,
    topLevel: hasTopLevel(source, functions),
    functions: functions.length,
  };
}

/** One stylesheet's figures from CSS.stopRuleUsageTracking ruleUsage (used rules only count as used). */
export function styleCoverage(url, text, ruleUsage) {
  const total = Buffer.byteLength(text),
    used = unionBytes(
      text,
      ruleUsage.filter((r) => r.used).map((r) => [r.startOffset, r.endOffset]),
    );
  return { url, totalBytes: total, usedBytes: used, unusedBytes: total - used };
}

/**
 * Totals by kind (main JS, worker JS, CSS) with unused share, for one coverage load. An entry that could not be read
 * (`{url, error}`: a script source, a worker's profiler or a stylesheet's text) is NOT counted as zero bytes: its
 * kind gets `notEvaluated: [url…]` and the summary `complete: false` (codex-04: an error reduced to "0 unused").
 */
export function coverageSummary({ scripts = [], workers = [], styles = [] }) {
  const sum = (list) => {
    const ok = list.filter((x) => !x.error),
      failed = list.filter((x) => x.error);
    const total = ok.reduce((a, x) => a + (x.totalBytes ?? 0), 0),
      unused = ok.reduce((a, x) => a + (x.unusedBytes ?? 0), 0);
    return {
      totalBytes: total,
      unusedBytes: unused,
      unusedShare: total ? Math.round((unused / total) * 1000) / 1000 : null,
      largestUnusedBytes: ok.reduce((a, x) => Math.max(a, x.largestUnused?.bytes ?? 0), 0),
      ...(failed.length ? { notEvaluated: failed.map((x) => `${x.url}: ${x.error}`) } : {}),
    };
  };
  const out = { mainJs: sum(scripts), workerJs: sum(workers), css: sum(styles) };
  const missing = Object.entries(out).flatMap(([k, v]) => (v.notEvaluated ?? []).map((m) => `${k} ${m}`));
  // An invalid sample (claude-303): a worker script whose report has no top level. It is retaken, never counted.
  const invalid = workers
    .filter((x) => !x.error && x.topLevel === false)
    .map(
      (x) =>
        `workerJs ${x.url}: V8 reported no top-level function (${x.functions ?? "?"} functions), an invalid coverage sample`,
    );
  return {
    ...out,
    complete: missing.length === 0 && invalid.length === 0,
    ...(missing.length || invalid.length ? { reasons: [...missing, ...invalid] } : {}),
    ...(invalid.length ? { invalid } : {}),
  };
}

export const COVERAGE_KINDS = ["mainJs", "workerJs", "css"];

/**
 * Counts what the page posts to its dedicated workers during a coverage load (an init script; O216): one record per
 * `postMessage`, `{at, cmd, nodes?, ids?}` with ELK's `cmd` (`layout`) or `nest` for the nested-view channel, and for
 * a layout the graph's top-level children (count and the first ids). The worker's executed bytes follow its work: a
 * build that also lays out the synthetic warm-up graph runs more of the same file (codex-203, claude-203), so a
 * coverage sample carries the messages that explain it. The page's own scripts are untouched otherwise.
 */
export const WORKER_MESSAGES_SCRIPT = `(() => {
  if (typeof Worker !== "function" || Worker.prototype.__perfCounted) return;
  const list = window.__perfWorkerMessages = [];
  const post = Worker.prototype.postMessage;
  Worker.prototype.__perfCounted = true;
  Worker.prototype.postMessage = function (message) {
    try {
      const m = message && typeof message === "object" ? message : null;
      const children = Array.isArray(m?.graph?.children) ? m.graph.children : null;
      if (list.length < 500) list.push({ at: performance.now(), cmd: m ? (m.cmd ?? (m.nest !== undefined ? "nest" : "object")) : typeof message, ...(children ? { nodes: children.length, ids: children.slice(0, 6).map((c) => String(c?.id ?? "")) } : {}) });
    } catch {}
    return post.apply(this, arguments);
  };
})();`;

/** One load's worker messages as a summary: the count, per command, and each layout's top-level size and first ids. */
export function workerMessageSummary(list) {
  if (!Array.isArray(list)) return null;
  const byCmd = {};
  for (const m of list) byCmd[m.cmd] = (byCmd[m.cmd] ?? 0) + 1;
  return {
    count: list.length,
    byCmd,
    layouts: list.filter((m) => m.cmd === "layout").map((m) => ({ nodes: m.nodes ?? null, ids: m.ids ?? [] })),
  };
}

/**
 * A cell's coverage from its samples (rubric §5: max of 3). `samples`: one coverageSummary per run, or
 * `{error}` for a run that failed; `required`: the runs asked for; `minimum`: the design's floor (3 for a rubric
 * collection). Per kind, the sample with the most unused bytes. Complete only with `required` (≥ `minimum`)
 * samples, each complete; otherwise NOT EVALUATED with the reasons (never zero bytes). `retakes`: the invalid
 * samples that were taken again ({run, state, try, reasons}), kept with the cell so a reader sees them.
 */
export function coverageCell(samples, { required = samples.length, minimum = 1, retakes = [] } = {}) {
  const reasons = [];
  samples.forEach((s, i) => {
    if (s.error) reasons.push(`run ${i}: ${s.error}`);
    else if (s.complete === false) reasons.push(...(s.reasons ?? ["incomplete"]).map((r) => `run ${i}: ${r}`));
  });
  if (samples.length < required)
    reasons.push(`${required - samples.length} of ${required} coverage runs left no sample`);
  if (required < minimum) reasons.push(`${required} coverage run(s); the design needs ${minimum} per cell`);
  const good = samples.filter((s) => !s.error && s.complete !== false);
  const summary =
    good.length === 0
      ? null
      : Object.fromEntries(
          COVERAGE_KINDS.map((k) => [
            k,
            good.map((s) => s[k]).reduce((a, b) => (b.unusedBytes > a.unusedBytes ? b : a)),
          ]),
        );
  return {
    verdict: reasons.length ? "NOT EVALUATED" : "complete",
    complete: reasons.length === 0,
    reasons,
    summary,
    ...(retakes.length ? { retakes } : {}),
    perRun: samples.map((s) =>
      s.error
        ? { error: s.error }
        : {
            ...Object.fromEntries(COVERAGE_KINDS.map((k) => [k, s[k]?.unusedBytes ?? null])),
            ...(s.invalid ? { invalid: true } : {}),
            ...(s.workerMessages !== undefined ? { workerMessages: s.workerMessages } : {}),
          },
    ),
  };
}

/** A metric's range over a cell's runs ({min, max, runs, varies}), or null without a numeric value in every run. */
export function runRange(perRun = [], kind) {
  const values = perRun.map((r) => r?.[kind]);
  if (values.length === 0 || values.some((v) => typeof v !== "number") || perRun.some((r) => r?.invalid)) return null;
  return { min: Math.min(...values), max: Math.max(...values), runs: values, varies: new Set(values).size > 1 };
}

/**
 * The A/A control for S2 (O216): the same build, the same input, its runs against each other, per surface × state ×
 * profile and kind. A metric whose runs differ is not deterministic on that cell, so an exact comparison of its max
 * with another build's says nothing about code: coverageChanges reports such a rise NOT EVALUATED with both ranges.
 * `report`: a production perf-report.json. Returns {cells: [{page, state, profile, metric, min, max, runs, varies,
 * workerMessages}], varying: n}.
 */
export function coverageAA(report) {
  const cells = [];
  for (const r of (report?.results ?? []).filter((x) => x.coverage?.perRun)) {
    for (const kind of COVERAGE_KINDS) {
      const range = runRange(r.coverage.perRun, kind);
      cells.push({
        page: r.page,
        state: r.state,
        profile: r.profile ?? "default",
        metric: `${kind}.unusedBytes`,
        ...(range ?? { min: null, max: null, runs: [], varies: null }),
        ...(kind === "workerJs"
          ? { workerMessages: r.coverage.perRun.map((x) => x.workerMessages?.count ?? null) }
          : {}),
      });
    }
  }
  return { cells, varying: cells.filter((c) => c.varies).length };
}
