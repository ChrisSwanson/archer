// The nested view's "+" keeps the same gap to its box on the top, the right and round the corner
// (decided 2026-10-29: a "+" rounder or squarer than its box's corner looked uneven there).
import { describe, expect, it } from "vitest";
import {
  closedToggleInset,
  frameToggleRect,
  TOGGLE_DRAWN_PX,
  TOGGLE_RADIUS_MAX,
  toggleInset,
  togglePosition,
  toggleRadius,
} from "../src/nesting/toggle-place";
import { CANVAS_MAX_ZOOM, readableFloorZoom, tooSmallToRead } from "../src/diagrams/viewport-fit";

/** The gap from the box's corner arc to the "+"'s, along the diagonal, with the "+" drawn with its outline. */
function cornerGap(boxRadius: number, zoom: number): number {
  const inset = closedToggleInset(zoom, boxRadius),
    outer = toggleRadius(zoom, boxRadius) + 1.25 / 2;
  const box = boxRadius * zoom,
    edge = inset - 1.25 / 2;
  // Arc centres sit on the diagonal: the box's at `box` from each side, the mark's at `edge + outer`.
  const apart = (edge + outer - box) * Math.SQRT2;
  // The mark's centre lies `apart` further from the corner than the box's (nearer when negative).
  return box - outer + apart;
}

describe("the + round its box's corner", () => {
  it("sits the same distance from the top and the right", () => {
    for (const zoom of [0.6, 1, 1.5, 2.5]) {
      const at = togglePosition({ x: 0, y: 0, width: 200, height: 80 }, false, [0, 0, zoom]);
      expect(at.top).toBeCloseTo(200 * zoom - at.left - 20, 6);
    }
  });
  for (const radius of [6, 8, 12, 16]) {
    for (const zoom of [1, 1.5, 2, 3]) {
      it(`keeps the side gap round a ${radius} px corner at zoom ${zoom}`, () => {
        if (toggleRadius(zoom, radius) === 0) return;
        expect(cornerGap(radius, zoom)).toBeCloseTo(closedToggleInset(zoom, radius) - 1.25 / 2, 1);
      });
    }
  }
  it("keeps the side gap round an open-able box's 12 px corner at the size a diagram is read at", () => {
    expect(cornerGap(12, 1)).toBeCloseTo(toggleInset(1) - 1.25 / 2, 1);
    expect(toggleRadius(1, 12)).toBeGreaterThanOrEqual(5);
  });
  it("stays a rounded square, never a circle: in a very round corner it sits further in instead", () => {
    expect(toggleRadius(3, 12)).toBe(TOGGLE_RADIUS_MAX);
    expect(toggleRadius(1, 16)).toBe(TOGGLE_RADIUS_MAX);
    expect(closedToggleInset(1, 16)).toBe(16 - TOGGLE_RADIUS_MAX);
  });
  it("is square where the box's corner is tighter than the gap", () => {
    expect(toggleRadius(1, 4)).toBe(0);
    expect(toggleRadius(0.6, 8)).toBe(0);
  });
});

describe("the room a frame's − keeps clear", () => {
  // The "−" is drawn at a constant screen size, so in drawing units it grows as the view zooms out. The room
  // the layout keeps for it must hold it at every zoom the page draws it at: from the readable floor (below
  // which the controls hide) to the canvas's largest zoom. Found on the Pageturner containers opened at the
  // fit zoom 0.65 (2026-10-31): kept at zoom 1 only, a caption plate sat under the "−".
  const frame = { x: 40, y: 30, width: 420, height: 300 };
  const floor = readableFloorZoom();
  it("starts where the controls start to show", () => {
    expect(tooSmallToRead(floor)).toBe(false);
    expect(tooSmallToRead(floor - 0.001)).toBe(true);
  });
  for (const zoom of [floor, 0.5, 0.65, 0.8, 1, 1.5, CANVAS_MAX_ZOOM]) {
    it(`holds the − drawn at zoom ${zoom.toFixed(3)}`, () => {
      const at = togglePosition(frame, true, [0, 0, zoom]);
      const drawn = {
        x: at.left / zoom,
        y: at.top / zoom,
        width: TOGGLE_DRAWN_PX / zoom,
        height: TOGGLE_DRAWN_PX / zoom,
      };
      const room = frameToggleRect(frame);
      expect(drawn.x).toBeGreaterThanOrEqual(room.x);
      expect(drawn.y).toBeGreaterThanOrEqual(room.y);
      expect(drawn.x + drawn.width).toBeLessThanOrEqual(room.x + room.width);
      expect(drawn.y + drawn.height).toBeLessThanOrEqual(room.y + room.height);
    });
  }
  it("stays inside its frame", () => {
    const room = frameToggleRect(frame);
    expect(room.x).toBeGreaterThan(frame.x);
    expect(room.x + room.width).toBeLessThanOrEqual(frame.x + frame.width);
    expect(room.y).toBeGreaterThanOrEqual(frame.y);
  });
});
