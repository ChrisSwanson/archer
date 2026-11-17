import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  computeSequenceLayout,
  type SequenceLayoutResult,
  ACTOR_GLYPH_WIDTH,
  ACTOR_GLYPH_GAP,
  ACTOR_GLYPH_HEIGHT,
  PARTICIPANT_FONT,
  MESSAGE_LINE_HEIGHT,
  SELF_LOOP_WIDTH,
  SELF_LOOP_HEIGHT,
  SELF_LABEL_GAP,
  NOTE_FOLD,
  NOTE_PADDING_Y,
  NOTE_LINE_HEIGHT,
  NOTE_FONT,
  ACTIVATION_WIDTH,
  ACTIVATION_NEST_OFFSET,
  FRAGMENT_HEADER_HEIGHT,
} from "../layout/sequence-layout";
import { estimateTextWidth } from "../layout/text-measure";
import { ActorGlyph, Arrowhead } from "../diagrams/SequencePrimitives";
import type { ProjectedSequence } from "../diagrams/projection";
import { xml, textRows, emphasisOutline, stillChevrons, markKey, lineMark, type PaintedSvg } from "./svg";
const primitive = <P extends object>(component: FunctionComponent<P>, props: P): string =>
  renderToStaticMarkup(createElement(component, props));
export function paintSequence(layout: SequenceLayoutResult): PaintedSvg {
  let content = layout.fragments
    .map(
      (f) =>
        `<g data-element-id="${xml(f.id)}"><rect x="${f.x}" y="${f.y}" width="${f.width}" height="${f.height}" rx="5" fill="var(--fragment-bg)" stroke="var(--fragment-border)"/>${f.sections
          .slice(1)
          .map(
            (s) =>
              `<path d="M ${f.x} ${s.y} H ${f.x + f.width}" stroke-dasharray="3 3" stroke="var(--fragment-border)" fill="none"/>`,
          )
          .join("")}</g>`,
    )
    .join("");
  content += layout.participants
    .map((p) => {
      const cx = p.x + p.width / 2,
        cy = p.y + p.height / 2,
        actor = p.kind === "actor",
        tw = Math.max(0, ...p.lines.map((l) => estimateTextWidth(l, PARTICIPANT_FONT, true, layout.typeface))),
        gx = cx - (ACTOR_GLYPH_WIDTH + ACTOR_GLYPH_GAP + tw) / 2,
        tx = actor ? gx + ACTOR_GLYPH_WIDTH + ACTOR_GLYPH_GAP + tw / 2 : cx;
      return `<g data-element-id="${xml(p.id)}" data-element-channel="node"><path d="M ${cx} ${p.y + p.height} V ${layout.lifelineEndY}" fill="none" stroke="var(--lifeline)" stroke-dasharray="5 5" stroke-width="1"/><rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="6" fill="var(--node-bg)" stroke="var(--node-border)" stroke-width="1.5"/>${actor ? `<g fill="none" stroke="var(--node-text)">${primitive(ActorGlyph, { x: gx, y: cy - ACTOR_GLYPH_HEIGHT / 2 })}</g>` : ""}<g fill="currentColor" stroke="none">${textRows(p.lines, tx, cy - (p.lines.length - 1) * 7.5 + 4, PARTICIPANT_FONT, 15, true)}</g>${emphasisOutline(p.x, p.y, p.width, p.height, 6)}</g>`;
    })
    .join("");
  content += layout.activations
    .map((a) => {
      const p = layout.participants.find((p) => p.id === a.participantId)!;
      return `<rect x="${p.x + p.width / 2 + a.depth * ACTIVATION_NEST_OFFSET - ACTIVATION_WIDTH / 2}" y="${a.startY}" width="${ACTIVATION_WIDTH}" height="${Math.max(a.endY - a.startY, 6)}" rx="2" fill="var(--activation-bg)" stroke="var(--fragment-border)"/>`;
    })
    .join("");
  content += layout.fragments
    .map(
      (f) =>
        `<g fill="var(--bg)"><rect x="${f.x}" y="${f.y}" width="${f.width}" height="${FRAGMENT_HEADER_HEIGHT}" stroke="none"/><rect x="${f.x}" y="${f.y}" width="${f.chipWidth}" height="${FRAGMENT_HEADER_HEIGHT - 6}" rx="5" fill="var(--fragment-border)" fill-opacity="0.25" stroke="var(--fragment-border)" stroke-width="1"/><g fill="var(--text)" stroke="none">${textRows([f.kind], f.x + f.chipWidth / 2, f.y + 13, 10, 14, true)}<text x="${f.x + f.chipWidth + 8}" y="${f.y + 16}" font-size="11" fill="var(--fragment-text)" stroke="var(--bg)" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${xml(f.headerLabel)}</text>${f.sections
          .slice(1)
          .filter((s) => s.label)
          .map(
            (s) =>
              `<text x="${f.x + 10}" y="${s.y + 13}" font-size="11" fill="var(--fragment-text)" stroke="var(--bg)" stroke-width="3" stroke-linejoin="round" paint-order="stroke">[${xml(s.label!)}]</text>`,
          )
          .join("")}</g></g>`,
    )
    .join("");
  content += layout.messages
    .map((m) => {
      const self = m.from === m.to,
        tipX = self ? m.fromX : m.toX,
        tipY = self ? m.y + SELF_LOOP_HEIGHT : m.y,
        dir = self ? -1 : m.toX > m.fromX ? 1 : -1;
      const path = self
        ? `M ${m.fromX} ${m.y} H ${m.fromX + SELF_LOOP_WIDTH} V ${tipY} H ${m.fromX}`
        : `M ${m.fromX} ${m.y} H ${m.toX}`;
      const selfX = m.fromX + SELF_LOOP_WIDTH + SELF_LABEL_GAP,
        selfY = m.y + SELF_LOOP_HEIGHT / 2 + 4 - ((m.lines.length - 1) * MESSAGE_LINE_HEIGHT) / 2;
      const label = self
        ? `<text x="${selfX}" y="${selfY}" font-size="12">${m.lines.map((line, i) => `<tspan x="${selfX}" y="${selfY + i * MESSAGE_LINE_HEIGHT}">${xml(line)}</tspan>`).join("")}</text>`
        : textRows(
            m.lines,
            (m.fromX + m.toX) / 2,
            m.y - 7 - (m.lines.length - 1) * MESSAGE_LINE_HEIGHT,
            12,
            MESSAGE_LINE_HEIGHT,
          );
      const ink = m.kind === "reply" ? "var(--text-faint)" : "var(--edge)";
      const badge =
        m.number === undefined
          ? ""
          : `<rect x="${m.fromX - (m.badgeWidth ?? 0) / 2}" y="${m.y - 7}" width="${m.badgeWidth ?? 0}" height="14" rx="7" fill="var(--bg)" stroke="${ink}" stroke-width="1"/>`;
      return `<g data-element-id="${xml(m.id)}" data-element-channel="edge"><path class="export-edge-line" d="${path}" fill="none" stroke="${ink}" stroke-width="1.25"${m.kind === "reply" ? ' stroke-dasharray="6 3"' : ""}/><g data-export-arrow="true" fill="${ink}" stroke="${ink}">${primitive(Arrowhead, { tipX, y: tipY, direction: dir, open: m.kind !== "sync" })}</g>${m.bidirectional ? `<g data-export-arrow="true" fill="${ink}" stroke="${ink}">${primitive(Arrowhead, { tipX: m.fromX, y: m.y, direction: self ? -1 : dir === 1 ? -1 : 1, open: m.kind !== "sync" })}</g>` : ""}${stillChevrons(
        self
          ? [
              { x: m.fromX, y: m.y },
              { x: m.fromX + SELF_LOOP_WIDTH, y: m.y },
              { x: m.fromX + SELF_LOOP_WIDTH, y: tipY },
              { x: m.fromX, y: tipY },
            ]
          : [
              { x: m.fromX, y: m.y },
              { x: m.toX, y: m.y },
            ],
        m.bidirectional === true,
      )}${badge}<g fill="var(--text-dim)" stroke="none">${label}${m.number !== undefined ? `<g fill="var(--text)" stroke="none">${textRows([String(m.number)], m.fromX, m.y + 4, 10, 14, true)}</g>` : ""}</g></g>`;
    })
    .join("");
  content += layout.notes
    .map(
      (n) =>
        `<g data-element-id="${xml(n.id)}"><path d="M ${n.x} ${n.y} H ${n.x + n.width - NOTE_FOLD} L ${n.x + n.width} ${n.y + NOTE_FOLD} V ${n.y + n.height} H ${n.x} Z" fill="var(--surface-2)" stroke="var(--fragment-border)"/><path d="M ${n.x + n.width - NOTE_FOLD} ${n.y} V ${n.y + NOTE_FOLD} H ${n.x + n.width}" fill="none" stroke="var(--fragment-border)"/><g fill="var(--text-dim)" stroke="none">${textRows(n.lines, n.x + n.width / 2, n.y + NOTE_PADDING_Y + NOTE_LINE_HEIGHT - 4, NOTE_FONT, NOTE_LINE_HEIGHT)}</g></g>`,
    )
    .join("");
  const marks = new Map<string, { x: number; y: number }>();
  for (const p of layout.participants) marks.set(markKey("node", p.id), { x: p.x, y: p.y });
  for (const m of layout.messages) {
    if (m.from === m.to) {
      marks.set(
        markKey("edge", m.id),
        lineMark([
          { x: m.fromX, y: m.y },
          { x: m.fromX + SELF_LOOP_WIDTH, y: m.y },
          { x: m.fromX + SELF_LOOP_WIDTH, y: m.y + SELF_LOOP_HEIGHT },
          { x: m.fromX, y: m.y + SELF_LOOP_HEIGHT },
        ]),
      );
      continue;
    }
    // The caption sits above the line, centred: its last baseline 7 above it.
    const ink = Math.max(0, ...m.lines.map((line) => estimateTextWidth(line, 12)));
    const top = m.y - 7 - (m.lines.length - 1) * MESSAGE_LINE_HEIGHT - 12;
    const caption =
      m.lines.length && ink > 0
        ? { x: (m.fromX + m.toX) / 2 - ink / 2, y: top, width: ink, height: m.y - 4 - top }
        : undefined;
    marks.set(
      markKey("edge", m.id),
      lineMark(
        [
          { x: m.fromX, y: m.y },
          { x: m.toX, y: m.y },
        ],
        caption,
      ),
    );
  }
  return {
    content,
    width: layout.width,
    height: layout.height,
    originX: layout.originX,
    originY: layout.originY,
    marks,
  };
}
export function layoutSequence(view: ProjectedSequence): PaintedSvg {
  return paintSequence(computeSequenceLayout(view));
}
