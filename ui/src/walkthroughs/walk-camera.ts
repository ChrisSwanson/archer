/**
 * Where the follow camera goes for a step (ADR 0034 §6; the approved prototype's rule): fit the
 * step's parts and the previous step's, with a margin; never zoom in past 150% of the whole-graph
 * fit, and zoom out only as far as the parts need, never past that fit. Pure: the canvas applies
 * the frame with one animated `setViewport`, aimed at a view that is reachable.
 *
 * A diagram too big to read at its fit may be followed up to `readable`, the canvas's own reading
 * size, rather than at marks nobody can make out.
 */
import { CANVAS_MAX_ZOOM, layoutBounds, type Box, type Frame, type Padding, type Size } from "../diagrams/viewport-fit";
import type { LayoutResult } from "../layout/elk-layout";

export const FOLLOW_MAX_OF_FIT = 1.5;
/** Clear space round the parts, in layout units. */
export const FOLLOW_MARGIN = 40;

/** The box the named boxes, frames and lines take up; null when none of them is drawn. */
function partsBounds(layout: LayoutResult, nodeIds: readonly string[], edgeIds: readonly string[]): Box | null {
  const boxes: Box[] = [];
  const nodes = new Set(nodeIds);
  for (const box of [...layout.nodes, ...layout.groups]) if (nodes.has(box.id)) boxes.push(box);
  for (const edge of layout.edges) {
    if (!edgeIds.includes(edge.id) || edge.points.length === 0) continue;
    const xs = edge.points.map((point) => point.x);
    const ys = edge.points.map((point) => point.y);
    boxes.push({
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    });
  }
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  return {
    x: left,
    y: top,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - left,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - top,
  };
}

export function followFrame(input: {
  readonly layout: LayoutResult;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly canvas: Size;
  readonly padding: Padding;
  readonly margin?: number;
  /** The smallest zoom the canvas reads at; raises the ceiling when the whole graph fits below it. */
  readonly readable?: number;
  /** The canvas's own lowest zoom: a frame under it would be clamped up, to a view that is not the one aimed at. */
  readonly min?: number;
}): Frame | null {
  const { layout, canvas, padding } = input;
  const parts = partsBounds(layout, input.nodeIds, input.edgeIds);
  const whole = layoutBounds(layout);
  if (parts === null || whole === null) return null;
  const margin = input.margin ?? FOLLOW_MARGIN;
  const roomX = Math.max(1, canvas.width - padding.left - padding.right);
  const roomY = Math.max(1, canvas.height - padding.top - padding.bottom);
  const fits = (box: Box): number => Math.min(roomX / Math.max(1, box.width), roomY / Math.max(1, box.height));
  const floor = Math.max(fits(whole), input.min ?? 0);
  const ceiling = Math.min(CANVAS_MAX_ZOOM, Math.max(floor * FOLLOW_MAX_OF_FIT, input.readable ?? 0));
  const box = {
    x: parts.x - margin,
    y: parts.y - margin,
    width: parts.width + 2 * margin,
    height: parts.height + 2 * margin,
  };
  const zoom = Math.max(Math.min(floor, ceiling), Math.min(ceiling, fits(box)));
  return {
    x: towardCut(padding.left, roomX, box.x, box.width, whole.x, whole.width, zoom),
    y: towardCut(padding.top, roomY, box.y, box.height, whole.y, whole.height, zoom),
    zoom,
  };
}

/**
 * One axis of the camera's offset: the parts' box centred in the room, unless that shows empty canvas past one edge
 * of the drawing while the drawing is cut off at the other. Then the camera moves toward the cut side, until the
 * drawing's edge meets the room's or the parts' box does, so every part stays in the room at the same zoom.
 * Departure from plain centring (ADR 0034 slice 5): Brew step 1, the top of a tall drawing, was centred with ~280px of
 * empty canvas above it while the drawing ran off the bottom (rendered review, 2026-11-13).
 */
function towardCut(
  start: number,
  room: number,
  boxAt: number,
  boxSize: number,
  wholeAt: number,
  wholeSize: number,
  zoom: number,
): number {
  const end = start + room;
  const offset = start + room / 2 - (boxAt + boxSize / 2) * zoom;
  const drawing = { from: wholeAt * zoom + offset, to: (wholeAt + wholeSize) * zoom + offset };
  const parts = { from: boxAt * zoom + offset, to: (boxAt + boxSize) * zoom + offset };
  if (drawing.from > start && drawing.to > end) return offset - Math.max(0, Math.min(drawing.from, parts.from) - start);
  if (drawing.to < end && drawing.from < start) return offset + Math.max(0, end - Math.max(drawing.to, parts.to));
  return offset;
}

/** Framing clear of the tool rail and the chat button is the canvas's, shared with its own framings. */
export { CHROME_GAP_PX, clearOfChrome } from "../diagrams/chrome-clearance";

/**
 * A step's parts for the camera, as drawn ids (the current step's and the previous step's); `current`, the current
 * step's alone; `key` changes when the camera should move again.
 */
export type FollowRequest = {
  readonly key: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly current?: { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
};

/** A canvas narrower than this is a phone's (the page's `max-width: 599px` layouts). */
export const COMPACT_FOLLOW_WIDTH = 600;
/** On a phone: the clear space round the step's parts, in layout units, and the canvas gutter, in px. */
export const COMPACT_FOLLOW_MARGIN = 12;
export const COMPACT_FOLLOW_GUTTER = 8;

/**
 * What the camera frames for `request` on `canvas`. A desktop canvas: both steps, so the move from the last step
 * is seen. A phone canvas: the current step only, with a small margin and gutter, because both steps side by side
 * drew its labels at about 6 px (flows-r1 claude-06, O95: fulfilment step 2 at 320x640, zoom 0.36). `gutter` null:
 * the canvas's usual fit padding.
 */
export function followParts(
  request: FollowRequest,
  canvas: Size,
): { nodeIds: readonly string[]; edgeIds: readonly string[]; margin: number; gutter: number | null } {
  const current = request.current;
  if (
    canvas.width >= COMPACT_FOLLOW_WIDTH ||
    current === undefined ||
    current.nodeIds.length + current.edgeIds.length === 0
  ) {
    return { nodeIds: request.nodeIds, edgeIds: request.edgeIds, margin: FOLLOW_MARGIN, gutter: null };
  }
  return {
    nodeIds: current.nodeIds,
    edgeIds: current.edgeIds,
    margin: COMPACT_FOLLOW_MARGIN,
    gutter: COMPACT_FOLLOW_GUTTER,
  };
}
/** What the canvas is given to follow with, and how it says the person took the camera. */
export type WalkCamera = { readonly request: FollowRequest | null; readonly onPersonMoved: () => void };
/** How long the glide takes (prototype: 0.56 s; one transform, aimed at a reachable view). */
export const FOLLOW_GLIDE_MS = 500;
