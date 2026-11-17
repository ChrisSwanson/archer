import type { EdgeLine, LineKeyEntry } from "./graph.ts";
// The C4 model (Mermaid's native `C4Context`, `C4Container` and
// `C4Component` diagrams).
//
// Elements and their stable IDs:
// - elements (`Person`, `System`, `Container`, `Component` and their `_Ext`,
//   `Db` and `Queue` variants): the alias, the first argument
//   (`Person(customer, "Customer")`).
// - boundaries (`Enterprise_Boundary`, `System_Boundary`,
//   `Container_Boundary`, `Boundary`): the alias, likewise.
// - relationships (`Rel`, `BiRel`): Mermaid has no relationship ID syntax,
//   so a relationship's ID is its two ends, `<source>--<target>`, as written.
//   A second relationship written between the same two aliases in the same
//   order is refused, so no ordinal is ever needed.
//
// Elements and boundaries share one namespace, as they do in Mermaid.

import type { StableId } from "./ids.ts";

export const C4_LEVELS = ["context", "container", "component"] as const;
export type C4Level = (typeof C4_LEVELS)[number];

export const C4_ELEMENT_KINDS = ["person", "system", "container", "component"] as const;
export type C4ElementKind = (typeof C4_ELEMENT_KINDS)[number];

/** `Db` and `Queue` variants; absent means the plain box (or the person figure). */
export const C4_ELEMENT_SHAPES = ["database", "queue"] as const;
export type C4ElementShape = (typeof C4_ELEMENT_SHAPES)[number];

export const C4_BOUNDARY_KINDS = ["enterprise", "system", "container", "generic"] as const;
export type C4BoundaryKind = (typeof C4_BOUNDARY_KINDS)[number];

export interface C4Element {
  id: StableId;
  kind: C4ElementKind;
  label: string;
  /** An `_Ext` element: outside the scope of the diagram. Absent means false. */
  external?: boolean;
  shape?: C4ElementShape;
  technology?: string | null;
  description?: string | null;
  /** The boundary the element is written inside; absent at the top level. */
  boundaryId?: StableId | null;
}

export interface C4Boundary {
  id: StableId;
  kind: C4BoundaryKind;
  label: string;
  parentId?: StableId | null;
}

export interface C4Relationship {
  id: StableId;
  source: StableId;
  target: StableId;
  label?: string | null;
  technology?: string | null;
  description?: string | null;
  /** `BiRel`: drawn with an arrowhead at both ends. Absent means false. */
  bidirectional?: boolean;
  /** A pattern its author gave it with `%% archer-line` (ADR 0030); absent means solid. */
  line?: EdgeLine;
}

export interface C4Model {
  type: "c4-model";
  level: C4Level;
  title?: string | null;
  elements: C4Element[];
  boundaries: C4Boundary[];
  relationships: C4Relationship[];
  /** What its line patterns mean, in the author's words (`%% archer-key`). */
  lineKey?: LineKeyEntry[];
}
