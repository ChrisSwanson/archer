#!/usr/bin/env node
/**
 * Runs a test command many times and says how often it failed.
 *
 * "The suite passed" is one sample. Whether the UI gate is DETERMINISTIC
 * (the implementation plan's section 12.2, row U6) is a statement about a rate,
 * and a rate takes repetitions to measure: one failure in 33 runs was seen on
 * 2026-08-05 and never identified, and twelve clean runs since do not rule it
 * out. This is the instrument, the same one locally and in the flake-hunt CI
 * job, where there is one.
 *
 *   npm --workspace ui run test:repeat -- --runs 20
 *   npm --workspace ui run test:repeat -- --runs 50 --load 4
 *   npm --workspace ui run test:repeat -- --runs 30 -- npx vitest run tests/app.render.test.tsx
 *
 *   --runs N        how many times (default 10)
 *   --load L        background CPU hogs, to imitate a contended CI runner (default 0)
 *   --log-dir DIR   where each run's output goes, as run-<i>.log (default: a temp dir)
 *   --report-only   exit 0 even when runs failed (CI reports the verdict itself)
 *   -- command...   what to run, in `ui/` (default: npx vitest run)
 *
 * HOW TO READ IT. The last lines are the result:
 *
 *   VERDICT: 0 of 100 runs failed (load 4)
 *   BOUND: with no failure in 100 runs, the failure rate is below 3.0% (95% confidence)
 *
 * A clean result is only as strong as its N. With no failure in N runs the
 * rate is below 1 - 0.05^(1/N) at 95% confidence, about 3/N: 12 runs bound it
 * at 22%, 33 at 8.7%, 100 at 3.0%, 300 at 1.0%. So ruling out the 3% flake
 * takes a hundred clean runs, in the environment it was seen in.
 *
 * When runs do fail, the tests that failed are tallied across runs, most
 * frequent first, and the first failing run's whole log is kept as
 * first-failure.log beside the others. Read that log before forming a theory
 * (AGENTS.md, "When CI fails, read the log").
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The tests a vitest or Playwright log says failed, one name per failing test. */
export function failedTests(log) {
  const names = new Set();
  for (const line of log.split("\n")) {
    // vitest: " FAIL  tests/a.test.ts > suite > test"
    const vitest = /^\s*FAIL\s+(\S.*)$/.exec(line);
    if (vitest !== null) names.add(vitest[1].trim());
    // Playwright's list reporter: "  ✘  12 tests/browser/a.e2e.ts:10:5 › suite › test (1.2s)"
    const playwright = /^\s*✘\s+\d+\s+(\S.*?)(?:\s+\(\d[\d.]*(?:ms|s|m)\))?$/.exec(line);
    if (playwright !== null) names.add(playwright[1].trim());
  }
  return [...names];
}

/** The failure rate that N clean runs rule out, at 95% confidence. */
export function boundAfterCleanRuns(runs) {
  return runs <= 0 ? 1 : 1 - 0.05 ** (1 / runs);
}

/** The verdict lines for a set of runs: what a reader, or CI, takes away. */
export function summarise(results, load) {
  const failures = results.filter((result) => !result.passed);
  const lines = [];
  const seconds = results.map((result) => result.seconds).sort((a, b) => a - b);
  if (seconds.length > 0) {
    const median = seconds[Math.floor(seconds.length / 2)];
    lines.push(
      `DURATION: min ${seconds[0].toFixed(0)}s, median ${median.toFixed(0)}s, max ${seconds[seconds.length - 1].toFixed(0)}s`,
    );
  }
  if (failures.length > 0) {
    const tally = new Map();
    for (const failure of failures) {
      const names = failure.failed.length > 0 ? failure.failed : ["(no failing test named: the command itself failed)"];
      for (const name of names) tally.set(name, (tally.get(name) ?? 0) + 1);
    }
    lines.push("FAILED TESTS, by how many runs each failed in:");
    for (const [name, count] of [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      lines.push(`  ${String(count).padStart(3)}  ${name}`);
    }
    lines.push(`RATE: ${((failures.length / results.length) * 100).toFixed(1)}% of runs failed`);
  } else if (results.length > 0) {
    lines.push(
      `BOUND: with no failure in ${results.length} runs, the failure rate is below ` +
        `${(boundAfterCleanRuns(results.length) * 100).toFixed(1)}% (95% confidence)`,
    );
  }
  lines.push(`VERDICT: ${failures.length} of ${results.length} runs failed (load ${load})`);
  return lines;
}

function parse(argv) {
  const options = { runs: 10, load: 0, logDir: null, reportOnly: false, command: ["npx", "vitest", "run"] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      if (argv.length > i + 1) options.command = argv.slice(i + 1);
      break;
    }
    if (arg === "--runs") options.runs = Number(argv[++i]);
    else if (arg === "--load") options.load = Number(argv[++i]);
    else if (arg === "--log-dir") options.logDir = argv[++i];
    else if (arg === "--report-only") options.reportOnly = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs takes a whole number, 1 or more");
  if (!Number.isInteger(options.load) || options.load < 0) throw new Error("--load takes a whole number, 0 or more");
  return options;
}

/**
 * A background CPU hog that cannot outlive this script. It spins in quarter
 * second slices and looks, between them, at whether its parent is still the
 * one that started it: killed outright (a cancelled job, a closed terminal),
 * this script gets no chance to clean up, and a hog that only stopped when
 * told to would spin on that machine until someone found it.
 */
const HOG =
  "const parent = process.ppid; for (;;) { const until = Date.now() + 250; while (Date.now() < until); if (process.ppid !== parent) process.exit(0); }";

/** The run in flight, so an interrupt can stop it. */
let running = null;

function runOnce(command, cwd, logFile) {
  return new Promise((done) => {
    const started = Date.now();
    const chunks = [];
    // Its own process group: `npx` starts the suite as a grandchild, and
    // stopping only `npx` would leave the suite running.
    const child = spawn(command[0], command.slice(1), {
      cwd,
      detached: true,
      env: { ...process.env, CI: process.env.CI ?? "" },
    });
    running = child;
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => chunks.push(Buffer.from(`\ncould not start: ${error.message}\n`)));
    child.on("close", (code) => {
      running = null;
      const log = Buffer.concat(chunks).toString("utf8");
      writeFileSync(logFile, log);
      done({ passed: code === 0, seconds: (Date.now() - started) / 1000, failed: code === 0 ? [] : failedTests(log) });
    });
  });
}

async function main() {
  const options = parse(process.argv.slice(2));
  const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const logDir = options.logDir ?? mkdtempSync(join(tmpdir(), "archer-repeat-"));
  mkdirSync(logDir, { recursive: true });

  // Contention is the variable that matters: a race that needs a loaded
  // scheduler to appear does not appear on a quiet machine.
  const hogs = Array.from({ length: options.load }, () => spawn(process.execPath, ["-e", HOG], { stdio: "ignore" }));
  // Interrupted, it stops what it started and reports nothing: half a
  // measurement is not a smaller measurement.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      for (const hog of hogs) hog.kill();
      if (running?.pid !== undefined) {
        try {
          process.kill(-running.pid);
        } catch {
          // Already gone.
        }
      }
      console.error(`interrupted by ${signal}: no verdict`);
      process.exit(130);
    });
  }
  console.log(
    `running \`${options.command.join(" ")}\` ${options.runs} times in ${ui} (load ${options.load}); logs in ${logDir}`,
  );

  const results = [];
  try {
    for (let i = 1; i <= options.runs; i += 1) {
      const logFile = join(logDir, `run-${i}.log`);
      const result = await runOnce(options.command, ui, logFile);
      results.push(result);
      console.log(`run ${i}: ${result.passed ? "passed" : "FAILED"} in ${result.seconds.toFixed(0)}s`);
      if (!result.passed && results.filter((entry) => !entry.passed).length === 1) {
        // Keep the first failure whole; later ones are usually the same.
        copyFileSync(logFile, join(logDir, "first-failure.log"));
      }
    }
  } finally {
    for (const hog of hogs) hog.kill();
  }

  for (const line of summarise(results, options.load)) console.log(line);
  const failed = results.some((result) => !result.passed);
  process.exit(failed && !options.reportOnly ? 1 : 0);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
