/**
 * Shift+F10 opens the menu of what has focus, on every platform (UI_UX.md; the help overlay says so).
 *
 * The page's menus listen for `contextmenu` (right-click, the context-menu key, Shift+F10, a long press), and a
 * browser on Windows or Linux turns Shift+F10 into that event. Chromium and Safari on macOS do not: there, a keyboard
 * user's Shift+F10 did nothing, on the canvas and the walkthrough rows alike. This sends the event the browser would
 * have sent, at the focused element, only when the browser sent none (checked a task later, so it never doubles), and
 * with no pointer position (clientX and clientY 0, not the right button), which the menus read as "open at the element".
 * A handler that took the key itself (the note body's own Shift+F10) prevented it, and is left alone.
 */
export function installMenuKeyFallback(target: Window = window): () => void {
  let pending: { at: EventTarget; timer: number } | null = null;
  const onContextMenu = (): void => {
    if (pending === null) return;
    target.clearTimeout(pending.timer);
    pending = null;
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key !== "F10" ||
      !event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.defaultPrevented ||
      event.repeat
    )
      return;
    const at = event.target;
    if (!(at instanceof Element) || pending !== null) return;
    const timer = target.setTimeout(() => {
      pending = null;
      if (!at.isConnected) return;
      at.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          clientX: 0,
          clientY: 0,
        }),
      );
    }, 0);
    pending = { at, timer };
  };
  // Capture, so a menu that stops the event's propagation still tells this one the browser sent it.
  target.addEventListener("contextmenu", onContextMenu, true);
  // Bubble, after the page's own handlers, so one that took the key (defaultPrevented) is left alone.
  target.addEventListener("keydown", onKeyDown);
  return () => {
    target.removeEventListener("contextmenu", onContextMenu, true);
    target.removeEventListener("keydown", onKeyDown);
    if (pending !== null) target.clearTimeout(pending.timer);
    pending = null;
  };
}
