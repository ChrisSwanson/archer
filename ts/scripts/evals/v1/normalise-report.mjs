// aev-canary-5d1f8e02b7c4 (judge.mjs CANARY: an evaluated agent that reads this file is caught)
// Pools the normalisation runs (ticket 06 §5) of a baseline and a comparison campaign (eval.mjs results
// folders), tests each rate with Fisher's exact test, and writes the committed record.
//
//   node ts/scripts/evals/v1/normalise-report.mjs --baseline <results dir> --compare <results dir> [--agent sonnet]
//        [--json docs/evaluations/baseline/normalisation.json] [--markdown <file>] [--before <name>] [--after <name>] [--about <text>]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CANARY } from "./judge.mjs";

// ---- pure parts (tested in ts/test/evals/normalise-tasks.test.ts)

const logFactorial = (() => {
  const cache = [0];
  return (n) => {
    for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1] + Math.log(i);
    return cache[n];
  };
})();
const hyper = (a, b, c, d) =>
  Math.exp(
    logFactorial(a + b) +
      logFactorial(c + d) +
      logFactorial(a + c) +
      logFactorial(b + d) -
      logFactorial(a + b + c + d) -
      logFactorial(a) -
      logFactorial(b) -
      logFactorial(c) -
      logFactorial(d),
  );

/**
 * Fisher's exact test on [[a, b], [c, d]] (rows: before, after; columns: yes, no). `two`: two-sided (every
 * table at most as likely as the observed one); `greater`: one-sided, P(after's yes count this high or higher).
 */
export function fisher(a, b, c, d) {
  const row1 = a + b,
    col1 = a + c,
    n = a + b + c + d;
  const lo = Math.max(0, col1 - (n - row1)),
    hi = Math.min(row1, col1);
  const observed = hyper(a, b, c, d);
  let two = 0,
    less = 0;
  for (let x = lo; x <= hi; x++) {
    const p = hyper(x, row1 - x, col1 - x, n - row1 - col1 + x);
    if (p <= observed * (1 + 1e-7)) two += p;
    if (x <= a) less += p; // before's yes as low as observed or lower = after's as high or higher
  }
  return { two: Math.min(1, two), greater: Math.min(1, less) };
}

export const median = (values) => {
  const v = values.filter((x) => typeof x === "number").sort((x, y) => x - y);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const round = (x, digits = 2) => (x === null || x === undefined ? null : Math.round(x * 10 ** digits) / 10 ** digits);
const rate = (yes, n) => ({ yes, n, rate: n ? round(yes / n, 3) : null });

/** Tasks with seeded ids to reuse (T2, the control, has none: its ids are free and `queue` is no drift there). */
export const SEEDED_TASKS = [
  "norm-context",
  "norm-component-from-code",
  "norm-extend",
  "norm-flow-over-existing",
  "norm-refactor",
];
/** Tasks whose reuse ratio ticket 06 §5 pools (T1, T3, T4, T5). */
export const REUSE_TASKS = ["norm-context", "norm-component-from-code", "norm-extend", "norm-flow-over-existing"];

/** One side's pooled measures over its runs (results.json `runs` of the normalisation tasks). */
export function pool(runs) {
  const m = (r) => r.measures ?? {};
  const judged = runs.filter((r) => r.verdict !== "error");
  const written = judged.filter((r) => m(r).written > 0);
  const linted = written.filter((r) => m(r).zeroFindings !== null && m(r).zeroFindings !== undefined);
  const seeded = written.filter((r) => SEEDED_TASKS.includes(r.task));
  const reuse = written.filter((r) => REUSE_TASKS.includes(r.task));
  const c4Views = written.flatMap((r) => (m(r).views ?? []).filter((v) => v.family === "c4"));
  const seen = linted.filter((r) => m(r).findingsSeen > 0);
  const tokens = (key) => median(judged.map((r) => r.usage?.tokens?.[key]));
  const byLevel = {};
  for (const v of written.flatMap((r) => m(r).words ?? [])) (byLevel[v.level] ??= []).push(v.words);
  return {
    runs: runs.length,
    errors: runs.length - judged.length,
    verdicts: {
      pass: judged.filter((r) => r.verdict === "pass").length,
      partial: judged.filter((r) => r.verdict === "partial").length,
      fail: judged.filter((r) => r.verdict === "fail").length,
      contaminated: judged.filter((r) => r.verdict === "contaminated").length,
    },
    pass: rate(judged.filter((r) => r.verdict === "pass").length, judged.length),
    passOrPartial: rate(judged.filter((r) => r.verdict === "pass" || r.verdict === "partial").length, judged.length),
    zeroFindings: rate(linted.filter((r) => m(r).zeroFindings).length, linted.length),
    findingsPerRun: {
      mean: round(linted.reduce((n, r) => n + m(r).findings, 0) / (linted.length || 1)),
      median: median(linted.map((r) => m(r).findings)),
    },
    noDrift: rate(seeded.filter((r) => m(r).drift.length === 0).length, seeded.length),
    noHomonym: rate(seeded.filter((r) => m(r).homonyms.length === 0).length, seeded.length),
    fullReuse: rate(
      reuse.filter((r) => m(r).reused === m(r).expected && m(r).homonyms.length === 0).length,
      reuse.length,
    ),
    reuseRatio: {
      reused: reuse.reduce((n, r) => n + m(r).reused, 0),
      expected: reuse.reduce((n, r) => n + m(r).expected, 0),
    },
    c4NotMixed: rate(c4Views.filter((v) => !v.mixed).length, c4Views.length),
    c4InBand: rate(c4Views.filter((v) => v.inBand).length, c4Views.length),
    fixPass: rate(seen.filter((r) => m(r).findings === 0).length, seen.length),
    findingsSeenRuns: rate(seen.length, linted.length),
    wordsMedian: Object.fromEntries(
      Object.entries(byLevel)
        .sort()
        .map(([level, w]) => [level, median(w)]),
    ),
    cost: {
      secondsMedian: round(median(judged.map((r) => r.usage?.seconds ?? r.seconds)), 1),
      secondsMean: round(
        judged.reduce((n, r) => n + (r.usage?.seconds ?? r.seconds ?? 0), 0) / (judged.length || 1),
        1,
      ),
      usdMedian: round(median(judged.map((r) => r.usage?.costUsd)), 3),
      usdTotal: round(
        judged.reduce((n, r) => n + (r.usage?.costUsd ?? 0), 0),
        2,
      ),
      turnsMedian: median(judged.map((r) => r.usage?.turns)),
      toolCallsMedian: median(judged.map((r) => r.toolCalls)),
      archerCallsMedian: median(judged.map((r) => r.archerCalls)),
      tokensMedian: {
        input: tokens("input_tokens"),
        output: tokens("output_tokens"),
        cacheRead: tokens("cache_read_input_tokens"),
        cacheCreation: tokens("cache_creation_input_tokens"),
      },
    },
  };
}

/** The rates ticket 06 §5 tests, before against after; `better` says which way is an improvement. */
export const TESTED = [
  ["zeroFindings", "zero lint findings left (runs)"],
  ["noDrift", "no drifted alias (runs, seeded tasks)"],
  ["fullReuse", "every seeded element by its id, no homonym (runs, T1 T3 T4 T5)"],
  ["noHomonym", "no seeded id on something else (runs, seeded tasks)"],
  ["c4NotMixed", "C4 views not mixing levels (views)"],
  ["c4InBand", "C4 views within 10 / 15 / 12 (views)"],
  ["pass", "runs passing every check"],
  ["passOrPartial", "runs passing every must check"],
];

export function tests(before, after) {
  return TESTED.map(([key, label]) => {
    const b = before[key],
      a = after[key];
    const p = fisher(b.yes, b.n - b.yes, a.yes, a.n - a.yes);
    return {
      measure: key,
      label,
      before: b,
      after: a,
      delta: a.rate !== null && b.rate !== null ? round(a.rate - b.rate, 3) : null,
      pTwoSided: round(p.two, 4),
      pImproved: round(p.greater, 4),
    };
  });
}

/** Per task × side: verdicts and the run-level rates, to say where to look. */
export function perTask(runs) {
  const out = {};
  for (const task of [...new Set(runs.map((r) => r.task))].sort()) {
    const mine = runs.filter((r) => r.task === task);
    const p = pool(mine);
    const misses = {};
    for (const r of mine) for (const miss of r.misses ?? []) misses[miss] = (misses[miss] ?? 0) + 1;
    out[task] = {
      runs: mine.length,
      verdicts: p.verdicts,
      zeroFindings: p.zeroFindings,
      noDrift: p.noDrift,
      fullReuse: p.fullReuse,
      c4NotMixed: p.c4NotMixed,
      c4InBand: p.c4InBand,
      secondsMedian: p.cost.secondsMedian,
      usdMedian: p.cost.usdMedian,
      misses,
    };
  }
  return out;
}

/** The sides' names in the tables, and the record's `about`, as the 2026-11-04 campaign had them (--before, --after, --about). */
const DEFAULT_LABELS = { baseline: "0.11.0", compare: "Expand" };
const DEFAULT_ABOUT =
  "Normalisation evals, cut down for v1 (decided 2026-11-04): one model, T1–T6, baseline = the released 0.11.0 package, comparison = the Expand build; both judged by the comparison build's compiler and lint. A pre-change baseline and its comparison, not a full campaign.";
const pct = (r) => (r.rate === null ? "-" : `${r.yes}/${r.n} (${Math.round(r.rate * 100)}%)`);
export function markdown(record) {
  const { baseline: before, compare: after } = record.labels ?? DEFAULT_LABELS;
  const lines = [
    `| Measure | Before (${before}) | After (${after}) | Δ | Fisher p (two-sided) | p (improved, one-sided) |`,
    "|---|---|---|---|---|---|",
  ];
  for (const t of record.tests)
    lines.push(
      `| ${t.label} | ${pct(t.before)} | ${pct(t.after)} | ${t.delta === null ? "-" : `${t.delta > 0 ? "+" : ""}${Math.round(t.delta * 100)} pt`} | ${t.pTwoSided} | ${t.pImproved} |`,
    );
  const s = record.sides;
  lines.push(
    "",
    "| Also measured | Before | After |",
    "|---|---|---|",
    `| id reuse ratio (T1 T3 T4 T5) | ${s.baseline.reuseRatio.reused}/${s.baseline.reuseRatio.expected} | ${s.compare.reuseRatio.reused}/${s.compare.reuseRatio.expected} |`,
    `| lint findings per run, mean (median) | ${s.baseline.findingsPerRun.mean} (${s.baseline.findingsPerRun.median}) | ${s.compare.findingsPerRun.mean} (${s.compare.findingsPerRun.median}) |`,
    `| runs shown findings by a tool result | ${pct(s.baseline.findingsSeenRuns)} | ${pct(s.compare.findingsSeenRuns)} |`,
    `| fix pass (seen > 0, none left) | ${pct(s.baseline.fixPass)} | ${pct(s.compare.fixPass)} |`,
    `| words per diagram, median by level | ${JSON.stringify(s.baseline.wordsMedian)} | ${JSON.stringify(s.compare.wordsMedian)} |`,
    `| seconds per run, median (mean) | ${s.baseline.cost.secondsMedian} (${s.baseline.cost.secondsMean}) | ${s.compare.cost.secondsMedian} (${s.compare.cost.secondsMean}) |`,
    `| USD per run, median (total) | ${s.baseline.cost.usdMedian} (${s.baseline.cost.usdTotal}) | ${s.compare.cost.usdMedian} (${s.compare.cost.usdTotal}) |`,
    `| turns / tool calls / Archer calls, median | ${s.baseline.cost.turnsMedian} / ${s.baseline.cost.toolCallsMedian} / ${s.baseline.cost.archerCallsMedian} | ${s.compare.cost.turnsMedian} / ${s.compare.cost.toolCallsMedian} / ${s.compare.cost.archerCallsMedian} |`,
    `| tokens per run, median: output / cache read / cache write / input | ${Object.values({ o: s.baseline.cost.tokensMedian.output, r: s.baseline.cost.tokensMedian.cacheRead, w: s.baseline.cost.tokensMedian.cacheCreation, i: s.baseline.cost.tokensMedian.input }).join(" / ")} | ${Object.values({ o: s.compare.cost.tokensMedian.output, r: s.compare.cost.tokensMedian.cacheRead, w: s.compare.cost.tokensMedian.cacheCreation, i: s.compare.cost.tokensMedian.input }).join(" / ")} |`,
  );
  lines.push(
    "",
    "| Task | Before p/p/f | After p/p/f | Zero findings before → after | No drift before → after |",
    "|---|---|---|---|---|",
  );
  for (const task of Object.keys(record.tasks.compare)) {
    const b = record.tasks.baseline[task],
      a = record.tasks.compare[task];
    const v = (x) => (x ? `${x.verdicts.pass}/${x.verdicts.partial}/${x.verdicts.fail}` : "-");
    lines.push(
      `| ${task} | ${v(b)} | ${v(a)} | ${b ? pct(b.zeroFindings) : "-"} → ${pct(a.zeroFindings)} | ${b ? pct(b.noDrift) : "-"} → ${pct(a.noDrift)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

// ---- the command

function side(dir, agent) {
  const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
  const runs = results.runs.filter((r) => r.agent === agent && r.task.startsWith("norm-"));
  const { install: _install, ...meta } = results.meta;
  return { meta: { ...meta, package: { sha256: meta.package?.sha256 } }, runs };
}

async function main() {
  const { values } = parseArgs({
    options: {
      baseline: { type: "string" },
      compare: { type: "string" },
      agent: { type: "string" },
      json: { type: "string" },
      markdown: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      about: { type: "string" },
    },
  });
  // A run as the record keeps it: a contamination note names paths on the run host, so only its count;
  // of Claude's usage, the turns, cost, time and four token counts.
  const kept = ({ agent: _a, misses: _m, contamination, usage, ...r }) => ({
    ...r,
    ...(usage
      ? {
          usage: {
            turns: usage.turns,
            costUsd: usage.costUsd,
            seconds: usage.seconds,
            tokens:
              usage.tokens &&
              Object.fromEntries(
                ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].map((k) => [
                  k,
                  usage.tokens[k],
                ]),
              ),
          },
        }
      : {}),
    ...(contamination ? { contamination: contamination.length } : {}),
  });
  const agent = values.agent ?? "sonnet";
  const before = side(resolve(values.baseline), agent),
    after = side(resolve(values.compare), agent);
  const sides = { baseline: pool(before.runs), compare: pool(after.runs) };
  const record = {
    canary: CANARY,
    about: values.about ?? DEFAULT_ABOUT,
    agent,
    labels: { baseline: values.before ?? DEFAULT_LABELS.baseline, compare: values.after ?? DEFAULT_LABELS.compare },
    meta: { baseline: before.meta, compare: after.meta },
    sides,
    tests: tests(sides.baseline, sides.compare),
    tasks: { baseline: perTask(before.runs), compare: perTask(after.runs) },
    runs: { baseline: before.runs.map(kept), compare: after.runs.map(kept) },
  };
  record.sha256 = createHash("sha256").update(JSON.stringify(record.runs)).digest("hex");
  // One run per line: the record stays readable and its diff small.
  const { runs, sha256, ...head } = record;
  const lines = (list) => list.map((r) => "    " + JSON.stringify(r)).join(",\n");
  if (values.json)
    writeFileSync(
      resolve(values.json),
      JSON.stringify(head, null, 2).replace(
        /\n}$/,
        `,\n  "runs": {\n  "baseline": [\n${lines(runs.baseline)}\n  ],\n  "compare": [\n${lines(runs.compare)}\n  ]\n  },\n  "sha256": "${sha256}"\n}\n`,
      ),
    );
  const md = markdown(record);
  if (values.markdown) writeFileSync(resolve(values.markdown), md);
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
