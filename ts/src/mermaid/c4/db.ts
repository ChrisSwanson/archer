// Copies what Archer needs out of Mermaid's C4 database (internal API of
// mermaid 12.1.0, checked at run time; see flowchart/db.ts). Mermaid hands
// every C4 parse the same database object, so everything is copied out here,
// inside the parse's turn (engine.ts serializes parses).
//
// Text fields are `{ text }` records; a top-level element's boundary is the
// pseudo-boundary `global`, which is not copied.

import { call, drift, fields, optionalText, type Fields } from "../db-fields.ts";

export interface C4DbShape {
  alias: string;
  type: string;
  label: string;
  technology: string | undefined;
  description: string | undefined;
  boundary: string;
}

export interface C4DbBoundary {
  alias: string;
  type: string;
  label: string;
  parent: string;
}

export interface C4DbRel {
  type: string;
  from: string;
  to: string;
  label: string | undefined;
  technology: string | undefined;
  description: string | undefined;
}

export interface C4Data {
  type: string;
  title: string;
  shapes: C4DbShape[];
  boundaries: C4DbBoundary[];
  rels: C4DbRel[];
}

const DB = "c4";

/** The text of a `{ text }` field; undefined when the field is absent. */
function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  const record: Fields = fields(value, DB, "text field");
  const text = record["text"];
  return typeof text === "string" ? text : JSON.stringify(text);
}

function list(db: Fields, name: string): Fields[] {
  const value = call(db, DB, name);
  if (!Array.isArray(value)) throw drift(DB, `${name}() is not an array`);
  return value.map((item: unknown) => fields(item, DB, name));
}

export function readC4Db(db: unknown): C4Data {
  const c4 = fields(db, DB, "not an object");
  return {
    type: optionalText(call(c4, DB, "getC4Type")) ?? "",
    title: optionalText(call(c4, DB, "getTitle")) ?? "",
    shapes: list(c4, "getC4ShapeArray").map((shape) => ({
      alias: optionalText(shape["alias"]) ?? "",
      type: textOf(shape["typeC4Shape"]) ?? "",
      label: textOf(shape["label"]) ?? "",
      technology: textOf(shape["techn"]),
      description: textOf(shape["descr"]),
      boundary: optionalText(shape["parentBoundary"]) ?? "",
    })),
    boundaries: list(c4, "getBoundaries")
      .filter((boundary) => boundary["alias"] !== "global")
      .map((boundary) => ({
        alias: optionalText(boundary["alias"]) ?? "",
        type: textOf(boundary["type"]) ?? "",
        label: textOf(boundary["label"]) ?? "",
        parent: optionalText(boundary["parentBoundary"]) ?? "",
      })),
    rels: list(c4, "getRels").map((rel) => ({
      type: optionalText(rel["type"]) ?? "",
      from: optionalText(rel["from"]) ?? "",
      to: optionalText(rel["to"]) ?? "",
      label: textOf(rel["label"]),
      technology: textOf(rel["techn"]),
      description: textOf(rel["descr"]),
    })),
  };
}
