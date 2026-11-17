/**
 * A source frame's own controls on the canvas (ADR 0036 A12, A13): its caption names the source and says
 * when it is proposed, "Open" goes to the full diagram, "×" removes what it added. The page provides the
 * actions; the canvas only draws them, so a canvas without Expand (MCP, the editor) draws a plain frame.
 */
import { createContext, useContext, type JSX } from "react";

export type FrameActions = {
  readonly proposed: (source: string) => boolean;
  readonly open: (source: string) => void;
  readonly remove: (source: string) => void;
};

export const FrameActionsContext = createContext<FrameActions | null>(null);

export function FrameChrome(props: { readonly source: string; readonly label: string }): JSX.Element | null {
  const actions = useContext(FrameActionsContext);
  if (actions === null) return null;
  const proposed = actions.proposed(props.source);
  // The buttons stop the press reaching the canvas, so pressing one neither pans nor clears the selection.
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stops pointer events from reaching the canvas under the frame's buttons; it handles nothing itself.
    // biome-ignore lint/a11y/useKeyWithClickEvents: stops pointer events from reaching the canvas under the frame's buttons; it handles nothing itself.
    <span className="archer-source-frame-tools nodrag nopan" onPointerDown={stop} onClick={stop} onDoubleClick={stop}>
      {proposed ? <span className="archer-source-frame-proposed">Proposed</span> : null}
      <button
        type="button"
        className="archer-source-frame-button"
        title={`Open ${props.label}`}
        aria-label={`Open ${props.label}`}
        onClick={() => actions.open(props.source)}
      >
        Open
      </button>
      <button
        type="button"
        className="archer-source-frame-button archer-source-frame-remove"
        title={`Remove ${props.label} from this view`}
        aria-label={`Remove ${props.label} from this view`}
        onClick={() => actions.remove(props.source)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}
