// Paint a cell layout with Unicode box-drawing characters.
//
// One corner system throughout: routes and frames turn with square corners,
// and only shapes that are round in Archer's browser (rounded, stadium, circle,
// cylinder) are drawn round. A node's kind is a caption inside it ("Person"),
// as the browser shows it, so the border is free to show the shape.
//
// Routes and group frames are not drawn as characters directly. Each cell
// records which of its four sides a line leaves by, and the glyph is chosen at
// the end, so lines sharing a cell become a junction or a crossing.
import { printable } from "./printable.ts";
import { straighten, type Point } from "./geometry.ts";
import type { EdgeLine, NodeShape } from "./input.ts";
import { routeCells, wrap, type Box, type Layout, type Route } from "./layout.ts";

export { straighten } from "./geometry.ts";

const UP = 1,
  RIGHT = 2,
  DOWN = 4,
  LEFT = 8;
const ALL = UP | RIGHT | DOWN | LEFT;
type Glyphs = Readonly<Record<number, string>>;
const LIGHT: Glyphs = {
  [UP | DOWN]: "│",
  [LEFT | RIGHT]: "─",
  [DOWN | RIGHT]: "┌",
  [DOWN | LEFT]: "┐",
  [UP | RIGHT]: "└",
  [UP | LEFT]: "┘",
  [UP | DOWN | RIGHT]: "├",
  [UP | DOWN | LEFT]: "┤",
  [LEFT | RIGHT | DOWN]: "┬",
  [LEFT | RIGHT | UP]: "┴",
  [ALL]: "┼",
  [UP]: "│",
  [DOWN]: "│",
  [LEFT]: "─",
  [RIGHT]: "─",
};
const HEAVY: Glyphs = {
  [UP | DOWN]: "┃",
  [LEFT | RIGHT]: "━",
  [DOWN | RIGHT]: "┏",
  [DOWN | LEFT]: "┓",
  [UP | RIGHT]: "┗",
  [UP | LEFT]: "┛",
  [UP | DOWN | RIGHT]: "┣",
  [UP | DOWN | LEFT]: "┫",
  [LEFT | RIGHT | DOWN]: "┳",
  [LEFT | RIGHT | UP]: "┻",
  [ALL]: "╋",
  [UP]: "┃",
  [DOWN]: "┃",
  [LEFT]: "━",
  [RIGHT]: "━",
};
// Dotted straight runs; turns and junctions stay light, since box drawing has
// no dotted corners.
const DOTTED: Glyphs = {
  ...LIGHT,
  [UP | DOWN]: "┆",
  [LEFT | RIGHT]: "┄",
  [UP]: "┆",
  [DOWN]: "┆",
  [LEFT]: "┄",
  [RIGHT]: "┄",
};
const WEIGHT: Readonly<Record<EdgeLine, number>> = { dotted: 1, solid: 2, thick: 3 };
const BY_WEIGHT: Readonly<Record<number, Glyphs>> = { 1: DOTTED, 2: LIGHT, 3: HEAVY };

// Outline glyphs: top-left, top-right, bottom-left, bottom-right, top/bottom
// edge, left side, right side.
type Outline = readonly [tl: string, tr: string, bl: string, br: string, h: string, l: string, r: string];
const OUTLINES: Readonly<Record<NodeShape, Outline>> = {
  rectangle: ["┌", "┐", "└", "┘", "─", "│", "│"],
  rounded: ["╭", "╮", "╰", "╯", "─", "│", "│"],
  stadium: ["╭", "╮", "╰", "╯", "─", "(", ")"],
  circle: ["╭", "╮", "╰", "╯", "─", "(", ")"],
  cylinder: ["╭", "╮", "╰", "╯", "─", "│", "│"],
  diamond: ["╱", "╲", "╲", "╱", "─", "<", ">"],
  hexagon: ["╱", "╲", "╲", "╱", "─", "│", "│"],
  subroutine: ["┌", "┐", "└", "┘", "─", "││", "││"],
};
// What tells each outline apart, for the legend: several share their corners
// and differ only in their sides or lid.
const SAMPLES: Readonly<Record<NodeShape, string>> = {
  rectangle: "┌──┐",
  rounded: "╭──╮",
  stadium: "(  )",
  circle: "(╭╮)",
  cylinder: "│╰╯│",
  diamond: "<  >",
  hexagon: "╱──╲",
  subroutine: "││  ││",
};
const LINE_SAMPLES: Readonly<Record<EdgeLine, string>> = { solid: "──▶", dotted: "┄┄▶", thick: "━━▶" };

// Archer's browser draws an external system with a dashed border and a system
// with a double one; the shape keeps its corners, the kind sets the line.
function bordered(glyphs: Outline, box: Box): Outline {
  const [tl, tr, bl, br, h, l, r] = glyphs;
  if (box.kind === "external") return [tl, tr, bl, br, h === "─" ? "╌" : h, l === "│" ? "╎" : l, r === "│" ? "╎" : r];
  if (box.kind === "system") {
    if ((box.outline ?? "rectangle") === "rectangle") return ["╔", "╗", "╚", "╝", "═", "║", "║"];
    return [tl, tr, bl, br, h === "─" ? "═" : h, l === "│" ? "║" : l, r === "│" ? "║" : r];
  }
  return glyphs;
}

const KIND_SGR: Readonly<Record<string, string>> = {
  person: "36",
  system: "33",
  external: "35",
  component: "32",
  container: "34",
  database: "34",
};
const EDGE_SGR = "90",
  GROUP_SGR = "2",
  LABEL_SGR = "3";

export interface RenderOptions {
  readonly color?: boolean | undefined;
  readonly width?: number | undefined;
}

/** A fixed-size grid of cells; reads and writes outside it are ignored. */
class Grid<T> {
  private readonly cells: T[];
  readonly cols: number;
  readonly rows: number;
  constructor(cols: number, rows: number, fill: T) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array<T>(cols * rows).fill(fill);
  }
  has(x: number, y: number): boolean {
    return y >= 0 && y < this.rows && x >= 0 && x < this.cols;
  }
  get(x: number, y: number, fallback: T): T {
    return this.has(x, y) ? (this.cells[y * this.cols + x] as T) : fallback;
  }
  set(x: number, y: number, value: T): void {
    if (this.has(x, y)) this.cells[y * this.cols + x] = value;
  }
  row(y: number): T[] {
    return this.cells.slice(y * this.cols, (y + 1) * this.cols);
  }
}

type Put = (x: number, y: number, ch: string, style?: string) => void;

export function render(layout: Layout, options: RenderOptions = {}): string {
  const cols = layout.width + 1,
    rows = layout.height + 1;
  const text = new Grid(cols, rows, " ");
  const sgr = new Grid(cols, rows, "");
  const sides = new Grid(cols, rows, 0);
  const weight = new Grid(cols, rows, 0);
  const frames = new Grid(cols, rows, 0);
  const put: Put = (x, y, ch, style = "") => {
    text.set(x, y, ch);
    sgr.set(x, y, style);
  };
  const write = (x: number, y: number, s: string, style = ""): void =>
    [...printable(s)].forEach((ch, i) => put(x + i, y, ch, style));
  const trace = (grid: Grid<number>, pts: readonly Point[], w = 0): void => {
    const mark = (x: number, y: number, side: number): void => {
      if (!grid.has(x, y)) return;
      grid.set(x, y, grid.get(x, y, 0) | side);
      if (w) weight.set(x, y, Math.max(weight.get(x, y, 0), w));
    };
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i] as Point,
        b = pts[i + 1] as Point;
      const dx = Math.sign(b.x - a.x),
        dy = Math.sign(b.y - a.y);
      const out = dx > 0 ? RIGHT : dx < 0 ? LEFT : dy > 0 ? DOWN : UP;
      const back = dx > 0 ? LEFT : dx < 0 ? RIGHT : dy > 0 ? UP : DOWN;
      for (let x = a.x, y = a.y; x !== b.x || y !== b.y; x += dx, y += dy) {
        mark(x, y, out);
        mark(x + dx, y + dy, back);
      }
    }
  };

  const groups = layout.boxes.filter((b) => b.group);
  const nodes = layout.boxes.filter((b) => !b.group);
  const inNode = (x: number, y: number): boolean =>
    nodes.some((b) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height);

  for (const g of groups) {
    const x1 = g.x + g.width - 1,
      y1 = g.y + g.height - 1;
    trace(frames, [
      { x: g.x, y: g.y },
      { x: x1, y: g.y },
      { x: x1, y: y1 },
      { x: g.x, y: y1 },
      { x: g.x, y: g.y },
    ]);
  }
  const routes: Route[] = layout.routes
    .filter((r) => r.points.length >= 2)
    .map((r) => ({ ...r, points: straighten(r.points) }));
  for (const route of routes) trace(sides, route.points, WEIGHT[route.line]);

  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const e = sides.get(x, y, 0),
        f = frames.get(x, y, 0);
      if (!e && !f) continue;
      const table = BY_WEIGHT[weight.get(x, y, 0) || 2] ?? LIGHT;
      // A route passing straight through a frame side is a crossing; anything
      // else on a frame cell keeps the route's own glyph.
      if (e && f && (e | f) === ALL) put(x, y, table[ALL] ?? "┼", EDGE_SGR);
      else if (e) put(x, y, table[e] ?? "┼", EDGE_SGR);
      else put(x, y, LIGHT[f] ?? "┼", GROUP_SGR);
    }

  for (const box of nodes) paintNode(put, write, box);

  // The head sits on the route's last cell outside the target, pointing in.
  for (const route of routes) {
    const end = route.points.at(-1) as Point,
      prev = route.points.at(-2) as Point;
    const dx = Math.sign(end.x - prev.x),
      dy = Math.sign(end.y - prev.y);
    const at = inNode(end.x, end.y) ? { x: end.x - dx, y: end.y - dy } : end;
    put(at.x, at.y, dx > 0 ? "▶" : dx < 0 ? "◀" : dy > 0 ? "▼" : "▲", EDGE_SGR);
    if (route.bidirectional !== true || route.points.length < 2) continue;
    // A two-way edge has a head at its source as well, pointing out of the route.
    const start = route.points[0] as Point,
      next = route.points[1] as Point;
    const sx = Math.sign(start.x - next.x),
      sy = Math.sign(start.y - next.y);
    const from = inNode(start.x, start.y) ? { x: start.x - sx, y: start.y - sy } : start;
    put(from.x, from.y, sx > 0 ? "▶" : sx < 0 ? "◀" : sy > 0 ? "▼" : "▲", EDGE_SGR);
  }
  for (const g of groups) {
    // On the frame's top edge when it fits; otherwise on the rows the layout
    // reserved inside the frame, whole.
    if (g.titleInside) g.lines.forEach((line, i) => write(g.x + 2, g.y + 1 + i, line, "1"));
    else write(g.x + 2, g.y, ` ${g.lines[0] ?? ""} `, "1");
  }
  // A label goes where ELK put it unless that covers a line or a node; then to
  // the nearest spot on the same row that covers neither and still touches
  // its own route.
  const taken = (x: number, y: number): boolean =>
    !text.has(x, y) || sides.get(x, y, 0) !== 0 || frames.get(x, y, 0) !== 0 || inNode(x, y);
  for (const route of routes) {
    if (!route.label) continue;
    const { text: words, y } = route.label;
    const own = routeCells(route.points);
    const span = words.length + 2;
    // The words and a space either side must be free; the route may run
    // just past either space, or along the row above or below.
    const clear = (x: number): boolean => {
      for (let i = 0; i < span; i++) if (taken(x + i, y)) return false;
      return true;
    };
    const touches = (x: number): boolean => {
      if (own.has(`${x - 1},${y}`) || own.has(`${x + span},${y}`)) return true;
      for (let i = 0; i < span; i++) if (own.has(`${x + i},${y - 1}`) || own.has(`${x + i},${y + 1}`)) return true;
      return false;
    };
    const start = route.label.x;
    let best = start;
    if (!clear(start))
      for (let d = 1; d <= span + 2; d++) {
        const found = [start + d, start - d].find((x) => clear(x) && touches(x));
        if (found !== undefined) {
          best = found;
          break;
        }
      }
    write(best + 1, y, words, LABEL_SGR);
  }

  const color = options.color ?? false;
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) lines.push(paint(text.row(y), sgr.row(y), color));
  const body = lines.join("\n").replace(/\n+$/, "");
  return `${body}\n${legend(layout, nodes, routes, options.width ?? 80, color)}`;
}

function paintNode(put: Put, write: (x: number, y: number, s: string, style?: string) => void, box: Box): void {
  const outline = bordered(OUTLINES[box.outline ?? "rectangle"], box);
  const tint = KIND_SGR[box.kind ?? ""] ?? "";
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) put(x, y, " ");
  frame(put, box, outline, tint);
  let row = box.y + (box.outline === "circle" ? 2 : 1);
  const x1 = box.x + box.width - 1;
  if (box.outline === "cylinder") {
    // The lid: the top's curve seen from the front, inside the sides.
    put(box.x + 1, row, "╰", tint);
    put(x1 - 1, row, "╯", tint);
    for (let x = box.x + 2; x < x1 - 1; x++) put(x, row, outline[4], tint);
    row++;
  }
  if (box.outline === "circle") {
    // An ellipse in cells: the top and bottom edges two cells in, diagonals
    // one cell in on the rows next to them, parentheses at the widest rows.
    const y1 = box.y + box.height - 1;
    for (const y of [box.y, y1]) {
      for (const x of [box.x, box.x + 1, x1 - 1, x1]) put(x, y, " ");
      put(box.x + 2, y, y === box.y ? "╭" : "╰", tint);
      put(x1 - 2, y, y === box.y ? "╮" : "╯", tint);
    }
    if (box.height >= 5) {
      put(box.x, box.y + 1, " ");
      put(x1, box.y + 1, " ");
      put(box.x + 1, box.y + 1, "╱", tint);
      put(x1 - 1, box.y + 1, "╲", tint);
      put(box.x, y1 - 1, " ");
      put(x1, y1 - 1, " ");
      put(box.x + 1, y1 - 1, "╲", tint);
      put(x1 - 1, y1 - 1, "╱", tint);
    }
  }
  const left = box.x + (box.outline === "subroutine" || box.outline === "circle" ? 3 : 2);
  if (box.caption) write(left, row++, box.caption, tint ? `2;${tint}` : "2");
  box.lines.forEach((line, i) => write(left, row + i, line, tint ? `1;${tint}` : "1"));
}

function frame(put: Put, b: Box, glyphs: Outline, style: string): void {
  const [tl, tr, bl, br, h, l, r] = glyphs;
  const x1 = b.x + b.width - 1,
    y1 = b.y + b.height - 1;
  for (let x = b.x + 1; x < x1; x++) {
    put(x, b.y, h, style);
    put(x, y1, h, style);
  }
  for (let y = b.y + 1; y < y1; y++) {
    [...l].forEach((ch, i) => put(b.x + i, y, ch, style));
    [...r].forEach((ch, i) => put(x1 - r.length + 1 + i, y, ch, style));
  }
  put(b.x, b.y, tl, style);
  put(x1, b.y, tr, style);
  put(b.x, y1, bl, style);
  put(x1, y1, br, style);
}

/** One row to text, with an escape sequence only where the style changes. */
function paint(row: readonly string[], styles: readonly string[], color: boolean): string {
  let end = row.length;
  while (end > 0 && row[end - 1] === " ") end--;
  if (!color) return row.slice(0, end).join("");
  let out = "",
    current = "";
  for (let x = 0; x < end; x++) {
    const style = styles[x] ?? "";
    if (style !== current) {
      out += `\x1b[0${style ? `;${style}` : ""}m`;
      current = style;
    }
    out += row[x] ?? " ";
  }
  return current ? `${out}\x1b[0m` : out;
}

/**
 * Only what the drawing cannot say for itself: which shapes and line styles
 * appear, and, when labels were numbered to fit, what each number means.
 */
function legend(
  layout: Layout,
  nodes: readonly Box[],
  routes: readonly Route[],
  width: number,
  color: boolean,
): string {
  const tint = (s: string, code: string): string => (color && code ? `\x1b[${code}m${s}\x1b[0m` : s);
  const samples: string[] = [];
  const shapes = [...new Set(nodes.map((n) => n.outline ?? "rectangle"))];
  if (shapes.length > 1 || (shapes[0] !== undefined && shapes[0] !== "rectangle"))
    for (const shape of shapes) samples.push(`${SAMPLES[shape]} ${shape}`);
  const lines = new Set(routes.map((r) => r.line));
  if ([...lines].some((l) => l !== "solid"))
    for (const line of (["solid", "dotted", "thick"] as const).filter((l) => lines.has(l)))
      samples.push(`${tint(LINE_SAMPLES[line], EDGE_SGR)} ${line}`);

  const out: string[] = [];
  if (samples.length) {
    const visible = (t: string): number => [...t.replace(/\x1b\[[0-9;]*m/g, "")].length;
    const rows = [""];
    for (const sample of samples) {
      const row = rows[rows.length - 1] ?? "";
      if (row && visible(`Legend: ${row}   ${sample}`) > width) rows.push(sample);
      else rows[rows.length - 1] = row ? `${row}   ${sample}` : sample;
    }
    out.push("", ...rows.map((r, i) => `${i === 0 ? "Legend:" : "       "} ${r}`));
  }
  if (layout.edgeLegend?.length) {
    out.push("", "Edges:");
    const pad = String(layout.edgeLegend.length).length;
    for (const e of layout.edgeLegend)
      wrap(printable(e.text), width - pad - 4).forEach((line, i) =>
        out.push(`  ${i === 0 ? tint(e.key.padStart(pad), LABEL_SGR) : " ".repeat(pad)}  ${line}`),
      );
  }
  return out.length ? `${out.join("\n")}\n` : "";
}
