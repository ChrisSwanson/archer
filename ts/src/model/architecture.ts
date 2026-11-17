import type { EdgeLine, LineKeyEntry } from "./graph.ts";
// The service-architecture model (an `architecture-beta` source).
//
// Elements and their stable IDs:
// - groups, services and junctions: the ID written after the keyword
//   (`group api(cloud)[API]`, `service db(database)[Database]`,
//   `junction j1`). They share one namespace, as they do in Mermaid.
// - edges: Mermaid has no edge ID syntax, so an edge's ID is its two ends,
//   `<source>--<target>`, as written left to right. A second edge written
//   between the same two ends in the same order is refused, so no ordinal
//   is ever needed.

import type { StableId } from "./ids.ts";

/** Mermaid's built-in icons; icon packs (`logos:aws-s3`) are not drawn by Archer. */
export const ARCHITECTURE_ICONS = ["cloud", "database", "disk", "internet", "server"] as const;
export type ArchitectureIcon = (typeof ARCHITECTURE_ICONS)[number];

/** The side of an element an edge leaves or enters by: `L`, `R`, `T`, `B`. */
export const ARCHITECTURE_SIDES = ["left", "right", "top", "bottom"] as const;
export type ArchitectureSide = (typeof ARCHITECTURE_SIDES)[number];

export interface ArchitectureGroup {
  id: StableId;
  label: string;
  icon?: ArchitectureIcon | null;
  parentId?: StableId | null;
}

export interface ArchitectureService {
  id: StableId;
  label: string;
  icon?: ArchitectureIcon | null;
  groupId?: StableId | null;
}

export interface ArchitectureJunction {
  id: StableId;
  groupId?: StableId | null;
}

export interface ArchitectureEdge {
  id: StableId;
  /** A service or junction. */
  source: StableId;
  target: StableId;
  sourceSide: ArchitectureSide;
  targetSide: ArchitectureSide;
  /** An arrowhead at the source end (`<--`). Absent means false. */
  sourceArrow?: boolean;
  targetArrow?: boolean;
  /** `{group}`: the edge meets the boundary of the source's group. Absent means false. */
  sourceGroup?: boolean;
  targetGroup?: boolean;
  label?: string | null;
  /** A pattern its author gave it with `%% archer-line` (ADR 0030); absent means solid. */
  line?: EdgeLine;
}

export interface ServiceArchitecture {
  type: "service-architecture";
  title?: string | null;
  groups: ArchitectureGroup[];
  services: ArchitectureService[];
  junctions: ArchitectureJunction[];
  edges: ArchitectureEdge[];
  /** What its line patterns mean, in the author's words (`%% archer-key`). */
  lineKey?: LineKeyEntry[];
}
