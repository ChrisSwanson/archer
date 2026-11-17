import type { EdgeLine, LineKeyEntry } from "./graph.ts";
// The state-machine model (a `stateDiagram-v2` source).
//
// Elements and their stable IDs:
// - states: the Mermaid state ID as written (`Idle`, `state "Waiting" as
//   Idle`). A composite state (`state Busy { ... }`) is a state whose children
//   name it as `parentId`.
// - initial and final pseudo-states: `[*]`, one of each per scope, with the
//   ID Mermaid gives them: `root_start`/`root_end` at the top level,
//   `<composite>_start`/`<composite>_end` inside a composite.
// - transitions: Mermaid has no transition ID syntax, so a transition's ID is
//   its two ends, `<source>--<target>` (state IDs cannot hold `-`). It changes
//   only when an end is renamed; a second transition between the same two
//   states is refused, so no ordinal is ever needed.
// - a note belongs to the state it is attached to; it has no ID of its own.

import type { Direction } from "./graph.ts";
import type { StableId } from "./ids.ts";

/** Absent means `state`. */
export const STATE_KINDS = ["state", "initial", "final", "choice", "fork", "join"] as const;
export type StateKind = (typeof STATE_KINDS)[number];

export const STATE_NOTE_POSITIONS = ["left-of", "right-of"] as const;
export type StateNotePosition = (typeof STATE_NOTE_POSITIONS)[number];

export interface StateNote {
  position: StateNotePosition;
  text: string;
}

export interface StateNode {
  id: StableId;
  label: string;
  kind?: StateKind;
  /** The composite state this one is inside; absent at the top level. */
  parentId?: StableId | null;
  note?: StateNote | null;
}

export interface StateTransition {
  id: StableId;
  source: StableId;
  target: StableId;
  label?: string | null;
  /** A pattern its author gave it with `%% archer-line` (ADR 0030); absent means solid. */
  line?: EdgeLine;
}

export interface StateMachine {
  type: "state-machine";
  direction?: Direction | null;
  states: StateNode[];
  transitions: StateTransition[];
  /** What its line patterns mean, in the author's words (`%% archer-key`). */
  lineKey?: LineKeyEntry[];
}
