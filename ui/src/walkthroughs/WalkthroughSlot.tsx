/**
 * The open walkthrough as the side panel's top section (0.6.4, D5; ADR 0034 §6): picker, status, the
 * Steps / Sequence tabs and the transport, with the ✕ that leaves Walkthrough mode. Where it sits (beside
 * the drawing, or in the phone's sheet) is the panel's business (`app/diagram-panel.tsx`), which renders it
 * twice: as the panel's section, and as the mode's part (the step keys and the one spoken step), which stays
 * mounted while the panel is collapsed or the sheet folded (`DiagramPanelPart`). One module, loaded when
 * first needed (`deferredComponent`), with its stylesheet.
 */
import { useContext, type JSX } from "react";
import { DiagramPanelPart } from "../app/panel-context";
import type { StepBadge } from "../comments/walk-anchors";
import { SequenceTab } from "./SequenceTab";
import { hasMessages } from "./walk-sequence";
import {
  WalkLive,
  WalkModeKeys,
  WalkTransport,
  WalkthroughPanel,
  type Go,
  type WalkNoteLink,
} from "./WalkthroughPanel";
import type { Presented } from "./use-walk-steering";
import type { Walkthroughs } from "./use-walkthroughs";
import "./walkthroughs.css";

export function WalkthroughSurface({
  walkthroughs,
  revision,
  changedAt,
  presented,
  onClose,
  noteLink,
}: {
  readonly walkthroughs: Walkthroughs;
  readonly revision?: string;
  readonly changedAt?: string;
  readonly presented?: Presented | null;
  /** Leave Walkthrough mode (`DiagramModes.exit`). */
  readonly onClose: () => void;
  /** The link to a walkthrough's related note (its folder-relative path), or null when the page cannot open it. */
  readonly noteLink?: (path: string) => WalkNoteLink | null;
}): JSX.Element | null {
  const { walks, state, walk, labelOf, dispatch, select, togglePlay, old, openOld, backToCurrent } = walkthroughs;
  const part = useContext(DiagramPanelPart);
  if (!state.open) return null;
  const go = (to: Go): void => dispatch({ type: "go", to });
  if (part === "mode") {
    return (
      <>
        <WalkModeKeys stepping={walk !== null && walk.status !== "archived"} onGo={go} onTogglePlay={togglePlay} />
        <WalkLive walks={walks} state={state} labelOf={labelOf} />
      </>
    );
  }
  return (
    <WalkthroughPanel
      standalone={part === null}
      walks={walks}
      state={state}
      labelOf={labelOf}
      presented={presented}
      old={old}
      note={walk?.note === undefined || noteLink === undefined ? null : noteLink(walk.note)}
      onOpenOld={openOld}
      onBackToCurrent={backToCurrent}
      {...(revision === undefined ? {} : { revision })}
      {...(changedAt === undefined ? {} : { changedAt })}
      onSelect={(id: string) => select(id)}
      onClose={onClose}
      onGo={go}
      onTogglePlay={togglePlay}
      // The Sequence tab, when some step has a message to draw (ADR 0034 §6).
      {...(walk !== null && hasMessages(walk)
        ? {
            sequence: (badges: ReadonlyMap<string, StepBadge>) => (
              <SequenceTab walk={walk} step={state.step} labelOf={labelOf} badges={badges} onGo={go} />
            ),
          }
        : {})}
      transport={<WalkTransport walks={walks} state={state} onGo={go} onTogglePlay={togglePlay} />}
    />
  );
}

/** Under the drawing on a phone, for when the sheet is closed: first, previous, Play, next, last, and a scrubber. */
export function WalkthroughTransport({ walkthroughs }: { readonly walkthroughs: Walkthroughs }): JSX.Element | null {
  const { walks, state, dispatch, togglePlay } = walkthroughs;
  return state.open ? (
    <WalkTransport walks={walks} state={state} onGo={(to) => dispatch({ type: "go", to })} onTogglePlay={togglePlay} />
  ) : null;
}
