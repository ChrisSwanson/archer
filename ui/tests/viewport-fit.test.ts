// Where the camera goes when the canvas frames a drawing.
//
// The first version left this to React Flow's `fitView`, which clamps to the
// flow's minimum zoom (0.5 by default) and then CENTRES: a graph that needed
// 0.38 to fit was drawn at 0.5 with its first and its last node both outside
// the canvas, and the user was shown the middle of a diagram with no cue that
// there was more. The decision is a pure function so it can be pinned here.
//
// The second review (2026-10-04) found every notation opening at its own
// scale: a five-service architecture at 1.38 with 19px labels, a flowchart at
// 0.7 with 8px captions, a sequence's fragment conditions at 7px on a phone.
// One policy now holds the smallest text each notation draws for its reader
// to 12-13px on screen (`READING_TEXT_PX`).
import { describe, expect, it } from "vitest";
import {
  CANVAS_MIN_ZOOM,
  FIT_GUTTER_PX,
  MIN_DECIPHERABLE_LABEL_PX,
  NO_ZOOM_FLOOR,
  NODE_LABEL_FACES,
  READING_TEXT_PX,
  entryBox,
  fitPadding,
  frameViewport,
  layoutBounds,
  overflowOf,
  overflowText,
  readingFaces,
  readingZoom,
  showAllZoom,
  tooSmallToRead,
  type Box,
  type Frame,
  type Padding,
  type ReadingNotation,
  type Size,
  type ZoomRange,
} from "../src/diagrams/viewport-fit";
import type { LayoutResult } from "../src/layout/elk-adapter";
import { FRAME_CAPTION_FONT_PX } from "../src/layout/captions";
import { TYPEFACES, type TypefaceId } from "../src/layout/text-measure";
import { declarationsOf, readStylesheet, rulesOf, throughTokens } from "./stylesheet";

const CANVAS: Size = { width: 1440, height: 795 };
const GUTTER: Padding = { top: 24, right: 24, bottom: 24, left: 24 };
/** A flowchart in Current: what most of these cases frame. */
const READ: ZoomRange = readingZoom("flowchart");
/** The reader's explicit fit of a flowchart. */
const ALL: ZoomRange = showAllZoom(READ);

const NOTATIONS: readonly ReadingNotation[] = ["flowchart", "state", "er", "c4", "architecture", "sequence"];
const FACES = Object.keys(TYPEFACES) as TypefaceId[];

/** Where a graph-space box lands on screen under a frame. */
function onScreen(box: Box, frame: Frame): { left: number; top: number; right: number; bottom: number } {
  return {
    left: box.x * frame.zoom + frame.x,
    top: box.y * frame.zoom + frame.y,
    right: (box.x + box.width) * frame.zoom + frame.x,
    bottom: (box.y + box.height) * frame.zoom + frame.y,
  };
}

/** The smallest reading text of a notation, in screen pixels, at `zoom`. */
const smallestOnScreen = (notation: ReadingNotation, zoom: number, typeface?: TypefaceId): number =>
  Math.min(...readingFaces(notation, typeface).map((face) => face.px)) * zoom;

describe("the reading policy: one for every notation", () => {
  it.each(NOTATIONS)("%s: an automatic framing draws its smallest reading text at 12 to 13px", (notation) => {
    for (const typeface of FACES) {
      const range = readingZoom(notation, typeface);
      expect(smallestOnScreen(notation, range.min, typeface)).toBeCloseTo(READING_TEXT_PX.min, 9);
      expect(smallestOnScreen(notation, range.max, typeface)).toBeCloseTo(READING_TEXT_PX.max, 9);
    }
  });

  it.each(NOTATIONS)("%s: a small drawing is not blown up past reading size to fill the canvas", (notation) => {
    const range = readingZoom(notation);
    const small: Box = { x: 0, y: 0, width: 400, height: 200 };
    const frame = frameViewport(small, CANVAS, GUTTER, range);
    expect(frame.zoom).toBe(range.max);
    expect(smallestOnScreen(notation, frame.zoom)).toBeCloseTo(13, 9);
  });

  it.each(NOTATIONS)("%s: a drawing that fits between the two is fitted, text inside the band", (notation) => {
    const range = readingZoom(notation);
    // Just tall enough to need a zoom in the middle of the band.
    const zoom = (range.min + range.max) / 2;
    const content: Box = { x: 0, y: 0, width: 300, height: (CANVAS.height - 48) / zoom };
    const frame = frameViewport(content, CANVAS, GUTTER, range);
    expect(frame.zoom).toBeCloseTo(zoom, 9);
    const px = smallestOnScreen(notation, frame.zoom);
    expect(px).toBeGreaterThanOrEqual(12);
    expect(px).toBeLessThanOrEqual(13);
  });

  it.each(NOTATIONS)("%s: a drawing too big to read whole is framed from its entry at the floor", (notation) => {
    const range = readingZoom(notation);
    const big: Box = { x: 0, y: 0, width: 4000, height: 3000 };
    const entry: Box = { x: 1800, y: 0, width: 400, height: 60 };
    const frame = frameViewport(big, CANVAS, GUTTER, range, entry);
    expect(frame.zoom).toBe(range.min);
    expect(smallestOnScreen(notation, frame.zoom)).toBeCloseTo(12, 9);
    const drawn = onScreen(entry, frame);
    expect(drawn.left).toBeGreaterThanOrEqual(24);
    expect(drawn.right).toBeLessThanOrEqual(CANVAS.width - 24);
    expect(drawn.top).toBeCloseTo(24, 6);
  });

  it("holds a sequence to its fragment conditions, which are smaller than any graph's captions", () => {
    // The sequence canvas used to borrow the graph's floor, derived from node
    // labels, and drew its 11px conditions at 7.7px.
    const sequence = readingFaces("sequence");
    expect(Math.min(...sequence.map((face) => face.px))).toBe(11);
    expect(readingZoom("sequence").min).toBeGreaterThan(readingZoom("flowchart").min);
  });

  it("opens the review's architecture at reading size, not at 1.38", () => {
    // Five services in a 1080x855 canvas fit at 1.38; the labels were 19px.
    const architecture = readingZoom("architecture");
    const frame = frameViewport(
      { x: 0, y: 0, width: 760, height: 560 },
      { width: 1080, height: 855 },
      GUTTER,
      architecture,
    );
    expect(frame.zoom).toBeLessThan(1.1);
    for (const face of readingFaces("architecture")) {
      expect(face.px * frame.zoom, face.what).toBeLessThanOrEqual(15.5 + 1e-9);
    }
  });

  it("states the frame caption's size the stylesheet draws", () => {
    const rules = rulesOf(readStylesheet());
    const value = rules
      .filter((rule) => rule.selectors.includes(".archer-frame-caption"))
      .flatMap((rule) => declarationsOf(rule.body))
      .find(([property]) => property === "font-size")?.[1];
    // Through its named canvas token (round 1 pass 3) when it names one.
    const token = /^var\((--[\w-]+)\)$/.exec(value!)?.[1];
    const size =
      token === undefined
        ? value!
        : rules
            .flatMap((rule) => (rule.selectors.includes(":root") ? declarationsOf(rule.body) : []))
            .find(([property]) => property === token)?.[1];
    expect(Number.parseFloat(size!)).toBe(FRAME_CAPTION_FONT_PX);
  });
});

describe("an explicit fit of a graph far wider than the window", () => {
  // Measured in a browser: sixteen nodes left to right are about 5,500px of
  // graph, and a 420px window has 372px of room, so showing all of it takes
  // 0.07. "Fit view" used to stop at the hand-zoom minimum (0.1) and leave the
  // last five nodes off screen.
  const chain: Box = { x: 12, y: 12, width: 5500, height: 60 };
  const narrow: Size = { width: 420, height: 700 };
  const nodes: Box[] = Array.from({ length: 16 }, (_, i) => ({ x: 12 + i * 362, y: 12, width: 200, height: 60 }));

  it("goes below the hand-zoom minimum, as far as showing everything takes", () => {
    const frame = frameViewport(chain, narrow, GUTTER, ALL);
    const drawn = onScreen(chain, frame);

    expect(frame.zoom).toBeLessThan(CANVAS_MIN_ZOOM);
    expect(drawn.left).toBeGreaterThanOrEqual(24 - 1e-6);
    expect(drawn.right).toBeLessThanOrEqual(narrow.width - 24 + 1e-6);
    expect(overflowOf(chain, { across: nodes, down: nodes }, frame, narrow)).toEqual([]);
  });

  it("is what the hand-zoom minimum could not do", () => {
    const frame = frameViewport(chain, narrow, GUTTER, { min: CANVAS_MIN_ZOOM, max: READ.max });
    expect(overflowOf(chain, { across: nodes, down: nodes }, frame, narrow)).toEqual([{ side: "right", count: 5 }]);
  });

  it("keeps the reading ceiling: a small graph is shown whole, not magnified", () => {
    const tiny: Box = { x: 0, y: 0, width: 180, height: 60 };
    expect(frameViewport(tiny, CANVAS, GUTTER, ALL).zoom).toBe(READ.max);
  });
});

/*
 * NO FLOOR UNDER AN EXPLICIT FIT (adversarial review 2026-10-02, F7).
 *
 * It stopped at a constant of 0.01, and this file asserted that it did: "still
 * says what is off screen when even the explicit minimum cannot show it all".
 * A 200-node chain is about 40,000px and needs 0.0093 in a 420px window, so
 * "Show all" left twenty nodes off screen and went on offering to show all.
 * What is supported is bounded by the source (256 KiB), not by a size, so the
 * minimum is whatever the drawing implies.
 */
describe("an explicit fit of a drawing of any supported size", () => {
  const narrow: Size = { width: 420, height: 700 };
  const room = narrow.width - GUTTER.left - GUTTER.right;

  // What a line of `count` nodes comes to, at the pitch measured above.
  const chainOf = (count: number): { content: Box; nodes: Box[] } => ({
    content: { x: 12, y: 12, width: count * 200 + (count - 1) * 162, height: 60 },
    nodes: Array.from({ length: count }, (_, i) => ({ x: 12 + i * 362, y: 12, width: 200, height: 60 })),
  });

  it.each([
    ["200 nodes, the review's case", 200],
    ["2,000 nodes", 2_000],
    // About what 256 KiB of source can hold in one line: twenty bytes a link.
    ["12,000 nodes, the most a registered source can describe", 12_000],
  ])("shows every node of a chain of %s", (_name, count) => {
    const { content, nodes } = chainOf(count);
    const frame = frameViewport(content, narrow, GUTTER, ALL);
    const drawn = onScreen(content, frame);

    // The zoom is the drawing's own, to the pixel: not a constant near it.
    expect(frame.zoom).toBeCloseTo(room / content.width, 12);
    expect(frame.zoom).toBeGreaterThan(0);
    expect(drawn.left).toBeGreaterThanOrEqual(GUTTER.left - 1e-6);
    expect(drawn.right).toBeLessThanOrEqual(narrow.width - GUTTER.right + 1e-6);
    expect(overflowOf(content, { across: nodes, down: nodes }, frame, narrow)).toEqual([]);
  });

  it("is what the old constant could not do", () => {
    const { content, nodes } = chainOf(200);
    const frame = frameViewport(content, narrow, GUTTER, { min: 0.01, max: READ.max });
    const left = overflowOf(content, { across: nodes, down: nodes }, frame, narrow);
    expect(left).toHaveLength(1);
    expect(left[0].side).toBe("right");
    expect(left[0].count).toBeGreaterThan(0);
  });
});

describe("saying an overview is too small to read", () => {
  it("is derived from the label sizes: below the size at which a label can still be made out", () => {
    for (const label of NODE_LABEL_FACES) {
      const edge = MIN_DECIPHERABLE_LABEL_PX / label.fontPx;
      expect(tooSmallToRead(edge * 0.99), `${label.face} just under`).toBe(true);
    }
    // The smallest face decides: every face has to be decipherable.
    const threshold = Math.max(...NODE_LABEL_FACES.map((label) => MIN_DECIPHERABLE_LABEL_PX / label.fontPx));
    expect(tooSmallToRead(threshold)).toBe(false);
    expect(tooSmallToRead(threshold - 1e-9)).toBe(true);
  });

  it("does not call the reading floor, or the measured decipherable half, too small", () => {
    for (const notation of NOTATIONS) expect(tooSmallToRead(readingZoom(notation).min)).toBe(false);
    // 0.50 is where the measurement found a label "can be deciphered".
    expect(tooSmallToRead(0.5)).toBe(false);
    expect(MIN_DECIPHERABLE_LABEL_PX).toBeLessThan(READING_TEXT_PX.min);
  });

  it("calls the review's overview too small", () => {
    expect(tooSmallToRead(0.0093)).toBe(true);
  });
});

describe("framing a graph that fits at a readable size", () => {
  // Needs 0.96 to fill the canvas's height: inside the flowchart's band (12/13 to 1 for its 13px captions).
  const content: Box = { x: 12, y: 12, width: 700, height: 778 };

  it("shows the whole graph inside the canvas, with a gutter on every side", () => {
    const frame = frameViewport(content, CANVAS, GUTTER, READ);
    const drawn = onScreen(content, frame);

    expect(drawn.left).toBeGreaterThanOrEqual(24 - 1e-6);
    expect(drawn.top).toBeGreaterThanOrEqual(24 - 1e-6);
    expect(drawn.right).toBeLessThanOrEqual(CANVAS.width - 24 + 1e-6);
    expect(drawn.bottom).toBeLessThanOrEqual(CANVAS.height - 24 + 1e-6);
  });

  it("uses all the room the tighter axis has", () => {
    const frame = frameViewport(content, CANVAS, GUTTER, READ);
    expect(frame.zoom).toBeCloseTo((CANVAS.height - 48) / content.height, 6);
  });

  it("centres the graph across, and starts it at the top", () => {
    // A short, wide drawing centred down a tall canvas sat between two empty
    // bands (state and ER, review of 2026-10-04).
    const wide: Box = { x: 12, y: 12, width: 900, height: 200 };
    const frame = frameViewport(wide, CANVAS, GUTTER, READ);
    const drawn = onScreen(wide, frame);
    expect(drawn.left).toBeCloseTo(CANVAS.width - drawn.right, 6);
    expect(drawn.top).toBeCloseTo(24, 6);
  });

  it("does not blow a small graph up past the reading ceiling", () => {
    const tiny: Box = { x: 0, y: 0, width: 180, height: 60 };
    expect(frameViewport(tiny, CANVAS, GUTTER, READ).zoom).toBe(READ.max);
  });
});

describe("framing a graph too big to fit at a readable size", () => {
  // The containers sample before the layout was compacted: 1966px of layers.
  const tall: Box = { x: 12, y: 12, width: 856, height: 1966 };

  it("stops at the reading floor instead of shrinking the text away", () => {
    const frame = frameViewport(tall, CANVAS, GUTTER, READ);
    expect(frame.zoom).toBe(READ.min);
  });

  it("starts at the top of the graph rather than cutting off both ends", () => {
    const frame = frameViewport(tall, CANVAS, GUTTER, READ);
    const drawn = onScreen(tall, frame);
    // The first layer sits on the gutter; the overflow is all at the bottom,
    // which is where scrolling goes looking for it.
    expect(drawn.top).toBeCloseTo(24, 6);
    expect(drawn.bottom).toBeGreaterThan(CANVAS.height);
  });

  it("still centres the axis that does fit", () => {
    const frame = frameViewport(tall, CANVAS, GUTTER, READ);
    const drawn = onScreen(tall, frame);
    expect(drawn.left).toBeCloseTo(CANVAS.width - drawn.right, 6);
  });

  it("starts at the left of a graph that is too wide as well", () => {
    const narrow: Size = { width: 420, height: 640 };
    const frame = frameViewport(tall, narrow, GUTTER, READ);
    const drawn = onScreen(tall, frame);
    expect(drawn.left).toBeCloseTo(24, 6);
    expect(drawn.top).toBeCloseTo(24, 6);
  });

  // Measured at 420px: the first layer of a layered graph is centred over the
  // graph, so a left-aligned start showed a column with no first node in it.
  it("keeps the first layer in view across an axis that overflows", () => {
    const narrow: Size = { width: 420, height: 640 };
    const entry: Box = { x: 350, y: 12, width: 180, height: 60 };
    const frame = frameViewport(tall, narrow, GUTTER, READ, entry);
    const drawn = onScreen(entry, frame);

    expect(drawn.left).toBeGreaterThanOrEqual(24);
    expect(drawn.right).toBeLessThanOrEqual(narrow.width - 24);
    // As near the drawing's start as keeps it in view: its far edge on the
    // gutter, and no more of the drawing off the left than that takes.
    expect(drawn.right).toBeCloseTo(narrow.width - 24, 6);
    expect(drawn.top).toBeCloseTo(24, 6);
  });

  it("starts at the drawing's own edge when the first layer is in view from there", () => {
    // Centring it ran the drawing off the left edge, under the control
    // cluster, for a first layer that was in view anyway.
    const narrow: Size = { width: 420, height: 640 };
    const near: Box = { x: 100, y: 12, width: 180, height: 60 };
    const frame = frameViewport(tall, narrow, GUTTER, READ, near);
    expect(onScreen(tall, frame).left).toBeCloseTo(24, 6);
    expect(onScreen(near, frame).right).toBeLessThanOrEqual(narrow.width - 24);
  });

  it("never scrolls past the graph's own edge to centre the first layer", () => {
    const narrow: Size = { width: 420, height: 640 };
    const atTheEdge: Box = { x: 12, y: 12, width: 180, height: 60 };
    const frame = frameViewport(tall, narrow, GUTTER, READ, atTheEdge);

    // Centring it would leave empty canvas to the left of the whole graph.
    expect(onScreen(tall, frame).left).toBeCloseTo(24, 6);
  });

  it("shows all of it when the user asks for the whole graph", () => {
    // The fit control and its shortcut pass no floor at all: an explicit
    // request for an overview outranks legibility.
    const frame = frameViewport(tall, CANVAS, GUTTER, ALL);
    const drawn = onScreen(tall, frame);
    expect(frame.zoom).toBeLessThan(READ.min);
    expect(drawn.top).toBeGreaterThanOrEqual(24 - 1e-6);
    expect(drawn.bottom).toBeLessThanOrEqual(CANVAS.height - 24 + 1e-6);
  });
});

describe("the faces the policy is held to are the ones on screen", () => {
  it("knows the node label of every typeface the estimator has a table for", () => {
    expect(NODE_LABEL_FACES.map((label) => label.face).sort()).toEqual([...FACES].sort());
  });

  it("states the sizes the stylesheet draws node labels at", () => {
    // The numbers are only a derivation if they are the ones on screen.
    const rules = rulesOf(readStylesheet());
    const fontSize = (selector: string): number => {
      const value = rules
        .filter((candidate) => candidate.selectors.includes(selector))
        .flatMap((rule) => declarationsOf(rule.body))
        .find(([property]) => property === "font-size")?.[1];
      expect(value, `${selector} { font-size }`).toBeDefined();
      return Number.parseFloat(throughTokens(readStylesheet(), value!));
    };
    for (const label of NODE_LABEL_FACES) {
      expect(label.fontPx, `${label.face} node label size`).toBe(fontSize(".archer-node"));
    }
  });

  it("does not let a fit nobody asked for go below the explicit fit's floor", () => {
    expect(NO_ZOOM_FLOOR).toBe(0);
    expect(ALL.min).toBe(NO_ZOOM_FLOOR);
  });
});

describe("saying what a framing left outside the canvas", () => {
  // The floor means an automatic fit can leave part of a big diagram off
  // screen, and until now nothing on screen said so: the reader was shown the
  // first two thirds of a graph as if it were the graph.
  const canvas: Size = { width: 1000, height: 600 };
  // Eight 100x40 boxes in a row, 200 apart: centres at 50, 250, ... 1450.
  const row: Box[] = Array.from({ length: 8 }, (_, i) => ({ x: i * 200, y: 100, width: 100, height: 40 }));
  const content: Box = { x: 0, y: 100, width: 1500, height: 40 };
  const items = { across: row, down: row };

  it("says nothing when the whole diagram is in view", () => {
    expect(overflowOf(content, items, { x: 24, y: 24, zoom: 0.5 }, canvas)).toEqual([]);
  });

  it("counts what lies past an edge, on the side it lies", () => {
    // Centres land at 74, 274, 474, 674, 874 | 1074, 1274, 1474.
    expect(overflowOf(content, items, { x: 24, y: 24, zoom: 1 }, canvas)).toEqual([{ side: "right", count: 3 }]);
  });

  it("counts each side on its own", () => {
    // Centres at -450, -250, -50 | 150 ... 950: three off the left, and the
    // content's right edge now lands exactly on the canvas's.
    expect(overflowOf(content, items, { x: -500, y: 24, zoom: 1 }, canvas)).toEqual([{ side: "left", count: 3 }]);
    // Panned to the middle, it continues both ways.
    expect(overflowOf(content, items, { x: -250, y: 24, zoom: 1 }, canvas)).toEqual([
      { side: "left", count: 1 },
      { side: "right", count: 1 },
    ]);
  });

  it("counts by the middle of a thing: half a node in view is a node the reader can see", () => {
    // The sixth box spans 990..1089 on screen: cut, and its middle (1039.5) is out.
    expect(overflowOf(content, items, { x: 0, y: 24, zoom: 0.99 }, canvas)).toEqual([{ side: "right", count: 3 }]);
    // A little smaller it spans 940..1034: still cut, but its middle (987) is
    // in view, and it is no longer counted.
    expect(overflowOf(content, items, { x: 0, y: 24, zoom: 0.94 }, canvas)).toEqual([{ side: "right", count: 2 }]);
  });

  it("still names a side where only the edge of something is cut off", () => {
    // Two boxes; the second runs 30px past the right edge, its middle in view.
    const pair: Box[] = [
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 930, y: 0, width: 100, height: 40 },
    ];
    const bounds: Box = { x: 0, y: 0, width: 1030, height: 40 };
    expect(overflowOf(bounds, { across: pair, down: pair }, { x: 0, y: 0, zoom: 1 }, canvas)).toEqual([
      { side: "right", count: 0 },
    ]);
  });

  it("does not call a sub-pixel overhang content", () => {
    const bounds: Box = { x: 0, y: 0, width: 1000.4, height: 600.4 };
    expect(overflowOf(bounds, { across: [], down: [] }, { x: 0, y: 0, zoom: 1 }, canvas)).toEqual([]);
  });

  it("counts columns for left and right and rows for above and below", () => {
    // A sequence diagram: participants are its columns, messages its rows. A
    // message between two participants that are off to the right is not a
    // thing "to the right"; a participant header is not a thing "below".
    const participants: Box[] = [0, 400, 800, 1200].map((x) => ({ x, y: 0, width: 120, height: 40 }));
    const messages: Box[] = Array.from({ length: 30 }, (_, i) => ({ x: 60, y: 80 + i * 44, width: 1200, height: 30 }));
    const bounds: Box = { x: 0, y: 0, width: 1320, height: 80 + 30 * 44 };
    expect(overflowOf(bounds, { across: participants, down: messages }, { x: 20, y: 20, zoom: 1 }, canvas)).toEqual([
      // 1200 + 60 + 20 = 1280: the fourth participant.
      { side: "right", count: 1 },
      // Rows are centred at 115 + 44i; the first past 600 is i = 12.
      { side: "bottom", count: 18 },
    ]);
  });

  it("lists the sides in one order, so a redraw does not shuffle them", () => {
    // Zoomed far in on the middle of the row: it runs off all four sides.
    const sides = overflowOf(content, items, { x: -250, y: -2100, zoom: 20 }, canvas).map((entry) => entry.side);
    expect(sides).toEqual(["left", "right", "top", "bottom"]);
  });

  it.each([
    [{ side: "right", count: 6 }, "6 more to the right"],
    [{ side: "left", count: 1 }, "1 more to the left"],
    [{ side: "top", count: 3 }, "3 more above"],
    [{ side: "bottom", count: 12 }, "12 more below"],
    [{ side: "right", count: 0 }, "More to the right"],
    [{ side: "left", count: 0 }, "More to the left"],
    [{ side: "top", count: 0 }, "More above"],
    [{ side: "bottom", count: 0 }, "More below"],
  ] as const)("says %j in plain words: %s", (overflow, words) => {
    expect(overflowText(overflow)).toBe(words);
  });
});

describe("fit reserves the legend's corner", () => {
  it("leaves the plain gutter on every side when there is no legend", () => {
    expect(fitPadding(CANVAS, false)).toEqual({
      top: FIT_GUTTER_PX,
      right: FIT_GUTTER_PX,
      bottom: FIT_GUTTER_PX,
      left: FIT_GUTTER_PX,
    });
  });

  it("pads the fit away from the corner the legend occupies", () => {
    const padding = fitPadding(CANVAS, true);
    // Reserved on the legend's two sides, and by more than the others get:
    // this is the corner the panel rests in, beside the toolbar (bottom left).
    expect(padding.left).toBeGreaterThan(padding.right);
    expect(padding.bottom).toBeGreaterThan(padding.top);
    // The panel is up to 300px wide and sits 14px in from the corner.
    expect(padding.left).toBeGreaterThanOrEqual(314);
  });

  it("keeps the framed graph out from under the legend", () => {
    const content: Box = { x: 0, y: 0, width: 900, height: 500 };
    const padding = fitPadding(CANVAS, true);
    const drawn = onScreen(content, frameViewport(content, CANVAS, padding, READ));
    expect(drawn.left).toBeGreaterThanOrEqual(314);
    expect(drawn.bottom).toBeLessThanOrEqual(CANVAS.height - padding.bottom + 1e-6);
  });

  it("never reserves so much of a narrow canvas that nothing is left to draw in", () => {
    const phone: Size = { width: 420, height: 640 };
    const padding = fitPadding(phone, true);
    expect(phone.width - padding.left - padding.right).toBeGreaterThanOrEqual(phone.width / 2);
    expect(phone.height - padding.top - padding.bottom).toBeGreaterThanOrEqual(phone.height / 2);
  });
});

describe("what a fit frames", () => {
  const layout: LayoutResult = {
    width: 0,
    height: 0,
    nodes: [
      { id: "a", x: 100, y: 100, width: 180, height: 60, label: "A", shape: undefined, classes: [], groupId: "g" },
      {
        id: "b",
        x: 100,
        y: 300,
        width: 180,
        height: 60,
        label: "B",
        shape: undefined,
        classes: [],
        groupId: undefined,
      },
    ],
    groups: [{ id: "g", label: "Group", parentId: undefined, x: 80, y: 52, width: 220, height: 128 }],
    edges: [
      {
        id: "e",
        source: "a",
        target: "b",
        label: "loops round",
        // Routed out to the right of both nodes, the way a back edge is.
        points: [
          { x: 190, y: 160 },
          { x: 400, y: 160 },
          { x: 400, y: 300 },
          { x: 190, y: 300 },
        ],
        labelAnchor: { x: 380, y: 220, width: 90, height: 20 },
      },
    ],
  };

  it("includes wires and captions that run outside every node", () => {
    const bounds = layoutBounds(layout)!;
    // React Flow's own fit measures nodes only, and clipped these.
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(470);
  });

  it("includes group frames, whose captions are inside them", () => {
    const bounds = layoutBounds(layout)!;
    expect(bounds.x).toBeLessThanOrEqual(80);
    expect(bounds.y).toBeLessThanOrEqual(52);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(360);
  });

  it("frames just the named nodes for a focused fit", () => {
    expect(layoutBounds(layout, ["b"])).toEqual({ x: 100, y: 300, width: 180, height: 60 });
  });

  it("names the first layer as where reading the graph starts", () => {
    expect(entryBox(layout)).toEqual({ x: 100, y: 100, width: 180, height: 60 });
    // Two nodes side by side in the first layer are one entry, not a tie.
    const twoRoots: LayoutResult = {
      ...layout,
      nodes: [...layout.nodes, { ...layout.nodes[0], id: "c", x: 400, y: 110 }],
    };
    expect(entryBox(twoRoots)).toEqual({ x: 100, y: 100, width: 480, height: 70 });
    expect(entryBox({ width: 0, height: 0, nodes: [], groups: [], edges: [] })).toBeNull();
  });

  it("has nothing to frame for an empty graph or for ids that are not in it", () => {
    expect(layoutBounds({ width: 0, height: 0, nodes: [], groups: [], edges: [] })).toBeNull();
    expect(layoutBounds(layout, ["nope"])).toBeNull();
  });
});

// A fixed chrome shelf can leave a drawing just short of fitting. Automatic
// framing must retain the reading floor; only Show all may shrink below it.
describe("reading floor in a reduced viewport", () => {
  it.each(NOTATIONS)("%s: a near fit still honors the supplied reading minimum", (notation) => {
    const range = readingZoom(notation);
    const canvas = { width: 1440, height: 500 };
    const content = { x: 0, y: 0, width: 400, height: 500 / (range.min * 0.95) };
    const padding = { top: 0, right: 0, bottom: 0, left: 0 };
    const frame = frameViewport(content, canvas, padding, range);
    expect(frame.zoom).toBe(range.min);
    expect(smallestOnScreen(notation, frame.zoom)).toBeCloseTo(12, 9);
    expect(onScreen(content, frame).bottom).toBeGreaterThan(canvas.height);
    const overview = frameViewport(content, canvas, padding, showAllZoom(range));
    expect(onScreen(content, overview).bottom).toBeCloseTo(canvas.height, 9);
  });
});

describe("framing a graph that overflows only into the gutter at its reading size (review 2026-11-13, D)", () => {
  // The heartbeat at 1440x900: at the reading floor it is 22px taller than the room inside the gutter, but 26px
  // shorter than the canvas. Started at the top gutter, its last node sat 2px from the canvas's bottom edge.
  const canvas: Size = { width: 1025, height: 796 };
  const content: Box = { x: 12, y: 12, width: 560, height: (canvas.height - 48 + 22) / READ.min };

  it("shares what it lacks between the two gutters, so neither edge is touched", () => {
    const frame = frameViewport(content, canvas, GUTTER, READ);
    const drawn = onScreen(content, frame);
    expect(frame.zoom).toBeCloseTo(READ.min, 6);
    expect(drawn.top).toBeCloseTo(13, 6);
    expect(canvas.height - drawn.bottom).toBeCloseTo(13, 6);
  });

  it("takes nothing from a side that holds chrome: the heading's band stays whole", () => {
    const frame = frameViewport(content, canvas, { ...GUTTER, top: 44 }, READ);
    expect(onScreen(content, frame).top).toBeCloseTo(44, 6);
  });

  it("leaves a drawing that runs off the canvas framed from its start", () => {
    const long: Box = { ...content, height: content.height * 2 };
    expect(onScreen(long, frameViewport(long, canvas, GUTTER, READ)).top).toBeCloseTo(24, 6);
  });
});
