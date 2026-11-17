#!/usr/bin/env node
// Run journeys against a sandbox and print where the evidence is.
//
//   node tools/devkit/harness/smoke.mjs --sandbox <name> --journey <file> [--journey <file>…]
//        [--headed] [--slow-mo ms] [--keep-going] [--no-invariant <name>…] [--json]
//        [--max-minutes n] [--profile] [--no-trace-snapshots] [--no-entry-shots] [--no-orphan-check]
//
// A journey is an ESM module:
//   export const meta = { name: "flowchart-create", invariants: { "console-errors": false } };  // optional
//   export default async ({ ui, page, step, expect, sandbox, log }) => { … };
//
// Prints one line per journey (PASS/FAIL + summary.json path); --json prints the summaries' key
// fields as JSON lines. Exit code 1 if any journey failed, 3 if the run was aborted.
//
// Robustness (TG-m2): SIGINT/SIGTERM/SIGHUP, the parent process going away (this process re-parented: its driver
// shell died, as the monkey batch's did with exit 144) or a closed stdout abort the run: the browser is closed, the
// current journey's summary.json is written with `aborted`, the remaining journeys are not started. A second
// signal exits at once. Each run dir has progress.json ({pid, steps, last, at}): stop a run by that pid, never
// with `pkill -f <pattern>`, which also matches the shell that runs pkill.
import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { journeyDeadlineMs, openSandbox, withPage } from "./index.mjs";

const { values } = parseArgs({
  options: {
    sandbox: { type: "string", default: process.env.ARCHER_SANDBOX ?? "smoke" },
    journey: { type: "string", multiple: true },
    headed: { type: "boolean" },
    "slow-mo": { type: "string" },
    "keep-going": { type: "boolean" },
    "no-invariant": { type: "string", multiple: true },
    json: { type: "boolean" },
    "max-minutes": { type: "string" },
    profile: { type: "boolean" },
    "no-trace-snapshots": { type: "boolean" },
    "no-entry-shots": { type: "boolean" },
    "no-orphan-check": { type: "boolean" },
  },
});
if (!values.journey?.length) {
  process.stderr.write(
    "usage: smoke.mjs --sandbox <name> --journey <file> [--journey …] [--headed] [--slow-mo ms] [--keep-going] [--no-invariant name] [--json]\n",
  );
  process.exit(2);
}
const sandbox = openSandbox(values.sandbox);
const control = new AbortController();
let signals = 0;
const stop = (reason) => {
  if (!control.signal.aborted) {
    process.stderr.write(`aborting: ${reason}\n`);
    control.abort(reason);
  }
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => {
    if (++signals > 1) process.exit(130);
    stop(`received ${sig}`);
  });
process.stdout.on("error", () => stop("stdout closed")); // EPIPE: whoever reads us has gone
if (!values["no-orphan-check"]) {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) stop(`parent process ${parent} exited (this run was orphaned)`);
  }, 2000).unref();
}
const write = (text) => {
  try {
    process.stdout.write(text);
  } catch {
    /* stdout closed */
  }
};
let failed = 0,
  abortedRuns = 0;
for (const file of values.journey) {
  if (control.signal.aborted) break;
  const mod = await import(pathToFileURL(resolve(file)).href);
  const meta = mod.meta ?? {};
  const invariants = { ...(meta.invariants ?? {}) };
  for (const n of values["no-invariant"] ?? []) invariants[n] = false;
  const summary = await withPage(mod.default, {
    name: meta.name ?? basename(file).replace(/\.m?js$/, ""),
    sandbox,
    invariants,
    headed: values.headed,
    slowMo: values["slow-mo"] ? Number(values["slow-mo"]) : undefined,
    stopOnFailure: !values["keep-going"],
    viewport: meta.viewport,
    timeoutMs: meta.timeoutMs,
    signal: control.signal,
    maxMs: journeyDeadlineMs(meta, values["max-minutes"] ? Number(values["max-minutes"]) : undefined),
    profile: values.profile || meta.profile,
    traceSnapshots: !values["no-trace-snapshots"] && meta.traceSnapshots !== false,
    entryShots: !values["no-entry-shots"] && meta.entryShots !== false,
  });
  if (!summary.ok) failed++;
  if (summary.aborted) abortedRuns++;
  if (values.json) {
    write(
      JSON.stringify({
        name: summary.name,
        ok: summary.ok,
        counts: summary.counts,
        summary: summary.artifacts.summary,
        trace: summary.howTo.trace,
        failures: summary.failures.map((f) => ({ step: f.step, kind: f.kind, invariant: f.invariant, error: f.error })),
      }) + "\n",
    );
  } else {
    write(
      `${summary.aborted ? "ABORTED" : summary.ok ? "PASS" : "FAIL"} ${summary.name}  steps=${summary.counts.steps} failures=${summary.counts.failures} warnings=${summary.counts.warnings} ${(summary.durationMs / 1000).toFixed(1)}s\n  summary: ${summary.artifacts.summary}\n`,
    );
    for (const f of summary.failures.slice(0, 8))
      write(
        `  ✗ [${f.step}] ${f.kind === "invariant" ? `invariant ${f.invariant}` : (f.error ?? "").split("\n")[0]}\n`,
      );
    if (!summary.ok) write(`  trace: ${summary.howTo.trace}\n`);
  }
}
process.exitCode = abortedRuns ? 3 : failed ? 1 : 0;
