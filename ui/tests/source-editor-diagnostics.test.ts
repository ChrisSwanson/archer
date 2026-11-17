// Server diagnostics (one-based lines and Unicode-scalar columns, end exclusive) placed on the text.
import { expect, it } from "vitest";
import { fixLabel, placeDiagnostics, summarize } from "../src/source-editor/diagnostics";

const at = (line: number, column: number, endLine: number, endColumn: number) => ({
  start: { line, column },
  end: { line: endLine, column: endColumn },
});

it("places a span on its line and columns", () => {
  const text = "flowchart LR\n  a --> b\n  c -->";
  const [d] = placeDiagnostics(text, [{ code: "x", severity: "error", message: "bad", span: at(2, 3, 2, 4) }]);
  expect(text.slice(d.from, d.to)).toBe("a");
  expect(d).toMatchObject({ line: 2, severity: "error", message: "bad", code: "x" });
});

it("counts columns in Unicode scalars, not UTF-16 units", () => {
  const text = "flowchart LR\n  a[🙂 x] --> b";
  const [d] = placeDiagnostics(text, [{ severity: "warning", message: "w", span: at(2, 7, 2, 8) }]);
  expect(text.slice(d.from, d.to)).toBe("x");
  expect(d.severity).toBe("warning");
});

it("widens an empty span to the word there, or the line when at its end", () => {
  const text = "flowchart LR\n  a --> b";
  const [word, end] = placeDiagnostics(text, [
    { severity: "error", message: "m", span: at(2, 3, 2, 3) },
    { severity: "error", message: "m", span: at(2, 99, 2, 99) },
  ]);
  expect(text.slice(word.from, word.to)).toBe("a");
  expect(text.slice(end.from, end.to)).toBe("  a --> b");
});

it("clamps a line past the end, reads a bare `line`, drops what it cannot read, keeps the fix", () => {
  const text = "graph TD\nA-->B";
  const placed = placeDiagnostics(text, [
    { severity: "error", message: "past", span: at(9, 1, 9, 2) },
    { message: "refused", line: 2, code: "edit_requires_valid" },
    null,
    7,
    { severity: "error" },
    { severity: "error", message: "ids", span: at(2, 2, 2, 5), fix: { operation: "add-edge-ids" } },
  ]);
  expect(placed.map((d) => d.line)).toEqual([2, 2, 2]);
  expect(placed[1].severity).toBe("error");
  expect(placed[2].fix).toEqual({ operation: "add-edge-ids" });
  expect(text.slice(placed[2].from, placed[2].to)).toBe("-->");
  expect(summarize(placed)).toEqual({ errors: 3, warnings: 0, infos: 0 });
});

it("names fixes for a person", () => {
  expect(fixLabel({ operation: "add-edge-ids" })).toBe("Add edge IDs");
  expect(fixLabel({ operation: "wrap-edges" })).toBe("Wrap edges");
});
