// The entity-relationship model (an `erDiagram` source).
//
// Elements and their stable IDs:
// - entities: the entity name as written (`CUSTOMER`, `CUSTOMER["Customer"]`).
//   Attributes belong to their entity and have no ID of their own.
// - relationships: Mermaid has no relationship ID syntax, so a
//   relationship's ID is its two ends, `<source>--<target>`, as written
//   left to right. A second relationship written between the same two
//   entities in the same order is refused, so no ordinal is ever needed.
//
// Cardinalities are given per end: `sourceCardinality` is the marker written
// beside the source entity (`||` in `A ||--o{ B`), `targetCardinality` the one
// beside the target. (Mermaid's own database stores them the other way round:
// its `cardA` is the target's end.)

import type { Direction } from "./graph.ts";
import type { StableId } from "./ids.ts";

export const CARDINALITIES = ["zero-or-one", "exactly-one", "zero-or-more", "one-or-more"] as const;
export type Cardinality = (typeof CARDINALITIES)[number];

export const ATTRIBUTE_KEYS = ["PK", "FK", "UK"] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export interface EntityAttribute {
  name: string;
  type: string;
  keys?: AttributeKey[];
  comment?: string | null;
}

export interface Entity {
  id: StableId;
  label: string;
  attributes: EntityAttribute[];
}

export interface Relationship {
  id: StableId;
  source: StableId;
  target: StableId;
  sourceCardinality: Cardinality;
  targetCardinality: Cardinality;
  /** `--` (identifying, a solid line) rather than `..` (non-identifying, dashed). */
  identifying: boolean;
  label?: string | null;
}

export interface EntityRelationship {
  type: "entity-relationship";
  direction?: Direction | null;
  entities: Entity[];
  relationships: Relationship[];
}
