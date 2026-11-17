// Copies what Archer needs out of Mermaid's state database: the flattened
// nodes and edges of `getData()`, which is what Mermaid draws (internal API of
// mermaid 12.1.0, checked at run time; see flowchart/db.ts). `getStates()` is
// not used: it lists only the top level, and a state named both inside and
// outside a composite appears in it at the wrong level.

import { call, drift, fields, optionalText, type Fields } from "../db-fields.ts";

export interface StateDbNode {
  id: string;
  /** `rect`, `roundedWithTitle`, `stateStart`, `stateEnd`, `choice`, `fork`, `join`, `note`, `noteGroup`, ... */
  shape: string;
  label: string;
  parentId: string | undefined;
  /** For a note: `left of` or `right of`. */
  position: string | undefined;
}

export interface StateDbEdge {
  start: string;
  end: string;
  label: string;
}

export interface StateData {
  nodes: StateDbNode[];
  edges: StateDbEdge[];
}

const DB = "state";

export function readStateDb(db: unknown): StateData {
  const state = fields(db, DB, "not an object");
  const data = fields(call(state, DB, "getData"), DB, "getData()");
  const nodes = data["nodes"];
  const edges = data["edges"];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw drift(DB, "getData() nodes or edges not arrays");
  return {
    nodes: nodes.map((value: unknown) => {
      const node: Fields = fields(value, DB, "node");
      const id = optionalText(node["id"]);
      if (id === undefined) throw drift(DB, "a node without an id");
      return {
        id,
        shape: optionalText(node["shape"]) ?? "",
        label: optionalText(node["label"]) ?? "",
        parentId: optionalText(node["parentId"]),
        position: optionalText(node["position"]),
      };
    }),
    edges: edges.map((value: unknown) => {
      const edge: Fields = fields(value, DB, "edge");
      return {
        start: optionalText(edge["start"]) ?? "",
        end: optionalText(edge["end"]) ?? "",
        label: optionalText(edge["label"]) ?? "",
      };
    }),
  };
}
