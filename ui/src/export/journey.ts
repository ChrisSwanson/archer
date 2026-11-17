import type { ProjectedJourney } from "../diagrams/projection";
import { estimateTextWidth } from "../layout/text-measure";
import { computeJourneyLayout } from "../layout/journey-layout";
import { JOURNEY_LABEL_FONT_PX, journeyScore } from "./journey-metrics";
import { xml, textRows, emphasisOutline, markKey, type PaintedSvg } from "./svg";
/** A full-width static board; responsive browser narrowing is intentionally not a screenshot. */
export function layoutJourney(view: ProjectedJourney): PaintedSvg {
  const board = computeJourneyLayout(view);
  const marks = new Map<string, { x: number; y: number }>();
  const content = board.sections
    .map(({ section, x, headingLines: head, tasks }) => {
      let y = 58;
      let inner = `<g fill="var(--group-text)" stroke="none">${textRows(head, x + 160, y, JOURNEY_LABEL_FONT_PX, 18, true)}</g>`;
      y += head.length * 18 + 14;
      for (const measured of tasks) {
        const { task, lines, actorLines, height: h } = measured;
        const score = journeyScore(task.score);
        let body = `<rect x="${x + 10}" y="${y}" width="300" height="${h}" rx="6"/><path class="export-journey-rail" d="M ${x + 12} ${y + 5} V ${y + h - 5}" stroke-width="${score === 3 ? 2 : score <= 2 ? 4 : 5}"${score <= 2 ? ' stroke-dasharray="4 3"' : ""}/><g fill="currentColor" stroke="none">${textRows(lines, x + 160, y + 22, JOURNEY_LABEL_FONT_PX, 18, true)}</g>`;
        const sy = y + 16 + lines.length * 18 + 6 + 9;
        body +=
          Array.from(
            { length: 5 },
            (_, i) =>
              `<circle cx="${x + 25 + i * 12}" cy="${sy}" r="4" fill="${i < score ? "currentColor" : "none"}"/>`,
          ).join("") +
          `<text x="${x + 90}" y="${sy + 4}" fill="currentColor" stroke="none" font-size="12">${score}/5</text>`;
        const ay = sy + 20;
        if (!actorLines.length)
          body += `<text x="${x + 24}" y="${ay + 4}" font-size="12" font-style="italic" fill="var(--text-dim)" stroke="none">No actors</text>`;
        actorLines.forEach((actors, j) => {
          let ax = x + 24;
          for (const actor of actors) {
            const aw = estimateTextWidth(actor, 12) + 16;
            body += `<rect x="${ax}" y="${ay + j * 20 - 10}" width="${aw}" height="18" rx="9" fill="none"/><text x="${ax + 8}" y="${ay + j * 20 + 3}" font-size="12" fill="currentColor" stroke="none">${xml(actor)}</text>`;
            ax += aw + 4;
          }
        });
        marks.set(markKey("node", task.id), { x: x + 10, y });
        inner += `<g data-element-id="${xml(task.id)}" data-element-channel="node">${body}${emphasisOutline(x + 10, y, 300, h, 6)}</g>`;
        y += h + 8;
      }
      const bottom = y + 2;
      marks.set(markKey("node", section.id), { x, y: 32 });
      return `<g data-element-id="${xml(section.id)}" data-element-channel="node"><rect x="${x}" y="32" width="320" height="${bottom - 32}" rx="10" fill="var(--group-bg)"/>${inner}${emphasisOutline(x, 32, 320, bottom - 32, 10)}</g>`;
    })
    .join("");
  return { content, width: board.width, height: board.height, originX: 0, originY: 0, marks };
}
