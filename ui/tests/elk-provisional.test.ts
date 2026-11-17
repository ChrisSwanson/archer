// After an edit to a large graph the editor draws a provisional layout at
// once -- the last drawing with the change made in it -- and ELK's layout
// replaces it when it answers (perf #9: ~0.9 s of ELK per add on 150 nodes).
import { afterEach, expect, it, vi } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { ProjectedView } from "../src/diagrams/projection";
import { computeLayout } from "../src/layout/elk-adapter";
import { PROVISIONAL_MAX_CHANGES, PROVISIONAL_MIN_ELEMENTS, provisionalLayout } from "../src/layout/provisional-layout";
import { computeBackgroundLayout, resetBackgroundLayout } from "../src/layout/elk-worker-transport";
import { DEFAULT_TYPEFACE } from "../src/layout/text-measure";

vi.unmock("../src/layout/elk-worker-transport");
afterEach(() => {
  vi.unstubAllGlobals();
  resetBackgroundLayout();
});

/** A chain of `count` nodes, the first ten in a group. */
function chain(count: number): ProjectedView {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    label: `Node ${i}`,
    shape: "rectangle",
    classes: [],
    groupId: i < 10 ? "g" : undefined,
  }));
  const edges = nodes.slice(1).map((node, i) => ({
    id: `e${i}`,
    source: `n${i}`,
    target: node.id,
    label: i % 5 === 0 ? `step ${i}` : undefined,
  }));
  return {
    viewId: "authoring-preview",
    kind: "flowchart",
    title: "Chain",
    revision: "1",
    modelType: "freeform-graph",
    direction: "lr",
    nodes,
    edges,
    groups: [{ id: "g", label: "Group", parentId: undefined }],
  };
}
const large = chain(PROVISIONAL_MIN_ELEMENTS);
const added = (view: ProjectedView, id = "fresh"): ProjectedView => ({
  ...view,
  revision: "2",
  nodes: [...view.nodes, { id, label: "Process", shape: "rectangle", classes: [], groupId: undefined }],
});

it("draws an added top-level shape beside the last drawing, which keeps every other object", async () => {
  const before = await computeLayout(large);
  const next = added(large);
  const drawn = provisionalLayout({ view: large, layout: before }, next)!;
  expect(drawn).not.toBeNull();
  for (const node of before.nodes) expect(drawn.nodes.find((item) => item.id === node.id)).toBe(node);
  for (const edge of before.edges) expect(drawn.edges.find((item) => item.id === edge.id)).toBe(edge);
  expect(drawn.groups).toEqual(before.groups);
  const fresh = drawn.nodes.find((node) => node.id === "fresh")!;
  expect(fresh).toMatchObject({ label: "Process", groupId: undefined });
  // Clear of the drawing, inside the bounds it reports.
  for (const node of before.nodes) expect(fresh.y >= node.y + node.height || fresh.x >= node.x + node.width).toBe(true);
  expect(fresh.y + fresh.height).toBeLessThanOrEqual(drawn.height);
  expect(drawn.nodes.map((node) => node.id)).toEqual([...next.nodes].map((node) => node.id).sort());
});

it("drops a deleted shape and its wires, and draws a new wire straight until ELK routes it", async () => {
  const before = await computeLayout(large);
  const without: ProjectedView = {
    ...large,
    nodes: large.nodes.filter((node) => node.id !== "n40"),
    edges: [
      ...large.edges.filter((edge) => edge.source !== "n40" && edge.target !== "n40"),
      { id: "skip", source: "n39", target: "n41", label: "around" },
    ],
  };
  const drawn = provisionalLayout({ view: large, layout: before }, without)!;
  expect(drawn.nodes.some((node) => node.id === "n40")).toBe(false);
  expect(drawn.edges.some((edge) => edge.source === "n40" || edge.target === "n40")).toBe(false);
  expect(drawn.edges.find((edge) => edge.id === "skip")).toMatchObject({
    source: "n39",
    target: "n41",
    label: "around",
    points: [],
    labelAnchor: undefined,
  });
});

it("declines what it cannot draw faithfully: a resized or regrouped shape, a new group, a shape added inside one, many changes, a small graph", async () => {
  const before = await computeLayout(large);
  const last = { view: large, layout: before };
  const resized: ProjectedView = {
    ...large,
    nodes: large.nodes.map((node) =>
      node.id === "n50" ? { ...node, label: "A much longer label that needs a wider box than before" } : node,
    ),
  };
  expect(provisionalLayout(last, resized)).toBeNull();
  expect(
    provisionalLayout(last, { ...large, groups: [...large.groups, { id: "h", label: "New", parentId: undefined }] }),
  ).toBeNull();
  expect(
    provisionalLayout(last, {
      ...large,
      nodes: [...large.nodes, { id: "inside", label: "In", shape: "rectangle", classes: [], groupId: "g" }],
    }),
  ).toBeNull();
  expect(provisionalLayout(last, { ...large, direction: "tb" })).toBeNull();
  let many = large;
  for (let i = 0; i <= PROVISIONAL_MAX_CHANGES; i++) many = added(many, `fresh${i}`);
  expect(provisionalLayout(last, many)).toBeNull();
  const small = chain(10);
  expect(provisionalLayout({ view: small, layout: await computeLayout(small) }, added(small))).toBeNull();
  // Nothing changed that ELK sees: the cached layout answers, no provisional is needed.
  expect(provisionalLayout(last, { ...large, revision: "3" })).toBeNull();
});

type Request = { id: number; cmd: string; graph?: ElkNode };
const elk = new ELK();
/** A worker whose layouts wait until the test releases them. */
class HeldKernel {
  static last: HeldKernel | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror = null;
  onmessageerror = null;
  terminate = vi.fn();
  held: Request[] = [];
  constructor() {
    HeldKernel.last = this;
  }
  postMessage(message: Request) {
    if (message.cmd !== "layout")
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, data: [] } } as MessageEvent));
    else this.held.push(message);
  }
  async release() {
    for (const message of this.held.splice(0))
      this.onmessage?.({ data: { id: message.id, data: await elk.layout(message.graph!) } } as MessageEvent);
  }
}

it("hands the editor a provisional layout before ELK answers, then ELK's own", async () => {
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("Worker", HeldKernel);
  const first = computeBackgroundLayout(large, DEFAULT_TYPEFACE);
  await vi.waitFor(() => expect(HeldKernel.last!.held).toHaveLength(1));
  await HeldKernel.last!.release();
  const before = await first;
  const next = added(large);
  const provisional = vi.fn();
  const final = computeBackgroundLayout(next, DEFAULT_TYPEFACE, { provisional });
  expect(provisional).toHaveBeenCalledTimes(1);
  expect(provisional.mock.calls[0]![0]).toEqual(provisionalLayout({ view: large, layout: before }, next));
  await vi.waitFor(() => expect(HeldKernel.last!.held).toHaveLength(1));
  await HeldKernel.last!.release();
  expect(await final).toEqual(await computeLayout(next));
  // A layout already known is answered from the cache, with no provisional step.
  const again = vi.fn();
  await computeBackgroundLayout(next, DEFAULT_TYPEFACE, { provisional: again });
  expect(again).not.toHaveBeenCalled();
});

it("builds the next provisional layout on the one it handed out, while ELK is still busy", async () => {
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("Worker", HeldKernel);
  const first = computeBackgroundLayout(large, DEFAULT_TYPEFACE);
  await vi.waitFor(() => expect(HeldKernel.last!.held).toHaveLength(1));
  await HeldKernel.last!.release();
  await first;
  const one = added(large, "one");
  const firstProvisional = vi.fn();
  const pending = [computeBackgroundLayout(one, DEFAULT_TYPEFACE, { provisional: firstProvisional })];
  const two = added(one, "two");
  const secondProvisional = vi.fn();
  pending.push(computeBackgroundLayout(two, DEFAULT_TYPEFACE, { provisional: secondProvisional }));
  const drawn = secondProvisional.mock.calls[0]![0];
  expect(drawn.nodes.find((node: { id: string }) => node.id === "one")).toEqual(
    firstProvisional.mock.calls[0]![0].nodes.find((node: { id: string }) => node.id === "one"),
  );
  expect(drawn.nodes.some((node: { id: string }) => node.id === "two")).toBe(true);
  await vi.waitFor(() => expect(HeldKernel.last!.held).toHaveLength(2));
  await HeldKernel.last!.release();
  await Promise.all(pending);
});
