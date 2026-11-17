/**
 * Small route geometry shared by the grow-in-place layouts (`grow-in-place.ts`,
 * `grow-in-place-v2.ts`): crossing tests and label placement along a route.
 */
import type { LayoutPoint } from "../layout/elk-layout";

import { intersects, type Rect } from "../geometry/rect";
export { intersects, type Rect } from "../geometry/rect";

/** Whether a polyline passes through the inside of a rect (touching its edge does not count). */
export function routeCrosses(points: readonly LayoutPoint[], rect: Rect, inset = 1): boolean {
  const x0 = rect.x + inset;
  const y0 = rect.y + inset;
  const x1 = rect.x + rect.width - inset;
  const y1 = rect.y + rect.height - inset;
  if (x1 <= x0 || y1 <= y0) return false;
  for (let index = 1; index < points.length; index++) {
    // Liang-Barsky: clip the segment to the rect; any length left inside is a crossing.
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    let inside = true;
    for (const [p, q] of [
      [-dx, a.x - x0],
      [dx, x1 - a.x],
      [-dy, a.y - y0],
      [dy, y1 - a.y],
    ] as const) {
      if (p === 0) {
        if (q <= 0) inside = false;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (inside && t1 - t0 > 1e-9) return true;
  }
  return false;
}

/** The length of a route. */
export function lengthOf(points: readonly LayoutPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index++)
    total += Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y);
  return total;
}

/** The label box centred `distance` along a route. */
export function boxAt(points: readonly LayoutPoint[], size: { width: number; height: number }, distance: number): Rect {
  let left = Math.max(0, distance);
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= length && length > 0) {
      const t = left / length;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      return { x: x - size.width / 2, y: y - size.height / 2, width: size.width, height: size.height };
    }
    left -= length;
  }
  const p = points[0]!;
  return { x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height };
}

/** Which way the route runs at `distance` along it: true when that segment is vertical. */
function verticalAt(points: readonly LayoutPoint[], distance: number): boolean {
  let left = Math.max(0, distance);
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= length && length > 0) return Math.abs(a.x - b.x) < Math.abs(a.y - b.y);
    left -= length;
  }
  return false;
}

/**
 * A label box on a route: at its middle, or slid along it (6 px at a time either way), or shifted
 * across it by up to half its own size less a margin, so that the route still runs through the
 * plate, to the nearest place that covers nothing in `taken` (boxes, frame edges, captions, labels
 * already placed). With no free place, the place that covers least.
 */
export function labelOnRoute(
  points: readonly LayoutPoint[],
  size: { width: number; height: number },
  taken: Rect[],
): Rect {
  const covered = (rect: Rect) => taken.reduce((n, other) => n + (intersects(rect, other) ? 1 : 0), 0);
  let chosen = boxAt(points, size, lengthOf(points) / 2);
  let least = covered(chosen);
  if (least > 0) {
    for (const candidate of placesOnRoute(points, size)) {
      const n = covered(candidate);
      if (n < least) {
        least = n;
        chosen = candidate;
      }
      if (least === 0) break;
    }
  }
  taken.push(chosen);
  return chosen;
}

/** The first place on a route, in `labelOnRoute`'s order, where a box of `size` touches none of `walls`; undefined when there is none. */
export function clearPlaceOnRoute(
  points: readonly LayoutPoint[],
  size: { width: number; height: number },
  walls: readonly Rect[],
): Rect | undefined {
  for (const candidate of placesOnRoute(points, size))
    if (!walls.some((wall) => intersects(candidate, wall))) return candidate;
  return undefined;
}

/** Where a plate may sit on a route, from its middle outwards: on the route, and slid to either side of it. */
function* placesOnRoute(points: readonly LayoutPoint[], size: { width: number; height: number }): Generator<Rect> {
  const total = lengthOf(points);
  for (let offset = 0; offset <= total / 2; offset += 6) {
    for (const distance of offset === 0 ? [total / 2] : [total / 2 + offset, total / 2 - offset]) {
      const box = boxAt(points, size, distance);
      yield box;
      const vertical = verticalAt(points, distance);
      const reach = vertical ? size.width / 2 - 6 : size.height / 2 - 4;
      if (reach > 0)
        for (const shift of [reach, -reach])
          yield vertical ? { ...box, x: box.x + shift } : { ...box, y: box.y + shift };
    }
  }
}

/** Proper crossings between two polylines (segments that cross at a point inside both; touching does not count). */
export function countCrossings(p: readonly LayoutPoint[], q: readonly LayoutPoint[]): number {
  let count = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!;
    const b = p[i]!;
    for (let j = 1; j < q.length; j++) {
      const c = q[j - 1]!;
      const d = q[j]!;
      const d1 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
      const d2 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
      const d3 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const d4 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
      if (d1 * d2 < 0 && d3 * d4 < 0) count++;
    }
  }
  return count;
}
