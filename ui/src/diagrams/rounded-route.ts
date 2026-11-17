/** Round the corners of ELK's route without moving its endpoints or lanes. */
export type RoutePoint = { readonly x: number; readonly y: number };
export type RouteEnds = { readonly arrowStart?: boolean; readonly arrowEnd?: boolean };

/** How round a turn is where both runs have room: about the reference's 10-12px (redesign slice 6). */
export const CORNER_RADIUS_PX = 10;

/** Room for the marker AND a distinct shaft before the first turn. */
export const ARROW_APPROACH_PX = 40;

function cornerRadius(route: readonly RoutePoint[], i: number, ends: RouteEnds): number {
  const incoming = Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
  const outgoing = Math.hypot(route[i + 1].x - route[i].x, route[i + 1].y - route[i].y);
  let radius = Math.min(CORNER_RADIUS_PX, incoming / 2, outgoing / 2);
  if (i === 1 && ends.arrowStart) radius = Math.min(radius, Math.max(0, incoming - ARROW_APPROACH_PX));
  if (i === route.length - 2 && ends.arrowEnd) radius = Math.min(radius, Math.max(0, outgoing - ARROW_APPROACH_PX));
  return radius;
}

export function roundedRoute(route: readonly RoutePoint[], ends: RouteEnds = {}): string {
  if (route.length === 0) return "";
  let path = `M ${route[0].x},${route[0].y}`;
  for (let i = 1; i < route.length - 1; i += 1) {
    const prev = route[i - 1];
    const current = route[i];
    const next = route[i + 1];
    const incoming = Math.hypot(current.x - prev.x, current.y - prev.y);
    const outgoing = Math.hypot(next.x - current.x, next.y - current.y);
    const round = cornerRadius(route, i, ends);
    if (round === 0) {
      path += ` L ${current.x},${current.y}`;
      continue;
    }
    const before = {
      x: current.x - ((current.x - prev.x) / (incoming || 1)) * round,
      y: current.y - ((current.y - prev.y) / (incoming || 1)) * round,
    };
    const after = {
      x: current.x + ((next.x - current.x) / (outgoing || 1)) * round,
      y: current.y + ((next.y - current.y) / (outgoing || 1)) * round,
    };
    path += ` L ${before.x},${before.y} Q ${current.x},${current.y} ${after.x},${after.y}`;
  }
  const last = route[route.length - 1];
  return `${path} L ${last.x},${last.y}`;
}

/** The actual straight run at one end of this rounded route, before its bend. */
export function terminalStraightLength(route: readonly RoutePoint[], at: "start" | "end", ends: RouteEnds): number {
  const points = at === "end" ? [...route].reverse() : [...route];
  if (points.length < 2) return 0;
  const tip = points[0];
  let first = 1;
  while (first < points.length && points[first].x === tip.x && points[first].y === tip.y) first++;
  if (first === points.length) return 0;
  const dx = points[first].x - tip.x;
  const dy = points[first].y - tip.y;
  let length = 0;
  for (let i = first; i < points.length; i++) {
    const previous = points[i - 1];
    const point = points[i];
    const incoming = Math.hypot(point.x - previous.x, point.y - previous.y);
    if (incoming === 0) continue;
    const next = points[i + 1];
    length += incoming;
    if (next === undefined) return length;
    const ex = next.x - point.x;
    const ey = next.y - point.y;
    if (ex * dy === ey * dx && ex * dx + ey * dy >= 0) continue;
    const index = at === "end" ? route.length - 1 - i : i;
    const cut = cornerRadius(route, index, ends);
    return length - cut;
  }
  return length;
}
