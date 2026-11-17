// @vitest-environment jsdom
// Editor fix-round regressions on the sequence canvas alone (the workspace-level ones are in
// editor-regressions-workspace.test.tsx).
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { computeSequenceLayout, type SequenceLayoutResult } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { loadValidFixture } from "./fixtures";

function sequenceLayout(): SequenceLayoutResult {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence")
    throw new Error("minimal-sequence.json did not project to a sequence view");
  return computeSequenceLayout(projection.view);
}
afterEach(cleanup);

/** Presses on the first lifeline and drags right across the canvas, ending with `beforeUp` then the release. */
function drawAcross(beforeUp: () => void): { onMessageDraw: ReturnType<typeof vi.fn>; container: HTMLElement } {
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
  const lifeline = container.querySelector<SVGElement>(".archer-seq-lifeline-hit")!;
  fireEvent.pointerDown(lifeline, { clientX: 100, clientY: 200, button: 0, pointerId: 1 });
  for (let x = 140; x <= 600; x += 40) fireEvent.pointerMove(canvas, { clientX: x, clientY: 200, pointerId: 1 });
  expect(container.querySelector(".archer-seq-draw-ghost")).not.toBeNull();
  beforeUp();
  fireEvent.pointerUp(canvas, { clientX: 600, clientY: 200, pointerId: 1 });
  return { onMessageDraw, container };
}

it("a message drag released normally draws a message (control for ux:F8)", () => {
  const { onMessageDraw } = drawAcross(() => {});
  expect(onMessageDraw).toHaveBeenCalledTimes(1);
});

it("Escape during a sequence draw drag cancels it: the ghost goes and nothing is sent on release (ux:F8)", () => {
  const { onMessageDraw } = drawAcross(() => {
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".archer-seq-draw-ghost")).toBeNull();
  });
  expect(onMessageDraw).not.toHaveBeenCalled();
});
