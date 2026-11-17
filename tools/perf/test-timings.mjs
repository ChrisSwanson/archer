// Where the test time goes: summarise Vitest and Playwright JSON reports.
//
//   cd ts && npx vitest run --reporter=json --outputFile=/tmp/ts.json
//   cd ui && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/browser.json npx playwright test -c tests/browser-ts --reporter=json
//   node tools/perf/test-timings.mjs /tmp/ts.json /tmp/browser.json [--top 25]
//
// For each report: total test time, then the slowest files and the slowest tests. Vitest file time is
// the sum of its tests (collect/setup time is not in the JSON report); Playwright time is per attempt.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const topAt = args.indexOf("--top");
const top = topAt === -1 ? 25 : Number(args[topAt + 1]);
const files = args.filter((arg, index) => !arg.startsWith("--") && index !== topAt + 1);

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

function vitest(report) {
  const tests = [];
  for (const file of report.testResults ?? [])
    for (const test of file.assertionResults ?? [])
      tests.push({ file: file.name, title: test.fullName ?? test.title, ms: test.duration ?? 0, status: test.status });
  return tests;
}

function playwright(report) {
  const tests = [];
  const walk = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        for (const result of test.results ?? [])
          tests.push({
            file: here,
            title: `${test.projectName ? `[${test.projectName}] ` : ""}${spec.title}`,
            ms: result.duration ?? 0,
            status: result.status,
          });
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file);
  return tests;
}

for (const path of files) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const tests = report.testResults ? vitest(report) : playwright(report);
  const byFile = new Map();
  for (const test of tests) {
    const entry = byFile.get(test.file) ?? { ms: 0, count: 0 };
    entry.ms += test.ms;
    entry.count++;
    byFile.set(test.file, entry);
  }
  const total = tests.reduce((sum, test) => sum + test.ms, 0);
  const wall = report.stats?.duration; // Playwright only
  console.log(`\n== ${path}: ${tests.length} tests, ${seconds(total)} summed${wall ? `, ${seconds(wall)} wall` : ""}`);
  console.log(`-- slowest files`);
  for (const [file, entry] of [...byFile].sort((a, b) => b[1].ms - a[1].ms).slice(0, top))
    console.log(
      `${seconds(entry.ms).padStart(8)}  ${String(entry.count).padStart(4)} tests  ${file.replace(/^.*?\/(ts|ui)\//, "$1/")}`,
    );
  console.log(`-- slowest tests`);
  for (const test of [...tests].sort((a, b) => b.ms - a.ms).slice(0, top))
    console.log(`${seconds(test.ms).padStart(8)}  ${test.status.padEnd(7)} ${test.title.slice(0, 110)}`);
}
