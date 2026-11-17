import type { JSX } from "react";
import "./PanSelectControl.css";

export type PointerMode = "select" | "hand";
export const DEFAULT_POINTER_MODE: PointerMode = "hand";

/** Pointer modes affect gestures only; keyboard selection remains available. */
export function PanSelectControl({
  mode,
  onChange,
}: {
  mode: PointerMode;
  onChange: (mode: PointerMode) => void;
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        className="archer-pan-select-button nopan"
        aria-label="Select mode"
        title="Select items"
        aria-pressed={mode === "select"}
        onClick={() => onChange("select")}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 3 19 13l-7 1-3 7Z" />
        </svg>
      </button>
      <button
        type="button"
        className="archer-pan-select-button nopan"
        aria-label="Hand mode"
        title="Drag to pan"
        aria-pressed={mode === "hand"}
        onClick={() => onChange("hand")}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path
            transform="translate(12 13) scale(0.85) translate(-12 -13)"
            d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v6c0 5-2 7-6 7h-1c-2 0-3-1-4-3l-4-5a1.5 1.5 0 0 1 2-2l3 3"
          />
        </svg>
      </button>
    </>
  );
}
