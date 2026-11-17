// @vitest-environment jsdom
//
// How the sequence canvas frames its diagram.
//
// The canvas used to mount at a fixed offset and leave the user to find the
// rest: nothing fitted it, the host's `viewport` instruction never reached it,
// and pan/zoom was a CSS transform on the `<svg>` itself -- which moves the
// element AFTER it has clipped to its own box, so anything laid out at a
// negative coordinate, or panned in from outside the first screenful, was
// simply not painted. These pin the replacement behaviour. jsdom lays nothing
// out, so no absolute geometry is asserted: only which framing is which.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_PAN_ZOOM,
  SEQUENCE_READING,
  SequenceCanvas,
  framePanZoom,
  sequenceOverflow,
  viewportTransform,
} from "../src/diagrams/SequenceCanvas";
import { messageBox } from "../src/diagrams/sequence-nav";
import { readingZoom } from "../src/diagrams/viewport-fit";
import { FRAGMENT_FONT } from "../src/layout/sequence-layout";
import { computeSequenceLayout, type SequenceLayoutResult } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { loadValidFixture } from "./fixtures";

function sequenceLayout(): SequenceLayoutResult {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence") {
    throw new Error("minimal-sequence.json did not project to a sequence view");
  }
  return computeSequenceLayout(projection.view);
}

afterEach(cleanup);

const viewportGroup = (container: HTMLElement): SVGGElement =>
  container.querySelector("g.archer-seq-viewport") as SVGGElement;
const transformOf = (container: HTMLElement): string => viewportGroup(container).getAttribute("transform") ?? "";
const panAway = (container: HTMLElement): void => {
  fireEvent.wheel(container.querySelector(".archer-seq-canvas")!, { deltaX: 4000, deltaY: 4000 });
};

describe("framePanZoom", () => {
  const { min, max } = SEQUENCE_READING;

  it("offsets by the layout's origin, so marks left of zero are inside the frame", () => {
    const framed = framePanZoom({ originX: -40, originY: 0, width: 400, height: 200 }, { width: 1000, height: 600 });
    // Centred across: the left edge of the content (-40) lands where a
    // 400-wide drawing at the ceiling is centred; and it starts at the top.
    expect(framed.scale).toBe(max);
    expect(framed.x + -40 * framed.scale).toBeCloseTo((1000 - 400 * max) / 2, 9);
    expect(framed.y).toBe(20);
  });

  it("keeps a long diagram readable and starts it at the top instead of shrinking it to fit", () => {
    // Fitting 3000 units of height into 600 would be a scale of ~0.19 --
    // every label illegible. Hold a readable scale and let the reader scroll.
    const framed = framePanZoom({ originX: 0, originY: 0, width: 500, height: 3000 }, { width: 1000, height: 600 });
    expect(framed.scale).toBe(min);
    expect(framed.y).toBe(20);
  });

  it("falls back to the initial framing for a box that is not a viewport yet", () => {
    expect(framePanZoom({ originX: 0, originY: 0, width: 500, height: 300 }, { width: 0, height: 0 })).toEqual(
      INITIAL_PAN_ZOOM,
    );
  });

  it("keeps the policy every canvas keeps, held to its own smallest reading text", () => {
    // One policy (`READING_TEXT_PX`), so the canvases cannot come to disagree;
    // the sequence's floor is its fragment conditions', a pixel under a
    // message, and so above a graph's.
    expect(SEQUENCE_READING).toEqual(readingZoom("sequence"));
    expect(FRAGMENT_FONT * min).toBeCloseTo(12, 9);
    expect(min).toBeGreaterThan(readingZoom("flowchart").min);
    // Too wide and too long at once: the floor holds, from the top left.
    const framed = framePanZoom({ originX: 0, originY: 0, width: 4000, height: 3000 }, { width: 1000, height: 600 });
    expect(framed.scale).toBe(min);
    expect(framed.x).toBe(20);
    expect(framed.y).toBe(20);
  });

  it("shows a diagram whole when that takes it no lower than the floor", () => {
    // (600 - 40) / 495: inside the band, so all of it, inside the gutters.
    const framed = framePanZoom({ originX: 0, originY: 0, width: 700, height: 495 }, { width: 1000, height: 600 });
    expect(framed.scale).toBeCloseTo(560 / 495, 10);
    expect(framed.y + 495 * framed.scale).toBeLessThanOrEqual(600 - 20 + 1e-6);
  });

  it("holds the floor, from the top, for a diagram that would need less to be shown whole", () => {
    // (600 - 40) / 1000 = 0.56: every label would be under 7px. It opens on
    // its first rows at a size that reads, and the rest is a scroll away.
    const framed = framePanZoom({ originX: 0, originY: 0, width: 900, height: 1000 }, { width: 1000, height: 600 });
    expect(framed.scale).toBe(min);
    expect(framed.y).toBe(20);
    expect(framed.y + 1000 * framed.scale).toBeGreaterThan(600);
  });

  it("treats a diagram that needs exactly the floor as one that fits", () => {
    // The floor is a derived decimal; a comparison that lost to rounding would
    // refuse the one diagram the floor was meant to admit.
    const height = (600 - 40) / min;
    const framed = framePanZoom({ originX: 0, originY: 0, width: 300, height }, { width: 1000, height: 600 });
    expect(framed.scale).toBeCloseTo(min, 10);
    expect(framed.y + height * framed.scale).toBeLessThanOrEqual(600 - 20 + 1e-6);
  });
});

describe("what a framing leaves off screen", () => {
  // A sequence diagram is as long as its conversation, so the canvas holds a
  // readable scale and starts at the top -- with the rest of the conversation
  // below the fold and, until now, nothing to say there was any.
  const layout = sequenceLayout();
  const messageRows = layout.messages.map((message) => messageBox(message));

  it("counts messages below and participants to the side", () => {
    // At full size, with the drawing's own top-left corner in the canvas's (a
    // fragment frame reaches left of zero, so that corner is not the origin),
    // in a box that holds neither the last column nor the last rows.
    const camera = { x: -layout.originX, y: -layout.originY, scale: 1 };
    const last = layout.participants[layout.participants.length - 1];
    const box = { width: last.x + camera.x + 10, height: layout.messages[1].y + camera.y + 6 };
    const found = sequenceOverflow(layout, camera, box);

    const below = messageRows.filter((row) => row.y + row.height / 2 + camera.y > box.height).length;
    expect(below).toBeGreaterThan(0);
    expect(below).toBeLessThan(layout.messages.length);
    expect(found).toEqual([
      // Its box begins 10px inside the right edge, so its middle is past it.
      { side: "right", count: 1 },
      { side: "bottom", count: below },
    ]);
  });

  it("says nothing of a diagram framed whole", () => {
    const box = { width: 2400, height: 2400 };
    expect(sequenceOverflow(layout, framePanZoom(layout, box), box)).toEqual([]);
  });

  it("says nothing before there is a box to measure against", () => {
    // jsdom, or a canvas mounted hidden: no viewport, so no claim about it.
    expect(sequenceOverflow(layout, INITIAL_PAN_ZOOM, { width: 0, height: 0 })).toEqual([]);
  });
});

describe("the off-screen cue on the sequence canvas", () => {
  /**
   * Gives the canvas a box. jsdom lays nothing out, and the component measures
   * its container at the moment it frames, so that one measurement is stood in
   * for -- on the canvas element only, so nothing else's box changes.
   */
  function withCanvasBox(width: number, height: number): void {
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("archer-seq-canvas")
        ? ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect)
        : real.call(this);
    });
  }
  afterEach(() => vi.restoreAllMocks());

  const layout = sequenceLayout();
  const cues = (container: HTMLElement): string[] =>
    [...container.querySelectorAll(".archer-offscreen-cue")].map((cue) => cue.getAttribute("aria-label") ?? "");
  /** The camera the canvas is showing, read back from the transform it drew. */
  function camera(container: HTMLElement): { x: number; y: number; scale: number } {
    const match = /^translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)$/.exec(transformOf(container));
    expect(match, `unreadable transform ${transformOf(container)}`).not.toBeNull();
    return { x: Number(match![1]), y: Number(match![2]), scale: Number(match![3]) };
  }
  // Wide enough for every participant, far too short for the conversation.
  const SHORT = { width: 1200, height: 180 };

  it("says how many messages the first framing left below the fold", () => {
    withCanvasBox(SHORT.width, SHORT.height);
    const { container } = render(<SequenceCanvas layout={layout} />);

    const expected = sequenceOverflow(layout, camera(container), SHORT);
    expect(expected.map((entry) => entry.side)).toEqual(["bottom"]);
    expect(expected[0].count).toBeGreaterThan(0);
    expect(cues(container)).toEqual([`${expected[0].count} more below. Show all`]);
    expect(container.querySelector(".archer-offscreen-status")).toHaveTextContent(`${expected[0].count} more below`);
  });

  it("says nothing when the whole conversation is in view", () => {
    withCanvasBox(2400, 2400);
    const { container } = render(<SequenceCanvas layout={layout} />);
    expect(cues(container)).toEqual([]);
    expect(container.querySelector(".archer-offscreen-status")).toBeEmptyDOMElement();
  });

  it("shows all of it when pressed, and then has nothing left to say", () => {
    withCanvasBox(SHORT.width, SHORT.height);
    const { container } = render(<SequenceCanvas layout={layout} />);
    const opened = transformOf(container);

    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    const shown = transformOf(container);
    expect(shown).not.toBe(opened);
    expect(sequenceOverflow(layout, camera(container), SHORT)).toEqual([]);
    expect(cues(container)).toEqual([]);

    // `1` (Fit view) shows all of it too, as the cue's Show all does (AM-R1-02, round1-f17.test.tsx).
    panAway(container);
    fireEvent.keyDown(window, { key: "1" });
    expect(transformOf(container)).toBe(shown);
    expect(cues(container)).toEqual([]);
  });

  // The conversation shown whole in a 180px-tall box is far below the size at
  // which a name can be made out. The fit kept its promise, and the canvas
  // says the rest (adversarial review 2026-10-02, F7).
  it("says when all of it is too small to read, and goes back to a size that reads", () => {
    withCanvasBox(SHORT.width, SHORT.height);
    const { container } = render(<SequenceCanvas layout={layout} />);
    const opened = transformOf(container);

    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(camera(container).scale).toBeLessThan(0.5);

    const overview = screen.getByRole("button", { name: /too small to read/ });
    expect(overview).toHaveAccessibleName(
      `All ${layout.messages.length} messages shown, too small to read. Zoom to read`,
    );
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    expect(container.querySelector(".archer-offscreen-status")).toHaveTextContent(
      `All ${layout.messages.length} messages are shown, too small to read. Zoom in to explore.`,
    );

    fireEvent.click(overview);
    expect(transformOf(container)).toBe(opened);
    expect(screen.queryByRole("button", { name: /too small to read/ })).toBeNull();
    expect(cues(container)).toHaveLength(1);
  });

  it("withdraws that once the reader takes the camera", () => {
    withCanvasBox(SHORT.width, SHORT.height);
    const { container } = render(<SequenceCanvas layout={layout} />);
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(screen.getByRole("button", { name: /too small to read/ })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(screen.queryByRole("button", { name: /too small to read/ })).toBeNull();
  });

  it.each([
    [
      "scrolled",
      (container: HTMLElement) => fireEvent.wheel(container.querySelector(".archer-seq-canvas")!, { deltaY: 60 }),
    ],
    ["zoomed from the control cluster", () => fireEvent.click(screen.getByRole("button", { name: "Zoom out" }))],
    [
      "dragged the canvas",
      (container: HTMLElement) => {
        const canvas = container.querySelector(".archer-seq-canvas")!;
        fireEvent.pointerDown(canvas, { button: 0, clientX: 300, clientY: 100, pointerId: 1 });
        fireEvent.pointerMove(canvas, { clientX: 300, clientY: 60, pointerId: 1 });
        fireEvent.pointerUp(canvas, { pointerId: 1 });
      },
    ],
  ] as const)("goes once the reader has %s", (_gesture, act) => {
    withCanvasBox(SHORT.width, SHORT.height);
    const { container } = render(<SequenceCanvas layout={layout} />);
    expect(cues(container)).toHaveLength(1);

    act(container);

    expect(cues(container)).toEqual([]);
  });

  it("comes back when the host frames the diagram again", () => {
    withCanvasBox(SHORT.width, SHORT.height);
    const { container, rerender } = render(<SequenceCanvas layout={layout} viewport={{ mode: "fit-all", key: 1 }} />);
    panAway(container);
    expect(cues(container)).toEqual([]);

    rerender(<SequenceCanvas layout={layout} viewport={{ mode: "fit-all", key: 2 }} />);
    expect(cues(container)).toHaveLength(1);
  });

  it("says nothing of a framing the host aimed at a focus", () => {
    // The rest of the diagram is off screen there because the host asked for
    // a closer look, not for want of room.
    withCanvasBox(SHORT.width, SHORT.height);
    const { container } = render(
      <SequenceCanvas
        layout={layout}
        focus={{ messageIds: [layout.messages[0].id] }}
        viewport={{ mode: "fit-focus", key: 1 }}
      />,
    );
    expect(cues(container)).toEqual([]);
  });
});

describe("SequenceCanvas viewport", () => {
  it("pans and zooms an inner group, never the svg element that clips", () => {
    const { container } = render(<SequenceCanvas layout={sequenceLayout()} />);
    const svg = container.querySelector("svg.archer-seq-svg") as SVGSVGElement;

    expect(svg.style.transform).toBe("");
    expect(transformOf(container)).toMatch(/^translate\(/);
  });

  it("frames the diagram on mount instead of parking it at a fixed offset", () => {
    const { container } = render(<SequenceCanvas layout={sequenceLayout()} />);
    expect(transformOf(container)).not.toBe(viewportTransform(INITIAL_PAN_ZOOM));
  });

  it("reframes when the host sends a new fit instruction", () => {
    const layout = sequenceLayout();
    const { container, rerender } = render(<SequenceCanvas layout={layout} viewport={{ mode: "fit-all", key: 1 }} />);
    const framed = transformOf(container);

    panAway(container);
    expect(transformOf(container)).not.toBe(framed);

    rerender(<SequenceCanvas layout={layout} viewport={{ mode: "fit-all", key: 2 }} />);
    expect(transformOf(container)).toBe(framed);
  });

  it("leaves the reader's pan alone when the host says preserve, or says nothing new", () => {
    const layout = sequenceLayout();
    const { container, rerender } = render(<SequenceCanvas layout={layout} viewport={{ mode: "fit-all", key: 1 }} />);
    panAway(container);
    const panned = transformOf(container);

    // A live reload: a new layout object under the same instruction.
    rerender(<SequenceCanvas layout={{ ...layout }} viewport={{ mode: "fit-all", key: 1 }} />);
    expect(transformOf(container)).toBe(panned);

    rerender(<SequenceCanvas layout={layout} viewport={{ mode: "preserve", key: 2 }} />);
    expect(transformOf(container)).toBe(panned);
  });

  it("offers zoom and fit as buttons, not only as gestures", () => {
    const { container } = render(<SequenceCanvas layout={sequenceLayout()} />);
    const framed = transformOf(container);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomed = transformOf(container);
    expect(zoomed).not.toBe(framed);

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(transformOf(container)).not.toBe(zoomed);

    // `Fit view` and the `1` key are the same request: all of it.
    fireEvent.keyDown(window, { key: "1" });
    const fitted = transformOf(container);
    panAway(container);
    fireEvent.click(screen.getByRole("button", { name: "Fit view" }));
    expect(transformOf(container)).toBe(fitted);
  });
});

describe("drawing the next message (smoke-b#13:b)", () => {
  afterEach(() => vi.restoreAllMocks());
  it("brings a message whose label opens into view, with lifeline room below it to draw the next", () => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("archer-seq-canvas")
        ? ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 1200,
            bottom: 180,
            width: 1200,
            height: 180,
            toJSON: () => ({}),
          } as DOMRect)
        : real.call(this);
    });
    const layout = sequenceLayout();
    const last = [...layout.messages].sort((a, b) => a.y - b.y).at(-1)!;
    const props = { layout, onMessageDraw: () => {} };
    const { container, rerender } = render(<SequenceCanvas {...props} />);
    rerender(<SequenceCanvas {...props} editingLabel={{ channel: "messages", id: last.id }} />);
    const match = /^translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)$/.exec(transformOf(container))!;
    const [y, scale] = [Number(match[2]), Number(match[3])];
    // The last message on screen, and at least a row of lifeline under it.
    expect(last.y * scale + y).toBeGreaterThan(0);
    expect((last.y + 48) * scale + y).toBeLessThanOrEqual(180);
  });
});
