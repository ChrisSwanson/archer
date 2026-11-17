// @vitest-environment jsdom
// Drawing or dragging a message moves only its ghost: the participants, lifelines and messages are not
// re-rendered on every pointer move (the editor's render storm while drawing in the sequence-edit journey).
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { computeSequenceLayout, type SequenceLayoutResult } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { loadValidFixture } from "./fixtures";

const drawn = vi.hoisted(() => ({ lines: 0 }));
vi.mock("../src/diagrams/SequencePrimitives", async (original) => {
  const real = await original<typeof import("../src/diagrams/SequencePrimitives")>();
  return {
    ...real,
    Lines: (props: Parameters<typeof real.Lines>[0]) => {
      drawn.lines += 1;
      return real.Lines(props);
    },
  };
});
const { SequenceCanvas } = await import("../src/diagrams/SequenceCanvas");

function sequenceLayout(): SequenceLayoutResult {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence")
    throw new Error("minimal-sequence.json did not project to a sequence view");
  return computeSequenceLayout(projection.view);
}
afterEach(cleanup);

it("a message being drawn redraws its ghost, not the diagram, as the pointer moves", () => {
  const layout = sequenceLayout();
  const onMessageDraw = vi.fn();
  const { container } = render(
    <SequenceCanvas
      layout={layout}
      onMessageDraw={onMessageDraw}
      onNodeClick={() => {}}
      onEdgeClick={() => {}}
      onPaneClick={() => {}}
    />,
  );
  const canvas = container.querySelector<HTMLElement>(".archer-seq-canvas")!;
  const lifeline = container.querySelector<SVGElement>(".archer-seq-lifeline-hit")!;
  expect(lifeline).not.toBeNull();
  fireEvent.pointerDown(lifeline, { clientX: 100, clientY: 200, button: 0, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 140, clientY: 200, pointerId: 1 });
  expect(container.querySelector(".archer-seq-draw-ghost")).not.toBeNull();
  const before = drawn.lines;
  for (let x = 150; x < 400; x += 10) fireEvent.pointerMove(canvas, { clientX: x, clientY: 201, pointerId: 1 });
  expect(drawn.lines - before).toBe(0);
  expect(container.querySelector(".archer-seq-draw-ghost line")?.getAttribute("y1")).not.toBeNull();
  fireEvent.pointerUp(canvas, { clientX: 400, clientY: 201, pointerId: 1 });
  expect(container.querySelector(".archer-seq-draw-ghost")).toBeNull();
});

it.each(["pointercancel", "blur"] as const)("a draw ended by %s is cancelled, not sent (codex review)", (how) => {
  const onMessageDraw = vi.fn();
  const { container } = render(
    <SequenceCanvas
      layout={sequenceLayout()}
      onMessageDraw={onMessageDraw}
      onNodeClick={() => {}}
      onEdgeClick={() => {}}
      onPaneClick={() => {}}
    />,
  );
  const canvas = container.querySelector<HTMLElement>(".archer-seq-canvas")!;
  fireEvent.pointerDown(container.querySelector<SVGElement>(".archer-seq-lifeline-hit")!, {
    clientX: 100,
    clientY: 200,
    button: 0,
    pointerId: 1,
  });
  for (let x = 140; x < 600; x += 40) fireEvent.pointerMove(canvas, { clientX: x, clientY: 200, pointerId: 1 });
  expect(container.querySelector(".archer-seq-draw-ghost")).not.toBeNull();
  if (how === "blur") fireEvent.blur(window);
  else fireEvent.pointerCancel(canvas, { pointerId: 1 });
  expect(container.querySelector(".archer-seq-draw-ghost")).toBeNull();
  fireEvent.pointerUp(canvas, { clientX: 600, clientY: 200, pointerId: 1 });
  expect(onMessageDraw).not.toHaveBeenCalled();
});
