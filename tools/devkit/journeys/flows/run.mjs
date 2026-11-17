#!/usr/bin/env node
// The user-flows runner (rubric docs/quality/rubrics/user-flows.md §1 matrix, §5, §8 G6/U1/U2):
//
//   node tools/devkit/journeys/flows/run.mjs --sandbox <name> [--queued-sandbox <name>] [--journey <file>…]
//        [--runs N] [--only J4 …] [--headed] [--out <dir>] [--json]
//
// For each journey (default: every jNN-*.mjs here) it expands `meta.flow.matrix` into cells (viewports ×
// comment_submission settings), and runs each cell N times (default 3) through the harness (withPage), resetting the
// journey's projects before every run (ui.resetProject). A cell passes when every run is ok, run 1's action
// counts and agent operations (summary.flow) equal runs 2…N, and every run's trace is its pinned trace (pinCheck:
// no action missing, none extra, none in another class; §6 "the journey file pins the exact trace", U2, U1 "full").
//
// A `queued` cell needs a sandbox whose comment_submission is queued (--queued-sandbox; `sandbox.mjs up
// --comment-submission queued`): without one the cell is NOT EVALUATED, never skipped silently. A cell whose sandbox
// setting differs from the one it names is NOT EVALUATED too.
//
// Writes <out>/flows.json (default tools/devkit/runs/<stamp>-flows/): per journey and cell, every run's verdict,
// summary.json path, trace counts and the stability check. tools/quality/flow-report.mjs reads it.
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { request } from "playwright";
import { RUNS, openSandbox, withPage, journeyDeadlineMs } from "../../harness/index.mjs";
import { sameCounts } from "../../harness/flow-metrics.mjs";
import { issueMessage } from "../../harness/errors.mjs";
import { issueLink } from "../../sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/** The comment_submission a sandbox runs with: its record's field when `up` wrote one, else its archer.toml, else the default. */
export function commentSubmissionOf(record) {
  if (record.commentSubmission) return record.commentSubmission;
  try {
    const m = /^\s*comment_submission\s*=\s*"(queued|immediate)"/m.exec(readFileSync(record.configPath, "utf8"));
    if (m) return m[1];
  } catch {
    /* no config file */
  }
  return "immediate"; // ts/src/config/instance-settings.ts default
}

/** meta.flow.matrix → cells. `matrix.viewports` (default 1440×900) × `matrix.commentSubmission` (default immediate). */
export function cellsOf(meta) {
  const m = meta.flow?.matrix ?? {};
  const viewports = m.viewports ?? [meta.viewport ?? DEFAULT_VIEWPORT];
  const modes = m.commentSubmission ?? ["immediate"];
  const cells = [];
  for (const viewport of viewports)
    for (const commentSubmission of modes)
      cells.push({ id: `${viewport.width}x${viewport.height}-${commentSubmission}`, viewport, commentSubmission });
  return cells;
}

/** The stability rule (§5 "Actions by class"): every run's counts equal run 1's. */
export function stability(flows) {
  const present = flows.filter(Boolean);
  if (present.length < flows.length) return { stable: false, reason: "a run wrote no summary.flow" };
  const first = present[0];
  const differing = present
    .slice(1)
    .map((f, i) => (sameCounts(first, f) ? null : { run: i + 2, counts: f.counts, agentOps: f.agentOps }))
    .filter(Boolean);
  return differing.length
    ? {
        stable: false,
        reason: `run 1 ${JSON.stringify(first.counts)} agentOps ${first.agentOps} differs from ${JSON.stringify(differing)}`,
      }
    : { stable: true };
}

/**
 * The pin rule: every run's action trace equals the journey's pinned trace (meta.flow.baseline, or the cell's entry in
 * meta.flow.baselines), action for action and class for class. A run with no trace fails it. Returns
 * { matches, diff: [{ run, missing, extra, reclassed }], text } where `text` is a readable diff ("- " pinned but not
 * done, "+ " done but not pinned, "~ " another class).
 */
export function pinCheck(runs) {
  const diff = [];
  for (const r of runs) {
    const k = r.flow?.comparison;
    if (!k) {
      diff.push({ run: r.run, noTrace: true, missing: [], extra: [], reclassed: [] });
      continue;
    }
    if (!k.matches) diff.push({ run: r.run, missing: k.missing, extra: k.extra, reclassed: k.reclassed });
  }
  const text = diff
    .map((d) =>
      [
        `run ${d.run}: ${d.noTrace ? "no action trace (summary.flow)" : "trace differs from the pinned trace"}`,
        ...d.missing.map((m) => `  - ${m.action} (${m.class}, pinned at ${m.at + 1})`),
        ...d.extra.map((m) => `  + ${m.action} (${m.class}, done at ${m.at + 1})`),
        ...d.reclassed.map((m) => `  ~ ${m.action}: pinned ${m.baseline}, now ${m.now}`),
      ].join("\n"),
    )
    .join("\n");
  return { matches: diff.length === 0, diff, text };
}

/** A cell's verdict from its runs: PASS when all `expected` runs are ok, stable (§5) and on their pinned trace. */
export function cellVerdict(runs, expected = runs.length) {
  const st = stability(runs.map((r) => r.flow));
  const pin = pinCheck(runs);
  const ok = runs.length === expected && runs.every((r) => r.ok);
  return {
    verdict: ok && st.stable && pin.matches ? "PASS" : "FAIL",
    ok,
    stable: st.stable,
    ...(st.stable ? {} : { stabilityReason: st.reason }),
    pin,
  };
}

/**
 * A run's navigation census (harness/navigations.mjs) as its digest keeps it: the counts, every load the journey did
 * not issue, and declarations that absorbed nothing. Null when the harness wrote none (an older harness).
 */
export function navigationDigest(n) {
  if (!n || n.schema === undefined) return null;
  return {
    schema: n.schema,
    documents: n.documents,
    issued: n.issued,
    unrequested: n.unrequested,
    unrequestedLoads: n.unrequestedLoads,
    sameDocument: n.sameDocument,
    unusedDeclarations: n.unusedDeclarations,
  };
}

/** The error census in a run's digest (harness/errors.mjs): counts, by kind, and the unseeded events themselves. */
export function errorsDigest(e) {
  if (!e || e.schema === undefined) return null;
  return {
    schema: e.schema,
    events: e.events,
    expected: e.expected,
    unseeded: e.unseeded,
    unseededByKind: e.unseededByKind,
    unseededEvents: e.unseededEvents.slice(0, 50),
    unusedDeclarations: e.unusedDeclarations,
    absorbed: absorbedTexts(e.all ?? []),
  };
}

/** What a run's seeded conditions and declarations absorbed, by text (PC-601): a reviewer reads them in the packet. */
export function absorbedTexts(all) {
  const by = new Map();
  for (const x of all) {
    if (!x.expected) continue;
    const key = `${x.kind}\u0000${x.text}\u0000${x.expectedBy}`;
    const row = by.get(key) ?? { kind: x.kind, text: x.text, by: x.expectedBy, count: 0 };
    row.count++;
    by.set(key, row);
  }
  return [...by.values()].slice(0, 50);
}

/** A failure or warning in a run's digest: what it was, in words (PC-18: the message used to be lost). */
export function issueDigest(w) {
  return {
    step: w.step ?? null,
    kind: w.kind ?? null,
    ...(w.code ? { code: w.code } : {}),
    invariant: w.invariant ?? null,
    message: issueMessage(w).slice(0, 300),
  };
}

export function journeyFiles(dir = HERE) {
  return readdirSync(dir)
    .filter((f) => /^j\d\d[a-z0-9]*-.*\.mjs$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * The same start for every run (O97): the service lists the sandbox's projects in the order `up` attached them. The
 * overview shows them in that order, so a journey's pinned scrolls depend on it; a restart in an earlier journey (J8b,
 * J8c, J8d, J9d) used to reorder them. A different order fails the run here, before the journey, naming both orders.
 */
export async function startState(ctx, sandbox) {
  await ctx.step("start state: the service lists the projects in the sandbox's order", async () => {
    const want = sandbox.projects.map((p) => p.slug);
    // A request context of its own, signed in with the run's link: the journey's browser context is left as it is
    // (J1 starts with no session at all).
    const api = await request.newContext({ ...(sandbox.caPath ? { ignoreHTTPSErrors: true } : {}) });
    try {
      const login = await api.get(sandbox.link);
      if (!login.ok()) throw new Error(`the run's link answered ${login.status()}`);
      const r = await api.get(new URL("/api/projects", sandbox.origin).href, {
        headers: { "cache-control": "no-store" },
      });
      if (!r.ok()) throw new Error(`api/projects answered ${r.status()}`);
      const got = (await r.json()).projects.map((p) => p.slug);
      if (JSON.stringify(got) !== JSON.stringify(want))
        throw new Error(
          `start state differs: the service lists ${got.join(", ")}; the sandbox attached ${want.join(", ")}`,
        );
    } finally {
      await api.dispose();
    }
  });
}

/**
 * Run one journey module in one cell `runs` times: projects reset before each run, the cell passed as ctx.cell.
 * `seedFor(i)` (proving the collectors only) gives run i a seeded fault (ctx.seed). Resolves to the run records.
 */
export async function runCell(
  mod,
  cell,
  sandbox,
  { runs = 3, headed, signal, onRun = () => {}, seedFor = () => undefined, name } = {},
) {
  const meta = mod.meta ?? {};
  const out = [];
  for (let i = 1; i <= runs; i++) {
    if (signal?.aborted) break;
    const seed = seedFor(i);
    // Each run signs in with a link of its own: the service mints at most 20 sessions a minute per link
    // (MAX_SESSION_MINTS_PER_MINUTE) and answers more with 404, and back-to-back runs that open fresh contexts
    // (J7b: five sign-ins a run) ran the sandbox's one link out (O81; O70 was the same limit in round trips).
    const runSandbox = {
      ...sandbox,
      link: issueLink({ name: sandbox.name, label: `flows ${name ?? meta.name ?? "journey"} ${cell.id} r${i}` }).url,
    };
    const summary = await withPage(
      async (ctx) => {
        // Reset before every run: the journey's projects back to the corpus snapshot, this browser's drafts cleared.
        for (const slug of meta.flow?.projects ?? ["pageturner"]) await ctx.ui.resetProject(slug);
        await startState(ctx, runSandbox);
        await mod.default({ ...ctx, cell, resetDone: true, ...(seed ? { seed } : {}) });
      },
      {
        name: `${name ?? meta.name ?? "journey"}-${cell.id}-r${i}`,
        sandbox: runSandbox,
        invariants: meta.invariants,
        headed,
        viewport: cell.viewport,
        timeoutMs: meta.timeoutMs,
        signal,
        maxMs: journeyDeadlineMs(meta),
        login: meta.login,
      },
    );
    // A restart during the run (ui.restartService) updated the run's copy of the record.
    for (const k of ["pid", "process", "ownerToken"]) if (runSandbox[k] !== undefined) sandbox[k] = runSandbox[k];
    out.push({
      run: i,
      ok: summary.ok,
      ...(seed ? { seed } : {}),
      summary: summary.artifacts.summary,
      failures: summary.failures.map((f) => ({ ...issueDigest(f), error: (f.error ?? "").split("\n")[0] })),
      warnings: (summary.warnings ?? []).map(issueDigest),
      unseededErrors: seed ? null : summary.failures.length + (summary.errors?.unseeded ?? 0),
      flow: summary.flow ?? null,
      roundTrip: summary.roundTrip ?? null,
      flowChecks: (summary.flowState?.checks ?? []).map((c) => ({ gate: c.gate, boundary: c.boundary, ok: c.ok })),
      navigations: navigationDigest(summary.navigations),
      errors: errorsDigest(summary.errors),
      durationMs: summary.durationMs,
    });
    onRun(out);
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      sandbox: { type: "string" },
      "queued-sandbox": { type: "string" },
      journey: { type: "string", multiple: true },
      runs: { type: "string", default: "3" },
      only: { type: "string", multiple: true },
      headed: { type: "boolean" },
      out: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (!values.sandbox) {
    process.stderr.write(
      "usage: run.mjs --sandbox <name> [--queued-sandbox <name>] [--journey file…] [--runs N] [--only J4…] [--out dir] [--json]\n",
    );
    process.exit(2);
  }
  const runs = Math.max(1, Number(values.runs));
  const sandboxes = {
    immediate: openSandbox(values.sandbox),
    queued: values["queued-sandbox"] ? openSandbox(values["queued-sandbox"]) : null,
  };
  const out = resolve(
    values.out ?? join(RUNS, `${new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")}-flows`),
  );
  mkdirSync(out, { recursive: true });
  const control = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => control.abort(`received ${sig}`));
  const report = {
    schema: "archer-flows-run/1",
    startedAt: new Date().toISOString(),
    runsPerCell: runs,
    sandboxes: Object.fromEntries(
      Object.entries(sandboxes).map(([k, s]) => [
        k,
        s && { name: s.name, debugUi: s.debugUi, commentSubmission: commentSubmissionOf(s) },
      ]),
    ),
    journeys: [],
  };
  const write = () => writeFileSync(join(out, "flows.json"), JSON.stringify(report, null, 2));
  const files = values.journey?.length ? values.journey.map((f) => resolve(f)) : journeyFiles();
  let failed = 0;
  for (const file of files) {
    if (control.signal.aborted) break;
    const mod = await import(pathToFileURL(file).href);
    const meta = mod.meta ?? {};
    if (!meta.flow) continue;
    if (values.only?.length && !values.only.includes(meta.flow.id)) continue;
    const entry = {
      id: meta.flow.id,
      name: meta.name ?? basename(file),
      file: basename(file),
      baseline: meta.flow.baseline,
      cells: [],
    };
    report.journeys.push(entry);
    for (const cell of cellsOf(meta)) {
      const sandbox = sandboxes[cell.commentSubmission] ?? null;
      const c = { ...cell, runs: [] };
      entry.cells.push(c);
      if (sandbox === null) {
        c.verdict = "NOT EVALUATED";
        c.reason = `needs a sandbox with comment_submission = ${cell.commentSubmission} (--${cell.commentSubmission}-sandbox; sandbox.mjs up --comment-submission ${cell.commentSubmission})`;
        write();
        continue;
      }
      const setting = commentSubmissionOf(sandbox);
      if (setting !== cell.commentSubmission) {
        c.verdict = "NOT EVALUATED";
        c.reason = `sandbox ${sandbox.name} runs comment_submission = ${setting}, the cell needs ${cell.commentSubmission}`;
        write();
        continue;
      }
      const pending = meta.flow.pending?.[cell.commentSubmission] ?? meta.flow.pending?.[cell.id];
      if (pending) {
        c.verdict = "NOT EVALUATED";
        c.reason = pending;
        write();
        continue;
      }
      c.runs = await runCell(mod, cell, sandbox, {
        runs,
        headed: values.headed,
        signal: control.signal,
        onRun: (sofar) => {
          c.runs = [...sofar];
          write();
        },
      });
      const v = cellVerdict(c.runs, runs);
      const pin = v.pin;
      c.stable = v.stable;
      if (!v.stable) c.stabilityReason = v.stabilityReason;
      c.pinned = pin.matches;
      if (!pin.matches) c.pinDiff = pin.diff;
      c.verdict = v.verdict;
      if (c.verdict === "FAIL") failed++;
      write();
      const line = `${c.verdict.padEnd(13)} ${meta.flow.id.padEnd(4)} ${cell.id.padEnd(22)} runs=${c.runs.filter((r) => r.ok).length}/${runs} stable=${c.stable} pinned=${c.pinned} actions=${JSON.stringify(c.runs[0]?.flow?.counts ?? null)} agentOps=${c.runs[0]?.flow?.agentOps ?? "-"}`;
      if (!values.json) process.stdout.write(line + "\n");
      for (const r of c.runs.filter((x) => !x.ok))
        for (const f of r.failures.slice(0, 3))
          if (!values.json)
            process.stdout.write(
              `    run ${r.run}: [${f.step}] ${f.invariant ? `invariant ${f.invariant}` : f.error}\n`,
            );
      if (!pin.matches && !values.json) process.stdout.write(pin.text.replace(/^/gm, "    ") + "\n");
    }
    for (const c of entry.cells.filter((x) => x.verdict === "NOT EVALUATED"))
      if (!values.json)
        process.stdout.write(`NOT EVALUATED ${meta.flow.id.padEnd(4)} ${c.id.padEnd(22)} ${c.reason}\n`);
  }
  report.finishedAt = new Date().toISOString();
  write();
  if (values.json) process.stdout.write(JSON.stringify({ out: join(out, "flows.json"), failed }) + "\n");
  else process.stdout.write(`flows.json: ${join(out, "flows.json")}\n`);
  process.exitCode = control.signal.aborted ? 3 : failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
