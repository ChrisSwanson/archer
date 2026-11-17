// Keyboard traversal is decided from LAYOUT GEOMETRY, and decided here.
//
// This is a pure module with a test of its own on purpose. jsdom does no
// layout -- `getBoundingClientRect` and the offsets are stubbed in
// `tests/setup.ts` -- so any assertion about which node is "to the right of"
// another, made through a rendered canvas, would be an assertion about those
// stubs. The direction picking is therefore a function over the coordinates
// ELK produced, tested directly; the component test only proves the wiring.
//
// Array order is not an answer to any of these questions. `toXFlowNodes` sorts
// by id, and the id order of a graph has nothing to do with where its nodes
// were drawn.
import { describe, expect, it } from "vitest";
import {
  directionForKey,
  edgeAnchors,
  nextInDirection,
  readingOrder,
  rovingStopId,
  type NavEdge,
  type NavNode,
} from "../src/diagrams/keyboard-nav";

/** A 2x2 grid. Ids are deliberately NOT in reading order. */
const GRID: readonly NavNode[] = [
  { id: "d", x: 200, y: 120, width: 100, height: 40 },
  { id: "b", x: 200, y: 0, width: 100, height: 40 },
  { id: "c", x: 0, y: 120, width: 100, height: 40 },
  { id: "a", x: 0, y: 0, width: 100, height: 40 },
];

const ids = (nodes: readonly NavNode[]): string[] => nodes.map((node) => node.id);

describe("reading order", () => {
  it("runs top to bottom, then left to right", () => {
    expect(ids(readingOrder(GRID))).toEqual(["a", "b", "c", "d"]);
  });

  it("is not the order the layout happened to list nodes in", () => {
    expect(ids(readingOrder(GRID))).not.toEqual(ids(GRID));
  });
});

describe("the roving tab stop", () => {
  it("starts on the first node in reading order", () => {
    expect(rovingStopId(GRID, null)).toBe("a");
  });

  it("follows the focused node once there is one", () => {
    expect(rovingStopId(GRID, "c")).toBe("c");
  });

  it("falls back to the first node when the focused one is no longer in the graph", () => {
    // A recompile can remove the node the user was standing on. Leaving the
    // stop on a missing id would leave the canvas with no tab stop at all.
    expect(rovingStopId(GRID, "gone")).toBe("a");
  });

  it("is null for a graph with no nodes", () => {
    expect(rovingStopId([], null)).toBeNull();
  });
});

describe("arrow keys name a direction, and nothing else does", () => {
  it("maps the four arrows", () => {
    expect(directionForKey("ArrowUp")).toBe("up");
    expect(directionForKey("ArrowDown")).toBe("down");
    expect(directionForKey("ArrowLeft")).toBe("left");
    expect(directionForKey("ArrowRight")).toBe("right");
  });

  it("claims no other key", () => {
    for (const key of ["Enter", " ", "Tab", "a", "Escape", "PageDown"]) {
      expect(directionForKey(key), key).toBeNull();
    }
  });
});

describe("moving in a direction uses geometry", () => {
  it("steps to the neighbour on that side", () => {
    expect(nextInDirection(GRID, "a", "right")).toBe("b");
    expect(nextInDirection(GRID, "a", "down")).toBe("c");
    expect(nextInDirection(GRID, "d", "left")).toBe("c");
    expect(nextInDirection(GRID, "d", "up")).toBe("b");
  });

  it("prefers the nearer node when two lie the same way", () => {
    const nodes: readonly NavNode[] = [
      { id: "from", x: 0, y: 0, width: 100, height: 40 },
      { id: "far", x: 600, y: 0, width: 100, height: 40 },
      { id: "near", x: 200, y: 0, width: 100, height: 40 },
    ];
    expect(nextInDirection(nodes, "from", "right")).toBe("near");
  });

  it("prefers the node in line over one further off the axis", () => {
    // Both are below. The one that is nearly straight down is the one the
    // user means, even when a skewed node is fractionally closer in raw
    // distance -- otherwise Down and Right can pick the same node.
    const nodes: readonly NavNode[] = [
      { id: "from", x: 0, y: 0, width: 100, height: 40 },
      { id: "inline", x: 0, y: 200, width: 100, height: 40 },
      { id: "skewed", x: 480, y: 150, width: 100, height: 40 },
    ];
    expect(nextInDirection(nodes, "from", "down")).toBe("inline");
  });

  it("never returns the node it started from", () => {
    const solo: readonly NavNode[] = [{ id: "only", x: 0, y: 0, width: 100, height: 40 }];
    for (const direction of ["up", "down", "left", "right"] as const) {
      expect(nextInDirection(solo, "only", direction), direction).toBeNull();
    }
  });

  it("has no dead end: pressing into an edge continues in reading order", () => {
    // "b" is the rightmost node of the top row, so nothing is to its right.
    // Rather than doing nothing -- which reads as a broken key -- the move
    // continues the way reading does, onto the next row.
    expect(nextInDirection(GRID, "b", "right")).toBe("c");
    // ...and from the last node it wraps, so no node is unreachable by one key.
    expect(nextInDirection(GRID, "d", "right")).toBe("a");
    // Backwards directions run the order backwards, and wrap the same way.
    expect(nextInDirection(GRID, "c", "left")).toBe("b");
    expect(nextInDirection(GRID, "a", "left")).toBe("d");
    expect(nextInDirection(GRID, "a", "up")).toBe("d");
    expect(nextInDirection(GRID, "d", "down")).toBe("a");
  });

  it("falls back to the first node when the graph never had the id", () => {
    expect(nextInDirection(GRID, "gone", "down")).toBe("a");
  });
});

/*
 * Edges traverse on the same machinery as nodes, which is only possible if an
 * edge can be reduced to the one thing the machinery reads: a box. An edge is
 * a polyline, so the box is a point ON that polyline -- halfway along it by
 * arc length, which is where the eye finds the edge and, in this layout, where
 * ELK put the caption too.
 *
 * Deliberately NOT the midpoint between the two endpoints. An orthogonal route
 * that doglegs around a node has a straight-line midpoint that can sit on
 * empty canvas, or inside a node the edge only passes, and arrowing "down"
 * would then aim at somewhere the edge is not drawn.
 */
describe("edge anchors", () => {
  const NODES: readonly NavNode[] = [
    { id: "a", x: 0, y: 0, width: 100, height: 40 },
    { id: "b", x: 0, y: 200, width: 100, height: 40 },
  ];

  it("puts the anchor halfway along the routed polyline, not halfway between its ends", () => {
    // An L: 100 across, then 100 down. The arc-length midpoint is the corner.
    // The straight-line midpoint would be (50, 50), which is off the line.
    const edge: NavEdge = {
      id: "e",
      source: "a",
      target: "b",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    };

    expect(edgeAnchors([edge], NODES)).toEqual([{ id: "e", x: 100, y: 0, width: 0, height: 0 }]);
  });

  it("falls back to the midpoint between the node centres when ELK routed nothing", () => {
    // `LayoutEdge.points` is empty when ELK returned no section. An edge with
    // no anchor would be dropped from traversal and become unreachable, so the
    // ends -- which always exist -- answer instead.
    const edge: NavEdge = { id: "e", source: "a", target: "b", points: [] };

    expect(edgeAnchors([edge], NODES)).toEqual([
      // Centres are (50, 20) and (50, 220).
      { id: "e", x: 50, y: 120, width: 0, height: 0 },
    ]);
  });

  it("drops an edge whose ends are not in the layout", () => {
    // Nothing is drawn for it, so a tab stop on it would be a stop on nothing.
    const edge: NavEdge = { id: "e", source: "a", target: "gone", points: [] };

    expect(edgeAnchors([edge], NODES)).toEqual([]);
  });

  it("feeds reading order and direction picking unchanged", () => {
    // The point of a zero-sized box: every function above already works on it,
    // so edge traversal is the node traversal, not a second implementation.
    const high: NavEdge = { id: "high", source: "a", target: "b", points: [{ x: 0, y: 0 }] };
    const low: NavEdge = { id: "low", source: "a", target: "b", points: [{ x: 0, y: 400 }] };
    const anchors = edgeAnchors([low, high], NODES);

    expect(ids(readingOrder(anchors))).toEqual(["high", "low"]);
    expect(nextInDirection(anchors, "high", "down")).toBe("low");
    expect(rovingStopId(anchors, null)).toBe("high");
  });
});
