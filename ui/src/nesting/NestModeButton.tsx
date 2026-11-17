/**
 * Nested or full view (ADR 0029 §2): one switch in the canvas control cluster, shown only when the
 * diagram has containers. Pressed = the nested view (open a level at a time); not pressed = the
 * whole model as written. Page state only: it never writes the address or history.
 */
import { ControlButton } from "@xyflow/react";
import type { JSX } from "react";
import type { NestMode } from "./nest-page";

export function NestModeButton(props: {
  readonly mode: NestMode;
  readonly busy?: boolean;
  readonly onChange: (mode: NestMode) => void;
}): JSX.Element {
  const nested = props.mode === "nested";
  return (
    <ControlButton
      className="archer-nest-mode"
      onClick={() => props.onChange(nested ? "full" : "nested")}
      aria-label="Nested view"
      aria-pressed={nested}
      aria-busy={props.busy === true ? true : undefined}
      title={
        nested
          ? "Nested view: open boxes one level at a time. Press for the whole diagram."
          : "Whole diagram. Press for the nested view."
      }
    >
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
        {nested ? (
          <path d="M12 8.5v7M8.5 12h7" strokeLinecap="round" />
        ) : (
          <rect x="8.5" y="8.5" width="7" height="7" rx="1.5" />
        )}
      </svg>
    </ControlButton>
  );
}
