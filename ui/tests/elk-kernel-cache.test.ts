import { expect, it, vi } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { cachedKernel, KERNEL_CACHE_ENTRIES } from "../src/layout/elk-kernel-cache";
import { computeLayout } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";
import { DEFAULT_TYPEFACE } from "../src/layout/text-measure";

const view: ProjectedView = {
  viewId: "kernel",
  kind: "freeform",
  title: "Kernel",
  revision: "1",
  modelType: "freeform-graph",
  nodes: [
    { id: "a", label: "Alpha", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "Beta", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [{ id: "hop", source: "a", target: "b", label: "calls" }],
  groups: [],
};
const counting = () => {
  const real = new ELK();
  const layout = vi.fn((graph: ElkNode) => real.layout(graph));
  return { layout, kernel: cachedKernel({ layout }) };
};

it("a rename that keeps every box its size lays out without ELK, and draws the new words", async () => {
  const { layout, kernel } = counting();
  await computeLayout(view, DEFAULT_TYPEFACE, kernel);
  const runs = layout.mock.calls.length;
  // The same letters in another order, so the same width: "Alpha" → "Aplha"; "calls" → "clals" (an edge caption is
  // a label with text).
  const renamed: ProjectedView = {
    ...view,
    nodes: [{ ...view.nodes[0]!, label: "Aplha" }, view.nodes[1]!],
    edges: [{ ...view.edges[0]!, label: "clals" }],
  };
  const expected = await computeLayout(renamed);
  const actual = await computeLayout(renamed, DEFAULT_TYPEFACE, kernel);
  expect(actual).toEqual(expected);
  expect(layout.mock.calls.length).toBe(runs);
});

it("a change of size, a node or an edge runs ELK again", async () => {
  const { layout, kernel } = counting();
  await computeLayout(view, DEFAULT_TYPEFACE, kernel);
  let runs = layout.mock.calls.length;
  for (const changed of [
    { ...view, nodes: [{ ...view.nodes[0]!, label: "Alpha, now a much longer name that wraps" }, view.nodes[1]!] },
    { ...view, edges: [] },
    { ...view, nodes: [...view.nodes, { id: "c", label: "C", shape: undefined, classes: [], groupId: undefined }] },
  ] satisfies ProjectedView[]) {
    expect(await computeLayout(changed, DEFAULT_TYPEFACE, kernel)).toEqual(await computeLayout(changed));
    expect(layout.mock.calls.length).toBeGreaterThan(runs);
    runs = layout.mock.calls.length;
  }
});

it("keeps only the newest answers, hands each caller its own copy, and does not keep a refusal", async () => {
  let fail = true;
  const layout = vi.fn(async (graph: ElkNode) => {
    if (fail) throw new Error("refused");
    return { ...graph, x: 0 };
  });
  const kernel = cachedKernel({ layout }, 2);
  await expect(kernel.layout({ id: "g" })).rejects.toThrow("refused");
  fail = false;
  const first = await kernel.layout({ id: "g" });
  expect(layout).toHaveBeenCalledTimes(2);
  (first as { x?: number }).x = 99;
  expect(await kernel.layout({ id: "g" })).toEqual({ id: "g", x: 0 });
  expect(layout).toHaveBeenCalledTimes(2);
  await kernel.layout({ id: "h" });
  await kernel.layout({ id: "i" });
  await kernel.layout({ id: "g" });
  expect(layout).toHaveBeenCalledTimes(5);
  expect(KERNEL_CACHE_ENTRIES).toBeGreaterThan(2);
});
