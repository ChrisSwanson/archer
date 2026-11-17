import { describe, expect, it } from "vitest";
import { computeLayout, LAYER_GAP, NODE_WIDTH, NODE_HEIGHT } from "../src/layout/elk-adapter";
import { toXFlowEdges, toXFlowNodes } from "../src/diagrams/xflow-adapter";
import type { ProjectedView } from "../src/diagrams/projection";

function view(overrides: Partial<ProjectedView> = {}): ProjectedView {
  return {
    viewId: "test-view",
    kind: "c4-context",
    title: "Test",
    revision: "1",
    modelType: "architecture-graph",
    nodes: [],
    edges: [],
    groups: [],
    ...overrides,
  };
}

const simpleView = view({
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: undefined },
    { id: "c", label: "C", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [
    { id: "e1", source: "a", target: "b", label: "calls" },
    { id: "e2", source: "b", target: "c", label: undefined },
  ],
});

const groupedView = view({
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: "g1" },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: "g1" },
    { id: "c", label: "C", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [{ id: "e1", source: "a", target: "b", label: undefined }],
  groups: [{ id: "g1", label: "Group 1", parentId: undefined }],
});

describe("computeLayout", () => {
  it("produces deterministic output", async () => {
    const first = await computeLayout(simpleView);
    const second = await computeLayout(simpleView);
    expect(second).toEqual(first);
  });

  it("handles empty view", async () => {
    const result = await computeLayout(view());
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it("positions groups containing their children", async () => {
    const result = await computeLayout(groupedView);
    expect(result.nodes).toHaveLength(3);

    const a = result.nodes.find((n) => n.id === "a")!;
    const b = result.nodes.find((n) => n.id === "b")!;
    const c = result.nodes.find((n) => n.id === "c")!;

    expect(a.groupId).toBe("g1");
    expect(b.groupId).toBe("g1");
    expect(c.groupId).toBeUndefined();

    for (const node of [a, b, c]) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.width).toBe(NODE_WIDTH);
      expect(node.height).toBe(NODE_HEIGHT);
    }
  });

  it("uses fixed node dimensions", async () => {
    const result = await computeLayout(simpleView);
    for (const node of result.nodes) {
      expect(node.width).toBe(NODE_WIDTH);
      expect(node.height).toBe(NODE_HEIGHT);
    }
  });

  it("leaves enough space between layers for edge labels and handles", async () => {
    const result = await computeLayout(simpleView);
    const a = result.nodes.find((node) => node.id === "a")!;
    const b = result.nodes.find((node) => node.id === "b")!;
    const c = result.nodes.find((node) => node.id === "c")!;

    expect(b.y - (a.y + a.height)).toBeGreaterThanOrEqual(LAYER_GAP);
    expect(c.y - (b.y + b.height)).toBeGreaterThanOrEqual(LAYER_GAP);
  });
});

describe("toXFlowNodes", () => {
  it("marks focused nodes", async () => {
    const layout = await computeLayout(simpleView);
    const nodes = toXFlowNodes(layout, { nodeIds: ["a"] });
    const a = nodes.find((n) => n.id === "a")!;
    const b = nodes.find((n) => n.id === "b")!;

    expect((a.data as { focused: boolean }).focused).toBe(true);
    expect((a.data as { dimmed: boolean }).dimmed).toBe(false);
    expect((b.data as { focused: boolean }).focused).toBe(false);
    expect((b.data as { dimmed: boolean }).dimmed).toBe(true);
  });

  it("without focus sets no dimming", async () => {
    const layout = await computeLayout(simpleView);
    const nodes = toXFlowNodes(layout);
    for (const node of nodes) {
      expect((node.data as { focused: boolean }).focused).toBe(false);
      expect((node.data as { dimmed: boolean }).dimmed).toBe(false);
    }
  });

  it("projects controlled node selection for persistent click feedback", async () => {
    const layout = await computeLayout(simpleView);
    const nodes = toXFlowNodes(layout, undefined, { nodeIds: ["a"] });

    expect(nodes.find((node) => node.id === "a")!.selected).toBe(true);
    expect(nodes.find((node) => node.id === "b")!.selected).toBe(false);
  });

  // Colour is not the adapter's job any more -- the base node theme lives in
  // `src/styles.css` and is covered by `canvas-theme.test.tsx`. The adapter
  // owns only what CSS cannot express: the ELK box and the focus opacity.
  it("carries the laid-out box and focus opacity, and no palette", async () => {
    const layout = await computeLayout(simpleView);
    const laidOut = layout.nodes.find((candidate) => candidate.id === "a")!;
    const node = toXFlowNodes(layout).find((candidate) => candidate.id === "a")!;

    expect(node.style).toEqual({
      width: laidOut.width,
      height: laidOut.height,
      opacity: 1,
    });
  });

  it("uses group labels (not IDs) for group nodes", async () => {
    const layout = await computeLayout(groupedView);
    const nodes = toXFlowNodes(layout);
    const groupNode = nodes.find((n) => n.id === "group:g1")!;
    expect(groupNode).toBeDefined();
    expect(groupNode.data.label).toBe("Group 1");
  });
});

describe("toXFlowEdges", () => {
  it("maps edge labels", async () => {
    const layout = await computeLayout(simpleView);
    const edges = toXFlowEdges(layout);
    const e1 = edges.find((e) => e.id === "e1")!;
    const e2 = edges.find((e) => e.id === "e2")!;

    expect(e1.label).toBe("calls");
    expect(e1.source).toBe("a");
    expect(e1.target).toBe("b");
    expect(e2.label).toBeUndefined();
    // Label colours moved to `src/styles.css`; see `canvas-theme.test.tsx`.
    expect(e1.selectable).toBe(true);
    expect(e1.interactionWidth).toBe(24);
    // NOT React Flow's own focusability. It would make every edge a tab stop,
    // announce it as a "group", and bind Enter to a store update this
    // controlled flow drops. The app owns the keyboard instead -- the stop is
    // the `tabIndex` below, the keys are handled on the canvas surface, and
    // `tests/edge-keyboard.test.tsx` proves the whole path.
    expect(e1.focusable).toBe(false);
    // No keyboard nav was passed, which is the shape of a canvas that has no
    // keyboard channel at all -- the last-valid drawing under an error banner
    // is the live case. It must make no claim it cannot honour: no `button`
    // role, no `aria-pressed`, no tab stop. `tests/review-remediation.test.tsx`
    // asserts the rendered consequence; the live canvas is covered by
    // `tests/edge-keyboard.test.tsx`.
    expect(e1.ariaRole).toBeUndefined();
    expect(e1.domAttributes).toBeUndefined();
  });

  it("projects controlled edge selection for persistent click feedback", async () => {
    const layout = await computeLayout(simpleView);
    const edges = toXFlowEdges(layout, undefined, { edgeIds: ["e1"] });

    expect(edges.find((edge) => edge.id === "e1")!.selected).toBe(true);
    expect(edges.find((edge) => edge.id === "e2")!.selected).toBe(false);
  });
});
