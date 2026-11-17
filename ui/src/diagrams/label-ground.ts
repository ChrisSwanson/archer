/**
 * What an edge label is drawn on (treatment A, owner's choice, redesign slice 6): no plate. The line stops around
 * the words, the gap painted in the colour of whatever is behind the label -- the canvas, or the panel it sits on --
 * so nothing reads as a box, and the words never sit on their own line (ADR 0030: a label never hides its line).
 *
 * The words are the softer slate (`--text-dim`, 4.5:1 or more on every neutral ground) and, on a family panel, the
 * family's ink: secondary text on a coloured surface takes the hue, never grey.
 *
 * One answer for the canvas (`xflow-adapter.ts`) and the export (`export/svg.ts`), so both draw the same gap.
 */
import type { LayoutResult } from "../layout/elk-layout";
import { FAMILY_TOKENS, groupPanelsOf, indexCategories, type GroupPanels, type Palette } from "./palette";

/** One part of a label's gap, in the label's own coordinates (0,0 is its top-left), and the colour behind it. */
export type GroundPiece = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: string;
};

/**
 * A label's ground: one `fill` for the whole gap, or -- when the label straddles a panel's edge -- `pieces`, each
 * part in the colour behind it, with the frame's line left showing between them. `fill` and `ink` are then the
 * label's middle's.
 */
export type LabelGround = { readonly fill: string; readonly ink: string; readonly pieces?: readonly GroundPiece[] };

/** How far a piece stops short of a frame's line on each side: half the widest frame line (2px). */
const FRAME_LINE_CLEARANCE_PX = 1;

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const containsPoint = (box: Box, x: number, y: number): boolean =>
  x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;

/** The innermost (smallest) group that holds the point, if any. */
function innermostAt<G extends Box>(groups: readonly G[], x: number, y: number): G | undefined {
  let behind: G | undefined;
  for (const group of groups)
    if (
      containsPoint(group, x, y) &&
      (behind === undefined || group.width * group.height < behind.width * behind.height)
    )
      behind = group;
  return behind;
}

/**
 * The parts of a label's gap, split where a frame's edge runs through it; `undefined` when none does. Each cell of
 * the split takes the colour of the innermost panel at its middle, and stops short of a frame line that runs along
 * its side, so the frame is not erased under the words.
 */
function piecesOf<G extends Box>(
  label: Box,
  groups: readonly G[],
  fillOf: (group: G | undefined) => string,
): GroundPiece[] | undefined {
  const [left, top, right, bottom] = [label.x, label.y, label.x + label.width, label.y + label.height];
  const inside = (v: number, lo: number, hi: number): boolean => v > lo && v < hi;
  // Vertical frame lines (x, from y0 to y1) and horizontal ones (y, from x0 to x1) that cross the label.
  const verticals: { at: number; from: number; to: number }[] = [];
  const horizontals: { at: number; from: number; to: number }[] = [];
  for (const g of groups) {
    const [gl, gt, gr, gb] = [g.x, g.y, g.x + g.width, g.y + g.height];
    if (gr <= left || gl >= right || gb <= top || gt >= bottom) continue;
    for (const x of [gl, gr]) if (inside(x, left, right)) verticals.push({ at: x, from: gt, to: gb });
    for (const y of [gt, gb]) if (inside(y, top, bottom)) horizontals.push({ at: y, from: gl, to: gr });
  }
  if (verticals.length === 0 && horizontals.length === 0) return undefined;
  const xs = [...new Set([left, right, ...verticals.map((l) => l.at)])].sort((a, b) => a - b);
  const ys = [...new Set([top, bottom, ...horizontals.map((l) => l.at)])].sort((a, b) => a - b);
  // A cell's side is cleared only where a frame line really runs along it.
  const along = (lines: typeof verticals, at: number, lo: number, hi: number): boolean =>
    lines.some((l) => l.at === at && l.from <= lo && l.to >= hi);
  const pieces: GroundPiece[] = [];
  for (let i = 0; i + 1 < xs.length; i++)
    for (let j = 0; j + 1 < ys.length; j++) {
      const [x0, x1, y0, y1] = [xs[i]!, xs[i + 1]!, ys[j]!, ys[j + 1]!];
      const c = FRAME_LINE_CLEARANCE_PX;
      const l = x0 + (along(verticals, x0, y0, y1) ? c : 0);
      const r = x1 - (along(verticals, x1, y0, y1) ? c : 0);
      const t = y0 + (along(horizontals, y0, x0, x1) ? c : 0);
      const b = y1 - (along(horizontals, y1, x0, x1) ? c : 0);
      if (r <= l || b <= t) continue;
      const fill = fillOf(innermostAt(groups, (x0 + x1) / 2, (y0 + y1) / 2));
      pieces.push({ x: l - left, y: t - top, width: r - l, height: b - t, fill });
    }
  return pieces;
}

/** A label on the open canvas. */
export const CANVAS_GROUND: LabelGround = { fill: "var(--bg)", ink: "var(--text-dim)" };

/** The fill a group's panel is painted in: its family's tint, the nested neutral step, or the outer neutral. */
function panelFill(panel: { readonly palette: Palette; readonly nested: boolean } | undefined): string {
  const family = panel?.palette.family;
  if (family !== undefined) return FAMILY_TOKENS[family].panel;
  return panel?.nested === true ? "var(--group-bg-alt)" : "var(--group-bg)";
}

/**
 * Each labelled edge's ground: the innermost panel that holds the middle of its label (the smallest that does), or
 * the canvas when none does -- split into `pieces` when a panel's edge runs through the label.
 */
export function labelGrounds(
  layout: Pick<LayoutResult, "edges" | "groups" | "categories">,
  panels: GroupPanels = groupPanelsOf(layout.groups, indexCategories(layout.categories)),
): Map<string, LabelGround> {
  const grounds = new Map<string, LabelGround>();
  for (const edge of layout.edges) {
    const anchor = edge.labelAnchor;
    if (anchor === undefined || !edge.label) continue;
    const x = anchor.x + anchor.width / 2;
    const y = anchor.y + anchor.height / 2;
    const groundOf = (group: (typeof layout.groups)[number] | undefined): LabelGround => {
      if (group === undefined) return CANVAS_GROUND;
      const panel = panels.get(group.id);
      const family = panel?.palette.family;
      return { fill: panelFill(panel), ink: family === undefined ? "var(--text-dim)" : FAMILY_TOKENS[family].ink };
    };
    const middle = groundOf(innermostAt(layout.groups, x, y));
    const pieces = piecesOf(anchor, layout.groups, (group) => groundOf(group).fill);
    grounds.set(edge.id, pieces === undefined ? middle : { ...middle, pieces });
  }
  return grounds;
}
