/**
 * Orthogonal wire routing around boxes and frames, written for Archer (no third-party code).
 *
 * The method is the published one of Wybrow, Marriott and Stuckey, "Orthogonal Connector
 * Routing" (Graph Drawing 2009), simplified for diagrams of a few hundred boxes:
 *
 * 1. A sparse grid of "interesting" lines: every box edge pushed out by a buffer, both sides of
 *    every frame edge, and the centre lines of every wire end. Grid points inside a buffered box
 *    are blocked, as is every grid step whose middle is.
 * 2. Frames are walls, not obstacles. A grid step that crosses a frame's edge is allowed only for a
 *    wire with exactly one end inside that frame (it has to go in or out); every other wire stays
 *    on its side. No step may run along a frame edge (within the frame buffer), so wires never hug
 *    or trace a frame.
 * 3. A* over (grid point, heading): cost = length + a penalty per bend + a penalty per crossing
 *    with wires already routed or kept + a small cost per unit run on top of another wire. Ends
 *    leave from the middle of a side, preferring the sides the diagram flows through; an
 *    architecture edge leaves only from its declared side.
 * 4. Two passes: every wire routed, then each ripped up and routed again with all others present.
 * 5. Nudging: segments that share a grid line over an overlapping span are spread apart within
 *    the free channel around the line, ordered so that spreading adds no crossing where one can be
 *    avoided (compare where each turns off the line). Wires leaving one side of a box spread along
 *    that side the same way.
 *
 * Pure TypeScript and synchronous, so it runs in a worker or inline in the single-file page.
 */
import type { GraphDirection } from "../diagrams/projection";
import type { LayoutPoint } from "../layout/elk-layout";
import { count, span, type NestProfile } from "./profile";
import { countCrossings, routeCrosses, type Rect } from "./route-geometry";

export type Side = "left" | "right" | "top" | "bottom";

export type OrthoConnection = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** The sides the wire may leave its source by; absent means any. */
  readonly sourceSides?: readonly Side[];
  readonly targetSides?: readonly Side[];
  /**
   * Where on its target's edge the wire must end (a bundle's shared exit on a frame): the only
   * port it may arrive at, and nudging leaves its last segment there.
   */
  readonly targetAt?: LayoutPoint;
};

export type OrthoOptions = {
  /** Clearance kept from a box. */
  readonly buffer: number;
  /** Clearance kept from a frame edge, either side. */
  readonly frameBuffer: number;
  readonly bendPenalty: number;
  readonly crossingPenalty: number;
  /** Cost per unit length run on top of (or within 4 px beside) another wire. */
  readonly overlapPenalty: number;
  /** Cost of each frame edge a wire passes through (it may, into or out of its own end's frame). */
  readonly frameCrossPenalty: number;
  /** The gap nudging aims for between wires sharing a channel. */
  readonly nudgeGap: number;
  /** Routing passes (the second and later rip up and re-route each wire). */
  readonly passes: number;
  /** Cost of a port at a side's end rather than its middle (scaled linearly in between). */
  readonly portOffsetPenalty: number;
  /** Cost per unit length run on top of (or within 4 px beside) a wire that stays: nudging cannot part those. */
  readonly fixedOverlapPenalty: number;
  /** Weight on the A* estimate (1 is optimal; more is faster and a little worse). */
  readonly heuristicWeight: number;
  /** Ports on each side of an end besides the middle, in pairs (0: the middle only; 1: three ports). */
  readonly extraPortsPerSide: number;
  /** Rounds of refinement after nudging (each re-routes the wires that still cross). */
  readonly refineRounds: number;
  /** Requests with more connections than this are routed in one order only. */
  readonly secondOrderLimit: number;
};

const DEFAULT_ORTHO_OPTIONS: OrthoOptions = {
  buffer: 12,
  frameBuffer: 10,
  bendPenalty: 40,
  crossingPenalty: 160,
  overlapPenalty: 0.1,
  frameCrossPenalty: 30,
  nudgeGap: 10,
  passes: 2,
  portOffsetPenalty: 12,
  fixedOverlapPenalty: 1.5,
  heuristicWeight: 1,
  secondOrderLimit: 12,
  extraPortsPerSide: 1,
  refineRounds: 2,
};

/** Where along a side of this length ports may be: the middle, and more on a longer side (at least 20 px apart, 12 px from the corners). */
function portFractions(length: number, most = 1): number[] {
  const count = Math.max(0, Math.min(most, Math.floor((length - 24) / 40)));
  const out = [0.5];
  for (let k = 1; k <= count; k++) {
    const offset = (k / (count + 1)) * 0.5 * (1 - 24 / Math.max(length, 25));
    out.push(0.5 - offset, 0.5 + offset);
  }
  return out;
}

export type OrthoRequest = {
  /** Boxes no wire may pass through but its own ends: every drawn node and note. */
  readonly obstacles: readonly { readonly id: string; readonly rect: Rect }[];
  /** Open frames; also where a wire may end when its end is a frame. */
  readonly frames?: readonly { readonly id: string; readonly rect: Rect }[];
  /** Wires that stay where they are: routed wires avoid crossing and overlapping them. */
  readonly fixed?: readonly (readonly LayoutPoint[])[];
  readonly connections: readonly OrthoConnection[];
  readonly direction?: GraphDirection;
  readonly options?: Partial<OrthoOptions>;
  /** Where to record spans (grid, search, nudge) and counters; optional. */
  readonly profile?: NestProfile;
};

/* Headings: 0 +x, 1 −x, 2 +y, 3 −y. */
const DX = [1, -1, 0, 0] as const;
const DY = [0, 0, 1, -1] as const;
const REVERSE = [1, 0, 3, 2] as const;
const EPS = 0.5;

/** Lines closer than this are one line. Exact on purpose: merging nearby lines moves a wire's end off its box. */
const SAME_LINE = 1e-6;
/** The most grid points a request may build (about 150 bytes each, so about 75 MB): past it, nothing is routed. */
const MAX_GRID_POINTS = 500_000;

/** Sorted distinct values. */
function lines(values: number[]): Float64Array {
  values.sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of values) if (out.length === 0 || v - out[out.length - 1]! > SAME_LINE) out.push(v);
  return Float64Array.from(out);
}

/** First index with arr[i] >= v. */
function lowerBound(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The index of the line at v, or -1. */
function lineAt(arr: Float64Array, v: number): number {
  const i = lowerBound(arr, v - 2 * SAME_LINE);
  return i < arr.length && Math.abs(arr[i]! - v) <= 2 * SAME_LINE ? i : -1;
}

/** Indices of the lines strictly between lo and hi. */
function between(arr: Float64Array, lo: number, hi: number): [number, number] {
  return [lowerBound(arr, lo + EPS), lowerBound(arr, hi - EPS)];
}

/** A binary min-heap of (key, value) in typed arrays that grow by doubling. */
class Heap {
  private keys = new Float64Array(1024);
  private vals = new Int32Array(1024);
  private count = 0;
  get size(): number {
    return this.count;
  }
  push(key: number, val: number): void {
    if (this.count === this.keys.length) {
      const keys = new Float64Array(this.count * 2);
      keys.set(this.keys);
      this.keys = keys;
      const vals = new Int32Array(this.count * 2);
      vals.set(this.vals);
      this.vals = vals;
    }
    const keys = this.keys;
    const vals = this.vals;
    let i = this.count++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= key) break;
      keys[i] = keys[parent]!;
      vals[i] = vals[parent]!;
      i = parent;
    }
    keys[i] = key;
    vals[i] = val;
  }
  /** The value with the least key (the heap must not be empty). */
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0]!;
    const n = --this.count;
    if (n > 0) {
      const lastKey = keys[n]!;
      const lastVal = vals[n]!;
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1]! < keys[child]!) child++;
        if (keys[child]! >= lastKey) break;
        keys[i] = keys[child]!;
        vals[i] = vals[child]!;
        i = child;
      }
      keys[i] = lastKey;
      vals[i] = lastVal;
    }
    return top;
  }
  clear(): void {
    this.count = 0;
  }
}

type End = {
  readonly id: string;
  readonly rect: Rect;
  readonly frame: boolean;
  /** Indices of the frames this end is inside. */
  readonly within: ReadonlySet<number>;
};

type Port = {
  readonly point: number;
  readonly heading: number;
  readonly boundary: LayoutPoint;
  readonly penalty: number;
  readonly side: Side;
};

const SIDES: readonly Side[] = ["right", "left", "bottom", "top"];
/** The heading a wire leaves a side by (outwards). */
const OUTWARD: Record<Side, number> = { right: 0, left: 1, bottom: 2, top: 3 };

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.width <= outer.x + outer.width + EPS &&
    inner.y + inner.height <= outer.y + outer.height + EPS
  );
}

/** The sides a wire's source (and target) prefer in a flow direction: [source, target]. */
function preferred(direction: GraphDirection | undefined): [Side, Side] {
  switch (direction) {
    case "lr":
      return ["right", "left"];
    case "rl":
      return ["left", "right"];
    case "bt":
      return ["top", "bottom"];
    default:
      return ["bottom", "top"];
  }
}

const OPPOSITE: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };

/** Routes every connection; one that cannot be routed is left out of the result. */
export function routeOrthogonalJs(request: OrthoRequest): Map<string, LayoutPoint[]> {
  const o = { ...DEFAULT_ORTHO_OPTIONS, ...request.options };
  const b = o.buffer;
  const fb = o.frameBuffer;
  const obstacles = request.obstacles;
  const frames = request.frames ?? [];
  const rects = new Map<string, { rect: Rect; frame: boolean }>();
  for (const { id, rect } of obstacles) rects.set(id, { rect, frame: false });
  for (const { id, rect } of frames) if (!rects.has(id)) rects.set(id, { rect, frame: true });

  const endOf = (id: string): End | undefined => {
    const found = rects.get(id);
    if (found === undefined) return undefined;
    const within = new Set<number>();
    frames.forEach((f, index) => {
      if (f.id !== id && inside(found.rect, f.rect)) within.add(index);
    });
    return { id, rect: found.rect, frame: found.frame, within };
  };

  const profile = request.profile;
  count(profile, "router.calls");
  const sideSpread = o.extraPortsPerSide;
  const gridStart = profile === undefined ? 0 : performance.now();
  // 1. The grid.
  const xsRaw: number[] = [];
  const ysRaw: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (r: Rect) => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  };
  for (const { rect } of obstacles) {
    xsRaw.push(rect.x - b, rect.x + rect.width + b);
    ysRaw.push(rect.y - b, rect.y + rect.height + b);
    extend(rect);
  }
  for (const { rect } of frames) {
    xsRaw.push(rect.x - fb, rect.x + fb, rect.x + rect.width - fb, rect.x + rect.width + fb);
    ysRaw.push(rect.y - fb, rect.y + fb, rect.y + rect.height - fb, rect.y + rect.height + fb);
    extend(rect);
  }
  const ended = new Set<string>();
  for (const connection of request.connections) {
    if (connection.targetAt !== undefined) {
      xsRaw.push(connection.targetAt.x);
      ysRaw.push(connection.targetAt.y);
    }
    for (const id of [connection.source, connection.target]) {
      const found = rects.get(id);
      if (found === undefined || ended.has(id)) continue;
      ended.add(id);
      const r = found.rect;
      for (const f of portFractions(r.width, sideSpread)) xsRaw.push(r.x + f * r.width);
      for (const f of portFractions(r.height, sideSpread)) ysRaw.push(r.y + f * r.height);
      if (!found.frame) {
        // Half-buffer lines only on a side with a box close enough to block the full-buffer one.
        const close = (side: Side) =>
          obstacles.some(({ id: other, rect: q }) => {
            if (other === id) return false;
            const reach = 1.5 * b;
            if (side === "left" || side === "right") {
              const edge = side === "left" ? r.x - reach : r.x + r.width;
              return q.x < edge + reach && q.x + q.width > edge && q.y < r.y + r.height && q.y + q.height > r.y;
            }
            const edge = side === "top" ? r.y - reach : r.y + r.height;
            return q.y < edge + reach && q.y + q.height > edge && q.x < r.x + r.width && q.x + q.width > r.x;
          });
        if (close("left")) xsRaw.push(r.x - b / 2);
        if (close("right")) xsRaw.push(r.x + r.width + b / 2);
        if (close("top")) ysRaw.push(r.y - b / 2);
        if (close("bottom")) ysRaw.push(r.y + r.height + b / 2);
      }
    }
  }
  if (!Number.isFinite(minX)) return new Map();
  const margin = 2 * b + 2 * fb;
  xsRaw.push(minX - margin, maxX + margin);
  ysRaw.push(minY - margin, maxY + margin);
  const xs = lines(xsRaw);
  const ys = lines(ysRaw);
  const nx = xs.length;
  const ny = ys.length;
  const n = nx * ny;
  // A sound failure rather than hundreds of megabytes: the caller falls back for every wire.
  if (n > MAX_GRID_POINTS) return new Map();
  const blockedP = new Uint8Array(n);
  /** Step from point p to p+1 (H) or p+nx (V). */
  const blockedH = new Uint8Array(n);
  const blockedV = new Uint8Array(n);
  const frameH = new Int32Array(n);
  const frameV = new Int32Array(n);
  const multiFrame = new Map<number, number[]>();
  const fixedCrossH = new Uint16Array(n);
  const fixedCrossV = new Uint16Array(n);
  const fixedNearH = new Uint16Array(n);
  const fixedNearV = new Uint16Array(n);
  const usedH = new Uint16Array(n);
  const usedV = new Uint16Array(n);
  const thruH = new Uint16Array(n);
  const thruV = new Uint16Array(n);

  // Blocked within half the buffer: wires keep the full buffer where they can (the grid's lines
  // are there) and squeeze to half of it only through a tight gap beside a wire's own end.
  const hb = b / 2;
  // Steps inside a box's full buffer (but outside the blocked half) are allowed at a price.
  const tightH = new Uint8Array(n);
  const tightV = new Uint8Array(n);
  for (const { rect } of obstacles) {
    const [i0, i1] = between(xs, rect.x - b, rect.x + rect.width + b);
    const [j0, j1] = between(ys, rect.y - b, rect.y + rect.height + b);
    for (let j = j0; j < j1; j++) for (let i = Math.max(0, i0 - 1); i < i1 && i < nx - 1; i++) tightH[j * nx + i] = 1;
    for (let j = Math.max(0, j0 - 1); j < j1 && j < ny - 1; j++) for (let i = i0; i < i1; i++) tightV[j * nx + i] = 1;
  }
  for (const { rect } of obstacles) {
    const L = rect.x - hb;
    const R = rect.x + rect.width + hb;
    const T = rect.y - hb;
    const B = rect.y + rect.height + hb;
    const [i0, i1] = between(xs, L, R);
    const [j0, j1] = between(ys, T, B);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) blockedP[j * nx + i] = 1;
    // A step is blocked when its middle is inside: steps from line i0-1 (the left buffer line) on.
    const hi0 = Math.max(0, i0 - 1);
    for (let j = j0; j < j1; j++) for (let i = hi0; i < i1 && i < nx - 1; i++) blockedH[j * nx + i] = 1;
    const vj0 = Math.max(0, j0 - 1);
    for (let j = vj0; j < j1 && j < ny - 1; j++) for (let i = i0; i < i1; i++) blockedV[j * nx + i] = 1;
  }
  const markFrame = (arr: Int32Array, index: number, frame: number) => {
    const was = arr[index]!;
    if (was === 0) arr[index] = frame + 1;
    else {
      const key = arr === frameH ? index : index + n;
      const list = was === -1 ? multiFrame.get(key)! : [was - 1];
      list.push(frame);
      multiFrame.set(key, list);
      arr[index] = -1;
    }
  };
  frames.forEach(({ rect }, f) => {
    const L = rect.x;
    const R = rect.x + rect.width;
    const T = rect.y;
    const B = rect.y + rect.height;
    const [j0, j1] = between(ys, T, B);
    for (const X of [L, R]) {
      // The step from line i to i+1 crosses X when xs[i] < X <= xs[i+1].
      const i = lowerBound(xs, X) - 1;
      if (i < 0 || i >= nx - 1) continue;
      for (let j = j0; j < j1; j++) markFrame(frameH, j * nx + i, f);
    }
    const [i0, i1] = between(xs, L, R);
    for (const Y of [T, B]) {
      const j = lowerBound(ys, Y) - 1;
      if (j < 0 || j >= ny - 1) continue;
      for (let i = i0; i < i1; i++) markFrame(frameV, j * nx + i, f);
    }
    // No run along a frame edge: steps on lines closer to it than the frame buffer are blocked.
    const hug = Math.min(fb - 1, 6);
    for (const Y of [T, B]) {
      const [ja, jb] = between(ys, Y - hug, Y + hug);
      const [ia, ib] = between(xs, L - fb - EPS, R + fb + EPS);
      for (let j = ja; j < jb; j++)
        for (let i = Math.max(0, ia - 1); i < ib && i < nx - 1; i++) blockedH[j * nx + i] = 1;
    }
    for (const X of [L, R]) {
      const [ia, ib] = between(xs, X - hug, X + hug);
      const [ja, jb] = between(ys, T - fb - EPS, B + fb + EPS);
      for (let i = ia; i < ib; i++)
        for (let j = Math.max(0, ja - 1); j < jb && j < ny - 1; j++) blockedV[j * nx + i] = 1;
    }
  });
  const NEAR = 4;
  for (const points of request.fixed ?? []) {
    for (let k = 1; k < points.length; k++) {
      const p = points[k - 1]!;
      const q = points[k]!;
      if (Math.abs(p.x - q.x) < 0.01) {
        const X = p.x;
        const y0 = Math.min(p.y, q.y);
        const y1 = Math.max(p.y, q.y);
        const i = lowerBound(xs, X) - 1;
        const [j0, j1] = between(ys, y0, y1);
        if (i >= 0 && i < nx - 1) for (let j = j0; j < j1; j++) fixedCrossH[j * nx + i]++;
        const [ia, ib] = between(xs, X - NEAR, X + NEAR);
        const ja = Math.max(0, lowerBound(ys, y0) - 1);
        for (let ii = ia; ii < ib; ii++)
          for (let j = ja; j < ny - 1 && ys[j]! < y1; j++) if (ys[j + 1]! > y0) fixedNearV[j * nx + ii]++;
      } else if (Math.abs(p.y - q.y) < 0.01) {
        const Y = p.y;
        const x0 = Math.min(p.x, q.x);
        const x1 = Math.max(p.x, q.x);
        const j = lowerBound(ys, Y) - 1;
        const [i0, i1] = between(xs, x0, x1);
        if (j >= 0 && j < ny - 1) for (let i = i0; i < i1; i++) fixedCrossV[j * nx + i]++;
        const [ja, jb] = between(ys, Y - NEAR, Y + NEAR);
        const ia = Math.max(0, lowerBound(xs, x0) - 1);
        for (let jj = ja; jj < jb; jj++)
          for (let i = ia; i < nx - 1 && xs[i]! < x1; i++) if (xs[i + 1]! > x0) fixedNearH[jj * nx + i]++;
      }
    }
  }

  if (profile !== undefined) {
    profile.spans.grid = (profile.spans.grid ?? 0) + performance.now() - gridStart;
    count(profile, "grid.points", n);
    count(profile, "grid.lines", nx + ny);
  }
  // 2. Ends and ports. A place where a wire that stays already meets a box is taken.
  const takenEnds = (request.fixed ?? []).flatMap((points) =>
    points.length < 2 ? [] : [points[0]!, points[points.length - 1]!],
  );
  const taken = (p: LayoutPoint) => takenEnds.some((q) => Math.abs(q.x - p.x) < 3 && Math.abs(q.y - p.y) < 3);
  const [prefSource, prefTarget] = preferred(request.direction);
  const sidePenalty = (side: Side, pref: Side) =>
    side === pref ? 0 : side === OPPOSITE[pref] ? 1.5 * o.bendPenalty : 0.5 * o.bendPenalty;
  const portsOf = (
    end: End,
    other: End,
    allowed: readonly Side[] | undefined,
    pref: Side,
    at?: LayoutPoint,
  ): Port[] => {
    const r = end.rect;
    // A frame end whose other end is inside it is reached from inside.
    const inward = end.frame && inside(other.rect, r);
    const fullGap = end.frame ? fb : b;
    if (at !== undefined) {
      // One port, exactly at `at`, on the side it lies on.
      const side = (["left", "right", "top", "bottom"] as const)
        .map(
          (name) =>
            [
              name,
              name === "left"
                ? Math.abs(at.x - r.x)
                : name === "right"
                  ? Math.abs(at.x - r.x - r.width)
                  : name === "top"
                    ? Math.abs(at.y - r.y)
                    : Math.abs(at.y - r.y - r.height),
            ] as const,
        )
        .sort((p, q) => p[1] - q[1])[0]![0];
      // Not at a corner: the side would be ambiguous and the approach could run along the other edge.
      const along = side === "left" || side === "right" ? at.y - r.y : at.x - r.x;
      const length = side === "left" || side === "right" ? r.height : r.width;
      if (along < 12 || along > length - 12) return [];
      const out = inward ? -1 : 1;
      const px = side === "right" ? at.x + out * fullGap : side === "left" ? at.x - out * fullGap : at.x;
      const py = side === "bottom" ? at.y + out * fullGap : side === "top" ? at.y - out * fullGap : at.y;
      const i = lineAt(xs, px);
      const j = lineAt(ys, py);
      if (i < 0 || j < 0 || blockedP[j * nx + i] === 1) return [];
      return [
        { point: j * nx + i, heading: inward ? REVERSE[OUTWARD[side]] : OUTWARD[side], boundary: at, penalty: 0, side },
      ];
    }
    const ports: Port[] = [];
    for (const side of allowed ?? SIDES) {
      const vertical = side === "left" || side === "right";
      // Several places along the side: the middle is free, the others cost a little, so wires
      // to one box can arrive side by side on lines of their own.
      for (const [f, gap, tight] of portFractions(vertical ? r.height : r.width, sideSpread).flatMap((f) => [
        [f, fullGap, 0] as const,
        [f, fullGap / 2, 1] as const,
      ])) {
        if (end.frame && tight === 1) continue;
        const ax = r.x + f * r.width;
        const ay = r.y + f * r.height;
        const boundary =
          side === "right"
            ? { x: r.x + r.width, y: ay }
            : side === "left"
              ? { x: r.x, y: ay }
              : side === "bottom"
                ? { x: ax, y: r.y + r.height }
                : { x: ax, y: r.y };
        const out = inward ? -1 : 1;
        const px = side === "right" ? boundary.x + out * gap : side === "left" ? boundary.x - out * gap : ax;
        const py = side === "bottom" ? boundary.y + out * gap : side === "top" ? boundary.y - out * gap : ay;
        const i = lineAt(xs, px);
        const j = lineAt(ys, py);
        if (i < 0 || j < 0) continue;
        const point = j * nx + i;
        if (blockedP[point] === 1) continue;
        const heading = inward ? REVERSE[OUTWARD[side]] : OUTWARD[side];
        if (taken(boundary)) continue;
        // The stub from the box to the grid must itself be clear: no box in it, no frame edge across it.
        const stub = [boundary, { x: px, y: py }];
        if (obstacles.some((ob) => ob.id !== end.id && routeCrosses(stub, ob.rect, 0.01))) continue;
        if (frames.some((f) => f.id !== end.id && stubCrossesFrame(boundary, { x: px, y: py }, f.rect))) continue;
        // The half-buffer place only where the full one is blocked.
        if (
          tight === 1 &&
          ports.some((p) => p.side === side && p.boundary.x === boundary.x && p.boundary.y === boundary.y)
        )
          continue;
        ports.push({
          point,
          heading,
          boundary,
          penalty: sidePenalty(side, pref) + o.portOffsetPenalty * Math.abs(f - 0.5) * 2 + tight * o.bendPenalty * 0.5,
          side,
        });
      }
    }
    return ports;
  };

  // 3. A*. Each step's cost that does not change from wire to wire (its length, the price of a
  // tight lane, crossing or running beside fixed wires) is summed once; -1 marks a blocked step.
  const baseH = new Float64Array(n);
  const baseV = new Float64Array(n);
  const lengthH = new Float64Array(n);
  const lengthV = new Float64Array(n);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p = j * nx + i;
      if (i < nx - 1) {
        const length = xs[i + 1]! - xs[i]!;
        lengthH[p] = length;
        baseH[p] =
          blockedH[p] === 1
            ? -1
            : length +
              (tightH[p] === 1 ? 2 * length + o.bendPenalty / 2 : 0) +
              o.fixedOverlapPenalty * fixedNearH[p]! * length +
              o.crossingPenalty * fixedCrossH[p]!;
      }
      if (j < ny - 1) {
        const length = ys[j + 1]! - ys[j]!;
        lengthV[p] = length;
        baseV[p] =
          blockedV[p] === 1
            ? -1
            : length +
              (tightV[p] === 1 ? 2 * length + o.bendPenalty / 2 : 0) +
              o.fixedOverlapPenalty * fixedNearV[p]! * length +
              o.crossingPenalty * fixedCrossV[p]!;
      }
    }
  }
  const states = 4 * n;
  const g = new Float64Array(states);
  const parent = new Int32Array(states);
  const stamp = new Uint32Array(states);
  const closed = new Uint32Array(states);
  let generation = 0;
  const heap = new Heap();
  /** Goal port per point for the current search (valid where goalStamp matches). */
  const goalStamp = new Uint32Array(n);
  const goalPort = new Int32Array(n);

  type Routed = { steps: number[]; points: LayoutPoint[]; source: End; target: End; pinned: boolean };
  const routed = new Map<string, Routed>();

  const occupy = (steps: readonly number[], delta: number) => {
    for (let k = 1; k < steps.length; k++) {
      const p = steps[k - 1]!;
      const q = steps[k]!;
      if (q === p + 1) usedH[p] += delta;
      else if (q === p - 1) usedH[q] += delta;
      else if (q === p + nx) usedV[p] += delta;
      else usedV[q] += delta;
      if (k + 1 < steps.length) {
        const r = steps[k + 1]!;
        if (r - q === q - p) {
          if (Math.abs(q - p) === 1) thruH[q] += delta;
          else thruV[q] += delta;
        }
      }
    }
  };

  let overlapCost = o.overlapPenalty;
  let expanded = 0;
  /** Which part of the routing a search belongs to, for the counters. */
  let stage = "pass1";
  const search = (connection: OrthoConnection): Routed | undefined => {
    if (profile === undefined) return searchOne(connection);
    return span(profile, "search", () => {
      count(profile, "search.calls");
      count(profile, `search.calls.${stage}`);
      const before = expanded;
      const found = searchOne(connection);
      count(profile, "search.expanded", expanded - before);
      return found;
    });
  };
  const searchOne = (connection: OrthoConnection): Routed | undefined => {
    const source = endOf(connection.source);
    const target = endOf(connection.target);
    if (source === undefined || target === undefined || source.id === target.id) return undefined;
    const starts = portsOf(source, target, connection.sourceSides, prefSource);
    const goals = portsOf(target, source, connection.targetSides, prefTarget, connection.targetAt);
    if (starts.length === 0 || goals.length === 0) return undefined;
    // 1: may only leave (its source is inside, its target is not); 2: may only enter; 0: never cross.
    const allowed = new Uint8Array(frames.length);
    for (let f = 0; f < frames.length; f++)
      allowed[f] = source.within.has(f) === target.within.has(f) ? 0 : source.within.has(f) ? 1 : 2;
    /** Whether a step into point q may cross frame f's edge. */
    const passes = (f: number, q: number): boolean => {
      const rule = allowed[f]!;
      if (rule === 0) return false;
      const r = frames[f]!.rect;
      const qi = q % nx;
      const x = xs[qi]!;
      const y = ys[(q - qi) / nx]!;
      // A point ON the edge counts as inside: the step after it, inward, is not marked as a
      // crossing, so arriving on the edge from outside is already entering.
      const into = x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
      return rule === 2 ? into : !into;
    };
    const goalAt = new Map<number, Port>();
    for (const [k, port] of goals.entries()) {
      goalAt.set(port.point, port);
      goalStamp[port.point] = generation + 1;
      goalPort[port.point] = k;
    }
    // Distinct goal points only (several ports can share one).
    const goalPoints = [...new Set(goals.map((p) => p.point))];
    const gx = Float64Array.from(goalPoints, (p) => xs[p % nx]!);
    const gy = Float64Array.from(goalPoints, (p) => ys[Math.floor(p / nx)]!);
    // Distance plus the bends the heading still forces, weighted (weighted A*: a little
    // optimality traded for far fewer expansions when crossing costs dwarf distance).
    const h = (point: number, heading: number) => {
      const pi = point % nx;
      const x = xs[pi]!;
      const y = ys[(point - pi) / nx]!;
      let best = Infinity;
      for (let k = 0; k < gx.length; k++) {
        const dx = gx[k]! - x;
        const dy = gy[k]! - y;
        const ax = Math.abs(dx) < EPS;
        const ay = Math.abs(dy) < EPS;
        const towardX = (heading === 0 && dx > EPS) || (heading === 1 && dx < -EPS);
        const towardY = (heading === 2 && dy > EPS) || (heading === 3 && dy < -EPS);
        const bends = ax && ay ? 0 : ax ? (towardY ? 0 : 2) : ay ? (towardX ? 0 : 2) : towardX || towardY ? 1 : 2;
        best = Math.min(best, Math.abs(dx) + Math.abs(dy) + bends * o.bendPenalty);
      }
      return o.heuristicWeight * best;
    };
    generation++;
    heap.clear();
    const GOAL = states; // a virtual state: reached the target through `bestGoal`
    let bestGoal = -1;
    let bestGoalCost = Infinity;
    for (const port of starts) {
      const s = port.point * 4 + port.heading;
      const cost = port.penalty;
      if (stamp[s] !== generation || cost < g[s]!) {
        stamp[s] = generation;
        g[s] = cost;
        parent[s] = -1;
        heap.push(cost + h(port.point, port.heading), s);
      }
    }
    while (heap.size > 0) {
      const s = heap.pop();
      expanded++;
      if (s === GOAL) break;
      if (closed[s] === generation) continue;
      closed[s] = generation;
      const point = s >> 2;
      const heading = s & 3;
      const cost = g[s]!;
      const goal = goalStamp[point] === generation ? goals[goalPort[point]!] : undefined;
      if (goal !== undefined) {
        // Arriving the way the port faces is free; otherwise the last stub is one more bend.
        const arrive = REVERSE[goal.heading];
        const total = cost + goal.penalty + (heading === arrive ? 0 : o.bendPenalty);
        if (total < bestGoalCost) {
          bestGoalCost = total;
          bestGoal = s;
          heap.push(total, GOAL);
        }
      }
      const i = point % nx;
      const j = (point - i) / nx;
      for (let d = 0; d < 4; d++) {
        if (d === REVERSE[heading]) continue;
        const ni = i + DX[d]!;
        const nj = j + DY[d]!;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const q = nj * nx + ni;
        if (blockedP[q] === 1) continue;
        const horizontal = d < 2;
        const step = horizontal ? (d === 0 ? point : q) : d === 2 ? point : q;
        const base = horizontal ? baseH[step]! : baseV[step]!;
        if (base < 0) continue;
        let extra = 0;
        const crossed = horizontal ? frameH[step]! : frameV[step]!;
        if (crossed > 0) {
          if (!passes(crossed - 1, q)) continue;
          extra = o.frameCrossPenalty;
        } else if (crossed < 0) {
          const list = multiFrame.get(horizontal ? step : step + n)!;
          let ok = true;
          for (const f of list) if (!passes(f, q)) ok = false;
          if (!ok) continue;
          extra = o.frameCrossPenalty * list.length;
        }
        // The parts that change as wires are routed: running on them, crossing them.
        const dynamic = horizontal
          ? overlapCost * usedH[step]! * lengthH[step]! + o.crossingPenalty * thruV[q]!
          : overlapCost * usedV[step]! * lengthV[step]! + o.crossingPenalty * thruH[q]!;
        const next = cost + base + extra + (d === heading ? 0 : o.bendPenalty) + dynamic;
        const t = q * 4 + d;
        if (closed[t] === generation) continue;
        if (stamp[t] !== generation || next < g[t]!) {
          stamp[t] = generation;
          g[t] = next;
          parent[t] = s;
          heap.push(next + h(q, d), t);
        }
      }
    }
    if (bestGoal < 0) return undefined;
    const steps: number[] = [];
    for (let s = bestGoal; s >= 0; s = parent[s]!) {
      const point = s >> 2;
      if (steps.length === 0 || steps[steps.length - 1] !== point) steps.push(point);
    }
    steps.reverse();
    const startPort = starts.find((p) => p.point === steps[0])!;
    const endPort = goalAt.get(steps[steps.length - 1]!)!;
    const raw: LayoutPoint[] = [
      startPort.boundary,
      ...steps.map((p) => ({ x: xs[p % nx]!, y: ys[Math.floor(p / nx)]! })),
      endPort.boundary,
    ];
    return { steps, points: simplify(raw), source, target, pinned: connection.targetAt !== undefined };
  };

  const order = [...request.connections].sort((p, q) => spanOf(p) - spanOf(q));
  function spanOf(c: OrthoConnection): number {
    const a = rects.get(c.source)?.rect;
    const z = rects.get(c.target)?.rect;
    if (a === undefined || z === undefined) return 0;
    return Math.abs(a.x + a.width / 2 - z.x - z.width / 2) + Math.abs(a.y + a.height / 2 - z.y - z.height / 2);
  }
  // 5. Nudging, then refinement: a wire that still crosses after nudging (often because it shares
  // a line with another and leaves it on the other side) is routed again with sharing made dear,
  // and the round is kept only if it crosses less in all.
  const boxes = obstacles.map((ob) => ob.rect);
  const frameRects = frames.map((f) => f.rect);
  const fixedRoutes = request.fixed ?? [];
  const finalise = (): ReturnType<typeof finaliseOnce> => span(profile, "nudge", finaliseOnce);
  const finaliseOnce = (): { result: Map<string, LayoutPoint[]>; crossings: Map<string, number>; total: number } => {
    const ids = [...routed.keys()];
    const before = ids.map((id) => routed.get(id)!.points.map((p) => ({ ...p })));
    const after = before.map((points) => points.map((p) => ({ ...p })));
    const ends = ids.map((id) => routed.get(id)!);
    nudge(after, before, ends, boxes, frameRects, fixedRoutes, true, o.nudgeGap);
    nudge(after, before, ends, boxes, frameRects, fixedRoutes, false, o.nudgeGap);
    const result = new Map<string, LayoutPoint[]>();
    ids.forEach((id, index) => {
      const nudged = simplify(rebuild(before[index]!, after[index]!));
      const own = ends[index]!;
      // A nudge that pushed a wire into a box is undone for that wire (the grid route is clear).
      const clear = obstacles.every(
        (ob) => ob.id === own.source.id || ob.id === own.target.id || !routeCrosses(nudged, ob.rect, 1),
      );
      result.set(id, clear ? nudged : before[index]!);
    });
    const crossings = new Map<string, number>(ids.map((id) => [id, 0]));
    const lines = ids.map((id) => result.get(id)!);
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      let mine = 0;
      for (const fixed of fixedRoutes) mine += countCrossings(lines[i]!, fixed);
      total += mine;
      for (let j = i + 1; j < lines.length; j++) {
        const c = countCrossings(lines[i]!, lines[j]!);
        if (c > 0) {
          crossings.set(ids[j]!, crossings.get(ids[j]!)! + c);
          mine += c;
          total += c;
        }
      }
      crossings.set(ids[i]!, crossings.get(ids[i]!)! + mine);
    }
    return { result, crossings, total };
  };
  /** The proper crossings a routed wire has now, with the other routed wires and the fixed ones. */
  const crossingsNow = (id: string): number => {
    const mine = routed.get(id);
    if (mine === undefined) return 0;
    let total = 0;
    for (const [other, r] of routed) if (other !== id) total += countCrossings(mine.points, r.points);
    for (const fixed of request.fixed ?? []) total += countCrossings(mine.points, fixed);
    return total;
  };
  /** One full routing in the given order: passes, nudging, refinement. */
  const attempt = (ord: readonly OrthoConnection[]): ReturnType<typeof finalise> => {
    for (const r of routed.values()) occupy(r.steps, -1);
    routed.clear();
    for (let pass = 0; pass < Math.max(1, o.passes); pass++) {
      stage = ord === order ? `pass${pass + 1}` : `order2.pass${pass + 1}`;
      // Later passes rip up only the wires that cross something.
      const todo = pass === 0 ? ord : ord.filter((c) => crossingsNow(c.id) > 0);
      for (const connection of todo) {
        const was = routed.get(connection.id);
        if (was !== undefined) occupy(was.steps, -1);
        const found = search(connection);
        if (found !== undefined) {
          routed.set(connection.id, found);
          occupy(found.steps, 1);
        } else if (was !== undefined) occupy(was.steps, 1);
      }
    }

    let best = finalise();
    for (let round = 0; round < o.refineRounds && best.total > 0; round++) {
      const saved = new Map(routed);
      const worst = ord
        .filter((c) => (best.crossings.get(c.id) ?? 0) > 0)
        .sort((p, q) => best.crossings.get(q.id)! - best.crossings.get(p.id)!);
      overlapCost = o.overlapPenalty * 8 + 1;
      stage = "refine";
      for (const connection of worst) {
        const was = routed.get(connection.id);
        if (was === undefined) continue;
        occupy(was.steps, -1);
        const found = search(connection);
        const next = found ?? was;
        routed.set(connection.id, next);
        occupy(next.steps, 1);
      }
      overlapCost = o.overlapPenalty;
      const candidate = finalise();
      if (candidate.total < best.total) best = candidate;
      else {
        for (const r of routed.values()) occupy(r.steps, -1);
        routed.clear();
        for (const [id, r] of saved) {
          routed.set(id, r);
          occupy(r.steps, 1);
        }
        break;
      }
    }
    return best;
  };
  // Routing order matters; two are tried (shortest span first, then longest) and the one that
  // crosses less is kept.
  let best = attempt(order);
  if (best.total > 0 && order.length > 1 && order.length <= o.secondOrderLimit) {
    const other = attempt([...order].reverse());
    if (other.total < best.total) best = other;
  }
  const result = best.result;
  count(profile, "wires.routed", request.connections.length);
  return result;
}

/** Drops repeated points and points in the middle of a straight run. */
export function simplify(points: readonly LayoutPoint[]): LayoutPoint[] {
  const out: LayoutPoint[] = [];
  for (const raw of points) {
    // Nudging arithmetic can leave a segment a hair off the axis: snap it back.
    const prev = out[out.length - 1];
    const p =
      prev === undefined
        ? raw
        : { x: Math.abs(raw.x - prev.x) < 0.5 ? prev.x : raw.x, y: Math.abs(raw.y - prev.y) < 0.5 ? prev.y : raw.y };
    const last = out[out.length - 1];
    if (last !== undefined && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!;
      const m = out[out.length - 1]!;
      const straight =
        (Math.abs(a.x - m.x) < 0.01 && Math.abs(m.x - p.x) < 0.01) ||
        (Math.abs(a.y - m.y) < 0.01 && Math.abs(m.y - p.y) < 0.01);
      if (straight) out.pop();
    }
    out.push(p);
  }
  return out;
}

type Segment = {
  readonly route: number;
  readonly k: number;
  readonly c: number;
  readonly lo: number;
  readonly hi: number;
  /** Which way the wire turns off the line at its low end (−1, +1), or 0 at a wire end. */
  readonly loTurn: number;
  readonly hiTurn: number;
  /** For a segment that ends at a box: the range its line may move within (the box's side). */
  readonly bound: readonly [number, number] | undefined;
};

/**
 * Spreads apart segments that share a line (`horizontal`: segments along x, at one y) over an
 * overlapping span, inside the free channel around it. Mutates `routes`.
 */
function nudge(
  routes: { x: number; y: number }[][],
  topology: readonly (readonly LayoutPoint[])[],
  ends: readonly { source: End; target: End; pinned: boolean }[],
  boxes: readonly Rect[],
  frames: readonly Rect[],
  fixed: readonly (readonly LayoutPoint[])[],
  horizontal: boolean,
  gap: number,
): void {
  const along = (p: LayoutPoint) => (horizontal ? p.x : p.y);
  const across = (p: LayoutPoint) => (horizontal ? p.y : p.x);
  const segments: Segment[] = [];
  routes.forEach((points, route) => {
    for (let k = 0; k + 1 < points.length; k++) {
      const p = points[k]!;
      const q = points[k + 1]!;
      if (Math.abs(across(p) - across(q)) > 0.01 || Math.abs(along(p) - along(q)) < 0.01) continue;
      const c = across(p);
      const forward = along(q) > along(p);
      const turn = (index: number) => {
        const neighbour = points[index];
        if (neighbour === undefined) return 0;
        return Math.sign(across(neighbour) - c);
      };
      const before = turn(k - 1);
      const after = turn(k + 2);
      let bound: [number, number] | undefined;
      const sideRange = (r: Rect): [number, number] =>
        horizontal ? [r.y + 6, r.y + r.height - 6] : [r.x + 6, r.x + r.width - 6];
      if (k === 0) bound = sideRange(ends[route]!.source.rect);
      if (k + 2 === points.length) {
        // A pinned end (a bundle's shared exit) stays exactly where it is.
        const r: [number, number] = ends[route]!.pinned ? [c, c] : sideRange(ends[route]!.target.rect);
        bound = bound === undefined ? r : [Math.max(bound[0], r[0]), Math.min(bound[1], r[1])];
      }
      segments.push({
        route,
        k,
        c,
        lo: Math.min(along(p), along(q)),
        hi: Math.max(along(p), along(q)),
        loTurn: forward ? before : after,
        hiTurn: forward ? after : before,
        bound,
      });
    }
  });
  const byLine = new Map<number, Segment[]>();
  for (const s of segments) {
    const key = Math.round(s.c * 2);
    const list = byLine.get(key);
    if (list === undefined) byLine.set(key, [s]);
    else list.push(s);
  }
  const unit = horizontal ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const compare = (a: Segment, z: Segment): number =>
    sideVote(topology, a, z, unit, horizontal, false) || sideVote(topology, a, z, unit, horizontal, true);
  for (const list of byLine.values()) {
    if (list.length < 2) continue;
    list.sort((p, q) => p.lo - q.lo);
    const clusters: Segment[][] = [];
    let current: Segment[] = [];
    let reach = -Infinity;
    for (const s of list) {
      if (current.length > 0 && s.lo < reach - EPS) {
        current.push(s);
        reach = Math.max(reach, s.hi);
      } else {
        if (current.length > 1) clusters.push(current);
        current = [s];
        reach = s.hi;
      }
    }
    if (current.length > 1) clusters.push(current);
    for (const cluster of clusters) {
      // Order: insertion sort with the pairwise rule (it need not be transitive).
      const ordered: Segment[] = [];
      for (const s of cluster) {
        let at = ordered.length;
        while (at > 0 && compare(s, ordered[at - 1]!) < 0) at--;
        ordered.splice(at, 0, s);
      }
      const c = cluster[0]!.c;
      const lo = Math.min(...cluster.map((s) => s.lo));
      const hi = Math.max(...cluster.map((s) => s.hi));
      let low = -Infinity;
      let high = Infinity;
      const MARGIN = 6;
      for (const r of boxes) {
        const a0 = horizontal ? r.x : r.y;
        const a1 = a0 + (horizontal ? r.width : r.height);
        if (a1 <= lo + EPS || a0 >= hi - EPS) continue;
        const c0 = horizontal ? r.y : r.x;
        const c1 = c0 + (horizontal ? r.height : r.width);
        if (c1 <= c + EPS) low = Math.max(low, c1 + MARGIN);
        else if (c0 >= c - EPS) high = Math.min(high, c0 - MARGIN);
      }
      for (const r of frames) {
        const a0 = horizontal ? r.x : r.y;
        const a1 = a0 + (horizontal ? r.width : r.height);
        if (a1 <= lo + EPS || a0 >= hi - EPS) continue;
        const c0 = horizontal ? r.y : r.x;
        for (const edge of [c0, c0 + (horizontal ? r.height : r.width)]) {
          if (edge <= c + EPS) low = Math.max(low, edge + MARGIN);
          else high = Math.min(high, edge - MARGIN);
        }
      }
      // A wire that stays bounds the channel too (it cannot move out of the way).
      for (const points of fixed) {
        for (let k = 1; k < points.length; k++) {
          const p = points[k - 1]!;
          const q = points[k]!;
          if (Math.abs((horizontal ? p.y : p.x) - (horizontal ? q.y : q.x)) > 0.01) continue;
          const a0 = Math.min(horizontal ? p.x : p.y, horizontal ? q.x : q.y);
          const a1 = Math.max(horizontal ? p.x : p.y, horizontal ? q.x : q.y);
          if (a1 <= lo + EPS || a0 >= hi - EPS) continue;
          const at = horizontal ? p.y : p.x;
          if (at < c - EPS) low = Math.max(low, at + 4);
          else if (at > c + EPS) high = Math.min(high, at - 4);
        }
      }
      const count = ordered.length;
      let spacing = gap;
      if (Number.isFinite(low) && Number.isFinite(high))
        spacing = Math.max(1, Math.min(gap, (high - low) / (count - 1)));
      let first = c - ((count - 1) / 2) * spacing;
      if (first < low) first = low;
      if (first + (count - 1) * spacing > high) first = high - (count - 1) * spacing;
      ordered.forEach((s, index) => {
        let value = first + index * spacing;
        if (s.bound !== undefined) value = Math.min(Math.max(value, s.bound[0]), s.bound[1]);
        const points = routes[s.route]!;
        for (const at of [s.k, s.k + 1]) {
          if (horizontal) points[at]!.y = value;
          else points[at]!.x = value;
        }
      });
    }
  }
}

type Vec = { readonly x: number; readonly y: number };
const near = (p: number, q: number) => Math.abs(p - q) <= EPS;
function direction(from: LayoutPoint, to: LayoutPoint): Vec {
  return { x: Math.sign(Math.round(to.x - from.x)), y: Math.sign(Math.round(to.y - from.y)) };
}

/**
 * Which side of `z` wire `a` belongs on along the line they share, decided where they part,
 * walking from their shared segment toward its low end (or, with `atHigh`, its high end) and on
 * around any corners they turn together. A wire that turns off to the right of the way walked lies
 * to the right of the other all along the shared path, so offsetting it that way adds no crossing.
 * Negative: `a` takes the smaller coordinate across the line; 0: they never part (or one ends).
 */
function sideVote(
  routes: readonly (readonly LayoutPoint[])[],
  a: Segment,
  z: Segment,
  unit: Vec,
  horizontal: boolean,
  atHigh: boolean,
): number {
  const along = (p: LayoutPoint) => (horizontal ? p.x : p.y);
  const start = (s: Segment) => {
    const points = routes[s.route]!;
    const forward = along(points[s.k + 1]!) > along(points[s.k]!);
    // The vertex at the chosen end of the segment, and which way the index runs away from it.
    const atEnd = forward === atHigh ? s.k + 1 : s.k;
    return { points, index: atEnd, step: atEnd === s.k ? -1 : 1 };
  };
  const A = start(a);
  const Z = start(z);
  let walk: Vec = atHigh ? unit : { x: -unit.x, y: -unit.y };
  const first = walk;
  const right = (w: Vec, d: Vec) => w.x * d.y - w.y * d.x > 0;
  /** +1 when `a` is to the right of the way first walked, as a coordinate comparison. */
  const answer = (aRight: boolean) => {
    const normal = { x: -first.y, y: first.x };
    const sign = horizontal ? normal.y : normal.x;
    return (aRight ? 1 : -1) * sign;
  };
  /** The side the wire that turns first goes to, decided for `a`. */
  const turnOf = (W: typeof A, at: number): Vec | undefined => {
    const here = W.points[at];
    const next = W.points[at + W.step];
    return here === undefined || next === undefined ? undefined : direction(here, next);
  };
  const pa = A.points[A.index]!;
  const pz = Z.points[Z.index]!;
  const da = horizontal ? pa.x : pa.y;
  const dz = horizontal ? pz.x : pz.y;
  if (!near(da, dz)) {
    // The one reached first, walking away from the overlap, turns off there.
    const aFirst = atHigh ? da < dz : da > dz;
    const turn = turnOf(aFirst ? A : Z, aFirst ? A.index : Z.index);
    if (turn === undefined) return 0;
    return answer(right(walk, turn) === aFirst);
  }
  let ia = A.index;
  let iz = Z.index;
  for (let guard = 0; guard < 64; guard++) {
    const here = A.points[ia]!;
    const na = A.points[ia + A.step];
    const nz = Z.points[iz + Z.step];
    if (na === undefined || nz === undefined) return 0;
    const dA = direction(here, na);
    const dZ = direction(Z.points[iz]!, nz);
    if (dA.x !== dZ.x || dA.y !== dZ.y) {
      if (dA.x === -dZ.x && dA.y === -dZ.y) return 0;
      return answer(right(walk, dA) || (!right(walk, dZ) && dA.x === walk.x && dA.y === walk.y));
    }
    walk = dA;
    const la = Math.abs(na.x - here.x) + Math.abs(na.y - here.y);
    const lz = Math.abs(nz.x - Z.points[iz]!.x) + Math.abs(nz.y - Z.points[iz]!.y);
    if (!near(la, lz)) {
      const aFirst = la < lz;
      const turn = turnOf(aFirst ? A : Z, aFirst ? ia + A.step : iz + Z.step);
      if (turn === undefined) return 0;
      return answer(right(walk, turn) === aFirst);
    }
    ia += A.step;
    iz += Z.step;
  }
  return 0;
}

/**
 * A nudged route made orthogonal by construction: each segment keeps its orientation from the
 * route before nudging and takes its coordinate across from after; each corner is where its two
 * segments meet.
 */
function rebuild(before: readonly LayoutPoint[], after: readonly LayoutPoint[]): LayoutPoint[] {
  const n = before.length;
  if (n < 2) return after.map((p) => ({ ...p }));
  const horizontal = (k: number) =>
    Math.abs(before[k]!.y - before[k + 1]!.y) < 0.01 && Math.abs(before[k]!.x - before[k + 1]!.x) >= 0.01;
  const across = (k: number) => (horizontal(k) ? after[k]!.y : after[k]!.x);
  const out: LayoutPoint[] = [];
  for (let k = 0; k < n; k++) {
    if (k === 0 || k === n - 1) {
      const seg = k === 0 ? 0 : n - 2;
      out.push(horizontal(seg) ? { x: after[k]!.x, y: across(seg) } : { x: across(seg), y: after[k]!.y });
      continue;
    }
    const a = horizontal(k - 1);
    const b = horizontal(k);
    if (a === b) out.push({ ...after[k]! });
    else out.push(a ? { x: across(k), y: across(k - 1) } : { x: across(k - 1), y: across(k) });
  }
  return out;
}

/** Whether a short axis-parallel segment passes through one of a frame's edges. */
function stubCrossesFrame(a: LayoutPoint, b: LayoutPoint, r: Rect): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  if (y0 === y1) return y0 > r.y && y0 < r.y + r.height && [r.x, r.x + r.width].some((X) => X > x0 && X < x1);
  return x0 > r.x && x0 < r.x + r.width && [r.y, r.y + r.height].some((Y) => Y > y0 && Y < y1);
}
