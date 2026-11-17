/** Static export-board geometry. The responsive page may wrap these columns. */
import type { ProjectedJourney } from "../diagrams/projection";
import { wrapText, estimateTextWidth, DEFAULT_TYPEFACE, type TypefaceId } from "./text-measure";
import {
  JOURNEY_COLUMN_MAX_PX,
  JOURNEY_GAP_PX,
  JOURNEY_LABEL_FONT_PX,
  journeyBoardWidth,
} from "../export/journey-metrics";
export function computeJourneyLayout(view: ProjectedJourney, typeface: TypefaceId = DEFAULT_TYPEFACE) {
  const sections = view.sections.map((section, index) => {
    const x = JOURNEY_GAP_PX + index * (JOURNEY_COLUMN_MAX_PX + JOURNEY_GAP_PX);
    const headingLines = wrapText(section.label, 260, JOURNEY_LABEL_FONT_PX, 100, true, typeface);
    let y = 58 + headingLines.length * 18 + 14;
    const tasks = section.tasks.map((task) => {
      const lines = wrapText(task.label, 274, JOURNEY_LABEL_FONT_PX, 100, true, typeface);
      const actorLines: string[][] = [];
      let row: string[] = [],
        used = 0;
      for (const actor of task.actors) {
        const width = estimateTextWidth(actor, 12, false, typeface) + 16;
        if (used + width > 274 && row.length) {
          actorLines.push(row);
          row = [];
          used = 0;
        }
        row.push(actor);
        used += width + 4;
      }
      if (row.length) actorLines.push(row);
      const height = 16 + lines.length * 18 + 6 + 18 + 6 + Math.max(1, actorLines.length) * 20;
      const result = { task, x: x + 10, y, width: 300, height, lines, actorLines };
      y += height + 8;
      return result;
    });
    return { section, x, y: 32, width: 320, height: y + 2 - 32, headingLines, tasks };
  });
  return {
    width: journeyBoardWidth(view.sections.length),
    height: Math.max(64, ...sections.map((s) => s.y + s.height + 16)),
    sections,
  };
}
