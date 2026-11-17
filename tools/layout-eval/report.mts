/**
 * PROTOTYPE layout-quality calculator ("how convoluted is this drawing?").
 *
 * Lays a Mermaid flowchart out with the product engine (ELK + route-simplify, exactly what the page draws), then
 * measures the drawing and, with --suggest, tries source-level rewrites and reports the measured change each makes.
 * Feedback is phrased as Mermaid edits, never geometry, so an agent that cannot see the picture can still act on it.
 *
 *   npx tsx tools/layout-eval/report.mts <file.mmd> [--viewport 1025x896] [--suggest] [--json] [--svg out.svg]
 *
 * Run from ui/ (module resolution): cd ui && ../node_modules/.bin/tsx ../tools/layout-eval/report.mts ...
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { computeLayout, type LayoutResult, type LayoutPoint } from "../../ui/src/layout/elk-adapter";
import { routeMetrics, viewOfSource, essentialPoints, crossingsOf } from "../../ui/tests/route-metrics";

type Box = { x: number; y: number; width: number; height: number };
type Side = "N" | "E" | "S" | "W" | "?";

const READING_FLOOR_PX = 11; // the design's type floor (graph-metrics NODE_KIND_FONT_PX)
const EDGE_LABEL_PX = 13; // smallest routine text on a graph canvas (EDGE_LABEL_FONT_PX)
const GUTTER_PX = 24;

export type WireReport = {
  id: string;
  from: string;
  to: string;
  bends: number;
  fewest: number;
  excess: number;
  exit: Side;
  entry: Side;
  offFlow: boolean;
  borderCrossings: number;
  requiredBorderCrossings: number;
  detour: number; // drawn length / manhattan distance between its ends
};

export type Report = {
  file: string;
  direction: string;
  nodes: number;
  wires: number;
  groups: number;
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  fitZoom: number;
  labelPxAtFit: number;
  bends: number;
  excessBends: number;
  /**
   * Pair lines with corners: a line that is its source's only outgoing line and its target's only incoming one. Such
   * a pair can face each other and be joined straight (the owner's Data Sources screenshot, 2026-11-15), so a corner
   * on one is a sign of box ORDER, which needless bends cannot see (they are measured with the boxes where they sit).
   * A signal, not a proof: other lines can still compete for the same row.
   */
  bentPairLines: number;
  excessPerWire: number;
  maxBends: number;
  crossings: number;
  /** Crossings at under 45 degrees, which count double: shallow crossings slow tracing. */
  acuteCrossings: number;
  minCrossingAngle: number | null;
  crossingsPerWire: number;
  offFlowEnds: number;
  extraBorderCrossings: number;
  throughNode: string[];
  labelOverlaps: string[];
  maxFanIn: { node: string; count: number };
  congestion: Omit<Congestion, "windows">;
  score: number;
  valid: boolean;
  grade: string;
  penalties: Record<string, number>;
  worstWires: WireReport[];
  wiresDetail: WireReport[];
};

// ---------------------------------------------------------------- congestion ("junctions")
//
// Totals cannot tell three crossings spread over a drawing from three crossings stacked in one place, yet the stack is
// what a reader gets lost in: many lines turning and crossing in a small area, with nothing to say which line is which.
// So the drawing is cut into cells and every WINDOW of cells (about the size of the eye's focus at reading zoom) is
// asked: how many different wires pass through here, and how many corners and crossings happen here? A window busy on
// both counts is a hotspot; touching hotspots merge into one junction, reported with the wires that form it.

const CELL_PX = 40;
const WINDOW_CELLS = 3; // a 120 px window
const HOTSPOT_WIRES = 6; // at least this many different wires in one window ...
const HOTSPOT_EVENTS = 6; // ... and at least this many corners + crossings
/** Parallel runs of different wires closer than this ON SCREEN (at the target screen's fit zoom) read as one line. */
const TIGHT_GAP_SCREEN_PX = 6;
const TIGHT_MIN_OVERLAP_PX = 24;
/** The renderer's corner radius (ui/src/diagrams/rounded-route.ts CORNER_RADIUS_PX). */
const CORNER_RADIUS_PX = 10;
/** A rounded corner needs at least this much on screen to read as a curve, not a square corner. */
const VISIBLE_RADIUS_SCREEN_PX = 5;
const AMBIGUOUS_SCREEN_PX = 8;

export type Junction = {
  x: number;
  y: number;
  width: number;
  height: number;
  wires: string[];
  corners: number;
  crossings: number;
};
export type Congestion = {
  /** The most different wires in any one window. */
  peakWires: number;
  /** The most corners + crossings in any one window. */
  peakEvents: number;
  junctions: Junction[];
  /** Corners + crossings inside junctions: how much of the drawing's turning happens in a knot. */
  junctionLoad: number;
  /** Pairs of different wires' parallel runs closer than TIGHT_GAP_SCREEN_PX on the target screen, over a real length. */
  tightRuns: number;
  /** Segments between two corners too short, on screen, to show both rounded corners: a staircase. */
  shortJogs: number;
  /** Corners within AMBIGUOUS_SCREEN_PX (on screen) of another wire's corner or crossing: turn vs. cross is unclear. */
  ambiguousTurns: number;
  /** Per window: wires and events, for the overlay heat map. */
  windows: { x: number; y: number; wires: number; events: number }[];
};

export function congestionOf(layout: LayoutResult, fitZoom = 1): Congestion {
  const tightGap = TIGHT_GAP_SCREEN_PX / Math.max(0.05, fitZoom);
  type Cell = { wires: Set<string>; corners: number; crossings: number };
  const cells = new Map<string, Cell>();
  const at = (cx: number, cy: number) => {
    const k = `${cx},${cy}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { wires: new Set(), corners: 0, crossings: 0 }));
    return c;
  };
  const cellOf = (p: LayoutPoint) => [Math.floor(p.x / CELL_PX), Math.floor(p.y / CELL_PX)] as const;
  const routes = layout.edges.map((e) => ({ id: e.id, pts: essentialPoints(e.points) }));
  for (const { id, pts } of routes) {
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL_PX / 4)));
      for (let s = 0; s <= steps; s += 1) {
        const [cx, cy] = cellOf({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
        at(cx, cy).wires.add(id);
      }
    }
    // Turning, in quarter turns, where it happens: an orthogonal corner is 1, a curve adds up its sweep.
    const turns = turnsOf(pts);
    pts.slice(1, -1).forEach((p, k) => {
      const [cx, cy] = cellOf(p);
      at(cx, cy).corners += turns[k]! / 90;
    });
  }
  for (let i = 0; i < routes.length; i += 1)
    for (let j = i + 1; j < routes.length; j += 1)
      for (let p = 1; p < routes[i]!.pts.length; p += 1)
        for (let q = 1; q < routes[j]!.pts.length; q += 1) {
          const x = crossPoint(routes[i]!.pts[p - 1]!, routes[i]!.pts[p]!, routes[j]!.pts[q - 1]!, routes[j]!.pts[q]!);
          if (x) {
            const [cx, cy] = cellOf(x);
            at(cx, cy).crossings += 1;
          }
        }

  // Windows anchored at every occupied cell's neighbourhood.
  const anchors = new Set<string>();
  for (const k of cells.keys()) {
    const [cx, cy] = k.split(",").map(Number) as [number, number];
    for (let dx = 0; dx < WINDOW_CELLS; dx += 1)
      for (let dy = 0; dy < WINDOW_CELLS; dy += 1) anchors.add(`${cx - dx},${cy - dy}`);
  }
  const windows: Congestion["windows"] = [];
  const hot: { cx: number; cy: number }[] = [];
  let peakWires = 0;
  let peakEvents = 0;
  for (const k of anchors) {
    const [ax, ay] = k.split(",").map(Number) as [number, number];
    const wires = new Set<string>();
    let events = 0;
    for (let dx = 0; dx < WINDOW_CELLS; dx += 1)
      for (let dy = 0; dy < WINDOW_CELLS; dy += 1) {
        const c = cells.get(`${ax + dx},${ay + dy}`);
        if (!c) continue;
        for (const w of c.wires) wires.add(w);
        events += c.corners + c.crossings;
      }
    peakWires = Math.max(peakWires, wires.size);
    peakEvents = Math.max(peakEvents, events);
    if (wires.size >= 3 || events >= 3) windows.push({ x: ax * CELL_PX, y: ay * CELL_PX, wires: wires.size, events });
    if (wires.size >= HOTSPOT_WIRES && events >= HOTSPOT_EVENTS) hot.push({ cx: ax, cy: ay });
  }

  // Merge hot windows that touch or overlap into junctions; count each cell's events once.
  const seen = new Set<number>();
  const junctions: Junction[] = [];
  for (let i = 0; i < hot.length; i += 1) {
    if (seen.has(i)) continue;
    const group = [i];
    seen.add(i);
    for (let g = 0; g < group.length; g += 1)
      for (let j = 0; j < hot.length; j += 1)
        if (
          !seen.has(j) &&
          Math.abs(hot[j]!.cx - hot[group[g]!]!.cx) <= WINDOW_CELLS &&
          Math.abs(hot[j]!.cy - hot[group[g]!]!.cy) <= WINDOW_CELLS
        ) {
          seen.add(j);
          group.push(j);
        }
    const covered = new Set<string>();
    for (const h of group.map((n) => hot[n]!))
      for (let dx = 0; dx < WINDOW_CELLS; dx += 1)
        for (let dy = 0; dy < WINDOW_CELLS; dy += 1) covered.add(`${h.cx + dx},${h.cy + dy}`);
    const wires = new Set<string>();
    let corners = 0;
    let crossings = 0;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const k of covered) {
      const [cx, cy] = k.split(",").map(Number) as [number, number];
      minX = Math.min(minX, cx);
      minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx);
      maxY = Math.max(maxY, cy);
      const c = cells.get(k);
      if (!c) continue;
      for (const w of c.wires) wires.add(w);
      corners += c.corners;
      crossings += c.crossings;
    }
    junctions.push({
      x: minX * CELL_PX,
      y: minY * CELL_PX,
      width: (maxX - minX + 1) * CELL_PX,
      height: (maxY - minY + 1) * CELL_PX,
      wires: [...wires].sort(),
      corners,
      crossings,
    });
  }
  junctions.sort((a, b) => b.corners + b.crossings - (a.corners + a.crossings));

  // Near-coincident parallel runs of different wires.
  let tightRuns = 0;
  const segs = routes.flatMap(({ id, pts }) =>
    pts.slice(1).map((b, i) => ({ id, a: pts[i]!, b, horizontal: Math.abs(b.y - pts[i]!.y) < 0.5 })),
  );
  for (let i = 0; i < segs.length; i += 1)
    for (let j = i + 1; j < segs.length; j += 1) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (s.id === t.id || s.horizontal !== t.horizontal) continue;
      const gap = s.horizontal ? Math.abs(s.a.y - t.a.y) : Math.abs(s.a.x - t.a.x);
      if (gap >= tightGap) continue;
      const [s0, s1] = s.horizontal
        ? [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)]
        : [Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y)];
      const [t0, t1] = t.horizontal
        ? [Math.min(t.a.x, t.b.x), Math.max(t.a.x, t.b.x)]
        : [Math.min(t.a.y, t.b.y), Math.max(t.a.y, t.b.y)];
      if (Math.min(s1, t1) - Math.max(s0, t0) >= TIGHT_MIN_OVERLAP_PX) tightRuns += 1;
    }

  // Staircases: a jog between two corners must hold both corners' curves at a visible size on screen.
  const minJog = 2 * Math.max(CORNER_RADIUS_PX, VISIBLE_RADIUS_SCREEN_PX / Math.max(0.05, fitZoom));
  let shortJogs = 0;
  for (const { pts } of routes) {
    const turns = turnsOf(pts);
    for (let i = 2; i < pts.length - 1; i += 1)
      if (
        turns[i - 2]! >= SHARP_DEG &&
        turns[i - 1]! >= SHARP_DEG &&
        Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y) < minJog
      )
        shortJogs += 1;
  }
  // Ambiguous turns: a corner sitting on another wire's corner or crossing.
  const near = AMBIGUOUS_SCREEN_PX / Math.max(0.05, fitZoom);
  const sharp = (pts: readonly LayoutPoint[]) => {
    const turns = turnsOf(pts);
    return pts.slice(1, -1).filter((_, k) => turns[k]! >= SHARP_DEG);
  };
  const events: { id: string; p: LayoutPoint }[] = routes.flatMap(({ id, pts }) => sharp(pts).map((p) => ({ id, p })));
  for (let i = 0; i < routes.length; i += 1)
    for (let j = i + 1; j < routes.length; j += 1)
      for (let p = 1; p < routes[i]!.pts.length; p += 1)
        for (let q = 1; q < routes[j]!.pts.length; q += 1) {
          const x = crossPoint(routes[i]!.pts[p - 1]!, routes[i]!.pts[p]!, routes[j]!.pts[q - 1]!, routes[j]!.pts[q]!);
          if (x) events.push({ id: `${routes[i]!.id}|${routes[j]!.id}`, p: x });
        }
  let ambiguousTurns = 0;
  for (const { id, pts } of routes)
    for (const c of sharp(pts))
      if (events.some((e) => !e.id.split("|").includes(id) && Math.hypot(e.p.x - c.x, e.p.y - c.y) < near))
        ambiguousTurns += 1;

  const junctionLoad = Math.round(junctions.reduce((s, j) => s + j.corners + j.crossings, 0));
  return { peakWires, peakEvents, junctions, junctionLoad, tightRuns, shortJogs, ambiguousTurns, windows };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** The heading change at each interior point of a route, in degrees (0 on a straight run, 90 at an orthogonal corner). */
export function turnsOf(points: readonly LayoutPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = Math.atan2(points[i]!.y - points[i - 1]!.y, points[i]!.x - points[i - 1]!.x);
    const b = Math.atan2(points[i + 1]!.y - points[i]!.y, points[i + 1]!.x - points[i]!.x);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = 2 * Math.PI - d;
    out.push((d * 180) / Math.PI);
  }
  return out;
}
/** A route that is not all horizontal and vertical runs: a curve, sampled. */
const isCurved = (points: readonly LayoutPoint[]) =>
  points.some((p, i) => i > 0 && Math.abs(p.x - points[i - 1]!.x) > 0.5 && Math.abs(p.y - points[i - 1]!.y) > 0.5);
/** A turn that reads as a corner (on a sampled curve each sample turns a few degrees; only sharp ones count). */
const SHARP_DEG = 45;
const overlaps = (a: Box, b: Box, pad = 0) =>
  a.x + a.width > b.x + pad && b.x + b.width > a.x + pad && a.y + a.height > b.y + pad && b.y + b.height > a.y + pad;
const segBox = (a: LayoutPoint, b: LayoutPoint): Box => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

function sideOf(n: Box, p: LayoutPoint): Side {
  const e = 2;
  if (Math.abs(p.x - n.x) < e) return "W";
  if (Math.abs(p.x - (n.x + n.width)) < e) return "E";
  if (Math.abs(p.y - n.y) < e) return "N";
  if (Math.abs(p.y - (n.y + n.height)) < e) return "S";
  return "?";
}
const FLOW: Record<string, { exit: Side; entry: Side; axis: "x" | "y"; sign: 1 | -1 }> = {
  lr: { exit: "E", entry: "W", axis: "x", sign: 1 },
  rl: { exit: "W", entry: "E", axis: "x", sign: -1 },
  tb: { exit: "S", entry: "N", axis: "y", sign: 1 },
  bt: { exit: "N", entry: "S", axis: "y", sign: -1 },
};

/** How many times a polyline passes a rectangle's outline. */
function outlinePasses(points: readonly LayoutPoint[], g: Box): number {
  const inside = (p: LayoutPoint) => p.x > g.x && p.x < g.x + g.width && p.y > g.y && p.y < g.y + g.height;
  let passes = 0;
  for (let i = 1; i < points.length; i += 1) if (inside(points[i - 1]!) !== inside(points[i]!)) passes += 1;
  return passes;
}

export function measure(file: string, layout: LayoutResult, viewport = { width: 1025, height: 896 }): Report {
  const direction = layout.direction ?? "tb";
  const flow = FLOW[direction]!;
  const m = routeMetrics(layout);
  const nodes = new Map(layout.nodes.map((n) => [n.id, n]));
  const groupsById = new Map(layout.groups.map((g) => [g.id, g]));
  const chain = (id: string | undefined): string[] => {
    const out: string[] = [];
    for (let g = id; g !== undefined; g = groupsById.get(g)?.parentId) out.push(g);
    return out;
  };
  const inDegree = new Map<string, number>();
  const wires: WireReport[] = layout.edges.map((e) => {
    const s = nodes.get(e.source)!;
    const t = nodes.get(e.target)!;
    const pts = essentialPoints(e.points);
    const em = m.edges.find((x) => x.id === e.id)!;
    const exit = s ? sideOf(s, pts[0]!) : "?";
    const entry = t ? sideOf(t, pts[pts.length - 1]!) : "?";
    const sc = s.x + s.width / 2;
    const tc = t.x + t.width / 2;
    const forward = flow.axis === "x" ? (tc - sc) * flow.sign > 0 : (t.y - s.y) * flow.sign > 0;
    const offFlow = forward && (exit !== flow.exit || entry !== flow.entry);
    const sg = new Set(chain(s.groupId));
    const tg = new Set(chain(t.groupId));
    const required = [...sg].filter((g) => !tg.has(g)).length + [...tg].filter((g) => !sg.has(g)).length;
    const passes = layout.groups.reduce((sum, g) => sum + outlinePasses(pts, g), 0);
    const a = pts[0]!;
    const z = pts[pts.length - 1]!;
    const manhattan = Math.abs(a.x - z.x) + Math.abs(a.y - z.y) || 1;
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    // A curve has no corners to count: its bends are its total turning in quarter turns, which is the corner count
    // for an orthogonal route, so the two styles are compared on one scale.
    const bends = isCurved(pts) ? Math.round(turnsOf(pts).reduce((a, b) => a + b, 0) / 90) : em.bends;
    return {
      id: e.id,
      from: e.source,
      to: e.target,
      bends,
      fewest: em.fewest,
      excess: Math.max(0, bends - em.fewest),
      exit,
      entry,
      offFlow,
      borderCrossings: passes,
      requiredBorderCrossings: required,
      detour: Math.round((em.length / manhattan) * 100) / 100,
    };
  });

  const throughNode: string[] = [];
  // A slanted chord's bounding box covers ground the chord never touches, so a slanted chord must itself meet the
  // (padded) box: Liang-Barsky clipping. An axis-aligned chord is its own bounding box.
  const chordMeets = (a: { x: number; y: number }, b: { x: number; y: number }, n: Box, pad: number): boolean => {
    if (!overlaps(segBox(a, b), n, pad)) return false;
    if (Math.abs(a.x - b.x) <= 0.5 || Math.abs(a.y - b.y) <= 0.5) return true;
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (const [p, q] of [
      [-dx, a.x - (n.x - pad)],
      [dx, n.x + n.width + pad - a.x],
      [-dy, a.y - (n.y - pad)],
      [dy, n.y + n.height + pad - a.y],
    ] as const) {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    return t0 < t1;
  };
  for (const e of layout.edges) {
    const pts = essentialPoints(e.points);
    for (let i = 1; i < pts.length; i += 1)
      for (const n of layout.nodes)
        if (n.id !== e.source && n.id !== e.target && chordMeets(pts[i - 1]!, pts[i]!, n, 1))
          throughNode.push(`${e.id} runs through ${n.id}`);
  }
  const labelOverlaps: string[] = [];
  const labelled = layout.edges.filter((e) => e.labelAnchor !== undefined);
  for (const e of labelled) {
    for (const n of layout.nodes) if (overlaps(e.labelAnchor!, n, 1)) labelOverlaps.push(`label of ${e.id} on ${n.id}`);
    for (const f of labelled)
      if (f.id > e.id && overlaps(e.labelAnchor!, f.labelAnchor!, 1))
        labelOverlaps.push(`labels of ${e.id} and ${f.id} overlap`);
    for (const f of layout.edges) {
      if (f.id === e.id) continue;
      const pts = essentialPoints(f.points);
      for (let i = 1; i < pts.length; i += 1)
        if (overlaps(segBox(pts[i - 1]!, pts[i]!), e.labelAnchor!, 2)) {
          labelOverlaps.push(`label of ${e.id} crossed by ${f.id}`);
          break;
        }
    }
  }

  const width = Math.round(layout.width);
  const height = Math.round(layout.height);
  const fitZoom = Math.min(1, (viewport.width - 2 * GUTTER_PX) / width, (viewport.height - 2 * GUTTER_PX) / height);
  const labelPxAtFit = Math.round(EDGE_LABEL_PX * fitZoom * 10) / 10;
  const n = Math.max(1, wires.length);
  const excess = wires.reduce((s, w) => s + w.excess, 0);
  const outDeg = new Map<string, number>(),
    inDeg = new Map<string, number>();
  for (const e of layout.edges) {
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }
  const bentPairLines = wires.filter(
    (w) => w.from !== w.to && outDeg.get(w.from) === 1 && inDeg.get(w.to) === 1 && w.bends > 0,
  ).length;
  const totalBends = wires.reduce((s, w) => s + w.bends, 0);
  const maxBends = Math.max(0, ...wires.map((w) => w.bends));
  // Crossing angles: small ones slow path tracing (Huang 2008; Huang, Eades & Hong 2014). Orthogonal ones are all 90.
  const angles: number[] = [];
  {
    const rs = layout.edges.map((e) => essentialPoints(e.points));
    for (let i = 0; i < rs.length; i += 1)
      for (let j = i + 1; j < rs.length; j += 1)
        for (let p = 1; p < rs[i]!.length; p += 1)
          for (let q = 1; q < rs[j]!.length; q += 1) {
            const a = rs[i]![p - 1]!,
              b = rs[i]![p]!,
              c = rs[j]![q - 1]!,
              d = rs[j]![q]!;
            if (!crossPoint(a, b, c, d)) continue;
            const u = Math.atan2(b.y - a.y, b.x - a.x),
              v = Math.atan2(d.y - c.y, d.x - c.x);
            let t = Math.abs(u - v) % Math.PI;
            if (t > Math.PI / 2) t = Math.PI - t;
            angles.push((t * 180) / Math.PI);
          }
  }
  const crossings = angles.length;
  const acuteCrossings = angles.filter((a) => a < 45).length;
  const offFlowEnds = wires.filter((w) => w.offFlow).length;
  const extraBorderCrossings = wires.reduce(
    (s, w) => s + Math.max(0, w.borderCrossings - w.requiredBorderCrossings),
    0,
  );
  const fan = [...inDegree.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];

  const jam = congestionOf(layout, fitZoom);
  // Prototype weights: 100 is a drawing a reader can follow at a glance on the target screen.
  const penalties = {
    needlessBends: Math.round(30 * clamp01(excess / n / 1.5)),
    crossings: Math.round(15 * clamp01((crossings + acuteCrossings) / n / 0.6)),
    // Knots: corners and crossings piled into one place (junctions), and lines run so close they read as one.
    junctions: Math.round(10 * clamp01(jam.junctionLoad / 40)),
    tightRuns: Math.round(5 * clamp01(jam.tightRuns / 8)),
    worstWire: Math.round(10 * clamp01((maxBends - 2) / 6)),
    offFlow: Math.round(5 * clamp01(offFlowEnds / n / 0.3)),
    overlaps: Math.round(5 * clamp01((throughNode.length + labelOverlaps.length) / 4)),
    screenFit: Math.round(20 * clamp01((READING_FLOOR_PX - labelPxAtFit) / READING_FLOOR_PX)),
  };
  const score = 100 - Object.values(penalties).reduce((a, b) => a + b, 0);
  // A drawing with a wire through a box or a caption collision is broken: invalid, whatever its score.
  const valid = throughNode.length === 0 && labelOverlaps.length === 0;
  const grade = !valid
    ? "INVALID"
    : score >= 85
      ? "A"
      : score >= 70
        ? "B"
        : score >= 55
          ? "C"
          : score >= 40
            ? "D"
            : "F";
  return {
    file,
    direction,
    nodes: layout.nodes.length,
    wires: wires.length,
    groups: layout.groups.length,
    size: { width, height },
    viewport,
    fitZoom: Math.round(fitZoom * 100) / 100,
    labelPxAtFit,
    bends: totalBends,
    excessBends: excess,
    bentPairLines,
    excessPerWire: Math.round((excess / n) * 100) / 100,
    maxBends,
    crossings,
    acuteCrossings,
    minCrossingAngle: angles.length ? Math.round(Math.min(...angles)) : null,
    crossingsPerWire: Math.round((crossings / n) * 100) / 100,
    offFlowEnds,
    extraBorderCrossings,
    throughNode,
    labelOverlaps,
    maxFanIn: { node: fan[0], count: fan[1] },
    congestion: {
      peakWires: jam.peakWires,
      peakEvents: jam.peakEvents,
      junctions: jam.junctions,
      junctionLoad: jam.junctionLoad,
      tightRuns: jam.tightRuns,
      shortJogs: jam.shortJogs,
      ambiguousTurns: jam.ambiguousTurns,
    },
    score,
    valid,
    grade,
    penalties,
    worstWires: [...wires]
      .sort((a, b) => b.excess - a.excess || b.bends - a.bends)
      .slice(0, 5)
      .filter((w) => w.excess > 0),
    wiresDetail: wires,
  };
}

// ---------------------------------------------------------------- source rewrites (counterfactuals)

type Block = { id: string; label: string; start: number; end: number; parent: string | undefined };

function blocksOf(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  const stack: Block[] = [];
  lines.forEach((line, i) => {
    const open = line.match(/^\s*subgraph\s+([A-Za-z0-9_-]+)\s*(?:\[(.*)\])?/);
    if (open) {
      const b = { id: open[1]!, label: open[2] ?? open[1]!, start: i, end: -1, parent: stack[stack.length - 1]?.id };
      stack.push(b);
      blocks.push(b);
    } else if (/^\s*end\s*$/.test(line) && stack.length > 0) stack.pop()!.end = i;
  });
  return blocks;
}

const NODE_DECL = /^\s*([A-Za-z0-9_-]+)\s*(\[|\(|\{|>|\[\(|\(\()/;

type Candidate = { action: string; source: string };

export function candidates(source: string): Candidate[] {
  const lines = source.split("\n");
  const out: Candidate[] = [];
  const dir = source.match(/^\s*(flowchart|graph)\s+(LR|RL|TB|TD|BT)/m);
  if (dir) {
    const next = dir[2] === "LR" || dir[2] === "RL" ? "TB" : "LR";
    out.push({
      action: `Change the direction to ${dir[1]} ${next}`,
      source: source.replace(dir[0], `${dir[1]} ${next}`),
    });
  }
  // Frames are the author's meaning (what belongs to one application, SDK, system): never suggest removing one or
  // moving a node out of one (owner, 2026-11-15). Only layout-neutral edits are tried: frame declaration order.
  const blocks = blocksOf(lines).filter((b) => b.parent === undefined);
  for (const b of blocks) {
    const block = lines.slice(b.start, b.end + 1);
    const rest = lines.filter((_, i) => i < b.start || i > b.end);
    const header = rest.findIndex((l) => /^\s*(flowchart|graph)\b/.test(l));
    const first = [...rest.slice(0, header + 1), ...block, ...rest.slice(header + 1)];
    out.push({ action: `Declare the frame '${b.label}' first`, source: first.join("\n") });
  }
  void NODE_DECL;
  return out;
}

export async function layoutOf(source: string): Promise<LayoutResult> {
  return computeLayout(await viewOfSource(source));
}

// ---------------------------------------------------------------- debug overlay

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function overlaySvg(layout: LayoutResult, report: Report, title = report.file): string {
  const pad = 20;
  const W = report.size.width + pad * 2;
  const H = report.size.height + pad * 2 + 30;
  const byId = new Map(report.wiresDetail.map((w) => [w.id, w]));
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,sans-serif">`,
    `<rect width="100%" height="100%" fill="#fbfbf9"/>`,
    `<text x="${pad}" y="20" font-size="14" fill="#333">${esc(title)} — score ${report.score} (${report.grade}) · bends ${report.bends} (needless ${report.excessBends}) · crossings ${report.crossings} · junction load ${report.congestion.junctionLoad} · fit ${report.fitZoom}</text>`,
    `<g transform="translate(${pad},${pad + 30})">`,
  );
  for (const g of layout.groups)
    parts.push(
      `<rect x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" rx="10" fill="#eef1f6" fill-opacity="0.5" stroke="#8a94a6" stroke-dasharray="6 4"/>`,
      `<text x="${g.x + 10}" y="${g.y + 18}" font-size="12" fill="#5a6478">${esc(g.label)}</text>`,
    );
  const jam = congestionOf(layout, report.fitZoom);
  for (const w of jam.windows) {
    const heat = Math.min(1, Math.max(0, (w.wires - 3) / 8) * Math.min(1, w.events / 8));
    if (heat > 0.05)
      parts.push(
        `<rect x="${w.x}" y="${w.y}" width="120" height="120" fill="#f97316" fill-opacity="${(heat * 0.12).toFixed(3)}"/>`,
      );
  }
  for (const n of layout.nodes)
    parts.push(
      `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" fill="#fff" stroke="#444"/>`,
      `<text x="${n.x + n.width / 2}" y="${n.y + n.height / 2 + 5}" font-size="14" text-anchor="middle" fill="#222">${esc(n.label.split("\n")[0] ?? n.id)}</text>`,
    );
  for (const e of layout.edges) {
    const w = byId.get(e.id)!;
    const color = w.excess === 0 ? "#6b7280" : w.excess <= 2 ? "#d97706" : "#dc2626";
    const pts = essentialPoints(e.points);
    parts.push(
      `<polyline points="${pts.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="${color}" stroke-width="${w.excess > 2 ? 2.5 : 1.6}"/>`,
    );
    for (const p of pts.slice(1, -1)) parts.push(`<circle cx="${p.x}" cy="${p.y}" r="3" fill="${color}"/>`);
    const z = pts[pts.length - 1]!;
    parts.push(`<circle cx="${z.x}" cy="${z.y}" r="4" fill="none" stroke="${color}" stroke-width="1.5"/>`);
    if (e.labelAnchor)
      parts.push(
        `<rect x="${e.labelAnchor.x}" y="${e.labelAnchor.y}" width="${e.labelAnchor.width}" height="${e.labelAnchor.height}" fill="#fff" fill-opacity="0.85" stroke="${color}" stroke-opacity="0.35"/>`,
        `<text x="${e.labelAnchor.x + 3}" y="${e.labelAnchor.y + e.labelAnchor.height / 2 + 4}" font-size="11" fill="#555">${esc((e.label ?? "").split("\n")[0]!)}</text>`,
      );
  }
  // Crossing markers.
  const routes = layout.edges.map((e) => essentialPoints(e.points));
  for (let i = 0; i < routes.length; i += 1)
    for (let j = i + 1; j < routes.length; j += 1)
      for (let p = 1; p < routes[i]!.length; p += 1)
        for (let q = 1; q < routes[j]!.length; q += 1) {
          const x = crossPoint(routes[i]![p - 1]!, routes[i]![p]!, routes[j]![q - 1]!, routes[j]![q]!);
          if (x) parts.push(`<circle cx="${x.x}" cy="${x.y}" r="6" fill="none" stroke="#7c3aed" stroke-width="2"/>`);
        }
  for (const j of jam.junctions)
    parts.push(
      `<rect x="${j.x}" y="${j.y}" width="${j.width}" height="${j.height}" rx="12" fill="none" stroke="#ea580c" stroke-width="3" stroke-dasharray="10 6"/>`,
      `<text x="${j.x + 6}" y="${j.y - 8}" font-size="14" font-weight="700" fill="#c2410c">junction: ${j.wires.length} wires · ${j.corners} corners · ${j.crossings} crossings</text>`,
    );
  parts.push("</g></svg>");
  return parts.join("\n");
}

function crossPoint(a: LayoutPoint, b: LayoutPoint, c: LayoutPoint, d: LayoutPoint): LayoutPoint | null {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

// ---------------------------------------------------------------- text report

export function textReport(r: Report, suggestions: { action: string; score: number; delta: string }[] = []): string {
  const lines = [
    `LAYOUT REPORT  ${r.file}`,
    `score ${r.score}/100 (${r.grade})   direction ${r.direction.toUpperCase()}   ${r.nodes} nodes, ${r.wires} wires, ${r.groups} frames`,
    `penalties: ${
      Object.entries(r.penalties)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k} -${v}`)
        .join(", ") || "none"
    }`,
    `bends ${r.bends} (needless ${r.excessBends}, ${r.excessPerWire}/wire, worst wire ${r.maxBends})   crossings ${r.crossings}`,
    `screen: drawing ${r.size.width}x${r.size.height} on ${r.viewport.width}x${r.viewport.height} -> fits at zoom ${r.fitZoom}, wire labels ${r.labelPxAtFit}px (floor ${READING_FLOOR_PX}px)`,
    `wires crossing frame borders more than needed: ${r.extraBorderCrossings}   ends against the flow: ${r.offFlowEnds}   busiest target: ${r.maxFanIn.node} (${r.maxFanIn.count} in)`,
  ];
  lines.push(
    `knots: ${r.congestion.junctions.length} junction(s) holding ${r.congestion.junctionLoad} corners+crossings; busiest 120px spot has ${r.congestion.peakWires} wires and ${r.congestion.peakEvents} corners+crossings; ${r.congestion.tightRuns} near-coincident runs; ${r.congestion.shortJogs} short jogs (corners too close to show rounding on screen), ${r.congestion.ambiguousTurns} ambiguous turns (a corner on another wire's corner or crossing)`,
  );
  for (const j of r.congestion.junctions.slice(0, 3))
    lines.push(
      `  junction at (${j.x},${j.y}) ${j.width}x${j.height}px: ${j.wires.length} wires, ${j.corners} corners, ${j.crossings} crossings -- ${j.wires.slice(0, 8).join(", ")}${j.wires.length > 8 ? ", ..." : ""}`,
    );
  if (r.throughNode.length) lines.push(`runs through boxes: ${r.throughNode.join("; ")}`);
  if (r.labelOverlaps.length) lines.push(`label collisions: ${r.labelOverlaps.slice(0, 6).join("; ")}`);
  if (r.worstWires.length) {
    lines.push("worst wires:");
    for (const w of r.worstWires)
      lines.push(
        `  ${w.from} -> ${w.to} (${w.id}): ${w.bends} bends, ${w.excess} needless, crosses frame borders ${w.borderCrossings}x (needs ${w.requiredBorderCrossings})`,
      );
  }
  if (suggestions.length) {
    lines.push("measured source edits (each tried alone; best first):");
    for (const s of suggestions) lines.push(`  ${s.delta.padEnd(28)} ${s.action}`);
  }
  return lines.join("\n");
}

export async function suggest(source: string, base: Report, viewport: Report["viewport"]) {
  const out: { action: string; score: number; delta: string; report: Report }[] = [];
  for (const c of candidates(source)) {
    try {
      const r = measure(c.action, await layoutOf(c.source), viewport);
      const d = r.score - base.score;
      out.push({
        action: c.action,
        score: r.score,
        delta: `score ${d >= 0 ? "+" : ""}${d} (bends ${r.excessBends - base.excessBends >= 0 ? "+" : ""}${r.excessBends - base.excessBends}, x ${r.crossings - base.crossings >= 0 ? "+" : ""}${r.crossings - base.crossings})`,
        report: r,
      });
    } catch {
      /* a rewrite that no longer compiles is not a suggestion */
    }
  }
  return out
    .filter((s) => s.score > base.score)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      viewport: { type: "string", default: "1025x896" },
      suggest: { type: "boolean" },
      json: { type: "boolean" },
      svg: { type: "string" },
    },
  });
  const file = positionals[0];
  if (!file) {
    console.error("usage: report.mts <file.mmd> [--viewport WxH] [--suggest] [--json] [--svg out.svg]");
    process.exit(2);
  }
  const [vw, vh] = values.viewport!.split("x").map(Number) as [number, number];
  const viewport = { width: vw, height: vh };
  const source = readFileSync(file, "utf8");
  let layout: LayoutResult;
  try {
    layout = await layoutOf(source);
  } catch (error) {
    console.error(`does not compile: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const report = measure(file.split("/").pop()!, layout, viewport);
  const suggestions = values.suggest ? await suggest(source, report, viewport) : [];
  if (values.svg) writeFileSync(values.svg, overlaySvg(layout, report));
  if (values.json)
    console.log(JSON.stringify({ ...report, suggestions: suggestions.map(({ report: _r, ...s }) => s) }, null, 1));
  else console.log(textReport(report, suggestions));
  void crossingsOf;
}
