/**
 * Where the nested view's "+" and "−" sit (`NestToggles.tsx`), as pure geometry, so the layout
 * (`grow-in-place-v2.ts`, in the worker) can keep label plates out from under a frame's "−".
 *
 * The controls are drawn in screen space at a constant size; in layout units the area they cover
 * is `TOGGLE_DRAWN_PX / zoom`, so it grows as the view zooms out. A fitted-down view hides them once
 * it is too small to read (`tooSmallToRead`), so a frame's "−" is reserved at every zoom from that
 * floor up to the canvas's largest: reserved at zoom 1 only, a caption plate sat under it at the
 * fit zoom 0.65 (Pageturner containers opened, 2026-10-31).
 */
import type { LayoutResult } from "../layout/elk-layout";
import type { Rect } from "./route-geometry";
import { CANVAS_MAX_ZOOM, readableFloorZoom } from "../diagrams/viewport-fit";

/** The drawn size of a control and its hit area, in screen px. */
export const TOGGLE_DRAWN_PX = 20;
/** Clear space between a box's border and its control, the same on the top and the right (decided 2026-10-29). */
export const TOGGLE_GAP_PX = 4;
/** The widest border a box is drawn with (an emphasised one), in layout units; it scales with the drawing. */
const BORDER_MAX = 2;
/** A box's corner radius when it cannot be read (`.archer-node`), in layout units. */
export const BOX_RADIUS = 6;
/** From a container's outer edge to its control at this zoom: the border, then the gap (a frame's "−" sits 4 px further in). */
export function toggleInset(zoom: number): number {
  return BORDER_MAX * zoom + TOGGLE_GAP_PX;
}
/**
 * A "+" and its box's corner share one centre, so the gap is the same along both sides and round the
 * curve (decided 2026-10-29: a squarer "+" pinched the corner and opened along the sides). Its corner is
 * the box's on screen less the inset. A tight corner gives a square "+". A "+" stays a rounded square
 * (at most TOGGLE_RADIUS_MAX round, never a circle), so in a very round corner, or zoomed far in, it
 * sits further in: the gap grows with the curve and stays even. The "−" sits in a frame's caption row.
 */
export const TOGGLE_RADIUS_MAX = 6;
/** From a closed box's outer edge to its "+": the usual inset, or further in where its corner is very round. */
export function closedToggleInset(zoom: number, boxRadius = BOX_RADIUS): number {
  return Math.max(toggleInset(zoom), boxRadius * zoom - TOGGLE_RADIUS_MAX);
}
export function toggleRadius(zoom: number, boxRadius = BOX_RADIUS): number {
  // The outline's outer edge is half a stroke outside the square and its curve half a stroke wider: the two cancel.
  return Math.max(0, Math.round((boxRadius * zoom - closedToggleInset(zoom, boxRadius)) * 100) / 100);
}
export const FRAME_TOGGLE_RADIUS = 3;
const FRAME_INSET_EXTRA_PX = 4;
/** How far below a frame's top edge its "−" sits: the middle of the caption's 18 px row at 8 px. */
const FRAME_TOGGLE_TOP_PX = 7;
/** Clear space kept around a "−" by label plates, in layout units. */
const RESERVE_PX = 4;

/** A control's top-left on screen, for a container at layout box `box` under transform [tx, ty, zoom] (a closed box's corner `boxRadius`). */
export function togglePosition(
  box: Rect,
  open: boolean,
  [tx, ty, zoom]: readonly [number, number, number],
  boxRadius = BOX_RADIUS,
): { left: number; top: number } {
  const right = (box.x + box.width) * zoom + tx;
  const top = box.y * zoom + ty;
  const inset = open ? toggleInset(zoom) : closedToggleInset(zoom, boxRadius);
  return {
    left: right - inset - TOGGLE_DRAWN_PX - (open ? FRAME_INSET_EXTRA_PX : 0),
    top: top + (open ? FRAME_TOGGLE_TOP_PX : inset),
  };
}

/**
 * The layout area an open frame's "−" covers at any zoom it is drawn at, with clear space: no label
 * plate and no rerouted wire goes there. In layout units the control's left and bottom edges move out
 * as the zoom falls and its right and top edges move in as it rises, so the area is the union of the
 * control drawn at the readable floor and at the largest zoom.
 */
export function frameToggleRect(frame: Rect): Rect {
  const drawn = (zoom: number) => {
    const at = togglePosition(frame, true, [0, 0, zoom]);
    return {
      left: at.left / zoom,
      top: at.top / zoom,
      right: (at.left + TOGGLE_DRAWN_PX) / zoom,
      bottom: (at.top + TOGGLE_DRAWN_PX) / zoom,
    };
  };
  const [small, large] = [drawn(readableFloorZoom()), drawn(CANVAS_MAX_ZOOM)];
  const left = Math.min(small.left, large.left) - RESERVE_PX;
  const top = Math.min(small.top, large.top) - RESERVE_PX;
  const right = Math.min(Math.max(small.right, large.right) + RESERVE_PX, frame.x + frame.width);
  const bottom = Math.max(small.bottom, large.bottom) + RESERVE_PX;
  return { x: left, y: Math.max(top, frame.y), width: right - left, height: bottom - Math.max(top, frame.y) };
}

/** What `cameraAfterPress` needs: the new layout, the box pressed and where it sat on screen. */
export type PressCamera = {
  readonly layout: LayoutResult;
  readonly groupId: string;
  /** The pressed container's top-left on screen before the press. */
  readonly screen: { readonly x: number; readonly y: number };
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
};

const CAMERA_MARGIN_PX = 12;

/**
 * The camera's translation after a press: the pressed box stays where it was on screen (its
 * control under the finger). A frame that grew past the right edge (a phone) is brought back far
 * enough that its "−" shows, and so is every open frame around it, innermost first (a second
 * press inside an open frame widens the outer one too), as far as the pressed control stays on
 * screen: that one always wins.
 */
export function cameraAfterPress(press: PressCamera): { x: number; y: number } {
  const { layout, groupId, screen, zoom, width, height } = press;
  const frames = new Map(layout.groups.map((group) => [group.id, group]));
  const opened = frames.get(groupId);
  const folded = opened === undefined ? layout.nodes.find((node) => node.folded?.groupId === groupId) : undefined;
  const box = opened ?? folded;
  if (box === undefined) return { x: screen.x, y: screen.y };
  let x = screen.x - box.x * zoom;
  let y = screen.y - box.y * zoom;
  const margin = CAMERA_MARGIN_PX;
  if (width > 0) {
    const right = (box.x + box.width) * zoom + x;
    if (right > width - margin) x -= right - (width - margin);
    const left = box.x * zoom + x;
    if (left < margin && box.width * zoom <= width - 2 * margin) x += margin - left;
  }
  if (width <= 0 || height <= 0) return { x, y };
  const pressed = () => togglePosition(box, opened !== undefined, [x, y, zoom]);
  const around: Rect[] = [];
  for (
    let id = opened?.parentId ?? folded?.groupId, guard = 0;
    id !== undefined && guard <= layout.groups.length;
    guard++
  ) {
    const frame = frames.get(id);
    if (frame === undefined) break;
    around.push(frame);
    id = frame.parentId;
  }
  for (const frame of around) {
    const at = togglePosition(frame, true, [x, y, zoom]);
    const over = at.left + TOGGLE_DRAWN_PX - (width - margin);
    if (over > 0) x -= Math.max(0, Math.min(over, pressed().left - margin));
    const under = margin - at.top;
    if (under > 0) y += Math.max(0, Math.min(under, height - margin - TOGGLE_DRAWN_PX - pressed().top));
  }
  return { x, y };
}

/** The room round the canvas a camera keeps clear, in screen px: the margin, widened beside floating chrome. */
export type CameraPadding = {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
};

/**
 * The camera after a press that OPENED `groupId`, with the opened frame in view (second rendered review,
 * 2026-11-13: Where Archer Runs and Archer Containers opened at 1440x900 with the frame cut at the canvas's left
 * edge and under the tool rail). `camera` is where `cameraAfterPress` left it: the box kept in place.
 *
 * The least move that shows the whole frame inside `padding`: none when it is in view; a pan when it fits at this
 * zoom; otherwise a zoom out to just fit it, about its "−" corner, then the pan. Never a zoom in, and never below
 * `floor`: a frame that cannot be shown whole there (a phone) keeps the press's camera, the ADR 0029 rule.
 * A press that closed the frame has nothing to show.
 */
export function showOpened(input: {
  readonly layout: LayoutResult;
  readonly groupId: string;
  readonly camera: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly width: number;
  readonly height: number;
  readonly padding: CameraPadding;
  readonly floor: number;
}): { x: number; y: number; zoom: number } {
  const { camera, padding } = input;
  const frame = input.layout.groups.find((group) => group.id === input.groupId);
  const roomX = input.width - padding.left - padding.right;
  const roomY = input.height - padding.top - padding.bottom;
  if (frame === undefined || roomX <= 0 || roomY <= 0 || frame.width <= 0 || frame.height <= 0) return camera;
  const fits = Math.min(roomX / frame.width, roomY / frame.height);
  if (fits < input.floor && fits < camera.zoom) return camera;
  const zoom = Math.min(camera.zoom, fits);
  // Zoomed about the frame's top-right corner, where its "−" is.
  const cornerX = (frame.x + frame.width) * camera.zoom + camera.x;
  const cornerY = frame.y * camera.zoom + camera.y;
  let x = cornerX - (frame.x + frame.width) * zoom;
  let y = cornerY - frame.y * zoom;
  const into = (start: number, size: number, lead: number, room: number): number =>
    start < lead ? lead - start : start + size > lead + room ? lead + room - (start + size) : 0;
  x += into(frame.x * zoom + x, frame.width * zoom, padding.left, roomX);
  y += into(frame.y * zoom + y, frame.height * zoom, padding.top, roomY);
  return { x, y, zoom };
}
