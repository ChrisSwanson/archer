// diagnosticsOf rewrites each line once, whatever the number of findings on
// it, and reports a bounded number of findings per line (server review S1: a
// one-line chain of 4000 edges took 96 s, rewriting the line once per finding).

import { expect, test } from "vitest";
import { error } from "../../src/mermaid/diagnostics.ts";
import { diagnosticsOf, MAX_FINDINGS_PER_LINE, rewriteLine, type Finding } from "../../src/mermaid/findings.ts";
import type { SourceLine } from "../../src/mermaid/source.ts";

const lineOf = (text: string, number = 2) => ({ number, text, indent: "" }) as unknown as SourceLine;

/** One finding per `x` in the line, each replacing its `x` with `y`. */
function findingsOn(line: SourceLine): Finding[] {
  const findings: Finding[] = [];
  for (let at = line.text.indexOf("x"); at !== -1; at = line.text.indexOf("x", at + 1)) {
    findings.push({
      diagnostic: error("unexpected_token", "x", {
        start: { line: line.number, column: at + 1 },
        end: { line: line.number, column: at + 2 },
      }),
      line,
      edits: [{ start: at, end: at + 1, replacement: "y" }],
      legacy: false,
    });
  }
  return findings;
}

test("every finding on a line carries the line with all of the line's fixes applied", () => {
  const line = lineOf("a x b x c");
  const diagnostics = diagnosticsOf(findingsOn(line));
  expect(diagnostics.map((d) => d.hint)).toEqual(["a y b y c", "a y b y c"]);
});

test("a line with thousands of findings is rewritten once, and reports a bounded number of them", () => {
  const line = lineOf(Array.from({ length: 20_000 }, () => "x").join(" "));
  const started = performance.now();
  const diagnostics = diagnosticsOf(findingsOn(line));
  expect(performance.now() - started).toBeLessThan(1000);
  expect(diagnostics).toHaveLength(MAX_FINDINGS_PER_LINE);
  expect(diagnostics[0]!.hint).toBe(Array.from({ length: 20_000 }, () => "y").join(" "));
});

test("findings on other lines are not bounded by one line's count", () => {
  const busy = findingsOn(lineOf("x ".repeat(100), 2));
  const other = findingsOn(lineOf("x", 3));
  expect(diagnosticsOf([...busy, ...other]).filter((d) => d.span.start.line === 3)).toHaveLength(1);
});

test("rewriteLine applies edits from the end, inserts included", () => {
  expect(
    rewriteLine("abc %% c", [
      { start: 3, end: 8, replacement: "" },
      { start: 0, end: 0, replacement: "%% c\n" },
    ]),
  ).toBe("%% c\nabc");
  expect(
    rewriteLine("aaaa", [
      { start: 1, end: 2, replacement: "XY" },
      { start: 3, end: 4, replacement: "Z" },
    ]),
  ).toBe("aXYaZ");
});
