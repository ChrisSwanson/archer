/**
 * Curved lines, Mermaid style: each line drawn as one gentle B-spline from box to box, the way Mermaid draws a
 * flowchart (dagre's points through d3's `curveBasis`). A pure drawing change: the boxes stay where the orthogonal
 * layout put them, and so does every line's route, which the curve is drawn from.
 *
 * A line's curve passes near a few points only: where it leaves its source, one point per gap between layers (the
 * middle of each run the orthogonal route takes across the flow, between two layers), and where it enters its
 * target. It leaves and enters at whatever slant that gives: each end is where the line from the box's centre toward
 * the nearest waypoint meets the drawn outline, so the curve's tip touches the box and its arrowhead follows the end
 * tangent. A route with no run across the flow is straight and stays as routed.
 *
 * Captions are placed afterwards, on the curve at the middle of its length, and slid along it until clear.
 *
 * Every curve is checked, sampled: 6px clear of every other box, note and frame caption, and never inside its own
 * ends. One that is not clear is drawn again through the route's corners nearest the trouble, one at a time; failing
 * that, it is drawn as the orthogonal route with curved corners (`curved-route.ts`). Deterministic.
 */
import type { LayoutEdge, LayoutResult } from "../layout/elk-layout";
import { insideShape, meetOutline, outlineOf, type Outline } from "../layout/graph-metrics";
import { lengthOf } from "../nesting/route-geometry";
import {
  boxesOverlap,
  corners as routeCorners,
  cubicAt,
  type CurveBox,
  len,
  pointSegmentDistance,
  pt,
  segBox,
  sub,
} from "./curve-geometry";
import { curvedRoutes, type CurvedRoute } from "./curved-route";
import type { RoutePoint } from "./rounded-route";

type P = RoutePoint;

/** How far a curve keeps from a box it does not end on. */
export const MERMAID_CLEARANCE_PX = 6;
/** A waypoint this close to the line through its neighbours adds nothing and is dropped. */
const COLLINEAR_PX = 3;
/** Route corners a curve may borrow to get clear of a box, at most. */
const MAX_BORROWED_CORNERS = 6;
/** How far a curve may bend away from its end tangent under an arrowhead: inside the head's own half-width. */
const ARROW_TANGENT_SLACK_PX = 1.5;
/** How far a caption slides along its curve at each try. */
const LABEL_STEP_PX = 6;
/** How far a caption keeps from another caption, a box, or another line (the eval's own margins). */
const LABEL_PAD_PX = 2;
const SAMPLES_PER_CUBIC = 16;

export type MermaidLine = CurvedRoute & {
  /** `mermaid`: the curve as designed; `corners`: route corners borrowed to clear a box; `square`: the curved-corner drawing (`curvedRoutes`). */
  readonly kind: "mermaid" | "corners" | "square";
};

export type MermaidDrawing = {
  readonly lines: ReadonlyMap<string, MermaidLine>;
  /** Where each caption is drawn: on its own curve (or, for a `square` line, where the layout put it). */
  readonly labels: ReadonlyMap<string, CurveBox>;
  /** Captions that had to slide off their curve's middle, and those with no clear place (left at the middle). */
  readonly slid: number;
  readonly unplaced: readonly string[];
};

// ---------------------------------------------------------------- geometry

/** d3's `curveBasis` through `points`, written out as a chain of cubics: start, then (control, control, end) each. */
export function basisChain(points: readonly P[]): P[] {
  if (points.length < 3) return points.length === 2 ? [points[0]!, points[1]!] : [...points];
  const chain: P[] = [points[0]!];
  const lineTo = (b: P): void => {
    const a = chain[chain.length - 1]!;
    chain.push(
      { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
      { x: a.x + (2 * (b.x - a.x)) / 3, y: a.y + (2 * (b.y - a.y)) / 3 },
      b,
    );
  };
  let x0 = points[0]!;
  let x1 = points[1]!;
  lineTo({ x: (5 * x0.x + x1.x) / 6, y: (5 * x0.y + x1.y) / 6 });
  const bezier = (x: P): void => {
    chain.push(
      { x: (2 * x0.x + x1.x) / 3, y: (2 * x0.y + x1.y) / 3 },
      { x: (x0.x + 2 * x1.x) / 3, y: (x0.y + 2 * x1.y) / 3 },
      { x: (x0.x + 4 * x1.x + x.x) / 6, y: (x0.y + 4 * x1.y + x.y) / 6 },
    );
  };
  for (let i = 2; i < points.length; i += 1) {
    bezier(points[i]!);
    x0 = x1;
    x1 = points[i]!;
  }
  bezier(x1);
  lineTo(x1);
  return chain;
}

/** A cubic chain (or a single straight line) as a polyline through points on it, about every 4px. */
export function sampleChain(chain: readonly P[]): P[] {
  if (chain.length === 2) {
    const [a, b] = [chain[0]!, chain[1]!];
    const steps = Math.max(1, Math.ceil(len(sub(b, a)) / 4));
    return Array.from({ length: steps + 1 }, (_, s) => ({
      x: a.x + ((b.x - a.x) * s) / steps,
      y: a.y + ((b.y - a.y) * s) / steps,
    }));
  }
  const out: P[] = [chain[0]!];
  for (let i = 0; i + 3 < chain.length; i += 3) {
    const [a, b, c, d] = [chain[i]!, chain[i + 1]!, chain[i + 2]!, chain[i + 3]!];
    const flat = pointSegmentDistance(b, a, d) < 1e-6 && pointSegmentDistance(c, a, d) < 1e-6;
    const hull = len(sub(b, a)) + len(sub(c, b)) + len(sub(d, c));
    const steps = Math.max(
      flat ? 1 : 2,
      Math.min(flat ? Number.POSITIVE_INFINITY : SAMPLES_PER_CUBIC, Math.ceil(hull / 4)),
    );
    for (let s = 1; s < steps; s += 1) out.push(cubicAt(a, b, c, d, s / steps));
    if (!(Math.abs(d.x - out[out.length - 1]!.x) < 1e-9 && Math.abs(d.y - out[out.length - 1]!.y) < 1e-9)) out.push(d);
  }
  return out;
}

export function chainPath(chain: readonly P[]): string {
  if (chain.length === 2) return `M ${pt(chain[0]!)} L ${pt(chain[1]!)}`;
  let d = `M ${pt(chain[0]!)}`;
  for (let i = 1; i + 2 < chain.length; i += 3) d += ` C ${pt(chain[i]!)} ${pt(chain[i + 1]!)} ${pt(chain[i + 2]!)}`;
  return d;
}

/** How far from an end the sampled curve stays within `ARROW_TANGENT_SLACK_PX` of its end tangent. */
function straightRun(samples: readonly P[], at: "start" | "end"): number {
  const pts = at === "end" ? [...samples].reverse() : samples;
  if (pts.length < 2) return 0;
  const tip = pts[0]!;
  const u = sub(pts[1]!, tip);
  const l = len(u) || 1;
  const ux = u.x / l;
  const uy = u.y / l;
  let run = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i]!;
    if (Math.abs((p.x - tip.x) * uy - (p.y - tip.y) * ux) > ARROW_TANGENT_SLACK_PX) break;
    run = (p.x - tip.x) * ux + (p.y - tip.y) * uy;
  }
  return Math.max(0, run);
}

// ---------------------------------------------------------------- ends

type End = { readonly box: CurveBox; readonly shape: Outline };

/** Where the line from the box's centre toward `toward` meets the drawn outline; undefined when `toward` is inside. */
function anchor(end: End, toward: P): P | undefined {
  const { box } = end;
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const d = sub(toward, c);
  const tx = d.x === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(d.x);
  const ty = d.y === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(d.y);
  const t = Math.min(tx, ty);
  if (!(t < 1)) return undefined;
  const onBox = { x: c.x + d.x * t, y: c.y + d.y * t };
  return end.shape === "rectangle" ? onBox : meetOutline(end.shape, box, onBox, c);
}

// ---------------------------------------------------------------- checking

/** How near the segment `a`-`b` comes to `box`: 0 when it touches or enters it. */
function segmentToBox(a: P, b: P, box: CurveBox): number {
  const x1 = box.x + box.width;
  const y1 = box.y + box.height;
  const inside = (p: P): boolean => p.x >= box.x && p.x <= x1 && p.y >= box.y && p.y <= y1;
  if (inside(a) || inside(b)) return 0;
  const corners = [
    { x: box.x, y: box.y },
    { x: x1, y: box.y },
    { x: x1, y: y1 },
    { x: box.x, y: y1 },
  ];
  const cross = (o: P, p: P, q: P): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  for (let i = 0; i < 4; i += 1) {
    const c = corners[i]!;
    const d = corners[(i + 1) % 4]!;
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  }
  const toBox = (p: P): number => Math.hypot(Math.max(box.x - p.x, 0, p.x - x1), Math.max(box.y - p.y, 0, p.y - y1));
  return Math.min(toBox(a), toBox(b), ...corners.map((c) => pointSegmentDistance(c, a, b)));
}

/** The first place the sampled curve comes too near a box, or enters one of its own ends; undefined when clear. */
function conflictOf(samples: readonly P[], walls: readonly CurveBox[], ends: readonly End[]): P | undefined {
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const chord = segBox(a, b);
    for (const wall of walls)
      if (boxesOverlap(chord, wall, MERMAID_CLEARANCE_PX) && segmentToBox(a, b, wall) < MERMAID_CLEARANCE_PX)
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (const p of i < samples.length - 1 ? [mid, b] : [mid])
      for (const { box, shape } of ends) {
        const lx = p.x - box.x;
        const ly = p.y - box.y;
        // Inside by more than half a pixel: the tip touches the outline, nothing goes in.
        const inside = [
          [0, 0],
          [0.5, 0],
          [-0.5, 0],
          [0, 0.5],
          [0, -0.5],
        ].every(([dx, dy]) => insideShape(shape, box.width, box.height, lx + dx!, ly + dy!));
        if (inside) return p;
      }
  }
  return undefined;
}

// ---------------------------------------------------------------- one line

type Waypoint = { readonly p: P; readonly at: number };

function lengthsAlong(route: readonly P[]): number[] {
  const at = [0];
  for (let i = 1; i < route.length; i += 1) at.push(at[i - 1]! + len(sub(route[i]!, route[i - 1]!)));
  return at;
}

/**
 * About one point per gap between layers, and one per layer the line passes, as dagre gives Mermaid: the middle of
 * each run the route takes across the flow, and, where a run along the flow passes a layer of boxes (a box not its
 * own sits wholly within the run's reach), the run at the middle of that layer.
 */
function layerWaypoints(route: readonly P[], across: "x" | "y", boxes: readonly CurveBox[]): Waypoint[] {
  const at = lengthsAlong(route);
  const along = across === "y" ? "x" : "y";
  const size = along === "x" ? "width" : "height";
  const out: Waypoint[] = [];
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    // Across the flow: in a graph flowing sideways, a vertical run.
    const isAcross = Math.abs(a[along] - b[along]) < 0.5;
    if (isAcross) {
      // In the middle of the gap between the layers either side, wherever in the gap the route crossed it.
      const here = a[along];
      let before = Number.NEGATIVE_INFINITY;
      let after = Number.POSITIVE_INFINITY;
      for (const box of boxes) {
        if (box[along] + box[size] <= here + 0.5) before = Math.max(before, box[along] + box[size]);
        if (box[along] >= here - 0.5) after = Math.min(after, box[along]);
      }
      const middle = Number.isFinite(before) && Number.isFinite(after) ? (before + after) / 2 : here;
      // At the level the run arrives at, as dagre lines a long line's middle up with where it is going: the curve
      // leaves its source at a slant and settles toward its target's level.
      const p = { x: b.x, y: b.y };
      p[along] = middle;
      out.push({ p, at: (at[i - 1]! + at[i]!) / 2 });
      continue;
    }
    const lo = Math.min(a[along], b[along]);
    const hi = Math.max(a[along], b[along]);
    const layers = new Set<number>();
    for (const box of boxes)
      if (box[along] > lo && box[along] + box[size] < hi) layers.add(Math.round(box[along] + box[size] / 2));
    for (const middle of [...layers].sort((m, n) => m - n)) {
      const t = (middle - a[along]) / (b[along] - a[along]);
      out.push({
        p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        at: at[i - 1]! + (at[i]! - at[i - 1]!) * t,
      });
    }
  }
  return out.sort((m, n) => m.at - n.at);
}

/** Drop waypoints that sit on the line through their neighbours (the ends included). */
function collapse(points: readonly P[], keep: ReadonlySet<P>): P[] {
  const out = [...points];
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 1; i < out.length - 1; i += 1) {
      if (keep.has(out[i]!)) continue;
      if (pointSegmentDistance(out[i]!, out[i - 1]!, out[i + 1]!) < COLLINEAR_PX) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

type Drawn = { readonly chain: readonly P[]; readonly samples: readonly P[] };

function drawThrough(
  waypoints: readonly Waypoint[],
  source: End,
  target: End,
  borrowed: ReadonlySet<P>,
  /** A line that states the sides it leaves and enters by keeps the route's own ends. */
  fixed?: { readonly start: P; readonly end: P },
): Drawn | undefined {
  if (waypoints.length === 0) return undefined;
  const first = fixed?.start ?? anchor(source, waypoints[0]!.p);
  const last = fixed?.end ?? anchor(target, waypoints[waypoints.length - 1]!.p);
  if (first === undefined || last === undefined) return undefined;
  const points = collapse([first, ...waypoints.map((w) => w.p), last], borrowed);
  // Collapsing may change which waypoint each end looks toward.
  const start = fixed?.start ?? (points.length > 2 ? anchor(source, points[1]!) : anchor(source, last));
  const end = fixed?.end ?? (points.length > 2 ? anchor(target, points[points.length - 2]!) : anchor(target, first));
  if (start === undefined || end === undefined) return undefined;
  points[0] = start;
  points[points.length - 1] = end;
  const chain = basisChain(points);
  return { chain, samples: sampleChain(chain) };
}

function endOf(layout: LayoutResult, id: string): End | undefined {
  const node = layout.nodes.find((n) => n.id === id);
  if (node !== undefined) return { box: node, shape: outlineOf(node.shape, node.classes) };
  const group = layout.groups.find((g) => g.id === id);
  return group === undefined ? undefined : { box: group, shape: "rectangle" };
}

/** One line's curve, or undefined when only the square drawing will do. */
function mermaidLine(edge: LayoutEdge, layout: LayoutResult, walls: readonly CurveBox[]): MermaidLine | undefined {
  if (edge.source === edge.target) return undefined;
  const route = routeCorners(edge.points);
  if (route.length < 2) return undefined;
  const source = endOf(layout, edge.source);
  const target = endOf(layout, edge.target);
  if (source === undefined || target === undefined) return undefined;
  const ends = [source, target];
  const own = new Set([source.box, target.box]);
  const others = walls.filter((w) => !own.has(w as never));
  const across = layout.direction === "lr" || layout.direction === "rl" ? "y" : "x";
  const waypoints = layerWaypoints(route, across, layout.nodes);
  const fixed = edge.figure?.type === "ports" ? { start: route[0]!, end: route[route.length - 1]! } : undefined;
  // Straight as routed: the route is already the most direct line, and it meets both boxes.
  if (waypoints.length === 0) {
    const chain = [route[0]!, route[route.length - 1]!];
    const samples = sampleChain(chain);
    if (conflictOf(samples, others, []) !== undefined) return undefined;
    return {
      kind: "mermaid",
      d: chainPath(chain),
      samples,
      straight: { start: len(sub(chain[1]!, chain[0]!)), end: len(sub(chain[1]!, chain[0]!)) },
    };
  }
  const at = lengthsAlong(route);
  const corners: Waypoint[] = route.slice(1, -1).map((p, i) => ({ p, at: at[i + 1]! }));
  let current = [...waypoints];
  const borrowed = new Set<P>();
  for (let tries = 0; tries <= MAX_BORROWED_CORNERS; tries += 1) {
    const drawn = drawThrough(current, source, target, borrowed, fixed);
    if (drawn === undefined) return undefined;
    const trouble = conflictOf(drawn.samples, others, ends);
    if (trouble === undefined) {
      return {
        kind: tries === 0 ? "mermaid" : "corners",
        d: chainPath(drawn.chain),
        samples: drawn.samples,
        straight: { start: straightRun(drawn.samples, "start"), end: straightRun(drawn.samples, "end") },
      };
    }
    // Borrow the route corner nearest the trouble, in its place along the route.
    const unused = corners.filter((c) => !borrowed.has(c.p));
    if (unused.length === 0) return undefined;
    unused.sort((a, b) => len(sub(a.p, trouble)) - len(sub(b.p, trouble)) || a.at - b.at);
    const next = unused[0]!;
    borrowed.add(next.p);
    current = [...current, next].sort((a, b) => a.at - b.at);
  }
  return undefined;
}

// ---------------------------------------------------------------- captions

function pointAlong(samples: readonly P[], distance: number): P {
  let travelled = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const l = len(sub(b, a));
    if (travelled + l >= distance) {
      const t = l === 0 ? 0 : (distance - travelled) / l;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    travelled += l;
  }
  return samples[samples.length - 1]!;
}

// ---------------------------------------------------------------- the drawing

/** Every line of a layout drawn Mermaid style, with its caption on it. */
export function mermaidCurves(layout: LayoutResult): MermaidDrawing {
  // Whatever a curve costs, the drawing never gets a caption collision the square drawing does not have: a curved
  // line in one, or whose caption is in one, is drawn square (its caption where the layout put it), and the drawing
  // made again. Every line square is the curved-corner drawing (`curvedRoutes`), so this ends.
  const square = new Set<string>();
  // Each line's curve and curved-corner drawing do not depend on which others are square: worked out once.
  const walls = wallsOf(layout);
  const curves = new Map<string, MermaidLine | undefined>();
  for (const edge of layout.edges) if (edge.points.length >= 2) curves.set(edge.id, mermaidLine(edge, layout, walls));
  let cornered: ReadonlyMap<string, CurvedRoute> | undefined;
  const squareOf = (id: string): CurvedRoute | undefined => {
    cornered ??= curvedRoutes(layout);
    return cornered.get(id);
  };
  for (;;) {
    const drawing = drawOnce(layout, walls, square, curves, squareOf);
    const involved = collidingCurves(layout, drawing).filter((id) => !square.has(id));
    if (involved.length === 0)
      return { ...drawing, unplaced: drawing.unplaced.filter((id) => drawing.lines.get(id)?.kind !== "square") };
    for (const id of involved) square.add(id);
  }
}

/** The curved lines in a caption collision: the caption's own, and any line across it. */
function collidingCurves(layout: LayoutResult, drawing: MermaidDrawing): string[] {
  const out = new Set<string>();
  const curved = (id: string): boolean => drawing.lines.get(id)?.kind !== "square";
  const labels = [...drawing.labels];
  const chords = new Map([...drawing.lines].map(([id, line]) => [id, chordsOf(line.samples)] as const));
  for (const [id, box] of labels) {
    // The line across a caption goes square first (its route is clear of every caption the layout placed); the
    // caption's own line only when nothing else will.
    const hit = (other?: string): void => {
      if (other !== undefined && curved(other)) out.add(other);
      else if (curved(id)) out.add(id);
    };
    if (layout.nodes.some((n) => boxesOverlap(box, n, 1))) hit();
    for (const [other, at] of labels) if (other !== id && boxesOverlap(box, at, 1)) hit(other);
    for (const [other, runs] of chords)
      if (other !== id && runs.some((chord) => boxesOverlap(chord, box, LABEL_PAD_PX))) hit(other);
  }
  return [...out].sort();
}

/** The bounding box of each sampled chord of a line. */
function chordsOf(samples: readonly P[]): CurveBox[] {
  const boxes: CurveBox[] = [];
  for (let i = 1; i < samples.length; i += 1) boxes.push(segBox(samples[i - 1]!, samples[i]!));
  return boxes;
}

function wallsOf(layout: LayoutResult): CurveBox[] {
  const walls: CurveBox[] = [...layout.nodes];
  for (const node of layout.nodes) if (node.note !== undefined) walls.push(node.note);
  for (const group of layout.groups) if (group.caption !== undefined) walls.push(group.caption);
  return walls;
}

function drawOnce(
  layout: LayoutResult,
  walls: readonly CurveBox[],
  forced: ReadonlySet<string>,
  curves: ReadonlyMap<string, MermaidLine | undefined>,
  squareOf: (id: string) => CurvedRoute | undefined,
): MermaidDrawing {
  const edges = [...layout.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = new Map<string, MermaidLine>();
  const square: string[] = [];
  for (const edge of edges) {
    if (edge.points.length < 2) continue;
    const line = forced.has(edge.id) ? undefined : curves.get(edge.id);
    if (line === undefined) square.push(edge.id);
    else lines.set(edge.id, line);
  }
  for (const id of square) {
    const route = squareOf(id);
    if (route !== undefined) lines.set(id, { ...route, kind: "square" });
  }

  // Captions: a square line's stays where the layout put it, on its route; the others go on their curves.
  const labels = new Map<string, CurveBox>();
  const placed = new Map<string, CurveBox>();
  const runs = new Map<string, CurveBox[]>([...lines].map(([id, line]) => [id, chordsOf(line.samples)]));
  /** What a caption at `box` would collide with: boxes, captions already placed, and other lines. */
  const collisions = (id: string, box: CurveBox): number =>
    walls.filter((wall) => boxesOverlap(box, wall, LABEL_PAD_PX)).length +
    [...placed].filter(([other, at]) => other !== id && boxesOverlap(box, at, LABEL_PAD_PX)).length +
    [...runs].filter(
      ([other, chords]) => other !== id && chords.some((chord) => boxesOverlap(chord, box, LABEL_PAD_PX)),
    ).length;
  for (const edge of edges)
    if (edge.labelAnchor !== undefined && lines.get(edge.id)?.kind === "square") {
      labels.set(edge.id, edge.labelAnchor);
      placed.set(edge.id, edge.labelAnchor);
    }
  let slid = 0;
  const unplaced: string[] = [];
  for (const edge of edges) {
    const line = lines.get(edge.id);
    const size = edge.labelAnchor;
    if (line === undefined || size === undefined || line.kind === "square") continue;
    const total = lengthOf(line.samples);
    const boxAt = (distance: number): CurveBox => {
      const c = pointAlong(line.samples, distance);
      return { x: c.x - size.width / 2, y: c.y - size.height / 2, width: size.width, height: size.height };
    };
    // From the middle outward, alternately later and earlier along the curve; the first clear place wins.
    let chosen: CurveBox | undefined;
    let fewest: { box: CurveBox; count: number } | undefined;
    for (let offset = 0; offset <= total / 2 && chosen === undefined; offset += LABEL_STEP_PX) {
      for (const distance of offset === 0 ? [total / 2] : [total / 2 + offset, total / 2 - offset]) {
        const box = boxAt(distance);
        const count = collisions(edge.id, box);
        if (count === 0) {
          chosen = box;
          if (offset > 0) slid += 1;
          break;
        }
        if (fewest === undefined || count < fewest.count) fewest = { box, count };
      }
    }
    if (chosen === undefined) {
      // Nowhere clear on the curve: the line goes back to its route, its caption to where the layout put it,
      // when that is clear of everything drawn so far and the route crosses no caption placed so far.
      const square = squareOf(edge.id);
      const squareRun = square === undefined ? undefined : chordsOf(square.samples);
      const routeClear =
        squareRun !== undefined &&
        ![...placed.values()].some((at) => squareRun.some((chord) => boxesOverlap(chord, at, LABEL_PAD_PX)));
      if (square !== undefined && squareRun !== undefined && routeClear) {
        runs.set(edge.id, squareRun);
        if (collisions(edge.id, size) === 0) {
          lines.set(edge.id, { ...square, kind: "square" });
          labels.set(edge.id, size);
          placed.set(edge.id, size);
          continue;
        }
        runs.set(edge.id, chordsOf(line.samples));
      }
      unplaced.push(edge.id);
      chosen = fewest?.box ?? boxAt(total / 2);
    }
    labels.set(edge.id, chosen);
    placed.set(edge.id, chosen);
  }
  return { lines, labels, slid, unplaced };
}
