// The fewest corners a wire needs given the sides its two ends sit on (the measure of "needless" bends, redesign
// slice 6). A back-edge -- its target behind its source along the way it leaves -- can never be straight: leaving and
// entering the same way it needs four corners (out, across, back, across, in), which is a side lane, not needless.
import { describe, expect, it } from "vitest";
import { fewestBends } from "./route-metrics";

const box = (x: number, y: number, width = 100, height = 50) => ({ x, y, width, height });

describe("the fewest corners a wire needs", () => {
  it("is 0 for ends facing each other across an overlap, 2 for a jog", () => {
    expect(
      fewestBends(
        [
          { x: 50, y: 50 },
          { x: 50, y: 70 },
          { x: 60, y: 70 },
          { x: 60, y: 200 },
        ],
        box(0, 0),
        box(0, 200),
      ),
    ).toBe(0);
    expect(
      fewestBends(
        [
          { x: 50, y: 50 },
          { x: 50, y: 70 },
          { x: 350, y: 70 },
          { x: 350, y: 200 },
        ],
        box(0, 0),
        box(300, 200),
      ),
    ).toBe(2);
  });

  it("is 4 for a back-edge leaving and entering the same way (bottom out, top in, its target above)", () => {
    // Leaves the source's bottom going down, enters the target's top going down, the target above the source.
    const route = [
      { x: 50, y: 250 },
      { x: 50, y: 270 },
      { x: 200, y: 270 },
      { x: 200, y: -20 },
      { x: 50, y: -20 },
      { x: 50, y: 0 },
    ];
    expect(fewestBends(route, box(0, 200), box(0, 0))).toBe(4);
  });

  it("is 1 for perpendicular sides whose corner is ahead of both, 3 when it is not", () => {
    // Out of the bottom, into the left side of a target below and to the right: one corner.
    expect(
      fewestBends(
        [
          { x: 50, y: 50 },
          { x: 50, y: 225 },
          { x: 300, y: 225 },
        ],
        box(0, 0),
        box(300, 200),
      ),
    ).toBe(1);
    // Out of the bottom, into the left side of a target ABOVE: the corner would be behind the start.
    const route = [
      { x: 50, y: 250 },
      { x: 50, y: 270 },
      { x: 250, y: 270 },
      { x: 250, y: 25 },
      { x: 300, y: 25 },
    ];
    expect(fewestBends(route, box(0, 200), box(300, 0))).toBe(3);
  });

  it("treats a wire whose target ranks above its source in the flow as a back-edge, whichever sides it uses", () => {
    // A top-to-bottom drawing; the wire leaves its source's top and enters its target's bottom, going up a side lane.
    const lane = [
      { x: 50, y: 200 },
      { x: 50, y: 180 },
      { x: 250, y: 180 },
      { x: 250, y: 70 },
      { x: 50, y: 70 },
      { x: 50, y: 50 },
    ];
    expect(fewestBends(lane, box(0, 200), box(0, 0), "tb")).toBe(4);
    // Without the flow's direction it is judged by its ends alone, as before.
    expect(fewestBends(lane, box(0, 200), box(0, 0))).toBe(0);
    // Leaving and entering on the same side (a U up the side): two.
    const u = [
      { x: 100, y: 225 },
      { x: 130, y: 225 },
      { x: 130, y: 25 },
      { x: 100, y: 25 },
    ];
    expect(fewestBends(u, box(0, 200), box(0, 0), "tb")).toBe(2);
  });

  it("is 2 for ends facing the same side (a U)", () => {
    expect(
      fewestBends(
        [
          { x: 50, y: 50 },
          { x: 50, y: 80 },
          { x: 350, y: 80 },
          { x: 350, y: 50 },
        ],
        box(0, 0),
        box(300, 0),
      ),
    ).toBe(2);
  });
});
