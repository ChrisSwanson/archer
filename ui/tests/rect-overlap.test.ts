import { expect, test } from "vitest";
import { intersects, type Rect } from "../src/nesting/route-geometry";
import { hitsAny } from "../src/diagrams/chrome-clearance";

const origin: Rect = { x: 10, y: 20, width: 30, height: 40 };
test.each([
  ["inside", { x: 12, y: 22, width: 5, height: 5 }, true],
  ["crossing", { x: 0, y: 0, width: 15, height: 25 }, true],
  ["covering", { x: 0, y: 0, width: 100, height: 100 }, true],
  ["touching right", { x: 40, y: 20, width: 10, height: 10 }, false],
  ["touching bottom", { x: 10, y: 60, width: 10, height: 10 }, false],
  ["touching corner", { x: 40, y: 60, width: 10, height: 10 }, false],
  ["separate", { x: -40, y: -60, width: 10, height: 10 }, false],
  ["zero width inside", { x: 20, y: 30, width: 0, height: 10 }, true],
] as const)("strict overlap preserves route and chrome decisions: %s", (_, box, expected) => {
  expect(intersects(origin, box)).toBe(expected);
  expect(intersects(box, origin)).toBe(expected);
  expect(hitsAny([origin], box)).toBe(expected);
});

test("edge coordinates stay exact rather than round-tripping through width", () => {
  // left + (right - left) rounds to 0 here, which would lose this overlap.
  const a = { left: -1e16, right: 1, top: 0, bottom: 20 };
  expect(intersects(a, { left: 0, right: 2, top: 0, bottom: 20 })).toBe(true);
  expect(intersects(a, { x: 0, y: 0, width: 2, height: 20 })).toBe(true);
  expect(intersects(a, { left: 1, right: 2, top: 0, bottom: 20 })).toBe(false);
});
