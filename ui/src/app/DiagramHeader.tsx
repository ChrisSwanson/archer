/**
 * The diagram's header line: who is behind what is on screen, and what the
 * agent just changed (phase3-front-door.md).
 *
 *   Presented by the agent · 2 min ago — <caption>
 *   The agent changed 3 elements — merged Lexer into Parser.  Removed: Lexer.  [Show changes] [Dismiss]
 *
 * Rendered only over a drawing; each line only when there is something to say.
 */
import type { JSX } from "react";
import { changeHeadline, changedCount, type ViewChange } from "./change";
import type { Presence } from "./presence";

export function PresenceLine({ presence }: { readonly presence: Presence }): JSX.Element {
  return (
    <p
      className="archer-presence"
      data-voice={presence.voice}
      data-caption={presence.detailIsCaption === true ? "true" : undefined}
    >
      <span className="archer-presence-lead">{presence.lead}</span>
      {presence.time === undefined ? null : (
        <>
          {" · "}
          <time dateTime={presence.time.iso}>{presence.time.text}</time>
        </>
      )}
      {presence.detail === undefined ? null : (
        // The caption is shown here, and read from the bar under the drawing
        // (kept for the screen reader, `Caption`), so it is not read twice.
        <span
          className="archer-presence-detail"
          title={presence.detail}
          aria-hidden={presence.detailIsCaption === true ? "true" : undefined}
        >
          {" — "}
          {presence.detail}
        </span>
      )}
    </p>
  );
}

export function ChangeNotice(props: {
  readonly change: ViewChange;
  readonly onShow: () => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  const { change, onShow, onDismiss } = props;
  return (
    <div className="archer-change" role="status" data-by={change.by}>
      <p className="archer-change-text">
        <span className="archer-change-headline">{changeHeadline(change)}</span>
        {change.summary === undefined ? null : (
          <span className="archer-change-summary">
            {" — "}
            {change.summary}
            {change.removed.length === 0 ? null : "."}
          </span>
        )}
        {change.removed.length === 0 ? null : (
          <span className="archer-change-removed">
            {" "}
            Removed: {change.removed.map((element) => element.label || element.id).join(", ")}.
          </span>
        )}
      </p>
      {changedCount(change) === 0 ? null : (
        <button type="button" className="archer-change-show" onClick={onShow}>
          Show changes
        </button>
      )}
      <button
        type="button"
        className="archer-change-dismiss"
        aria-label="Dismiss the change notice"
        onClick={onDismiss}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
