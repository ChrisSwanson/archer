/**
 * One chip per named emphasis the agent has stored for the diagram on screen.
 *
 * Sits directly under the tab strip, so picking a diagram and picking a flow
 * through it are one continuous gesture rather than two controls in different
 * places. The tabs say WHICH diagram; this row says which claim about it.
 *
 * Clicking a chip applies that emphasis; clicking the active one dismisses it.
 * Dismissed is not deleted -- the chip stays, because the agent's stored list
 * is not the user's to edit by looking away from it.
 *
 * WEB SHELL ONLY. The MCP-App view is embedded in a host that does its own
 * navigation, so a second row of controls inside it competes with the host's.
 * The canvas emphasis and the legend do render there: those are what the agent
 * SAID, and the embedded view must not say less than the browser one.
 */
import type { JSX } from "react";
import { emphasisName, HIGHLIGHTS, type Emphasis } from "../emphasis/contract";

export type DataflowChipsProps = {
  /** The agent's stored list for the active view, oldest-first. */
  readonly emphases: readonly Emphasis[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
};

export function DataflowChips({ emphases, activeId, onSelect }: DataflowChipsProps): JSX.Element | null {
  // Nothing stored is not an error state and gets no empty rail, exactly as
  // the tab strip gets none when nothing is registered.
  if (emphases.length === 0) {
    return null;
  }

  return (
    <div className="archer-dataflows" role="group" aria-label={HIGHLIGHTS}>
      <span className="archer-dataflows-label" aria-hidden="true">
        {HIGHLIGHTS}
      </span>
      {emphases.map((emphasis) => (
        <button
          key={emphasis.id}
          type="button"
          className="archer-dataflow-chip"
          // `aria-pressed` rather than a selected-tab role: these are toggles,
          // and the row can legitimately have none of them pressed.
          aria-pressed={emphasis.id === activeId}
          onClick={() => onSelect(emphasis.id)}
        >
          {/* The agent's own words, rendered as text and never as markup; never the raw id. */}
          {emphasisName(emphasis)}
        </button>
      ))}
    </div>
  );
}
