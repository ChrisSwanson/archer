// The follow camera's frame (ADR 0034 §6, prototype round 3): fit the current step's parts and the
// previous step's; never past 150% of the whole-graph fit; out only as far as the parts need.
import { describe, expect, it } from "vitest";
import type { LayoutResult } from "../src/layout/elk-layout";
import {
  CHROME_GAP_PX,
  clearOfChrome,
  COMPACT_FOLLOW_GUTTER,
  COMPACT_FOLLOW_MARGIN,
  FOLLOW_MARGIN,
  FOLLOW_MAX_OF_FIT,
  followFrame,
  followParts,
} from "../src/walkthroughs/walk-camera";

const node = (id: string, x: number, y: number, width = 100, height = 50) => ({ id, x, y, width, height });
const layoutOf = (nodes: ReturnType<typeof node>[], edges: unknown[] = [], groups: unknown[] = []): LayoutResult =>
  ({ nodes, edges, groups, width: 2000, height: 1000 }) as unknown as LayoutResult;

const canvas = { width: 1000, height: 600 };
const none = { top: 0, right: 0, bottom: 0, left: 0 };
/** A graph 2000x1000 wide: whole-graph fit is 0.5 (1000/2000), 0.6 tall. */
const big = layoutOf([node("a", 0, 0), node("b", 300, 0), node("c", 1900, 950), node("far", 1000, 500)]);

describe("followFrame", () => {
  it("two parts that fit at 1.2x of the whole-graph fit give 1.2x", () => {
    // Fit of the whole graph is 0.5. Parts a..b span 1667 wide: 1000/1667 = 0.6 = 1.2 x 0.5, under the 0.75 cap.
    const layout = layoutOf([node("a", 0, 0), node("b", 1567, 0), node("c", 1900, 950)]);
    const frame = followFrame({ layout, nodeIds: ["a", "b"], edgeIds: [], canvas, padding: none, margin: 0 })!;
    expect(frame.zoom).toBeCloseTo(0.6, 2);
  });

  it("a tiny step is capped at 1.5x the whole-graph fit", () => {
    const frame = followFrame({ layout: big, nodeIds: ["a"], edgeIds: [], canvas, padding: none, margin: 0 })!;
    expect(frame.zoom).toBeCloseTo(0.5 * FOLLOW_MAX_OF_FIT, 3);
  });

  it("never zooms out past the whole-graph fit, even when the parts are as far apart as the graph", () => {
    const frame = followFrame({ layout: big, nodeIds: ["a", "c"], edgeIds: [], canvas, padding: none, margin: 0 })!;
    expect(frame.zoom).toBeCloseTo(0.5, 3);
  });

  it("centres the parts in the canvas", () => {
    const frame = followFrame({ layout: big, nodeIds: ["far"], edgeIds: [], canvas, padding: none, margin: 0 })!;
    // The node's centre (1050, 525) lands in the middle of the canvas.
    expect(1050 * frame.zoom + frame.x).toBeCloseTo(500, 1);
    expect(525 * frame.zoom + frame.y).toBeCloseTo(300, 1);
  });

  it("frames a line by its route, and a frame (group) by its box", () => {
    const layout = layoutOf(
      [node("a", 0, 0), node("b", 1900, 950)],
      [
        {
          id: "e",
          points: [
            { x: 600, y: 400 },
            { x: 800, y: 500 },
          ],
        },
      ],
      // In the drawing's middle, cut off on every side, so the frame is centred on it (near a corner the camera would
      // move toward the cut-off sides: "followFrame clamps toward the cut-off side").
      [{ id: "g", x: 900, y: 450, width: 200, height: 100 }],
    );
    const edge = followFrame({ layout, nodeIds: [], edgeIds: ["e"], canvas, padding: none, margin: 0 })!;
    expect(700 * edge.zoom + edge.x).toBeCloseTo(500, 1);
    const group = followFrame({ layout, nodeIds: ["g"], edgeIds: [], canvas, padding: none, margin: 0 })!;
    expect(1000 * group.zoom + group.x).toBeCloseTo(500, 1);
    expect(500 * group.zoom + group.y).toBeCloseTo(300, 1);
  });

  it("is null when none of the parts is drawn", () => {
    expect(
      followFrame({ layout: big, nodeIds: ["gone"], edgeIds: ["nope"], canvas, padding: none, margin: 0 }),
    ).toBeNull();
  });

  it("a whole graph too small to read may go up to reading size, no further", () => {
    // Fit 0.2 -> 1.5x = 0.3, below a reading floor of 0.8: a phone may read at 0.8.
    const tall = layoutOf([node("a", 0, 0), node("z", 4900, 2400)]);
    const frame = followFrame({
      layout: tall,
      nodeIds: ["a"],
      edgeIds: [],
      canvas,
      padding: none,
      margin: 0,
      readable: 0.8,
    })!;
    expect(frame.zoom).toBeCloseTo(0.8, 3);
  });

  it("keeps the margin and padding clear around the parts", () => {
    const frame = followFrame({
      layout: big,
      nodeIds: ["a", "b"],
      edgeIds: [],
      canvas,
      padding: { top: 0, right: 200, bottom: 0, left: 0 },
      margin: 50,
    })!;
    // Room is 800 wide, the whole graph fits at 0.4, so the ceiling is 0.6; the parts (400 + margins) want 1.6.
    // Changed 2026-11-13 (rendered review item 3, Brew step 1; owner-approved): this asserted exact centring (x 400),
    // which left empty canvas left of the drawing while it ran off the right. The camera now moves toward the cut-off
    // side, so the parts' box (margin included) meets the room's left edge and stays inside the room.
    expect(frame.zoom).toBeCloseTo(0.6, 3);
    expect(-50 * frame.zoom + frame.x).toBeCloseTo(0, 1);
    expect(450 * frame.zoom + frame.x).toBeLessThanOrEqual(800);
  });
});

// Rendered review (2026-11-13), Brew step 1: a step at the top of a tall drawing was centred, leaving ~280px of empty
// space above the drawing while the drawing ran off the bottom. Where centring would show space past one edge while
// the drawing is cut off at the other, the camera moves toward the cut side: same zoom, the parts still in the room.
describe("followFrame clamps toward the cut-off side", () => {
  // 200 x 2050: the whole fit is 600/2050 = 0.293 and the ceiling 1.5x that (0.439).
  const tall = layoutOf([
    node("top", 400, 0, 200, 50),
    node("mid", 400, 300, 200, 50),
    node("centre", 400, 1000, 200, 50),
    node("bottom", 400, 2000, 200, 50),
  ]);
  const zoom = (600 / 2050) * FOLLOW_MAX_OF_FIT;

  it("a step at the top of a drawing cut off below shows no more than its margin above the drawing", () => {
    const frame = followFrame({ layout: tall, nodeIds: ["top"], edgeIds: [], canvas, padding: none, margin: 40 })!;
    expect(frame.zoom).toBeCloseTo(zoom, 3);
    // The parts' box (margin included) meets the top of the room; the drawing's top is one margin below it.
    expect(-40 * frame.zoom + frame.y).toBeCloseTo(0, 1);
    expect(0 * frame.zoom + frame.y).toBeCloseTo(40 * zoom, 1);
    // Across, the whole drawing fits: still centred.
    expect(500 * frame.zoom + frame.x).toBeCloseTo(500, 1);
  });

  it("a step at the bottom of a drawing cut off above shows no more than its margin below it", () => {
    const frame = followFrame({ layout: tall, nodeIds: ["bottom"], edgeIds: [], canvas, padding: none, margin: 40 })!;
    expect(frame.zoom).toBeCloseTo(zoom, 3);
    expect(2090 * frame.zoom + frame.y).toBeCloseTo(600, 1);
  });

  it("moves no further than keeps every part in the room", () => {
    // Parts top..mid span 390 tall with margins (171px at this zoom); the room is 600 tall, so they reach the top
    // edge, not past it, and the bottom of the box stays inside.
    const padding = { top: 30, right: 0, bottom: 20, left: 0 };
    const frame = followFrame({ layout: tall, nodeIds: ["top", "mid"], edgeIds: [], canvas, padding, margin: 40 })!;
    expect(-40 * frame.zoom + frame.y).toBeGreaterThanOrEqual(30 - 0.01);
    expect(390 * frame.zoom + frame.y).toBeLessThanOrEqual(580 + 0.01);
    expect(-40 * frame.zoom + frame.y).toBeCloseTo(30, 1);
  });

  it("does not move a drawing cut off on both sides", () => {
    const frame = followFrame({ layout: tall, nodeIds: ["centre"], edgeIds: [], canvas, padding: none, margin: 40 })!;
    expect(1025 * frame.zoom + frame.y).toBeCloseTo(300, 1);
  });
});

// flows-r1 claude-06 (O95): on a phone the previous step's parts beside the current step's left the step's labels at
// about 6 px (fulfilment step 2 at 320x640: zoom 0.36). A compact canvas frames the current step only, closer.
describe("followParts", () => {
  const request = {
    key: "w#2#0",
    nodeIds: ["a", "b", "c"],
    edgeIds: ["ab", "bc"],
    current: { nodeIds: ["b", "c"], edgeIds: ["bc"] },
  };
  it("a desktop canvas follows the current and the previous step, with the usual margin", () => {
    expect(followParts(request, { width: 1000, height: 600 })).toEqual({
      nodeIds: ["a", "b", "c"],
      edgeIds: ["ab", "bc"],
      margin: FOLLOW_MARGIN,
      gutter: null,
    });
  });
  it("a phone canvas follows the current step only, with a small margin and gutter", () => {
    expect(followParts(request, { width: 320, height: 480 })).toEqual({
      nodeIds: ["b", "c"],
      edgeIds: ["bc"],
      margin: COMPACT_FOLLOW_MARGIN,
      gutter: COMPACT_FOLLOW_GUTTER,
    });
  });
  it("a phone canvas falls back to both steps when the current one draws nothing", () => {
    expect(
      followParts({ ...request, current: { nodeIds: [], edgeIds: [] } }, { width: 320, height: 480 }).nodeIds,
    ).toEqual(["a", "b", "c"]);
  });
  it("frames fulfilment's step 2 at 320 px at least 1.5x larger than the two-step framing", () => {
    // Order Placed, Payment accepted?, Pick from Shelf in a row, as laid out (layout px).
    const layout = layoutOf(
      [node("a", 0, 40, 140, 50), node("b", 200, 0, 130, 130), node("c", 450, 40, 180, 50)],
      [
        {
          id: "ab",
          points: [
            { x: 140, y: 65 },
            { x: 200, y: 65 },
          ],
        },
        {
          id: "bc",
          points: [
            { x: 330, y: 65 },
            { x: 450, y: 65 },
          ],
        },
      ],
    );
    const phone = { width: 320, height: 300 };
    const pad = (g: number) => ({ top: 24, right: g, bottom: 24, left: g });
    const before = followFrame({
      layout,
      nodeIds: request.nodeIds,
      edgeIds: request.edgeIds,
      canvas: phone,
      padding: pad(24),
      readable: 12 / 14,
    })!;
    const parts = followParts(request, phone);
    const after = followFrame({
      layout,
      nodeIds: parts.nodeIds,
      edgeIds: parts.edgeIds,
      canvas: phone,
      padding: pad(parts.gutter ?? 24),
      margin: parts.margin,
      readable: 12 / 14,
    })!;
    expect(after.zoom / before.zoom).toBeGreaterThan(1.5);
    expect(14 * after.zoom).toBeGreaterThan(9);
  });
});

// Rendered review (2026-11-13): QoS step 2 framed "Concorde Queue" under the tool rail and "Coach Queue" against the chat
// button. The camera frames in what the canvas's floating chrome leaves, giving each piece the side that costs least room.
describe("clearOfChrome", () => {
  const canvas = { left: 64, top: 104, right: 1090, bottom: 900 };
  const gutter = { top: 24, right: 24, bottom: 24, left: 24 };
  const rail = { left: 80, top: 577, right: 130, bottom: 885 };
  const fab = { left: 1021, top: 832, right: 1073, bottom: 884 };

  it("insets the side a tall tool rail stands on, not the bottom it reaches", () => {
    const padding = clearOfChrome(gutter, canvas, [rail]);
    expect(padding.left).toBe(130 - 64 + CHROME_GAP_PX);
    expect(padding).toMatchObject({ top: 24, right: 24, bottom: 24 });
  });

  it("insets one side for the chat button in the corner", () => {
    const padding = clearOfChrome(gutter, canvas, [rail, fab]);
    expect(padding.right).toBe(1090 - 1021 + CHROME_GAP_PX);
    expect(padding.bottom).toBe(24);
  });

  it("a wide toolbar row (a phone's, above its sheet) insets the bottom", () => {
    const phone = { left: 0, top: 160, right: 390, bottom: 760 };
    const padding = clearOfChrome(gutter, phone, [{ left: 8, top: 700, right: 380, bottom: 748 }]);
    expect(padding.bottom).toBe(760 - 700 + CHROME_GAP_PX);
    expect(padding.left).toBe(24);
  });

  it("ignores chrome outside the canvas, and keeps a larger padding already there", () => {
    expect(
      clearOfChrome({ ...gutter, left: 200 }, canvas, [rail, { left: 1100, top: 0, right: 1440, bottom: 900 }]),
    ).toEqual({ ...gutter, left: 200 });
  });

  it("frames the walked parts clear of the rail and centred in the room left", () => {
    const layout = layoutOf([node("concorde", 0, 0, 190, 56), node("coach", 720, 0, 176, 56), node("z", 900, 600)]);
    const size = { width: canvas.right - canvas.left, height: canvas.bottom - canvas.top };
    const padding = clearOfChrome(gutter, canvas, [rail, fab]);
    const frame = followFrame({
      layout,
      nodeIds: ["concorde", "coach"],
      edgeIds: [],
      canvas: size,
      padding,
      margin: 40,
    })!;
    expect(canvas.left + frame.x).toBeGreaterThanOrEqual(rail.right);
    expect(canvas.left + frame.x + 896 * frame.zoom).toBeLessThanOrEqual(fab.left);
  });
});
