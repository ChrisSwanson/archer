/**
 * The panel's notice for a walkthrough that does not match the diagram (ADR 0034 §3, slice 7b; the
 * words are the approved prototype's): partly out of date, archived with the way to its old version,
 * and playing on that version with the way back. Grey, never teal: stale is not part of the path.
 */
import { useEffect, useRef, type JSX } from "react";
import type { Walk } from "./contract";
import type { OldVersion } from "./use-old-version";
import { dayLabel, flagNotice } from "./walk-stale";

export type StaleProps = {
  readonly walk: Walk | null;
  /** When the diagram last changed, if known: the date the partly out-of-date notice gives. */
  readonly changedAt?: string;
  readonly old?: OldVersion;
  readonly onOpenOld?: () => void;
  readonly onBackToCurrent?: () => void;
};

const WHY: Record<"refused" | "not-in-history" | "failed", string> = {
  refused: "That version no longer compiles with this Archer, so only the text of its steps can be shown.",
  "not-in-history": "That version is not in this project's Git history, so only the text of its steps can be shown.",
  failed: "The old version could not be read. Try again.",
};

export function WalkStaleNotice({ walk, changedAt, old, onOpenOld, onBackToCurrent }: StaleProps): JSX.Element | null {
  const note = useRef<HTMLParagraphElement>(null);
  // Focus moves only after the reader pressed one of these buttons, which is then replaced: to its opposite, or to the note when no button is left.
  const pressed = useRef<"open" | "back" | null>(null);
  const state = old?.status ?? "idle";
  const playing = walk?.old === true;
  useEffect(() => {
    const was = pressed.current;
    if (was === null || state === "loading") return;
    const button = note.current?.querySelector<HTMLElement>("button");
    if (button !== null && button !== undefined) button.focus();
    else note.current?.focus();
    pressed.current = null;
  }, [state, playing]);
  if (walk === null || (walk.status === "current" && walk.old !== true)) return null;
  const flag = <span className="archer-walk-flag" aria-hidden="true" />;
  if (walk.old === true) {
    const at = old?.status === "found" ? dayLabel(old.committedAt) : "";
    return (
      <p ref={note} tabIndex={-1} className="archer-walk-notice" role="note">
        <b>Old version{at === "" ? "" : `: ${at}`}.</b> The diagram this walkthrough was written for.{" "}
        <button
          type="button"
          className="archer-walk-link"
          onClick={() => {
            pressed.current = "back";
            onBackToCurrent?.();
          }}
        >
          Back to the current diagram
        </button>
      </p>
    );
  }
  if (walk.status === "archived") {
    return (
      <p ref={note} tabIndex={-1} className="archer-walk-notice" role="note" aria-busy={state === "loading"}>
        {flag}
        <b>Archived.</b> None of its {walk.steps.length} steps match this diagram any more.{" "}
        {state === "refused" || state === "not-in-history" ? (
          WHY[state]
        ) : state === "loading" ? (
          <span>Opening the version it was written for…</span>
        ) : (
          <>
            {state === "failed" ? `${WHY.failed} ` : ""}
            <button
              type="button"
              className="archer-walk-link"
              onClick={() => {
                pressed.current = "open";
                onOpenOld?.();
              }}
            >
              Open on the version it was written for
            </button>
          </>
        )}
      </p>
    );
  }
  const text = flagNotice(walk, changedAt);
  return (
    <p className="archer-walk-notice" role="note">
      {flag}
      <b>{text.lead}</b> {text.rest}
    </p>
  );
}
