/**
 * "Follow steps" (ADR 0034 §6): a switch beside the canvas's zoom controls. Pressed = the camera
 * follows each step; it goes off when the person moves the canvas and stays off until pressed again.
 */
import { ControlButton } from "@xyflow/react";
import type { JSX } from "react";
import "./walk-follow.css";

export function FollowButton(props: { readonly on: boolean; readonly onChange: (on: boolean) => void }): JSX.Element {
  return (
    <ControlButton
      className="archer-walk-follow"
      onClick={() => props.onChange(!props.on)}
      aria-label="Follow steps"
      aria-pressed={props.on}
      title={props.on ? "Following the steps. Press to stop." : "Following paused. Press to follow the steps again."}
    >
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.5v2.3M8 12.2v2.3M1.5 8h2.3M12.2 8h2.3" />
      </svg>
    </ControlButton>
  );
}

/** "Open Shop API to see the detail": over the canvas when the step's parts are inside a closed container. */
export function ClosedNote(props: { readonly label: string; readonly onOpen: () => void }): JSX.Element {
  return (
    <div className="archer-walk-note" role="status">
      <span>This step happens inside {props.label}.</span>
      <button type="button" onClick={props.onOpen}>
        Open {props.label} to see the detail
      </button>
    </div>
  );
}
