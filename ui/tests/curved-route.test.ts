import { describe, expect, it } from "vitest";
import {
  CURVE_ARROW_APPROACH_PX,
  CURVE_CLEARANCE_PX,
  CURVE_RADIUS_PX,
  curvedRoute,
  curvedRoutes,
  type CurveBox,
} from "../src/diagrams/curved-route";
import type { RoutePoint } from "../src/diagrams/rounded-route";
import type { LayoutResult } from "../src/layout/elk-layout";

const NONE = { boxes: [], lines: [] };
const L_ROUTE: RoutePoint[] = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 200 },
];

/** Every number in a path's data, as points. */
function pathPoints(d: string): RoutePoint[] {
  const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const out: RoutePoint[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push({ x: n[i]!, y: n[i + 1]! });
  return out;
}

function minDistanceToBox(samples: readonly RoutePoint[], box: CurveBox): number {
  let best = Number.POSITIVE_INFINITY;
  for (const p of samples) {
    const dx = Math.max(box.x - p.x, 0, p.x - (box.x + box.width));
    const dy = Math.max(box.y - p.y, 0, p.y - (box.y + box.height));
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

const curves = (d: string): number => (d.match(/ C /g) ?? []).length;

describe("curvedRoute", () => {
  it("gives a corner with room on both runs the full radius, as one cubic", () => {
    const route = curvedRoute(L_ROUTE, NONE);
    expect(curves(route.d)).toBe(1);
    // The turn starts and ends the full radius from the corner.
    expect(route.d).toContain(`L ${200 - CURVE_RADIUS_PX},0 C`);
    expect(route.d.endsWith(`200,${CURVE_RADIUS_PX} L 200,200`)).toBe(true);
  });

  it("may take a line's whole tail run: the line still leaves its box head-on", () => {
    const route = curvedRoute(
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 200 },
      ],
      NONE,
    );
    expect(route.d.startsWith("M 0,0 L 0,0 C 16.57,0")).toBe(true);
  });

  it("keeps a U's two turns as two arcs, each taking at most half the run between them", () => {
    const route = curvedRoute(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 30 },
        { x: 0, y: 30 },
      ],
      NONE,
    );
    expect(curves(route.d)).toBe(2);
    expect(route.d).toContain("100,15 L 100,15 C");
  });

  it("keeps the curve clear of a box tucked into the turn, shrinking it until it is", () => {
    // A box inside the corner, 15px off each run: a 40px turn would pass within 5px of its corner.
    const box = { x: 150, y: 15, width: 35, height: 35 };
    const free = curvedRoute(L_ROUTE, NONE);
    expect(minDistanceToBox(free.samples, box)).toBeLessThan(CURVE_CLEARANCE_PX);
    const route = curvedRoute(L_ROUTE, { boxes: [box], lines: [] });
    expect(curves(route.d)).toBe(1);
    expect(minDistanceToBox(route.samples, box)).toBeGreaterThanOrEqual(CURVE_CLEARANCE_PX - 1);
  });

  it("leaves the endpoints where they are and the arrowhead's approach straight", () => {
    const route = curvedRoute(
      [
        { x: 0, y: 0 },
        { x: 60, y: 0 },
        { x: 60, y: 300 },
      ],
      NONE,
      { arrowStart: true, arrowEnd: true },
    );
    const points = pathPoints(route.d);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 60, y: 300 });
    // The head keeps its own approach (CURVE_ARROW_APPROACH_PX) at each end; the turn takes the full radius.
    expect(CURVE_ARROW_APPROACH_PX).toBe(14);
    expect(route.d).toContain(`L ${60 - CURVE_RADIUS_PX},0 C`);
    expect(route.straight.start).toBe(60 - CURVE_RADIUS_PX);
    expect(route.straight.end).toBe(300 - CURVE_RADIUS_PX);
    expect(route.straight.start).toBeGreaterThanOrEqual(CURVE_ARROW_APPROACH_PX);
  });

  it("sweeps a wide jog over to a box as one S, using the whole runs either side", () => {
    const route = curvedRoute(
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 150 },
        { x: 500, y: 150 },
      ],
      NONE,
      { arrowEnd: true },
    );
    expect(curves(route.d)).toBe(1);
    expect(route.d.startsWith("M 0,0 L 0,0 C")).toBe(true);
    expect(route.d.endsWith(`${500 - CURVE_ARROW_APPROACH_PX},150 L 500,150`)).toBe(true);
    expect(route.straight.end).toBe(CURVE_ARROW_APPROACH_PX);
  });

  it("does not curve the run under the line's own caption, so the caption stays on the line", () => {
    // A caption on the first run, 30px before the corner.
    const label = { x: 140, y: -8, width: 30, height: 16 };
    const route = curvedRoute(L_ROUTE, { boxes: [], lines: [], label });
    const start = pathPoints(route.d)[1]!;
    expect(start.y).toBe(0);
    expect(start.x).toBeGreaterThanOrEqual(label.x + label.width);
    // The caption's middle is still on a straight run of the drawn line.
    const middle = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
    expect(middle.y).toBe(0);
    expect(middle.x).toBeLessThan(start.x);
  });

  it("draws a Z jog as a single S-curve", () => {
    const route = curvedRoute(
      [
        { x: 0, y: 0 },
        { x: 150, y: 0 },
        { x: 150, y: 30 },
        { x: 300, y: 30 },
      ],
      NONE,
    );
    expect(curves(route.d)).toBe(1);
    // It leaves and rejoins heading along the flow: both handles are level with their ends.
    const [, a, b, c, e] = pathPoints(route.d);
    expect(b!.y).toBe(a!.y);
    expect(c!.y).toBe(e!.y);
    expect(a!.y).toBe(0);
    expect(e!.y).toBe(30);
  });

  it("keeps a crossing where it was, on a straight run at its own angle", () => {
    // Another wire crosses the vertical run 20px past the corner; a 40px turn would swallow that crossing.
    const other = [
      { x: 150, y: 70 },
      { x: 230, y: -10 },
    ];
    const crossingsOf = (samples: readonly RoutePoint[]) => {
      const at: RoutePoint[] = [];
      const [c, e] = other as [RoutePoint, RoutePoint];
      for (let i = 1; i < samples.length; i += 1) {
        const a = samples[i - 1]!;
        const b = samples[i]!;
        const den = (b.x - a.x) * (e.y - c.y) - (b.y - a.y) * (e.x - c.x);
        if (den === 0) continue;
        const t = ((c.x - a.x) * (e.y - c.y) - (c.y - a.y) * (e.x - c.x)) / den;
        const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) at.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      }
      return at;
    };
    const free = curvedRoute(L_ROUTE, NONE);
    expect(crossingsOf(free.samples)).not.toEqual([{ x: 200, y: 20 }]);
    const route = curvedRoute(L_ROUTE, { boxes: [], lines: [other] });
    expect(curves(route.d)).toBe(1);
    const crossings = crossingsOf(route.samples);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.x).toBeCloseTo(200, 6);
    expect(crossings[0]!.y).toBeCloseTo(20, 6);
  });

  it("is deterministic", () => {
    const route = [
      { x: 0, y: 0 },
      { x: 150, y: 0 },
      { x: 150, y: 30 },
      { x: 300, y: 30 },
      { x: 300, y: 200 },
    ];
    const obstacles = { boxes: [{ x: 240, y: 50, width: 40, height: 40 }], lines: [] };
    expect(curvedRoute(route, obstacles)).toEqual(curvedRoute(route, obstacles));
  });
});

describe("curvedRoutes", () => {
  const layout = (edges: LayoutResult["edges"]): LayoutResult => ({
    nodes: [
      {
        id: "a",
        label: "a",
        x: -100,
        y: -20,
        width: 100,
        height: 40,
        shape: undefined,
        classes: [],
        groupId: undefined,
      },
      { id: "b", label: "b", x: 160, y: 220, width: 80, height: 40, shape: undefined, classes: [], groupId: undefined },
      { id: "c", label: "c", x: 180, y: 20, width: 60, height: 40, shape: undefined, classes: [], groupId: undefined },
    ],
    edges,
    groups: [],
    width: 400,
    height: 300,
  });

  it("curves every line clear of every node, and is the same each time", () => {
    const l = layout([
      {
        id: "a--b",
        source: "a",
        target: "b",
        label: undefined,
        points: [
          { x: 0, y: 0 },
          { x: 140, y: 0 },
          { x: 140, y: 120 },
          { x: 200, y: 120 },
          { x: 200, y: 220 },
        ],
        labelAnchor: undefined,
      },
    ]);
    const first = curvedRoutes(l);
    expect(first).toEqual(curvedRoutes(l));
    const route = first.get("a--b")!;
    expect(curves(route.d)).toBeGreaterThan(0);
    // c sits above the second corner; nothing of the curve comes near it.
    expect(minDistanceToBox(route.samples, l.nodes[2]!)).toBeGreaterThanOrEqual(CURVE_CLEARANCE_PX - 1);
  });
});
