// Cell geometry shared by the layout and the painter.

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Rounding can turn an axis-aligned segment into one that is off by a cell.
 * Each bend is pulled back onto the axis of the segment before it; the two end
 * points stay where ELK put them, since they are anchored to node borders.
 */
export function straighten(points: readonly Point[]): Point[] {
  const pts = points.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1],
      b = pts[i];
    if (!a || !b) continue;
    if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) b.y = a.y;
    else b.x = a.x;
  }
  const before = pts.at(-3),
    a = pts.at(-2),
    end = pts.at(-1);
  if (before && a && end) {
    if (a.x === before.x) a.y = end.y;
    else a.x = end.x;
  }
  return pts;
}
