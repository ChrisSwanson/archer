/**
 * The separator between the drawing and the diagram side panel (0.6.4, D5; first the walkthrough panel's,
 * ADR 0034 §6): drag it, click it to step through widths, or press ← → (← widens: the panel is on the right);
 * Escape during a drag puts the width back. The width is kept per viewer,
 * in `localStorage`, which may be blocked, so every touch of it is guarded and the page works without it.
 */
import { useRef, type JSX } from "react";
import { useGrip } from "./use-grip";
import { browserStateKey } from "../runtime/address.ts";

export const PANEL_WIDTH_KEY = "archer.diagram-panel.width";
export const PANEL_WIDTH = { min: 280, max: 640, initial: 340, key: 24 } as const;

const clamp = (width: number): number => Math.max(PANEL_WIDTH.min, Math.min(PANEL_WIDTH.max, Math.round(width)));

export function readPanelWidth(): number {
  try {
    const width = Number(localStorage.getItem(browserStateKey(PANEL_WIDTH_KEY)));
    return Number.isFinite(width) && width > 0 ? clamp(width) : PANEL_WIDTH.initial;
  } catch {
    return PANEL_WIDTH.initial;
  }
}

export function savePanelWidth(width: number): void {
  try {
    localStorage.setItem(browserStateKey(PANEL_WIDTH_KEY), String(clamp(width)));
  } catch {
    // Storage blocked: the width lasts this visit only.
  }
}

/** The widths a click on the divider steps through: the narrowest, the first, a wider one and the widest. */
export const PANEL_WIDTH_STEPS = [PANEL_WIDTH.min, PANEL_WIDTH.initial, 480, PANEL_WIDTH.max] as const;

/** The next step wider than `width`, back to the narrowest after the widest. */
export function nextPanelWidth(width: number): number {
  return PANEL_WIDTH_STEPS.find((step) => step > width) ?? PANEL_WIDTH_STEPS[0];
}

export function PanelDivider({
  width,
  onChange,
}: {
  readonly width: number;
  readonly onChange: (width: number) => void;
}): JSX.Element {
  const latest = useRef(width);
  latest.current = width;
  /** Where the pointer says the width is, unclamped, so a drag past a bound comes back under the pointer. */
  const raw = useRef(width);
  /** The width a drag began at, for Escape to put back. */
  const start = useRef(width);
  const commit = (next: number): void => {
    latest.current = clamp(next);
    raw.current = latest.current;
    onChange(latest.current);
    savePanelWidth(latest.current);
  };
  const grip = useGrip(
    (dx, _dy, done) => {
      if (!done && clamp(raw.current) !== latest.current) raw.current = latest.current;
      const next = done ? (dx === 0 ? latest.current : width) - dx : raw.current - dx;
      if (!done) raw.current = next;
      latest.current = clamp(next);
      onChange(latest.current);
      if (done) {
        raw.current = latest.current;
        savePanelWidth(latest.current);
      }
    },
    PANEL_WIDTH.key,
    {
      // A single pointer resizes without dragging (WCAG 2.5.7): each click steps to the next width.
      onClick: () => commit(nextPanelWidth(latest.current)),
      onCancel: () => commit(start.current),
    },
  );
  return (
    <div
      {...grip}
      // The press is the grip's (no native focus on it), so the divider takes focus itself: after a click step or a
      // drag the arrow keys go on resizing, and focus is not left behind on the page (round 1, R4-claude S4).
      onPointerDown={(event) => {
        start.current = latest.current;
        grip.onPointerDown(event);
        if (event.button === 0) event.currentTarget.focus({ preventScroll: true });
      }}
      className="archer-walk-divider archer-panel-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize diagram panel"
      aria-description="Drag, click to step through widths, or use the arrow keys. Escape cancels a drag."
      title="Drag or click to resize"
      tabIndex={0}
      aria-valuemin={PANEL_WIDTH.min}
      aria-valuemax={PANEL_WIDTH.max}
      aria-valuenow={width}
    />
  );
}
