// Copies what Archer needs out of Mermaid's flowchart database.
//
// None of these getters is public Mermaid API (research 01): the database is
// read through the shape mermaid 12.1.0 has, checked at run time, and a
// version that changes it fails loudly here rather than yielding a wrong
// model. The golden fixtures pin the shape on every Mermaid bump.

import { call, drift, fields, optionalText, texts, type Fields } from "../db-fields.ts";

export interface FlowVertex {
  id: string;
  text: string;
  /** Mermaid's shape name; absent when the node was never given a shape. */
  type: string | undefined;
  labelType: string;
  classes: string[];
}

export interface FlowEdge {
  id: string;
  userDefinedId: boolean;
  start: string;
  end: string;
  /** `arrow_point`, `arrow_open`, `arrow_cross`, `arrow_circle`, `double_arrow_point`, ... */
  type: string;
  /** `normal`, `dotted`, `thick` or `invisible`. */
  stroke: string;
  text: string;
  labelType: string;
}

export interface FlowSubgraph {
  id: string;
  title: string;
  labelType: string;
  /** Node IDs and nested subgraph IDs, as Mermaid assigned them. */
  members: string[];
}

export interface FlowData {
  direction: string;
  vertices: FlowVertex[];
  edges: FlowEdge[];
  subgraphs: FlowSubgraph[];
}

const DB = "flowchart";

function record(value: unknown, what: string): Fields {
  return fields(value, DB, what);
}

function text(value: unknown): string {
  return optionalText(value) ?? "";
}

export function readFlowDb(db: unknown): FlowData {
  const flow = record(db, "not an object");
  const vertices = call(flow, DB, "getVertices");
  if (!(vertices instanceof Map)) throw drift(DB, "getVertices() is not a Map");
  const edges = call(flow, DB, "getEdges");
  const subgraphs = call(flow, DB, "getSubGraphs");
  if (!Array.isArray(edges) || !Array.isArray(subgraphs)) throw drift(DB, "edges or subgraphs not arrays");
  return {
    direction: text(call(flow, DB, "getDirection")),
    vertices: [...vertices.values()].map((value: unknown) => {
      const vertex = record(value, "vertex");
      return {
        id: text(vertex["id"]),
        text: text(vertex["text"]),
        type: typeof vertex["type"] === "string" ? vertex["type"] : undefined,
        labelType: text(vertex["labelType"]),
        classes: texts(vertex["classes"]),
      };
    }),
    edges: edges.map((value: unknown) => {
      const edge = record(value, "edge");
      return {
        id: text(edge["id"]),
        userDefinedId: edge["isUserDefinedId"] === true,
        start: text(edge["start"]),
        end: text(edge["end"]),
        type: text(edge["type"]),
        stroke: text(edge["stroke"]),
        text: text(edge["text"]),
        labelType: text(edge["labelType"]),
      };
    }),
    subgraphs: subgraphs.map((value: unknown) => {
      const subgraph = record(value, "subgraph");
      return {
        id: text(subgraph["id"]),
        title: text(subgraph["title"]),
        labelType: text(subgraph["labelType"]),
        members: texts(subgraph["nodes"]),
      };
    }),
  };
}
