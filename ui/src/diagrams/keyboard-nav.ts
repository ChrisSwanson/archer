/**
 * Where the keyboard goes next on the graph canvas.
 *
 * GEOMETRY, NOT ARRAY ORDER. Every answer here is computed from the box ELK
 * placed each node in. The obvious cheap alternative -- step through
 * `layout.nodes` -- would make Right mean "the next id alphabetically", since
 * `toXFlowNodes` sorts by id, and that has nothing to do with what the user is
 * looking at.
 *
 * Pure, and separate from the canvas, for a second reason: jsdom does no
 * layout, so a component test can only assert against the stubs in
 * `tests/setup.ts`. The decisions live here where they can be tested against
 * real coordinates; the canvas only wires them up.
 */

/** The part of a `LayoutNode` traversal needs: an id and a box. */
export type NavNode = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type ArrowDirection = "up" | "down" | "left" | "right";

const ARROW_KEYS: Readonly<Record<string, ArrowDirection>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** The direction this key asks for, or `null` if it asks for nothing. */
export function directionForKey(key: string): ArrowDirection | null {
  return ARROW_KEYS[key] ?? null;
}

type Centre = { readonly x: number; readonly y: number };

function centre(node: NavNode): Centre {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/**
 * Top to bottom, then left to right -- the order the diagram reads in.
 *
 * Compared on CENTRES rather than on top-left corners so that a tall node and
 * a short one drawn side by side still count as one row. The id is the final
 * tie-break, so the order is total and stable: two nodes at the same point
 * must not swap between renders, or the tab stop would move on its own.
 */
export function readingOrder(nodes: readonly NavNode[]): readonly NavNode[] {
  return [...nodes].sort((a, b) => {
    const ca = centre(a);
    const cb = centre(b);
    if (ca.y !== cb.y) return ca.y - cb.y;
    if (ca.x !== cb.x) return ca.x - cb.x;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The one node that carries `tabindex="0"`.
 *
 * Exactly one, always: a canvas where every node is `-1` cannot be reached by
 * keyboard at all, and one where every node is `0` puts a whole graph in the
 * page's tab sequence -- the cost a roving tabindex exists to avoid.
 *
 * A focused id that no longer names a node is treated as no focus: a recompile
 * can delete the node the user was standing on, and holding the stop on a
 * ghost would leave the canvas unreachable.
 */
export function rovingStopId(nodes: readonly NavNode[], focusedNodeId: string | null): string | null {
  if (focusedNodeId !== null && nodes.some((node) => node.id === focusedNodeId)) {
    return focusedNodeId;
  }
  return readingOrder(nodes)[0]?.id ?? null;
}

/** Distance along the direction of travel, and off its axis. */
function offsets(
  from: Centre,
  to: Centre,
  direction: ArrowDirection,
): {
  along: number;
  perpendicular: number;
} {
  switch (direction) {
    case "right":
      return { along: to.x - from.x, perpendicular: Math.abs(to.y - from.y) };
    case "left":
      return { along: from.x - to.x, perpendicular: Math.abs(to.y - from.y) };
    case "down":
      return { along: to.y - from.y, perpendicular: Math.abs(to.x - from.x) };
    case "up":
      return { along: from.y - to.y, perpendicular: Math.abs(to.x - from.x) };
  }
}

/**
 * How much an off-axis node is penalised.
 *
 * Without a penalty the nearest node in raw distance wins, and a node down and
 * far to the right answers both Down and Right -- so one of the two keys can
 * never reach whatever is straight ahead. Weighting the perpendicular offset
 * makes "straight ahead" beat "closer but sideways" while still allowing a
 * step to a node that is only slightly off line.
 */
const OFF_AXIS_PENALTY = 2;

/** Anything closer than this along the axis is not in that direction at all. */
const EPSILON = 0.5;

/**
 * The node an arrow key moves focus to, or `null` when there is nowhere to go.
 *
 * NO DEAD ENDS. When nothing lies in the direction asked for -- Right from the
 * rightmost node of a row, Down from the bottom row -- the move continues in
 * READING ORDER rather than doing nothing: forwards for Right and Down,
 * backwards for Left and Up, wrapping at each end. Two reasons. A key that
 * silently does nothing reads as broken, and the user cannot tell "there is
 * nothing that way" from "this canvas ignores arrows". And the wrap is what
 * makes every node reachable with one key, including a node in a disconnected
 * component that no geometric step happens to point at.
 *
 * `null` therefore only comes back when there is nowhere else at all: a graph
 * of one node, or an empty one.
 */
export function nextInDirection(nodes: readonly NavNode[], fromId: string, direction: ArrowDirection): string | null {
  const order = readingOrder(nodes);
  const fromIndex = order.findIndex((node) => node.id === fromId);
  if (fromIndex === -1) {
    // The id is not in this graph -- most likely a redraw removed it. Start
    // over rather than reporting nowhere to go.
    return order[0]?.id ?? null;
  }

  const from = centre(order[fromIndex]);
  let best: { id: string; score: number } | null = null;
  for (const node of order) {
    if (node.id === fromId) continue;
    const { along, perpendicular } = offsets(from, centre(node), direction);
    if (along <= EPSILON) continue;
    const score = along + OFF_AXIS_PENALTY * perpendicular;
    // Ties keep the first candidate, and `order` is reading order, so a tie is
    // broken by which node reads first rather than by array position.
    if (best === null || score < best.score) {
      best = { id: node.id, score };
    }
  }
  if (best !== null) {
    return best.id;
  }

  if (order.length < 2) {
    return null;
  }
  const step = direction === "right" || direction === "down" ? 1 : -1;
  const wrapped = (fromIndex + step + order.length) % order.length;
  return order[wrapped].id;
}

/** The part of a `LayoutEdge` traversal needs: an id, its ends, and its route. */
export type NavEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
};

/** Halfway along a polyline BY ARC LENGTH, so the point is always on the line. */
function midpointOf(points: readonly Centre[]): Centre {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  let walked = 0;
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (walked + length >= total / 2) {
      // A zero-length run only happens when the whole polyline is one point,
      // and then either end is the answer.
      const t = length === 0 ? 0 : (total / 2 - walked) / length;
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    }
    walked += length;
  }
  return points[0];
}

/**
 * Where each edge sits, as a box traversal can read.
 *
 * A zero-sized box at a point on the edge, so `readingOrder`, `rovingStopId`
 * and `nextInDirection` all apply UNCHANGED -- they compare centres, and the
 * centre of a zero-sized box is the point itself. Edge traversal is therefore
 * the node traversal, not a second implementation of it that can drift.
 *
 * The point is halfway along the ROUTED polyline rather than halfway between
 * the two endpoints. Routing here is orthogonal (`elk.edgeRouting`), so an
 * edge that doglegs around a node has a straight-line midpoint that can land
 * on empty canvas or inside a node it merely passes -- and an arrow key aimed
 * at that point would be aimed at somewhere the edge is not drawn.
 *
 * An edge ELK routed nothing for falls back to the midpoint between its node
 * centres; without that it would have no anchor, drop out of the order, and
 * become the one edge no key can reach. An edge whose ends are not in the
 * layout is dropped instead: nothing is drawn for it, so a stop on it would be
 * a stop on nothing.
 */
export function edgeAnchors(edges: readonly NavEdge[], nodes: readonly NavNode[]): readonly NavNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const anchors: NavNode[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) {
      continue;
    }
    const point = edge.points.length > 0 ? midpointOf(edge.points) : midpointOf([centre(source), centre(target)]);
    anchors.push({ id: edge.id, x: point.x, y: point.y, width: 0, height: 0 });
  }
  return anchors;
}
