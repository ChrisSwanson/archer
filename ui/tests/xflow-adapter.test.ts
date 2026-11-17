import { describe, expect, it } from "vitest";
import {
  toXFlowEdges,
  toXFlowNodes,
  withLabelField,
  type DiagramNodeData,
  type EmphasisRender,
} from "../src/diagrams/xflow-adapter";
import type { LayoutResult } from "../src/layout/elk-adapter";
import { DIMMED_OPACITY, FOCUSED_OPACITY } from "../src/diagrams/focus-style";
import { assignEmphasis, type Emphasis } from "../src/emphasis/contract";

const layout: LayoutResult = {
  nodes: [
    {
      id: "web",
      x: 0,
      y: 0,
      width: 180,
      height: 60,
      label: "Web",
      shape: undefined,
      classes: [],
      groupId: "backend",
    },
    {
      id: "api",
      x: 0,
      y: 100,
      width: 180,
      height: 60,
      label: "API",
      shape: undefined,
      classes: [],
      groupId: undefined,
    },
  ],
  edges: [{ id: "calls", source: "web", target: "api", label: "calls", points: [], labelAnchor: undefined }],
  groups: [{ id: "backend", label: "Backend", parentId: undefined, x: 0, y: 0, width: 240, height: 160 }],
  width: 200,
  height: 200,
};

/** An emphasis pointing at the elements the focus set below leaves out. */
const emphasisOutsideFocus: Emphasis = {
  id: "e1",
  viewId: "v1",
  title: "Outside",
  groups: [
    {
      id: "g1",
      style: "flow",
      palette: "teal",
      state: "existing",
      speed: "normal",
      label: "Path",
      description: "",
      nodes: ["api"],
      edges: ["calls"],
    },
  ],
};

const render = (emphasis: Emphasis): EmphasisRender => ({
  assignments: assignEmphasis(emphasis),
  isolated: null,
});

describe("xflow adapter", () => {
  it("emits a group node before its members and reparents them", () => {
    const nodes = toXFlowNodes(layout);
    expect(nodes.map((n) => n.id)).toEqual(["group:backend", "api", "web"]);

    const web = nodes.find((n) => n.id === "web")!;
    expect(web.parentId).toBe("group:backend");
    expect(web.extent).toBe("parent");

    const api = nodes.find((n) => n.id === "api")!;
    expect(api.parentId).toBeUndefined();
  });

  it("marks unfocused elements as dimmed when a focus set is active", () => {
    const nodes = toXFlowNodes(layout, { nodeIds: ["web"] });
    const data = (id: string): DiagramNodeData => nodes.find((n) => n.id === id)!.data as DiagramNodeData;

    expect(data("web").focused).toBe(true);
    expect(data("web").dimmed).toBe(false);
    expect(data("api").focused).toBe(false);
    expect(data("api").dimmed).toBe(true);
  });

  it("group container nodes are never dimmed", () => {
    // Deliberate omission, documented in src/diagrams/focus-style.ts: a group
    // node is chrome, can never appear in a focus set, and so carries no focus
    // state. Its members dim normally.
    const nodes = toXFlowNodes(layout, { nodeIds: ["api"] });
    const group = nodes.find((n) => n.id === "group:backend")!;

    expect(group.type).toBe("group");
    expect(group.data).not.toHaveProperty("dimmed");
    expect((group.style as { opacity?: number } | undefined)?.opacity).toBeUndefined();

    // ... while the member inside it does dim.
    const web = nodes.find((n) => n.id === "web")!;
    expect((web.data as DiagramNodeData).dimmed).toBe(true);
    expect((web.style as { opacity?: number }).opacity).toBe(DIMMED_OPACITY);
  });

  it("dims nothing when the focus set is empty", () => {
    const nodes = toXFlowNodes(layout, { nodeIds: [], edgeIds: [] });
    for (const node of nodes) {
      if ("dimmed" in node.data) {
        expect(node.data.dimmed).toBe(false);
        expect((node.style as { opacity?: number }).opacity).toBe(FOCUSED_OPACITY);
      }
    }
  });

  // ADR-0005: focus and emphasis are separate channels, and their intersection
  // is defined rather than incidental. Emphasis wins the opacity, because an
  // emphasised element drawn at 25% is the agent pointing at something the user
  // cannot see.
  it("does not dim an emphasised node that lies outside the focus set", () => {
    const nodes = toXFlowNodes(layout, { nodeIds: ["web"] }, undefined, render(emphasisOutsideFocus));
    const api = nodes.find((n) => n.id === "api")!;

    expect((api.data as DiagramNodeData).focused).toBe(false);
    expect((api.data as DiagramNodeData).dimmed).toBe(false);
    expect((api.style as { opacity?: number }).opacity).toBe(FOCUSED_OPACITY);
  });

  it("does not dim an emphasised edge that lies outside the focus set", () => {
    const edges = toXFlowEdges(layout, { nodeIds: ["web"] }, undefined, render(emphasisOutsideFocus));
    const calls = edges[0];

    expect(calls.data).toMatchObject({ focused: false, dimmed: false });
    expect((calls.style as { opacity?: number }).opacity).toBe(FOCUSED_OPACITY);
    expect((calls.labelStyle as { opacity?: number }).opacity).toBe(FOCUSED_OPACITY);
  });

  it("still dims an unemphasised element while a focus set is active", () => {
    // The exemption is for the emphasised element only; focus keeps its meaning
    // for everything the agent did not point at.
    const noOverlap: Emphasis = {
      ...emphasisOutsideFocus,
      groups: [{ ...emphasisOutsideFocus.groups[0], nodes: [], edges: [] }],
    };
    const nodes = toXFlowNodes(layout, { nodeIds: ["web"] }, undefined, render(noOverlap));
    const api = nodes.find((n) => n.id === "api")!;

    expect((api.data as DiagramNodeData).dimmed).toBe(true);
    expect((api.style as { opacity?: number }).opacity).toBe(DIMMED_OPACITY);
  });

  it("carries edge identity and focus state through", () => {
    const edges = toXFlowEdges(layout, { edgeIds: ["calls"] });
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe("calls");
    expect(edges[0].source).toBe("web");
    expect(edges[0].target).toBe("api");
    expect(edges[0].data).toMatchObject({ focused: true, dimmed: false });
  });

  it("states every node's laid-out size as already measured", () => {
    // Without `measured`, React Flow re-adopts each node of a new array as
    // never measured and drops its handle bounds, which unmounts every edge
    // until the next measurement -- see `measuredAs`. Groups included: they
    // are re-adopted with the same array.
    const nodes = toXFlowNodes(layout);
    expect(nodes.map((node) => [node.id, node.measured])).toEqual([
      ["group:backend", { width: 240, height: 160 }],
      ["api", { width: 180, height: 60 }],
      ["web", { width: 180, height: 60 }],
    ]);
  });
});

describe("a node holding its inline label field (axe nested-interactive, A9)", () => {
  const button = { id: "a", ariaRole: "button" as const, domAttributes: { tabIndex: 0, "aria-pressed": true } };
  it("is a group without a pressed claim while its field is open", () => {
    expect(withLabelField(button, "a")).toEqual({ id: "a", ariaRole: "group", domAttributes: { tabIndex: 0 } });
  });
  it("keeps the button contract for every other node, and once the field closes", () => {
    expect(withLabelField(button, "b")).toBe(button);
    expect(withLabelField(button, null)).toBe(button);
  });
});
