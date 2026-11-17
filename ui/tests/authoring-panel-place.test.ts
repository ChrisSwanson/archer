// @vitest-environment jsdom
import { expect, test } from "vitest";
import { heightClearOfControls, panelAvoid, placePanel } from "../src/authoring/panel-place";

const area = { left: 0, top: 100, right: 1000, bottom: 700 },
  size = { width: 260, height: 280 };
const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

test("an empty canvas keeps the usual top-right panel", () => {
  expect(placePanel(area, size, [])).toEqual({ left: 725, top: 115 });
});
test("shapes under the top-right corner send the panel to the corner that covers fewest (smoke-b state-gestures: Execute under the panel)", () => {
  expect(placePanel(area, size, [{ box: box(800, 150, 120, 40), weight: 1 }])).toEqual({ left: 725, top: 405 });
});
test("the canvas controls are never covered, even to keep shapes clear (smoke-b layering: message panel over the controls)", () => {
  const controls = { box: box(15, 450, 52, 196), weight: 1000 };
  const right = [{ box: box(760, 130, 200, 520), weight: 1 }];
  expect(placePanel(area, size, [controls, ...right])).toEqual({ left: 15, top: 115 });
});

/*
 * smoke-a flow-existing and smoke-b state-gestures: with a connection selected, its panel took the drawing's
 * bottom-right corner, over the Source toggle (and under the chat button), so Source could not be clicked until the
 * selection was cleared. The panel keeps clear of both, as it does of the zoom cluster.
 */
test('the selection panel never covers the Source toggle or the chat button (smoke-b state-gestures: "Selected connection" over Source)', () => {
  const doc = new DOMParser().parseFromString("<body></body>", "text/html");
  const boxes = new Map<Element, ReturnType<typeof box>>();
  const el = (parent: Element, className: string, b: ReturnType<typeof box>) => {
    const e = doc.createElement("div");
    e.className = className;
    parent.appendChild(e);
    boxes.set(e, b);
    return e;
  };
  const canvas = el(doc.body, "authoring-preview", box(64, 136, 1376, 732));
  el(canvas, "archer-canvas-controls authoring-edit-cluster", box(80, 150, 206, 44));
  el(canvas, "archer-canvas-controls", box(80, 658, 51, 194));
  el(canvas, "react-flow__node", box(1200, 200, 160, 54));
  const source = el(canvas, "archer-reader-source authoring-preview-source", box(1270, 816, 90, 36));
  const fab = el(doc.body, "archer-chat-fab", box(1372, 832, 52, 52));
  for (const [e, b] of boxes)
    e.getBoundingClientRect = () => ({
      ...b,
      x: b.left,
      y: b.top,
      width: b.right - b.left,
      height: b.bottom - b.top,
      toJSON: () => b,
    });
  const area = boxes.get(canvas)!,
    size = { width: 266, height: 158 };
  const at = placePanel(area, size, panelAvoid(canvas, null)),
    panel = box(at.left, at.top, size.width, size.height);
  const overlaps = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  expect(overlaps(panel, boxes.get(source)!)).toBe(false);
  expect(overlaps(panel, boxes.get(fab)!)).toBe(false);
});
test("kept off the Source toggle, the panel lifts above it rather than cover a shape that is a drop target (smoke-b state-gestures: reattach onto Notify under the panel)", () => {
  const area = box(64, 136, 1376, 732),
    size = { width: 266, height: 158 };
  const avoid = [
    { box: box(80, 150, 206, 44), weight: 1000 },
    { box: box(80, 658, 51, 194), weight: 1000 }, // editing and zoom clusters
    { box: box(1270, 820, 90, 32), weight: 1000 },
    { box: box(1372, 832, 52, 52), weight: 1000 }, // Source, chat button
    { box: box(1203, 283, 240, 180), weight: 1 },
    { box: box(134, 375, 165, 54), weight: 1 }, // Working (top right), Notify (top left)
  ];
  const at = placePanel(area, size, avoid),
    panel = box(at.left, at.top, size.width, size.height);
  expect(
    avoid.every(
      (item) =>
        !(
          panel.left < item.box.right &&
          item.box.left < panel.right &&
          panel.top < item.box.bottom &&
          item.box.top < panel.bottom
        ),
    ),
  ).toBe(true);
});

test("a panel over a short canvas stops above the Source toggle below it instead of covering it", () => {
  // Measured on macOS (2026-11-11): the Source drawer open, the message panel top-right at 249 and 270 tall, the
  // Source toggle at the drawing's foot 510-541 under it: placePanel's least-covering corner still overlapped it 9px.
  const toggle = { box: { left: 1269, top: 510, right: 1360, bottom: 541 }, weight: 1000 };
  const zoom = { box: { left: 80, top: 347, right: 130, bottom: 541 }, weight: 1000 };
  const place = { left: 1159, top: 249 };
  expect(heightClearOfControls(place, 266, [toggle, zoom])).toBe(510 - 8 - 249);
  // A control beside the panel, or above its top, does not limit it; shapes (weight 1) never do.
  expect(heightClearOfControls(place, 266, [zoom, { box: toggle.box, weight: 1 }])).toBe(Infinity);
  expect(heightClearOfControls({ left: 1159, top: 600 }, 266, [toggle])).toBe(Infinity);
});
