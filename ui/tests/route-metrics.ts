// How many corners a laid-out drawing's wires take and how far they run, so "fewer bends" is measured, not eyeballed.
import { readFileSync } from "node:fs";
import { compile } from "../../ts/src/mermaid/index";
import { kindOfSource } from "../../ts/src/mermaid/preamble";
import { projectEnvelope, type GraphDirection, type ProjectedView } from "../src/diagrams/projection";
import type { LayoutPoint, LayoutResult } from "../src/layout/elk-adapter";

/**
 * One wire: the corners it actually turns, the fewest its two ends allow (`fewestBends`), and its length along the
 * drawn line.
 */
export type EdgeRouteMetrics = {
  readonly id: string;
  readonly bends: number;
  readonly fewest: number;
  readonly length: number;
};

export type RouteMetrics = {
  readonly edges: readonly EdgeRouteMetrics[];
  readonly totalBends: number;
  /** Corners beyond the fewest each wire's ends allow, summed: the needless ones a reader sees. */
  readonly excessBends: number;
  readonly maxBends: number;
  readonly totalLength: number;
  /** Places where two different wires cross. */
  readonly crossings: number;
  /** Points that change nothing drawn: a repeat of the point before, or one on the straight line through its neighbours. */
  readonly redundantPoints: number;
};

const same = (a: LayoutPoint, b: LayoutPoint): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/** The route without repeated points or points in the middle of a straight run. */
export function essentialPoints(points: readonly LayoutPoint[]): LayoutPoint[] {
  const distinct: LayoutPoint[] = [];
  for (const point of points)
    if (distinct.length === 0 || !same(distinct[distinct.length - 1], point)) distinct.push(point);
  const kept: LayoutPoint[] = [];
  for (const point of distinct) {
    while (kept.length >= 2) {
      const a = kept[kept.length - 2];
      const b = kept[kept.length - 1];
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x);
      const dot = (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y);
      // On the line and carrying on the same way: `b` is not a corner.
      if (Math.abs(cross) < 1e-6 && dot >= 0) kept.pop();
      else break;
    }
    kept.push(point);
  }
  return kept;
}

function lengthOf(points: readonly LayoutPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1)
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return length;
}

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/**
 * The fewest corners a wire needs given how its ends sit (owner, 2026-11-12; back-edges corrected by the lead the same
 * day): leaving and entering on perpendicular sides, one where the corner is ahead of both ends, else three; leaving
 * and entering the same way, none where its two boxes overlap across that way and the target lies ahead, two (a jog)
 * where it lies ahead without the overlap, four where it lies behind (a back-edge: out, across, back, across, in);
 * leaving and entering opposite ways (a U), two. Without boxes, its ends stand in for them.
 */
export function fewestBends(
  points: readonly LayoutPoint[],
  source?: Box,
  target?: Box,
  /** The drawing's flow: a wire whose target ranks above its source along it is a back-edge. */
  flow?: GraphDirection,
): number {
  const corners = essentialPoints(points);
  if (corners.length < 2) return 0;
  const a = corners[0]!;
  const b = corners[1]!;
  const y = corners[corners.length - 2]!;
  const z = corners[corners.length - 1]!;
  const out = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
  const into = { x: Math.sign(z.x - y.x), y: Math.sign(z.y - y.y) };
  if (flow !== undefined && source !== undefined && target !== undefined && isBackEdge(source, target, flow)) {
    // Against the flow it cannot run straight past the ranks between: leaving and entering the same way, it goes
    // out, round a side lane and back in (four); on perpendicular sides, three; on facing sides (a U), two.
    if (out.x * into.x + out.y * into.y === 0) return 3;
    return out.x === into.x && out.y === into.y ? 4 : 2;
  }
  if (out.x * into.x + out.y * into.y === 0) {
    // An L, where its one corner -- on the line out of the start and the line into the end -- is ahead of both;
    // otherwise the wire has to go round: three.
    const corner = out.x !== 0 ? { x: z.x, y: a.y } : { x: a.x, y: z.y };
    const aheadOfStart = (corner.x - a.x) * out.x + (corner.y - a.y) * out.y > 0;
    const beforeEnd = (z.x - corner.x) * into.x + (z.y - corner.y) * into.y > 0;
    return aheadOfStart && beforeEnd ? 1 : 3;
  }
  if (out.x !== into.x || out.y !== into.y) return 2;
  const s = source ?? { x: a.x, y: a.y, width: 0, height: 0 };
  const t = target ?? { x: z.x, y: z.y, width: 0, height: 0 };
  const horizontal = out.x !== 0;
  const overlap = horizontal
    ? Math.min(s.y + s.height, t.y + t.height) - Math.max(s.y, t.y)
    : Math.min(s.x + s.width, t.x + t.width) - Math.max(s.x, t.x);
  const ahead = horizontal ? (z.x - a.x) * out.x > 0 : (z.y - a.y) * out.y > 0;
  // A back-edge (its end behind its start, the way it leaves) goes out, across, back, across and in: four.
  if (!ahead) return 4;
  return overlap >= 0 ? 0 : 2;
}

/** The target ranks above the source in the flow: its middle lies behind the source's, the way the drawing runs. */
function isBackEdge(source: Box, target: Box, flow: GraphDirection): boolean {
  const middle = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const s = middle(source);
  const t = middle(target);
  switch (flow) {
    case "tb":
      return t.y < source.y && t.y < s.y;
    case "bt":
      return t.y > source.y + source.height && t.y > s.y;
    case "lr":
      return t.x < source.x && t.x < s.x;
    case "rl":
      return t.x > source.x + source.width && t.x > s.x;
  }
}

/** Whether segments ab and cd cross at a point inside both (touching ends do not count). */
function segmentsCross(a: LayoutPoint, b: LayoutPoint, c: LayoutPoint, d: LayoutPoint): boolean {
  const side = (p: LayoutPoint, q: LayoutPoint, r: LayoutPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return d1 * d2 < -1e-9 && d3 * d4 < -1e-9;
}

export function crossingsOf(layout: Pick<LayoutResult, "edges">): number {
  const routes = layout.edges.map((edge) => essentialPoints(edge.points));
  let count = 0;
  for (let i = 0; i < routes.length; i += 1)
    for (let j = i + 1; j < routes.length; j += 1)
      for (let p = 1; p < routes[i]!.length; p += 1)
        for (let q = 1; q < routes[j]!.length; q += 1)
          if (segmentsCross(routes[i]![p - 1]!, routes[i]![p]!, routes[j]![q - 1]!, routes[j]![q]!)) count += 1;
  return count;
}

export function routeMetrics(
  layout: Pick<LayoutResult, "edges"> & Partial<Pick<LayoutResult, "nodes" | "direction">>,
): RouteMetrics {
  const boxes = new Map((layout.nodes ?? []).map((node) => [node.id, node]));
  const edges = layout.edges.map((edge) => {
    const essential = essentialPoints(edge.points);
    return {
      id: edge.id,
      bends: Math.max(0, essential.length - 2),
      fewest: fewestBends(edge.points, boxes.get(edge.source), boxes.get(edge.target), layout.direction ?? "tb"),
      length: lengthOf(edge.points),
    };
  });
  const redundantPoints = layout.edges.reduce(
    (sum, edge) => sum + edge.points.length - essentialPoints(edge.points).length,
    0,
  );
  return {
    edges,
    totalBends: edges.reduce((sum, edge) => sum + edge.bends, 0),
    excessBends: edges.reduce((sum, edge) => sum + Math.max(0, edge.bends - edge.fewest), 0),
    crossings: crossingsOf(layout),
    maxBends: Math.max(0, ...edges.map((edge) => edge.bends)),
    totalLength: Math.round(edges.reduce((sum, edge) => sum + edge.length, 0)),
    redundantPoints,
  };
}

/** A Mermaid source, compiled and projected as the page draws it. */
export async function viewOfSource(source: string, id = "fixture"): Promise<ProjectedView> {
  const compiled = await compile(source);
  if (compiled.model === null) throw new Error(JSON.stringify(compiled.diagnostics));
  const projected = projectEnvelope({
    schemaVersion: 2,
    revision: `sha256:${"a".repeat(64)}`,
    view: { id, kind: kindOfSource(source), title: id },
    model: compiled.model,
  });
  if (!projected.ok || projected.type !== "graph")
    throw new Error(`${id}: expected a graph, got ${JSON.stringify(projected).slice(0, 300)}`);
  return projected.view;
}

export async function viewOfFile(path: string): Promise<ProjectedView> {
  return viewOfSource(
    readFileSync(path, "utf8"),
    path
      .split("/")
      .pop()
      ?.replace(/\.mmd$/, ""),
  );
}
