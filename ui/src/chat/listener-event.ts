/**
 * The window event the page's stream bridge (`app/host-bridge.ts`) raises for the service's `listeners` stream
 * event (ADR 0035 §8): `detail` is the event's data, unchecked (`chat/listeners.ts` reads it), `null` when the
 * stream (re)opened and what it missed must be read again, or `LISTENERS_LOST` when the stream dropped: until a
 * fresh listing arrives nobody can say who listens, so the chat says it does not know. Its own module, so the bridge (also in the MCP App
 * page) takes this one name and none of the chat.
 */
export const LISTENERS_DOM_EVENT = "archer:listeners";
/** The `detail` for a dropped stream. */
export const LISTENERS_LOST = "lost";

/** Raises it, where there is a window to raise it on. */
export function announceListeners(detail: unknown): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function" || typeof CustomEvent !== "function")
    return;
  window.dispatchEvent(new CustomEvent(LISTENERS_DOM_EVENT, { detail }));
}
