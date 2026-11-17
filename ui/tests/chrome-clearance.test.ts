// Chrome and drawing do not share pixels when they do not have to.
//
// The control cluster sits in the canvas's bottom-left corner and the
// off-screen cue floats over the canvas. A framing that knows about neither
// puts the drawing under both: at 420x800 the shipped sample's sequence opened
// with the cue on a message label and the cluster on a fragment's frame
// (release review 2026-10-01, I1). These are the two decisions that stop it,
// as pure functions of boxes: where the framing leaves room, and where the cue
// goes.
import { describe, expect, it } from "vitest";
import {
  CHROME_GAP_PX,
  CUE_BAND_PX,
  drawnOn,
  frameClearOfChrome,
  graphObstacles,
  hitsAny,
  placeCue,
  sequenceObstacles,
} from "../src/diagrams/chrome-clearance";
import {
  readingZoom,
  frameViewport,
  overflowOf,
  type Box,
  type Frame,
  type Padding,
  type Size,
} from "../src/diagrams/viewport-fit";
import type { LayoutResult } from "../src/layout/elk-adapter";
import type { SequenceLayoutResult } from "../src/layout/sequence-layout";

const GUTTER: Padding = { top: 24, right: 24, bottom: 24, left: 24 };
const NARROW: Size = { width: 420, height: 700 };
/** The control cluster as both canvases draw it: 30px wide, bottom-left, 15px in. */
const controlsIn = (canvas: Size): Box => ({ x: 15, y: canvas.height - 15 - 142, width: 30, height: 142 });

/** Frames `items` (their bounding box is the content) the way the graph canvas does. */
function frameItems(
  items: readonly Box[],
  canvas: Size,
  controls: Box | null,
  minZoom = readingZoom("flowchart").min,
  cueFor?: (frame: Frame) => boolean,
) {
  const left = Math.min(...items.map((b) => b.x));
  const top = Math.min(...items.map((b) => b.y));
  const right = Math.max(...items.map((b) => b.x + b.width));
  const bottom = Math.max(...items.map((b) => b.y + b.height));
  const content: Box = { x: left, y: top, width: right - left, height: bottom - top };
  return frameClearOfChrome<Frame>({
    base: GUTTER,
    controls,
    frameWith: (padding) =>
      frameViewport(content, canvas, padding, { min: minZoom, max: readingZoom("flowchart").max }),
    overflowOf: (frame) => overflowOf(content, { across: items, down: items }, frame, canvas),
    hits: (frame, rect) => hitsAny(drawnOn(items, frame), rect),
    cueFor,
  });
}

describe("a framing leaves the control cluster's corner clear", () => {
  // A column of boxes filling the canvas: its left edge is on the gutter and
  // its last rows run past the bottom, straight through the cluster's corner.
  const column: Box[] = Array.from({ length: 30 }, (_, i) => ({ x: 0, y: i * 70, width: 520, height: 50 }));

  it("moves the drawing out from under it, by the cluster's width and a gap", () => {
    const controls = controlsIn(NARROW);
    const framed = frameItems(column, NARROW, controls);

    expect(hitsAny(drawnOn(column, framed.frame), controls), "something is drawn under the controls").toBe(false);
    expect(framed.padding.left).toBe(controls.x + controls.width + CHROME_GAP_PX);
  });

  it("is what the plain gutter does not do", () => {
    const controls = controlsIn(NARROW);
    const plain = frameViewport(
      { x: 0, y: 0, width: 520, height: 30 * 70 - 20 },
      NARROW,
      GUTTER,
      readingZoom("flowchart"),
    );
    expect(hitsAny(drawnOn(column, plain), controls)).toBe(true);
  });

  it("takes no room from a drawing that was never going to be under it", () => {
    // A wide band across the middle of the canvas: its bounding box is nowhere
    // near the corner, so nothing is reserved and nothing shrinks.
    const band: Box[] = Array.from({ length: 4 }, (_, i) => ({ x: i * 200, y: 0, width: 160, height: 60 }));
    const wide: Size = { width: 1440, height: 800 };
    const framed = frameItems(band, wide, controlsIn(wide));

    expect(framed.padding).toEqual(GUTTER);
  });

  it("judges by what is drawn, not by the corner of an empty bounding box", () => {
    // A staircase from top-left... to bottom-right: the bounding box covers
    // the bottom-left corner and nothing in it is there.
    const wide: Size = { width: 900, height: 700 };
    const stairs: Box[] = [
      { x: 500, y: 0, width: 300, height: 100 },
      { x: 600, y: 500, width: 300, height: 100 },
      { x: 0, y: 0, width: 300, height: 100 },
    ];
    const framed = frameItems(stairs, wide, controlsIn(wide), 0.01);

    expect(framed.padding.left).toBe(GUTTER.left);
  });

  it("reserves nothing when there is no cluster to measure", () => {
    expect(frameItems(column, NARROW, null).padding.left).toBe(GUTTER.left);
  });
});

describe("a framing leaves the compile notice's corner clear", () => {
  // A drawing too big for the canvas opens at its start, top-left: right
  // where the compile notice sits. The notice's sentence is a band the
  // framing keeps free, as it keeps the cue's.
  const WIDE: Size = { width: 1200, height: 800 };
  const grid: Box[] = Array.from({ length: 40 }, (_, i) => ({
    x: (i % 8) * 260,
    y: Math.floor(i / 8) * 200,
    width: 200,
    height: 80,
  }));
  const notice: Box = { x: 12, y: 12, width: 480, height: 40 };

  const frame = (withNotice: Box | null) => {
    const content: Box = { x: 0, y: 0, width: 8 * 260 - 60, height: 5 * 200 - 120 };
    return frameClearOfChrome<Frame>({
      base: GUTTER,
      controls: null,
      notice: withNotice,
      frameWith: (padding) =>
        frameViewport(content, WIDE, padding, readingZoom("flowchart"), { x: 0, y: 0, width: 200, height: 80 }),
      overflowOf: (f) => overflowOf(content, { across: grid, down: grid }, f, WIDE),
      hits: (f, rect) => hitsAny(drawnOn(grid, f), rect),
    });
  };

  it("draws nothing under the notice's sentence", () => {
    const framed = frame(notice);
    expect(hitsAny(drawnOn(grid, framed.frame), notice), "something is drawn under the notice").toBe(false);
    expect(framed.padding.top).toBeGreaterThanOrEqual(notice.y + notice.height + CHROME_GAP_PX);
  });

  it("is what the framing did not do before: the drawing's corner sat under it", () => {
    expect(hitsAny(drawnOn(grid, frame(null).frame), notice)).toBe(true);
  });

  it("keeps no band where the drawing is clear of the notice anyway", () => {
    const low: Box = { x: 12, y: 12, width: 40, height: 10 };
    const small: Box[] = [{ x: 300, y: 300, width: 100, height: 40 }];
    const framed = frameClearOfChrome<Frame>({
      base: GUTTER,
      controls: null,
      notice: low,
      frameWith: (padding) => frameViewport(small[0]!, WIDE, padding, readingZoom("flowchart")),
      overflowOf: () => [],
      hits: (f, rect) => hitsAny(drawnOn(small, f), rect),
    });
    expect(framed.padding).toEqual(GUTTER);
  });
});

describe("a framing that leaves part of the drawing off screen", () => {
  const column: Box[] = Array.from({ length: 30 }, (_, i) => ({ x: 0, y: i * 70, width: 300, height: 50 }));

  it("keeps a band at the top free, for the cue that says so", () => {
    const framed = frameItems(column, NARROW, null);

    expect(framed.overflow).not.toEqual([]);
    expect(framed.padding.top).toBe(CUE_BAND_PX);
    // The first row starts under the band, and nothing is drawn in it.
    const band: Box = { x: 0, y: 0, width: NARROW.width, height: CUE_BAND_PX - 1 };
    expect(hitsAny(drawnOn(column, framed.frame), band)).toBe(false);
  });

  it("reports the overflow of the framing it settled on, not of the first try", () => {
    const framed = frameItems(column, NARROW, null);
    const expected = overflowOf(
      { x: 0, y: 0, width: 300, height: 30 * 70 - 20 },
      { across: column, down: column },
      framed.frame,
      NARROW,
    );
    expect(framed.overflow).toEqual(expected);
  });

  it("keeps no band when everything is in view", () => {
    const small: Box[] = [{ x: 0, y: 0, width: 200, height: 100 }];
    const framed = frameItems(small, NARROW, null);

    expect(framed.overflow).toEqual([]);
    expect(framed.padding).toEqual(GUTTER);
  });

  /*
   * The cue has a second thing to say: everything is in view, too small to
   * read. A tall drawing shown whole is a line down the middle of the canvas,
   * and a pill nearly as wide as a phone has nowhere beside it; without a
   * band the pill sat on the first nodes (`browser/framing.e2e.ts` found it).
   */
  it("keeps the band for a cue that has something else to say, with nothing off screen", () => {
    const framed = frameItems(column, NARROW, null, 0, () => true);

    expect(framed.overflow).toEqual([]);
    expect(framed.padding.top).toBe(CUE_BAND_PX);
    const band: Box = { x: 0, y: 0, width: NARROW.width, height: CUE_BAND_PX - 1 };
    expect(hitsAny(drawnOn(column, framed.frame), band)).toBe(false);
    // Still all of it: the band costs zoom, not content.
    const last = drawnOn(column, framed.frame).at(-1)!;
    expect(last.y + last.height).toBeLessThanOrEqual(NARROW.height - GUTTER.bottom + 1e-6);
  });

  it("asks about the framing it is about to settle on, and keeps no band when the answer is no", () => {
    const asked: number[] = [];
    const framed = frameItems(column, NARROW, null, 0, (frame) => {
      asked.push(frame.zoom);
      return false;
    });

    expect(asked.length).toBeGreaterThan(0);
    expect(framed.padding).toEqual(GUTTER);
  });

  it("is the same framing every time, however often it is asked", () => {
    const first = frameItems(column, NARROW, controlsIn(NARROW));
    const second = frameItems(column, NARROW, controlsIn(NARROW));
    expect(second).toEqual(first);
  });
});

describe("where the cue goes", () => {
  const canvas: Size = { width: 420, height: 700 };
  const bar: Size = { width: 200, height: 26 };
  const overlaps = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const at = (spot: { left: number; top: number }): Box => ({ x: spot.left, y: spot.top, ...bar });

  it("sits in the top band, at the edge the drawing runs past, when that is free", () => {
    const spot = placeCue(bar, canvas, "right", []);
    expect(spot.top).toBeLessThan(CUE_BAND_PX - bar.height);
    expect(spot.left + bar.width).toBeGreaterThan(canvas.width - 20);
  });

  it("is centred when the drawing runs past more than one edge, or past the bottom", () => {
    const spot = placeCue(bar, canvas, "center", []);
    expect(spot.left + bar.width / 2).toBeCloseTo(canvas.width / 2, 6);
  });

  it("moves along the band when something is drawn where it would have sat", () => {
    const corner: Box = { x: 300, y: 0, width: 120, height: 60 };
    const spot = placeCue(bar, canvas, "right", [corner]);

    expect(overlaps(at(spot), corner)).toBe(false);
    expect(spot.top, "it stayed in the band").toBeLessThan(CUE_BAND_PX - bar.height);
  });

  it("leaves the band for any free canvas when the whole band is drawn on", () => {
    const band: Box = { x: 0, y: 0, width: canvas.width, height: 300 };
    const spot = placeCue(bar, canvas, "right", [band]);

    expect(overlaps(at(spot), band)).toBe(false);
    expect(spot.top).toBeGreaterThanOrEqual(300);
    expect(spot.top + bar.height).toBeLessThanOrEqual(canvas.height);
  });

  it("goes back to its usual place when there is no free canvas at all", () => {
    const everything: Box = { x: 0, y: 0, ...canvas };
    expect(placeCue(bar, canvas, "right", [everything])).toEqual(placeCue(bar, canvas, "right", []));
  });

  it("never leaves the canvas, even one too small to hold it", () => {
    const tiny: Size = { width: 150, height: 40 };
    const spot = placeCue(bar, tiny, "center", []);
    expect(spot.left).toBeGreaterThanOrEqual(0);
    expect(spot.top).toBeGreaterThanOrEqual(0);
  });

  it("finds free canvas beside a drawing that crosses the whole height", () => {
    // Lifelines every 110px all the way down, and a clear strip on the left.
    const lifelines: Box[] = [200, 310, 420].map((x) => ({ x, y: 0, width: 2, height: canvas.height }));
    const rows: Box[] = Array.from({ length: 20 }, (_, i) => ({ x: 200, y: i * 35, width: 220, height: 20 }));
    const blocked = [...lifelines, ...rows];
    const narrowBar: Size = { width: 170, height: 26 };
    const spot = placeCue(narrowBar, canvas, "right", blocked);

    for (const box of blocked) {
      expect(overlaps({ x: spot.left, y: spot.top, ...narrowBar }, box)).toBe(false);
    }
  });
});

describe("what counts as drawn", () => {
  const layout: LayoutResult = {
    nodes: [
      { id: "a", x: 20, y: 40, width: 100, height: 40, label: "A", shape: undefined, classes: [], groupId: "g" },
      { id: "b", x: 300, y: 40, width: 100, height: 40, label: "B", shape: undefined, classes: [], groupId: undefined },
    ],
    edges: [
      {
        id: "e",
        source: "a",
        target: "b",
        label: "calls",
        points: [
          { x: 120, y: 60 },
          { x: 200, y: 60 },
          { x: 200, y: 200 },
          { x: 300, y: 200 },
        ],
        labelAnchor: { x: 180, y: 120, width: 40, height: 18 },
      },
    ],
    groups: [{ id: "g", label: "Group", parentId: undefined, x: 10, y: 30, width: 130, height: 60 }],
    width: 420,
    height: 240,
  };
  const identity: Frame = { x: 0, y: 0, zoom: 1 };
  const drawnAt = (rect: Box): boolean => hitsAny(drawnOn(graphObstacles(layout), identity), rect);

  it("a node, a wire, a caption and a group's caption are", () => {
    expect(drawnAt({ x: 30, y: 50, width: 4, height: 4 }), "a node").toBe(true);
    expect(drawnAt({ x: 196, y: 100, width: 8, height: 8 }), "a wire's vertical run").toBe(true);
    expect(drawnAt({ x: 250, y: 196, width: 8, height: 8 }), "a wire's horizontal run").toBe(true);
    expect(drawnAt({ x: 185, y: 125, width: 4, height: 4 }), "an edge caption").toBe(true);
    // Inside its frame, in the band at its home: no layout placed it elsewhere.
    expect(drawnAt({ x: 28, y: 44, width: 20, height: 3 }), "a group's caption, in its band").toBe(true);
    expect(drawnAt({ x: 12, y: 12, width: 20, height: 10 }), "above its frame, where the caption used to hang").toBe(
      false,
    );
  });

  it("the empty inside of a wire's bend and of the canvas are not", () => {
    expect(drawnAt({ x: 230, y: 80, width: 40, height: 80 }), "inside the bend").toBe(false);
    expect(drawnAt({ x: 300, y: 120, width: 60, height: 40 }), "empty canvas").toBe(false);
  });

  it("scales and moves with the camera", () => {
    const half: Frame = { x: 100, y: 50, zoom: 0.5 };
    const [node] = drawnOn([{ x: 20, y: 40, width: 100, height: 40 }], half);
    expect(node).toEqual({ x: 110, y: 70, width: 50, height: 20 });
  });

  it("on a sequence: participants, their lifelines, messages, notes and fragment frames", () => {
    const sequence: SequenceLayoutResult = {
      participants: [
        { id: "p", label: "P", lines: ["P"], x: 0, y: 0, width: 100, height: 40 },
        { id: "q", label: "Q", lines: ["Q"], x: 200, y: 0, width: 100, height: 40 },
      ],
      messages: [
        {
          id: "m",
          from: "p",
          to: "q",
          fromX: 50,
          toX: 250,
          y: 100,
          label: "go",
          lines: ["go"],
          labelWidth: 20,
          kind: "sync",
        },
      ],
      fragments: [
        {
          id: "f",
          kind: "loop",
          label: "",
          headerLabel: "",
          chipWidth: 40,
          x: 20,
          y: 140,
          width: 260,
          height: 100,
          sections: [],
        },
      ],
      activations: [],
      notes: [
        {
          id: "n",
          position: "over",
          participants: ["p"],
          text: "note",
          lines: ["note"],
          x: 10,
          y: 260,
          width: 80,
          height: 30,
        },
      ],
      originX: 0,
      originY: 0,
      width: 300,
      height: 400,
      lifelineEndY: 400,
    } as unknown as SequenceLayoutResult;
    const at = (rect: Box): boolean => hitsAny(drawnOn(sequenceObstacles(sequence), identity), rect);

    expect(at({ x: 10, y: 10, width: 4, height: 4 }), "a participant").toBe(true);
    expect(at({ x: 46, y: 300, width: 8, height: 8 }), "a lifeline").toBe(true);
    expect(at({ x: 140, y: 96, width: 8, height: 8 }), "a message").toBe(true);
    expect(at({ x: 16, y: 180, width: 8, height: 8 }), "a fragment's frame").toBe(true);
    expect(at({ x: 30, y: 270, width: 4, height: 4 }), "a note").toBe(true);
    expect(at({ x: 120, y: 180, width: 40, height: 20 }), "the empty inside of a fragment").toBe(false);
    expect(at({ x: 120, y: 320, width: 60, height: 40 }), "between two lifelines").toBe(false);
  });
});

describe("a framing leaves every floating piece of chrome clear, the chat button too (review 2026-11-13, D)", () => {
  // A drawing about as wide as it is tall: Fit fills the canvas to its corners, and the bottom-right one is the chat
  // button's.
  const WIDE: Size = { width: 1025, height: 796 };
  const grid: Box[] = Array.from({ length: 54 }, (_, i) => ({
    x: (i % 6) * 210,
    y: Math.floor(i / 6) * 110,
    width: 160,
    height: 50,
  }));
  const content: Box = { x: 0, y: 0, width: 5 * 210 + 160, height: 8 * 110 + 50 };
  const fab: Box = { x: 957, y: 728, width: 52, height: 52 };
  const rail: Box = { x: 15, y: 471, width: 52, height: 310 };
  const fit = (floating: readonly Box[] | undefined) =>
    frameClearOfChrome<Frame>({
      base: GUTTER,
      controls: rail,
      floating,
      canvas: WIDE,
      frameWith: (padding) => frameViewport(content, WIDE, padding, { min: 0, max: readingZoom("flowchart").max }),
      overflowOf: (f) => overflowOf(content, { across: grid, down: grid }, f, WIDE),
      hits: (f, rect) => hitsAny(drawnOn(grid, f), rect),
    });

  it("is what the framing did not do before: the last box sat under the chat button", () => {
    expect(hitsAny(drawnOn(grid, fit(undefined).frame), fab)).toBe(true);
  });

  it("draws nothing under the chat button or the rail", () => {
    const framed = fit([fab]);
    expect(hitsAny(drawnOn(grid, framed.frame), fab), "something is drawn under the chat button").toBe(false);
    expect(hitsAny(drawnOn(grid, framed.frame), rail), "something is drawn under the rail").toBe(false);
  });

  it("reserves the side that costs least and clears it: here the right", () => {
    expect(fit([fab]).padding.right).toBe(WIDE.width - fab.x + CHROME_GAP_PX);
  });

  it("tries the next side when the cheapest would not clear it: a drawing held at its reading size", () => {
    // A column at the reading floor runs off the bottom; reserving the bottom (cheapest for a button low in a tall
    // canvas) moves nothing. The right moves the centred column off it.
    const tall: Size = { width: 600, height: 1200 };
    const column: Box[] = Array.from({ length: 30 }, (_, i) => ({ x: 0, y: i * 70, width: 470, height: 50 }));
    const button: Box = { x: 530, y: 1100, width: 52, height: 52 };
    const reading = readingZoom("flowchart");
    const framed = frameClearOfChrome<Frame>({
      base: GUTTER,
      controls: null,
      floating: [button],
      canvas: tall,
      frameWith: (padding) =>
        frameViewport({ x: 0, y: 0, width: 470, height: 30 * 70 - 20 }, tall, padding, {
          min: reading.max,
          max: reading.max,
        }),
      overflowOf: (f) =>
        overflowOf({ x: 0, y: 0, width: 470, height: 2080 }, { across: column, down: column }, f, tall),
      hits: (f, rect) => hitsAny(drawnOn(column, f), rect),
    });
    expect(hitsAny(drawnOn(column, framed.frame), button)).toBe(false);
    expect(framed.padding.bottom).toBe(GUTTER.bottom);
  });
});
