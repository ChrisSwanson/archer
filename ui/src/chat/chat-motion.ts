/**
 * The chat's one motion: it grows out of its bubble and shrinks back into it (about 200 ms).
 * Transforms only; with reduced motion, or where the browser cannot animate, it is instant.
 */
import type { Rect } from "./chat-position";

const MS = 200;

function reduced(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
const canAnimate = (el: HTMLElement): boolean => typeof el.animate === "function" && !reduced();
const via = (from: Rect, to: DOMRect): string =>
  `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${(from.right - from.left) / to.width}, ${(from.bottom - from.top) / to.height})`;

/** `el` has just taken its place: play it from `from` (the bubble's, or its own earlier box). */
export function growFrom(el: HTMLElement, from: Rect): void {
  if (!canAnimate(el)) return;
  const to = el.getBoundingClientRect();
  if (to.width === 0 || to.height === 0) return;
  el.animate([{ transform: via(from, to) }, { transform: "none" }], { duration: MS, easing: "ease-out" });
}

/** Shrinks `el` into `into`, then calls `done`; at once when it cannot animate. */
export function shrinkInto(el: HTMLElement, into: Rect, done: () => void): void {
  if (!canAnimate(el)) {
    done();
    return;
  }
  const from = el.getBoundingClientRect();
  if (from.width === 0 || from.height === 0) {
    done();
    return;
  }
  const run = el.animate(
    [
      { transform: "none", opacity: 1 },
      { transform: via(into, from), opacity: 0.15 },
    ],
    { duration: MS, easing: "ease-in", fill: "forwards" },
  );
  run.onfinish = done;
  run.oncancel = done;
}
