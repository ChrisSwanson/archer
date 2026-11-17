// The canvas marks what has a comment thread: a class the stylesheet draws as
// a small mark, and words a screen reader hears with the element's name.
// Nothing is marked unless something is commented, so a page without the
// comments capability draws exactly what it always did.
import { describe, expect, it } from "vitest";
import { COMMENTED_CLASS, toXFlowEdges, toXFlowNodes } from "../src/diagrams/xflow-adapter";
import type { LayoutResult } from "../src/layout/elk-adapter";

const layout: LayoutResult = {
  nodes: [
    { id: "web", x: 0, y: 0, width: 180, height: 60, label: "Web", shape: undefined, classes: [], groupId: "backend" },
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

const commented = { nodeIds: new Set(["web"]), edgeIds: new Set(["calls"]), groupIds: new Set(["backend"]) };

describe("comment marks on the graph", () => {
  it("marks a commented node, edge and group, and only those", () => {
    const nodes = toXFlowNodes(layout, undefined, undefined, undefined, undefined, commented);
    const edges = toXFlowEdges(layout, undefined, undefined, undefined, undefined, commented);
    const classes = (id: string): string[] => (nodes.find((n) => n.id === id)?.className ?? "").split(" ");
    expect(classes("web")).toContain(COMMENTED_CLASS);
    expect(classes("group:backend")).toContain(COMMENTED_CLASS);
    expect(classes("api")).not.toContain(COMMENTED_CLASS);
    expect((edges[0]?.className ?? "").split(" ")).toContain(COMMENTED_CLASS);
  });

  it("says so in the element's accessible name", () => {
    const nodes = toXFlowNodes(layout, undefined, undefined, undefined, undefined, commented);
    const edges = toXFlowEdges(layout, undefined, undefined, undefined, undefined, commented);
    expect(nodes.find((n) => n.id === "web")?.ariaLabel).toBe("Web, in Backend, has comments");
    expect(nodes.find((n) => n.id === "api")?.ariaLabel).toBe("API");
    expect(edges[0]?.ariaLabel).toMatch(/, has comments$/);
  });

  it("draws exactly what it always did when nothing is commented", () => {
    expect(toXFlowNodes(layout)).toEqual(toXFlowNodes(layout, undefined, undefined, undefined, undefined, undefined));
    expect(toXFlowEdges(layout)).toEqual(toXFlowEdges(layout, undefined, undefined, undefined, undefined, undefined));
  });
});
