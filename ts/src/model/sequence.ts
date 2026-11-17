// The sequence model of the envelope (schemaVersion 2): an ordered trace, not
// a graph. Ordering is preserved and fragments nest.

import type { StableId } from "./ids.ts";

/** Absent means `participant`. */
export const PARTICIPANT_KINDS = ["participant", "actor"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

export interface Participant {
  id: StableId;
  label: string;
  kind?: ParticipantKind;
}

/** `->>` is sync, `-->>` is reply, `-)` is async. */
export const MESSAGE_KINDS = ["sync", "reply", "async"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const FRAGMENT_KINDS = ["loop", "alt", "opt", "par"] as const;
export type FragmentKind = (typeof FRAGMENT_KINDS)[number];

export const NOTE_POSITIONS = ["left-of", "right-of", "over"] as const;
export type NotePosition = (typeof NOTE_POSITIONS)[number];

export interface MessageEvent {
  type: "message";
  id: StableId;
  from: StableId;
  to: StableId;
  label?: string | null;
  kind: MessageKind;
  /** An arrowhead at each end (`<<->>` is sync, `<<-->>` reply). Absent means false. */
  bidirectional?: boolean;
}

export interface FragmentSection {
  label?: string | null;
  events: SequenceEvent[];
}

export interface FragmentEvent {
  type: "fragment";
  id: StableId;
  kind: FragmentKind;
  label: string;
  sections: FragmentSection[];
}

export interface NoteEvent {
  type: "note";
  id: StableId;
  position: NotePosition;
  participants: StableId[];
  text: string;
}

export interface ActivateEvent {
  type: "activate";
  participant: StableId;
}

export interface DeactivateEvent {
  type: "deactivate";
  participant: StableId;
}

export type SequenceEvent = MessageEvent | FragmentEvent | NoteEvent | ActivateEvent | DeactivateEvent;

export interface SequenceTrace {
  type: "sequence-trace";
  participants: Participant[];
  events: SequenceEvent[];
  autonumber?: boolean;
}
