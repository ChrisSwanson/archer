// @vitest-environment jsdom
//
// The cue that says a diagram continues past the edge of the canvas.
//
// An automatic fit holds a readable floor, so a big diagram can open with part
// of itself off screen -- and nothing used to say so. The cue is the smallest
// thing that does: one quiet pill per edge the content runs past, in plain
// words ("6 more to the right"), that IS the button to see everything.
//
// What is decided where: `overflowOf` (pinned in `viewport-fit.test.ts`)
// decides what is off screen; the canvases decide when to ask (their own fit
// tests); this file pins the control itself -- what it says, to whom, and
// what it does.
import type { JSX } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OffscreenCue } from "../src/diagrams/OffscreenCue";
import { CHROME_GAP_PX, CUE_BAND_PX } from "../src/diagrams/chrome-clearance";
import type { Overflow } from "../src/diagrams/viewport-fit";
import { declarationsOf, readStylesheet, rulesOf } from "./stylesheet";

afterEach(cleanup);

/** The announcer: one polite live region, found by what it is for. */
function announcer(): HTMLElement {
  const region = document.querySelector<HTMLElement>(".archer-offscreen-status");
  expect(region, "the cue's live region").not.toBeNull();
  return region!;
}

const RIGHT: readonly Overflow[] = [{ side: "right", count: 6 }];
const BOTH: readonly Overflow[] = [
  { side: "right", count: 2 },
  { side: "bottom", count: 12 },
];

describe("with everything in view", () => {
  it("draws no pill and offers nothing to press", () => {
    const { container } = render(<OffscreenCue overflow={[]} onShowAll={vi.fn()} />);
    expect(container.querySelectorAll(".archer-offscreen-cue")).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps its announcer mounted and silent, so a later cue is announced rather than merely inserted", () => {
    // A live region has to be in the page BEFORE its text changes; one that
    // arrives already holding its text is not reliably read out.
    render(<OffscreenCue overflow={[]} onShowAll={vi.fn()} />);
    expect(announcer()).toBeEmptyDOMElement();
  });
});

/*
 * EVERYTHING IN VIEW, AND TOO SMALL TO READ (adversarial review 2026-10-02,
 * F7). "Show all" did what it said; the pill stops offering it and says the
 * rest of the truth, with the way back to a size that reads.
 */
describe("with all of a large diagram in view, too small to read", () => {
  it("says so, and offers to zoom to a size that reads instead of promising more", () => {
    const onZoomToRead = vi.fn();
    const onShowAll = vi.fn();
    render(<OffscreenCue overflow={[]} overview="200 nodes" onShowAll={onShowAll} onZoomToRead={onZoomToRead} />);

    const pill = screen.getByRole("button");
    expect(pill).toHaveAccessibleName("All 200 nodes shown, too small to read. Zoom to read");
    expect(within(pill).getByText("All 200 nodes shown · too small to read")).toBeInTheDocument();
    expect(within(pill).getByText("Zoom to read")).toBeInTheDocument();
    expect(screen.queryByText("Show all"), "the promise that was just kept is not made again").toBeNull();
    // Not the off-screen cue: nothing is off screen.
    expect(pill).toHaveClass("archer-overview-cue");
    expect(document.querySelectorAll(".archer-offscreen-cue")).toHaveLength(0);

    fireEvent.click(pill);
    expect(onZoomToRead).toHaveBeenCalledTimes(1);
    expect(onShowAll).not.toHaveBeenCalled();
  });

  it("tells a screen reader, once, in the same live region", () => {
    const { rerender } = render(<OffscreenCue overflow={[]} overview={null} onShowAll={vi.fn()} />);
    expect(announcer()).toBeEmptyDOMElement();

    rerender(<OffscreenCue overflow={[]} overview="300 messages" onShowAll={vi.fn()} />);
    expect(announcer()).toHaveTextContent("All 300 messages are shown, too small to read. Zoom in to explore.");
  });

  it("gives way to the off-screen cue: a diagram is not both all in view and partly off screen", () => {
    render(<OffscreenCue overflow={RIGHT} overview="200 nodes" onShowAll={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button")).toHaveAccessibleName("6 more to the right. Show all");
    expect(document.querySelectorAll(".archer-overview-cue")).toHaveLength(0);
  });
});

describe("with part of the diagram off screen", () => {
  it("says how much, in plain words, on a button that offers to show all of it", () => {
    render(<OffscreenCue overflow={RIGHT} onShowAll={vi.fn()} />);
    const pill = screen.getByRole("button", { name: /6 more to the right/ });
    expect(pill).toHaveAccessibleName("6 more to the right. Show all");
    // Both halves are on the page as text, not only in the accessibility tree.
    expect(within(pill).getByText("6 more to the right")).toBeInTheDocument();
    expect(within(pill).getByText("Show all")).toBeInTheDocument();
  });

  it("does what it offers", () => {
    const onShowAll = vi.fn();
    render(<OffscreenCue overflow={RIGHT} onShowAll={onShowAll} />);
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it("is a native button in the tab order, so the keyboard reaches and presses it unaided", () => {
    render(<OffscreenCue overflow={RIGHT} onShowAll={vi.fn()} />);
    const pill = screen.getByRole("button", { name: /Show all/ });
    expect(pill.tagName).toBe("BUTTON");
    expect(pill).toHaveAttribute("type", "button");
    expect(pill).not.toHaveAttribute("tabindex", "-1");
    expect(pill).not.toBeDisabled();
  });

  it("is one pill and one button, however many edges the content runs past", () => {
    // One action, so one control. Two pills that each showed everything did
    // not fit side by side on a 420px canvas.
    const { container } = render(<OffscreenCue overflow={BOTH} onShowAll={vi.fn()} />);
    const pills = [...container.querySelectorAll(".archer-offscreen-cue")];
    expect(pills).toHaveLength(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(pills[0]).toHaveAccessibleName("2 more to the right, 12 more below. Show all");
    // Each edge is named on the page as text, with its own mark.
    const sides = [...pills[0].querySelectorAll(".archer-offscreen-cue-side")];
    expect(sides.map((side) => side.className)).toEqual([
      "archer-offscreen-cue-side archer-offscreen-cue-side--right",
      "archer-offscreen-cue-side archer-offscreen-cue-side--bottom",
    ]);
    expect(sides.map((side) => side.textContent)).toEqual(["2 more to the right", "12 more below"]);
    expect(within(pills[0] as HTMLElement).getAllByText("Show all")).toHaveLength(1);
  });

  const ENDS: readonly { align: string; overflow: readonly Overflow[]; why: string }[] = [
    { align: "right", overflow: RIGHT, why: "the one edge the drawing runs past" },
    { align: "left", overflow: [{ side: "left", count: 1 }], why: "the one edge the drawing runs past" },
    {
      align: "center",
      overflow: [{ side: "bottom", count: 3 }],
      why: "past the bottom, the top band has no end to prefer",
    },
    { align: "center", overflow: BOTH, why: "past two edges, neither end is the one" },
  ];
  it.each(ENDS)("asks for the $align of the band: $why", ({ align, overflow }) => {
    const { container } = render(<OffscreenCue overflow={overflow} onShowAll={vi.fn()} />);
    expect(container.querySelector(".archer-offscreen-cue")).toHaveClass(`archer-offscreen-cue--${align}`);
  });

  it("stays where the stylesheet puts it until there is a laid-out page to measure", () => {
    // jsdom lays nothing out: every box is 0x0. Moving the pill on that
    // evidence would put it at the canvas's origin.
    const { container } = render(
      <OffscreenCue overflow={RIGHT} onShowAll={vi.fn()} blocked={[{ x: 0, y: 0, width: 400, height: 400 }]} />,
    );
    expect(container.querySelector<HTMLElement>(".archer-offscreen-cue")!.getAttribute("style")).toBeNull();
  });

  it("points the way with a drawn mark that is not read out", () => {
    const { container } = render(<OffscreenCue overflow={RIGHT} onShowAll={vi.fn()} />);
    const mark = container.querySelector(".archer-offscreen-cue svg");
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });

  it("tells assistive technology once, politely, in one sentence for every side", () => {
    render(<OffscreenCue overflow={BOTH} onShowAll={vi.fn()} />);
    const status = announcer();
    // Polite: it waits for the screen reader to finish what it is saying.
    // Atomic: the sentence is read whole, not as the words that changed.
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    // Not a second `status` on a page that already has the connection strip.
    expect(status).not.toHaveAttribute("role");
    expect(status).toHaveTextContent(
      "Part of the diagram is off screen: 2 more to the right, 12 more below. Press Show all to see all of it.",
    );
  });

  it("does not say it again when the canvas redraws with the same thing off screen", () => {
    // A live region re-announces when its text node changes. A re-render with
    // an equal overflow must leave the very same text node in place.
    const { rerender } = render(<OffscreenCue overflow={RIGHT} onShowAll={vi.fn()} />);
    const before = announcer().firstChild;
    rerender(<OffscreenCue overflow={[{ side: "right", count: 6 }]} onShowAll={vi.fn()} />);
    expect(announcer().firstChild).toBe(before);
  });

  it("falls silent, and takes its pills away, once everything is in view", () => {
    const { container, rerender } = render(<OffscreenCue overflow={RIGHT} onShowAll={vi.fn()} />);
    rerender(<OffscreenCue overflow={[]} onShowAll={vi.fn()} />);
    expect(container.querySelectorAll(".archer-offscreen-cue")).toHaveLength(0);
    expect(announcer()).toBeEmptyDOMElement();
  });

  it("hands the keyboard to the canvas's own fit control when pressing it makes it disappear", () => {
    // Showing all puts everything in view, which removes the pill -- and a
    // focused element that is removed drops focus on `<body>`, where the next
    // Tab starts from the top of the page.
    function Canvas(): JSX.Element {
      return (
        <div className="archer-emph-surface">
          <button type="button" aria-label="Fit view" />
          <OffscreenCue overflow={RIGHT} onShowAll={vi.fn()} />
        </div>
      );
    }
    render(<Canvas />);
    const pill = screen.getByRole("button", { name: /Show all/ });
    pill.focus();
    fireEvent.click(pill);
    expect(screen.getByRole("button", { name: "Fit view" })).toHaveFocus();
  });

  it("leaves focus alone when it was pressed with the pointer from somewhere else", () => {
    render(
      <div className="archer-emph-surface">
        <button type="button" aria-label="Fit view" />
        <OffscreenCue overflow={RIGHT} onShowAll={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(screen.getByRole("button", { name: "Fit view" })).not.toHaveFocus();
  });
});

describe("the cue in the stylesheet", () => {
  // jsdom applies no stylesheet, so where the pills sit is read from the one
  // on disk. What they look like is checked in a real browser.
  const rules = rulesOf(readStylesheet());
  const declared = (selector: string, property: string): string | undefined =>
    rules
      .filter((rule) => rule.selectors.includes(selector))
      .flatMap((rule) => declarationsOf(rule.body))
      .filter(([name]) => name === property)
      .map(([, value]) => value)
      .at(-1);

  it("floats over the canvas, in the band a framing keeps free at the top", () => {
    expect(declared(".archer-offscreen-cue", "position")).toBe("absolute");
    // The band is the pill's inset, its height and the gap under it; the
    // framing and the stylesheet have to mean the same strip of canvas.
    const inset = Number.parseFloat(declared(".archer-offscreen-cue", "top") ?? "");
    const pill = Number.parseFloat(declared(".archer-offscreen-cue", "min-height") ?? "");
    expect(inset + pill + CHROME_GAP_PX).toBe(CUE_BAND_PX);
  });

  it.each(["left", "right"])("sits at the %s end of the band when that is the edge the drawing runs past", (side) => {
    expect(declared(`.archer-offscreen-cue--${side}`, side)).toMatch(/^\d+px$/);
  });

  it("is centred when no one edge is the one", () => {
    expect(declared(".archer-offscreen-cue--center", "left")).toBe("50%");
    expect(declared(".archer-offscreen-cue--center", "transform")).toBe("translateX(-50%)");
  });

  it("is as wide as its words and no wider than the canvas, so it can be measured and moved as a box", () => {
    expect(declared(".archer-offscreen-cue", "width")).toBe("max-content");
    const limits = rules
      .filter((rule) => rule.selectors.includes(".archer-offscreen-cue"))
      .flatMap((rule) => declarationsOf(rule.body))
      .filter(([name]) => name === "max-width")
      .map(([, value]) => value);
    expect(limits).toEqual(["calc(100% - 20px)", "min(220px, calc(100% - 20px))"]);
    expect(readStylesheet()).toMatch(/@media \(max-width: 720px\)\s*\{\s*\.archer-offscreen-cue,/);
  });

  it("sits under the legend and over the canvas's own panels", () => {
    const cue = Number(declared(".archer-offscreen-cue", "z-index"));
    // React Flow's panels (the control cluster) are at 5.
    expect(cue).toBeGreaterThan(5);
    expect(cue).toBeLessThan(Number(declared(".archer-emph-legend", "z-index")));
  });

  it("shows where the keyboard is with the page's own ring", () => {
    expect(declared(".archer-offscreen-cue:focus-visible", "outline")).toBe("2px solid var(--accent)");
  });

  it("hides the announcer from sight without hiding it from a screen reader", () => {
    // `display: none` or `visibility: hidden` would silence it.
    expect(declared(".archer-offscreen-status", "position")).toBe("absolute");
    expect(declared(".archer-offscreen-status", "clip-path")).toBe("inset(50%)");
    expect(declared(".archer-offscreen-status", "display")).toBeUndefined();
    expect(declared(".archer-offscreen-status", "visibility")).toBeUndefined();
  });
});
