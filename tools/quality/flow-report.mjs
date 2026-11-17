#!/usr/bin/env node
// The user-flows §5 metrics table (docs/quality/rubrics/user-flows.md §5, §3 U2), from flows/run.mjs output.
//
//   node tools/quality/flow-report.mjs --run <flows.json> [--run …] [--baseline <report.json>] [--out <report.json>] [--json]
//
// Rows: every §5 metric, per journey (× cell where the metric is per cell: completion and U2). Each row says its value, the baseline's,
// and its comparison: "baseline set" when no baseline packet is given (the first round, §5), "ratchet FAIL" when a
// ratcheted metric got worse, else "same"/"better"/"worse" for compared ones. A metric whose collector this run does
// not have, or a cell that was not run, is NOT EVALUATED with the reason, never a blank or a zero.
//
// U2 is judged against each journey's pinned trace (meta.flow.baseline, carried in flows.json): more overhead actions
// than pinned is a ratchet failure in any round. Exit code 1 when any ratchet fails.
//
// --out writes the report as JSON; that file is the next round's --baseline.
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "archer-flow-report/1";
const NE = "NOT EVALUATED";

/** Merge flows.json files: a later file's journey×cell replaces an earlier one's (a rerun). */
export function mergeRuns(files) {
  const cells = new Map();
  const journeys = new Map();
  for (const f of files)
    for (const j of f.journeys ?? []) {
      journeys.set(j.id, { id: j.id, name: j.name, baseline: j.baseline });
      for (const c of j.cells) cells.set(`${j.id}\0${c.id}`, { journey: j.id, ...c });
    }
  return { journeys: [...journeys.values()], cells: [...cells.values()] };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
/** A run's collector checks ({gate, boundary, ok}): carried in flows.json by run.mjs, else read from its summary.json. */
const checksOf = (run) => {
  if (Array.isArray(run.flowChecks)) return run.flowChecks;
  try {
    return (JSON.parse(readFileSync(run.summary, "utf8")).flowState?.checks ?? []).map((c) => ({
      gate: c.gate,
      boundary: c.boundary,
      ok: c.ok,
    }));
  } catch {
    return [];
  }
};

/** Compare `now` with `base` for a metric where lower is better. */
function compare(now, base, { ratcheted, baselineSet }) {
  if (baselineSet) return "baseline set";
  if (base === undefined || base === null) return "no baseline value";
  if (now === base) return "same";
  if (now < base) return "better";
  return ratcheted ? "ratchet FAIL" : "worse";
}

/** The §5 table. `baseline`: an earlier report (its rows by key), or null in the first round. */
export function buildReport(merged, baseline = null) {
  const baselineSet = baseline === null;
  const base = new Map((baseline?.rows ?? []).map((r) => [r.key, r]));
  const rows = [];
  const add = (r) => {
    const b = base.get(r.key);
    const comparison =
      r.verdict === NE
        ? NE
        : (r.comparison ??
          (typeof r.value === "number"
            ? compare(r.value, b?.value, { ratcheted: r.ratcheted, baselineSet })
            : baselineSet
              ? "baseline set"
              : b === undefined
                ? "no baseline value"
                : JSON.stringify(b.value) === JSON.stringify(r.value)
                  ? "same"
                  : r.ratcheted && b.value === "pass"
                    ? "ratchet FAIL"
                    : "changed"));
    rows.push({ ...r, baseline: b?.value ?? null, comparison });
  };
  for (const j of merged.journeys) {
    const cells = merged.cells.filter((c) => c.journey === j.id);
    // Journey completion: per cell; ratcheted (a cell that passed in the baseline must pass).
    for (const c of cells) {
      if (c.verdict === NE)
        add({
          key: `completion ${j.id} ${c.id}`,
          metric: "Journey completion",
          journey: j.id,
          cell: c.id,
          verdict: NE,
          reason: c.reason,
          ratcheted: true,
        });
      else
        add({
          key: `completion ${j.id} ${c.id}`,
          metric: "Journey completion",
          journey: j.id,
          cell: c.id,
          value: c.verdict === "PASS" ? "pass" : "fail",
          runs: c.runs.length,
          stable: c.stable,
          ...(c.stabilityReason ? { reason: c.stabilityReason } : {}),
          ratcheted: true,
        });
    }
    const ran = cells.filter((c) => c.verdict !== NE && c.runs.length);
    const first = ran[0]?.runs[0]?.flow ?? null;
    // Success level: reviewer grading, outside this tool.
    add({
      key: `success ${j.id}`,
      metric: "Success level",
      journey: j.id,
      verdict: NE,
      reason: "reviewer log (manual, §6 levels)",
    });
    if (first === null) {
      add({
        key: `actions ${j.id}`,
        metric: "Actions by class",
        journey: j.id,
        verdict: NE,
        reason: "no cell ran (see Journey completion)",
      });
      add({ key: `agent-ops ${j.id}`, metric: "Agent operations", journey: j.id, verdict: NE, reason: "no cell ran" });
    } else {
      const cmp = first.comparison;
      // U2 vs the pinned trace, in every round: one row per cell that ran (its run 1), so the phone and queued cells
      // are judged too, each against its own pinned trace (PC-11: only the first cell was).
      for (const c of ran) {
        const f = c.runs[0]?.flow;
        if (!f) {
          add({
            key: `u2 ${j.id} ${c.id}`,
            metric: "Overhead vs pinned trace (U2)",
            journey: j.id,
            cell: c.id,
            verdict: NE,
            reason: "run 1 wrote no summary.flow",
          });
          continue;
        }
        const k = f.comparison;
        add({
          key: `u2 ${j.id} ${c.id}`,
          metric: "Overhead vs pinned trace (U2)",
          journey: j.id,
          cell: c.id,
          value: k.counts.overhead,
          pinned: k.baselineCounts.overhead,
          comparison: k.counts.overhead > k.baselineCounts.overhead ? "ratchet FAIL" : "pass",
          extra: k.extra,
          missing: k.missing,
          reclassed: k.reclassed,
          goalReached: f.goal?.reached ?? null,
        });
      }
      // §5: run 1 of N, which must match runs 2…N (the runner's stability check, per cell).
      const unstable = ran.filter((c) => !c.stable);
      add({
        key: `overhead ${j.id}`,
        metric: "Actions by class: overhead",
        journey: j.id,
        value: cmp.counts.overhead,
        ratcheted: true,
        ...(unstable.length
          ? { reason: `run 1 differs from later runs in ${unstable.map((c) => c.id).join(", ")}` }
          : {}),
      });
      add({
        key: `total ${j.id}`,
        metric: "Actions by class: total",
        journey: j.id,
        value: cmp.counts.total,
        detail: cmp.counts,
        ratcheted: false,
      });
      add({
        key: `agent-ops ${j.id}`,
        metric: "Agent operations",
        journey: j.id,
        value: first.agentOps,
        ops: first.agentCalls.map((c) => c.op),
        ratcheted: false,
      });
    }
    // Elapsed task time: performance's shared timing collector (median of N = 5, 95 % CI of the difference).
    // Measured here from the harness's step timings (flow-metrics.mjs elapsedOf): first action to goal, with the
    // harness's own time between steps reported apart. Without performance's shared collector and its CI of the
    // difference, the comparison is inconclusive (allowed by §5), never a pass or a fail.
    const elapsed = ran.flatMap((c) => c.runs.map((r) => r.flow?.elapsed)).filter((x) => x && typeof x.ms === "number");
    if (elapsed.length)
      add({
        key: `time ${j.id}`,
        metric: "Elapsed task time",
        journey: j.id,
        value: median(elapsed.map((e) => e.ms)),
        unit: "ms",
        detail: {
          runs: elapsed.length,
          medianStepsMs: median(elapsed.map((e) => e.stepsMs)),
          medianHarnessMs: median(elapsed.map((e) => e.harnessMs)),
        },
        ratcheted: false,
        comparison: "inconclusive",
        reason: `first action to goal from the harness's step timings over ${elapsed.length} runs (all cells); ${elapsed.length < 5 ? "fewer than 5 runs" : "no 95 % CI of the difference"} and not performance's shared timing collector: inconclusive`,
      });
    else
      add({
        key: `time ${j.id}`,
        metric: "Elapsed task time",
        journey: j.id,
        verdict: NE,
        reason: ran.length ? "no run recorded first-action-to-goal timing (summary.flow.elapsed)" : "no cell ran",
      });
    // Unseeded errors (§5): per journey, failures[] plus every alert, error notice, HTTP 4xx/5xx, failed request, console
    // error, page error and refused edit that no step declared ({ expects }) and no seeded condition caused, from the
    // error census (harness/errors.mjs), summed over every unseeded run of every cell. Ratcheted at 0. A run without a
    // census makes the row NOT EVALUATED: failures alone would undercount it.
    if (ran.length) {
      const runs = ran.flatMap((c) =>
        c.runs.filter((r) => !r.seed).map((r) => ({ cell: c.id, run: r.run, failures: r.failures ?? [], e: r.errors })),
      );
      const missing = runs.filter((r) => !r.e);
      if (!runs.length)
        add({
          key: `unseeded ${j.id}`,
          metric: "Unseeded errors",
          journey: j.id,
          verdict: NE,
          reason: "every run seeded a fault",
        });
      else if (missing.length)
        add({
          key: `unseeded ${j.id}`,
          metric: "Unseeded errors",
          journey: j.id,
          verdict: NE,
          reason: `${missing.length} of ${runs.length} runs have no error census (harness/errors.mjs)`,
        });
      else {
        const failures = runs.reduce((n, r) => n + r.failures.length, 0);
        const census = runs.reduce((n, r) => n + r.e.unseeded, 0);
        const byKind = {};
        for (const r of runs)
          for (const [k, v] of Object.entries(r.e.unseededByKind ?? {})) if (v) byKind[k] = (byKind[k] ?? 0) + v;
        const events = runs.flatMap((r) => [
          ...r.failures.map((f) => ({
            cell: r.cell,
            run: r.run,
            step: f.step,
            kind: "failure",
            text: f.message ?? f.error,
          })),
          ...r.e.unseededEvents.map((x) => ({ cell: r.cell, run: r.run, ...x })),
        ]);
        const value = failures + census;
        add({
          key: `unseeded ${j.id}`,
          metric: "Unseeded errors",
          journey: j.id,
          value,
          ratcheted: true,
          comparison: value > 0 ? "ratchet FAIL" : baselineSet ? "baseline set" : "pass",
          detail: {
            runs: runs.length,
            failures,
            census,
            byKind,
            expected: runs.reduce((n, r) => n + r.e.expected, 0),
            unusedDeclarations: runs.reduce((n, r) => n + r.e.unusedDeclarations.length, 0),
          },
          ...(events.length ? { events: events.slice(0, 20) } : {}),
        });
      }
    } else
      add({ key: `unseeded ${j.id}`, metric: "Unseeded errors", journey: j.id, verdict: NE, reason: "no cell ran" });
    // Unrequested reloads: document loads in any tab that the journey did not issue (harness/navigations.mjs), summed
    // over every run of every cell. Ratcheted at 0. A run without a census makes the journey's row NOT EVALUATED.
    if (ran.length) {
      const runs = ran.flatMap((c) => c.runs.map((r) => ({ cell: c.id, run: r.run, n: r.navigations })));
      const missing = runs.filter((r) => !r.n);
      if (missing.length)
        add({
          key: `reloads ${j.id}`,
          metric: "Unrequested reloads",
          journey: j.id,
          verdict: NE,
          reason: `${missing.length} of ${runs.length} runs have no navigation census (harness/navigations.mjs)`,
        });
      else {
        const value = runs.reduce((n, r) => n + r.n.unrequested, 0);
        const loads = runs.flatMap((r) => r.n.unrequestedLoads.map((x) => ({ cell: r.cell, run: r.run, ...x })));
        add({
          key: `reloads ${j.id}`,
          metric: "Unrequested reloads",
          journey: j.id,
          value,
          ratcheted: true,
          comparison: value > 0 ? "ratchet FAIL" : baselineSet ? "baseline set" : "pass",
          detail: {
            runs: runs.length,
            documents: runs.reduce((n, r) => n + r.n.documents, 0),
            issued: runs.reduce((n, r) => n + r.n.issued, 0),
            sameDocument: runs.reduce((n, r) => n + r.n.sameDocument, 0),
            unusedDeclarations: runs.reduce((n, r) => n + r.n.unusedDeclarations.length, 0),
          },
          ...(loads.length ? { loads: loads.slice(0, 20) } : {}),
        });
      }
    } else
      add({ key: `reloads ${j.id}`, metric: "Unrequested reloads", journey: j.id, verdict: NE, reason: "no cell ran" });
  }
  // Collector checks (G1, G2, G4, G5: summary.flowState.checks), per journey × cell × boundary, over the cell's runs.
  const checks = [];
  for (const c of merged.cells.filter((x) => x.verdict !== NE)) {
    const by = new Map();
    for (const r of c.runs)
      for (const k of checksOf(r)) {
        const key = `${k.gate}\0${k.boundary}`;
        const e = by.get(key) ?? {
          journey: c.journey,
          cell: c.id,
          gate: k.gate,
          boundary: k.boundary,
          held: 0,
          failed: 0,
        };
        if (k.ok) e.held++;
        else e.failed++;
        by.set(key, e);
      }
    checks.push(...by.values());
  }
  // Lost state (failed G1 checks) and duplicate effects (failed G5 checks), per journey that has them. Ratcheted at 0.
  for (const j of merged.journeys) {
    const mine = checks.filter((k) => k.journey === j.id && (k.gate === "G1" || k.gate === "G5"));
    if (!mine.length) continue;
    const lost = mine.filter((k) => k.gate === "G1").reduce((n, k) => n + k.failed, 0),
      duplicates = mine.filter((k) => k.gate === "G5").reduce((n, k) => n + k.failed, 0);
    const value = lost + duplicates;
    add({
      key: `lost-dup ${j.id}`,
      metric: "Lost state, duplicate effects",
      journey: j.id,
      value,
      detail: { lost, duplicates, checked: mine.reduce((n, k) => n + k.held + k.failed, 0) },
      ratcheted: true,
      comparison: value > 0 ? "ratchet FAIL" : baselineSet ? "baseline set" : "pass",
    });
  }
  // Rubric-wide rows.
  add({
    key: "recovery",
    metric: "Recovery actions (E1–E6)",
    verdict: NE,
    reason: "seeded errors E1–E6 are not scripted in this tool set (manual protocol U4)",
  });
  if (!checks.some((k) => k.gate === "G1" || k.gate === "G5"))
    add({
      key: "lost-dup",
      metric: "Lost state, duplicate effects",
      verdict: NE,
      reason: "no run recorded a G1 or G5 check",
    });
  add({ key: "u3-no", metric: 'Walkthrough "no" answers', verdict: NE, reason: "reviewer tables (manual, §6 U3)" });
  const ratchetFailures = rows.filter((r) => r.comparison === "ratchet FAIL");
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    baselineSet,
    rows,
    checks,
    ratchetFailures: ratchetFailures.map((r) => r.key),
    notEvaluated: rows.filter((r) => r.verdict === NE).map((r) => ({ key: r.key, reason: r.reason })),
  };
}

export function markdown(report) {
  const cell = (x) =>
    (x === undefined || x === null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x)).replace(/\|/g, "\\|");
  const lines = [
    `# User-flows §5 metrics (${report.generatedAt})`,
    "",
    report.baselineSet
      ? 'First round: this run sets the baseline; comparisons read "baseline set".'
      : "Compared with the baseline packet given.",
    "",
    "| Metric | Journey | Cell | Value | Baseline | Comparison | Note |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of report.rows) {
    const note =
      r.verdict === "NOT EVALUATED"
        ? r.reason
        : [
            r.reason,
            r.extra?.length ? `extra: ${r.extra.map((e) => `${e.action} (${e.class})`).join(", ")}` : "",
            r.missing?.length ? `missing: ${r.missing.map((e) => e.action).join(", ")}` : "",
            r.pinned !== undefined ? `pinned overhead ${r.pinned}` : "",
            r.ops ? r.ops.join(", ") : "",
            r.loads?.length
              ? `loads not issued: ${r.loads.map((l) => `${l.cell} r${l.run} [${l.step ?? "between steps"}] ${l.kind} ${l.url}`).join("; ")}`
              : "",
            r.detail ? JSON.stringify(r.detail) : "",
          ]
            .filter(Boolean)
            .join("; ");
    lines.push(
      `| ${cell(r.metric)} | ${cell(r.journey)} | ${cell(r.cell)} | ${cell(r.verdict ?? r.value)} | ${cell(r.baseline)} | ${cell(r.comparison)} | ${cell(note)} |`,
    );
  }
  if (report.checks?.length) {
    lines.push(
      "",
      "## Collector checks (G1, G2, G4, G5)",
      "",
      "Each journey's recorded checks (summary.flowState.checks), over the cell's runs. Evidence for the gates; the verdicts are the reviewers'.",
      "",
      "| Journey | Cell | Gate | Boundary | Held | Failed |",
      "|---|---|---|---|---|---|",
    );
    for (const k of report.checks)
      lines.push(
        `| ${cell(k.journey)} | ${cell(k.cell)} | ${cell(k.gate)} | ${cell(k.boundary)} | ${k.held} | ${k.failed} |`,
      );
  }
  lines.push(
    "",
    `Ratchet failures: ${report.ratchetFailures.length ? report.ratchetFailures.join(", ") : "none"}`,
    `NOT EVALUATED rows: ${report.notEvaluated.length}`,
  );
  return lines.join("\n") + "\n";
}

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: "string", multiple: true },
      baseline: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (!values.run?.length) {
    process.stderr.write(
      "usage: flow-report.mjs --run <flows.json> [--run …] [--baseline <report.json>] [--out <report.json>] [--json]\n",
    );
    process.exit(2);
  }
  const merged = mergeRuns(values.run.map((f) => JSON.parse(readFileSync(resolve(f), "utf8"))));
  const baseline = values.baseline ? JSON.parse(readFileSync(resolve(values.baseline), "utf8")) : null;
  const report = buildReport(merged, baseline);
  if (values.out) writeFileSync(resolve(values.out), JSON.stringify(report, null, 2));
  process.stdout.write(values.json ? JSON.stringify(report, null, 2) + "\n" : markdown(report));
  process.exitCode = report.ratchetFailures.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
