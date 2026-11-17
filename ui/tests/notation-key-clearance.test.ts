import { expect, it } from "vitest";
import { hitsAny, placeCue } from "../src/diagrams/chrome-clearance";

it("leaves heading chrome readable when a dense drawing has no free cue position", () => {
  const canvas = { width: 390, height: 600 };
  const bar = { width: 368, height: 36 };
  const heading = { x: 16, y: 10, width: 300, height: 24 };
  const position = placeCue(bar, canvas, "center", [{ x: 0, y: 0, ...canvas }, heading], [heading]);
  expect(hitsAny([heading], { x: position.left, y: position.top, ...bar })).toBe(false);
  expect(position.top + bar.height).toBeLessThanOrEqual(canvas.height);
});
