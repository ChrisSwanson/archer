/**
 * Where a group's caption goes: inside its frame, in a band the layout keeps
 * for it, at a place no wire, arrowhead or edge caption crosses.
 *
 * Every frame -- a flowchart subgraph, a composite state, a C4 boundary, an
 * architecture group -- is named by a caption. It used to be drawn ABOVE the
 * frame, outside the box ELK sized, so ELK routed wires straight through it:
 * in the shop platform's architecture an arrow ran along "Data tier" and two
 * arrowheads landed on it (review of 2026-10-04).
 *
 * Two decisions fix that, and both are made here:
 *   - THE BAND IS RESERVED IN ELK'S INPUT. A frame's top padding is the
 *     caption's height plus room under it for an arrowhead coming into the
 *     frame's first row (`FRAME_CAPTION_BAND_PX`), and its minimum width is
 *     the caption's (`frameMinimumWidth`), so a long name never outgrows its
 *     frame.
 *   - THE CAPTION IS PLACED IN THE BAND AFTER ROUTING (`placeCaption`). A
 *     wire entering the frame from above still crosses the band on its way to
 *     the first row; the caption takes the leftmost run of the band that wire
 *     does not cross, clear of every arrowhead by `ARROWHEAD_REACH_PX`.
 */
import type { GroupFigure } from "../diagrams/figures";
import { groupPanelsOf, indexCategories, type Category } from "../diagrams/palette";
import { BOUNDARY_WORD } from "../diagrams/figures";
import { DEFAULT_TYPEFACE, estimateTextWidth, type TypefaceId } from "./text-measure";

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Point = { readonly x: number; readonly y: number };

/** The caption's type: `.archer-frame-caption` in `styles.css` states the same (14px bold, redesign slice 4). */
export const FRAME_CAPTION_FONT_PX = 14;
/** One row of caption. */
export const FRAME_CAPTION_LINE_PX = 20;
/** An architecture group's icon, and the gap after it (`FrameNode`). */
const CAPTION_ICON_PX = 16;
const CAPTION_GAP_PX = 5;

/** From the frame's top-left corner to the caption's, at its leftmost. */
export const FRAME_CAPTION_INSET = { x: 14, y: 10 } as const;

/**
 * Which end of its band a caption is placed from. The outermost neutral panel, the boundary round the whole drawing,
 * names itself at the top right (the home rig's server); every other panel at the top left.
 */
export type CaptionEnd = "start" | "end";

/**
 * How far an arrowhead or an end mark reaches back from the point a wire
 * ends at, in graph units: the closed arrowhead is drawn about ten long, a
 * crow's foot about as much, and two more keep the caption off its tip.
 */
export const ARROWHEAD_REACH_PX = 12;

/**
 * The air a caption keeps from a wire or an end mark, the wire's own half-width included. It was 4: a caption searched
 * along its band came to rest touching the first wire in its way, under two screen pixels at a fit zoom (rendered
 * review, 2026-11-13: "Design Together, Live" against the "Looks right" line). The nested view's grow keeps the same.
 */
export const CAPTION_AIR_PX = 10;
const WIRE_CLEARANCE_PX = CAPTION_AIR_PX;

/**
 * The top padding every frame is laid out with: the caption's inset and row,
 * then room for an arrowhead into the first row and a gap before it.
 */
export const FRAME_CAPTION_BAND_PX = FRAME_CAPTION_INSET.y + FRAME_CAPTION_LINE_PX + ARROWHEAD_REACH_PX + 10;

/** What a frame's caption says, as `FrameNode` and the subgraph caption draw it. */
export type CaptionText = { readonly label: string; readonly figure?: GroupFigure };

/** The caption's box: its icon, its name in the caption's weight, and a C4 boundary's kind. */
export function captionSize(
  caption: CaptionText,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
): { width: number; height: number } {
  const figure = caption.figure;
  const icon = figure?.type === "zone" && figure.icon !== undefined ? CAPTION_ICON_PX + CAPTION_GAP_PX : 0;
  const name = estimateTextWidth(caption.label, FRAME_CAPTION_FONT_PX, true, typeface);
  const kind =
    figure?.type === "boundary"
      ? CAPTION_GAP_PX + estimateTextWidth(`[${BOUNDARY_WORD[figure.kind]}]`, FRAME_CAPTION_FONT_PX, false, typeface)
      : 0;
  return { width: Math.ceil(icon + name + kind), height: FRAME_CAPTION_LINE_PX };
}

/** The narrowest a frame may be laid out: its caption, inset on both sides. */
export function frameMinimumWidth(caption: CaptionText, typeface: TypefaceId = DEFAULT_TYPEFACE): number {
  return captionSize(caption, typeface).width + 2 * FRAME_CAPTION_INSET.x;
}

/** A routed wire, as the caption has to keep off it. */
export type CaptionObstacleEdge = {
  readonly points: readonly Point[];
  readonly labelAnchor?: Box;
};

/** One straight run of a wire, grown by the clearance. */
function runBox(a: Point, b: Point): Box {
  return {
    x: Math.min(a.x, b.x) - WIRE_CLEARANCE_PX,
    y: Math.min(a.y, b.y) - WIRE_CLEARANCE_PX,
    width: Math.abs(a.x - b.x) + 2 * WIRE_CLEARANCE_PX,
    height: Math.abs(a.y - b.y) + 2 * WIRE_CLEARANCE_PX,
  };
}

/**
 * The room an end mark takes at `tip`, the wire arriving from `from`: the
 * last `ARROWHEAD_REACH_PX` of the wire, as wide as the mark either side.
 */
function endMarkBox(tip: Point, from: Point): Box {
  const length = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const back = {
    x: tip.x + ((from.x - tip.x) / length) * ARROWHEAD_REACH_PX,
    y: tip.y + ((from.y - tip.y) / length) * ARROWHEAD_REACH_PX,
  };
  // As wide as the mark across the wire; along it, the clearance past the tip.
  const across = ARROWHEAD_REACH_PX / 2 + WIRE_CLEARANCE_PX;
  const alongX = Math.abs(tip.x - from.x) >= Math.abs(tip.y - from.y);
  const padX = alongX ? WIRE_CLEARANCE_PX : across;
  const padY = alongX ? across : WIRE_CLEARANCE_PX;
  return {
    x: Math.min(tip.x, back.x) - padX,
    y: Math.min(tip.y, back.y) - padY,
    width: Math.abs(tip.x - back.x) + 2 * padX,
    height: Math.abs(tip.y - back.y) + 2 * padY,
  };
}

/**
 * Everything drawn for the edges that a caption must not share a pixel with:
 * each run of each wire, both its end marks, and its caption plate. Every end
 * is treated as marked -- an arrowhead, a crow's foot or a C4 arrow -- since
 * an unmarked end is a wire, which is in the list anyway.
 */
export function edgeObstacles(edges: readonly CaptionObstacleEdge[]): Box[] {
  const boxes: Box[] = [];
  for (const edge of edges) {
    const points = edge.points;
    for (let i = 1; i < points.length; i += 1) boxes.push(runBox(points[i - 1], points[i]));
    if (points.length >= 2) {
      boxes.push(endMarkBox(points[0], points[1]));
      boxes.push(endMarkBox(points[points.length - 1], points[points.length - 2]));
    }
    if (edge.labelAnchor !== undefined) boxes.push(edge.labelAnchor);
  }
  return boxes;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** How finely the band is searched for a free run, in graph units. */
const SEARCH_STEP_PX = 2;

/** The caption's row across the frame: what can be in its way. */
function captionRow(frame: Box, size: { width: number; height: number }): Box {
  return { x: frame.x, y: frame.y + FRAME_CAPTION_INSET.y, width: frame.width, height: size.height };
}

/**
 * The leftmost place in a frame's band where its caption shares no pixel
 * with `obstacles`, or `null` when every run of the band is taken.
 */
export function findCaptionPlace(
  frame: Box,
  size: { width: number; height: number },
  obstacles: readonly Box[],
  end: CaptionEnd = "start",
): Box | null {
  const row = captionRow(frame, size);
  const first = frame.x + FRAME_CAPTION_INSET.x;
  const last = frame.x + frame.width - FRAME_CAPTION_INSET.x - size.width;
  const at = (x: number): Box => ({ x, y: row.y, width: size.width, height: size.height });
  const near = obstacles.filter((box) => overlaps(box, row));
  const fits = (x: number): boolean => !near.some((box) => overlaps(box, at(x)));
  if (end === "end") {
    for (let x = last; x >= first; x -= SEARCH_STEP_PX) {
      if (fits(x)) return at(x);
    }
    return last >= first && fits(first) ? at(first) : null;
  }
  for (let x = first; x <= last; x += SEARCH_STEP_PX) {
    if (fits(x)) return at(x);
  }
  return last >= first && fits(last) ? at(last) : null;
}

/**
 * Where a frame's caption is drawn: the leftmost free place in its band, or
 * -- when the band has none -- its home at the left. The layout widens a
 * frame whose band is taken and lays the graph out again (`widthToClear`),
 * so the home is only the answer for a band that is taken after that too.
 */
export function placeCaption(
  frame: Box,
  size: { width: number; height: number },
  obstacles: readonly Box[],
  end: CaptionEnd = "start",
): Box {
  return (
    findCaptionPlace(frame, size, obstacles, end) ?? {
      x: end === "end" ? frame.x + frame.width - FRAME_CAPTION_INSET.x - size.width : frame.x + FRAME_CAPTION_INSET.x,
      y: frame.y + FRAME_CAPTION_INSET.y,
      width: size.width,
      height: size.height,
    }
  );
}

/**
 * How wide a frame whose band is taken has to be for its caption to fit to
 * the right of everything that crosses the band now. ELK keeps a frame's
 * contents at its left when a minimum widens it, so what crosses the band
 * stays where it is and the caption gets the run that was added.
 */
export function widthToClear(frame: Box, size: { width: number; height: number }, obstacles: readonly Box[]): number {
  const row = captionRow(frame, size);
  const right = Math.max(frame.x, ...obstacles.filter((box) => overlaps(box, row)).map((box) => box.x + box.width));
  return Math.ceil(right - frame.x + SEARCH_STEP_PX + size.width + FRAME_CAPTION_INSET.x);
}

type GroupLike = {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly element?: boolean;
  readonly figure?: GroupFigure;
  readonly classes?: readonly string[];
};

/**
 * Which end of its band each group's caption is placed from: the end for an outermost neutral subgraph (the boundary
 * round the drawing, as the home rig's server is named top right), the start for everything else -- a nested
 * panel, a family panel, and a frame that is a model element or a figure (a C4 boundary, a composite state, an
 * architecture group), which keep their own convention.
 */
export function captionEnds(view: {
  readonly groups: readonly GroupLike[];
  readonly categories?: readonly Category[];
}): Map<string, CaptionEnd> {
  const panels = groupPanelsOf(view.groups, indexCategories(view.categories));
  const ids = new Set(view.groups.map((group) => group.id));
  return new Map(
    view.groups.map((group) => {
      const outermost = group.parentId === undefined || !ids.has(group.parentId);
      const neutral = panels.get(group.id)?.palette.family === undefined;
      const plain = group.element !== true && group.figure === undefined;
      return [group.id, outermost && neutral && plain ? "end" : "start"];
    }),
  );
}
