import { intersects, type Edges, type Rect } from "../geometry/rect";
export type { Edges } from "../geometry/rect";

type Point = { readonly x: number; readonly y: number };
type Size = Pick<Rect, "width" | "height">;
type Workspace = Size & { readonly left?: number; readonly top?: number };
const GAP = 16,
  MARGIN = 12;
const contains = (a: Edges, b: Edges): boolean =>
  a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom;

/** Free rectangles preserve full strips around an obstacle, including space below a floating panel. */
function rooms(workspace: Workspace, obstacles: readonly Edges[]): Edges[] {
  const left = (workspace.left ?? 0) + MARGIN,
    top = (workspace.top ?? 0) + MARGIN;
  let free: Edges[] = [
    { left, top, right: left + workspace.width - MARGIN * 2, bottom: top + workspace.height - MARGIN * 2 },
  ];
  for (const obstacle of obstacles) {
    free = free.flatMap((r) =>
      !intersects(r, obstacle)
        ? [r]
        : [
            { ...r, right: Math.min(r.right, obstacle.left - MARGIN) },
            { ...r, left: Math.max(r.left, obstacle.right + MARGIN) },
            { ...r, bottom: Math.min(r.bottom, obstacle.top - MARGIN) },
            { ...r, top: Math.max(r.top, obstacle.bottom + MARGIN) },
          ].filter((part) => part.right > part.left && part.bottom > part.top),
    );
    free = free.filter(
      (r, i) => !free.some((other, j) => j !== i && contains(other, r) && (!contains(r, other) || j < i)),
    );
  }
  return free;
}

/** Prefer a clear side, then below/above; only constrain the card when its full size cannot fit. */
export function fitDiscussion(
  anchor: Edges,
  size: Size,
  workspace: Workspace,
  obstacles: readonly Edges[] = [],
  options: { readonly preferSide?: boolean } = {},
): Point & Size {
  const free = rooms(workspace, obstacles);
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max));
  // A participant's following messages remain reachable: use a narrower side card before
  // moving below its header. Its body scrolls when the available side is shorter than the thread.
  if (options.preferSide) {
    for (const side of ["right", "left"] as const) {
      for (const room of free) {
        const available = side === "right" ? room.right - anchor.right - GAP : anchor.left - GAP - room.left;
        const width = Math.min(size.width, available),
          height = Math.min(size.height, room.bottom - room.top);
        if (width < Math.min(180, size.width) || height < Math.min(180, size.height)) continue;
        const x = side === "right" ? anchor.right + GAP : anchor.left - GAP - width;
        const y = clamp(anchor.top, room.top, room.bottom - height);
        if (x >= room.left && x + width <= room.right) return { x, y, width, height };
      }
    }
  }
  for (const side of ["right", "left", "below", "above"] as const) {
    for (const room of free) {
      if (room.right - room.left < size.width || room.bottom - room.top < size.height) continue;
      const x =
        side === "right"
          ? anchor.right + GAP
          : side === "left"
            ? anchor.left - GAP - size.width
            : clamp(anchor.left, room.left, room.right - size.width);
      const y =
        side === "below"
          ? anchor.bottom + GAP
          : side === "above"
            ? anchor.top - GAP - size.height
            : clamp(anchor.top, room.top, room.bottom - size.height);
      if (x >= room.left && x + size.width <= room.right && y >= room.top && y + size.height <= room.bottom)
        return { x, y, ...size };
    }
  }
  // The largest useful card wins; closeness breaks ties so it stays beside the original scope.
  const candidates = free
    .map((room) => {
      const width = Math.min(size.width, room.right - room.left),
        height = Math.min(size.height, room.bottom - room.top);
      const x = clamp(anchor.right + GAP, room.left, room.right - width),
        y = clamp(anchor.top, room.top, room.bottom - height);
      return { x, y, width, height };
    })
    .sort(
      (a, b) =>
        b.width * b.height - a.width * a.height ||
        Math.hypot(a.x - anchor.left, a.y - anchor.top) - Math.hypot(b.x - anchor.left, b.y - anchor.top),
    );
  return candidates[0] ?? { x: (workspace.left ?? 0) + MARGIN, y: (workspace.top ?? 0) + MARGIN, width: 0, height: 0 };
}

export function placeDiscussion(
  anchor: Edges,
  size: Size,
  workspace: Workspace,
  obstacles: readonly Edges[] = [],
): Point {
  const { x, y } = fitDiscussion(anchor, size, workspace, obstacles);
  return { x, y };
}
