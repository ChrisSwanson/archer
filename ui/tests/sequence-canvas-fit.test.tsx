// @vitest-environment jsdom
//
// `1` on the sequence canvas.
//
// Two halves, deliberately split. The ARITHMETIC is a pure function over the
// layout's own dimensions and a viewport box, tested here with numbers,
// because jsdom lays nothing out and a test that asserted a real fitted
// transform would be asserting the geometry stubs in `setup.ts`. The WIRING is
// tested through the component, and only claims what it can honestly see: that
// `1` puts the canvas back where a fit put it, whatever that is.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  INITIAL_PAN_ZOOM,
  SEQUENCE_READING,
  SequenceCanvas,
  fitPanZoom,
  viewportTransform,
  zoomedScale,
} from "../src/diagrams/SequenceCanvas";
import { computeSequenceLayout, type SequenceLayoutResult } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { HelpProvider, type HelpController } from "../src/app/HelpOverlay";
import { loadValidFixture } from "./fixtures";

function sequenceLayout(): SequenceLayoutResult {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence") {
    throw new Error("minimal-sequence.json did not project to a sequence view");
  }
  return computeSequenceLayout(projection.view);
}

afterEach(cleanup);

describe("fitPanZoom", () => {
  it("shrinks the diagram until the whole of it fits, centred across and from the top", () => {
    // 1000x500 into 600x400 with a 20px gutter: the width is the binding
    // constraint at (600-40)/1000 = 0.56.
    expect(fitPanZoom({ width: 1000, height: 500 }, { width: 600, height: 400 })).toEqual({
      scale: 0.56,
      x: (600 - 1000 * 0.56) / 2,
      y: 20,
    });
  });

  it("takes the tighter of the two axes, so a tall diagram is not cropped", () => {
    // (400-40)/1000 = 0.36 on height, against 0.96 on width.
    const fitted = fitPanZoom({ width: 500, height: 1000 }, { width: 520, height: 400 });

    expect(fitted.scale).toBeCloseTo(0.36, 10);
    expect(fitted.y).toBe(20);
  });

  it("never magnifies a small diagram past reading size", () => {
    // Text sizes in the layout are absolute; blowing a three-box diagram up to
    // fill a wall is not what "fit" means.
    expect(fitPanZoom({ width: 100, height: 80 }, { width: 900, height: 700 }).scale).toBe(SEQUENCE_READING.max);
  });

  it("falls back to the initial framing when either box is degenerate", () => {
    // An unmeasured container (jsdom, or a canvas mounted hidden) must not
    // produce an infinite or negative scale.
    expect(fitPanZoom({ width: 1000, height: 500 }, { width: 0, height: 0 })).toEqual(INITIAL_PAN_ZOOM);
    expect(fitPanZoom({ width: 0, height: 0 }, { width: 600, height: 400 })).toEqual(INITIAL_PAN_ZOOM);
    // Narrower than the gutter it would reserve.
    expect(fitPanZoom({ width: 1000, height: 500 }, { width: 30, height: 400 })).toEqual(INITIAL_PAN_ZOOM);
  });
});

describe("an explicit fit of a diagram far larger than the window", () => {
  it("shows all of it, however small that makes it", () => {
    // Forty participants across a 420px window: 0.04. `1` and the fit control
    // promise the whole diagram, so nothing floors this.
    const fitted = fitPanZoom({ width: 9500, height: 900 }, { width: 420, height: 800 });

    expect(fitted.scale).toBeCloseTo(380 / 9500, 10);
    expect(fitted.x).toBeGreaterThanOrEqual(20 - 1e-9);
    expect(fitted.x + 9500 * fitted.scale).toBeLessThanOrEqual(420 - 20 + 1e-9);
  });
});

describe("zooming by hand", () => {
  it("stops at the hand-zoom minimum and maximum", () => {
    expect(zoomedScale(1, 0.001)).toBe(0.1);
    expect(zoomedScale(1, 1000)).toBe(3);
    expect(zoomedScale(1, 1.25)).toBe(1.25);
  });

  it("never magnifies on a zoom OUT from a fit that went below the minimum", () => {
    // Clamping 0.04 x 0.8 up to 0.1 made "zoom out" zoom in by 2.5x.
    expect(zoomedScale(0.04, 0.8)).toBe(0.04);
    // Zooming in from there is ordinary.
    expect(zoomedScale(0.04, 1.25)).toBeCloseTo(0.05, 10);
  });
});

// Pan and zoom live on the inner viewport group; the `<svg>` itself is never
// transformed, because an element clips to its own box before it is moved.
const transformOf = (container: HTMLElement): string =>
  container.querySelector("g.archer-seq-viewport")?.getAttribute("transform") ?? "";

const help = (open: boolean): HelpController => ({ open, toggle: () => {}, hide: () => {} });

describe("1 refits the sequence canvas", () => {
  it("puts a panned-away canvas back where the fit framing is", () => {
    const { container } = render(<SequenceCanvas layout={sequenceLayout()} />);

    fireEvent.keyDown(window, { key: "1" });
    const fitted = transformOf(container);

    // Pan a long way off, the dead end this binding exists to undo.
    fireEvent.wheel(container.querySelector(".archer-seq-canvas")!, { deltaX: 4000, deltaY: 4000 });
    expect(transformOf(container)).not.toBe(fitted);

    fireEvent.keyDown(window, { key: "1" });

    // No geometry is asserted -- only that the key is a reset to one framing.
    expect(transformOf(container)).toBe(fitted);
  });

  it("frames the layout it is given, rather than resetting to a constant", () => {
    // The test above cannot tell a fit from `setPanZoom(INITIAL_PAN_ZOOM)`:
    // replacing the whole implementation with that constant would pass it. This
    // one fails against that mutant, because a taller layout must be framed
    // differently from a short one -- while still asserting no absolute
    // geometry, which jsdom cannot supply.
    const short = render(<SequenceCanvas layout={sequenceLayout()} />);
    fireEvent.keyDown(window, { key: "1" });
    const shortFit = transformOf(short.container);

    cleanup();

    const tallLayout = sequenceLayout();
    const tall = render(<SequenceCanvas layout={{ ...tallLayout, height: tallLayout.height * 8 }} />);
    fireEvent.keyDown(window, { key: "1" });

    expect(transformOf(tall.container)).not.toBe(shortFit);
    // ...and neither is the untouched mount transform, so both really fitted.
    expect(shortFit).not.toBe(viewportTransform(INITIAL_PAN_ZOOM));
  });

  it("leaves the canvas alone while the cheat sheet has the keyboard", () => {
    const { container } = render(
      <HelpProvider value={help(true)}>
        <SequenceCanvas layout={sequenceLayout()} />
      </HelpProvider>,
    );

    fireEvent.wheel(container.querySelector(".archer-seq-canvas")!, { deltaX: 4000, deltaY: 4000 });
    const panned = transformOf(container);

    fireEvent.keyDown(window, { key: "1" });

    expect(transformOf(container)).toBe(panned);
  });
});
