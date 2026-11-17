/**
 * The page's route-ready point (performance rubric S7) where the graph canvas's `archer:interactive` mark does not
 * reach: a sequence diagram drawn and framed, a list of files or projects rendered, a note's text with the figures in
 * view drawn. `performance.mark("archer:route-ready", { detail: { kind } })`, once per document, a frame after the
 * state is committed (so it follows the paint), for the page-load lab (tools/perf/lib/readiness.mjs) to read in place
 * of its DOM stand-ins. Nothing reads it in the product.
 */
import { FIGURE_HOST_ATTRIBUTE } from "../comments/note-figures";

export type RouteReadyKind = "sequence" | "list" | "note";
export const ROUTE_READY_MARK = "archer:route-ready";

let marked = false;

export function markRouteReady(kind: RouteReadyKind): void {
  if (marked || typeof performance?.mark !== "function" || typeof requestAnimationFrame !== "function") return;
  marked = true;
  requestAnimationFrame(() => performance.mark(ROUTE_READY_MARK, { detail: { kind } }));
}

/** Tests only: a fresh document. */
export function resetRouteReadyForTests(): void {
  marked = false;
}

/**
 * Whether a note's figures in view are all drawn (or say why not): every figure host holds its figure, and none in
 * view is still waiting or drawing. The note's text and its empty hosts are committed a render before the figures
 * (NoteItem portals them into the hosts it placed), and a host with no figure yet is not settled: the mark fired there,
 * with every figure still waiting (O193).
 */
export function noteFiguresSettled(root: ParentNode, viewportHeight: number): boolean {
  for (const host of root.querySelectorAll(`[${FIGURE_HOST_ATTRIBUTE}]`)) {
    if (host.querySelector("figure.archer-note-figure") === null) return false;
  }
  for (const figure of root.querySelectorAll<HTMLElement>("figure.archer-note-figure")) {
    const box = figure.getBoundingClientRect();
    if (box.bottom <= 0 || box.top >= viewportHeight) continue;
    const state = figure.dataset.state;
    if (state === "waiting" || state === "drawing") return false;
  }
  return true;
}
