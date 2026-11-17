/**
 * The size of every figure the graph canvas draws for the newer diagram types
 * (`diagrams/figures.ts`), worked out from the text alone, as
 * `graph-metrics.ts` does for a flowchart node.
 *
 * The layout sizes each box from here and the node component draws exactly
 * the rows computed here, in the same face, so no figure overflows the box
 * ELK placed. Sizes the stylesheet must agree with are stated as constants
 * and applied inline by the component, so there is one number for each.
 */
import type { GraphDirection } from "../diagrams/projection";
import type { NodeFigure } from "../diagrams/figures";
import { CYLINDER_CAP_PX, graphFontPx, NEST_CONTROL_CLEAR_PX, nodeBox, widest, wrap } from "./graph-metrics";
import { DEFAULT_TYPEFACE, estimateTextWidth, truncateToWidth, wrapText, type TypefaceId } from "./text-measure";
import { c4TypeLine } from "../diagrams/figures";
import type { EntityAttributeRow } from "../diagrams/figures";

/** A state's note: the sheet's text size, its padding, and how wide it may grow. */
export const NOTE_FONT_PX = 12;
export const NOTE_LINE_PX = 16;
export const NOTE_PAD_X = 8;
export const NOTE_PAD_Y = 6;
const NOTE_MAX_TEXT_PX = 168;
/** The gap between a state and its note, which the dashed tie crosses. */
export const NOTE_GAP_PX = 18;

/** The pseudo-states, as UML sizes them against a state box. */
// A touch larger than UML's bare dot, so the marks read as marks, not specks.
const INITIAL_PX = 26;
const FINAL_PX = 30;
const CHOICE_PX = 40;
/** A fork or join bar: its length across the flow and its thickness along it. */
const BAR_LENGTH_PX = 96;
const BAR_THICKNESS_PX = 10;

export type NoteBox = {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly string[];
};

export type FigureBox = {
  readonly width: number;
  readonly height: number;
  /** The label in the rows it is drawn as; empty when the figure draws no label. */
  readonly lines: readonly string[];
  readonly note?: NoteBox;
  /** An entity's attribute table, when it has attributes. */
  readonly table?: EntityTable;
  /** A C4 element's type line and description, in the rows they are drawn as. */
  readonly c4?: {
    readonly typeLine: string;
    readonly description: readonly string[];
    readonly glyph: boolean;
    readonly queue: boolean;
  };
};

/** A C4 element's lines: the label at node size, then the type line and the description smaller. */
const C4_PAD_X = 14;
const C4_PAD_Y = 10;
export const C4_TYPE_FONT_PX = 11;
export const C4_TYPE_LINE_PX = 15;
export const C4_TEXT_FONT_PX = 12;
export const C4_TEXT_LINE_PX = 16;
export const C4_PERSON_GLYPH_PX = 26;
/** A queue's text keeps this far clear of each cylinder end. */
const C4_QUEUE_END_PX = 26;
const C4_WRAP_PX = 200;
const C4_DESCRIPTION_LINES = 4;
const C4_MIN_WIDTH = 180;

/** A service: its icon over its name. */
export const SERVICE_ICON_PX = 28;
const SERVICE_PAD_Y = 10;
const SERVICE_MIN_WIDTH = 120;
const JUNCTION_PX = 14;

/** On a closed container (the nested view's "+" in its corner), how much narrower its text runs, per side. */
const controlClear = (control: boolean): number => (control ? Math.max(0, NEST_CONTROL_CLEAR_PX - C4_PAD_X) : 0);

function c4Box(
  figure: Extract<NodeFigure, { type: "c4" }>,
  label: string,
  typeface: TypefaceId,
  control = false,
): FigureBox {
  const labelPx = graphFontPx(typeface).nodeLabel;
  const clear = controlClear(control);
  const lines = wrap(label, C4_WRAP_PX - 2 * clear, labelPx, true, typeface);
  const typeLine = c4TypeLine(figure);
  const description =
    figure.description === undefined
      ? []
      : wrapText(figure.description, C4_WRAP_PX - 2 * clear, C4_TEXT_FONT_PX, C4_DESCRIPTION_LINES, false, typeface);
  const glyph = figure.kind === "person";
  const textWidth = Math.max(
    widest(lines, labelPx, true, typeface),
    estimateTextWidth(typeLine, C4_TYPE_FONT_PX, false, typeface),
    widest(description, C4_TEXT_FONT_PX, false, typeface),
  );
  const textHeight =
    (glyph ? C4_PERSON_GLYPH_PX + 2 : 0) + lines.length * 18 + C4_TYPE_LINE_PX + description.length * C4_TEXT_LINE_PX;
  const ends = figure.shape === "queue" ? 2 * C4_QUEUE_END_PX : 0;
  const lid = figure.shape === "database" ? 2 * CYLINDER_CAP_PX + 4 : 0;
  return {
    width: Math.max(C4_MIN_WIDTH, Math.ceil(textWidth) + 2 * (C4_PAD_X + clear) + ends),
    height: textHeight + 2 * C4_PAD_Y + lid,
    lines,
    c4: { typeLine, description, glyph, queue: figure.shape === "queue" },
  };
}

function serviceBox(
  figure: Extract<NodeFigure, { type: "service" }>,
  label: string,
  typeface: TypefaceId,
  control = false,
): FigureBox {
  const labelPx = graphFontPx(typeface).nodeLabel;
  const clear = controlClear(control);
  const lines = wrap(label, C4_WRAP_PX - 2 * clear, labelPx, true, typeface);
  const icon = figure.icon === undefined ? 0 : SERVICE_ICON_PX + 4;
  return {
    width: Math.max(SERVICE_MIN_WIDTH, widest(lines, labelPx, true, typeface) + 2 * (C4_PAD_X + clear)),
    height: icon + lines.length * 18 + 2 * SERVICE_PAD_Y,
    lines,
  };
}

/** An entity's table: its title band, then one row per attribute in four columns. */
export const ER_PAD_X = 10;
const ER_TITLE_PAD_Y = 7;
export const ER_ROW_PX = 20;
export const ER_ROW_FONT_PX = 12;
export const ER_COLUMN_GAP_PX = 10;
/**
 * A key chip (PK, FK, UK) and a state's start or end word: marks, but set at the notation's smallest
 * reading size (an attribute row, a transition caption), so where the opening framing stops (`readingZoom`)
 * they read as that text does (round 1, V6; `round1-verify.test.tsx`).
 */
export const ER_KEY_FONT_PX = ER_ROW_FONT_PX;
export const STATE_MARK_FONT_PX = 12;
export const ER_KEY_PAD_X = 4;
export const ER_KEY_GAP_PX = 3;
/** A comment longer than this is cut, and read whole in the accessible name. */
const ER_COMMENT_MAX_PX = 160;
const ER_MIN_WIDTH = 140;

export type EntityTable = {
  /** The title band's height; the rows start below it. */
  readonly titleHeight: number;
  readonly columns: { readonly type: number; readonly name: number; readonly keys: number; readonly comment: number };
  readonly rows: readonly (EntityAttributeRow & { readonly shownComment: string })[];
};

function keysWidth(keys: readonly string[], typeface: TypefaceId): number {
  return keys.reduce(
    (sum, key, index) =>
      sum + estimateTextWidth(key, ER_KEY_FONT_PX, true, typeface) + 2 * ER_KEY_PAD_X + (index > 0 ? ER_KEY_GAP_PX : 0),
    0,
  );
}

/**
 * An entity: its name in a title band over a table of attributes. Columns
 * are as wide as their widest cell, and an empty column takes no room.
 */
function entityBox(attributes: readonly EntityAttributeRow[], label: string, typeface: TypefaceId): FigureBox {
  if (attributes.length === 0) {
    const box = nodeBox(label, "rectangle", [], typeface, false, false);
    return { width: box.width, height: box.height, lines: box.lines };
  }
  const labelPx = graphFontPx(typeface).nodeLabel;
  const lines = wrap(label, 260, labelPx, true, typeface);
  const rows = attributes.map((row) => ({
    ...row,
    shownComment:
      row.comment === undefined ? "" : truncateToWidth(row.comment, ER_COMMENT_MAX_PX, ER_ROW_FONT_PX, false, typeface),
  }));
  const widestOf = (cells: readonly string[], bold = false): number =>
    Math.max(0, ...cells.map((cell) => estimateTextWidth(cell, ER_ROW_FONT_PX, bold, typeface)));
  const columns = {
    type: widestOf(rows.map((row) => row.type)),
    name: widestOf(
      rows.map((row) => row.name),
      true,
    ),
    keys: Math.max(0, ...rows.map((row) => keysWidth(row.keys, typeface))),
    comment: widestOf(rows.map((row) => row.shownComment)),
  };
  const used = [columns.type, columns.name, columns.keys, columns.comment].filter((width) => width > 0);
  const tableWidth = used.reduce((sum, width) => sum + width, 0) + ER_COLUMN_GAP_PX * (used.length - 1);
  const titleHeight = lines.length * 18 + 2 * ER_TITLE_PAD_Y;
  const width = Math.max(
    ER_MIN_WIDTH,
    tableWidth + 2 * ER_PAD_X,
    widest(lines, labelPx, true, typeface) + 2 * ER_PAD_X,
  );
  // The last row keeps half a row of air under it.
  const height = titleHeight + rows.length * ER_ROW_PX + ER_ROW_PX / 2;
  return { width, height, lines, table: { titleHeight, columns, rows } };
}

/** The sheet a note is written on. */
export function noteBox(text: string, typeface: TypefaceId = DEFAULT_TYPEFACE): NoteBox {
  const lines = wrap(text, NOTE_MAX_TEXT_PX, NOTE_FONT_PX, false, typeface);
  return {
    width: widest(lines, NOTE_FONT_PX, false, typeface) + 2 * NOTE_PAD_X,
    height: lines.length * NOTE_LINE_PX + 2 * NOTE_PAD_Y,
    lines,
  };
}

/** Whether the flow runs across the page (so a bar stands upright). */
const across = (direction: GraphDirection | undefined): boolean => direction === "lr" || direction === "rl";

/**
 * The box a figure needs. `shape` is the outline the projection gave the node
 * (`project-models.ts`), which is what a plain labelled box is sized as.
 */
export function figureBox(
  figure: NodeFigure,
  label: string,
  shape: string | undefined,
  direction: GraphDirection | undefined,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
  /** A closed container of the nested view: its text keeps clear of the "+" in its corner. */
  control = false,
): FigureBox {
  switch (figure.type) {
    case "state": {
      const note = figure.note === undefined ? undefined : noteBox(figure.note.text, typeface);
      const withNote = (box: Omit<FigureBox, "note">): FigureBox => (note === undefined ? box : { ...box, note });
      switch (figure.kind) {
        case "initial":
          return withNote({ width: INITIAL_PX, height: INITIAL_PX, lines: [] });
        case "final":
          return withNote({ width: FINAL_PX, height: FINAL_PX, lines: [] });
        case "choice":
          return withNote({ width: CHOICE_PX, height: CHOICE_PX, lines: [] });
        case "fork":
        case "join":
          return withNote(
            across(direction)
              ? { width: BAR_THICKNESS_PX, height: BAR_LENGTH_PX, lines: [] }
              : { width: BAR_LENGTH_PX, height: BAR_THICKNESS_PX, lines: [] },
          );
        case "state": {
          const box = nodeBox(label, shape, [], typeface, control, false);
          return withNote({ width: box.width, height: box.height, lines: box.lines });
        }
      }
      break;
    }
    case "entity":
      return entityBox(figure.attributes, label, typeface);
    case "c4":
      return c4Box(figure, label, typeface, control);
    case "service":
      return serviceBox(figure, label, typeface, control);
    case "junction":
      return { width: JUNCTION_PX, height: JUNCTION_PX, lines: [] };
    default:
      break;
  }
  const box = nodeBox(label, shape, [], typeface, control, false);
  return { width: box.width, height: box.height, lines: box.lines };
}
