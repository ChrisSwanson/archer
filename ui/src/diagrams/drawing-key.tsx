/* @jsxRuntime automatic */
/* @jsxImportSource react */
/**
 * The colour key an EXPORT carries beside the drawing (DESIGN.md, "The Key"): compact rows, one per colour the
 * drawing uses (`palette-key.ts`), each the real sample beside a short label -- the author's meaning for a
 * category (`%% archer-key gpu: Model server on a GPU`), else its class name as written; a kind keeps its word
 * and glyph. A picture has no side panel, so the key is part of it, at its top right, and covers nothing.
 *
 * The canvas draws no legend in the drawing (owner, 2026-11-12: redundant with the Diagram Key); the side
 * panel's Diagram Key is the reader's key, with the same rows in the same order.
 */
import type { JSX } from "react";
import { KeySymbol } from "../export/KeySymbol";
import { estimateTextWidth, wrapText } from "../layout/text-measure";
import type { PaletteKeyRow } from "./palette-key";

/** A label's column: the longest meaning (32 characters) on one line; a long class name wraps. */
const TEXT_WIDTH = 220;
/** Close to the owner's reference legend (about 22 by 18 at 1x). */
const SWATCH = { width: 24, height: 18 } as const;
const GLYPH = 18;
const FONT = 13;
const LINE = 17;
const ROW_GAP = 10;

export type DrawingKeyLine = {
  readonly row: PaletteKeyRow;
  /** The row's top. */
  readonly y: number;
  readonly textX: number;
  readonly lines: readonly string[];
};

export type DrawingKeyLayout = {
  readonly rows: readonly DrawingKeyLine[];
  readonly width: number;
  readonly height: number;
};

/** Where each row goes, and the legend's size: the sample, a kind's glyph, then the label, up to three lines. */
export function drawingKeyLayout(rows: readonly PaletteKeyRow[]): DrawingKeyLayout {
  const laid: DrawingKeyLine[] = [];
  let y = 0;
  let width = 0;
  for (const row of rows) {
    const textX = SWATCH.width + 10 + (row.glyph === undefined ? 0 : GLYPH + 6);
    const lines = wrapText(row.label, TEXT_WIDTH, FONT, 3, false);
    laid.push({ row, y, textX, lines });
    width = Math.max(width, textX + Math.max(...lines.map((line) => estimateTextWidth(line, FONT))));
    y += Math.max(SWATCH.height, lines.length * LINE) + ROW_GAP;
  }
  return { rows: laid, width: Math.ceil(width), height: rows.length === 0 ? 0 : y - ROW_GAP };
}

/**
 * The rows, as SVG with its origin at the legend's top left: each sample in the same 2px border, corner and dash
 * its members are drawn with, in theme tokens (an export resolves them to the theme's literal colours).
 */
export function DrawingKeyRows({ rows }: { readonly rows: readonly PaletteKeyRow[] }): JSX.Element {
  return (
    <>
      {drawingKeyLayout(rows).rows.map(({ row, y, textX, lines }) => (
        <g key={row.key} data-key-row={row.key}>
          <rect
            x={1}
            y={y + 1}
            width={SWATCH.width - 2}
            height={SWATCH.height - 2}
            rx={row.swatch.sample === "group" ? 6 : 5}
            fill={row.swatch.fill}
            stroke={row.swatch.border}
            // Its members' line role (`--line-panel` 1.5px, `--line-node` 1.5px), as the sidebar Key's sample.
            strokeWidth={1.5}
            {...(row.swatch.dashed ? { strokeDasharray: "5 3" } : {})}
          />
          {row.glyph === undefined ? null : (
            <g transform={`translate(${SWATCH.width + 8} ${y})`} color="var(--text-dim)">
              <KeySymbol label={row.glyph} size={GLYPH} />
            </g>
          )}
          <text fontSize={FONT} fill="var(--text)" stroke="none">
            {lines.map((line, i) => (
              <tspan key={line} x={textX} y={y + 13 + i * LINE}>
                {line}
              </tspan>
            ))}
          </text>
        </g>
      ))}
    </>
  );
}
