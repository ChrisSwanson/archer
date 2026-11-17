/** Standalone vector painting over the exact layout and figure metrics used by the UI. */
import { createElement, type FunctionComponent } from "react";
import { CHEVRON_PATH, parkedAt } from "../emphasis/EmphasisChevrons";
import { renderToStaticMarkup } from "react-dom/server";
import { computeLayout, type LayoutGroup, type LayoutResult, type LayoutNode } from "../layout/elk-adapter";
import {
  nodeBox,
  kindOf,
  outlineOf,
  hexagonPoints,
  edgeLabelBox,
  NODE_DESCRIPTION_FONT_PX,
  NODE_DESCRIPTION_LINE_PX,
  NODE_DESCRIPTION_GAP_PX,
  NODE_LABEL_FONT_PX,
  NODE_LABEL_LINE_PX,
  NODE_TITLE_FONT_PX,
  NODE_TITLE_LINE_PX,
  NODE_TITLE_WEIGHT,
  NODE_KIND_FONT_PX,
  NODE_KIND_LINE_PX,
  EDGE_LABEL_FONT_PX,
  EDGE_LABEL_LINE_PX,
  EDGE_LABEL_PAD_Y,
  PERSON_GLYPH_GAP_PX,
  PERSON_GLYPH_PX,
} from "../layout/graph-metrics";
import { estimateTextWidth } from "../layout/text-measure";
import { layoutBounds } from "../diagrams/viewport-fit";
import { ER_KEY_FONT_PX, ER_KEY_PAD_X, ER_KEY_GAP_PX } from "../layout/figure-metrics";
import { figureBox } from "../layout/figure-metrics";
import { roundedRoute } from "../diagrams/rounded-route";
import { FRAME_CAPTION_FONT_PX, FRAME_CAPTION_INSET, FRAME_CAPTION_LINE_PX } from "../layout/captions";
import { BOUNDARY_WORD } from "../diagrams/figures";
import { arrowsOf } from "../diagrams/figures";
import { ArrowMarkers, routeArrowWidths } from "../diagrams/ArrowMarkers";
import { EdgeEnds } from "../diagrams/EdgeEnds";
import { KindGlyph } from "./KindGlyph";
import { ArchitectureGlyph, PersonGlyph } from "../diagrams/FigureGlyphs";
import type { ProjectedView } from "../diagrams/projection";
import { CANVAS_GROUND, labelGrounds } from "../diagrams/label-ground";
import {
  FAMILY_TOKENS,
  groupPanelsOf,
  indexCategories,
  nodePalette,
  type CategoryIndex,
  type GroupPanels,
  type Palette,
} from "../diagrams/palette";
export type SvgPalette = Readonly<Record<string, string>>;
export type PaintedSvg = {
  readonly content: string;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  /**
   * Where each element's group-number marker goes, by `channel:id`
   * (`markKey`): a box's top-left corner, a line's middle clear of its caption.
   * Drawn only by an accessible presentation export.
   */
  readonly marks?: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
};
export const markKey = (channel: "node" | "edge", id: string): string => `${channel}:${id}`;
/** A line's marker point: its middle, parked clear of its caption as a chevron is. */
export function lineMark(
  route: readonly { x: number; y: number }[],
  avoid?: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const at = parkedAt(route, 0.5, avoid);
  return { x: at.x, y: at.y };
}
export const xml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const element = (tag: string, attributes: Record<string, string | number>, body = ""): string =>
  `<${tag} ${Object.entries(attributes)
    .map(([k, v]) => `${k}="${xml(String(v))}"`)
    .join(" ")}>${body}</${tag}>`;
export function textRows(
  lines: readonly string[],
  x: number,
  y: number,
  size = 14,
  line = 18,
  bold: boolean | number = false,
): string {
  return element(
    "text",
    {
      x,
      y,
      "text-anchor": "middle",
      "font-size": size,
      "font-weight": bold === true ? 600 : bold === false ? 400 : bold,
    },
    lines.map((s, i) => element("tspan", { x, y: y + i * line }, xml(s))).join(""),
  );
}
/**
 * Where the page puts a row's baseline inside its line box: half the leading, then the face's ascent. Fira Sans's
 * line box is 1.2em (ascent 0.935em, descent 0.265em), so an 18px title on its 24px line sits at about +18 and a 15px
 * description on its 23px line at about +16.5.
 */
/** A connection's weight as the page draws it for this notation (`styles.css`, EDGE WEIGHT FOLLOWS THE NOTATION). */
function lineWeight(notation: LayoutResult["notation"], thick: boolean): number {
  if (notation === "state") return thick ? 3.5 : 1.5;
  if (notation === "er") return thick ? 3 : 1.25;
  return thick ? 4 : 2;
}

export function baselineIn(fontPx: number, linePx: number): number {
  return Math.round(((linePx - 1.2 * fontPx) / 2 + 0.935 * fontPx) * 10) / 10;
}
const rect = (
  x: number,
  y: number,
  w: number,
  h: number,
  rx = 0,
  extra: Record<string, string | number> = {},
): string => element("rect", { x, y, width: w, height: h, rx, ...extra });
/**
 * The element's own outline again, hidden until an emphasis colours it
 * (ADR 0030): drawn ON the border, never outside it, so an emphasised element
 * reads as its border in the group's hue and nothing else.
 */
/**
 * A flow's moving arrows, as a still export draws them (ADR 0030): two along
 * the route, or one each way on a two-way line, clear of the caption. Hidden
 * until an emphasis shows them.
 */
export function stillChevrons(
  route: readonly { x: number; y: number }[],
  twoWay: boolean,
  avoid?: { x: number; y: number; width: number; height: number },
): string {
  if (route.length < 2) return "";
  const marks = (
    twoWay
      ? ([
          [0.25, false],
          [0.75, true],
        ] as const)
      : ([
          [0.25, false],
          [0.75, false],
        ] as const)
  )
    .map(([fraction, back]) => {
      const at = parkedAt(route, fraction, avoid);
      return element("path", {
        d: CHEVRON_PATH,
        transform: `translate(${at.x} ${at.y}) rotate(${at.angle + (back ? 180 : 0)})`,
      });
    })
    .join("");
  return element(
    "g",
    {
      class: "export-emph-chevrons",
      visibility: "hidden",
      fill: "none",
      "stroke-width": 2.25,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    },
    marks,
  );
}
export function emphasisOutline(x: number, y: number, width: number, height: number, radius: number): string {
  return rect(x, y, width, height, radius, {
    class: "export-emph-outline",
    visibility: "hidden",
    fill: "none",
    "vector-effect": "non-scaling-stroke",
  });
}
const svgPrimitive = <P extends object>(component: FunctionComponent<P>, props: P): string =>
  renderToStaticMarkup(createElement(component, props));
/**
 * A family's paint for a box -- fill, border and the words' ink -- or nothing for neutral (the drawing's own
 * defaults). A node with a colour of its own is filled in it, with the family's words; a card in a family panel
 * is the light card with the family's ink; a panel is the family's panel.
 */
function familyPaint(palette: Palette, part: "node" | "panel"): { fill?: string; stroke?: string; ink?: string } {
  if (palette.family === undefined)
    return palette.quiet === true && part === "node"
      ? { fill: "var(--node-quiet-bg)", stroke: "var(--node-quiet-border)", ink: "var(--node-quiet-text)" }
      : {};
  const tokens = FAMILY_TOKENS[palette.family];
  if (part === "panel") return { fill: tokens.panel, stroke: tokens.border, ink: tokens.ink };
  return palette.card === true
    ? { fill: tokens.card, stroke: tokens.border, ink: tokens.ink }
    : { fill: tokens.fill, stroke: tokens.border, ink: tokens.text };
}
export function paintNode(
  node: LayoutNode,
  layout: LayoutResult,
  categories: CategoryIndex = indexCategories(layout.categories),
  panels: GroupPanels = groupPanelsOf(layout.groups, categories),
): string {
  return paintNodeParts(node, layout, categories, panels);
}
/** A node's whole markup. */
function paintNodeParts(
  node: LayoutNode,
  layout: LayoutResult,
  categories: CategoryIndex,
  panels: GroupPanels,
): string {
  const { width: w, height: h } = node;
  const figure = node.figure;
  const box = figure
    ? figureBox(figure, node.label, node.shape, layout.direction, layout.typeface, node.folded !== undefined)
    : nodeBox(node.label, node.shape, node.classes, layout.typeface, node.folded !== undefined);
  const shape = outlineOf(node.shape, node.classes);
  let body = "";
  // The canvas's border (DESIGN.md, Diagram palette): `--line-node` 1.5px, a C4 system's `--line-node-strong` 2px
  // (owner, 2026-11-15); dashed outside the boundary
  // or where an authored category says so; the family's fill and border (`palette.ts`), as the page draws.
  const palette = nodePalette(node, categories, panels);
  const { fill: familyFill, stroke: familyStroke, ink: familyInk } = familyPaint(palette, "node");
  const border = figure?.type === "c4" && figure.kind === "system" ? 2 : 1.5;
  const dashed =
    (figure?.type === "c4" && figure.external) ||
    palette.dashed === true ||
    (figure === undefined && kindOf(node.classes) === "external");
  const extra = {
    "stroke-width": border,
    ...(familyStroke === undefined ? {} : { stroke: familyStroke }),
    ...(dashed ? { "stroke-dasharray": "5 3" } : {}),
  };
  const filled = familyFill === undefined ? extra : { ...extra, fill: familyFill };
  if (figure?.type === "state" && (figure.kind === "initial" || figure.kind === "final")) {
    body = element("circle", {
      cx: w / 2,
      cy: h / 2,
      r: w / 2,
      ...(figure.kind === "initial"
        ? { fill: "currentColor", stroke: "currentColor" }
        : { fill: "var(--bg)", stroke: "currentColor", "stroke-width": 1.5 }),
    });
    if (figure.kind === "final")
      body += element("circle", { cx: w / 2, cy: h / 2, r: 7, fill: "currentColor", stroke: "none" });
    const side = layout.direction === "tb" || layout.direction === "bt";
    const word = figure.kind === "initial" ? "start" : "end";
    body += element(
      "g",
      { fill: "var(--text-dim)", stroke: "none" },
      textRows([word], side ? w + 6 + estimateTextWidth(word, 11) / 2 : w / 2, side ? h / 2 + 4 : h + 14, 11, 14),
    );
  } else if (
    figure?.type === "junction" ||
    (figure?.type === "state" && (figure.kind === "fork" || figure.kind === "join"))
  )
    body = rect(0, 0, w, h, 2, { fill: "currentColor" });
  else if (shape === "diamond" || (figure?.type === "state" && figure.kind === "choice"))
    body = element("rect", {
      x: w * 0.14645,
      y: h * 0.14645,
      width: w * 0.7071,
      height: h * 0.7071,
      rx: 3,
      transform: `rotate(45 ${w / 2} ${h / 2})`,
      ...filled,
    });
  else if (shape === "hexagon")
    body = element("polygon", {
      points: hexagonPoints(w, h)
        .map((p) => `${p.x},${p.y}`)
        .join(" "),
      ...filled,
    });
  else if (shape === "circle") body = element("ellipse", { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, ...filled });
  else {
    const database = shape === "cylinder" || (figure?.type === "c4" && figure.shape === "database");
    const queue = figure?.type === "c4" && figure.shape === "queue";
    const radius = queue
      ? 16
      : database
        ? 7
        : shape === "stadium"
          ? h / 2
          : shape === "rounded"
            ? 16
            : figure?.type === "c4"
              ? figure.kind === "container"
                ? 6
                : figure.kind === "component"
                  ? 2
                  : 4
              : 12;
    body = element("rect", {
      x: 0,
      y: 0,
      width: w,
      height: h,
      rx: queue ? 16 : database ? w / 2 : radius,
      ry: queue ? h / 2 : database ? 7 : radius,
      ...filled,
    });
    if (database) body += element("ellipse", { cx: w / 2, cy: 6, rx: w / 2 - 0.5, ry: 6.5, fill: "none", ...extra });
    if (queue)
      body += element("ellipse", {
        cx: w - 15,
        cy: h / 2,
        rx: 15,
        ry: h / 2 - 1,
        fill: "none",
        ...extra,
        "stroke-width": 1.5,
      });
    if (shape === "subroutine")
      body += element("path", {
        d: `M 8 0 V ${h} M ${w - 8} 0 V ${h}`,
        fill: "none",
        ...(familyStroke === undefined ? {} : { stroke: familyStroke }),
      });
  }
  let label = "";
  if ("table" in box && box.table) {
    const table = box.table;
    label =
      textRows(box.lines, w / 2, 7 + 14, 14, 18, true) +
      element("line", { x1: 0, y1: table.titleHeight, x2: w, y2: table.titleHeight, stroke: "currentColor" });
    table.rows.forEach((row, i) => {
      const baseline = table.titleHeight + i * 20 + 14;
      let x = 10;
      for (const [key, value] of [
        ["type", row.type],
        ["name", row.name],
        ["keys", row.keys.join(" ")],
        ["comment", row.shownComment],
      ] as const) {
        if (table.columns[key] > 0) {
          if (key === "keys") {
            let keyX = x;
            for (const word of row.keys) {
              const keyWidth = estimateTextWidth(word, ER_KEY_FONT_PX, true, layout.typeface) + 2 * ER_KEY_PAD_X;
              label += element(
                "g",
                { "data-attribute-key": word },
                rect(keyX, baseline - 11, keyWidth, 14, 3, {
                  stroke: "currentColor",
                  fill: word === "PK" ? "currentColor" : "none",
                  ...(word === "PK" ? { "fill-opacity": 0.24 } : {}),
                  ...(word === "UK" ? { "stroke-dasharray": "3 2" } : {}),
                }) +
                  element(
                    "text",
                    { x: keyX + ER_KEY_PAD_X, y: baseline - 1, "font-size": ER_KEY_FONT_PX, "font-weight": 700 },
                    xml(word),
                  ),
              );
              keyX += keyWidth + ER_KEY_GAP_PX;
            }
          } else
            label += element(
              "text",
              {
                x,
                y: baseline,
                "font-size": 12,
                "font-weight": key === "name" ? 600 : 400,
                ...(key === "comment" ? { "font-style": "italic" } : {}),
                ...(key === "type" || key === "comment" ? { opacity: 0.78 } : {}),
              },
              xml(value),
            );
          x += table.columns[key] + 10;
        }
      }
    });
  } else if ("c4" in box && box.c4) {
    const c4 = box.c4;
    let y = (h - ((c4.glyph ? 28 : 0) + box.lines.length * 18 + 15 + c4.description.length * 16)) / 2;
    if (c4.glyph) {
      label += element("g", { transform: `translate(${w / 2 - 13} ${y})` }, svgPrimitive(PersonGlyph, { size: 26 }));
      y += 28;
    }
    label += textRows(box.lines, w / 2, y + 14, 14, 18, true);
    y += box.lines.length * 18;
    label += textRows([c4.typeLine], w / 2, y + 11, 11, 15);
    y += 15;
    label += textRows(c4.description, w / 2, y + 12, 12, 16);
  } else {
    // A plain node's title rows, then its description's (`nodeBox`); a figure's rows are all title.
    const described = "titleRows" in box;
    const titleRows = described ? box.titleRows : box.lines.length;
    const title = box.lines.slice(0, titleRows),
      description = box.lines.slice(titleRows);
    const [titlePx, titleLine] = described
      ? [NODE_TITLE_FONT_PX, NODE_TITLE_LINE_PX]
      : [NODE_LABEL_FONT_PX, NODE_LABEL_LINE_PX];
    const gap = description.length === 0 ? 0 : NODE_DESCRIPTION_GAP_PX;
    const rowsHeight = title.length * titleLine + gap + description.length * NODE_DESCRIPTION_LINE_PX;
    let top = (h - rowsHeight) / 2;
    if (figure?.type === "service" && figure.icon) {
      top = (h - rowsHeight - 32) / 2;
      label += element(
        "g",
        { transform: `translate(${w / 2 - 14} ${top})` },
        svgPrimitive(ArchitectureGlyph, { icon: figure.icon, size: 28 }),
      );
      top += 32;
    }
    const kind = figure === undefined ? kindOf(node.classes) : undefined;
    if (kind && kind !== "person") {
      top -= 8;
      // As the page sets it (`.archer-node-kind`): capitalised, NODE_KIND_FONT_PX, 500, the glyph and a 4px gap before it.
      const caption = kind.charAt(0).toUpperCase() + kind.slice(1),
        ink = estimateTextWidth(caption, NODE_KIND_FONT_PX, "semibold"),
        left = (w - ink - 15) / 2;
      label += element(
        "g",
        { transform: `translate(${left} ${top + (NODE_KIND_LINE_PX - 11) / 2})` },
        svgPrimitive(KindGlyph, { kind }),
      );
      label += element(
        "g",
        { opacity: 0.78 },
        textRows(
          [caption],
          left + 15 + ink / 2,
          top + baselineIn(NODE_KIND_FONT_PX, NODE_KIND_LINE_PX),
          NODE_KIND_FONT_PX,
          NODE_KIND_LINE_PX,
          500,
        ),
      );
      top += 16;
    }
    // Each row's baseline where the page's line box puts it (`baselineIn`).
    const titleTop = top + baselineIn(titlePx, titleLine);
    if (kind === "person" && title.length > 0) {
      // A person's glyph beside its title's first row, the row and glyph centred together as the page draws them.
      const beside = PERSON_GLYPH_PX + PERSON_GLYPH_GAP_PX,
        first = estimateTextWidth(title[0], titlePx, true, layout.typeface),
        left = (w - first - beside) / 2;
      label += element(
        "g",
        { transform: `translate(${left} ${top + (titleLine - PERSON_GLYPH_PX) / 2})` },
        svgPrimitive(KindGlyph, { kind, size: PERSON_GLYPH_PX }),
      );
      label += textRows(
        title.slice(0, 1),
        left + beside + first / 2,
        titleTop,
        titlePx,
        titleLine,
        described ? NODE_TITLE_WEIGHT : true,
      );
      label += textRows(
        title.slice(1),
        w / 2,
        titleTop + titleLine,
        titlePx,
        titleLine,
        described ? NODE_TITLE_WEIGHT : true,
      );
    } else label += textRows(title, w / 2, titleTop, titlePx, titleLine, described ? NODE_TITLE_WEIGHT : true);
    // The description in the title's own full ink (owner, 2026-11-12), never the chrome's dim grey.
    if (description.length > 0)
      label += textRows(
        description,
        w / 2,
        top + title.length * titleLine + gap + baselineIn(NODE_DESCRIPTION_FONT_PX, NODE_DESCRIPTION_LINE_PX),
        NODE_DESCRIPTION_FONT_PX,
        NODE_DESCRIPTION_LINE_PX,
      );
  }
  let note = "";
  if (node.note) {
    const n = node.note,
      left = n.x + n.width <= node.x;
    note =
      element("line", {
        x1: left ? 0 : w,
        y1: h / 2,
        x2: n.x - node.x + (left ? n.width : 0),
        y2: n.y - node.y + n.height / 2,
        "stroke-dasharray": "3 3",
        stroke: "var(--fragment-border)",
        fill: "none",
      }) +
      rect(n.x - node.x, n.y - node.y, n.width, n.height, 2, {
        fill: "var(--surface-2)",
        stroke: "var(--fragment-border)",
      }) +
      element(
        "g",
        { fill: "var(--text-dim)", stroke: "none" },
        textRows(n.lines, n.x - node.x + n.width / 2, n.y - node.y + 18, 12, 16),
      );
  }
  const firstShape = body.match(/^<(rect|ellipse|circle|polygon)\b[^>]*>[\s\S]*?<\/\1>/)?.[0];
  const ring = firstShape
    ? element(
        "g",
        { class: "export-emph-outline", visibility: "hidden" },
        firstShape
          .replace(/ fill="[^"]*"/g, "")
          .replace(/^<([a-z]+) /, '<$1 fill="none" vector-effect="non-scaling-stroke" '),
      )
    : "";
  const transform = `translate(${node.x} ${node.y})`;
  return element(
    "g",
    {
      "data-element-id": node.id,
      "data-element-channel": "node",
      "data-x": node.x,
      "data-y": node.y,
      "data-width": w,
      "data-height": h,
      transform,
    },
    ring +
      element("g", { class: "export-node-body" }, body) +
      element("g", { fill: familyInk ?? "currentColor", stroke: "none" }, label) +
      note,
  );
}
/** Outer groups first, so a parent's opaque panel never covers its children; siblings keep the layout's order. */
function byNestingDepth(groups: readonly LayoutGroup[]): LayoutGroup[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const depth = (g: LayoutGroup): number => {
    let d = 0;
    for (let p = g.parentId; p !== undefined && byId.has(p) && d <= groups.length; p = byId.get(p)?.parentId) d++;
    return d;
  };
  return groups
    .map((g, i) => ({ g, i, d: depth(g) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(({ g }) => g);
}
export function paintGraph(layout: LayoutResult): PaintedSvg {
  const categories = indexCategories(layout.categories);
  const panels = groupPanelsOf(layout.groups, categories);
  const nodes = layout.nodes.map((node) => paintNodeParts(node, layout, categories, panels));
  const grounds = labelGrounds(layout, panels);
  let content = byNestingDepth(layout.groups)
    .map((g) => {
      // The page's panel (DESIGN.md, Diagram palette): opaque, a 12px corner (a composite state's 16), a 2px
      // border (an enterprise boundary's 3), the family's colours or the neutral step, C4's dash kept.
      const panel = panels.get(g.id);
      const paint = familyPaint(panel?.palette ?? {}, "panel");
      // A subgraph's panel and a composite state round at 16 (redesign slice 5); a frame of another figure at 12.
      const subgraph = g.figure === undefined && g.element !== true;
      const radius = g.figure?.type === "composite" || subgraph ? 16 : 12;
      // The outer boundary 2px; a structural or family panel inside it 1.5px; a C4 enterprise boundary 3px.
      const panelLine =
        g.figure?.type === "boundary" && g.figure.kind === "enterprise"
          ? 3
          : subgraph && (panel?.nested === true || panel?.palette.family !== undefined)
            ? 1.5
            : 2;
      const x = g.caption?.x ?? g.x + FRAME_CAPTION_INSET.x,
        y = g.caption?.y ?? g.y + FRAME_CAPTION_INSET.y;
      const icon = g.figure?.type === "zone" ? g.figure.icon : undefined;
      const nameX = x + (icon ? 21 : 0),
        size = FRAME_CAPTION_FONT_PX;
      let caption = icon
        ? element("g", { transform: `translate(${x} ${y + 2})` }, svgPrimitive(ArchitectureGlyph, { icon, size: 16 }))
        : "";
      caption += element(
        "text",
        { x: nameX, y: y + baselineIn(size, FRAME_CAPTION_LINE_PX), "font-size": size, "font-weight": 700 },
        xml(g.label),
      );
      if (g.figure?.type === "boundary")
        caption += element(
          "text",
          {
            x: nameX + estimateTextWidth(g.label, size, true, layout.typeface) + 5,
            y: y + baselineIn(size, FRAME_CAPTION_LINE_PX),
            "font-size": size,
          },
          `[${BOUNDARY_WORD[g.figure.kind]}]`,
        );
      return element(
        "g",
        { "data-element-id": g.id, "data-element-channel": "node" },
        rect(g.x, g.y, g.width, g.height, radius, {
          fill: paint.fill ?? (panel?.nested === true ? "var(--group-bg-alt)" : "var(--group-bg)"),
          stroke: paint.stroke ?? (panel?.nested === true ? "var(--group-border-alt)" : "var(--group-border)"),
          "stroke-width": panelLine,
          "stroke-dasharray":
            g.figure?.type === "boundary"
              ? g.figure.kind === "container"
                ? "2 3"
                : "5 3"
              : panel?.palette.dashed === true
                ? "5 3"
                : "none",
        }) +
          element(
            "g",
            {
              fill: paint.ink ?? (panel?.nested === true ? "var(--group-caption-alt)" : "var(--group-caption)"),
              stroke: "none",
            },
            caption,
          ) +
          emphasisOutline(g.x, g.y, g.width, g.height, radius),
      );
    })
    .join("");
  content += layout.edges
    .map((edge, index) => {
      const arrows = arrowsOf(edge.figure, edge.bidirectional),
        ends = { arrowStart: arrows.start, arrowEnd: arrows.end },
        id = `export-edge-${index}`;
      const { start, end } = routeArrowWidths(edge.points, ends, 1);
      let body = svgPrimitive(ArrowMarkers, { id, start, end });
      body += element("path", {
        class: "export-edge-line",
        d: roundedRoute(edge.points, ends),
        fill: "none",
        stroke: "var(--edge)",
        // The page's weights by notation (`.archer-edge` and its `[data-notation]` rules): 2px, a state machine's
        // transitions 1.5px, an ER relationship 1.25px; a thick line 2px heavier, ER's 1.75px.
        "stroke-width": lineWeight(layout.notation, edge.line === "thick"),
        ...(edge.line === "dotted"
          ? { "stroke-dasharray": "2 4" }
          : edge.line === "dashed"
            ? { "stroke-dasharray": "6 4" }
            : edge.line === "dashdot"
              ? { "stroke-dasharray": "8 3 2 3" }
              : {}),
        ...(start ? { "marker-start": `url(#${id}-start)` } : {}),
        ...(end ? { "marker-end": `url(#${id}-end)` } : {}),
      });
      if (edge.figure) body += svgPrimitive(EdgeEnds, { figure: edge.figure, route: edge.points });
      if (edge.labelAnchor && edge.label) {
        // The label, then a C4 relationship's technology and description, as the canvas's plate draws them.
        const a = edge.labelAnchor,
          b = edgeLabelBox(edge.label, layout.typeface),
          x = a.x + a.width / 2;
        let y = a.y + EDGE_LABEL_PAD_Y;
        const labelBaseline = baselineIn(EDGE_LABEL_FONT_PX, EDGE_LABEL_LINE_PX);
        let rows =
          b.lines.length > 0 ? textRows(b.lines, x, y + labelBaseline, EDGE_LABEL_FONT_PX, EDGE_LABEL_LINE_PX) : "";
        y += b.lines.length * EDGE_LABEL_LINE_PX;
        if (b.technology.length > 0) {
          rows += textRows(b.technology, x, y + 11, 11, 15);
          y += 15;
        }
        if (b.description.length > 0)
          rows += textRows(b.description, x, y + labelBaseline, EDGE_LABEL_FONT_PX, EDGE_LABEL_LINE_PX);
        // As the canvas draws it (`.archer-edge-label`, treatment A): no plate -- the line stops round the words,
        // the gap square and in the colour of what is behind it; regular italic in that ground's ink.
        const ground = grounds.get(edge.id) ?? CANVAS_GROUND;
        body +=
          (ground.pieces === undefined
            ? rect(a.x, a.y, a.width, a.height, 0, { fill: ground.fill, stroke: "none" })
            : ground.pieces
                .map((p) => rect(a.x + p.x, a.y + p.y, p.width, p.height, 0, { fill: p.fill, stroke: "none" }))
                .join("")) + element("g", { fill: ground.ink, stroke: "none", "font-style": "italic" }, rows);
      }
      body += stillChevrons(
        edge.points,
        ends.arrowStart && ends.arrowEnd,
        edge.labelAnchor && edge.label ? edge.labelAnchor : undefined,
      );
      return element("g", { "data-element-id": edge.id, "data-element-channel": "edge" }, body);
    })
    .join("");
  content += nodes.join("");
  const marks = new Map<string, { x: number; y: number }>();
  for (const g of layout.groups) marks.set(markKey("node", g.id), { x: g.x, y: g.y });
  for (const edge of layout.edges)
    if (edge.points.length >= 2)
      marks.set(
        markKey("edge", edge.id),
        lineMark(edge.points, edge.labelAnchor && edge.label ? edge.labelAnchor : undefined),
      );
  for (const node of layout.nodes) marks.set(markKey("node", node.id), { x: node.x, y: node.y });
  const bounds = layoutBounds(layout) ?? { x: 0, y: 0, width: layout.width, height: layout.height };
  let right = Math.max(layout.width, bounds.x + bounds.width),
    bottom = Math.max(layout.height, bounds.y + bounds.height);
  for (const node of layout.nodes)
    if (node.figure?.type === "state" && (node.figure.kind === "initial" || node.figure.kind === "final")) {
      const side = layout.direction === "tb" || layout.direction === "bt",
        word = node.figure.kind === "initial" ? "start" : "end";
      if (side) right = Math.max(right, node.x + node.width + 6 + estimateTextWidth(word, 11));
      else bottom = Math.max(bottom, node.y + node.height + 17);
    }
  const originX = Math.min(0, bounds.x),
    originY = Math.min(0, bounds.y);
  return { content, width: right - originX, height: bottom - originY, originX, originY, marks };
}
export async function layoutGraph(view: ProjectedView): Promise<PaintedSvg> {
  return paintGraph(await computeLayout(view));
}
