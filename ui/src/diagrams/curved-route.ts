/**
 * Curved lines: ELK's orthogonal route drawn with large, clearance-checked curves (the viewer's "Curved lines").
 *
 * The route stays ELK's: same lanes, same crossings, same ends. Only the corners change. Each corner takes the
 * largest radius that fits (up to `CURVE_RADIUS_PX`, at most half of each run it sits on), and a Z or S jog -- two
 * opposite corners close together -- becomes one S-curve, so the line reads as heading straight for its end.
 *
 * Whole-route smoothing (Mermaid's curveBasis) cut corners through boxes, and ELK's own splines made shallow
 * crossings, which slow path tracing (Huang 2008; layout eval, 2026-11-15). So a curve is kept only where it is
 * clear: no node, note, frame caption or edge caption enters it, it neither crosses nor touches another line or a
 * frame's outline, and the part of the route it replaces crosses nothing either -- so every crossing stays where
 * ELK put it, on a straight run, at its right angle. Where nothing larger fits, the corner keeps the square view's
 * rounding (`roundedRoute`), which the layout already cleared.
 *
 * Endpoints, the arrowhead's straight approach and the run under the line's own caption are never moved.
 * Deterministic: the same route and obstacles give the same path.
 */
import type { LayoutResult } from "../layout/elk-layout";
import { EDGE_LABEL_LEAD_PX } from "../layout/graph-metrics";
import { arrowsOf } from "./figures";
import {
  add,
  boxesOverlap,
  corners,
  cross,
  cubicAt,
  distinct,
  dot,
  EPS,
  len,
  pointSegmentDistance,
  pt,
  scale,
  segBox,
  sub,
  type CurveBox,
} from "./curve-geometry";
import { CORNER_RADIUS_PX, type RouteEnds, type RoutePoint } from "./rounded-route";

/** The largest corner, in layout px: about four times the square view's, so a turn reads as a curve at Fit. */
export const CURVE_RADIUS_PX = 40;
/** How far a curve keeps from any box it must not enter. */
export const CURVE_CLEARANCE_PX = 6;
/** How far a curve keeps from another line it must not touch. */
const CURVE_LINE_GAP_PX = 4;
/** A jog whose offset is this or less is drawn as one S-curve, when the S fits: a line jogging over to a box reads
 *  as one sweep. */
const S_JOG_MAX_PX = 200;
/** How far an S-curve reaches along each run, at most, for its offset: past this it only flattens. */
const S_REACH_PER_JOG = 3;
const S_REACH_MIN_PX = 80;
/** The shares of each run an S tries, widest first. */
const S_STEPS = [1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1];
/**
 * The straight run a curved line keeps before an arrowhead: the head's own painted length at its base size
 * (34 x 5.5 / 20 = 9.35px) and 4px of shaft. The square view keeps 40px (`ARROW_APPROACH_PX`), so its 10px corner
 * stays a distinct turn before the head; on a curve the line flows into the head, so the head needs only itself.
 */
export const CURVE_ARROW_APPROACH_PX = 14;
/** The shaft a curved line's arrowhead keeps behind it (`arrowMarkerWidth`). */
export const CURVE_ARROW_SHAFT_PX = 4;

export type { CurveBox };

export type CurveObstacles = {
  /** What no curve may enter: nodes, notes, frame captions, other lines' captions. */
  readonly boxes: readonly CurveBox[];
  /** Other lines and frame outlines, as polylines: a curve must not cross or touch them. */
  readonly lines: readonly (readonly RoutePoint[])[];
  /** This line's own caption: the run under it stays as routed, so the caption still sits on the line. */
  readonly label?: CurveBox;
  /** The line's own two ends: it leaves and meets them head-on, so a curve may start at their edge but not enter. */
  readonly ends?: readonly CurveBox[];
};

export type CurveOptions = RouteEnds & {
  readonly maxRadius?: number;
  readonly clearance?: number;
};

export type CurvedRoute = {
  /** SVG path data: straight runs (`L`) joined by cubic curves (`C`). */
  readonly d: string;
  /** The same path as a polyline, finely sampled along its curves (for measuring and hit tests). */
  readonly samples: readonly RoutePoint[];
  /** The straight run at each end before its first curve, for the arrowhead's size (`routeArrowWidths`). */
  readonly straight: { readonly start: number; readonly end: number };
};

type P = RoutePoint;
type Cubic = readonly [P, P, P, P];
/** One curved stretch of the route: from a point on run `from` to a point on run `to` (`to` = `from` + 1 or + 2). */
type Piece = {
  readonly from: number;
  readonly to: number;
  readonly cut: number;
  readonly resume: number;
  readonly cubic: Cubic;
};

const SAMPLES_PER_CURVE = 16;

const unit = (a: P): P => {
  const l = len(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

/** About every 4px along the curve, between 4 and 16 samples: a tight turn is not a staircase of sub-pixel steps. */
function sampleCubic([a, b, c, d]: Cubic): P[] {
  const hull = len(sub(b, a)) + len(sub(c, b)) + len(sub(d, c));
  const steps = Math.max(4, Math.min(SAMPLES_PER_CURVE, Math.ceil(hull / 4)));
  const out: P[] = [];
  for (let i = 0; i <= steps; i += 1) out.push(cubicAt(a, b, c, d, i / steps));
  return out;
}

function segmentsProperlyCross(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Two segments meet or come within `gap` of each other. Parallel segments cannot cross and are never a hit. */
function segmentsNear(a: P, b: P, c: P, d: P, gap: number): boolean {
  if (Math.abs(cross(sub(b, a), sub(d, c))) < EPS) return false;
  if (segmentsProperlyCross(a, b, c, d)) return true;
  return (
    Math.min(
      pointSegmentDistance(a, c, d),
      pointSegmentDistance(b, c, d),
      pointSegmentDistance(c, a, b),
      pointSegmentDistance(d, a, b),
    ) < gap
  );
}

/** Another line's run that lies along one of this route's own runs: a shared trunk, which is drawn once. */
function onOwnRun(c: P, d: P, route: readonly P[]): boolean {
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const v = sub(b, a);
    if (Math.abs(cross(v, sub(c, a))) > 0.5 * len(v) || Math.abs(cross(v, sub(d, a))) > 0.5 * len(v)) continue;
    const l2 = dot(v, v);
    if (l2 === 0) continue;
    const t1 = dot(sub(c, a), v) / l2;
    const t2 = dot(sub(d, a), v) / l2;
    if (Math.min(1, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)) > 0.5 / Math.sqrt(l2)) return true;
  }
  return false;
}

type Segment = { readonly a: P; readonly b: P; readonly box: CurveBox };

type Checker = (curve: readonly P[], replaced: readonly (readonly [P, P])[]) => boolean;

function checker(route: readonly P[], obstacles: CurveObstacles, clearance: number): Checker {
  const segments: Segment[] = [];
  for (const line of obstacles.lines)
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1]!;
      const b = line[i]!;
      if (a.x === b.x && a.y === b.y) continue;
      if (onOwnRun(a, b, route)) continue;
      segments.push({ a, b, box: segBox(a, b) });
    }
  const lead = EDGE_LABEL_LEAD_PX;
  const label = obstacles.label;
  const hitsSegments = (a: P, b: P, gap: number): boolean => {
    const box = segBox(a, b);
    for (const s of segments) {
      if (!boxesOverlap(box, s.box, gap)) continue;
      if (segmentsNear(a, b, s.a, s.b, gap)) return true;
    }
    return false;
  };
  return (curve, replaced) => {
    for (let i = 1; i < curve.length; i += 1) {
      const box = segBox(curve[i - 1]!, curve[i]!);
      for (const o of obstacles.boxes) if (boxesOverlap(box, o, clearance)) return false;
      for (const o of obstacles.ends ?? []) if (boxesOverlap(box, o, -0.5)) return false;
      if (label !== undefined && boxesOverlap(box, label, lead)) return false;
      if (hitsSegments(curve[i - 1]!, curve[i]!, CURVE_LINE_GAP_PX)) return false;
    }
    for (const [a, b] of replaced) {
      if (label !== undefined && boxesOverlap(segBox(a, b), label, lead)) return false;
      if (hitsSegments(a, b, 1)) return false;
    }
    return true;
  };
}

/** A circular-looking turn of radius `r` at `corner`, from run direction `din` into `dout`. */
function arc(corner: P, din: P, dout: P, r: number): Cubic {
  const before = sub(corner, scale(din, r));
  const after = add(corner, scale(dout, r));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(din, dout))));
  const k = (4 / 3) * Math.tan(theta / 4);
  return [before, add(before, scale(din, r * k)), sub(after, scale(dout, r * k)), after];
}

/** One S from `p` (heading `dir`) to `q` (heading `dir` again), its handles half the reach along the flow. */
function sCurve(p: P, q: P, dir: P): Cubic {
  const reach = dot(sub(q, p), dir);
  return [p, add(p, scale(dir, reach / 2)), sub(q, scale(dir, reach / 2)), q];
}

/**
 * Radii worth trying, largest first, down to the square view's own and then smaller: a corner that sits on another
 * line's crossing turns more tightly, or not at all, rather than move the crossing.
 */
function candidates(most: number, square: number): number[] {
  const out: number[] = [];
  for (let r = most; r > square + 0.5; r *= 0.8) out.push(r);
  for (let r = square; r >= 2; r /= 2) out.push(r);
  return out;
}

export function curvedRoute(
  points: readonly RoutePoint[],
  obstacles: CurveObstacles,
  options: CurveOptions = {},
): CurvedRoute {
  const route = corners(points);
  const maxRadius = options.maxRadius ?? CURVE_RADIUS_PX;
  const clearance = options.clearance ?? CURVE_CLEARANCE_PX;
  if (route.length < 2) {
    const only = route[0] ?? points[0];
    return { d: only ? `M ${pt(only)}` : "", samples: only ? [only] : [], straight: { start: 0, end: 0 } };
  }
  const runs = route.slice(1).map((p, i) => len(sub(p, route[i]!)));
  const dirs = route.slice(1).map((p, i) => unit(sub(p, route[i]!)));
  const last = runs.length - 1;
  const approach = CURVE_ARROW_APPROACH_PX;
  /**
   * How much of run `j` one curve may take. A line's tail run is all its corner's (the line still leaves its box
   * head-on); a run into or out of an arrowhead keeps the head's own approach; a run between two corners is shared.
   */
  const share = (j: number): number => {
    const run = runs[j]!;
    if (j === 0 && j !== last) return Math.max(0, run - (options.arrowStart ? approach : 0));
    if (j === last && j !== 0) return Math.max(0, run - (options.arrowEnd ? approach : 0));
    return run / 2;
  };
  /** How much of run `j` is already taken at its start, by the curve before it. */
  const taken = new Array<number>(runs.length).fill(0);
  const clear = checker(route, obstacles, clearance);
  const pieces: Piece[] = [];

  for (let i = 1; i < route.length - 1; i += 1) {
    const corner = route[i]!;
    const din = dirs[i - 1]!;
    const dout = dirs[i]!;
    // A Z or S jog: this corner and the next turn opposite ways, so the line carries on the way it came.
    const next = route[i + 2];
    if (next !== undefined && runs[i]! <= S_JOG_MAX_PX && dot(din, dirs[i + 1]!) > 1 - EPS) {
      const jog = runs[i]!;
      const most = Math.max(S_REACH_MIN_PX, S_REACH_PER_JOG * jog);
      // The S takes all of the run it comes from that the curve before left, and its share of the run it joins.
      const reachIn = Math.min(i - 1 === 0 ? share(0) : runs[i - 1]! - taken[i - 1]!, most);
      const reachOut = Math.min(share(i + 1), most);
      let merged: Piece | undefined;
      // Each side shrinks on its own (a caption or a neighbour may sit on one run only), the widest S first. An S
      // spanning less than half its offset reads as a kink; any wider one is less steep than the two corners.
      const tries: [number, number][] = [];
      for (const k1 of S_STEPS) for (const k2 of S_STEPS) tries.push([reachIn * k1, reachOut * k2]);
      tries.sort((a, b) => b[0] + b[1] - (a[0] + a[1]) || b[0] - a[0]);
      for (const [e1, e2] of tries) {
        if (e1 + e2 < jog / 2) break;
        const p = sub(corner, scale(din, e1));
        const q = add(route[i + 1]!, scale(dirs[i + 1]!, e2));
        const cubic = sCurve(p, q, din);
        if (
          clear(sampleCubic(cubic), [
            [p, corner],
            [corner, route[i + 1]!],
            [route[i + 1]!, q],
          ])
        ) {
          merged = { from: i - 1, to: i + 1, cut: e1, resume: e2, cubic };
          break;
        }
      }
      if (merged !== undefined) {
        pieces.push(merged);
        taken[i + 1] = merged.resume;
        i += 1;
        continue;
      }
    }
    // A single turn, or one of a U's two (both turn the same way, and each keeps its own arc).
    const room = Math.min(share(i - 1), share(i));
    if (room <= 0) continue;
    const square = Math.min(CORNER_RADIUS_PX, room);
    const most = Math.max(square, Math.min(maxRadius, room));
    for (const r of candidates(most, square)) {
      const cubic = arc(corner, din, dout, r);
      const ok = clear(sampleCubic(cubic), [
        [cubic[0], corner],
        [corner, cubic[3]],
      ]);
      if (ok) {
        pieces.push({ from: i - 1, to: i, cut: r, resume: r, cubic });
        taken[i] = r;
        break;
      }
    }
  }

  let d = `M ${pt(route[0]!)}`;
  const samples: P[] = [route[0]!];
  const byCorner = new Map(pieces.map((piece) => [piece.from + 1, piece] as const));
  for (let i = 1; i < route.length - 1; i += 1) {
    const piece = byCorner.get(i);
    if (piece === undefined) {
      // Too tight to round at all: the corner stays square, as in the square view.
      d += ` L ${pt(route[i]!)}`;
      samples.push(route[i]!);
      continue;
    }
    const [a, b, c, e] = piece.cubic;
    d += ` L ${pt(a)} C ${pt(b)} ${pt(c)} ${pt(e)}`;
    samples.push(...sampleCubic(piece.cubic));
    i = piece.to;
  }
  const end = route[route.length - 1]!;
  d += ` L ${pt(end)}`;
  samples.push(end);

  const first = pieces[0];
  const final = pieces[pieces.length - 1];
  const total = runs[0]!;
  const straight = {
    start: last === 0 ? total : first?.from === 0 ? runs[0]! - first.cut : runs[0]!,
    end: last === 0 ? total : final?.to === last ? runs[last]! - final.resume : runs[last]!,
  };
  return { d, samples: distinct(samples), straight };
}

const outline = (g: CurveBox): P[] => [
  { x: g.x, y: g.y },
  { x: g.x + g.width, y: g.y },
  { x: g.x + g.width, y: g.y + g.height },
  { x: g.x, y: g.y + g.height },
  { x: g.x, y: g.y },
];

/**
 * Every line of a layout, curved. Lines are curved in id order; each is checked against every other line as
 * routed and every line already curved, so no two curves meet and no crossing moves.
 */
export function curvedRoutes(layout: LayoutResult): ReadonlyMap<string, CurvedRoute> {
  const notes: CurveBox[] = [];
  for (const node of layout.nodes) if (node.note !== undefined) notes.push(node.note);
  const captions: CurveBox[] = [];
  for (const group of layout.groups) if (group.caption !== undefined) captions.push(group.caption);
  const frames = layout.groups.map(outline);
  const edges = [...layout.edges]
    .filter((e) => e.points.length >= 2)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const drawn = new Map<string, readonly P[]>();
  const out = new Map<string, CurvedRoute>();
  for (const edge of edges) {
    const others: (readonly P[])[] = [...frames];
    const labels: CurveBox[] = [];
    for (const other of edges) {
      if (other.id === edge.id) continue;
      others.push(other.points);
      const curved = drawn.get(other.id);
      if (curved !== undefined) others.push(curved);
      if (other.labelAnchor !== undefined) labels.push(other.labelAnchor);
    }
    const arrows = arrowsOf(edge.figure, edge.bidirectional);
    const curve = curvedRoute(
      edge.points,
      {
        boxes: [
          ...layout.nodes.filter((node) => node.id !== edge.source && node.id !== edge.target),
          ...notes,
          ...captions,
          ...labels,
        ],
        ends: layout.nodes.filter((node) => node.id === edge.source || node.id === edge.target),
        lines: others,
        ...(edge.labelAnchor === undefined ? {} : { label: edge.labelAnchor }),
      },
      { arrowStart: arrows.start, arrowEnd: arrows.end },
    );
    drawn.set(edge.id, curve.samples);
    out.set(edge.id, curve);
  }
  return out;
}
