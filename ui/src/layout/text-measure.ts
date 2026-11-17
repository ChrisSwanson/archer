/**
 * Text measurement without a browser: the ONE estimator both canvases use.
 *
 * Layout has to be a pure function of the model -- it runs in tests under
 * jsdom, which lays nothing out, and it must give the same coordinates on every
 * machine. So widths are ESTIMATED from the face's own advance widths rather
 * than measured from the DOM. The estimate leans wide on purpose: a label with
 * a few pixels to spare looks fine, and one that overruns its box does not.
 *
 * THE TYPEFACE IS A PARAMETER, because a face has its own advances, and a
 * layout computed for one and drawn in another wraps labels that would have
 * fitted and overruns boxes that looked big enough. There is one face --
 * Fira Sans, embedded in the page (`theme/current-font.css`) -- and so one
 * entry; a second face is a second entry, and a face with no entry does not
 * type-check. Nothing here ever asks the DOM.
 *
 * The advances are the font files' own (`fira-metrics.ts`, generated from the
 * bundled faces by `ui/scripts/fira-fonts.py`), exact and hinted, one table
 * per face the canvas draws in -- 400, 600, 700 and 400 italic -- plus the
 * page's letter-spacing.
 * `tests/browser-ts/text-measure.e2e.ts` holds the estimate to what Chromium
 * draws, at the sizes and weights the canvases use, and never under it.
 */
import { FIRA_ADVANCES, FIRA_CHARS, FIRA_HINTED, FIRA_UNITS_PER_EM } from "./fira-metrics";

/** The faces the canvas draws text in. */
export type TextStyle = "regular" | "italic" | "semibold" | "bold";

/**
 * How text is set: `false` is regular; `true` is the canvas's strong weight,
 * which is 600 at rest and 700 selected, so it is sized for the wider of the
 * two and selecting a label never makes it overrun its plate; or one face.
 */
export type TextWeight = boolean | TextStyle;

/**
 * The letter-spacing every sans line is set with, in em per character
 * (`--type-tracking` in `styles.css`; `tests/font-tokens.test.ts` holds them
 * equal). Chromium adds it after every character, the last one included.
 */
export const TYPE_TRACKING_EM = 0.04;

export type Typeface = {
  /** The letter-spacing the face is drawn with, in em per character. */
  readonly tracking: number;
  /**
   * The px one character advances by at `fontPx`, before tracking: never less
   * than a browser draws it with. Undefined for a character the face does not
   * draw.
   */
  readonly advancePx: (ch: string, fontPx: number, style: TextStyle) => number | undefined;
};

/**
 * What a character no table holds is assumed to take, in em: it is drawn by a
 * fallback face whichever typeface the page asked for. CJK and emoji are at
 * least as wide as their em square; anything else as wide as an em, more than
 * the widest latin letter (Fira Sans's `W` is 0.9em at 700).
 */
const FALLBACK_WIDE_EM = 1.05;
const FALLBACK_EM = 1;
/** Added to every non-empty estimate (`estimateTextWidth`). */
const SAFETY_PX = 1;

/**
 * A face from its font's own tables: each character's exact advance, and its
 * hinted advance at each size the canvas sets text at.
 *
 * Chromium on macOS (and Windows) places glyphs at fractional positions, so
 * text is as wide as its exact advances. On Linux (CI, and most servers) it
 * does not: each glyph advances by its HINTED width at that size, a whole
 * pixel that is not always the nearest one -- a 15px `a` is 8.2px exactly
 * and 9px drawn there. The wider of the two, so a box sized here holds its
 * label on both. At a size with no hinted table, the nearest whole pixel
 * stands in for the hinted width.
 */
function tableFace(
  chars: string,
  unitsPerEm: number,
  advances: Readonly<Record<TextStyle, readonly number[]>>,
  hinted: Readonly<Record<number, Readonly<Record<TextStyle, string>>>>,
  tracking: number,
): Typeface {
  const index = new Map([...chars].map((ch, i) => [ch, i]));
  return {
    tracking,
    advancePx: (ch, fontPx, style) => {
      const at = index.get(ch);
      if (at === undefined) return undefined;
      const exact = (advances[style][at]! / unitsPerEm) * fontPx;
      // A digit per character: 4 is the nearest whole pixel, 5 one more, 3 one less.
      const digit = hinted[fontPx]?.[style].charCodeAt(at);
      const whole = Math.round(exact) + (digit === undefined ? 0 : digit - 0x34);
      return Math.max(exact, whole);
    },
  };
}

export const TYPEFACES = {
  /*
   * Fira Sans (SIL OFL): the latin subset of its static faces
   * (`theme/fonts/fira-sans-latin-*.woff2`), set with the page's tracking.
   */
  fira: tableFace(FIRA_CHARS, FIRA_UNITS_PER_EM, FIRA_ADVANCES, FIRA_HINTED, TYPE_TRACKING_EM),
} as const satisfies Record<TypefaceId, Typeface>;

export type { TypefaceId } from "../../../shared/layout-analysis.mts";
import type { TypefaceId } from "../../../shared/layout-analysis.mts";

/** The face a layout is computed for when nobody names one: the page's. */
export const DEFAULT_TYPEFACE: TypefaceId = "fira";

/** One character's advance in px, in one face. */
function glyphPx(ch: string, fontPx: number, face: Typeface, style: TextStyle): number {
  return face.advancePx(ch, fontPx, style) ?? (ch.charCodeAt(0) > 0x2e80 ? FALLBACK_WIDE_EM : FALLBACK_EM) * fontPx;
}

/** Estimated rendered width of `text` in px: regular, strong (`true`) or one face. */
export function estimateTextWidth(
  text: string,
  fontPx: number,
  weight: TextWeight = false,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
): number {
  const face: Typeface = TYPEFACES[typeface];
  const tracking = face.tracking * fontPx;
  let px = 0;
  for (const ch of text) {
    px +=
      tracking +
      (weight === true
        ? Math.max(glyphPx(ch, fontPx, face, "semibold"), glyphPx(ch, fontPx, face, "bold"))
        : glyphPx(ch, fontPx, face, weight === false ? "regular" : weight));
  }
  // A pixel more, for what neither table sees: of 1,176 strings measured in the CI image, one drew a pixel past
  // the sum of its hinted advances. To a hundredth first, so a sum that is a whole pixel is not rounded past it.
  return text === "" ? 0 : Math.ceil(Math.round(px * 100) / 100) + SAFETY_PX;
}

const ELLIPSIS = "…";
const BREAK_AFTER = new Set("/?&=-_.,;: ");

/** Shortens `text` until it fits `maxWidth`, marking the cut with an ellipsis. */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  fontPx: number,
  bold: TextWeight = false,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
): string {
  if (estimateTextWidth(text, fontPx, bold, typeface) <= maxWidth) {
    return text;
  }
  const chars = [...text];
  while (chars.length > 1 && estimateTextWidth(chars.join("") + ELLIPSIS, fontPx, bold, typeface) > maxWidth) {
    chars.pop();
  }
  return chars.join("").trimEnd() + ELLIPSIS;
}

/**
 * Greedy word wrap to at most `maxLines` lines of at most `maxWidth` px.
 *
 * A single token wider than a line (a URL, usually) is split mid-token rather
 * than left to overrun, and whatever does not fit in the last line is cut with
 * an ellipsis -- the caller keeps the full text for a tooltip.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontPx: number,
  maxLines: number,
  bold: TextWeight = false,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
): string[] {
  // A label's line break (`<br/>` in Mermaid, `\n` in the model) always starts a new line.
  if (text.includes("\n")) {
    const lines = text
      .split("\n")
      .flatMap((line) => wrapText(line, maxWidth, fontPx, Number.MAX_SAFE_INTEGER, bold, typeface));
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = truncateToWidth(
      `${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`,
      maxWidth,
      fontPx,
      bold,
      typeface,
    );
    return kept;
  }
  const fits = (candidate: string): boolean => estimateTextWidth(candidate, fontPx, bold, typeface) <= maxWidth;
  if (fits(text)) {
    return [text];
  }

  const lines: string[] = [];
  let current = "";
  const push = (): void => {
    lines.push(current);
    current = "";
  };

  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const joined = current === "" ? word : `${current} ${word}`;
    if (fits(joined)) {
      current = joined;
      continue;
    }
    if (fits(word)) {
      push();
      current = word;
      continue;
    }
    // The word alone is wider than a line (a URL, usually). Let it start on
    // the current line rather than stranding a short word above it, and break
    // it after punctuation where there is some near the edge.
    let rest = joined;
    current = "";
    while (!fits(rest)) {
      const chars = [...rest];
      let take = chars.length - 1;
      while (take > 1 && !fits(chars.slice(0, take).join(""))) {
        take--;
      }
      for (let back = 0; back < 12 && take - back > 1; back++) {
        if (BREAK_AFTER.has(chars[take - back - 1])) {
          take -= back;
          break;
        }
      }
      lines.push(chars.slice(0, take).join("").trimEnd());
      rest = chars.slice(take).join("").trimStart();
    }
    current = rest;
  }
  if (current !== "") {
    push();
  }

  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, maxLines);
  const overflow = `${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`;
  kept[maxLines - 1] = truncateToWidth(overflow, maxWidth, fontPx, bold, typeface);
  return kept;
}
