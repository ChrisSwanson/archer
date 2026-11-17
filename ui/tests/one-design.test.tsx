// @vitest-environment jsdom
//
// The one design (phase 3b, the second design review): Current's structure and
// readability, with what the retired Line map design did best folded in.
//
//   - STRUCTURE IS NEUTRAL. Hue carries exactly two meanings, the person's
//     blue and the agent's amber (with the agent's emphasis palette and the
//     danger family). The canvas, panels, outlines, wires and text are greys:
//     Current's were a mint-tinted grey, a third hue that meant nothing. The
//     Drafting palette (2026-10-08) warmed them a few degrees; cool slate
//     (owner, 2026-11-12, from the reference drawings) replaced that with a
//     slate cast -- a cast, not a hue.
//   - EDGE WEIGHT FOLLOWS THE NOTATION. Data flow and architecture are drawn
//     in rails, ER relationships and sequence messages in hairlines, a state
//     machine's transitions between the two.
//   - CALMER SURFACES. No dot grid behind the drawing, and flatter shadows.
//
// Read from the stylesheet on disk and from the rendered canvas, for the
// reasons `canvas-theme.test.tsx` gives (jsdom resolves no `var()`).
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import type { GraphNotation } from "../src/diagrams/figures";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { oklch, parseColour } from "./contrast";
import { containersView } from "./graph-samples";
import { declarationsOf, readStylesheet, rulesOf, tokensOf } from "./stylesheet";

const CSS = readStylesheet();
const RULES = rulesOf(CSS);

const SCHEMES = [
  ["dark", ':root[data-theme="dark"]'],
  ["light", ':root[data-theme="light"]'],
  ["light before JavaScript", ":root:not([data-theme])"],
] as const;

/** The tokens that are structure: everything that is not a voice. */
const STRUCTURE = [
  "--bg",
  "--surface",
  "--surface-2",
  "--panel",
  "--border",
  "--border-strong",
  "--border-hover",
  "--node-bg",
  "--node-border",
  "--node-border-hover",
  "--node-text",
  "--edge-hover",
  "--plate",
  "--plate-text",
  "--text",
  "--text-dim",
  "--text-faint",
  "--kbd-focus",
  "--group-bg",
  "--group-border",
  "--group-text",
  "--group-caption",
  "--fragment-bg",
  "--fragment-border",
  "--fragment-text",
  "--activation-bg",
  "--scrim",
] as const;

/** How far apart a colour's channels are: 0 for a true grey. */
function spread(value: string): number {
  const { rgb } = parseColour(value);
  return Math.max(...rgb) - Math.min(...rgb);
}

/**
 * A grey, or a grey with the platform's cool slate cast (owner, 2026-11-12, from the reference drawings: Tailwind's
 * slate, `#f1f5f9` to `#0f172a`): OKLCH chroma under 0.01 in any hue, or up to 0.045 in the slate band (hue
 * 230-270 degrees). A channel spread cannot draw that line: slate spreads up to 35 steps at a chroma of 0.04,
 * which is less colour than a mint grey shows at half the spread. Drafting's warm cast (hue 60-100) is retired.
 */
function isGrey(value: string): boolean {
  const [, chroma, hue] = oklch(parseColour(value).rgb);
  return chroma < 0.01 || (chroma <= 0.045 && hue >= 230 && hue <= 270);
}

/**
 * The connections and their arrowheads: an inked slate (DESIGN.md, Diagram palette; owner, 2026-11-11), the
 * reference's `#334155` -- a cast, in the slate band, so it never reads as the reader's ink blue or any voice.
 */
const SLATE = ["--edge", "--edge-arrow"] as const;

function isSlate(value: string): boolean {
  return isGrey(value);
}

describe("structure is neutral", () => {
  it.each(SCHEMES)("draws the connections of %s in a slate, not a hue", (_name, selector) => {
    const tokens = tokensOf(CSS, selector);
    const tinted = SLATE.filter((token) => {
      const value = tokens.get(token);
      expect(value, `${selector} { ${token} }`).toBeDefined();
      return !isSlate(value!);
    }).map((token) => `${token}: ${tokens.get(token)}`);
    expect(tinted).toEqual([]);
  });

  it.each(SCHEMES)("draws every structural token of %s in a grey", (_name, selector) => {
    const tokens = tokensOf(CSS, selector);
    const tinted = STRUCTURE.filter((token) => {
      const value = tokens.get(token);
      expect(value, `${selector} { ${token} }`).toBeDefined();
      // A warm grey is allowed its faint drafting-table cast; a mint grey is
      // not, and neither is anything with a hue of its own.
      return !isGrey(value!);
    }).map((token) => `${token}: ${tokens.get(token)}`);
    expect(tinted).toEqual([]);
  });

  it("tells a slate cast from a hue", () => {
    expect(isGrey("#64748b")).toBe(true); // the slate node border
    expect(isGrey("#0f172a")).toBe(true); // slate ink
    expect(isGrey("#86898e")).toBe(true); // the earlier neutral slate
    expect(isGrey("#8c867b")).toBe(false); // Drafting's warm node border, retired
    expect(isGrey("#7f8a84")).toBe(false); // a mint grey
    expect(isGrey("#e8dcc4")).toBe(false); // cream
    expect(isGrey("#2645a3")).toBe(false); // the reader's ink blue
  });

  it("keeps hue for the voices: the person's blue and the agent's amber are not grey", () => {
    for (const [, selector] of SCHEMES) {
      const tokens = tokensOf(CSS, selector);
      expect(spread(tokens.get("--accent")!)).toBeGreaterThan(60);
      expect(spread(tokens.get("--agent")!)).toBeGreaterThan(60);
    }
  });
});

/** The stroke width a rule body sets, in px. */
function strokeWidth(selector: string): number | undefined {
  const value = RULES.filter((rule) => rule.selectors.includes(selector))
    .flatMap((rule) => declarationsOf(rule.body))
    .filter(([property]) => property === "stroke-width")
    .map(([, value]) => Number.parseFloat(value))
    .at(-1);
  return value;
}

/** The resting width of a graph edge in a notation: the notation's rule, or the base rule. */
function edgeWeight(notation: GraphNotation): number {
  return (
    strokeWidth(`[data-notation="${notation}"] .archer-edge .react-flow__edge-path`) ??
    strokeWidth(".archer-edge .react-flow__edge-path")!
  );
}

describe("edge weight follows the notation", () => {
  it("draws data flow, C4 and architecture in rails of at least 2px", () => {
    for (const notation of ["flowchart", "c4", "architecture"] as const) {
      expect(edgeWeight(notation), notation).toBeGreaterThanOrEqual(2);
    }
  });

  it("draws ER relationships in hairlines", () => {
    expect(edgeWeight("er")).toBeLessThanOrEqual(1.25);
  });

  it("draws a state machine's transitions between the two", () => {
    expect(edgeWeight("state")).toBeGreaterThan(edgeWeight("er"));
    expect(edgeWeight("state")).toBeLessThan(edgeWeight("flowchart"));
  });

  it("keeps thick heavier than plain in every notation", () => {
    for (const notation of ["state", "er"] as const) {
      const thick = strokeWidth(`[data-notation="${notation}"] .archer-edge.archer-line-thick .react-flow__edge-path`);
      expect(thick, notation).toBeGreaterThanOrEqual(edgeWeight(notation) + 1.5);
    }
  });

  it("draws sequence messages in hairlines, heavier only when hovered or selected", () => {
    const message = strokeWidth(".archer-seq-message-stroke line");
    expect(message).toBeLessThanOrEqual(1.25);
    expect(strokeWidth(".archer-seq-message-stroke path")).toBe(message);
    expect(strokeWidth(".archer-seq-message.archer-seq-hover line")).toBeGreaterThan(message!);
    expect(strokeWidth(".archer-seq-message.archer-seq-selected line")).toBeGreaterThan(message!);
  });
});

describe("the canvas says which notation it draws, and draws no dot grid", () => {
  let layout: LayoutResult;
  beforeAll(async () => {
    layout = await computeLayout(containersView());
  });
  afterEach(cleanup);

  it.each(["flowchart", "er", "state"] as const)("marks a %s canvas with its notation", async (notation) => {
    const drawn: LayoutResult = notation === "flowchart" ? layout : { ...layout, notation };
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout: drawn }} />);
    await waitFor(() => expect(container.querySelector(".react-flow__edge")).not.toBeNull());
    expect(container.querySelector(`[data-notation="${notation}"]`)).not.toBeNull();
  });

  it("puts no pattern behind the drawing: the canvas is a plain ground, as the sequence canvas is", async () => {
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} />);
    await waitFor(() => expect(container.querySelector(".react-flow__node")).not.toBeNull());
    expect(container.querySelector(".react-flow__background")).toBeNull();
  });
});

describe("calmer surfaces", () => {
  /** The largest blur radius in a box-shadow list. */
  const blur = (shadow: string): number =>
    Math.max(
      ...[...shadow.matchAll(/(?:^|,)\s*-?[\d.]+(?:px)?\s+-?[\d.]+(?:px)?\s+([\d.]+)px/g)].map((match) =>
        Number(match[1]),
      ),
    );

  it.each(SCHEMES)("lifts %s panels with a short shadow, not a glow", (_name, selector) => {
    const shadow = tokensOf(CSS, selector).get("--shadow-panel")!;
    expect(blur(shadow)).toBeLessThanOrEqual(16);
  });
});
