/**
 * How many Diagrams-gallery cards show without scrolling, so their thumbnails are asked for first
 * (the cards' `fetchpriority`, and the prefetch that asks before the cards exist).
 */

/** The grid's track and gap (DiagramsView.css). */
const TRACK_PX = 250,
  GAP_PX = 16;
/** For the estimate before layout: the shell's sidebar, the page's header above the grid, one card. */
const SIDEBAR_PX = 300,
  NARROW_PX = 900,
  NARROW_GUTTER_PX = 32,
  GRID_TOP_PX = 400,
  CARD_PX = 280;

/**
 * Measured: the grid's columns, its top and a card's height against the window. Unmeasured (before
 * layout, or none, as in tests): estimated from the window alone, never less than one card.
 */
export function firstScreenCards(at: {
  readonly viewportHeight: number;
  readonly viewportWidth?: number;
  readonly columns?: number;
  readonly gridTop?: number;
  readonly cardHeight?: number;
}): number {
  if (
    at.columns !== undefined &&
    at.gridTop !== undefined &&
    at.cardHeight !== undefined &&
    at.columns > 0 &&
    at.cardHeight > 0
  ) {
    if (at.gridTop >= at.viewportHeight) return 0;
    return at.columns * Math.max(1, Math.ceil((at.viewportHeight - at.gridTop) / (at.cardHeight + GAP_PX)));
  }
  const width = at.viewportWidth ?? TRACK_PX;
  const content = width - (width >= NARROW_PX ? SIDEBAR_PX : NARROW_GUTTER_PX);
  const columns = Math.max(1, Math.floor((content + GAP_PX) / (TRACK_PX + GAP_PX)));
  return columns * Math.max(1, Math.ceil((at.viewportHeight - GRID_TOP_PX) / (CARD_PX + GAP_PX)));
}

/** The estimate for this window. */
export function windowFirstScreen(): number {
  return typeof window === "undefined"
    ? 0
    : firstScreenCards({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
}
