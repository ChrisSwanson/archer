import { describe, expect, it } from "vitest";
import { computeLayout } from "../src/layout/elk-adapter";
import type { LayoutEdge, LayoutNode, LayoutResult } from "../src/layout/elk-layout";
import { basisChain, chainPath, MERMAID_CLEARANCE_PX, mermaidCurves, sampleChain } from "../src/diagrams/mermaid-curve";
import type { RoutePoint } from "../src/diagrams/rounded-route";
import { viewOfSource } from "./route-metrics";

const CHRISTMAS = [
  "flowchart LR",
  "  A[Christmas] A_B@-->|Get money| B[Go shopping]",
  "  B B_C@--> C[Let me think]",
  "  C C_D@-->|One| D[Laptop]",
  "  C C_E@-->|Two| E[iPhone]",
  "  C C_F@-->|Three| F[Car]",
  "",
].join("\n");

type Box = { x: number; y: number; width: number; height: number };

const distanceToBox = (p: RoutePoint, box: Box): number =>
  Math.hypot(Math.max(box.x - p.x, 0, p.x - (box.x + box.width)), Math.max(box.y - p.y, 0, p.y - (box.y + box.height)));
const onBorder = (p: RoutePoint, box: Box): boolean =>
  distanceToBox(p, box) < 0.5 &&
  Math.min(
    Math.abs(p.x - box.x),
    Math.abs(p.x - box.x - box.width),
    Math.abs(p.y - box.y),
    Math.abs(p.y - box.y - box.height),
  ) < 0.5;
const toSegment = (p: RoutePoint, a: RoutePoint, b: RoutePoint): number => {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
  return Math.hypot(p.x - a.x - (b.x - a.x) * t, p.y - a.y - (b.y - a.y) * t);
};
const strictlyInside = (p: RoutePoint, box: Box): boolean =>
  p.x > box.x + 0.5 && p.x < box.x + box.width - 0.5 && p.y > box.y + 0.5 && p.y < box.y + box.height - 0.5;

async function christmas(): Promise<LayoutResult> {
  return computeLayout(await viewOfSource(CHRISTMAS, "christmas"));
}

const node = (id: string, x: number, y: number, width = 100, height = 40): LayoutNode => ({
  id,
  label: id,
  x,
  y,
  width,
  height,
  shape: "rectangle",
  classes: [],
  groupId: undefined,
});
const edge = (id: string, source: string, target: string, points: RoutePoint[]): LayoutEdge =>
  ({ id, source, target, points, label: undefined, labelAnchor: undefined }) as LayoutEdge;
const layoutOf = (nodes: LayoutNode[], edges: LayoutEdge[]): LayoutResult =>
  ({ nodes, edges, groups: [], width: 1000, height: 1000, direction: "lr" }) as unknown as LayoutResult;

describe("basisChain", () => {
  it("is d3's curveBasis written out as cubics", () => {
    // d3.line().curve(d3.curveBasis) of these points: M0,0L10,0C20,0,40,0,50,10C60,20,60,40,70,55C80,70,100,80,110,85L120,90
    const chain = basisChain([
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 120, y: 90 },
    ]);
    expect(chainPath(chain)).toBe(
      "M 0,0 C 3.33,0 6.67,0 10,0 C 20,0 40,0 50,10 C 60,20 60,40 70,55 C 80,70 100,80 110,85 C 113.33,86.67 116.67,88.33 120,90",
    );
  });

  it("samples a straight line about every 4px, so no long slanted chord stands in for it", () => {
    const samples = sampleChain([
      { x: 0, y: 0 },
      { x: 30, y: 40 },
    ]);
    expect(samples.length).toBeGreaterThanOrEqual(13);
    expect(samples[samples.length - 1]).toEqual({ x: 30, y: 40 });
  });
});

describe("mermaidCurves", () => {
  it("draws every line of a small flowchart as one gentle curve of pure cubics, box border to box border", async () => {
    const layout = await christmas();
    const drawing = mermaidCurves(layout);
    expect(drawing.lines.size).toBe(layout.edges.length);
    for (const e of layout.edges) {
      const line = drawing.lines.get(e.id)!;
      expect(line.kind).toBe("mermaid");
      expect(line.d).toMatch(/^M [-\d.]+,[-\d.]+( (C( [-\d.]+,[-\d.]+){3}|L [-\d.]+,[-\d.]+))+$/);
      const source = layout.nodes.find((n) => n.id === e.source)!;
      const target = layout.nodes.find((n) => n.id === e.target)!;
      expect(onBorder(line.samples[0]!, source)).toBe(true);
      expect(onBorder(line.samples[line.samples.length - 1]!, target)).toBe(true);
      for (const p of line.samples) for (const n of layout.nodes) expect(strictlyInside(p, n)).toBe(false);
    }
  });

  it("fans a box's lines out from its side at a slant, as Mermaid does, rather than in parallel runs", async () => {
    const layout = await christmas();
    const drawing = mermaidCurves(layout);
    // C's three lines leave C from different points, the outer two toward their targets.
    const starts = layout.edges
      .filter((e) => e.source === "C")
      .map((e) => drawing.lines.get(e.id)!.samples[0]!)
      .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`);
    expect(new Set(starts).size).toBe(3);
  });

  it("puts each caption on its own curve and clear of every box, caption and other line", async () => {
    const layout = await christmas();
    const drawing = mermaidCurves(layout);
    expect(drawing.unplaced).toEqual([]);
    for (const e of layout.edges.filter((x) => x.labelAnchor !== undefined)) {
      const label = drawing.labels.get(e.id)!;
      const centre = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
      const samples = drawing.lines.get(e.id)!.samples;
      const near = Math.min(...samples.slice(1).map((p, i) => toSegment(centre, samples[i]!, p)));
      expect(near).toBeLessThan(0.5);
      for (const n of layout.nodes) expect(distanceToBox(centre, n)).toBeGreaterThan(0);
    }
  });

  it("keeps a curve clear of a box it does not end on, borrowing route corners or falling back to curved corners", () => {
    // a and b share a row with blocker between them; the route climbs over it. Through the layer gaps alone, the
    // curve would come down across blocker's top.
    const nodes = [node("a", 0, 0), node("b", 400, 0), node("blocker", 140, -20, 120, 80)];
    const route = [
      { x: 100, y: 20 },
      { x: 120, y: 20 },
      { x: 120, y: -60 },
      { x: 380, y: -60 },
      { x: 380, y: 20 },
      { x: 400, y: 20 },
    ];
    const drawing = mermaidCurves(layoutOf(nodes, [edge("ab", "a", "b", route)]));
    const line = drawing.lines.get("ab")!;
    expect(["corners", "square"]).toContain(line.kind);
    for (const p of line.samples)
      expect(distanceToBox(p, nodes[2]!)).toBeGreaterThanOrEqual(MERMAID_CLEARANCE_PX - 0.5);
  });

  it("keeps the sides a line with stated ports leaves and enters by", () => {
    const nodes = [node("a", 0, 0), node("b", 300, 200)];
    const route = [
      { x: 100, y: 20 },
      { x: 200, y: 20 },
      { x: 200, y: 220 },
      { x: 300, y: 220 },
    ];
    const ports = {
      type: "ports",
      sourceSide: "right",
      targetSide: "left",
      sourceArrow: false,
      targetArrow: true,
      sourceGroup: false,
      targetGroup: false,
    } as const;
    const drawing = mermaidCurves(layoutOf(nodes, [{ ...edge("ab", "a", "b", route), figure: ports } as LayoutEdge]));
    const line = drawing.lines.get("ab")!;
    expect(line.samples[0]).toEqual({ x: 100, y: 20 });
    expect(line.samples[line.samples.length - 1]).toEqual({ x: 300, y: 220 });
  });
});
