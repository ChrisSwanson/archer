// The instrument that measures whether the UI gate is deterministic
// (`scripts/repeat-suite.mjs`; plan section 12.2, row U6). It reports a rate,
// and a wrong count or a wrong bound would be believed, so what it reads out
// of a log and what it claims from a set of runs are pinned here. The loop
// that spawns the suite is exercised by using it.
import { describe, expect, it } from "vitest";
import { boundAfterCleanRuns, failedTests, summarise } from "../scripts/repeat-suite.mjs";

const VITEST_FAILURE = `
 RUN  v4.1.10 /repo/ui

 ❯ tests/app.render.test.tsx (31 tests | 1 failed) 4012ms
     × redraws the same view when its model is re-presented at a new revision 1012ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/app.render.test.tsx > App > redraws the same view when its model is re-presented at a new revision
AssertionError: expected null not to be null

 FAIL  tests/canvas-fit.test.tsx > the first framing > shows the whole graph
Error: Maximum update depth exceeded.

 Test Files  2 failed | 87 passed (89)
      Tests  2 failed | 1837 passed (1839)
`;

const PLAYWRIGHT_FAILURE = `
Running 323 tests using 4 workers

  ✓   1 tests/browser/a11y.e2e.ts:98:7 › axe · current light › the graph canvas (2.1s)
  ✘   2 tests/browser/live-reload.e2e.ts:37:3 › live reload of a graph › an edit on disk redraws the page (5.4s)
  ✘  14 tests/browser/framing.e2e.ts:138:9 › wide · current · 420x800: opens readable (1.2m)

  2 failed
`;

describe("reading which tests failed out of a run's log", () => {
  it("names each failing vitest test once, by file and full title", () => {
    expect(failedTests(VITEST_FAILURE)).toEqual([
      "tests/app.render.test.tsx > App > redraws the same view when its model is re-presented at a new revision",
      "tests/canvas-fit.test.tsx > the first framing > shows the whole graph",
    ]);
  });

  it("names each failing Playwright test, without its duration", () => {
    expect(failedTests(PLAYWRIGHT_FAILURE)).toEqual([
      "tests/browser/live-reload.e2e.ts:37:3 › live reload of a graph › an edit on disk redraws the page",
      "tests/browser/framing.e2e.ts:138:9 › wide · current · 420x800: opens readable",
    ]);
  });

  it("names nothing in a log with no failure", () => {
    expect(failedTests(" Test Files  89 passed (89)\n      Tests  1839 passed (1839)\n")).toEqual([]);
  });
});

describe("what a run of clean results rules out", () => {
  it("is the rate below which N clean runs put the true rate, at 95% confidence", () => {
    // Twelve clean runs, which is what the release review had, bound it at 22%.
    expect(boundAfterCleanRuns(12)).toBeCloseTo(0.221, 3);
    // The one-in-33 observation needs a hundred clean runs to rule out.
    expect(boundAfterCleanRuns(33)).toBeCloseTo(0.087, 3);
    expect(boundAfterCleanRuns(100)).toBeLessThan(0.03);
    expect(boundAfterCleanRuns(99)).toBeGreaterThanOrEqual(0.0298);
    expect(boundAfterCleanRuns(300)).toBeLessThan(0.01);
  });

  it("claims nothing from no runs", () => {
    expect(boundAfterCleanRuns(0)).toBe(1);
  });
});

describe("the verdict", () => {
  const passed = { passed: true, seconds: 60, failed: [] };

  it("states the count, and the bound a clean result gives", () => {
    const lines = summarise(
      Array.from({ length: 100 }, () => passed),
      4,
    );
    expect(lines.at(-1)).toBe("VERDICT: 0 of 100 runs failed (load 4)");
    expect(lines).toContain("BOUND: with no failure in 100 runs, the failure rate is below 3.0% (95% confidence)");
    expect(lines.join("\n")).not.toMatch(/FAILED TESTS/);
  });

  it("tallies which tests failed across runs, most frequent first, and claims no bound", () => {
    const lines = summarise(
      [
        passed,
        { passed: false, seconds: 61, failed: ["a > flaky", "b > also"] },
        passed,
        { passed: false, seconds: 90, failed: ["a > flaky"] },
      ],
      0,
    );
    expect(lines.at(-1)).toBe("VERDICT: 2 of 4 runs failed (load 0)");
    expect(lines).toContain("RATE: 50.0% of runs failed");
    const tally = lines.slice(
      lines.indexOf("FAILED TESTS, by how many runs each failed in:") + 1,
      lines.indexOf("RATE: 50.0% of runs failed"),
    );
    expect(tally.map((line) => line.trim())).toEqual(["2  a > flaky", "1  b > also"]);
    expect(lines.join("\n")).not.toMatch(/BOUND/);
  });

  it("says so when a run failed without naming a test: the command itself broke", () => {
    const lines = summarise([{ passed: false, seconds: 1, failed: [] }], 0);
    expect(lines.join("\n")).toContain("(no failing test named: the command itself failed)");
  });

  it("reports how long runs took, so a slow outlier is visible", () => {
    const lines = summarise(
      [
        { passed: true, seconds: 60, failed: [] },
        { passed: true, seconds: 70, failed: [] },
        { passed: true, seconds: 200, failed: [] },
      ],
      0,
    );
    expect(lines[0]).toBe("DURATION: min 60s, median 70s, max 200s");
  });
});
