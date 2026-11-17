/**
 * Says the reader is looking at a different diagram from the one the agent is
 * presenting, and offers the way back (ADR 0011).
 *
 * The two are separate facts. The agent presents one view; the reader may pick
 * any tab. When they differ, the agent can be describing a drawing that is not
 * on this screen, and nothing else on the page would say so: the tabs look the
 * same whoever chose them. This is the smallest thing that does -- one quiet
 * line under the tabs, in the page's own chrome rather than on the drawing --
 * and it is gone the moment the two agree again.
 *
 * Titles are shown as text exactly as registered. The button is a button: it
 * changes what this page shows and tells the agent nothing except, as any
 * navigation does, which view the reader now has on screen.
 *
 * Not a live region. It appears because the reader picked a tab, and goes
 * because they went back or the agent presented: in each case something else
 * has just told them what changed.
 */
import type { JSX } from "react";

export function ReaderViewNotice(props: {
  /** The title of the view the agent is presenting. */
  readonly agentTitle: string;
  /** The title of the view the reader has on screen. */
  readonly readerTitle: string;
  readonly onReturn: () => void;
}): JSX.Element {
  return (
    <div className="archer-reader-view" role="group" aria-label="What the agent is presenting">
      <p className="archer-reader-view-text">
        The agent is presenting <span className="archer-reader-view-title">{props.agentTitle}</span>. You are viewing{" "}
        <span className="archer-reader-view-title">{props.readerTitle}</span>.
      </p>
      <button type="button" className="archer-reader-view-return" onClick={props.onReturn}>
        Back to the agent&apos;s view
      </button>
    </div>
  );
}
