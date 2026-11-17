// The graph models of the envelope (schema/diagram-envelope.schema.json,
// schemaVersion 2). Field names, optionality and enums follow the schema
// exactly; `null` is allowed wherever the schema allows it, though the
// compiler leaves a field out rather than writing null.

import type { StableId } from "./ids.ts";

/** The flow direction the source declared in its header. Absent means `tb`. */
export const DIRECTIONS = ["tb", "bt", "lr", "rl"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * How an edge's line is drawn: `-->`, `-.->` or `==>`, a flowchart edge class
 * `dashed` or `dashdot`, or `%% archer-line` elsewhere (ADR 0030). Absent means `solid`.
 */
export const EDGE_LINES = ["solid", "dotted", "thick", "dashed", "dashdot"] as const;
export type EdgeLine = (typeof EDGE_LINES)[number];

/** The patterns a diagram's author may give a meaning to (`%% archer-key`). */
export const KEY_PATTERNS = ["dotted", "dashed", "dashdot", "thick"] as const;
export type KeyPattern = (typeof KEY_PATTERNS)[number];
/** What a pattern means here, in the author's words; Archer never supplies one. */
export interface LineKeyEntry {
  pattern: KeyPattern;
  meaning: string;
}

export const NODE_SHAPES = [
  "rectangle",
  "rounded",
  "stadium",
  "circle",
  "diamond",
  "cylinder",
  "hexagon",
  "subroutine",
] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

export interface GraphNode {
  id: StableId;
  label: string;
  shape?: NodeShape | null;
  classes?: string[];
  groupId?: StableId | null;
}

export interface GraphEdge {
  id: StableId;
  source: StableId;
  target: StableId;
  label?: string | null;
  line?: EdgeLine;
  /** An arrowhead at each end (`<-->`, `<-.->`, `<==>`). Absent means false: one arrowhead, at the target. */
  bidirectional?: boolean;
}

export interface GraphGroup {
  id: StableId;
  label: string;
  parentId?: StableId | null;
  /** Its kind or authored category (`class groupId name`), as a node's: at most one. */
  classes?: string[];
}

/**
 * An authored `classDef` category a node or group wears (ADR 0009, amended 2026-11-11): its name and what it
 * declares to draw. The page chooses the palette family nearest the declared colour; the hex is never drawn as
 * written. `fill` and `stroke` are lowercase `#rrggbb`, present only when the declaration was a readable opaque
 * colour; `dashed` only when it declares a `stroke-dasharray`.
 */
export interface GraphCategory {
  name: string;
  fill?: string;
  stroke?: string;
  dashed?: boolean;
  /**
   * What the category means, in the author's words (`%% archer-key <name>: <meaning>`): what the Key and the
   * drawing's legend call it. Absent when the author said nothing; the page then uses the name as written.
   */
  meaning?: string;
}

/** The three graph models share one shape and differ only in their tag. */
export type GraphModelType = "architecture-graph" | "data-flow-graph" | "freeform-graph";

export interface GraphModel<T extends GraphModelType = GraphModelType> {
  type: T;
  direction?: Direction | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
  lineKey?: LineKeyEntry[];
  /** The authored categories in use, in declaration order. Absent when none is used. */
  categories?: GraphCategory[];
  /**
   * The order the source writes things in, which the id-sorted lists above lose: node and group ids by where each
   * is first written (a node's first mention, a group's `subgraph` line), and edge ids as written. For the
   * layout's model order and the Key's rows; never a colour's input. A flowchart always carries it.
   */
  sourceOrder?: GraphSourceOrder;
}

/** Where things are written in the source (`GraphModel.sourceOrder`). */
export interface GraphSourceOrder {
  /** Nodes and groups, interleaved as written. Tagged: a subgraph may share its id with a node. */
  elements: SourceElement[];
  edges: string[];
}

export interface SourceElement {
  id: string;
  kind: "node" | "group";
}

export type FreeformGraph = GraphModel<"freeform-graph">;
