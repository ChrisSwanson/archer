// @vitest-environment jsdom
//
// Shift+drag marquees ON TOP OF the current selection.
//
// The union itself is a rule about state and lives in the reducer, where
// `selection-additive.test.ts` drives it directly. What is left to prove here
// is the PLUMBING: that a real drag on a real canvas tells the page a marquee
// began, and whether it was additive.
//
// The rectangle's geometry is deliberately not asserted. jsdom performs no
// layout, so which nodes a screen-space rectangle encloses is not a fact this
// environment can produce -- `canvas-interaction.test.tsx` stops at "a
// rectangle appeared" for the same reason. Asserting a node count here would
// be asserting the stubs in `setup.ts`, not the product.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";

const view: ProjectedView = {
  viewId: "marquee-view",
  kind: "c4-context",
  title: "Marquee",
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

function renderCanvas(handlers: {
  onMarqueeStart?: (additive: boolean) => void;
  onMarqueeEnd?: () => void;
}): HTMLElement {
  const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} {...handlers} />);
  fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
  return container.querySelector<HTMLElement>(".react-flow__pane")!;
}

function drag(pane: HTMLElement, options: { shiftKey: boolean }): void {
  fireEvent.pointerDown(pane, {
    button: 0,
    isPrimary: true,
    pointerId: 1,
    clientX: 20,
    clientY: 20,
    shiftKey: options.shiftKey,
  });
  fireEvent.pointerMove(pane, {
    button: 0,
    isPrimary: true,
    pointerId: 1,
    clientX: 260,
    clientY: 220,
    shiftKey: options.shiftKey,
  });
  fireEvent.pointerUp(pane, { button: 0, isPrimary: true, pointerId: 1 });
}

describe("a marquee tells the page whether it adds", () => {
  it("reports an additive start for a Shift+drag", async () => {
    const onMarqueeStart = vi.fn();
    const pane = renderCanvas({ onMarqueeStart });

    drag(pane, { shiftKey: true });

    await waitFor(() => expect(onMarqueeStart).toHaveBeenCalledWith(true));
  });

  it("reports a replacing start for a plain drag", async () => {
    const onMarqueeStart = vi.fn();
    const pane = renderCanvas({ onMarqueeStart });

    drag(pane, { shiftKey: false });

    await waitFor(() => expect(onMarqueeStart).toHaveBeenCalledWith(false));
  });

  it("reports the end, so the union stops when the drag does", async () => {
    // Without this the NEXT plain click would be merged into a selection the
    // user finished building a gesture ago.
    const onMarqueeStart = vi.fn();
    const onMarqueeEnd = vi.fn();
    const pane = renderCanvas({ onMarqueeStart, onMarqueeEnd });

    drag(pane, { shiftKey: true });

    await waitFor(() => expect(onMarqueeEnd).toHaveBeenCalled());
  });
});
