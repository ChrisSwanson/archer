// Edge labels, treatment A (owner's choice, redesign slice 6): no plate. The words are italic in a softer ink and the
// line stops around them, the gap painted in the colour of whatever is behind -- the canvas, or the panel the label
// sits on -- so nothing reads as a box. On a family panel the words take the family's ink, never grey.
import { describe, expect, it } from "vitest";
import { toXFlowEdges } from "../src/diagrams/xflow-adapter";
import { paintGraph } from "../src/export/svg";
import type { LayoutResult } from "../src/layout/elk-layout";
import { EDGE_LABEL_PAD_X, EDGE_LABEL_PAD_Y } from "../src/layout/graph-metrics";
import { declarationsOf, readStylesheet, rulesOf } from "./stylesheet";

const CSS = readStylesheet();
const declared = (selector: string): Map<string, string> =>
  new Map(
    rulesOf(CSS)
      .filter((rule) => rule.selectors.includes(selector))
      .flatMap((rule) => declarationsOf(rule.body)),
  );

const edge = (id: string, x: number, y: number) => ({
  id,
  source: "a",
  target: "b",
  label: id,
  points: [
    { x, y: y - 60 },
    { x, y: y + 60 },
  ],
  labelAnchor: { x: x - 20, y: y - 10, width: 40, height: 20 },
});

const LAYOUT: LayoutResult = {
  nodes: [
    { id: "a", label: "A", x: 0, y: 0, width: 180, height: 60, shape: "rectangle", classes: [], groupId: undefined },
    { id: "b", label: "B", x: 0, y: 600, width: 180, height: 60, shape: "rectangle", classes: [], groupId: undefined },
  ],
  edges: [edge("onCanvas", 700, 100), edge("onOuter", 60, 300), edge("onInner", 200, 300), edge("onGpu", 500, 300)],
  groups: [
    { id: "outer", label: "Server", parentId: undefined, x: 20, y: 200, width: 640, height: 300 },
    { id: "inner", label: "Farm", parentId: "outer", x: 120, y: 240, width: 200, height: 200 },
    { id: "gpu", label: "GPU", parentId: "outer", x: 400, y: 240, width: 200, height: 200, classes: ["gpu"] },
  ],
  categories: [{ name: "gpu", fill: "#ecfdf5", stroke: "#0f766e" }],
  width: 800,
  height: 700,
};

describe("an edge label on the page", () => {
  it("has no plate: a 2px by 4px gap, square, italic and regular in the softer ink", () => {
    const label = declared(".archer-edge-label");
    expect(label.get("padding")).toBe(`${EDGE_LABEL_PAD_Y}px ${EDGE_LABEL_PAD_X}px`);
    expect(EDGE_LABEL_PAD_X).toBe(4);
    expect(label.has("border-radius")).toBe(false);
    expect(label.get("font-style")).toBe("italic");
    expect(label.get("font-weight")).toBe("400");
    expect(label.get("color")).toBe("var(--edge-label-ink)");
  });

  it("paints its gap in the colour of what is behind it, and on a family panel sets its words in the family's ink", () => {
    const by = new Map(toXFlowEdges(LAYOUT).map((e) => [e.id, e.data as { ground?: { fill: string; ink: string } }]));
    expect(by.get("onCanvas")?.ground).toEqual({ fill: "var(--bg)", ink: "var(--text-dim)" });
    expect(by.get("onOuter")?.ground).toEqual({ fill: "var(--group-bg)", ink: "var(--text-dim)" });
    expect(by.get("onInner")?.ground).toEqual({ fill: "var(--group-bg-alt)", ink: "var(--text-dim)" });
    expect(by.get("onGpu")?.ground).toEqual({ fill: "var(--family-teal-panel)", ink: "var(--family-teal-ink)" });
  });
});

describe("an edge label in the export", () => {
  const svg = paintGraph(LAYOUT).content;
  const labelOf = (id: string): string =>
    new RegExp(`data-element-id="${id}"[\\s\\S]*?(<rect [^>]*>)[\\s\\S]*?<g fill="([^"]*)"[^>]*font-style="italic"`)
      .exec(svg)!
      .slice(1)
      .join(" ");

  it("paints the same gap, square, and the same ink", () => {
    expect(labelOf("onCanvas")).toMatch(/fill="var\(--bg\)"[^>]*> var\(--text-dim\)/);
    expect(labelOf("onInner")).toMatch(/fill="var\(--group-bg-alt\)"[^>]*> var\(--text-dim\)/);
    expect(labelOf("onGpu")).toMatch(/fill="var\(--family-teal-panel\)"[^>]*> var\(--family-teal-ink\)/);
    expect(labelOf("onGpu")).toMatch(/rx="0"/);
  });
});

// A label that straddles a panel's edge (review, 2026-11-12): one fill picked from the label's middle painted a patch
// of the inner panel's colour over the outer one and erased the frame's line where it ran under the words. The gap is
// painted per region instead, each part in the colour behind it, and leaves the frame's line showing.
describe("an edge label across a panel's edge", () => {
  // `inner` runs x 120..320; this label spans x 100..140, across its left edge, and y 290..310 inside it.
  const across = { ...edge("across", 120, 300) };
  const layout: LayoutResult = { ...LAYOUT, edges: [across] };
  type Piece = { x: number; y: number; width: number; height: number; fill: string };
  const ground = () =>
    (toXFlowEdges(layout)[0]!.data as { ground?: { fill: string; ink: string; pieces?: Piece[] } }).ground!;

  it("paints each part of its gap in the colour behind that part", () => {
    const pieces = ground().pieces!;
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    const at = (x: number) => pieces.find((p) => x >= p.x && x <= p.x + p.width)?.fill;
    // Piece coordinates are the label's own: x 0 is the page's x 100.
    expect(at(5)).toBe("var(--group-bg)");
    expect(at(35)).toBe("var(--group-bg-alt)");
  });

  it("leaves the frame's line showing where it runs under the words", () => {
    // The frame's edge is at label x 20, its line 1.5px wide: no piece covers x 19.25..20.75.
    for (const piece of ground().pieces!) {
      expect(piece.x + piece.width <= 19.25 || piece.x >= 20.75, JSON.stringify(piece)).toBe(true);
      expect(piece.height).toBe(20);
    }
  });

  it("paints the same parts in the export", () => {
    const svg = paintGraph(layout).content;
    const at = svg.indexOf('data-element-id="across"');
    const rects = [...svg.slice(at, svg.indexOf("font-style", at)).matchAll(/<rect [^>]*>/g)].map((m) => m[0]);
    expect(rects.some((r) => r.includes('fill="var(--group-bg)"'))).toBe(true);
    expect(rects.some((r) => r.includes('fill="var(--group-bg-alt)"'))).toBe(true);
  });

  it("keeps one fill when the label sits wholly on one ground", () => {
    expect((toXFlowEdges(LAYOUT)[1]!.data as { ground?: { pieces?: unknown } }).ground?.pieces).toBeUndefined();
  });
});
