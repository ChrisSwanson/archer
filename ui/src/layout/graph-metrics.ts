/**
 * The size of everything the graph canvas draws text in, worked out from the
 * text alone.
 *
 * ELK has no font metrics, so every box it lays out has to arrive with its
 * dimensions. They are ESTIMATED rather than measured (`text-measure.ts`, the
 * estimator both canvases share): layout runs under jsdom in tests (which lays
 * nothing out) and has to give the same coordinates on every machine. The
 * estimate is for the TYPEFACE the design draws in, which every function here
 * that sizes text takes as its last argument.
 *
 * The renderer draws exactly the lines computed here (`nodeBox().lines`,
 * `edgeLabelBox().lines`), one unbreakable row each, so the browser never gets
 * to re-wrap a label into more rows than the box was sized for.
 *
 * The typography constants are the single source for both sides: the layout
 * sizes boxes from them and the stylesheet's `.archer-node` /
 * `.archer-edge-label` rules must state the same numbers.
 */

import type { EdgeLine, GraphDirection } from "../diagrams/projection";
import { DEFAULT_TYPEFACE, estimateTextWidth, type TypefaceId } from "./text-measure";

// The estimator is `text-measure.ts`'s -- the one both canvases share. It is
// re-exported because this module is where graph code has always asked for it.
export { estimateTextWidth };

/** The box of a node whose label fits on one line. */
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 60;

export const NODE_LABEL_FONT_PX = 14;
export const NODE_LABEL_LINE_PX = 18;
/**
 * A flowchart node's text (DESIGN.md, Typography and Diagram palette: Node text), after the reference: its
 * title (the first line) bold and a step larger than the description (every line after its first, `<br/>` in
 * Mermaid), regular, on a comfortable line, a small gap between them. The canvas tokens
 * `--type-canvas-node-title` and `--type-canvas-node-description` state the same sizes, the
 * `.archer-node-title-row` and `.archer-node-description-row` rules the lines and gap, and the export painter
 * draws them. Figures (a state, an entity) keep `NODE_LABEL_*`.
 */
/**
 * Sized after the owner's references (redesign slice 4, 2026-11-12): an 18px bold title over a 15px description on
 * a 23px line (about 1.55), a 4px gap between them.
 */
export const NODE_TITLE_FONT_PX = 18;
export const NODE_TITLE_LINE_PX = 24;
/** The title's weight: bold, a clear step above the regular description (`.archer-node-title-row`). */
export const NODE_TITLE_WEIGHT = 700;
export const NODE_DESCRIPTION_FONT_PX = 15;
export const NODE_DESCRIPTION_LINE_PX = 23;
export const NODE_DESCRIPTION_GAP_PX = 4;
/** The kind caption ("DATABASE") a semantic class adds above the label, at the type floor (`.archer-node-kind`). */
export const NODE_KIND_FONT_PX = 11;
export const NODE_KIND_LINE_PX = 16;

/** Room round a node's words (the references keep about this much): `NODE_PAD_X` each side, `NODE_PAD_Y` above and below. */
const NODE_PAD_X = 24;
const NODE_PAD_Y = 16;
/**
 * A box widens this far before its label wraps. Width is cheap in a layered
 * graph that flows downwards and height is not -- every extra row is paid for
 * by the whole layer -- so a label a little too long for the standard box
 * gets a wider box rather than a second line.
 */
/**
 * About the width of the reference's longer cards (the loop's are about 390px), so a long description takes two
 * or three lines rather than four (redesign slice 4, 2026-11-12).
 */
const NODE_MAX_WIDTH = 392;
/**
 * On a box with the nested view's "+" in its top right corner, the label keeps this far from each
 * side (not the usual NODE_PAD_X), so no row runs under the control: its inset in the roundest corner
 * (a state's 16 px), its 20 px and a gap (`nesting/toggle-place.ts`, at zoom 1, the size a diagram is
 * read at). Both sides, so the label stays centred.
 */
export const NEST_CONTROL_CLEAR_PX = 34;
/** Letter-spacing of the kind caption, in em; `styles.css` must agree. */
const NODE_KIND_TRACKING_EM = 0.08;
/** The glyph beside the kind caption, and the gap between them. */
const NODE_KIND_GLYPH_PX = 15;
/**
 * A flowchart person says what it is with a small glyph beside its title, not a "Person" row above it (review C.11,
 * redesign slice 4): the glyph's size and its gap before the title. The Key and the accessible name say the rest.
 */
export const PERSON_GLYPH_PX = 16;
export const PERSON_GLYPH_GAP_PX = 6;
/** Text in a circle or a diamond wraps narrower: their width is also height. */
const COMPACT_TEXT_PX = 116;
const MIN_ROUND_PX = 88;
/** Corner radius of the `rounded` shape; `styles.css` must agree. */
export const ROUNDED_RADIUS_PX = 16;
/** How far a cylinder's curved ends rise and fall; `styles.css` must agree. */
export const CYLINDER_CAP_PX = 7;
/** How far inside each end a subroutine's bar stands; `styles.css` must agree. */
export const SUBROUTINE_BAR_PX = 8;
/** A hexagon's two points are cut back this share of its height at each end. */
const HEXAGON_INSET_SHARE = 0.25;

export const EDGE_LABEL_FONT_PX = 13;
export const EDGE_LABEL_LINE_PX = 18;
/** The gap the line stops short of the words by (treatment A: no plate; `diagrams/label-ground.ts`). */
export const EDGE_LABEL_PAD_X = 4;
export const EDGE_LABEL_PAD_Y = 2;
/**
 * An edge caption wraps at about this many characters, on at most two lines (ADR 0030, amended 2026-11-12: 24,
 * was 14 -- the owner's reference keeps a label of four or five words on one line, and with no plate the line
 * still shows either side of it). Measured in the caption's own
 * face from a sample of that length, so every typeface wraps at the same reading
 * length.
 */
export const EDGE_LABEL_WRAP_CHARS = 24;
export const EDGE_LABEL_MAX_LINES = 2;
/** The sample `EDGE_LABEL_WRAP_CHARS` is measured with: ordinary prose letters and a space. */
const WRAP_SAMPLE = "Reads and writes the orders and the stock";
/**
 * How much of its line a caption leaves showing on each side, along the edge.
 * The layout reserves it around the plate (`elk-layout.ts`); the plate itself
 * is drawn at its real size.
 */
export const EDGE_LABEL_LEAD_PX = 10;

/**
 * The sizes graph text is drawn at, per typeface.
 *
 * A width is only right at the size the text is drawn at. These are the
 * stylesheet's numbers (`.archer-node` and `.archer-edge-label`), which
 * `tests/text-metrics-unified.test.ts` checks.
 */
const GRAPH_FONT_PX: Readonly<Record<TypefaceId, { readonly nodeLabel: number; readonly caption: number }>> = {
  fira: { nodeLabel: NODE_LABEL_FONT_PX, caption: EDGE_LABEL_FONT_PX },
};

export function graphFontPx(typeface: TypefaceId = DEFAULT_TYPEFACE): {
  readonly nodeLabel: number;
  readonly caption: number;
} {
  return GRAPH_FONT_PX[typeface];
}

/** Every direction a graph's source can declare, the default first. */
export const GRAPH_DIRECTIONS = ["tb", "bt", "lr", "rl"] as const satisfies readonly GraphDirection[];

/** Every way an edge's line can be drawn, the default first. */
export const EDGE_LINES = ["solid", "dotted", "thick", "dashed", "dashdot"] as const satisfies readonly EdgeLine[];

/** Every shape the Mermaid subset can declare. */
export const NODE_SHAPES = [
  "rectangle",
  "rounded",
  "stadium",
  "circle",
  "diamond",
  "cylinder",
  "hexagon",
  "subroutine",
] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

/** Every semantic class the canvas gives a treatment of its own. */
export const NODE_KINDS = ["person", "system", "container", "component", "database", "external"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** An absent or unrecognised shape is drawn as the plain rectangle. */
export function shapeOf(shape: string | undefined): NodeShape {
  return (NODE_SHAPES as readonly string[]).includes(shape ?? "") ? (shape as NodeShape) : "rectangle";
}

/**
 * The outline a node is actually drawn with.
 *
 * Its shape, except that a plain rectangle carrying the `database` class is
 * drawn as a cylinder -- the same cylinder `shape: cylinder` declares, so
 * `db[(Orders)]`, `db[Orders]:::database` and `db[(Orders)]:::database` are one
 * outline and never two decorations stacked. Only the rectangle gives way: a
 * node the author gave any other shape keeps it, and says "database" with its
 * caption and glyph.
 *
 * This is the ONE place that decision is made. The layout sizes the box and
 * ends the wires from it, and the adapter names the element's shape class from
 * it, so the stylesheet never has to ask about the class to draw the outline.
 */
export type Outline = NodeShape;

export function outlineOf(shape: string | undefined, classes: readonly string[]): Outline {
  const drawn = shapeOf(shape);
  return drawn === "rectangle" && kindOf(classes) === "database" ? "cylinder" : drawn;
}

/** The first semantic class a node carries, if it carries one. */
export function kindOf(classes: readonly string[]): NodeKind | undefined {
  return classes.find((name): name is NodeKind => (NODE_KINDS as readonly string[]).includes(name));
}

/**
 * Greedy word wrap to lines of at most `maxWidth` px.
 *
 * A token no line can hold is split mid-token rather than left to overrun.
 * Nothing is truncated: the lines always spell the whole text.
 */
export function wrap(text: string, maxWidth: number, fontPx: number, bold: boolean, typeface: TypefaceId): string[] {
  // A label's line break (`<br/>` in Mermaid, `\n` in the model) always starts a new line.
  if (text.includes("\n")) return text.split("\n").flatMap((line) => wrap(line, maxWidth, fontPx, bold, typeface));
  const fits = (candidate: string): boolean => estimateTextWidth(candidate, fontPx, bold, typeface) <= maxWidth;
  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/).filter((token) => token.length > 0)) {
    const joined = current === "" ? word : `${current} ${word}`;
    if (fits(joined)) {
      current = joined;
      continue;
    }
    if (current !== "") {
      lines.push(current);
      current = "";
    }
    let rest = word;
    while (!fits(rest)) {
      const chars = [...rest];
      let take = chars.length - 1;
      while (take > 1 && !fits(chars.slice(0, take).join(""))) {
        take -= 1;
      }
      lines.push(chars.slice(0, take).join(""));
      rest = chars.slice(take).join("");
    }
    current = rest;
  }
  if (current !== "" || lines.length === 0) {
    lines.push(current);
  }
  return lines;
}

export function widest(lines: readonly string[], fontPx: number, bold: boolean, typeface: TypefaceId): number {
  return Math.max(0, ...lines.map((line) => estimateTextWidth(line, fontPx, bold, typeface)));
}

export type NodeBox = {
  /** The bounding box handed to ELK and drawn by the canvas. */
  readonly width: number;
  readonly height: number;
  /** The label, broken into the rows it is drawn as: the title's rows, then the description's. */
  readonly lines: readonly string[];
  /** How many of `lines` are the title (weight 600, `NODE_LABEL_*`); the rest are the description. */
  readonly titleRows: number;
  /** The centred block the kind caption and the label rows occupy. */
  readonly textWidth: number;
  readonly textHeight: number;
};

/**
 * The box a node needs: the standard 180x60 where the label fits on a line,
 * grown -- never overflowed -- where it does not.
 */
export function nodeBox(
  label: string,
  shapeName: string | undefined,
  classes: readonly string[],
  typeface: TypefaceId = DEFAULT_TYPEFACE,
  /** The box carries the nested view's "+" (a closed container): the label stays clear of it. */
  control = false,
  /** A title over a description; false for figures that draw every row alike (a state, an entity). */
  described = true,
): NodeBox {
  const labelPx = graphFontPx(typeface).nodeLabel;
  const shape = outlineOf(shapeName, classes);
  const kind = kindOf(classes);
  const compact = shape === "circle" || shape === "diamond";
  // A person's glyph stands beside its title's first row; every other kind keeps its caption row above the label.
  const beside = kind === "person" ? PERSON_GLYPH_PX + PERSON_GLYPH_GAP_PX : 0;
  const kicker = kind !== undefined && kind !== "person";

  // A round shape wraps narrower: every pixel of its width is also a pixel of
  // its height.
  const clear = control && !compact ? NEST_CONTROL_CLEAR_PX - NODE_PAD_X : 0;
  const wrapAt = compact ? COMPACT_TEXT_PX : NODE_MAX_WIDTH - 2 * (NODE_PAD_X + clear);

  // The first line is the title; the lines after it, the description (DESIGN.md, Diagram palette).
  const breakAt = described ? label.indexOf("\n") : -1;
  const titlePx = described ? NODE_TITLE_FONT_PX : labelPx;
  const title = wrap(breakAt < 0 ? label : label.slice(0, breakAt), wrapAt - beside, titlePx, true, typeface);
  const description =
    breakAt < 0 ? [] : wrap(label.slice(breakAt + 1), wrapAt, NODE_DESCRIPTION_FONT_PX, false, typeface);
  const lines = [...title, ...description];
  const kindWidth = !kicker
    ? 0
    : estimateTextWidth(kind.toUpperCase(), NODE_KIND_FONT_PX, true, typeface) +
      Math.ceil(kind.length * NODE_KIND_TRACKING_EM * NODE_KIND_FONT_PX) +
      NODE_KIND_GLYPH_PX;
  const textWidth = Math.max(
    widest(title.slice(0, 1), titlePx, true, typeface) + beside,
    widest(title.slice(1), titlePx, true, typeface),
    widest(description, NODE_DESCRIPTION_FONT_PX, false, typeface),
    kindWidth,
  );
  const textHeight =
    title.length * (described ? NODE_TITLE_LINE_PX : NODE_LABEL_LINE_PX) +
    (description.length === 0 ? 0 : NODE_DESCRIPTION_GAP_PX + description.length * NODE_DESCRIPTION_LINE_PX) +
    (kicker ? NODE_KIND_LINE_PX : 0);

  let width: number;
  let height: number;
  switch (shape) {
    case "circle": {
      // The text block's diagonal is the smallest circle that holds it.
      const diameter = Math.ceil(Math.hypot(textWidth, textHeight)) + 2 * NODE_PAD_Y;
      width = height = Math.max(MIN_ROUND_PX, diameter);
      break;
    }
    case "diamond": {
      // A centred w x h block fits a square diamond of side-to-side D exactly
      // when w/D + h/D <= 1.
      width = height = Math.max(MIN_ROUND_PX, textWidth + textHeight + 2 * NODE_PAD_Y);
      break;
    }
    case "stadium": {
      height = Math.max(NODE_HEIGHT, textHeight + 2 * NODE_PAD_Y);
      // The end caps eat into the row at the text block's top and bottom.
      const radius = height / 2;
      const inset = radius - Math.sqrt(radius * radius - (textHeight / 2) ** 2);
      width = Math.max(NODE_WIDTH, Math.ceil(textWidth + 2 * inset + 2 * NODE_PAD_X));
      break;
    }
    case "cylinder": {
      // The lid is a full ellipse across the top, and the text sits below it.
      width = Math.max(NODE_WIDTH, textWidth + 2 * NODE_PAD_X);
      height = Math.max(NODE_HEIGHT, textHeight + 2 * CYLINDER_CAP_PX + 12);
      break;
    }
    case "hexagon": {
      height = Math.max(NODE_HEIGHT, textHeight + 2 * NODE_PAD_Y);
      // The slanted ends have closed in by this much at the text block's top
      // and bottom rows, which is where the block is nearest to them.
      const inset = hexagonInset(height) * (textHeight / height);
      width = Math.max(NODE_WIDTH, Math.ceil(textWidth + 2 * inset + 2 * NODE_PAD_X));
      break;
    }
    case "subroutine": {
      // The label keeps its padding INSIDE the two bars.
      width = Math.max(NODE_WIDTH, textWidth + 2 * NODE_PAD_X + 2 * SUBROUTINE_BAR_PX);
      height = Math.max(NODE_HEIGHT, textHeight + 2 * NODE_PAD_Y);
      break;
    }
    default: {
      width = Math.max(NODE_WIDTH, textWidth + 2 * NODE_PAD_X);
      height = Math.max(NODE_HEIGHT, textHeight + 2 * NODE_PAD_Y);
    }
  }

  if (clear > 0) width = Math.max(width, Math.ceil(textWidth + 2 * NEST_CONTROL_CLEAR_PX));
  return { width, height, lines, titleRows: title.length, textWidth, textHeight };
}

/** Where an edge caption wraps in this face: `EDGE_LABEL_WRAP_CHARS` of prose. */
export function edgeLabelWrapPx(typeface: TypefaceId = DEFAULT_TYPEFACE): number {
  return Math.ceil(
    estimateTextWidth(WRAP_SAMPLE.slice(0, EDGE_LABEL_WRAP_CHARS), graphFontPx(typeface).caption, false, typeface),
  );
}

/**
 * A C4 relationship's technology and description are drawn on its caption's plate, under the label
 * (decided 2026-10-31; ADR 0030). They travel in the caption string itself, after this separator, so every
 * place that sizes or places a caption (layout, the nested view, the provisional layout, export) reserves
 * the taller plate without knowing about C4. A control character: no label typed in Mermaid holds one.
 * Read a caption through `captionParts` (or `edgeLabelBox`), never as text.
 */
const CAPTION_DETAIL = "\u001f";

/** The rows of a technology line: the C4 card's type line (`.archer-c4-type`, `figure-metrics.ts`). */
export const EDGE_TECHNOLOGY_FONT_PX = 11;
export const EDGE_TECHNOLOGY_LINE_PX = 15;
/**
 * A relationship's description wraps at this width (about 24 characters of the caption face), on at most
 * `EDGE_DETAIL_MAX_LINES` rows; a longer one widens the plate rather than being cut, as the label does.
 */
export const EDGE_DETAIL_WRAP_PX = 150;
const EDGE_DETAIL_MAX_LINES = 3;

/** A caption with a C4 relationship's detail; just the label when there is none, undefined when there is nothing. */
export function captionWithDetail(
  label: string | undefined,
  technology: string | undefined,
  description: string | undefined,
): string | undefined {
  if (!technology && !description) return label || undefined;
  return [label ?? "", technology ?? "", description ?? ""].join(CAPTION_DETAIL);
}

/** What a caption says: its label, and a C4 relationship's technology and description when it carries them. */
export function captionParts(caption: string): {
  readonly label: string;
  readonly technology?: string;
  readonly description?: string;
} {
  if (!caption.includes(CAPTION_DETAIL)) return { label: caption };
  const [label = "", technology = "", description = ""] = caption.split(CAPTION_DETAIL);
  return { label, ...(technology ? { technology } : {}), ...(description ? { description } : {}) };
}

/**
 * `text` wrapped at `wrapPx` on at most `maxLines` rows; past that the width grows (never a further row,
 * never a cut) until it fits.
 */
function wrapWidening(
  text: string,
  wrapPx: number,
  maxLines: number,
  fontPx: number,
  typeface: TypefaceId,
  balance = false,
): string[] {
  const at = (width: number) => wrap(text, width, fontPx, false, typeface);
  // The narrowest width in (low, high] that still wraps to at most `rows` rows.
  const narrowest = (low: number, high: number, rows: number): number => {
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (at(mid).length > rows) low = mid;
      else high = mid;
    }
    return high;
  };
  let lines = at(wrapPx);
  if (lines.length > maxLines)
    lines = at(
      narrowest(wrapPx, Math.ceil(estimateTextWidth(text.replace(/\n/g, " "), fontPx, false, typeface)) + 1, maxLines),
    );
  // Balanced: the same rows at the narrowest width that keeps them, so a last row is not one stray word.
  if (balance && lines.length > 1)
    lines = at(narrowest(0, Math.ceil(widest(lines, fontPx, false, typeface)), lines.length));
  return lines;
}

/**
 * The plate an edge caption is drawn on: its rows plus the plate's padding.
 *
 * The label is wrapped at `edgeLabelWrapPx`; one that would then need more than two
 * lines is widened, never given a third line and never cut, so the page
 * agrees with the service's lint (which counts characters and refuses what
 * needs a third line) without either of them truncating anything. A C4
 * relationship's technology (`technology`, one row in brackets) and description
 * (`description`, wrapped at `EDGE_DETAIL_WRAP_PX`) follow under it.
 */
export function edgeLabelBox(
  text: string,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
): {
  readonly width: number;
  readonly height: number;
  /** The label's rows; empty when the caption is a relationship's detail alone. */
  readonly lines: readonly string[];
  /** A relationship's technology, `[HTTPS]`: one row, or none. */
  readonly technology: readonly string[];
  /** A relationship's description, in the rows it is drawn as. */
  readonly description: readonly string[];
} {
  const captionPx = graphFontPx(typeface).caption;
  const parts = captionParts(text);
  // An author's own line breaks are kept up to the two-line cap; past it they
  // become spaces, so the caption still fits two lines and nothing is cut.
  const caption = parts.label.split("\n").length > EDGE_LABEL_MAX_LINES ? parts.label.replace(/\n/g, " ") : parts.label;
  const technology = parts.technology === undefined ? [] : [`[${parts.technology}]`];
  const description =
    parts.description === undefined
      ? []
      : wrapWidening(
          parts.description.replace(/\n/g, " "),
          EDGE_DETAIL_WRAP_PX,
          EDGE_DETAIL_MAX_LINES,
          captionPx,
          typeface,
          true,
        );
  const detail = Math.max(
    widest(technology, EDGE_TECHNOLOGY_FONT_PX, false, typeface),
    widest(description, captionPx, false, typeface),
  );
  // The label may use the width its detail already gives the plate, rather than wrapping inside it.
  const lines =
    caption === ""
      ? []
      : wrapWidening(
          caption,
          Math.max(edgeLabelWrapPx(typeface), Math.floor(detail)),
          EDGE_LABEL_MAX_LINES,
          captionPx,
          typeface,
        );
  const width = Math.max(widest(lines, captionPx, false, typeface), detail);
  return {
    width: width + 2 * EDGE_LABEL_PAD_X,
    height:
      lines.length * EDGE_LABEL_LINE_PX +
      technology.length * EDGE_TECHNOLOGY_LINE_PX +
      description.length * EDGE_LABEL_LINE_PX +
      2 * EDGE_LABEL_PAD_Y,
    lines,
    technology,
    description,
  };
}

/** How far a hexagon of this height is cut back at each end. */
function hexagonInset(height: number): number {
  return height * HEXAGON_INSET_SHARE;
}

/**
 * A hexagon's six corners, clockwise from the top-left one, relative to the
 * box's top-left: flat along the top and bottom, a point at each end.
 */
export function hexagonPoints(width: number, height: number): { x: number; y: number }[] {
  const inset = hexagonInset(height);
  return [
    { x: inset, y: 0 },
    { x: width - inset, y: 0 },
    { x: width, y: height / 2 },
    { x: width - inset, y: height },
    { x: inset, y: height },
    { x: 0, y: height / 2 },
  ];
}

/**
 * A convex polygon grown by `distance` on every side (or shrunk, if negative),
 * corners kept sharp. `points` run clockwise on screen (y downwards).
 *
 * A ring has to stand the same distance off every side, which scaling the
 * polygon does not give: a hexagon scaled about its centre moves its points
 * further than its flats.
 */
export function offsetPolygon(
  points: readonly { readonly x: number; readonly y: number }[],
  distance: number,
): { x: number; y: number }[] {
  const count = points.length;
  // Each side pushed out along its own outward normal, as a point and a direction.
  const sides = points.map((a, index) => {
    const b = points[(index + 1) % count];
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dx = (b.x - a.x) / length;
    const dy = (b.y - a.y) / length;
    // Clockwise with y downwards: the outward normal is the direction turned left.
    return { x: a.x + dy * distance, y: a.y - dx * distance, dx, dy };
  });
  // Each corner is where the pushed-out side before it meets the one after.
  return sides.map((after, index) => {
    const before = sides[(index + count - 1) % count];
    const cross = before.dx * after.dy - before.dy * after.dx;
    if (Math.abs(cross) < 1e-9) return { x: after.x, y: after.y };
    const t = ((after.x - before.x) * after.dy - (after.y - before.y) * after.dx) / cross;
    return { x: before.x + before.dx * t, y: before.y + before.dy * t };
  });
}

/**
 * Whether the point (`x`, `y`), relative to the box's top-left, lies inside
 * the OUTLINE the shape is drawn with -- which for everything but a rectangle
 * is smaller than its bounding box.
 */
export function insideShape(shape: Outline, width: number, height: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x > width || y > height) {
    return false;
  }
  const dx = Math.abs(x - width / 2);
  const dy = Math.abs(y - height / 2);
  switch (shape) {
    case "diamond":
      return dx / (width / 2) + dy / (height / 2) <= 1;
    case "circle":
      return (dx / (width / 2)) ** 2 + (dy / (height / 2)) ** 2 <= 1;
    case "hexagon":
      // Full width across the middle, closing in evenly to the flat top and
      // bottom, which are shorter by the inset at each end.
      return dx <= width / 2 - hexagonInset(height) * (dy / (height / 2));
    case "cylinder": {
      // Straight sides; the top and bottom edges are half-ellipses that span
      // the whole width, so only the bands at the two ends are cut into.
      const cap = dy - (height / 2 - CYLINDER_CAP_PX);
      return cap <= 0 || (dx / (width / 2)) ** 2 + (cap / CYLINDER_CAP_PX) ** 2 <= 1;
    }
    case "stadium":
    case "rounded": {
      const radius = Math.min(
        shape === "stadium" ? Math.min(width, height) / 2 : ROUNDED_RADIUS_PX,
        width / 2,
        height / 2,
      );
      // Only the four corner squares differ from the plain rectangle.
      const cx = dx - (width / 2 - radius);
      const cy = dy - (height / 2 - radius);
      return cx <= 0 || cy <= 0 || cx * cx + cy * cy <= radius * radius;
    }
    default:
      return true;
  }
}

/**
 * Carry a wire that ELK ended on a node's bounding box on to the outline that
 * is actually drawn.
 *
 * ELK only knows rectangles, so a wire into the shoulder of a diamond or a
 * circle stops in mid-air. `end` is the wire's endpoint on the box and
 * `towards` any point further along the same line inside it; the result is
 * where that line first enters the shape, or `end` unchanged if it already
 * touches it or would miss it altogether.
 */
export function meetOutline(
  shape: Outline,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  end: { readonly x: number; readonly y: number },
  towards: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  const inside = (t: number): boolean =>
    insideShape(
      shape,
      box.width,
      box.height,
      end.x + (towards.x - end.x) * t - box.x,
      end.y + (towards.y - end.y) * t - box.y,
    );
  if (inside(0)) {
    return { x: end.x, y: end.y };
  }
  // March to the first sample inside, then bisect the step that crossed.
  const STEPS = 64;
  let first = 1;
  while (first <= STEPS && !inside(first / STEPS)) {
    first += 1;
  }
  if (first > STEPS) {
    return { x: end.x, y: end.y };
  }
  let hit = first / STEPS;
  let outside = (first - 1) / STEPS;
  for (let i = 0; i < 24; i += 1) {
    const mid = (outside + hit) / 2;
    if (inside(mid)) {
      hit = mid;
    } else {
      outside = mid;
    }
  }
  return { x: end.x + (towards.x - end.x) * hit, y: end.y + (towards.y - end.y) * hit };
}
