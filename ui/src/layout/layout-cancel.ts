/**
 * Layout the page itself stopped because it was being left (`pagehide`): not a failure to show. A page
 * restored from the back/forward cache asks again (`pageshow`). Kept apart from `elk-worker-transport.ts`,
 * which the component tests replace, so the stage and the transport share one class (O23).
 */
export class LayoutCancelled extends Error {
  constructor() {
    super("Background layout stopped: the page is closing.");
    this.name = "LayoutCancelled";
  }
}

export const isLayoutCancelled = (error: unknown): error is LayoutCancelled => error instanceof LayoutCancelled;

/** Calls `redraw` once, when the page is shown again; the returned function forgets it. */
export function whenPageShown(redraw: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => undefined;
  window.addEventListener("pageshow", redraw, { once: true });
  return () => window.removeEventListener("pageshow", redraw);
}
