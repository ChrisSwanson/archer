// A frame's caption is an obstacle the wires are routed round, not a label
// laid over them.
//
// It was drawn above the frame, outside the box ELK sized, so nothing kept a
// wire off it: in the shop platform's architecture (the golden fixture
// `ts/test/fixtures/architecture/widened.mmd`) a wire ran along "Data tier"
// and two arrowheads landed on it (review of 2026-10-04). The caption now sits
// in a band ELK reserves inside the frame, placed after routing where no wire,
// end mark or edge caption is.
import { describe, expect, it } from "vitest";
import { computeLayout, type LayoutGroup, type LayoutResult } from "../src/layout/elk-adapter";
import {
  ARROWHEAD_REACH_PX,
  FRAME_CAPTION_BAND_PX,
  FRAME_CAPTION_INSET,
  captionSize,
  edgeObstacles,
  placeCaption,
} from "../src/layout/captions";
import type { GraphDirection, ProjectedView } from "../src/diagrams/projection";
import { loadModelEnvelope } from "./fixtures";
import { projectGraph } from "./support/draw-envelope";

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/** Whether the segment a-b passes through the inside of `box` (Liang-Barsky). */
function segmentHits(a: Point, b: Point, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clips: [number, number][] = [
    [-dx, a.x - box.x],
    [dx, box.x + box.width - a.x],
    [-dy, a.y - box.y],
    [dy, box.y + box.height - a.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

/** The triangle an end mark is drawn as, as its bounding box: ten back along the wire, ten across. */
function markAt(tip: Point, from: Point): Box {
  const length = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const back = { x: tip.x + ((from.x - tip.x) / length) * 10, y: tip.y + ((from.y - tip.y) / length) * 10 };
  const horizontal = Math.abs(tip.x - from.x) >= Math.abs(tip.y - from.y);
  return {
    x: Math.min(tip.x, back.x) - (horizontal ? 0 : 5),
    y: Math.min(tip.y, back.y) - (horizontal ? 5 : 0),
    width: Math.abs(tip.x - back.x) + (horizontal ? 0 : 10),
    height: Math.abs(tip.y - back.y) + (horizontal ? 10 : 0),
  };
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Every way a caption is crossed: by a wire, an end mark, or an edge caption. */
function crossings(layout: LayoutResult, group: LayoutGroup): string[] {
  const caption = group.caption;
  if (caption === undefined) return [`${group.id} has no caption box`];
  const found: string[] = [];
  for (const edge of layout.edges) {
    for (let i = 1; i < edge.points.length; i += 1) {
      if (segmentHits(edge.points[i - 1], edge.points[i], caption)) found.push(`${edge.id}'s wire crosses ${group.id}`);
    }
    const n = edge.points.length;
    if (n >= 2) {
      if (overlaps(markAt(edge.points[0], edge.points[1]), caption))
        found.push(`${edge.id}'s start mark is on ${group.id}`);
      if (overlaps(markAt(edge.points[n - 1], edge.points[n - 2]), caption))
        found.push(`${edge.id}'s end mark is on ${group.id}`);
    }
    if (edge.labelAnchor !== undefined && overlaps(edge.labelAnchor, caption))
      found.push(`${edge.id}'s caption is on ${group.id}`);
  }
  for (const node of layout.nodes) {
    if (overlaps(node, caption)) found.push(`${node.id} is on ${group.id}'s caption`);
  }
  return found;
}

/** The caption sits inside its frame, in the band the layout kept for it. */
function inItsBand(group: LayoutGroup): void {
  const caption = group.caption!;
  expect(caption.x, `${group.id} caption left`).toBeGreaterThanOrEqual(group.x + FRAME_CAPTION_INSET.x - 1e-6);
  expect(caption.x + caption.width, `${group.id} caption right`).toBeLessThanOrEqual(
    group.x + group.width - FRAME_CAPTION_INSET.x + 1e-6,
  );
  expect(caption.y, `${group.id} caption top`).toBeGreaterThanOrEqual(group.y);
  expect(caption.y + caption.height, `${group.id} caption bottom`).toBeLessThanOrEqual(
    group.y + FRAME_CAPTION_BAND_PX - ARROWHEAD_REACH_PX,
  );
}

describe("captions of the golden fixtures", () => {
  it.each([
    ["architecture", "widened"],
    ["c4", "widened"],
    ["state", "widened"],
    ["flowchart", "groups"],
  ])("%s/%s: no wire, end mark or edge caption crosses a frame's caption", async (type, name) => {
    const layout = await computeLayout(projectGraph(loadModelEnvelope(type, name)));
    expect(layout.groups.length).toBeGreaterThan(0);
    for (const group of layout.groups) {
      inItsBand(group);
      expect(crossings(layout, group)).toEqual([]);
    }
  });

  it("keeps the architecture's port arrow into the Data tier off its caption", async () => {
    // `app{group}:B <--> T:db{group}` ends on the Data tier's top: its
    // arrowhead stops at the frame, and the caption is under the frame's edge.
    const layout = await computeLayout(projectGraph(loadModelEnvelope("architecture", "widened")));
    const data = layout.groups.find((group) => group.id === "data")!;
    const port = layout.edges.find((edge) => edge.source === "app" && edge.target === "db")!;
    const tip = port.points[port.points.length - 1];
    expect(tip.y).toBeCloseTo(data.y, 0);
    expect(data.caption!.y).toBeGreaterThan(tip.y);
  });
});

/** A frame with nodes inside it, fed from a node above it into its first row. */
function feedView(direction: GraphDirection, label: string): ProjectedView {
  return {
    viewId: "feed",
    kind: "freeform",
    title: "feed",
    revision: "1",
    modelType: "freeform-graph",
    direction,
    nodes: [
      { id: "src", label: "Source", shape: "rectangle", classes: [], groupId: undefined },
      { id: "a", label: "First", shape: "rectangle", classes: [], groupId: "g" },
      { id: "b", label: "Second", shape: "rectangle", classes: [], groupId: "g" },
      { id: "c", label: "Third", shape: "rectangle", classes: [], groupId: "g" },
    ],
    edges: [
      { id: "e1", source: "src", target: "a", label: "feeds" },
      { id: "e2", source: "src", target: "b", label: undefined },
      { id: "e3", source: "a", target: "c", label: undefined },
      { id: "e4", source: "src", target: "c", label: undefined },
    ],
    groups: [{ id: "g", label, parentId: undefined }],
  };
}

describe("a subgraph whose first row is fed from outside", () => {
  it.each(["tb", "bt", "lr", "rl"] as const)(
    "flowing %s: the wires into it cross the band, not the caption",
    async (direction) => {
      const layout = await computeLayout(feedView(direction, "Backend services"));
      const group = layout.groups[0];
      inItsBand(group);
      expect(crossings(layout, group)).toEqual([]);
    },
  );

  it.each(["tb", "lr"] as const)("flowing %s: a frame is never narrower than its caption", async (direction) => {
    const long = "A subgraph whose caption is a good deal wider than anything inside it";
    const view: ProjectedView = {
      ...feedView(direction, long),
      nodes: [{ id: "a", label: "A", shape: "rectangle", classes: [], groupId: "g" }],
      edges: [],
    };
    const layout = await computeLayout(view);
    const group = layout.groups[0];
    expect(group.width).toBeGreaterThanOrEqual(captionSize({ label: long }).width + 2 * FRAME_CAPTION_INSET.x);
    // The minimum is a width, not a height: the frame did not grow downwards.
    expect(group.height).toBeLessThan(200);
    inItsBand(group);
  });
});

describe("placing a caption in its band", () => {
  const frame: Box = { x: 100, y: 100, width: 400, height: 200 };
  const size = { width: 80, height: 18 };

  it("takes the band's home at the left when nothing is there", () => {
    expect(placeCaption(frame, size, [])).toEqual({ x: 114, y: 110, width: 80, height: 18 });
  });

  it("moves right past a wire that crosses the band", () => {
    const wire: Box = { x: 140, y: 60, width: 4, height: 100 };
    const placed = placeCaption(frame, size, [wire]);
    expect(placed.x).toBeGreaterThanOrEqual(wire.x + wire.width);
    expect(placed.y).toBe(110);
  });

  it("keeps its home when the whole band is taken, rather than leaving the frame", () => {
    const wall: Box = { x: 100, y: 100, width: 400, height: 40 };
    expect(placeCaption(frame, size, [wall]).x).toBe(114);
  });
});

/**
 * The air a frame's caption keeps from any wire, in graph units (rendered review, 2026-11-13: the heartbeat's
 * "Design Together, Live" sat 4.5 from the "Looks right" line, which at its fit zoom of about 0.42 is under two screen
 * pixels: the words read as touching the line). Ten is room for the line's own width and a visible gap at fit.
 */
const CAPTION_AIR = 10;

describe("a caption keeps air between itself and a wire", () => {
  const frame: Box = { x: 100, y: 100, width: 400, height: 200 };
  const size = { width: 150, height: 20 };
  /** A wire straight down through the band at `x`. */
  const wireAt = (x: number) => ({
    points: [
      { x, y: 60 },
      { x, y: 260 },
    ],
  });

  it.each(["start", "end"] as const)("placed from the %s, it stops short of a wire in its way", (end) => {
    // A wire where the caption would otherwise go: at the right end for "end", the left end for "start".
    const x = end === "end" ? 420 : 180;
    const placed = placeCaption(frame, size, edgeObstacles([wireAt(x)]), end);
    const gap = placed.x > x ? placed.x - x : x - (placed.x + placed.width);
    expect(gap).toBeGreaterThanOrEqual(CAPTION_AIR);
  });
});
