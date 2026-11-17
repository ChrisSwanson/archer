import { expect, it } from "vitest";
import { reuseUnchanged, sameValue } from "../src/diagrams/stable-items";

const node = (id: string, x: number, label = id) => ({
  id,
  position: { x, y: 0 },
  data: { label, classes: ["a"] },
  style: { width: 10 },
});

it("keeps every unchanged item's object and replaces only what changed", () => {
  const before = [node("a", 0), node("b", 10), node("c", 20)];
  const after = reuseUnchanged(before, [node("a", 0), node("b", 11), node("c", 20, "renamed")]);
  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(before[1]);
  expect(after[1]!.position.x).toBe(11);
  expect(after[2]!.data.label).toBe("renamed");
});

it("hands back the previous array when nothing changed, and a new one when items move, appear or go", () => {
  const before = [node("a", 0), node("b", 10)];
  expect(reuseUnchanged(before, [node("a", 0), node("b", 10)])).toBe(before);
  for (const next of [[node("b", 10), node("a", 0)], [node("a", 0)], [node("a", 0), node("b", 10), node("c", 0)]]) {
    const result = reuseUnchanged(before, next);
    expect(result).not.toBe(before);
    expect(result.map((item) => item.id)).toEqual(next.map((item) => item.id));
  }
});

it("compares plain data deeply and everything else by identity", () => {
  const f = () => {};
  expect(sameValue({ a: [1, { b: "x" }], f }, { a: [1, { b: "x" }], f })).toBe(true);
  expect(sameValue({ f }, { f: () => {} })).toBe(false);
  expect(sameValue({ a: undefined }, {})).toBe(false);
  expect(sameValue([1], { 0: 1 })).toBe(false);
  expect(sameValue(new Map(), new Map())).toBe(false);
  expect(sameValue(NaN, NaN)).toBe(true);
});

it("replaces an equal item the caller says is stale (React Flow mutated its internal copy)", () => {
  // React Flow's click selection writes `selected` into its INTERNAL node, which
  // a reused user object would keep: the canvas then shows a selection the page
  // never made (a Shift-click dropping the first node).
  const before = [node("a", 0), node("b", 10)];
  const after = reuseUnchanged(before, [node("a", 0), node("b", 10)], (old) => old.id !== "a");
  expect(after[0]).not.toBe(before[0]);
  expect(after[1]).toBe(before[1]);
  expect(after).not.toBe(before);
});
