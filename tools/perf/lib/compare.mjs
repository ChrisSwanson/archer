// Performance gate G4 and the §5 timing estimator (docs/quality/rubrics/performance.md), pure: no I/O, no clock.
//
// Timing half: paired runs of the last release A and the candidate B, the median of the differences B − A with a
// 95% bootstrap percentile interval (seeded, so a report can be re-derived), a floor from an A/A run, the
// sequential sample size (10 pairs, then +5 up to 30) and the confirmation rule (a regression counts only when a
// second paired run on fresh sandboxes repeats it).
// Deterministic half: the ratchet. Per surface × state each counted metric is ≤ the last release or covered by an
// approved PERF-EX exception; a missing value is NOT EVALUATED for that metric, never a pass.
//
// Used by tools/perf/compare.mjs; tested by tools/perf/test/compare.test.mjs.

import { movementKey } from "./vitals.mjs";

/** The rubric's verdict words (§3 "Verdict and evidence status"). */
export const PASS = "PASS";
export const FAIL = "FAIL";
export const NOT_EVALUATED = "NOT EVALUATED";
export const PASS_WITH_EXCEPTIONS = "PASS WITH APPROVED EXCEPTIONS";

/** §5 sample size: start at 10 pairs, add 5 while the interval straddles the floor, stop at 30. */
export const FIRST_PAIRS = 10;
export const PAIR_STEP = 5;
export const MAX_PAIRS = 30;

/**
 * mulberry32: a small seeded 32-bit PRNG. Returns a function giving floats in [0, 1).
 * @param {number} seed any integer; the same seed gives the same sequence
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A 32-bit seed from a string or number (FNV-1a over the string form), so `--seed release-0.10` works too.
 * @param {string|number} value
 * @returns {number}
 */
export function seedOf(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value >>> 0;
  let h = 0x811c9dc5;
  for (const ch of String(value)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Median of numbers (the mean of the middle two for an even count).
 * @param {number[]} values non-empty
 * @returns {number}
 */
export function median(values) {
  const s = [...values].sort((x, y) => x - y),
    mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * @typedef {{a: number, b: number}} Pair one run of A and one of B, back to back
 * @typedef {{n: number, median: number, lo: number, hi: number, resamples: number, seed: number, differences: number[]}} Estimate
 */

/**
 * The §5 statistic: the median of the paired differences B − A with a 95% bootstrap percentile interval.
 * Each resample draws n differences with replacement and takes their median; the bounds are the 2.5th and
 * 97.5th percentiles of the resampled medians (sorted, indices ⌊0.025·R⌋ and ⌈0.975·R⌉ − 1).
 * Deterministic for a given seed. A pair with a non-numeric side is refused: the caller decides what a missing
 * value means (NOT EVALUATED), the estimator never silently drops a pair.
 * @param {Pair[]} pairs at least one
 * @param {{resamples?: number, seed?: string|number}} [options]
 * @returns {Estimate}
 */
export function pairedEstimate(pairs, { resamples = 10000, seed = 1 } = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error("pairedEstimate needs at least one pair");
  const differences = pairs.map((p, i) => {
    if (!finite(p?.a) || !finite(p?.b)) throw new Error(`pair ${i} has a missing or non-numeric side`);
    return p.b - p.a;
  });
  const n = differences.length,
    random = mulberry32(seedOf(seed)),
    medians = new Float64Array(resamples),
    draw = new Array(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) draw[i] = differences[Math.floor(random() * n)];
    medians[r] = median(draw);
  }
  medians.sort();
  const lo = medians[Math.floor(0.025 * resamples)],
    hi = medians[Math.ceil(0.975 * resamples) - 1];
  return { n, median: median(differences), lo, hi, resamples, seed: seedOf(seed), differences };
}

/**
 * The floor from an A/A run (the candidate against itself): the larger magnitude of its interval bounds.
 * @param {{lo: number, hi: number}} aaEstimate
 * @returns {number}
 */
export function floorFromAA(aaEstimate) {
  if (!finite(aaEstimate?.lo) || !finite(aaEstimate?.hi))
    throw new Error("floorFromAA needs an estimate with numeric lo and hi");
  return Math.max(Math.abs(aaEstimate.lo), Math.abs(aaEstimate.hi));
}

/**
 * The §5 verdict of one estimate against a floor.
 * - `regressed`: the lower bound is above the floor (lo > floor).
 * - `improved`: the upper bound is below −floor (hi < −floor).
 * - `straddling`: the interval contains +floor or −floor: more samples could still move it either way.
 * - `not-detected`: the interval lies inside [−floor, +floor]; "not regressed" at this sample size.
 * @param {{lo: number, hi: number}} estimate
 * @param {number} floor ≥ 0
 * @returns {"regressed"|"improved"|"straddling"|"not-detected"}
 */
export function verdict(estimate, floor) {
  if (!finite(floor) || floor < 0) throw new Error("verdict needs a floor ≥ 0");
  const { lo, hi } = estimate;
  if (lo > floor) return "regressed";
  if (hi < -floor) return "improved";
  if ((lo <= floor && floor <= hi) || (lo <= -floor && -floor <= hi)) return "straddling";
  return "not-detected";
}

/**
 * The next sample size while straddling: the next step of 10, 15, 20, 25, 30 above n, or null at the cap.
 * @param {number} n pairs run so far
 * @returns {number|null}
 */
export function nextSampleSize(n) {
  if (n < FIRST_PAIRS) return FIRST_PAIRS;
  if (n >= MAX_PAIRS) return null;
  return Math.min(MAX_PAIRS, FIRST_PAIRS + (Math.floor((n - FIRST_PAIRS) / PAIR_STEP) + 1) * PAIR_STEP);
}

/**
 * One metric's outcome at its sample size: the verdict, whether to run more pairs, and the rubric status.
 * Straddling below the cap asks for `next` pairs; straddling at the cap is `inconclusive`, NOT EVALUATED (§3).
 * A regression is a FAIL candidate only: `confirm` decides whether it stands.
 * @param {Estimate} estimate
 * @param {number|null|undefined} floor null when no A/A floor is known: NOT EVALUATED
 * @returns {{verdict: string, status: string, next: number|null, floor: number|null, reason?: string}}
 */
export function assess(estimate, floor) {
  if (!finite(floor))
    return {
      verdict: "no-floor",
      status: NOT_EVALUATED,
      next: null,
      floor: null,
      reason: "no A/A floor for this metric",
    };
  const v = verdict(estimate, floor);
  if (v === "straddling") {
    const next = nextSampleSize(estimate.n);
    return next === null
      ? {
          verdict: "inconclusive",
          status: NOT_EVALUATED,
          next: null,
          floor,
          reason: `interval still straddles the floor at ${estimate.n} pairs`,
        }
      : { verdict: v, status: "MORE SAMPLES", next, floor };
  }
  return { verdict: v, status: v === "regressed" ? FAIL : PASS, next: null, floor };
}

/**
 * The confirmation rule: a regression is confirmed only when a second paired run on fresh sandboxes repeats it.
 * The same rule is applied to an improvement (the rubric's level 3 asks for "a confirmed improvement").
 * @param {{verdict: string}} first
 * @param {{verdict: string}|null|undefined} second null when no second run was made
 * @returns {{verdict: string, confirmed: boolean, status: string}}
 */
export function confirm(first, second) {
  const a = first?.verdict,
    b = second?.verdict;
  if (a === "regressed" || a === "improved") {
    if (b === undefined)
      return {
        verdict: `candidate ${a === "regressed" ? "regression" : "improvement"}`,
        confirmed: false,
        status: a === "regressed" ? NOT_EVALUATED : PASS,
      };
    if (b === a)
      return {
        verdict: `confirmed ${a === "regressed" ? "regression" : "improvement"}`,
        confirmed: true,
        status: a === "regressed" ? FAIL : PASS,
      };
    return {
      verdict: `unconfirmed ${a === "regressed" ? "regression" : "improvement"} (second run: ${b})`,
      confirmed: false,
      status: b === "inconclusive" || b === "no-floor" ? NOT_EVALUATED : PASS,
    };
  }
  return { verdict: a ?? "missing", confirmed: false, status: a === "not-detected" ? PASS : NOT_EVALUATED };
}

/** S1's "kinds and chain depth ≤ last release" (lib/chain.mjs), through the same ratchet: `ratchet(c, r, {metrics: S1_METRICS})`. */
export const S1_METRICS = ["kinds", "chainDepth"];

/** The ratchet's metrics, as dotted paths into a row. */
export const PHASES = ["document", "boot", "data", "stream", "prefetch", "idle"];
export const RATCHET_METRICS = [
  ...PHASES.map((p) => `byPhase.${p}`),
  "kinds",
  "documentBrBytes",
  "workerBrBytes",
  "distributionBytes.raw",
  "distributionBytes.gzip",
  "distributionBytes.br",
  "domElements",
];

const valueAt = (row, path) =>
  path.split(".").reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), row);
const isCount = (v) => finite(v) && v >= 0;
const listCovers = (list, value) =>
  list === undefined || list === "*" || (Array.isArray(list) && (list.includes("*") || list.includes(value)));

/**
 * @typedef {{page: string, state: string, byPhase?: Record<string, number>, kinds?: number, documentBrBytes?: number,
 *   workerBrBytes?: number, distributionBytes?: {raw?: number, gzip?: number, br?: number}, domElements?: number}} RatchetRow
 * @typedef {{id: string, metric: string, surfaces?: string[]|"*", states?: string[]|"*", profiles?: string[]|"*",
 *   upTo?: number, approval?: {by: string, pr?: string}|string}} PerfException a PERF-EX record (§4): it covers a rise
 *   of `metric` on the named surfaces, states and profiles (all profiles when `profiles` is left out), up to `upTo`
 *   when given, only when it carries the maintainer's approval
 */

/**
 * Whether an exception covers one rise. Unapproved records and ids not shaped PERF-EX-n never cover. A cell without a
 * profile (rows before O214) is `default`.
 * @param {PerfException} ex
 * @param {{page: string, state: string, profile?: string, metric: string, candidate: number}} cell
 */
export function covers(ex, { page, state, profile = "default", metric, candidate }) {
  if (!ex || !/^PERF-EX-\d+$/.test(ex.id ?? "") || !ex.approval) return false;
  if (ex.metric !== metric) return false;
  if (!listCovers(ex.surfaces, page) || !listCovers(ex.states, state) || !listCovers(ex.profiles, profile))
    return false;
  return ex.upTo === undefined || (finite(ex.upTo) && candidate <= ex.upTo);
}

/**
 * The deterministic half of G4: per surface × state, each metric is ≤ the last release or covered by an approved
 * exception. A cell missing on either side, or a non-numeric value, is NOT EVALUATED for that metric.
 * @param {RatchetRow[]} candidateRows
 * @param {RatchetRow[]} releaseRows
 * @param {{exceptions?: PerfException[]}} [options]
 * @returns {{status: string, cells: Array<{page: string, state: string, metric: string, release: number|null,
 *   candidate: number|null, status: string, exception?: string, reason?: string}>, counts: Record<string, number>}}
 */
/**
 * The readiness anchor two rows share, so DOM-at-ready and post-ready shifts compare like with like (codex-02): both
 * rows' `readyAnchors` ({mark?: {domElements, lateShifts}, dom?: {…}}), the mark when both have it, else the DOM
 * predicate's point. Rows without anchors on either side (older packets) compare their `domElements` as before
 * (`legacy`); anchors on one side only, or none in common, give null (NOT EVALUATED).
 */
export function commonAnchor(c, r) {
  const ca = c?.readyAnchors,
    ra = r?.readyAnchors;
  if (!ca && !ra) return { legacy: true };
  if (!ca || !ra) return null;
  for (const name of ["mark", "dom"]) if (ca[name] && ra[name]) return { name, candidate: ca[name], release: ra[name] };
  return null;
}

/**
 * The cells a comparison covers (O214): every surface × state × profile either side has, and every one `expected`
 * names ({pages, states, profiles}), so an omitted profile or surface is a NOT EVALUATED cell, not a cell nobody
 * looked at. A row without `profile` (packets before O214, default profile only) is `default`.
 */
export const cellKey = (r) => `${r.page}\u0000${r.state}\u0000${r.profile ?? "default"}`;
export function cellKeys(candidateKeys, releaseKeys, expected = null) {
  const keys = new Set([...candidateKeys, ...releaseKeys]);
  if (expected)
    for (const page of expected.pages ?? [])
      for (const state of expected.states ?? ["cold", "warm"])
        for (const profile of expected.profiles ?? ["default"]) keys.add(`${page}\u0000${state}\u0000${profile}`);
  return [...keys].sort();
}

/** Metrics a row measures in its loads (not the build's bytes): an incomplete row cannot give them. */
const LOAD_METRIC = (metric) =>
  metric.startsWith("byPhase.") || metric === "kinds" || metric === "domElements" || metric === "chainDepth";

/**
 * Why a row's value for `metric` is not evidence (O214, codex-202): the cell's samples were incomplete
 * (`readiness.complete` false), or for chain depth the dedicated chain loads were (`chainComplete` false, with
 * `chainReasons`). [] when the value can be compared.
 */
export function rowProblems(row, metric) {
  if (!row || !LOAD_METRIC(metric)) return [];
  const out = [];
  if (row.readiness && row.readiness.complete === false)
    out.push(`samples incomplete: ${(row.readiness.reasons ?? []).slice(0, 3).join("; ") || "no reason recorded"}`);
  if (metric === "chainDepth" && row.chainComplete === false)
    out.push(`chain incomplete: ${(row.chainReasons ?? []).slice(0, 3).join("; ") || "no reason recorded"}`);
  return out;
}

/**
 * G4 per request (rubric v2.4 item 2), one phase at the shared anchor: each request (method + manifest pattern) with
 * more reads in `phase` on the candidate than on the release (max of runs) is a rise when the release made no read of
 * it in this load in any phase, or when the candidate made more of it over all phases (checked in every phase holding
 * one of its reads, whatever this phase's max); otherwise it is a read the
 * release made in another phase (`moved`, reported). Returns {rises: [{pattern, candidate, release, why}], moved}.
 */
export function phaseRises(candidate, release, phase) {
  const rises = [],
    moved = [];
  for (const [pattern, phases] of Object.entries(candidate.byRequest).sort(([x], [y]) => x.localeCompare(y))) {
    const cn = phases[phase] ?? 0,
      rn = release.byRequest[pattern]?.[phase] ?? 0;
    const ct = candidate.requestTotals[pattern] ?? 0,
      rt = release.requestTotals[pattern] ?? 0;
    const at = { pattern, candidate: cn, release: rn };
    // More reads in total is a rise in every phase that holds one, even where this phase's max is not above the
    // release's: release runs that spread one read over two phases must not hide a second read (O234, codex-401).
    if (cn > 0 && ct > rt && rt > 0) {
      rises.push({ ...at, why: `${ct} reads over all phases against the release's ${rt}` });
      continue;
    }
    if (cn <= rn) continue;
    if (rt === 0) rises.push({ ...at, why: `a new request (${cn} in ${phase}; the release made none in any phase)` });
    else if (ct > rt) rises.push({ ...at, why: `${ct} reads over all phases against the release's ${rt}` });
    else moved.push({ ...at, releasePhases: release.byRequest[pattern] });
  }
  return { rises, moved };
}

export function ratchet(
  candidateRows,
  releaseRows,
  { exceptions = [], metrics = RATCHET_METRICS, expected = null } = {},
) {
  const index = (rows) => {
    const m = new Map();
    for (const r of rows ?? []) m.set(cellKey(r), r);
    return m;
  };
  const cand = index(candidateRows),
    rel = index(releaseRows);
  const keys = cellKeys(cand.keys(), rel.keys(), expected);
  const cells = [];
  for (const k of keys) {
    const [page, state, profile] = k.split("\u0000"),
      c = cand.get(k),
      r = rel.get(k);
    for (const metric of metrics) {
      const problems = [
        ...rowProblems(c, metric).map((p) => `candidate ${p}`),
        ...rowProblems(r, metric).map((p) => `last release ${p}`),
      ];
      if (c && r && problems.length) {
        cells.push({
          page,
          state,
          profile,
          metric,
          release: null,
          candidate: null,
          status: NOT_EVALUATED,
          reason: problems.join(" | "),
        });
        continue;
      }
      let cv = c ? valueAt(c, metric) : undefined,
        rv = r ? valueAt(r, metric) : undefined,
        anchor = null,
        near = null,
        phased = null;
      // Measured at readiness: the DOM, and the requests by phase (O213), at the anchor both rows have.
      const phase = metric.startsWith("byPhase.") ? metric.slice(8) : null;
      if ((metric === "domElements" || phase) && c && r) {
        const a = commonAnchor(c, r);
        if (a === null) {
          cells.push({
            page,
            state,
            profile,
            metric,
            release: null,
            candidate: null,
            status: NOT_EVALUATED,
            reason: `no common readiness anchor (candidate ${Object.keys(c.readyAnchors ?? {}).join("/") || "none"}, release ${Object.keys(r.readyAnchors ?? {}).join("/") || "none"})`,
          });
          continue;
        }
        if (!a.legacy && phase) {
          if (!a.candidate.byPhase || !a.release.byPhase) {
            cells.push({
              page,
              state,
              profile,
              metric,
              anchor: a.name,
              release: null,
              candidate: null,
              status: NOT_EVALUATED,
              reason: `requests not phased at the common anchor (${a.name}) on the ${!a.candidate.byPhase ? "candidate" : "last release"}`,
            });
            continue;
          }
          cv = a.candidate.byPhase[phase];
          rv = a.release.byPhase[phase];
          anchor = a.name;
          if (phase === "data" || phase === "idle")
            near = { candidate: a.candidate.nearAnchor ?? 0, release: a.release.nearAnchor ?? 0 };
          // Rubric v2.4 item 2: requests by phase compare per request. Rows without per-request phases (collected
          // before v2.4) are NOT EVALUATED, never the bare count.
          const missing = [
            ["candidate", a.candidate],
            ["last release", a.release],
          ]
            .filter(([, x]) => !x.byRequest || !x.requestTotals)
            .map(([who]) => who);
          if (missing.length) {
            cells.push({
              page,
              state,
              profile,
              metric,
              anchor: a.name,
              release: null,
              candidate: null,
              status: NOT_EVALUATED,
              reason: `no per-request phases at the common anchor (${a.name}) on the ${missing.join(" and ")} (collected before rubric v2.4)`,
            });
            continue;
          }
          phased = { perRequest: phaseRises(a.candidate, a.release, phase) };
        } else if (!a.legacy) {
          cv = a.candidate.domElements;
          rv = a.release.domElements;
          anchor = a.name;
        }
      }
      const base = {
        page,
        state,
        profile,
        metric,
        release: isCount(rv) ? rv : null,
        candidate: isCount(cv) ? cv : null,
        ...(anchor ? { anchor } : {}),
        ...(phased ?? {}),
        ...(near && (near.candidate || near.release) ? { readsWithinAFrameOfAnchor: near } : {}),
      };
      if (!c || !r) {
        cells.push({ ...base, status: NOT_EVALUATED, reason: c ? "no last-release row" : "no candidate row" });
        continue;
      }
      if (!isCount(cv) || !isCount(rv)) {
        cells.push({
          ...base,
          status: NOT_EVALUATED,
          reason: `${!isCount(cv) ? "candidate" : "last release"} value missing`,
        });
        continue;
      }
      if (phased) {
        // A phase rises only by a request the release never made in this load, or by more of one than it made.
        const { rises, moved } = phased.perRequest;
        if (rises.length === 0) {
          cells.push({
            ...base,
            status: PASS,
            ...(cv > rv
              ? {
                  reason: `${cv - rv} more at the anchor in this phase, each a request the release made in another phase (${moved.map((m) => m.pattern).join(", ")})`,
                }
              : {}),
          });
          continue;
        }
        const ex = exceptions.find((e) => covers(e, { page, state, profile, metric, candidate: cv }));
        cells.push(
          ex
            ? { ...base, status: PASS_WITH_EXCEPTIONS, exception: ex.id }
            : { ...base, status: FAIL, reason: rises.map((x) => `${x.pattern}: ${x.why}`).join("; ") },
        );
        continue;
      }
      if (cv <= rv) {
        cells.push({ ...base, status: PASS });
        continue;
      }
      const ex = exceptions.find((e) => covers(e, { page, state, profile, metric, candidate: cv }));
      cells.push(
        ex
          ? { ...base, status: PASS_WITH_EXCEPTIONS, exception: ex.id }
          : { ...base, status: FAIL, reason: `rose by ${cv - rv} with no approved exception` },
      );
    }
  }
  const counts = {};
  for (const cell of cells) counts[cell.status] = (counts[cell.status] ?? 0) + 1;
  const status = counts[FAIL]
    ? FAIL
    : counts[NOT_EVALUATED] || cells.length === 0
      ? NOT_EVALUATED
      : counts[PASS_WITH_EXCEPTIONS]
        ? PASS_WITH_EXCEPTIONS
        : PASS;
  return { status, cells, counts };
}

/**
 * S6 "no shift after route-ready that is new since last release", per surface × state at the two rows' common
 * readiness anchor: the candidate's late-shift signatures (vitals.mjs shiftSignature) the release does not have.
 * Identity, not count: the same element shifting after ready on both sides is not new. NOT EVALUATED without a common
 * anchor or a row. Returns {status, cells: [{page, state, anchor, newShifts, status, reason?}]}.
 */
export function lateShiftChanges(candidateRows, releaseRows, { expected = null, releaseControls = [] } = {}) {
  const index = (rows) => new Map((rows ?? []).map((r) => [cellKey(r), r]));
  const cand = index(candidateRows),
    rel = index(releaseRows),
    controls = releaseControls.map(index);
  const cells = cellKeys(cand.keys(), rel.keys(), expected).map((k) => {
    const [page, state, profile] = k.split("\u0000"),
      c = cand.get(k),
      r = rel.get(k),
      at = { page, state, profile };
    if (!c || !r) return { ...at, status: NOT_EVALUATED, reason: c ? "no last-release row" : "no candidate row" };
    const incomplete = [c, r].flatMap((x, i) =>
      x.readiness && x.readiness.complete === false ? [`${i ? "last release" : "candidate"} samples incomplete`] : [],
    );
    if (incomplete.length) return { ...at, status: NOT_EVALUATED, reason: incomplete.join("; ") };
    const a = commonAnchor(c, r);
    if (a === null || a.legacy)
      return {
        ...at,
        status: NOT_EVALUATED,
        reason: a === null ? "no common readiness anchor" : "no readiness anchors recorded",
      };
    // Per element and its geometry (O215), not per browser entry: the same motion attributed with other sources in
    // one entry is the same movement. Rows without element records (packets before O215) cannot be compared so.
    if (!Array.isArray(a.candidate.lateShiftElements) || !Array.isArray(a.release.lateShiftElements))
      return {
        ...at,
        anchor: a.name,
        status: NOT_EVALUATED,
        reason: `no per-element shift records on the ${!Array.isArray(a.candidate.lateShiftElements) ? "candidate" : "last release"} (collected before O215)`,
      };
    // Element identity (O229): a movement compares by its structural path; one recorded without it (rows before O229)
    // cannot be told from another element of its kind moving alike, so the cell is NOT EVALUATED, not matched.
    const unidentified = [...a.candidate.lateShiftElements, ...a.release.lateShiftElements].some(
      (e) => !e.path && e.node !== "(no source)",
    );
    if (a.candidate.lateShiftElements.length && unidentified)
      return {
        ...at,
        anchor: a.name,
        status: NOT_EVALUATED,
        reason:
          "late movements without a structural identity (collected before O229): a bare description can match another element moving alike",
      };
    // Release controls (O228): further collections of the release, at the same anchor, add their late movements to
    // the release's evidence; the packet's own release runs are kept as they are.
    const controlMoves = controls.flatMap((m) => {
      const x = m.get(k)?.readyAnchors?.[a.name]?.lateShiftElements;
      return Array.isArray(x) ? x : [];
    });
    const before = new Set(a.release.lateShiftElements.map(movementKey)),
      inControls = new Set(controlMoves.map(movementKey));
    const unseen = a.candidate.lateShiftElements.filter((e) => !before.has(movementKey(e)));
    const fromControls = [...new Set(unseen.map(movementKey).filter((key) => inControls.has(key)))];
    const fresh = [
      ...new Map(unseen.filter((e) => !inControls.has(movementKey(e))).map((e) => [movementKey(e), e])).values(),
    ];
    // Reported, not scored (O228): a new late movement the release makes too, before its anchor, in some run. The r3
    // note and project-diagrams cells were such: the same elements, the same motion, on either side of the anchor.
    const earlier = Array.isArray(a.release.earlyShiftElements)
      ? new Set(a.release.earlyShiftElements.map(movementKey))
      : null;
    const alsoEarly = earlier ? fresh.map(movementKey).filter((k) => earlier.has(k)) : null;
    return {
      ...at,
      anchor: a.name,
      newShifts: fresh.map(movementKey),
      newMovements: fresh,
      ...(fromControls.length ? { matchedInReleaseControls: fromControls } : {}),
      ...(alsoEarly?.length ? { releaseMakesBeforeAnchor: alsoEarly } : {}),
      status: fresh.length ? FAIL : PASS,
    };
  });
  const status = cells.some((x) => x.status === FAIL)
    ? FAIL
    : cells.length === 0 || cells.some((x) => x.status === NOT_EVALUATED)
      ? NOT_EVALUATED
      : PASS;
  return { status, cells };
}

/**
 * The readiness anchors every run of a cell has (mark, dom), with the max DOM elements and the union of late-shift
 * signatures over the runs (lib/compare.mjs commonAnchor, lateShiftChanges). An anchor some run lacks is left out.
 */
export function anchorsOverRuns(perRun) {
  if (perRun.length === 0 || perRun.some((x) => !x.readyAnchors)) return undefined;
  const names = ["mark", "dom"].filter((n) => perRun.every((x) => x.readyAnchors[n]));
  return Object.fromEntries(
    names.map((n) => {
      const at = perRun.map((x) => x.readyAnchors[n]);
      // Requests by phase at this anchor, the max of the runs per phase (§5), only when every run phased them (O213);
      // `nearAnchor`: the most data/idle reads any run started within a frame of the anchor (reported). Per request
      // (rubric v2.4 item 2), only when every run recorded it: `byRequest`, each request's reads per phase, and
      // `requestTotals`, its reads over all phases, each the max of the runs.
      const perRequest = at.every((a) => a.byRequest && typeof a.byRequest === "object");
      const patterns = perRequest ? [...new Set(at.flatMap((a) => Object.keys(a.byRequest)))].sort() : [];
      const phased = at.every((a) => a.byPhase)
        ? {
            byPhase: Object.fromEntries(
              Object.keys(at[0].byPhase).map((p) => [p, Math.max(...at.map((a) => a.byPhase[p] ?? -Infinity))]),
            ),
            nearAnchor: Math.max(
              ...at.map((a) => (Array.isArray(a.nearAnchor) ? a.nearAnchor.length : (a.nearAnchor ?? 0))),
            ),
            ...(perRequest
              ? {
                  byRequest: Object.fromEntries(
                    patterns.map((pat) => [
                      pat,
                      Object.fromEntries(
                        [...new Set(at.flatMap((a) => Object.keys(a.byRequest[pat] ?? {})))].map((p) => [
                          p,
                          Math.max(...at.map((a) => a.byRequest[pat]?.[p] ?? 0)),
                        ]),
                      ),
                    ]),
                  ),
                  requestTotals: Object.fromEntries(
                    patterns.map((pat) => [
                      pat,
                      Math.max(...at.map((a) => Object.values(a.byRequest[pat] ?? {}).reduce((x, y) => x + y, 0))),
                    ]),
                  ),
                }
              : {}),
          }
        : {};
      // Each element movement seen after the anchor in any run (O215), once per identity; absent unless every run has them.
      const union = (key) =>
        at.every((a) => Array.isArray(a[key]))
          ? {
              [key]: [...new Map(at.flatMap((a) => a[key]).map((e) => [movementKey(e), e])).values()].sort((x, y) =>
                movementKey(x).localeCompare(movementKey(y)),
              ),
            }
          : {};
      const moved = { ...union("lateShiftElements"), ...union("earlyShiftElements") };
      return [
        n,
        {
          domElements: Math.max(...at.map((a) => a.domElements ?? -Infinity)),
          lateShifts: [...new Set(at.flatMap((a) => a.lateShifts ?? []))].sort(),
          ...moved,
          ...phased,
        },
      ];
    }),
  );
}
