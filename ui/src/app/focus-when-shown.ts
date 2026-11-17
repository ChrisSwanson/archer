/**
 * Focus that waits for its target (a destination's heading, the editor, a panel's tab) to be on the page, and the
 * waits a component started, stopped with it. Out of App.tsx so the waits' lifetimes can be tested (G6, PF-3).
 */
import { useCallback, useEffect, useRef } from "react";

/**
 * Whether `element` can take focus where it stands: not under a `hidden` or `inert` ancestor, nor styled invisible.
 * A panel-hosted review is kept laid out while hidden (`display:flex; visibility:hidden`, for its fade), so having
 * boxes is not enough (round 1, R4-02).
 */
function shownForFocus(element: HTMLElement): boolean {
  if (element.closest("[hidden], [inert]") !== null) return false;
  if (typeof element.checkVisibility === "function") return element.checkVisibility({ visibilityProperty: true });
  return window.getComputedStyle(element).visibility !== "hidden";
}

/**
 * Focuses the first element matching `selector` once it is on the page (the editor draws after its
 * draft opens), unless focus has gone somewhere else meanwhile. Gives up after a few seconds.
 */
export function focusWhenShown(
  selector: string,
  options: {
    /** Also take focus from this element (the control that opened the destination and is still there). */
    readonly from?: Element | null;
    /** Only an element this accepts (the destination's own heading, not the page's it replaces). */
    readonly accept?: (element: HTMLElement) => boolean;
  } = {},
): FocusWait {
  // Held only until focus lands or the wait ends: a control kept past that would keep the page it was on (PF-3).
  let from = options.from ?? null;
  const accept = options.accept;
  const unplaced = (): boolean => {
    const held = document.activeElement;
    return held === null || held === document.body || (from !== null && held === from);
  };
  const attempt = (): boolean => {
    const target = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (element) => element.getClientRects().length > 0 && shownForFocus(element) && (accept?.(element) ?? true),
    );
    if (target === undefined) return false;
    if (unplaced()) {
      // A heading takes focus from script only (round 1, F10/F14): it stays out of the Tab order.
      if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      // Not taken (still behind a closing style, say): try again on the next change.
      if (document.activeElement !== target) return false;
    }
    return true;
  };
  if (attempt()) {
    from = null;
    return SETTLED;
  }
  const observer = new MutationObserver(() => {
    if (attempt()) stop();
  });
  const timer = window.setTimeout(() => stop(), 5000);
  let stopped = false;
  function stop(): void {
    stopped = true;
    from = null;
    observer.disconnect();
    window.clearTimeout(timer);
  }
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "inert", "class", "aria-selected"],
  });
  // A style that shows the target without a DOM change (a transition ending) is caught by a few frames' retries.
  let frames = 0;
  const retry = (): void => {
    if (stopped) return;
    if (attempt()) {
      stop();
      return;
    }
    if (++frames < 30) window.requestAnimationFrame(retry);
  };
  window.requestAnimationFrame(retry);
  return Object.assign(() => stop(), { settled: () => stopped });
}

/** A focus wait: call it to give up; `settled` once focus landed, the wait ended or it was given up. */
export type FocusWait = (() => void) & { readonly settled: () => boolean };
const SETTLED: FocusWait = Object.assign(() => {}, { settled: () => true });

/**
 * The control a navigation was started from (a file's title, a link), which the destination's heading may take focus
 * from even while it is still on screen; never a part of the drawing, so `[` and `]` leave a keyboard reader on it.
 */
export function navigationOrigin(): Element | null {
  const held = document.activeElement;
  return held === null || held === document.body || held.closest(".react-flow") !== null ? null : held;
}

export const weakly = (element: Element | null): WeakRef<Element> | null =>
  element === null ? null : new WeakRef(element);

/**
 * Keeps the stop of each focus watch started from an event handler, and stops any still waiting when the
 * component unmounts: its observer and 5 s timer must not outlive the page they were started for.
 */
export function usePendingFocus(): (wait: FocusWait) => void {
  const waits = useRef(new Set<FocusWait>());
  useEffect(
    () => () => {
      for (const wait of waits.current) wait();
      waits.current.clear();
    },
    [],
  );
  // Only the waits still waiting are kept: every settled one kept the page it was made on (G6, PF-3).
  return useCallback((wait: FocusWait) => {
    for (const held of waits.current) if (held.settled()) waits.current.delete(held);
    if (!wait.settled()) waits.current.add(wait);
  }, []);
}
