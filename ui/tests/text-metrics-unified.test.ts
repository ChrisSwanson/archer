// One text-width estimator, with the typeface as a parameter.
//
// There used to be two: `text-measure.ts` for sequence diagrams and a private
// table in `graph-metrics.ts` for graphs, each with its own advance table and
// its own idea of what bold adds. They are one, and its tables are the face the
// page draws in: Fira Sans, embedded, set with the page's tracking (+0.04em).
// (Inter before it, 2026-10-04 to 2026-11-11; DejaVu Sans, the stack's
// fallback, before that.)
//
// Everything asserted against a number here was MEASURED, not estimated:
// rendered widths of the embedded Fira Sans with the page's tracking in
// headless Chromium on macOS and in the CI image on Linux (2026-11-11), each
// the wider of the two rounded up -- macOS places glyphs at fractional
// positions, Linux at their hinted whole-pixel advances. Layout itself never
// measures: these tables are how the estimate is held to what a browser draws.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TYPEFACE,
  TYPEFACES,
  TYPE_TRACKING_EM,
  estimateTextWidth,
  truncateToWidth,
  wrapText,
  type TextWeight,
  type TypefaceId,
} from "../src/layout/text-measure";
import * as graphMetrics from "../src/layout/graph-metrics";
import {
  EDGE_LABEL_PAD_X,
  NODE_TITLE_FONT_PX,
  NODE_WIDTH,
  edgeLabelBox,
  graphFontPx,
  nodeBox,
} from "../src/layout/graph-metrics";
import { computeLayout } from "../src/layout/elk-adapter";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { containersView } from "./graph-samples";
import { loadValidFixture } from "./fixtures";
import { declarationsOf, readStylesheet, rulesOf, throughTokens } from "./stylesheet";

type Measured = readonly (readonly [text: string, drawnPx: number])[];

/** Fira Sans 400, 12px: a message label or an edge caption. */
const FIRA_REGULAR_12: Measured = [
  ["user record", 71],
  ["POST /login", 70],
  ["401 Unauthorized", 103],
  ["200 OK", 41],
  ["Open dashboard", 99],
  ["refresh token", 82],
  ["error: retry after timeout", 150],
  ["publishes order events", 139],
  ["reads and writes", 101],
  ["forwards dynamic requests", 163],
  ["GET /authorize?response_type=code", 217],
  ["INSERT order (pending)", 138],
  ["302 redirect carrying the authorization code", 263],
  ["API / CLI / UI", 78],
  ["/orders/42/refund", 111],
  ["Idempotency-Key: 7f3a", 136],
  ["=code", 36],
  ["a+b < c => d", 69],
  ["retry #3 ~2s", 68],
  ["WWW mirror", 73],
];

/** Fira Sans 600, 14px: a node label. */
const FIRA_STRONG_14: Measured = [
  ["Notification worker", 135],
  ["Web application (Next.js)", 174],
  ["Orders database (Postgres)", 193],
  ["API gateway", 84],
  ["Identity and access management", 228],
  ["POST /orders/42/refund", 169],
  ["Billing service", 100],
  ["INTERNAL tools", 106],
  ["Is the WWW mirror in sync?", 188],
  ["Customer-facing Web Application", 232],
  ["Identity Provider", 117],
  ["Payment provider", 122],
  ["Checkout API", 91],
  ["Shopper", 59],
];

/** Fira Sans 700, 12px: a selected edge caption, drawn bold. */
const FIRA_BOLD_12: Measured = [
  ["user record", 71],
  ["Open dashboard", 99],
];

/** Fira Sans 400 italic, 12px: an edge caption set in the italic. */
const FIRA_ITALIC_12: Measured = [
  ["user record", 69],
  ["publishes order events", 134],
  ["reads and writes", 99],
  ["302 redirect carrying the authorization code", 260],
  ["retry #3 ~2s", 67],
];

const TABLES: readonly (readonly [
  name: string,
  face: TypefaceId,
  fontPx: number,
  weight: TextWeight,
  table: Measured,
])[] = [
  ["Fira Sans 400 at 12px", "fira", 12, false, FIRA_REGULAR_12],
  ["Fira Sans 600 at 14px", "fira", 14, true, FIRA_STRONG_14],
  ["Fira Sans 700 at 12px", "fira", 12, true, FIRA_BOLD_12],
  ["Fira Sans 700 at 12px, as bold", "fira", 12, "bold", FIRA_BOLD_12],
  ["Fira Sans 400 italic at 12px", "fira", 12, "italic", FIRA_ITALIC_12],
];

describe.each(TABLES)("the estimate against %s", (_name, face, fontPx, weight, table) => {
  it.each(table)("is never narrower than %j is drawn", (text, drawn) => {
    // A label with a few pixels to spare looks fine; one that overruns its
    // box does not.
    expect(estimateTextWidth(text, fontPx, weight, face)).toBeGreaterThanOrEqual(drawn);
  });

  it("does not balloon: within a fifth of the drawn width, and a tenth on average", () => {
    // The other way to be wrong: a box far wider than its label wraps text
    // that would have fitted, and pushes lifelines and layers apart.
    const ratios = table.map(([text, drawn]) => estimateTextWidth(text, fontPx, weight, face) / drawn);
    for (const [i, ratio] of ratios.entries()) {
      expect(ratio, table[i][0]).toBeLessThanOrEqual(1.2);
    }
    expect(ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length).toBeLessThanOrEqual(1.1);
  });
});

describe("one estimator serves both canvases", () => {
  const LABELS = ["CDN", "Notification worker", "Web application (Next.js)", "Is the WWW mirror in sync?"];

  it.each(LABELS)("sizes the graph node label %j with the shared estimate", (label) => {
    const box = nodeBox(label, "rectangle", []);
    // A flowchart node's label is its title, at the title's size (DESIGN.md, Typography; owner 2026-11-11).
    const widest = Math.max(...box.lines.map((line) => estimateTextWidth(line, NODE_TITLE_FONT_PX, true)));
    expect(box.textWidth).toBe(widest);
  });

  it.each(["routes", "publishes order events", "reads / writes"])(
    "sizes the edge caption %j with it too",
    (caption) => {
      const box = edgeLabelBox(caption);
      const widest = Math.max(...box.lines.map((line) => estimateTextWidth(line, graphFontPx("fira").caption)));
      expect(box.width).toBe(widest + 2 * EDGE_LABEL_PAD_X);
    },
  );

  it("is the one the graph module hands out, not a second function of the same name", () => {
    expect(graphMetrics.estimateTextWidth).toBe(estimateTextWidth);
  });

  it("measures each weight in its own face, and the strong weight as the wider of 600 and 700", () => {
    // A node title is 600 and turns 700 when selected: sized for the wider,
    // selecting it never makes it overrun its box.
    for (const text of ["Notification worker", "illicit filling lilt", "MMWW mmww", "0123456789"]) {
      for (const px of [12, 14, 15]) {
        const strong = estimateTextWidth(text, px, true);
        expect(strong).toBeGreaterThanOrEqual(estimateTextWidth(text, px, "semibold"));
        expect(strong).toBeGreaterThanOrEqual(estimateTextWidth(text, px, "bold"));
        expect(strong).toBe(Math.max(estimateTextWidth(text, px, "semibold"), estimateTextWidth(text, px, "bold")));
        expect(estimateTextWidth(text, px, false)).toBe(estimateTextWidth(text, px, "regular"));
      }
    }
  });

  it("adds the page's tracking to every character, the last one included", () => {
    // Chromium sets letter-spacing after every character; a box sized without
    // it is 0.04em a character short.
    expect(TYPE_TRACKING_EM).toBe(0.04);
    for (const ch of ["i", "m", "A", "7", " "]) {
      const one = estimateTextWidth(ch.repeat(10), 100, false);
      const exact = TYPEFACES.fira.advancePx(ch, 100, "regular")!;
      expect(one, ch).toBe(Math.ceil(10 * exact + 10 * TYPE_TRACKING_EM * 100) + 1);
    }
  });

  it("estimates in the default face when none is named, so every existing caller is unchanged", () => {
    expect(DEFAULT_TYPEFACE).toBe("fira");
    expect(estimateTextWidth("Notification worker", 14, true)).toBe(
      estimateTextWidth("Notification worker", 14, true, "fira"),
    );
    expect(wrapText("302 redirect carrying the authorization code back", 160, 12, 4)).toEqual(
      wrapText("302 redirect carrying the authorization code back", 160, 12, 4, false, "fira"),
    );
    expect(truncateToWidth("a considerably longer label than the box", 80, 12)).toBe(
      truncateToWidth("a considerably longer label than the box", 80, 12, false, "fira"),
    );
  });
});

describe("the typeface is the page's", () => {
  it("has a table for Fira Sans, the one face the page embeds, and lays out in it by default", () => {
    expect(Object.keys(TYPEFACES)).toEqual(["fira"]);
    expect(DEFAULT_TYPEFACE).toBe("fira");
  });

  it("sizes graph text at the sizes the stylesheet draws it", () => {
    const rules = rulesOf(readStylesheet());
    const fontSize = (selector: string): number => {
      const value = rules
        .filter((rule) => rule.selectors.includes(selector))
        .flatMap((rule) => declarationsOf(rule.body))
        .find(([property]) => property === "font-size")?.[1];
      expect(value, `${selector} { font-size }`).toBeDefined();
      return Number.parseFloat(throughTokens(readStylesheet(), value!));
    };
    expect(graphFontPx("fira")).toMatchObject({
      nodeLabel: fontSize(".archer-node"),
      caption: fontSize(".archer-edge-label"),
    });
  });
});

describe("a layout is computed for a typeface, and says which", () => {
  const sequence = (): Parameters<typeof computeSequenceLayout>[0] => {
    const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
    if (!projection.ok || projection.type !== "sequence") {
      throw new Error("minimal-sequence.json did not project to a sequence view");
    }
    return projection.view;
  };

  it("lays a graph out for Fira Sans unless told otherwise, and records it", async () => {
    expect((await computeLayout(containersView())).typeface).toBe("fira");
  });

  it("lays a sequence out for Fira Sans, and records it", () => {
    expect(computeSequenceLayout(sequence()).typeface).toBe("fira");
  });

  it("does not wrap a node label that fits on the line Fira Sans draws it on", () => {
    // 173-174px in Fira Sans 600 at 14px with the page's tracking, inside the
    // line a title holds. Sized for DejaVu Sans Bold (200px), it broke in two.
    const label = "Web application (Next.js)";
    expect(nodeBox(label, "rectangle", []).lines).toEqual([label]);
  });

  it("never lets a label overrun its box", () => {
    for (const [text, drawn] of FIRA_STRONG_14) {
      const box = nodeBox(text, "rectangle", []);
      if (box.lines.length === 1) {
        expect(box.width - 2 * 14, text).toBeGreaterThanOrEqual(drawn);
      }
      expect(box.width).toBeGreaterThanOrEqual(NODE_WIDTH);
    }
  });

  it("gives an edge caption the room it is drawn with", () => {
    for (const [text, drawn] of FIRA_REGULAR_12) {
      const box = edgeLabelBox(text);
      if (box.lines.length === 1) {
        expect(box.width - 2 * EDGE_LABEL_PAD_X, text).toBeGreaterThanOrEqual(drawn);
      }
    }
  });
});
