// The diagram envelope: the wire contract between Archer and the page
// (schema/diagram-envelope.schema.json).

import type { ServiceArchitecture } from "./architecture.ts";
import type { C4Model } from "./c4.ts";
import type { EntityRelationship } from "./er.ts";
import type { GraphModel } from "./graph.ts";
import type { StableId } from "./ids.ts";
import type { UserJourney } from "./journey.ts";
import type { SequenceTrace } from "./sequence.ts";
import type { StateMachine } from "./state.ts";

export const SCHEMA_VERSION = 2;

export type DiagramModel =
  | GraphModel
  | SequenceTrace
  | StateMachine
  | EntityRelationship
  | C4Model
  | ServiceArchitecture
  | UserJourney;

export type DiagramModelType = DiagramModel["type"];

export const DIAGRAM_KINDS = [
  "c4-context",
  "c4-container",
  "c4-component",
  "c4-code",
  "data-flow",
  "sequence",
  "freeform",
  "state",
  "entity-relationship",
  "c4",
  "architecture",
  "journey",
] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

export interface ViewMetadata {
  id: StableId;
  kind: DiagramKind;
  title: string;
  summary?: string | null;
}

/** `sha256:` and 64 lowercase hex digits, over the exact source bytes. */
export type Revision = `sha256:${string}`;

export interface DiagramEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  view: ViewMetadata;
  revision: Revision;
  model: DiagramModel;
}
