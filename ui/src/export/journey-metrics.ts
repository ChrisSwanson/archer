/** Full-width board metrics shared with the responsive journey canvas. */
export const JOURNEY_COLUMN_MAX_PX = 320;
export const JOURNEY_GAP_PX = 16;
export const JOURNEY_MAX_SCORE = 5;
/** A section's and a task's label, in px (`--type-canvas-journey` in styles.css is this size). */
export const JOURNEY_LABEL_FONT_PX = 13.5;
export function journeyBoardWidth(columns: number): number {
  const n = Math.max(1, columns);
  return n * JOURNEY_COLUMN_MAX_PX + (n + 1) * JOURNEY_GAP_PX;
}
export function journeyScore(score: number): number {
  return Math.min(JOURNEY_MAX_SCORE, Math.max(1, Math.round(score)));
}
