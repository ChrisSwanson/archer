/** The plane geometry both Curved-lines drawings (`curved-route.ts`, `mermaid-curve.ts`) share. */
import type { RoutePoint } from "./rounded-route";

type P = RoutePoint;
export type CurveBox = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export const EPS = 1e-6;

export const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: P, k: number): P => ({ x: a.x * k, y: a.y * k });
export const len = (a: P): number => Math.hypot(a.x, a.y);
export const cross = (a: P, b: P): number => a.x * b.y - a.y * b.x;
export const dot = (a: P, b: P): number => a.x * b.x + a.y * b.y;

/** A point as SVG path data, to two decimals. */
const fmt = (n: number): string => String(Math.round(n * 100) / 100);
export const pt = (p: P): string => `${fmt(p.x)},${fmt(p.y)}`;

/** The point at `t` on the cubic `a`-`b`-`c`-`d`. */
export function cubicAt(a: P, b: P, c: P, d: P, t: number): P {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
}

export function pointSegmentDistance(p: P, a: P, b: P): number {
  const v = sub(b, a);
  const l2 = dot(v, v);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), v) / l2));
  return len(sub(p, add(a, scale(v, t))));
}

/** Two boxes overlap once `a` is grown by `pad` on every side. */
export const boxesOverlap = (a: CurveBox, b: CurveBox, pad: number): boolean =>
  a.x - pad < b.x + b.width && b.x < a.x + a.width + pad && a.y - pad < b.y + b.height && b.y < a.y + a.height + pad;

/** The bounding box of the segment `a`-`b`. */
export const segBox = (a: P, b: P): CurveBox => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

/** The points with each one that repeats the one before (within `EPS`) dropped. */
export function distinct(points: readonly P[]): P[] {
  const out: P[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev === undefined || Math.abs(prev.x - p.x) > EPS || Math.abs(prev.y - p.y) > EPS) out.push(p);
  }
  return out;
}

/** Distinct points with every point that is not a turn dropped: the route's own corners. */
export function corners(points: readonly P[]): P[] {
  const kept: P[] = [];
  for (const p of distinct(points)) {
    while (kept.length >= 2) {
      const a = kept[kept.length - 2]!;
      const b = kept[kept.length - 1]!;
      if (Math.abs(cross(sub(b, a), sub(p, b))) < EPS && dot(sub(b, a), sub(p, b)) >= 0) kept.pop();
      else break;
    }
    kept.push(p);
  }
  return kept;
}
