import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ArrowMarkers, arrowMarkerWidth } from "../src/diagrams/ArrowMarkers";
import { terminalStraightLength } from "../src/diagrams/rounded-route";

it.each([1, 0.5, 0.25, 0.2])("a %.2fx view has a readable filled head and twelve units of shaft", (zoom) => {
  const width = arrowMarkerWidth(zoom, 40);
  expect(((5 * width) / 20) * zoom).toBeGreaterThanOrEqual(4);
  expect(40 - (5.5 * width) / 20).toBeGreaterThanOrEqual(12);
});
it("a short terminal lane caps the head before its turn instead of promising an impossible screen minimum", () => {
  const width = arrowMarkerWidth(0.05, 10);
  expect((5.5 * width) / 20).toBeLessThanOrEqual(5 + 1e-9);
});
it.each([0, -1, NaN, Infinity])("invalid zoom %s cannot produce invalid SVG dimensions", (zoom) => {
  expect(arrowMarkerWidth(zoom, 40)).toBe(0);
});
it("local definitions name each end separately and reverse source arrowheads", () => {
  const markup = renderToStaticMarkup(<ArrowMarkers id="edge-one" start={40} end={60} />);
  expect(markup).toContain('id="edge-one-start"');
  expect(markup).toContain('id="edge-one-end"');
  expect(markup.match(/orient="auto"/g) ?? []).toHaveLength(2);
  expect(markup).toContain('points="5,-4 0,0 5,4 5,-4"');
  expect(markup).toContain('points="-5,-4 0,0 -5,4 -5,-4"');
  expect(markup).toContain('markerUnits="userSpaceOnUse"');
});
it("measures only the rounded terminal run, preserving duplicate and collinear route points", () => {
  const ends = { arrowEnd: true };
  expect(
    terminalStraightLength(
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 80 },
      ],
      "end",
      ends,
    ),
    // 80 less the 10px corner (CORNER_RADIUS_PX, redesign slice 6).
  ).toBe(70);
  expect(
    terminalStraightLength(
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 40 },
      ],
      "end",
      ends,
    ),
  ).toBe(40);
  expect(
    terminalStraightLength(
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 20 },
        { x: 80, y: 60 },
      ],
      "end",
      ends,
    ),
  ).toBe(50);
  expect(
    terminalStraightLength(
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 40 },
        { x: 80, y: 40 },
      ],
      "end",
      ends,
    ),
  ).toBe(30);
  expect(
    terminalStraightLength(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      "end",
      ends,
    ),
  ).toBe(0);
});
