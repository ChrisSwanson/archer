import { intersects } from "../geometry/rect";
/**
 * Keeping the canvas's chrome and the drawing off one another.
 *
 * Two things float over a canvas: the control cluster, fixed in the
 * bottom-left corner, and the off-screen cue, which appears when a framing
 * leaves part of the drawing out. A framing that knows about neither puts the
 * drawing under both. At 420x800 the shipped sample's sequence diagram opened
 * with the cue on a message label and the cluster on a fragment's frame and
 * two arrows (release review 2026-10-01, I1).
 *
 * Two decisions stop that, and both are here as pure functions of boxes, so
 * they can be pinned without a browser:
 *
 *   - THE FRAMING LEAVES ROOM (`frameClearOfChrome`). Where the drawing would
 *     lie under the cluster, it is framed to the right of it. Where a framing
 *     leaves part of the drawing off screen, it keeps a band free at the top
 *     for the cue that says so.
 *   - THE CUE LOOKS FOR FREE CANVAS (`placeCue`). It sits in that band when
 *     the band is free, and otherwise anywhere nothing is drawn. Only when
 *     the canvas has no free place at all does it sit on the drawing.
 *
 * Both judge by what is DRAWN -- each node, wire, caption and frame -- not by
 * the drawing's bounding box: a graph whose bounding box covers a corner very
 * often has nothing in that corner.
 *
 * The canvases measure (the cluster's box, the cue's size); this decides.
 */
import type { LayoutResult } from "../layout/elk-adapter";
import { FRAME_CAPTION_INSET, FRAME_CAPTION_LINE_PX } from "../layout/captions";
import type { SequenceLayoutResult } from "../layout/sequence-layout";
import { messageBox } from "./sequence-nav";
import type { Box, Frame, Overflow, Padding, Size } from "./viewport-fit";

import { CHROME_GAP_PX } from "../../../shared/viewport.mts";
export { CHROME_GAP_PX, HEADING_BAND_PX, withHeading } from "../../../shared/viewport.mts";

/** How far the cue sits from the canvas's edge, and its height as the stylesheet draws it. */
const CUE_INSET_PX = 10;
const CUE_HEIGHT_PX = 26;
/** Under a coarse pointer the cue is a 44 px touch target (`styles.css`, round 1 G7 [H]). */
const CUE_TOUCH_HEIGHT_PX = 44;

/**
 * The band a framing that overflows keeps free at the top of the canvas: the
 * cue's inset, its height, and the gap under it. This is the fine pointer's;
 * `cueBandPx` is the one for the pointer in use.
 */
export const CUE_BAND_PX = CUE_INSET_PX + CUE_HEIGHT_PX + CHROME_GAP_PX;

/** One line of the cue (`line-height` in `styles.css`), and the gap between wrapped lines. */
const CUE_LINE_PX = 16;
const CUE_ROW_GAP_PX = 2;
/** The cue's border, top and bottom, and a pixel of rounding. */
const CUE_FRAME_PX = 4;

/**
 * The cue's band for the pointer in use and the sides it names, read when a framing is made, so it follows a change
 * of pointer. On a phone-width canvas (`max-width: 720px` in `styles.css`) the cue is held to 220px and says each
 * side on its own line, so three sides are three lines: the band grows with them, or the wrapped cue ate the gap and
 * sat on the opening's first node (390x844, review 2026-11-12).
 */
function cueBandPx(sides = 1): number {
  const media = (query: string): boolean => typeof matchMedia === "function" && matchMedia(query).matches;
  const rows = media("(max-width: 720px)") ? Math.max(1, sides) : 1;
  const wrapped = rows * CUE_LINE_PX + (rows - 1) * CUE_ROW_GAP_PX + CUE_FRAME_PX;
  const floor = media("(pointer: coarse)") ? CUE_TOUCH_HEIGHT_PX : CUE_HEIGHT_PX;
  return CUE_INSET_PX + Math.max(floor, rows > 1 ? wrapped : 0) + CHROME_GAP_PX;
}

/** Half the width a wire, a lifeline or a frame's border is treated as having. */
const LINE_REACH = 2;

/** About how wide a frame caption's letter is, for a layout that did not place it. */
const GROUP_LABEL_CHAR_WIDTH = 8;

/** A fragment's kind chip and label sit in a header row of about this height. */
const FRAGMENT_HEADER_HEIGHT = 20;
const FRAGMENT_LABEL_CHAR_WIDTH = 7;

/** The four sides of a frame, as thin boxes: its inside is not drawn on. */
function outline(frame: Box): Box[] {
  const thick = LINE_REACH * 2;
  return [
    { x: frame.x - LINE_REACH, y: frame.y - LINE_REACH, width: frame.width + thick, height: thick },
    { x: frame.x - LINE_REACH, y: frame.y + frame.height - LINE_REACH, width: frame.width + thick, height: thick },
    { x: frame.x - LINE_REACH, y: frame.y - LINE_REACH, width: thick, height: frame.height + thick },
    { x: frame.x + frame.width - LINE_REACH, y: frame.y - LINE_REACH, width: thick, height: frame.height + thick },
  ];
}

/** The box around one straight run of a line. */
function run(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return {
    x: Math.min(a.x, b.x) - LINE_REACH,
    y: Math.min(a.y, b.y) - LINE_REACH,
    width: Math.abs(a.x - b.x) + LINE_REACH * 2,
    height: Math.abs(a.y - b.y) + LINE_REACH * 2,
  };
}

/**
 * Everything a graph draws, in graph coordinates: every node, every straight
 * run of every wire, every edge caption, and each group's frame and label.
 *
 * A group's frame is its four sides. Its inside is tinted, but a pill over a
 * tint hides nothing; a pill over its border or its label does.
 */
export function graphObstacles(layout: LayoutResult): Box[] {
  const boxes: Box[] = [];
  for (const node of layout.nodes) {
    boxes.push({ x: node.x, y: node.y, width: node.width, height: node.height });
  }
  for (const edge of layout.edges) {
    for (let i = 1; i < edge.points.length; i += 1) {
      boxes.push(run(edge.points[i - 1], edge.points[i]));
    }
    if (edge.labelAnchor !== undefined) {
      boxes.push(edge.labelAnchor);
    }
  }
  for (const group of layout.groups) {
    boxes.push(...outline(group));
    // The caption, where the layout placed it in the frame's band; a
    // hand-built layout has it at the band's home.
    boxes.push(
      group.caption ?? {
        x: group.x + FRAME_CAPTION_INSET.x,
        y: group.y + FRAME_CAPTION_INSET.y,
        width: Math.min(group.width, group.label.length * GROUP_LABEL_CHAR_WIDTH),
        height: FRAME_CAPTION_LINE_PX,
      },
    );
  }
  return boxes;
}

/**
 * Everything a sequence diagram draws, in its own coordinates: participants
 * and their lifelines, messages with their labels, notes, activation bars, and
 * each fragment's frame, dividers and header.
 */
export function sequenceObstacles(layout: SequenceLayoutResult): Box[] {
  const boxes: Box[] = [];
  const centre = new Map<string, number>();
  for (const participant of layout.participants) {
    const cx = participant.x + participant.width / 2;
    centre.set(participant.id, cx);
    boxes.push({ x: participant.x, y: participant.y, width: participant.width, height: participant.height });
    boxes.push(run({ x: cx, y: participant.y + participant.height }, { x: cx, y: layout.lifelineEndY }));
  }
  for (const message of layout.messages) {
    boxes.push(messageBox(message));
  }
  for (const note of layout.notes) {
    boxes.push({ x: note.x, y: note.y, width: note.width, height: note.height });
  }
  for (const activation of layout.activations) {
    const cx = centre.get(activation.participantId);
    if (cx !== undefined) {
      boxes.push(run({ x: cx, y: activation.startY }, { x: cx, y: activation.endY }));
    }
  }
  for (const fragment of layout.fragments) {
    boxes.push(...outline(fragment));
    boxes.push({
      x: fragment.x,
      y: fragment.y,
      width: Math.min(fragment.width, fragment.chipWidth + fragment.headerLabel.length * FRAGMENT_LABEL_CHAR_WIDTH),
      height: FRAGMENT_HEADER_HEIGHT,
    });
    for (const section of fragment.sections.slice(1)) {
      boxes.push(run({ x: fragment.x, y: section.y }, { x: fragment.x + fragment.width, y: section.y }));
    }
  }
  return boxes;
}

/** Where boxes in the drawing's own coordinates land on the canvas under a camera. */
export function drawnOn(boxes: readonly Box[], frame: Frame): Box[] {
  return boxes.map((box) => ({
    x: box.x * frame.zoom + frame.x,
    y: box.y * frame.zoom + frame.y,
    width: box.width * frame.zoom,
    height: box.height * frame.zoom,
  }));
}

/** Whether any of `boxes` shares a pixel with `rect`. */
export function hitsAny(boxes: readonly Box[], rect: Box): boolean {
  return boxes.some((box) => intersects(box, rect));
}

/**
 * Where a piece of the canvas's chrome is, as a box on the canvas: measured,
 * because its size is the stylesheet's and differs between designs.
 *
 * `null` when it is not there, when nothing has been laid out (jsdom reports
 * every box as 0x0), and when the answer cannot be a control cluster: a box
 * half as wide as the canvas is not something to frame a drawing beside, and
 * reserving it would leave no room to draw in. (A test double that answers
 * every element with the canvas's own box is the case that happens.)
 */
export function measureChrome(canvas: Element | null, piece: Element | null): Box | null {
  if (canvas === null || piece === null) {
    return null;
  }
  const outer = canvas.getBoundingClientRect();
  const inner = piece.getBoundingClientRect();
  if (inner.width === 0 || inner.height === 0 || inner.width * 2 >= outer.width) {
    return null;
  }
  return { x: inner.left - outer.left, y: inner.top - outer.top, width: inner.width, height: inner.height };
}

/** Chrome that floats over a canvas besides its control cluster: the chat button. */
const FLOATING_CHROME = ".archer-chat-fab";

/** The floating chrome over `canvas` (`FLOATING_CHROME`), each measured as `measureChrome` measures the cluster. */
export function measureFloating(canvas: Element | null): Box[] {
  if (canvas === null) return [];
  return [...canvas.ownerDocument.querySelectorAll(FLOATING_CHROME)]
    .map((piece) => measureChrome(canvas, piece))
    .filter((box): box is Box => box !== null);
}

/**
 * The compile notice's sentence, as a box on the canvas: the band at the top
 * a framing keeps free while a drawing's file does not compile.
 *
 * Its HEAD, not the whole notice: the list of problems under it can be
 * collapsed to the sentence (that is what the toggle is for), and reserving
 * a list sixty per cent of the stage tall would leave the drawing no room.
 * Measured like the controls, but as a band: it may be as wide as the
 * canvas, and only a band taller than a third of it is refused.
 */
export function measureNotice(canvas: Element | null): Box | null {
  if (canvas === null) return null;
  const shell = canvas.closest(".archer-stage, .archer-mcp-shell");
  const head = shell?.querySelector(".archer-compile-notice-head") ?? null;
  if (head === null) return null;
  const outer = canvas.getBoundingClientRect();
  const inner = head.getBoundingClientRect();
  if (inner.width === 0 || inner.height === 0 || inner.height * 3 >= outer.height) return null;
  return { x: inner.left - outer.left, y: inner.top - outer.top, width: inner.width, height: inner.height };
}

/** A framing, with what it left off screen and the room it was framed into. */
export type ClearFraming<F> = {
  readonly frame: F;
  readonly overflow: readonly Overflow[];
  readonly padding: Padding;
};

/** The most of an axis the framing gives up to clear one piece of floating chrome. */
const CHROME_RESERVE_MAX_SHARE = 0.4;

type Side = keyof Padding;
const SIDES: readonly Side[] = ["left", "right", "top", "bottom"];

/**
 * The sides of `canvas` that would keep `piece` (both in canvas coordinates) clear of what is framed inside the
 * padding, and what each needs: cheapest first, a side's cost being what it takes beyond `padding` as a share of its
 * axis. None when the piece is not over the canvas.
 */
function clearances(padding: Padding, canvas: Size, piece: Box): { side: Side; need: number; cost: number }[] {
  const right = piece.x + piece.width;
  const bottom = piece.y + piece.height;
  if (
    piece.width <= 0 ||
    piece.height <= 0 ||
    right <= 0 ||
    piece.x >= canvas.width ||
    bottom <= 0 ||
    piece.y >= canvas.height
  ) {
    return [];
  }
  const needs: Record<Side, number> = {
    left: right + CHROME_GAP_PX,
    right: canvas.width - piece.x + CHROME_GAP_PX,
    top: bottom + CHROME_GAP_PX,
    bottom: canvas.height - piece.y + CHROME_GAP_PX,
  };
  const axis = (side: Side): number => Math.max(1, side === "left" || side === "right" ? canvas.width : canvas.height);
  return SIDES.map((side) => ({
    side,
    need: needs[side],
    cost: Math.max(0, needs[side] - padding[side]) / axis(side),
  })).sort((a, b) => a.cost - b.cost);
}

type Edges = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

/**
 * `padding` widened so a frame stays clear of the chrome floating over the canvas (the tool rail, the chat button):
 * each piece reserves the one side of the canvas that costs the least of its room. Without it QoS step 2 framed
 * "Concorde Queue" under the tool rail and "Coach Queue" against the chat button (rendered review, 2026-11-13).
 * `canvas` and `chrome` are screen rectangles; chrome outside the canvas is ignored. The walkthrough's follow camera
 * frames with it (`walk-camera.ts`); the canvas's own framings use `frameClearOfChrome`, which also checks the side
 * it takes clears the piece.
 */
export function clearOfChrome(padding: Padding, canvas: Edges, chrome: readonly Edges[]): Padding {
  const out: { -readonly [S in Side]: number } = { ...padding };
  const size = { width: canvas.right - canvas.left, height: canvas.bottom - canvas.top };
  for (const piece of chrome) {
    const box = {
      x: piece.left - canvas.left,
      y: piece.top - canvas.top,
      width: piece.right - piece.left,
      height: piece.bottom - piece.top,
    };
    const cheapest = clearances(out, size, box)[0];
    if (cheapest !== undefined) out[cheapest.side] = Math.max(out[cheapest.side], cheapest.need);
  }
  return out;
}

/**
 * Frames a drawing with room left for the chrome it would otherwise be under.
 *
 * `frameWith` is the canvas's own framing for a given padding, so this does
 * not care whether the camera is a graph viewport or a sequence pan and zoom.
 * Starting from `base`, it adds:
 *
 *   - the cue's band at the top, when the framing leaves anything off screen
 *     or the cue has its other thing to say (`cueFor`);
 *   - room beside each piece of floating chrome -- the control cluster, the
 *     chat button -- that something would be drawn under: the side that costs
 *     the least room and does move the drawing off it. For the cluster, one
 *     button wide and five tall, that is its right. A side that would not
 *     clear it is passed over: a drawing held at its reading size and running
 *     off the bottom does not move for room kept at the bottom (review
 *     2026-11-13: Fit view drew the grid's last box under the chat button).
 *
 * Each reservation changes the room, and so can call for the other -- less
 * width can push a drawing past the readable floor, and a band at the top can
 * push it down into the corner -- so it frames again until nothing more is
 * asked for. Padding only ever grows.
 *
 * It cannot always succeed, and does not pretend to: a drawing that runs off
 * the LEFT of the canvas at the readable floor is under the cluster whatever
 * room is left, and a pan resolves it.
 */
export function frameClearOfChrome<F>(options: {
  readonly base: Padding;
  /** The control cluster's box on the canvas, or `null` when there is none to measure. */
  readonly controls: Box | null;
  /** Other chrome floating over the canvas (the chat button), as boxes on it. Judged as the cluster is. */
  readonly floating?: readonly Box[];
  /** The canvas's size: without it only the room to the cluster's right is ever kept, and `floating` is not judged. */
  readonly canvas?: Size;
  /** The compile notice's sentence on the canvas (`measureNotice`), when a notice is up. */
  readonly notice?: Box | null;
  readonly frameWith: (padding: Padding) => F;
  readonly overflowOf: (frame: F) => readonly Overflow[];
  /** Whether anything drawn under `frame` shares a pixel with `rect`. */
  readonly hits: (frame: F, rect: Box) => boolean;
  /**
   * Whether the cue will be up over `frame` for a reason other than overflow:
   * an explicit fit that shows everything too small to read says so there.
   * It needs the same band, or it sits on the drawing it is describing.
   */
  readonly cueFor?: (frame: F) => boolean;
}): ClearFraming<F> {
  const { base, controls, notice, frameWith, overflowOf, hits, cueFor, canvas } = options;
  const pieces = [
    ...(controls !== null && controls.width > 0 && controls.height > 0 ? [{ box: controls, cluster: true }] : []),
    ...(options.floating ?? []).map((box) => ({ box, cluster: false })),
  ];
  let padding = base;
  let frame = frameWith(padding);
  let overflow = overflowOf(frame);

  for (let pass = 0; pass < 3 + pieces.length; pass += 1) {
    let next = padding;
    const band = cueBandPx(overflow.length);
    if ((overflow.length > 0 || cueFor?.(frame) === true) && next.top < band) {
      next = { ...next, top: band };
    }
    // The notice's sentence sits over the drawing's top-left corner, where a
    // drawing that does not fit opens: framed below it when something would be under it.
    if (notice !== undefined && notice !== null) {
      const below = notice.y + notice.height + CHROME_GAP_PX;
      if (next.top < below && hits(frame, notice)) {
        next = { ...next, top: below };
      }
    }
    for (const { box, cluster } of pieces) {
      if (!hits(frame, box)) continue;
      const options =
        canvas === undefined
          ? cluster
            ? [{ side: "left" as const, need: box.x + box.width + CHROME_GAP_PX }]
            : []
          : clearances(next, canvas, box).filter(
              (option) =>
                option.need <=
                CHROME_RESERVE_MAX_SHARE *
                  (option.side === "left" || option.side === "right" ? canvas.width : canvas.height),
            );
      const open = options.filter((option) => next[option.side] < option.need);
      if (open.length === 0) continue;
      const clears = open.find((option) => !hits(frameWith({ ...next, [option.side]: option.need }), box));
      // The cluster keeps its room even where no side clears it: a pan from there reaches what is under it.
      const taken = clears ?? (cluster ? open[0] : undefined);
      if (taken !== undefined) next = { ...next, [taken.side]: taken.need };
    }
    if (next === padding) {
      break;
    }
    padding = next;
    frame = frameWith(padding);
    overflow = overflowOf(frame);
  }
  return { frame, overflow, padding };
}

/** Which end of the top band the cue prefers: the edge the drawing runs past. */
export type CueAlign = "left" | "center" | "right";

/** How far apart the places tried are, once the band has failed. */
const SEARCH_STEP_PX = 12;
/** The clear margin a place needs around the cue to count as free. */
const CUE_CLEARANCE_PX = 4;

/**
 * Where the cue goes: `left` and `top` of a bar of size `bar` on `canvas`,
 * given everything it must not cover (`blocked`: the drawing as framed, and
 * the canvas's other chrome).
 *
 * In order: its own end of the top band; the band's other positions; then the
 * free place nearest to where it wanted to be, anywhere on the canvas. If
 * there is none it takes its usual place -- a canvas with no free pixel is
 * covered whatever is done, and a cue that is where it always is can at least
 * be found.
 */
export function placeCue(
  bar: Size,
  canvas: Size,
  align: CueAlign,
  blocked: readonly Box[],
  /** Chrome stays readable even when the drawing leaves no completely free spot. */
  chrome: readonly Box[] = [],
): { left: number; top: number } {
  const maxLeft = Math.max(0, canvas.width - bar.width);
  const maxTop = Math.max(0, canvas.height - bar.height);
  const clampLeft = (left: number): number => Math.min(maxLeft, Math.max(0, left));
  const inset = Math.min(14, maxLeft / 2);
  const lefts: Record<CueAlign, number> = {
    left: clampLeft(inset),
    center: clampLeft((canvas.width - bar.width) / 2),
    right: clampLeft(canvas.width - bar.width - inset),
  };
  const top = Math.min(CUE_INSET_PX, maxTop);
  const preferred = { left: lefts[align], top };

  const free = (spot: { left: number; top: number }, obstacles = blocked): boolean =>
    !hitsAny(obstacles, {
      x: spot.left - CUE_CLEARANCE_PX,
      y: spot.top - CUE_CLEARANCE_PX,
      width: bar.width + CUE_CLEARANCE_PX * 2,
      height: bar.height + CUE_CLEARANCE_PX * 2,
    });

  if (free(preferred)) {
    return preferred;
  }
  // Along the band: the other two usual positions, then every step of it.
  const others: CueAlign[] = align === "center" ? ["right", "left"] : ["center", align === "right" ? "left" : "right"];
  for (const other of others) {
    const spot = { left: lefts[other], top };
    if (free(spot)) {
      return spot;
    }
  }

  // Anywhere: the free place nearest the preferred one. Vertical distance
  // counts double, so the cue stays near the top of the canvas when it can.
  let best: { left: number; top: number } | null = null;
  let bestCost = Infinity;
  for (let y = Math.min(CUE_CLEARANCE_PX, maxTop); y <= maxTop; y += SEARCH_STEP_PX) {
    for (let x = Math.min(CUE_CLEARANCE_PX, maxLeft); x <= maxLeft; x += SEARCH_STEP_PX) {
      const cost = Math.abs(x - preferred.left) + Math.abs(y - preferred.top) * 2;
      if (cost >= bestCost) {
        continue;
      }
      const spot = { left: x, top: y };
      if (free(spot)) {
        best = spot;
        bestCost = cost;
      }
    }
  }
  if (best !== null) return best;
  if (free(preferred, chrome)) return preferred;
  // A dense drawing may leave no free spot. Never put the cue back on a
  // heading or control when another position leaves the chrome readable.
  for (let y = Math.min(CUE_CLEARANCE_PX, maxTop); y <= maxTop; y += SEARCH_STEP_PX) {
    for (let x = Math.min(CUE_CLEARANCE_PX, maxLeft); x <= maxLeft; x += SEARCH_STEP_PX) {
      const cost = Math.abs(x - preferred.left) + Math.abs(y - preferred.top) * 2;
      if (cost >= bestCost) continue;
      const spot = { left: x, top: y };
      if (free(spot, chrome)) {
        best = spot;
        bestCost = cost;
      }
    }
  }
  return best ?? preferred;
}
