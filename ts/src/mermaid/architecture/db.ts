// Copies what Archer needs out of Mermaid's architecture database (internal
// API of mermaid 12.1.0, checked at run time; see flowchart/db.ts). Mermaid
// parses this type with @mermaid-js/parser (Langium) and fills the database
// from its AST, so reading the database also reads what the parser read.

import { call, drift, fields, optionalText, type Fields } from "../db-fields.ts";

export interface ArchitectureDbNode {
  id: string;
  icon: string | undefined;
  title: string | undefined;
  in: string | undefined;
}

export interface ArchitectureDbEdge {
  lhsId: string;
  lhsDir: string;
  lhsInto: boolean;
  lhsGroup: boolean;
  rhsId: string;
  rhsDir: string;
  rhsInto: boolean;
  rhsGroup: boolean;
  title: string | undefined;
}

export interface ArchitectureData {
  title: string;
  groups: ArchitectureDbNode[];
  services: ArchitectureDbNode[];
  junctions: ArchitectureDbNode[];
  edges: ArchitectureDbEdge[];
}

const DB = "architecture";

function list(db: Fields, name: string): Fields[] {
  const value = call(db, DB, name);
  if (!Array.isArray(value)) throw drift(DB, `${name}() is not an array`);
  return value.map((item: unknown) => fields(item, DB, name));
}

function node(record: Fields): ArchitectureDbNode {
  return {
    id: optionalText(record["id"]) ?? "",
    icon: optionalText(record["icon"]),
    title: optionalText(record["title"]),
    in: optionalText(record["in"]),
  };
}

export function readArchitectureDb(db: unknown): ArchitectureData {
  const architecture = fields(db, DB, "not an object");
  return {
    title: optionalText(call(architecture, DB, "getDiagramTitle")) ?? "",
    groups: list(architecture, "getGroups").map(node),
    services: list(architecture, "getServices").map(node),
    junctions: list(architecture, "getJunctions").map(node),
    edges: list(architecture, "getEdges").map((edge) => ({
      lhsId: optionalText(edge["lhsId"]) ?? "",
      lhsDir: optionalText(edge["lhsDir"]) ?? "",
      lhsInto: edge["lhsInto"] === true,
      lhsGroup: edge["lhsGroup"] === true,
      rhsId: optionalText(edge["rhsId"]) ?? "",
      rhsDir: optionalText(edge["rhsDir"]) ?? "",
      rhsInto: edge["rhsInto"] === true,
      rhsGroup: edge["rhsGroup"] === true,
      title: optionalText(edge["title"]),
    })),
  };
}
