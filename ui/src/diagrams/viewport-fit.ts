/**
 * Where the camera goes when the canvas frames a graph.
 *
 * This used to be React Flow's `fitView`, and it did not fit. `fitView` clamps
 * to the flow's minimum zoom -- 0.5 unless told otherwise -- and then centres
 * the bounds, so a graph that needed 0.38 to fit was drawn at 0.5 with its
 * first and its last layer both outside the canvas, and nothing on screen said
 * there was more. It also measures nodes only, so a wire routed round the
 * outside of the graph, or a group caption, was clipped even when the zoom was
 * not clamped.
 *
 * The decision is made here instead, as pure functions of the layout and the
 * canvas box, and applied with `setViewport`.
 */
import type { LayoutResult } from "../layout/elk-adapter";
import { FRAME_CAPTION_FONT_PX } from "../layout/captions";
import { C4_TEXT_FONT_PX, C4_TYPE_FONT_PX, ER_ROW_FONT_PX, NOTE_FONT_PX } from "../layout/figure-metrics";
import { graphFontPx } from "../layout/graph-metrics";
import {
  FRAGMENT_FONT,
  MESSAGE_FONT,
  NOTE_FONT as SEQUENCE_NOTE_FONT,
  PARTICIPANT_FONT,
} from "../layout/sequence-layout";
import { DEFAULT_TYPEFACE, type TypefaceId } from "../layout/text-measure";
import type { GraphNotation } from "./figures";

import type { Box, Overflow, ZoomRange } from "../../../shared/layout-analysis.mts";
export type { Box, Size, Padding, Overflow, ZoomRange } from "../../../shared/layout-analysis.mts";
export type { Frame } from "../../../shared/viewport.mts";
export {
  fitPadding,
  FIT_GUTTER_PX,
  frameViewport,
  overflowOf,
  NO_OVERFLOW,
  READING_TEXT_PX,
} from "../../../shared/viewport.mts";
export type Side = Overflow["side"];

/** A node label as the page draws it, in one typeface. */
export type LabelFace = {
  readonly face: TypefaceId;
  readonly fontPx: number;
};

/**
 * The node label, at the stylesheet's own size (`.archer-node`), which
 * `viewport-fit.test.ts` checks. What decides whether an overview is too
 * small to make out at all (`tooSmallToRead`). A list, so a second face is a
 * second entry rather than a second rule.
 */
export const NODE_LABEL_FACES: readonly LabelFace[] = [{ face: "fira", fontPx: 14 }];

/**
 * THE FRAMING POLICY: one for every notation drawn under a camera.
 *
 * An automatic framing -- a diagram opening, the host asking again, the
 * canvas resizing under a camera nobody has moved -- draws the SMALLEST text
 * the notation sets for its reader at `min` to `max` screen pixels:
 *
 *   1. it fits the whole drawing;
 *   2. it never magnifies past `max` to fill the canvas (a five-service
 *      architecture opened at 1.38, its labels at 19px beside a flowchart's
 *      at 9.8px: review of 2026-10-04);
 *   3. it never shrinks past `min`: a drawing that does not fit there is
 *      framed from its entry -- the first layer, the first participant -- and
 *      the off-screen cue says what is left out.
 *
 * Twelve pixels is the smallest size body text is set at that reads without
 * effort; thirteen is the top of the band, so whatever room a canvas has,
 * every notation's smallest text lands within a pixel of every other's. The
 * explicit fit (Fit view, `1`, the off-screen cue's "Show all") keeps the
 * ceiling and has no floor: asking to fit is asking to see all of it, and the
 * canvas says when that is too small to read (`showAllZoom`; AM-R1-02, the
 * decided 2026-10-31: the type floor round 1 put under Fit left drawings cut at
 * the docked key's edge).
 */
import { READING_TEXT_PX } from "../../../shared/viewport.mts";

/** The notations framed by a camera: the graph's five, and the sequence. */
export type ReadingNotation = GraphNotation | "sequence";

/** One kind of text a notation draws for its reader, at its size at zoom 1. */
export type ReadingFace = { readonly what: string; readonly px: number };

/**
 * The text each notation draws FOR ITS READER: names, relationships,
 * conditions, descriptions -- what the diagram is read for. Marks that repeat
 * what a shape already says (an ER key chip, a state's start or end word, a
 * fragment's `alt` chip, a message number) are not what a framing is held to,
 * so they are set no smaller than their notation's smallest reading face:
 * where Fit stops they too reach `TYPE_FLOOR_PX` (`round1-verify.test.tsx`).
 *
 * The sizes are the layout's own constants, which the stylesheet and the
 * figures draw at (`text-metrics-unified.test.ts`, `viewport-fit.test.ts`).
 */
export function readingFaces(
  notation: ReadingNotation,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
): readonly ReadingFace[] {
  const graph = graphFontPx(typeface);
  const frame: ReadingFace = { what: "frame caption", px: FRAME_CAPTION_FONT_PX };
  switch (notation) {
    case "flowchart":
      return [{ what: "node label", px: graph.nodeLabel }, { what: "edge caption", px: graph.caption }, frame];
    case "state":
      return [
        { what: "state name", px: graph.nodeLabel },
        { what: "transition caption", px: graph.caption },
        { what: "note", px: NOTE_FONT_PX },
        frame,
      ];
    case "er":
      return [
        { what: "entity name", px: graph.nodeLabel },
        { what: "attribute row", px: ER_ROW_FONT_PX },
        { what: "relationship caption", px: graph.caption },
      ];
    case "c4":
      return [
        { what: "element name", px: graph.nodeLabel },
        { what: "type and technology", px: C4_TYPE_FONT_PX },
        { what: "description", px: C4_TEXT_FONT_PX },
        { what: "relationship caption", px: graph.caption },
        frame,
      ];
    case "architecture":
      return [{ what: "service name", px: graph.nodeLabel }, { what: "edge caption", px: graph.caption }, frame];
    case "sequence":
      return [
        { what: "participant", px: PARTICIPANT_FONT },
        { what: "message", px: MESSAGE_FONT },
        { what: "fragment condition", px: FRAGMENT_FONT },
        { what: "note", px: SEQUENCE_NOTE_FONT },
      ];
  }
}

/** The zooms a framing may choose between. */

/**
 * The zooms at which `notation`'s smallest reading text is drawn at
 * `READING_TEXT_PX.min` to `.max` on screen: what an automatic framing keeps
 * to.
 */
export function readingZoom(notation: ReadingNotation, typeface: TypefaceId = DEFAULT_TYPEFACE): ZoomRange {
  const smallest = Math.min(...readingFaces(notation, typeface).map((face) => face.px));
  return { min: READING_TEXT_PX.min / smallest, max: READING_TEXT_PX.max / smallest };
}

/** An explicit fit of everything: as small as that takes, never past reading size. */
export function showAllZoom(reading: ZoomRange): ZoomRange {
  return { min: NO_ZOOM_FLOOR, max: reading.max };
}

/**
 * `--type-floor` in `styles.css`, in px: the smallest text the page sets (`round1-f1.test.tsx` reads it back).
 */
export const TYPE_FLOOR_PX = 11;

/** Whether `range` is an explicit fit's: one with no floor. */
export function showsEverything(range: ZoomRange): boolean {
  return range.min === NO_ZOOM_FLOOR;
}

/**
 * How far the user may zoom out BY HAND -- wheel, pinch, the zoom buttons.
 *
 * Not how far an explicit fit may go: see `NO_ZOOM_FLOOR`. After a fit that
 * went below this, the hand-zoom limit drops to where the fit landed
 * (`handZoomFloor`), so zooming out from there never jumps back up to it.
 */
export const CANVAS_MIN_ZOOM = 0.1;

/**
 * How far an EXPLICIT fit may go -- "Fit view", `1`, and the cue's "Show all":
 * as far as the drawing needs. There is no floor (AM-R1-02).
 *
 * Those controls say they show everything, so they do. They have stopped
 * short twice. First at `CANVAS_MIN_ZOOM`, where a sixteen-node chain in a
 * 420px window (which needs 0.07) was left with five nodes off screen. Then at
 * a constant of 0.01, chosen because "at a hundredth a 5,000px graph is 50px
 * and there is nothing left to see by going further" -- and a 200-node chain,
 * which is 40,000px long and needs 0.0093, was left with twenty off screen
 * while the cue went on offering to show all (adversarial review 2026-10-02,
 * F7).
 *
 * Any constant is wrong for some drawing, because what is supported is
 * bounded by the SOURCE, not by a size: a registered file may be 256 KiB
 * (`MAX_SOURCE_BYTES`). A chain costs about twenty bytes a link (a node and
 * the edge to it), so that is some 12,000 nodes in a line, about two million
 * pixels, which needs a zoom near 0.0002 in a phone-width window; a sequence
 * diagram of 256 KiB is some 29,000 messages and over a million pixels tall.
 * So the minimum is the one the drawing itself implies, `room / extent`, and
 * `frameViewport` is handed this to say "do not stop".
 *
 * What an overview that small cannot do is be read. That is said, not hidden:
 * `tooSmallToRead` decides it and the canvas offers the way back.
 */
export const NO_ZOOM_FLOOR = 0;

/**
 * The size, in device pixels, below which a node label cannot be made out.
 *
 * The other end of the scale from `READING_TEXT_PX`. Measured on 2026-10-01
 * in headless Chromium at device pixel ratio 1: at a zoom of 0.50 -- labels at
 * 7px for a 14px label -- "a node label can be deciphered and
 * nothing else can". So 6.5px is the last size at which the page can say the
 * labels are there to be read by someone who tries; below it they are marks.
 */
export const MIN_DECIPHERABLE_LABEL_PX = 6.5;

/**
 * Whether a drawing framed at `zoom` is too small to read.
 *
 * An explicit fit that lands here has done what it promised -- everything is
 * in view -- and the page owes the reader the other half of the truth: none
 * of it can be read at this size.
 */
export function tooSmallToRead(zoom: number): boolean {
  return NODE_LABEL_FACES.some((label) => label.fontPx * zoom < MIN_DECIPHERABLE_LABEL_PX);
}

/** The smallest zoom that is not `tooSmallToRead`: below it the nested view's controls hide (`NestToggles.tsx`). */
export function readableFloorZoom(): number {
  return Math.max(...NODE_LABEL_FACES.map((label) => MIN_DECIPHERABLE_LABEL_PX / label.fontPx));
}

/**
 * The hand-zoom limit while the camera is at `framedZoom`, the zoom a framing
 * chose: the ordinary minimum, or the framing's own zoom when an explicit fit
 * took it lower. Without it "zoom out" from a fit at 0.07 clamps UP to 0.1.
 */
export function handZoomFloor(framedZoom: number): number {
  return Math.min(CANVAS_MIN_ZOOM, framedZoom);
}
/** React Flow's own default, restated because the fit has to respect it. */
export const CANVAS_MAX_ZOOM = 2;

const WHERE: Readonly<Record<Side, string>> = {
  left: "to the left",
  right: "to the right",
  top: "above",
  bottom: "below",
};

/** One side's overflow in plain words: "6 more to the right", "More below". */
export function overflowText(overflow: Overflow): string {
  return overflow.count === 0 ? `More ${WHERE[overflow.side]}` : `${overflow.count} more ${WHERE[overflow.side]}`;
}

/** Whether two overflows say the same thing, so state need not change. */
export function sameOverflow(a: readonly Overflow[], b: readonly Overflow[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry.side === b[i].side && entry.count === b[i].count);
}

/**
 * Where reading the graph starts: the first layer.
 *
 * The first layer is at the upstream end of the flow -- the top for `tb`, the
 * bottom for `bt`, the left for `lr`, the right for `rl` -- so it is every
 * node that overlaps, along the flow axis, the one furthest upstream. It is
 * what a fit keeps in view when the whole graph cannot be: on a narrow canvas
 * the first layer sits centred over a graph wider than the screen, and
 * starting at the graph's left edge showed a column with no first node in it.
 * A graph that flows upwards and is framed from its top would open on its
 * LAST layer, which is the same mistake turned over.
 */
export function entryBox(layout: LayoutResult): Box | null {
  type Placed = LayoutResult["nodes"][number];
  const direction = layout.direction ?? "tb";
  const horizontal = direction === "lr" || direction === "rl";
  const reversed = direction === "bt" || direction === "rl";
  // A node's extent along the flow, measured so that SMALLER is further
  // upstream whichever way the graph runs.
  const span = (node: Placed): { start: number; end: number } => {
    const start = horizontal ? node.x : node.y;
    const end = start + (horizontal ? node.width : node.height);
    return reversed ? { start: -end, end: -start } : { start, end };
  };

  const first = layout.nodes.reduce<Placed | null>(
    (lead, node) => (lead === null || span(node).start < span(lead).start ? node : lead),
    null,
  );
  if (first === null) {
    return null;
  }
  const layer = layout.nodes.filter((node) => span(node).start < span(first).end);
  const left = Math.min(...layer.map((node) => node.x));
  const top = Math.min(...layer.map((node) => node.y));
  const right = Math.max(...layer.map((node) => node.x + node.width));
  const bottom = Math.max(...layer.map((node) => node.y + node.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The box a fit has to frame, in graph coordinates.
 *
 * With `nodeIds`, just those nodes (a focused fit). Without, everything that
 * is drawn: nodes, group frames (their captions are inside them), every routed wire
 * and every edge caption. `null` when there is nothing to frame.
 */
export function layoutBounds(layout: LayoutResult, nodeIds?: readonly string[]): Box | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x: number, y: number, width = 0, height = 0): void => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  };

  if (nodeIds !== undefined) {
    const wanted = new Set(nodeIds);
    for (const node of layout.nodes) {
      if (wanted.has(node.id)) {
        include(node.x, node.y, node.width, node.height);
        // A state's note hangs outside its box, and belongs to it.
        if (node.note !== undefined) include(node.note.x, node.note.y, node.note.width, node.note.height);
      }
    }
  } else {
    for (const node of layout.nodes) {
      include(node.x, node.y, node.width, node.height);
      if (node.note !== undefined) include(node.note.x, node.note.y, node.note.width, node.note.height);
    }
    for (const group of layout.groups) {
      // Its caption is inside the frame, in the band ELK kept for it.
      include(group.x, group.y, group.width, group.height);
    }
    for (const edge of layout.edges) {
      for (const point of edge.points) include(point.x, point.y);
      const caption = edge.labelAnchor;
      if (caption) include(caption.x, caption.y, caption.width, caption.height);
    }
  }

  if (left === Infinity) {
    return null;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A point on screen something lies over: a side panel, a floating control, or outside the canvas. */
export type CoveredAt = (x: number, y: number) => boolean;

/**
 * The part of `canvas` (screen px) the panel, the phone's dock sheet and the controls over it leave: the
 * longest clear run across the canvas's middle, then the longest clear run down the middle of that, then
 * across again at the middle of that. So a panel the full height of one side narrows it, a sheet over the
 * bottom (even over more than half) shortens it, and a small control in a corner does not (`revealShift`
 * steers round those). The whole canvas when nothing on the lines is clear.
 */
export function uncoveredArea(canvas: Box, covered: CoveredAt, step = 8): Box {
  const longest = (from: number, to: number, at: (t: number) => boolean): [number, number] | null => {
    // A run is from its first clear sample to just past its last: an edge is never placed past a covered sample.
    let best: [number, number] | null = null;
    let runStart: number | null = null;
    let lastClear = from;
    const samples: number[] = [];
    for (let t = from; t < to; t += step) samples.push(t);
    samples.push(to);
    for (const [i, t] of samples.entries()) {
      const clear = !at(t);
      if (clear) {
        if (runStart === null) runStart = t;
        lastClear = t;
      }
      if ((!clear || i === samples.length - 1) && runStart !== null) {
        if (best === null || lastClear + 1 - runStart > best[1] - best[0]) best = [runStart, lastClear + 1];
        runStart = null;
      }
    }
    return best;
  };
  const right = canvas.x + canvas.width - 1;
  const bottom = canvas.y + canvas.height - 1;
  let across = longest(canvas.x, right, (x) => covered(x, canvas.y + canvas.height / 2)) ?? [canvas.x, right + 1];
  const down = longest(canvas.y, bottom, (y) => covered((across[0] + across[1]) / 2, y)) ?? [canvas.y, bottom + 1];
  across = longest(canvas.x, right, (x) => covered(x, (down[0] + down[1]) / 2)) ?? across;
  return {
    x: across[0],
    y: down[0],
    width: Math.max(0, across[1] - across[0]),
    height: Math.max(0, down[1] - down[0]),
  };
}

/** Room kept round a revealed element: its focus ring (2px at 2px offset) and a little air. */
const REVEAL_MARGIN_PX = 16;
const RING_PX = 4;

/**
 * How far to pan (screen px) so `box`, with its focus ring, is in the clear: `null` when nothing covers it
 * now. The smallest move into `free` first; when a floating control would still lie over it there, its
 * middle goes to the middle of `free`.
 */
export function revealShift(box: Box, free: Box, covered: CoveredAt): { dx: number; dy: number } | null {
  // A grid over the ring's box, fine enough to catch a 40 px control and at most ~400 points.
  const outer = {
    x: box.x - RING_PX,
    y: box.y - RING_PX,
    width: box.width + 2 * RING_PX,
    height: box.height + 2 * RING_PX,
  };
  const step = Math.max(8, Math.sqrt((outer.width * outer.height) / 400));
  const along = (start: number, size: number): number[] => {
    const n = Math.max(1, Math.ceil(size / step));
    return Array.from({ length: n + 1 }, (_, i) => start + (size * i) / n);
  };
  const xs = along(outer.x, outer.width);
  const ys = along(outer.y, outer.height);
  const clear = (dx: number, dy: number): boolean => xs.every((x) => ys.every((y) => !covered(x + dx, y + dy)));
  if (clear(0, 0)) return null;
  const into = (start: number, size: number, lo: number, span: number): number => {
    let d = 0;
    if (start + size + REVEAL_MARGIN_PX > lo + span) d = lo + span - REVEAL_MARGIN_PX - (start + size);
    if (start + d < lo + REVEAL_MARGIN_PX) d = lo + REVEAL_MARGIN_PX - start;
    return d;
  };
  const dx = into(box.x, box.width, free.x, free.width);
  const dy = into(box.y, box.height, free.y, free.height);
  if (clear(dx, dy)) return { dx, dy };
  return {
    dx: free.x + free.width / 2 - (box.x + box.width / 2),
    dy: free.y + free.height / 2 - (box.y + box.height / 2),
  };
}
