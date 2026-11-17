// @vitest-environment jsdom
//
// The graph canvas frames what it draws -- on first load, when its box changes
// size, and when the user asks -- and leaves the camera alone once the user
// has moved it.
//
// The decision itself is pinned in `viewport-fit.test.ts`; this file proves the
// canvas APPLIES it, by reading the transform React Flow renders the viewport
// as. That is the only place the camera is observable from the DOM.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import {
  CANVAS_MIN_ZOOM,
  readingZoom,
  layoutBounds,
  overflowOf,
  overflowText,
  tooSmallToRead,
} from "../src/diagrams/viewport-fit";
import { CUE_BAND_PX } from "../src/diagrams/chrome-clearance";
import { containersView } from "./graph-samples";

/** Where an automatic framing of a flowchart stops shrinking (`readingZoom`). */
const READABLE_ZOOM_FLOOR = readingZoom("flowchart").min;

let layout: LayoutResult;

beforeAll(async () => {
  layout = await computeLayout(containersView());
});

afterEach(cleanup);

type Camera = { x: number; y: number; zoom: number };

function camera(container: HTMLElement): Camera {
  const viewport = container.querySelector<HTMLElement>(".react-flow__viewport");
  expect(viewport, "no React Flow viewport is mounted").not.toBeNull();
  const match = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(viewport!.style.transform);
  expect(match, `unreadable transform ${viewport!.style.transform}`).not.toBeNull();
  return { x: Number(match![1]), y: Number(match![2]), zoom: Number(match![3]) };
}

/**
 * Gives the canvas a box and tells React Flow about it.
 *
 * jsdom lays nothing out, so `tests/setup.ts` derives `offsetWidth` from the
 * inline style -- which for the `width: 100%` element React Flow measures
 * reads as 100. Overriding the two properties on that one element is the
 * smallest stand-in for the stage being resized, and the `resize` event is how
 * React Flow's own resize handler hears of it.
 */
async function resizeCanvas(container: HTMLElement, width: number, height: number): Promise<void> {
  const flow = container.querySelector<HTMLElement>(".react-flow__renderer");
  expect(flow).not.toBeNull();
  Object.defineProperty(flow, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(flow, "offsetHeight", { configurable: true, value: height });
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The graph's box as it lands on screen under the current camera. */
function drawnBounds(container: HTMLElement): { left: number; top: number; right: number; bottom: number } {
  const bounds = layoutBounds(layout)!;
  const { x, y, zoom } = camera(container);
  return {
    left: bounds.x * zoom + x,
    top: bounds.y * zoom + y,
    right: (bounds.x + bounds.width) * zoom + x,
    bottom: (bounds.y + bounds.height) * zoom + y,
  };
}

async function mount(): Promise<HTMLElement> {
  const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} />);
  // Framing waits for React Flow's pan/zoom instance, a tick after mount.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

async function scrollCanvas(container: HTMLElement): Promise<void> {
  const pane = container.querySelector<HTMLElement>(".react-flow__pane")!;
  await act(async () => {
    pane.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 300, clientX: 50, clientY: 50, bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the first framing", () => {
  it("shows the whole graph, inside the canvas with a gutter, when it fits readably", async () => {
    const container = await mount();
    await resizeCanvas(container, 2400, 2400);

    const drawn = drawnBounds(container);
    expect(camera(container).zoom).toBeGreaterThanOrEqual(READABLE_ZOOM_FLOOR);
    expect(drawn.left).toBeGreaterThanOrEqual(24 - 0.01);
    expect(drawn.top).toBeGreaterThanOrEqual(24 - 0.01);
    expect(drawn.right).toBeLessThanOrEqual(2400 - 24 + 0.01);
    expect(drawn.bottom).toBeLessThanOrEqual(2400 - 24 + 0.01);
  });

  it("starts a graph that cannot fit readably at its first layer, never mid-graph", async () => {
    const container = await mount();
    await resizeCanvas(container, 1440, 795);

    // React Flow's own fit clamped to 0.5 here and centred, which put the
    // first and the last node both outside the canvas.
    expect(camera(container).zoom).toBe(READABLE_ZOOM_FLOOR);
    // Under the band the framing keeps free for the cue that says there is more.
    expect(drawnBounds(container).top).toBeCloseTo(CUE_BAND_PX, 1);
  });
});

describe("a change in the canvas box", () => {
  it("re-frames a canvas the user has not moved", async () => {
    const container = await mount();
    await resizeCanvas(container, 2400, 2400);
    const before = camera(container);

    // The tab strip and the dataflow bar arrive after first paint and take
    // their height out of the stage, and the comments panel opens beside it.
    // Tall enough for the whole graph at a readable zoom, now that every
    // caption keeps a lead of line clear on each side (ADR 0030).
    await resizeCanvas(container, 2000, 2200);

    const after = camera(container);
    expect(after).not.toEqual(before);
    expect(drawnBounds(container).bottom).toBeLessThanOrEqual(2200 - 24 + 0.01);
  });

  it("does not pull back a camera the user has moved", async () => {
    const container = await mount();
    await resizeCanvas(container, 2400, 2400);
    const fitted = camera(container);

    await scrollCanvas(container);
    const moved = camera(container);
    expect(moved, "the scroll did not move the canvas").not.toEqual(fitted);

    await resizeCanvas(container, 2400, 1800);
    expect(camera(container)).toEqual(moved);
  });

  it("does not pull back a camera the user has zoomed from the control cluster", async () => {
    const container = await mount();
    await resizeCanvas(container, 2400, 2400);
    const fitted = camera(container);

    fireEvent.click(screen.getByRole("button", { name: /zoom out/i }));
    await waitFor(() => {
      expect(camera(container).zoom).toBeLessThan(fitted.zoom);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const zoomed = camera(container);

    await resizeCanvas(container, 2400, 1800);
    expect(camera(container)).toEqual(zoomed);
  });
});

describe("the fit control", () => {
  it("shows the whole graph where it does not fit at a size that reads, and no cue says more is left (AM-R1-02)", async () => {
    const container = await mount();
    await resizeCanvas(container, 1440, 795);
    expect(drawnBounds(container).bottom).toBeGreaterThan(795);

    fireEvent.click(screen.getByRole("button", { name: /fit view/i }));

    await waitFor(() => {
      expect(drawnBounds(container).bottom).toBeLessThanOrEqual(795);
    });
    expect(camera(container).zoom).toBeLessThan(readingZoom("flowchart").min);
    expect(drawnBounds(container).top).toBeGreaterThanOrEqual(0);
    expect(container.querySelectorAll(".archer-offscreen-cue")).toHaveLength(0);
  });

  // The cue's "Show all" is the overview: no floor under it at all.
  const showAll = (): void => {
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
  };

  it("shows the whole graph from the cue even where that takes it below the hand-zoom minimum", async () => {
    // A window so small that the graph needs less than 0.1: the fit used to
    // stop there and leave the rest off screen with the control already spent.
    const container = await mount();
    const bounds = layoutBounds(layout)!;
    const width = Math.round(bounds.width * 0.05) + 48;
    await resizeCanvas(container, width, 2400);

    showAll();

    await waitFor(() => {
      expect(drawnBounds(container).right).toBeLessThanOrEqual(width - 24 + 0.01);
    });
    expect(drawnBounds(container).left).toBeGreaterThanOrEqual(24 - 0.01);
    expect(camera(container).zoom).toBeLessThan(CANVAS_MIN_ZOOM);
  });

  it("lets the hand-zoom limit follow an overview that went below it", async () => {
    // The camera is set directly, so the fit itself is not clamped -- but the
    // next hand zoom is. With the limit left at 0.1, one step IN from 0.05
    // jumped to 0.1 and no step out came back.
    const container = await mount();
    const bounds = layoutBounds(layout)!;
    await resizeCanvas(container, Math.round(bounds.width * 0.05) + 48, 2400);
    showAll();
    await waitFor(() => {
      expect(camera(container).zoom).toBeLessThan(CANVAS_MIN_ZOOM);
    });
    const tick = (): Promise<void> =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    await tick();
    const fitted = camera(container).zoom;
    // Nothing further out than "everything": the control says so.
    expect(screen.getByRole("button", { name: /zoom out/i })).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    await waitFor(() => {
      expect(camera(container).zoom).toBeGreaterThan(fitted);
    });
    expect(camera(container).zoom, "one step in is one step, not a jump to the old minimum").toBeLessThan(
      CANVAS_MIN_ZOOM,
    );
    await tick();

    fireEvent.click(screen.getByRole("button", { name: /zoom out/i }));
    await waitFor(() => {
      expect(camera(container).zoom).toBeCloseTo(fitted, 6);
    });
  });

  it("takes the camera back from the user, and follows the canvas box again", async () => {
    const container = await mount();
    await resizeCanvas(container, 2400, 2400);
    await scrollCanvas(container);

    fireEvent.click(screen.getByRole("button", { name: /fit view/i }));
    await resizeCanvas(container, 2400, 1800);

    expect(drawnBounds(container).top).toBeGreaterThanOrEqual(24 - 0.01);
    expect(drawnBounds(container).bottom).toBeLessThanOrEqual(1800 - 24 + 0.01);
  });
});

describe("the off-screen cue", () => {
  // The floor means the first framing can leave layers below the fold, and
  // nothing used to say so. What is counted is `overflowOf`'s business and is
  // pinned in `viewport-fit.test.ts`; here, that the canvas asks it about the
  // camera it really applied, and takes the cue down when it should.
  const cues = (container: HTMLElement): HTMLElement[] => [
    ...container.querySelectorAll<HTMLElement>(".archer-offscreen-cue"),
  ];
  const announced = (container: HTMLElement): string =>
    container.querySelector(".archer-offscreen-status")?.textContent ?? "";

  /** What `overflowOf` says of the camera the canvas is showing right now. */
  function expected(container: HTMLElement, canvas: { width: number; height: number }): string[] {
    const boxes = layout.nodes.map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }));
    return overflowOf(layoutBounds(layout)!, { across: boxes, down: boxes }, camera(container), canvas).map(
      (entry) => `${overflowText(entry)}. Show all`,
    );
  }

  it("says what the first framing left below the fold, counted from the camera it applied", async () => {
    const container = await mount();
    await resizeCanvas(container, 1440, 500);

    const said = cues(container).map((cue) => cue.getAttribute("aria-label"));
    expect(said).toEqual(expected(container, { width: 1440, height: 500 }));
    // ...and that is a real count of real nodes, below, and nothing else.
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^\d+ more below\. Show all$/);
    expect(announced(container)).toMatch(/^Part of the diagram is off screen: \d+ more below\./);
  });

  it("says nothing when the whole graph is in view", async () => {
    const container = await mount();
    await resizeCanvas(container, 2400, 2400);

    expect(cues(container)).toHaveLength(0);
    expect(announced(container)).toBe("");
  });

  it("shows all of it when pressed, and stops offering to", async () => {
    const container = await mount();
    await resizeCanvas(container, 1440, 500);

    fireEvent.click(cues(container)[0]);

    await waitFor(() => {
      expect(drawnBounds(container).bottom).toBeLessThanOrEqual(500 - 24 + 0.01);
    });
    expect(drawnBounds(container).top).toBeGreaterThanOrEqual(24 - 0.01);
    expect(camera(container).zoom).toBeLessThan(READABLE_ZOOM_FLOOR);
    expect(cues(container)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  /*
   * ...AND WHAT IT HAS LEFT TO SAY (adversarial review 2026-10-02, F7). This
   * graph shown whole in a 500px-tall window is below the size at which a
   * label can be made out. The fit kept its promise; the canvas says the rest
   * -- none of it reads -- and offers the framing that does. It used to say
   * nothing here, and this test asserted that it said nothing.
   */
  it("says when showing all of it is too small to read, and offers the way back", async () => {
    const container = await mount();
    await resizeCanvas(container, 1440, 500);
    const opened = camera(container);

    fireEvent.click(cues(container)[0]);
    await waitFor(() => expect(cues(container)).toHaveLength(0));
    expect(tooSmallToRead(camera(container).zoom), "the fixture has to land below the threshold").toBe(true);

    const overview = screen.getByRole("button", { name: /too small to read/ });
    expect(overview).toHaveAccessibleName(`All ${layout.nodes.length} nodes shown, too small to read. Zoom to read`);
    expect(announced(container)).toBe(
      `All ${layout.nodes.length} nodes are shown, too small to read. Zoom in to explore.`,
    );

    fireEvent.click(overview);

    // Back to the framing it opened on: readable, from where reading starts.
    await waitFor(() => expect(camera(container).zoom).toBeCloseTo(opened.zoom, 6));
    expect(camera(container).zoom).toBeGreaterThanOrEqual(READABLE_ZOOM_FLOOR - 1e-9);
    expect(screen.queryByRole("button", { name: /too small to read/ })).toBeNull();
    expect(cues(container)).toHaveLength(1);
  });

  it("withdraws the overview's claim once the reader takes the camera", async () => {
    const container = await mount();
    await resizeCanvas(container, 1440, 500);
    fireEvent.click(cues(container)[0]);
    await screen.findByRole("button", { name: /too small to read/ });

    await scrollCanvas(container);

    expect(screen.queryByRole("button", { name: /too small to read/ })).toBeNull();
    expect(announced(container)).toBe("");
  });

  it("says nothing about an overview that still reads", async () => {
    const container = await mount();
    // A window in which all of it fits at a size that reads.
    await resizeCanvas(container, 2400, 2400);

    fireEvent.click(screen.getByRole("button", { name: /fit view/i }));

    await waitFor(() => expect(cues(container)).toHaveLength(0));
    expect(tooSmallToRead(camera(container).zoom)).toBe(false);
    expect(screen.queryByRole("button", { name: /too small to read/ })).toBeNull();
    expect(announced(container)).toBe("");
  });

  it("goes once the reader has taken the camera by scrolling", async () => {
    const container = await mount();
    await resizeCanvas(container, 1440, 500);
    expect(cues(container)).toHaveLength(1);

    await scrollCanvas(container);

    // Still off screen, no doubt -- but the camera is theirs now, and a cue
    // that chased every pan would be a counter, not a cue.
    expect(cues(container)).toHaveLength(0);
  });

  it("goes once the reader has zoomed from the control cluster", async () => {
    const container = await mount();
    await resizeCanvas(container, 1440, 500);
    expect(cues(container)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /zoom out/i }));

    await waitFor(() => expect(cues(container)).toHaveLength(0));
  });

  it("follows the canvas box while the camera is still the canvas's own", async () => {
    const container = await mount();
    await resizeCanvas(container, 1440, 500);
    expect(cues(container)).toHaveLength(1);

    // The window grows until everything fits: the framing follows, and so
    // does what it has to say about itself.
    await resizeCanvas(container, 2400, 2400);
    expect(cues(container)).toHaveLength(0);

    await resizeCanvas(container, 1440, 500);
    expect(cues(container).map((cue) => cue.getAttribute("aria-label"))).toEqual(
      expected(container, { width: 1440, height: 500 }),
    );
  });

  it("is canvas chrome: the last-valid drawing under an error banner has it too", async () => {
    // Nothing on that drawing can be selected, but it is still framed, and
    // `1` and the fit control still work there. So does the cue.
    const { container } = render(<DiagramCanvas state={{ status: "error", message: "broken", lastValid: layout }} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await resizeCanvas(container, 1440, 500);
    expect(cues(container)).toHaveLength(1);
  });
});
