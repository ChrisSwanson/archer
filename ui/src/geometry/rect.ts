import type { Box } from "../diagrams/viewport-fit";

export type Rect = Box;
export type Edges = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

/** Strict AABB overlap: touching an edge does not count. Keep measured endpoints exact. */
export function intersects(a: Rect | Edges, b: Rect | Edges): boolean {
  const leftA = "left" in a ? a.left : a.x;
  const rightA = "right" in a ? a.right : a.x + a.width;
  const topA = "top" in a ? a.top : a.y;
  const bottomA = "bottom" in a ? a.bottom : a.y + a.height;
  const leftB = "left" in b ? b.left : b.x;
  const rightB = "right" in b ? b.right : b.x + b.width;
  const topB = "top" in b ? b.top : b.y;
  const bottomB = "bottom" in b ? b.bottom : b.y + b.height;
  return leftA < rightB && rightA > leftB && topA < bottomB && bottomA > topB;
}
