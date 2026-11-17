// The colours of the sequence canvas's quiet marks -- the fragment kind chip
// and the note -- measured from the stylesheet in both themes.
//
// The chip used to be a solid `--accent` fill: in the light theme a loud blue
// tag on a neutral frame, in the one colour that is supposed to mean "the
// reader selected this". These tests keep the accent out of it and hold its
// text to 4.5:1 by computing what is actually painted, translucent layers
// composited, rather than trusting a comment.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Rgb, compositeOver, contrastRatio, parseColour } from "./contrast";

const CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function block(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  return CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("}", start));
}

function tokens(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of block(selector).matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    found.set(match[1], match[2].trim());
  }
  return found;
}

const THEMES = [
  ["dark", tokens(':root[data-theme="dark"]')],
  ["light", tokens(':root[data-theme="light"]')],
] as const;

/** One declaration of a rule: the token it names, or its literal value. */
function declared(selector: string, property: string): string | undefined {
  const match = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(block(selector));
  return match?.[1].trim();
}

function tokenOf(selector: string, property: string): string {
  const value = declared(selector, property);
  const token = value === undefined ? null : /^var\((--[\w-]+)\)$/.exec(value);
  if (token === null) throw new Error(`${selector} { ${property} } is not a token: ${value}`);
  return token[1];
}

function opacityOf(selector: string): number {
  return Number(declared(selector, "fill-opacity") ?? "1");
}

function colour(theme: Map<string, string>, token: string) {
  const value = theme.get(token);
  if (value === undefined) throw new Error(`theme has no ${token}`);
  return parseColour(value);
}

/** A fill, at its rule's own `fill-opacity`, laid over `backdrop`. */
function painted(theme: Map<string, string>, selector: string, backdrop: Rgb): Rgb {
  const fill = colour(theme, tokenOf(selector, "fill"));
  return compositeOver({ rgb: fill.rgb, alpha: fill.alpha * opacityOf(selector) }, backdrop);
}

/** The canvas under `depth` nested fragment frames. */
function frameBackdrop(theme: Map<string, string>, depth: number): Rgb {
  const fill = colour(theme, "--fragment-bg");
  const alpha = fill.alpha * 0.55; // `.archer-seq-fragment > rect:first-of-type { fill-opacity }`
  let backdrop = colour(theme, "--bg").rgb;
  for (let i = 0; i < depth; i++) {
    backdrop = compositeOver({ rgb: fill.rgb, alpha }, backdrop);
  }
  return backdrop;
}

describe("the fragment kind chip", () => {
  it("is drawn from the frame's neutrals, not from the accent", () => {
    for (const selector of [".archer-seq-fragment-chip", ".archer-seq-fragment-chip-text"]) {
      expect(block(selector)).not.toMatch(/--accent/);
    }
    expect(tokenOf(".archer-seq-fragment-chip", "fill")).toBe("--fragment-border");
    expect(tokenOf(".archer-seq-fragment-chip", "stroke")).toBe("--fragment-border");
  });

  it.each(THEMES)("keeps its text at 4.5:1 on the chip, in %s, at every nesting depth", (_, theme) => {
    const text = colour(theme, tokenOf(".archer-seq-fragment-chip-text", "fill")).rgb;
    for (const depth of [1, 2, 3, 4]) {
      const chip = painted(theme, ".archer-seq-fragment-chip", frameBackdrop(theme, depth));
      expect(contrastRatio(text, chip)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)("is still a visible tab on its frame, in %s", (_, theme) => {
    // The chip is a tint, so it must not vanish into the frame it sits on:
    // its outline is the frame's own, which holds 3:1 on the canvas.
    const outline = colour(theme, tokenOf(".archer-seq-fragment-chip", "stroke")).rgb;
    expect(contrastRatio(outline, frameBackdrop(theme, 1))).toBeGreaterThanOrEqual(3);
  });
});

describe("a note", () => {
  it("is quiet: none of its colours is the accent", () => {
    for (const selector of [".archer-seq-note-sheet", ".archer-seq-note-fold", ".archer-seq-note text"]) {
      expect(block(selector)).not.toMatch(/--accent/);
    }
  });

  it.each(THEMES)("keeps its text at 4.5:1 on its sheet, in %s", (_, theme) => {
    const sheet = painted(theme, ".archer-seq-note-sheet", colour(theme, "--bg").rgb);
    const text = colour(theme, tokenOf(".archer-seq-note text", "fill")).rgb;
    expect(contrastRatio(text, sheet)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)("has an outline that holds 3:1 on the canvas and inside a frame, in %s", (_, theme) => {
    const outline = colour(theme, tokenOf(".archer-seq-note-sheet", "stroke")).rgb;
    // Two frames deep, not three: at three the frame's own rule -- this same
    // token -- measures 2.95:1 in light against the compounded tint, so the
    // note is exactly as visible there as the frames around it.
    for (const depth of [0, 1, 2]) {
      expect(contrastRatio(outline, frameBackdrop(theme, depth))).toBeGreaterThanOrEqual(3);
    }
  });

  it("is not painted like a participant box", () => {
    expect(tokenOf(".archer-seq-note-sheet", "fill")).not.toBe(tokenOf(".archer-seq-participant rect", "fill"));
    expect(tokenOf(".archer-seq-note text", "fill")).not.toBe(tokenOf(".archer-seq-participant text", "fill"));
  });
});

describe("the autonumber badge", () => {
  const PILL = ".archer-seq-message .archer-seq-message-number rect";
  const DIGITS = ".archer-seq-message .archer-seq-message-number text";
  const SELECTED_PILL = ".archer-seq-message.archer-seq-selected .archer-seq-message-number rect";
  const SELECTED_DIGITS = ".archer-seq-message.archer-seq-selected .archer-seq-message-number text";

  it.each(THEMES)("keeps its 10px digits at 4.5:1, at rest and selected, in %s", (_, theme) => {
    const canvas = colour(theme, "--bg").rgb;
    expect(
      contrastRatio(colour(theme, tokenOf(DIGITS, "fill")).rgb, painted(theme, PILL, canvas)),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(colour(theme, tokenOf(SELECTED_DIGITS, "fill")).rgb, painted(theme, SELECTED_PILL, canvas)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("spends the accent only on a selected message", () => {
    expect(block(PILL)).not.toMatch(/--accent/);
    expect(block(DIGITS)).not.toMatch(/--accent/);
    expect(tokenOf(SELECTED_PILL, "stroke")).toBe("--accent");
  });
});

// A message's label is TEXT. It was filled with `--edge`, the colour of the
// arrow it sits on -- a stroke colour, held to the 3:1 a mark needs -- and a
// reply's with `--text-faint`. Measured in a browser against what was painted
// behind them (`tests/browser/state-marks.e2e.ts` (in the Rust implementation, not in this tree)), Current's light scheme
// drew them at 4.34:1 and 4.21:1 on the canvas and under 4:1 inside a frame.
// axe does not look at SVG text, so nothing had said so.
describe("a message's label", () => {
  it("is inked as text, not in its arrow's stroke colour", () => {
    expect(tokenOf(".archer-seq-message > text", "fill")).toBe("--text-dim");
  });

  it("is the same ink on a reply: the dashed line says reply, not a fainter word", () => {
    const fainter = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, selectors, body]) => /archer-seq-message--reply[^,{]*\btext\b/.test(selectors) && /\bfill:/.test(body),
    );
    expect(fainter.map(([, selectors]) => selectors.trim())).toEqual([]);
  });

  it.each(THEMES)("keeps 4.5:1 on the canvas and inside nested frames, in %s", (_, theme) => {
    const text = colour(theme, tokenOf(".archer-seq-message > text", "fill")).rgb;
    for (const depth of [0, 1, 2, 3]) {
      expect(contrastRatio(text, frameBackdrop(theme, depth)), `inside ${depth} frames`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)(
    "was under 4.5:1 in the arrow's colour, in light: the measurement this replaces (%s)",
    (name, theme) => {
      const stroke = colour(theme, "--edge").rgb;
      const onCanvas = contrastRatio(stroke, frameBackdrop(theme, 0));
      if (name === "light") {
        // Measured against the light line and canvas of the time, #6f6a61 on Drafting's #ebe9e4 (4.43:1). The
        // diagram palette has since inked `--edge` (owner, 2026-11-11) and the canvas turned white (2026-11-12):
        // the word keeps its own ink either way.
        expect(contrastRatio(parseColour("#6f6a61").rgb, parseColour("#ebe9e4").rgb)).toBeLessThan(4.5);
      }
      // Still a mark, in both: the arrow itself keeps the colour.
      expect(onCanvas).toBeGreaterThanOrEqual(3);
    },
  );
});

// Since ADR 0030 an emphasised message draws no band or wash under its label:
// its label keeps the canvas behind it, so the ordinary label rule above is
// the one that has to hold, and nothing may re-ink it for emphasis.
describe("a label on an emphasised message", () => {
  it("is not re-inked for emphasis: there is no highlight under it to read against", () => {
    expect(() => tokenOf(".archer-seq-message.archer-emph > text", "fill")).toThrow();
  });
});
