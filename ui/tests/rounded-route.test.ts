import { expect, it } from "vitest";
import { CORNER_RADIUS_PX, roundedRoute } from "../src/diagrams/rounded-route";

// The reference's turns are rounded at about 10-12px (review C.8; redesign slice 6).
it("rounds a corner with room on both sides at 10px", () => {
  expect(CORNER_RADIUS_PX).toBe(10);
  expect(
    roundedRoute([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]),
  ).toBe("M 0,0 L 90,0 Q 100,0 100,10 L 100,100");
});

it("keeps a 10-unit target approach straight rather than rounding half away", () => {
  expect(
    roundedRoute(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 10 },
      ],
      { arrowEnd: true },
    ),
  ).toBe("M 0,0 L 40,0 L 40,10");
});

it("reserves the source approach when the source has an arrowhead", () => {
  expect(
    roundedRoute(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 40 },
      ],
      { arrowStart: true },
    ),
  ).toBe("M 0,0 L 10,0 L 10,40");
});
it("preserves both ends of a bidirectional short corner", () => {
  expect(
    roundedRoute(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      { arrowStart: true, arrowEnd: true },
    ),
  ).toBe("M 0,0 L 10,0 L 10,10");
});
it("rounds the rest of the route normally and preserves every endpoint", () => {
  const route = [
    { x: 0, y: 0 },
    { x: 80, y: 0 },
    { x: 80, y: 80 },
  ];
  expect(roundedRoute(route, { arrowStart: true, arrowEnd: true })).toBe("M 0,0 L 70,0 Q 80,0 80,10 L 80,80");
  expect(route).toEqual([
    { x: 0, y: 0 },
    { x: 80, y: 0 },
    { x: 80, y: 80 },
  ]);
});
it("keeps the normal small corner for ends without arrowheads", () => {
  expect(
    roundedRoute([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 10 },
    ]),
  ).toBe("M 0,0 L 35,0 Q 40,0 40,5 L 40,10");
});
it("uses all available short approach without moving ELK's port", () => {
  expect(
    roundedRoute(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 4 },
      ],
      { arrowEnd: true },
    ),
  ).toBe("M 0,0 L 40,0 L 40,4");
});
it("handles degenerate routes without invalid numbers", () => {
  expect(roundedRoute([])).toBe("");
  expect(
    roundedRoute(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 10 },
      ],
      { arrowEnd: true },
    ),
  ).toBe("M 0,0 L 0,0 L 0,10");
});
