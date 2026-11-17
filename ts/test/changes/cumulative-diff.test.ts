import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cumulativeDiff, CumulativeDiffError, CUMULATIVE_DIFF_LIMITS } from "../../src/changes/cumulative-diff.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
for (const [name, before, after] of [
  [
    "context",
    "zero\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
    "zero\none\nTWO\nthree\nfour\nfive\nsix\nSEVEN\neight\n",
  ],
  ["new", null, "flowchart LR\n a[A]\n"],
  ["empty", null, ""],
  ["missing newline", "a\nb", "a\nchanged"],
  ["CRLF", "a\r\nb\r\n", "a\r\nB\r\n"],
  ["BOM", "\ufeffa\nb\n", "\ufeffA\nb\n"],
] as const)
  test(`cumulative ${name} diff applies to the exact latest bytes with git`, () => {
    const root = mkdtempSync(join(tmpdir(), "archer-cumulative-diff-"));
    roots.push(root);
    if (before !== null) writeFileSync(join(root, "diagram.mmd"), before);
    const diff = cumulativeDiff(before, after, "diagram.mmd");
    expect(diff.complete).toBe(true);
    expect(diff.netEffect).toBe("changed");
    writeFileSync(join(root, "change.patch"), diff.text);
    const applied = spawnSync("git", ["apply", "--allow-empty", "change.patch"], { cwd: root, encoding: "utf8" });
    expect(applied.status, applied.stderr + "\n" + diff.text).toBe(0);
    expect(readFileSync(join(root, "diagram.mmd"), "utf8")).toBe(after);
  });
test("no net change is explicit and contextual edits do not replace the whole source", () => {
  expect(cumulativeDiff("a\n", "a\n", "x.mmd")).toMatchObject({ text: "", netEffect: "none", added: 0, removed: 0 });
  const before = Array.from({ length: 50 }, (_, i) => `line${i}\n`).join("");
  const result = cumulativeDiff(before, before.replace("line25", "changed"), "x.mmd");
  expect(result).toMatchObject({ complete: true, algorithm: "myers", added: 1, removed: 1 });
  expect(result.text).toContain("@@ -23,7 +23,7 @@");
  expect(result.text).not.toContain("line0\n");
});
test("dense edits use bounded full replacement; oversized output is omitted explicitly", () => {
  const before = Array.from({ length: 400 }, (_, i) => `a${i}\n`).join(""),
    after = before.replaceAll("a", "b");
  expect(cumulativeDiff(before, after, "x.mmd")).toMatchObject({
    complete: true,
    algorithm: "whole-file-replacement",
    added: 400,
    removed: 400,
  });
  const large = cumulativeDiff("\n".repeat(262144), "a\n".repeat(131072), "x.mmd");
  expect(large.complete).toBe(false);
  expect(large.text).toBe("");
  expect(large.bytes).toBeGreaterThan(CUMULATIVE_DIFF_LIMITS.outputBytes);
});
test("invalid paths, malformed text and oversized sources are named refusals", () => {
  for (const [before, after, path] of [
    [null, "x", "bad\npath"],
    [null, "x".repeat(262145), "x"],
    [null, "\ud800", "x"],
    [1, "x", "x"],
    ["x", null, "x"],
  ] as const)
    expect(() => cumulativeDiff(before as any, after as any, path)).toThrow(CumulativeDiffError);
});
