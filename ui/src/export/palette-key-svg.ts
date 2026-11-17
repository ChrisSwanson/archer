/**
 * The drawing's legend in an exported drawing (DESIGN.md, "The Key"): the canvas's own rows
 * (`diagrams/drawing-key.tsx`), written as static markup beside the drawing, top right, as the owner's reference
 * legend is -- a sample in the tokens its members are painted in (the export resolves them to the theme's literal
 * colours), the kind's glyph, and the row's label. Members are said in the page's Key and in each member's
 * accessible name; a picture keeps the labels.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DrawingKeyRows, drawingKeyLayout } from "../diagrams/drawing-key";
import { type PaletteKeySource, paletteKeyRows } from "../diagrams/palette-key";

export type PaletteKeySvg = {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  /** The notation Key labels a kind's colour row already says (with their glyphs), so they are said once. */
  readonly glyphs: ReadonlySet<string>;
};

/** The colour key with its top left at (x, y), or undefined for a drawing without colour. */
export function paletteKeySvg(source: PaletteKeySource, x: number, y: number): PaletteKeySvg | undefined {
  const rows = paletteKeyRows(source);
  if (rows.length === 0) return undefined;
  const { width, height } = drawingKeyLayout(rows);
  const body = renderToStaticMarkup(createElement(DrawingKeyRows, { rows }));
  return {
    svg: `<g data-export-palette-key="true" transform="translate(${x} ${y})">${body}</g>`,
    width,
    height,
    glyphs: new Set(rows.flatMap((row) => (row.glyph === undefined ? [] : [row.glyph]))),
  };
}
