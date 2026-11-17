import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** An arrow key as a move of `step` along x and y; `undefined` for any other key. */
export function arrowDelta(key: string, step: number): readonly [number, number] | undefined {
  const d = ARROWS[key];
  return d === undefined ? undefined : [d[0] * step, d[1] * step];
}

/** How far a press may wander and still be a click, not a drag. */
const CLICK_SLOP = 3;

export type GripOptions = {
  /**
   * A press released where it started (WCAG 2.5.7: a single pointer resizes without dragging). With it,
   * a drag reports nothing until the pointer has moved past a few pixels.
   */
  readonly onClick?: () => void;
  /** Escape during a drag (WCAG 2.5.2): the caller puts the size back where the drag began. */
  readonly onCancel?: () => void;
};

/**
 * The handlers of a resize grip (`role="separator"`): a drag reports each move's change `(dx, dy, false)`
 * and ends with `(0, 0, true)`; an arrow key reports one `step` and is final `(±step, 0, true)`.
 * The caller clamps and keeps whatever the size is.
 */
export function useGrip(onMove: (dx: number, dy: number, done: boolean) => void, step = 24, options: GripOptions = {}) {
  const from = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
    element: HTMLElement;
    pointerId: number;
  } | null>(null);
  const stopEscape = useRef<(() => void) | null>(null);
  const latest = useRef({ onMove, options });
  latest.current = { onMove, options };
  useEffect(() => () => stopEscape.current?.(), []);

  const release = (): void => {
    const held = from.current;
    from.current = null;
    stopEscape.current?.();
    stopEscape.current = null;
    if (held === null) return;
    held.element.classList.remove("drag");
    if (held.element.hasPointerCapture?.(held.pointerId) === true) held.element.releasePointerCapture(held.pointerId);
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    const held = from.current;
    if (held === null) return;
    release();
    const { onMove: move, options: current } = latest.current;
    if (!held.moved && event.type === "pointerup" && current.onClick !== undefined) {
      current.onClick();
      return;
    }
    move(0, 0, true);
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      release();
      const element = event.currentTarget;
      element.classList.add("drag");
      element.setPointerCapture?.(event.pointerId);
      const clickable = latest.current.options.onClick !== undefined;
      from.current = {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        moved: !clickable,
        element,
        pointerId: event.pointerId,
      };
      if (latest.current.options.onCancel === undefined) return;
      // The press takes no focus (preventDefault), so Escape is heard on the window, ahead of the page's own keys.
      const onEscape = (key: globalThis.KeyboardEvent): void => {
        if (key.key !== "Escape" || from.current === null) return;
        key.preventDefault();
        key.stopPropagation();
        release();
        latest.current.options.onCancel?.();
      };
      window.addEventListener("keydown", onEscape, true);
      stopEscape.current = () => window.removeEventListener("keydown", onEscape, true);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>): void => {
      const held = from.current;
      if (held === null) return;
      if (!held.moved) {
        if (Math.abs(event.clientX - held.startX) < CLICK_SLOP && Math.abs(event.clientY - held.startY) < CLICK_SLOP)
          return;
        held.moved = true;
      }
      latest.current.onMove(event.clientX - held.x, event.clientY - held.y, false);
      held.x = event.clientX;
      held.y = event.clientY;
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: (event: PointerEvent<HTMLElement>): void => {
      if (from.current !== null) end(event);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>): void => {
      const d = arrowDelta(event.key, step);
      if (d === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      onMove(d[0], d[1], true);
    },
  };
}
