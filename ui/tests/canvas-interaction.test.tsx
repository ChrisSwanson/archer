// @vitest-environment jsdom
//
// Who owns a plain left-drag on the canvas?
//
// The canvas used to pass BOTH `panOnDrag` and `selectionOnDrag`. They cannot
// both own a plain left-drag, and React Flow resolves the clash in favour of
// pan -- `selectionOnDrag && panOnDrag !== true` in its FlowRenderer -- so
// marquee selection was only ever reachable via Shift+drag.
//
// Settled behaviour: dragging the canvas ALWAYS marquees. Panning is
// two-finger scroll, Space+drag, or middle-drag. Shift is never used for
// navigation, so it stays free for additive selection.
//
// These assertions read React Flow's OWN derived state off the pane element
// rather than echoing back the props we passed: the pane carries `selection`
// when React Flow has decided a drag starts a marquee, and `draggable` when it
// has decided a left-drag pans (`panOnDrag === true || panOnDrag.includes(0)`).
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";

const view: ProjectedView = {
  viewId: "interaction-view",
  kind: "c4-context",
  title: "Interaction",
  revision: "1",
  modelType: "architecture-graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [{ id: "e1", source: "a", target: "b", label: "calls" }],
  groups: [],
};

let layout: LayoutResult;

beforeAll(async () => {
  layout = await computeLayout(view);
});

afterEach(cleanup);

function renderPane(): HTMLElement {
  const container = render(<DiagramCanvas state={{ status: "ready", layout }} />).container;
  fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
  const pane = container.querySelector<HTMLElement>(".react-flow__pane");
  expect(pane).not.toBeNull();
  return pane!;
}

describe("canvas drag ownership", () => {
  it("gives a plain left-drag to marquee selection, not to pan", () => {
    const pane = renderPane();
    expect(pane.classList.contains("selection")).toBe(true);
    expect(pane.classList.contains("draggable")).toBe(false);
  });

  it("draws a selection rectangle from a plain left-drag", async () => {
    const pane = renderPane();

    fireEvent.pointerDown(pane, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(pane, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 160,
      clientY: 140,
    });

    await waitFor(() => {
      expect(document.querySelector(".react-flow__selection")).not.toBeNull();
    });

    fireEvent.pointerUp(pane, { button: 0, isPrimary: true, pointerId: 1 });
  });
});
