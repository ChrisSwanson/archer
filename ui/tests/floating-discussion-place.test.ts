// Where an anchored discussion opens (`placeDiscussion`, FloatingDiscussion.tsx): beside its element,
// never over it or the pins on its corner. A hover preview that clamped onto the element covered the
// pin being pressed, so the press opened nothing (browser suite, comments "a pin pressed…"). The box
// given is the element's with its pins.
import { describe, expect, it } from "vitest";
import { placeDiscussion } from "../src/comments/FloatingDiscussion";

const viewport = { width: 1440, height: 900 };
const box = { width: 360, height: 260 };
const overlaps = (p: { x: number; y: number }, r: { left: number; top: number; right: number; bottom: number }) =>
  p.x < r.right && p.x + box.width > r.left && p.y < r.bottom && p.y + box.height > r.top;

describe("placeDiscussion", () => {
  it("opens to the right of its element when there is room", () => {
    const r = { left: 200, top: 300, right: 360, bottom: 360 };
    expect(placeDiscussion(r, box, viewport)).toEqual({ x: 376, y: 300 });
  });
  it.each([
    ["near the right edge", { left: 1000, top: 300, right: 1160, bottom: 360 }],
    ["in the middle of a narrow window", { left: 150, top: 300, right: 330, bottom: 360 }],
    ["at the bottom right", { left: 1180, top: 760, right: 1340, bottom: 820 }],
  ] as const)("never covers its element or its corner pins: %s", (_, r) => {
    const size = _ === "in the middle of a narrow window" ? { width: 480, height: 900 } : viewport;
    const at = placeDiscussion(r, box, size);
    expect(overlaps(at, r)).toBe(false);
    expect(at.x).toBeGreaterThanOrEqual(12);
    expect(at.y).toBeGreaterThanOrEqual(12);
  });
});
