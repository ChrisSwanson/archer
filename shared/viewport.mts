/** Pure viewport arithmetic shared by the page and service. No layout engine or DOM. */
import type { Box, Size, Padding, ZoomRange, Overflow } from "./layout-analysis.mts";
export type Frame = { readonly x: number; readonly y: number; readonly zoom: number };
export const READING_TEXT_PX = { min: 12, max: 13 } as const;
export const CHROME_GAP_PX = 12;
export const HEADING_BAND_PX = 10 + 22 + CHROME_GAP_PX;
export function withHeading(padding: Padding, heading: string | undefined): Padding {
  return heading === undefined ? padding : { ...padding, top: Math.max(padding.top, HEADING_BAND_PX) };
}

/** The gutter a fit leaves on every side. */
export const FIT_GUTTER_PX = 24;

/*
 * The extra a fit leaves in the legend's corner.
 *
 * The legend rests at the VIEWPORT's bottom left, beside the toolbar (it can be moved, which this
 * does not follow), not at the graph, so
 * fitting content to the full viewport is exactly what drives a node
 * underneath it -- and a tighter fit makes the collision more likely, not less.
 * The reservation has to happen before the bounds are framed, which is here.
 *
 * Sized from the panel's own box in `styles.css`: 300px max width plus its
 * 14px offset, and a legend of a few rows plus the same offset.
 */
const LEGEND_RESERVE_SIDE_PX = 330;
const LEGEND_RESERVE_BOTTOM_PX = 190;
/** The most of either axis the reservation may take; see `fitPadding`. */
const LEGEND_RESERVE_MAX_SHARE = 0.4;

/**
 * The room a fit must leave clear on each side of the canvas.
 *
 * On a narrow canvas the full legend reservation is wider than what would be
 * left to draw in (330 of 420px), so it is capped at a share of each axis: the
 * legend then overlaps the graph's corner, which a pan resolves, rather than
 * the graph being squeezed into a 66px column, which nothing does.
 */
export function fitPadding(canvas: Size, reserveLegend: boolean): Padding {
  const gutter = FIT_GUTTER_PX;
  if (!reserveLegend) {
    return { top: gutter, right: gutter, bottom: gutter, left: gutter };
  }
  const cap = (reserve: number, extent: number): number =>
    Math.max(gutter, Math.min(reserve, extent * LEGEND_RESERVE_MAX_SHARE));
  return {
    top: gutter,
    right: gutter,
    left: cap(LEGEND_RESERVE_SIDE_PX, canvas.width),
    bottom: cap(LEGEND_RESERVE_BOTTOM_PX, canvas.height),
  };
}

/**
 * The viewport that frames `content` in `canvas`, leaving `padding` clear.
 *
 * As large as fits, within `zooms` (`readingZoom` for an automatic framing,
 * `showAllZoom` for an explicit one). If fitting would take the zoom below
 * `zooms.min` it stops there (`NO_ZOOM_FLOOR` never stops it: the zoom is then
 * exactly what the content needs), and an axis that then overflows is not
 * centred -- centring an overflow hides both ends -- but placed so that
 * `entry`, the part of the drawing where reading it starts, is in view:
 * centred in the room there is, and never so far that the canvas shows empty
 * space beyond the drawing's own edge. With no `entry` an overflowing axis
 * starts at the content's own start. An axis that overflows the room but not
 * the canvas takes what it lacks from both plain gutters alike.
 *
 * An axis that fits is centred across and starts at the top down: a drawing
 * is read from its top, and a short, wide one centred in a tall canvas sat in
 * the middle of two empty bands.
 */
export function frameViewport(
  content: Box,
  canvas: Size,
  padding: Padding,
  zooms: ZoomRange,
  entry?: Box | null,
): Frame {
  const roomX = Math.max(1, canvas.width - padding.left - padding.right);
  const roomY = Math.max(1, canvas.height - padding.top - padding.bottom);
  const fit = Math.min(roomX / Math.max(1, content.width), roomY / Math.max(1, content.height));
  const zoom = Math.min(zooms.max, Math.max(zooms.min, fit));

  /** The screen offset of one axis: `lead` is the padding before it, `trail` the padding after. */
  const place = (
    start: number,
    extent: number,
    room: number,
    lead: number,
    trail: number,
    entryStart: number,
    entryExtent: number,
    centreWhenFits: boolean,
  ): number => {
    const drawn = extent * zoom;
    if (drawn <= room) {
      return lead + (centreWhenFits ? (room - drawn) / 2 : 0) - start * zoom;
    }
    // Overflowing the room but not the canvas: what it lacks comes out of both gutters, the same on each side,
    // rather than all out of the trailing one (the heartbeat at 1440x900 opened with its last node 2px from the
    // canvas's bottom edge; review 2026-11-13). Only a plain gutter gives: a lead that holds chrome (the heading's
    // band, the cue's, the room beside the controls) keeps all of it.
    const short = drawn - room;
    if (short <= lead + trail && lead <= FIT_GUTTER_PX) {
      const give = Math.max(0, Math.min(lead, (short + lead - trail) / 2));
      return lead - give - start * zoom;
    }
    // Overflowing. From the drawing's own start, where it is read from, moved
    // only as far as keeps the entry in view -- and never so far that the
    // content's end is pulled inside the room. Centring the entry instead ran
    // the drawing off the canvas's left edge, under the control cluster, for
    // a first layer that was already in view (420px, review of 2026-10-04).
    const startAligned = lead - start * zoom;
    const endAligned = lead + room - (start + extent) * zoom;
    const entryFrom = entryStart * zoom;
    const entryTo = (entryStart + entryExtent) * zoom;
    const keepsEntry = entryTo - entryFrom > room ? lead - entryFrom : Math.min(startAligned, lead + room - entryTo);
    return Math.max(endAligned, Math.min(startAligned, keepsEntry));
  };

  // No entry: an entry of no size at the content's start, which the clamp
  // turns into plain start alignment.
  const anchor = entry ?? { x: content.x, y: content.y, width: 0, height: 0 };
  return {
    x: place(content.x, content.width, roomX, padding.left, padding.right, anchor.x, anchor.width, true),
    y: place(content.y, content.height, roomY, padding.top, padding.bottom, anchor.y, anchor.height, false),
    zoom,
  };
}

/** Stable "everything is in view", so state holding it does not churn. */
export const NO_OVERFLOW: readonly Overflow[] = [];

/** Less than this past an edge is rounding, not content. */
const OVERFLOW_TOLERANCE_PX = 1;

/**
 * What `frame` leaves outside `canvas`, side by side: nothing when the whole
 * of `content` is in view.
 *
 * A side is named when the content's own edge lies past the canvas's. What is
 * COUNTED there is the things whose middle does -- a node half in view is a
 * node the reader can see, and "1 more" for it would be one too many. So a
 * side can be named with a count of 0: something is cut off, nothing is
 * missing.
 *
 * `across` is what is counted to the left and right, `down` what is counted
 * above and below. A graph passes its nodes as both. A sequence diagram
 * passes its participants across and its messages down, because those are
 * what it has more of in each direction.
 *
 * Measured against the WHOLE canvas, not the padded room a fit frames into:
 * a node under the legend's corner is on screen.
 */
export function overflowOf(
  content: Box,
  items: { readonly across: readonly Box[]; readonly down: readonly Box[] },
  frame: Frame,
  canvas: Size,
): readonly Overflow[] {
  const centreX = (box: Box): number => (box.x + box.width / 2) * frame.zoom + frame.x;
  const centreY = (box: Box): number => (box.y + box.height / 2) * frame.zoom + frame.y;
  const count = (boxes: readonly Box[], past: (box: Box) => boolean): number => boxes.filter(past).length;

  const left = content.x * frame.zoom + frame.x;
  const top = content.y * frame.zoom + frame.y;
  const right = (content.x + content.width) * frame.zoom + frame.x;
  const bottom = (content.y + content.height) * frame.zoom + frame.y;

  const found: Overflow[] = [];
  if (left < -OVERFLOW_TOLERANCE_PX) {
    found.push({ side: "left", count: count(items.across, (box) => centreX(box) < 0) });
  }
  if (right > canvas.width + OVERFLOW_TOLERANCE_PX) {
    found.push({ side: "right", count: count(items.across, (box) => centreX(box) > canvas.width) });
  }
  if (top < -OVERFLOW_TOLERANCE_PX) {
    found.push({ side: "top", count: count(items.down, (box) => centreY(box) < 0) });
  }
  if (bottom > canvas.height + OVERFLOW_TOLERANCE_PX) {
    found.push({ side: "bottom", count: count(items.down, (box) => centreY(box) > canvas.height) });
  }
  return found.length === 0 ? NO_OVERFLOW : found;
}
