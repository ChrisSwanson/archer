/** UI-checked provider bundled directly through the neutral export alias. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExportPainterInput, ExportPainting } from "../../../ts/src/export/contract";
import {
  projectEnvelope,
  journeyElements,
  type ProjectionResult,
  type ProjectedSequenceEvent,
} from "../diagrams/projection";
import { diagramKeyEntries } from "../diagrams/key-entries";
import { usesFamilyColours } from "../diagrams/palette";
import { layoutGraph, xml, markKey } from "./svg";
import { layoutSequence } from "./sequence";
import { layoutJourney } from "./journey";
import { parseEmphasis, assignEmphasis, groupSlot, type EmphasisGroup } from "../emphasis/contract";
import { emphasisMarkerSvg, MARKER_RADIUS } from "../emphasis/EmphasisMarker";
import { KeySymbol } from "./KeySymbol";
import { paletteKeySvg } from "./palette-key-svg";
import { TYPE_TRACKING_EM, wrapText } from "../layout/text-measure";
type Projected = Extract<ProjectionResult, { ok: true }>;
/**
 * What the reader calls each element, by `channel:id`: a label, or a line's ends.
 * "to", not an arrow: a name reads as prose ("Web to API") wherever it is read out or drawn.
 */
function readableNames(projected: Projected): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const name = (id: string): string => names.get(markKey("node", id)) ?? id;
  // A blank label is no name: fall back to the id. A line says its ends too, so two "Request"s differ.
  const label = (text: string | undefined, id: string): string => text?.replace(/\s+/g, " ").trim() || id;
  const line = (text: string | undefined, from: string, to: string): string => {
    const words = text?.replace(/\s+/g, " ").trim();
    return words ? `${words} (${name(from)} to ${name(to)})` : `${name(from)} to ${name(to)}`;
  };
  if (projected.type === "graph") {
    for (const item of [...projected.view.groups, ...projected.view.nodes])
      names.set(markKey("node", item.id), label(item.label, item.id));
    for (const edge of projected.view.edges)
      names.set(markKey("edge", edge.id), line(edge.label, edge.source, edge.target));
  } else if (projected.type === "sequence") {
    for (const p of projected.view.participants) names.set(markKey("node", p.id), label(p.label, p.id));
    const walk = (events: readonly ProjectedSequenceEvent[]): void => {
      for (const event of events) {
        if (event.type === "message") names.set(markKey("edge", event.id), line(event.label, event.from, event.to));
        else if (event.type === "fragment") for (const section of event.sections) walk(section.events);
      }
    };
    walk(projected.view.events);
  } else
    for (const item of journeyElements(projected.view)) names.set(markKey("node", item.id), label(item.label, item.id));
  return names;
}
const membersOf = (group: EmphasisGroup, names: ReadonlyMap<string, string>): string[] => [
  ...group.nodes.map((id) => names.get(markKey("node", id)) ?? id),
  ...group.edges.map((id) => names.get(markKey("edge", id)) ?? id),
];
const leftRows = (lines: readonly string[], x: number, y: number, extra = ""): string =>
  `<text x="${x}" y="${y}" font-size="12"${extra}>${lines.map((s, i) => `<tspan x="${x}" y="${y + i * 16}">${xml(s)}</tspan>`).join("")}</text>`;
export async function paintExport(input: ExportPainterInput): Promise<ExportPainting> {
  const projected = projectEnvelope(input.envelope);
  if (!projected.ok) throw new Error(`export_invalid_envelope: ${projected.errors.map((e) => e.message).join("; ")}`);
  const painted =
    projected.type === "graph"
      ? await layoutGraph(projected.view)
      : projected.type === "sequence"
        ? layoutSequence(projected.view)
        : layoutJourney(projected.view);
  const { marks, ...drawing } = painted;
  let content = painted.content,
    width = painted.width,
    height = painted.height;
  let activeEmphasisId: string | null = null,
    description: string | undefined;
  if (input.mode === "presentation") {
    const presentation = input.presentation;
    const stored = presentation?.emphases ?? [];
    const chosen =
      presentation?.activeEmphasisId === null
        ? undefined
        : presentation?.activeEmphasisId !== undefined
          ? stored.find((e) => e.id === presentation.activeEmphasisId)
          : stored.at(-1);
    activeEmphasisId = chosen?.id ?? null;
    const normalized = chosen ? parseEmphasis(chosen) : undefined;
    const assignments = assignEmphasis(normalized);
    // The page's own rule (ADR 0030): the hue comes from the group's position,
    // and emphasis is the outline, the line and its arrowheads in it.
    const palette = { teal: "g1", amber: "g2", violet: "g3", coral: "g4" };
    let counter = 0,
      rules = "";
    // A thick line keeps its authored weight under an emphasis; only its colour changes.
    const thick = new Set(
      projected.type === "graph" ? projected.view.edges.filter((e) => e.line === "thick").map((e) => e.id) : [],
    );
    for (const [channel, assigned] of [
      ["node", assignments.nodes],
      ["edge", assignments.edges],
    ] as const)
      for (const [id, assignment] of assigned) {
        const needle = `data-element-id="${xml(id)}" data-element-channel="${channel}"`,
          hue = palette[assignment.palette],
          className = `export-emph-${counter++}`,
          color = `var(--${hue})`;
        // A function replacer: the id is text, never a replacement pattern (`$&`, `$'` would paste the drawing in).
        content = content.replace(needle, () => `${needle} data-emphasis="${xml(chosen!.id)}" class="${className}"`);
        if (channel === "edge")
          rules += `.${className} marker polyline{stroke:${color} !important;fill:${color} !important;}.${className}>.export-edge-line{stroke:${color};${thick.has(id) ? "" : "stroke-width:2;"}stroke-opacity:${assignment.style === "flow" ? 0.5 : 1};}.${className} .archer-er-mark{stroke:${color};}.${className} [data-export-arrow]{stroke:${color};fill:${color};}${assignment.style === "flow" ? `.${className} .export-emph-chevrons{visibility:visible;stroke:${color};}` : ""}`;
        else
          rules += `.${className}>.export-emph-outline{visibility:visible;stroke:${color};stroke-width:2;}.${className}>.export-node-body>rect,.${className}>.export-node-body>ellipse,.${className}>.export-node-body>polygon,.${className}>.export-node-body>circle{stroke:${color};stroke-width:2;}.${className} .export-journey-rail{stroke:${color};}`;
      }
    // What a shown highlight does not name steps back, as on the canvas (owner, 2026-11-12): a node's or a panel's
    // shapes fade to a quarter (the canvas's `-faded` tokens are its colour at 25%), its words take the faded ink.
    // A frame that holds a member is its context and stays at full strength, as on the canvas.
    if (normalized !== undefined && (assignments.nodes.size > 0 || assignments.edges.size > 0)) {
      if (projected.type === "graph") {
        const parentOf = new Map(projected.view.groups.map((g) => [g.id, g.parentId]));
        const nodeGroup = new Map(projected.view.nodes.map((n) => [n.id, n.groupId]));
        const holding = new Set<string>();
        for (const id of assignments.nodes.keys()) {
          let cursor = nodeGroup.get(id) ?? parentOf.get(id);
          for (let hops = 0; cursor !== undefined && hops <= parentOf.size; hops += 1) {
            holding.add(cursor);
            cursor = parentOf.get(cursor);
          }
        }
        for (const id of holding) {
          const needle = `data-element-id="${xml(id)}" data-element-channel="node"`;
          content = content.replace(needle, () => `${needle} data-emphasis-context="true"`);
        }
        // A line between two members is on the path, named or not.
        for (const edge of projected.view.edges)
          if (assignments.nodes.has(edge.source) && assignments.nodes.has(edge.target)) {
            const needle = `data-element-id="${xml(edge.id)}" data-element-channel="edge"`;
            content = content.replace(needle, () => `${needle} data-emphasis-context="true"`);
          }
      }
      const quiet = '[data-element-channel="node"]:not([data-emphasis]):not([data-emphasis-context])';
      // A line off the path fades as the canvas's does (its stroke and arrowheads at a quarter); its caption's words
      // take the faded ink, its gap keeps its ground.
      const offPath = '[data-element-channel="edge"]:not([data-emphasis]):not([data-emphasis-context])';
      rules +=
        `${quiet}>.export-node-body>*{fill-opacity:0.25;stroke-opacity:0.25;}` +
        `${quiet}>rect{fill-opacity:0.25;stroke-opacity:0.25;}` +
        `${quiet}>g[fill]{fill:var(--text-faded);}` +
        `${offPath}>.export-edge-line{stroke-opacity:0.25;}` +
        `${offPath} marker polyline,${offPath} [data-export-arrow],${offPath} .archer-er-mark{opacity:0.25;}` +
        `${offPath}>g[font-style]{fill:var(--text-faded);}`;
    }
    if (rules) content = `<style>${rules}</style>${content}`;
    const accessible = presentation?.accessible === true && normalized !== undefined;
    // A drawing in family colours numbers its groups too, as the canvas's Auto does (ADR 0030, amended 2026-11-11).
    const familyColours = projected.type === "graph" && usesFamilyColours(projected.view);
    if (accessible || (familyColours && normalized !== undefined)) {
      // Drawn after the content so a number is never under a box; lines first, so a corner's wins.
      for (const [channel, assigned] of [
        ["edge", assignments.edges],
        ["node", assignments.nodes],
      ] as const)
        for (const [id, assignment] of assigned) {
          const at = marks?.get(markKey(channel, id));
          if (at !== undefined)
            content += emphasisMarkerSvg(assignment.slot, at.x, at.y, `var(--${palette[assignment.palette]})`);
        }
    }
    const names = readableNames(projected);
    const groups = normalized?.groups ?? [];
    if (groups.length)
      description = `Highlights: ${groups
        .map((g) => {
          const members = membersOf(g, names);
          return `${groupSlot(g)} ${g.label}${members.length ? ` (${members.join(", ")})` : ""}`;
        })
        .join("; ")}`;
    // The Key's colours, beside the drawing at its top right (`palette-key-svg.ts`); a kind is said once there.
    const colours =
      presentation?.diagramKey === false || projected.type !== "graph"
        ? undefined
        : paletteKeySvg(projected.view, painted.originX + width + 32, painted.originY);
    const entries =
      presentation?.diagramKey === false
        ? []
        : diagramKeyEntries(projected).filter((e) => colours?.glyphs.has(e.label) !== true);
    if (colours !== undefined) {
      content += colours.svg;
      width += 32 + colours.width;
      height = Math.max(height, colours.height);
    }
    const paragraphs = presentation?.annotation ? [presentation.annotation] : [];
    // Without numbers, each group is still named beside its hue, as the page's legend does.
    const named = accessible ? [] : groups;
    const keyed = accessible ? groups : [];
    if (paragraphs.length || entries.length || keyed.length || named.length) {
      width = Math.max(320, width);
      // One column: every row of the key starts at the panel's left, its words beside its symbol.
      const x = painted.originX + 12,
        y = painted.originY + height + 24;
      let rowY = y;
      const rows = paragraphs.flatMap((s) => wrapText(s, width - 24, 12, 100, false));
      let body = rows.length ? `<g fill="var(--text)" stroke="none">${leftRows(rows, x, rowY + 14)}</g>` : "";
      rowY += rows.length * 16;
      if (named.length && rows.length) rowY += 8;
      for (const group of named) {
        const hue = `var(--${palette[group.palette]})`,
          tx = x + 20;
        const label = wrapText(
          group.label ?? group.description ?? group.id,
          width - (tx - painted.originX) - 12,
          12,
          100,
          true,
        );
        body += `<rect x="${x}" y="${rowY + 4}" width="12" height="12" rx="2" fill="${hue}" stroke="none"/><g fill="var(--text)" stroke="none">${leftRows(label, tx, rowY + 14, ' font-weight="600"')}</g>`;
        rowY += label.length * 16 + 6;
      }
      // One block per group: its number and hue, its name, and what it covers in words.
      if (keyed.length) rowY += 8;
      for (const group of keyed) {
        const hue = `var(--${palette[group.palette]})`,
          tx = x + 2 * MARKER_RADIUS + 22,
          wide = width - (tx - painted.originX) - 12;
        const label = wrapText(group.label, wide, 12, 100, true),
          about = group.description ? wrapText(group.description, wide, 12, 100, false) : [];
        const members = wrapText(`Members: ${membersOf(group, names).join(", ")}`, wide, 12, 100, false);
        body +=
          emphasisMarkerSvg(groupSlot(group), x + MARKER_RADIUS, rowY + 10, hue) +
          `<rect x="${x + 2 * MARKER_RADIUS + 4}" y="${rowY + 4}" width="12" height="12" rx="2" fill="${hue}" stroke="none"/>`;
        let lineY = rowY + 14;
        body += `<g fill="var(--text)" stroke="none">${leftRows(label, tx, lineY, ' font-weight="600"')}`;
        lineY += label.length * 16;
        if (about.length) {
          body += `<g fill="var(--text-dim)">${leftRows(about, tx, lineY)}</g>`;
          lineY += about.length * 16;
        }
        body += `${leftRows(members, tx, lineY)}</g>`;
        lineY += members.length * 16;
        rowY = Math.max(rowY + 24, lineY - 14 + 4) + 8;
      }
      if (entries.length) {
        body += `<text x="${x}" y="${rowY + 18}" font-size="13" font-weight="600" fill="var(--text)" stroke="none">Diagram Key</text>`;
        rowY += 32;
        for (const entry of entries) {
          const lines = wrapText(`${entry.label}: ${entry.meaning}`, width - 68, 12, 100, false);
          const symbol = renderToStaticMarkup(createElement(KeySymbol, { label: entry.label })).replace(
            /^<svg\b([^>]*)>/,
            (_, attrs: string) => `<svg${attrs.replace(/\s(?:width|height)="[^"]*"/g, "")} width="32" height="24">`,
          );
          body += `<g transform="translate(${x} ${rowY - 3})" color="var(--text)">${symbol}</g><g fill="var(--text)" stroke="none">${leftRows(lines, x + 44, rowY + 12)}</g>`;
          rowY += Math.max(24, lines.length * 16) + 8;
        }
      }
      height = rowY - painted.originY + 12;
      content += `<g data-export-presentation="true"><rect x="${painted.originX}" y="${y - 12}" width="${width}" height="${rowY - y + 24}" rx="6" fill="var(--node-bg)"/>${body}</g>`;
    }
  }
  if (input.noticeCaption !== undefined) {
    width = Math.max(320, width);
    const rows = input.noticeCaption
      .split(/\r?\n/)
      .flatMap((paragraph) =>
        paragraph === "" ? [""] : wrapText(paragraph, width - 24, 12, Number.MAX_SAFE_INTEGER, false),
      );
    const x = painted.originX + 12,
      y = painted.originY + height + 24;
    content += `<g data-export-notice="true" fill="var(--text)" stroke="none">${leftRows(rows, x, y + 14)}</g>`;
    height += 24 + rows.length * 16;
  }
  return {
    ...drawing,
    content,
    width,
    height,
    title: projected.view.title,
    ...(description === undefined ? {} : { description }),
    revision: projected.view.revision,
    activeEmphasisId,
    tracking: TYPE_TRACKING_EM,
  };
}
