// Mermaid's reading of a C4 diagram, held to the scan's and turned into the
// C4 model. Mermaid's C4 grammar is lenient and its database silently keeps
// only some of what is written, so every element, boundary and relationship
// is compared field by field with what the scan read, and any difference is
// refused.

import type { C4Boundary, C4Element, C4Model, C4Relationship } from "../../model/index.ts";
import { error, isError, type Diagnostic, type Span } from "../diagnostics.ts";
import { restoreEntities } from "../entities.ts";
import { readLabel } from "../labels.ts";
import type { C4Data } from "./db.ts";
import type { C4Scan, ScannedText } from "./scan.ts";

export interface Adapted {
  model: C4Model | undefined;
  diagnostics: Diagnostic[];
}

export function adaptC4(data: C4Data, scan: C4Scan, fallback: Span): Adapted {
  const diagnostics: Diagnostic[] = [];
  const disagree = (what: string, at: Span = fallback) =>
    diagnostics.push(
      error(
        "parser_disagreement",
        `Mermaid reads ${what}; rewrite the statement that holds it plainly, one statement per line`,
        at,
      ),
    );
  /** Mermaid's text for a field, checked against the scan's; the label to keep, or undefined for none. */
  const text = (where: string, mermaid: string | undefined, written: ScannedText | undefined): string | undefined => {
    const read = restoreEntities(mermaid ?? "");
    if (read !== (written?.text ?? "")) {
      disagree(`the ${where} as '${read}'`, written?.span);
      return undefined;
    }
    if (written === undefined || read.trim() === "") return undefined;
    const { label, problems } = readLabel(read.trim(), written.span);
    diagnostics.push(...problems);
    return label;
  };

  if (scan.level === undefined) return { model: undefined, diagnostics };

  const shapes = new Map(data.shapes.map((shape) => [shape.alias, shape]));
  if (shapes.size !== data.shapes.length || data.shapes.length !== scan.elements.length) {
    disagree(`${data.shapes.length} elements, not the ${scan.elements.length} written`);
  }
  const elements: C4Element[] = [];
  for (const scanned of scan.elements) {
    const shape = shapes.get(scanned.id);
    if (shape === undefined) {
      disagree(`no element '${scanned.id}'`, scanned.span);
      continue;
    }
    if (shape.type !== scanned.mermaidType) disagree(`'${scanned.id}' as a ${shape.type}`, scanned.span);
    if (shape.boundary !== (scanned.boundary ?? "global"))
      disagree(`'${scanned.id}' inside '${shape.boundary}'`, scanned.span);
    const element: C4Element = {
      id: scanned.id,
      kind: scanned.kind,
      label: text(`label of '${scanned.id}'`, shape.label, scanned.label) ?? "",
    };
    if (scanned.external) element.external = true;
    if (scanned.shape !== undefined) element.shape = scanned.shape;
    const technology = text(`technology of '${scanned.id}'`, shape.technology, scanned.technology);
    if (technology !== undefined) element.technology = technology;
    const description = text(`description of '${scanned.id}'`, shape.description, scanned.description);
    if (description !== undefined) element.description = description;
    if (scanned.boundary !== undefined) element.boundaryId = scanned.boundary;
    elements.push(element);
  }

  const found = new Map(data.boundaries.map((boundary) => [boundary.alias, boundary]));
  if (data.boundaries.length !== scan.boundaries.length) {
    disagree(`${data.boundaries.length} boundaries, not the ${scan.boundaries.length} written`);
  }
  const boundaries: C4Boundary[] = [];
  for (const scanned of scan.boundaries) {
    const boundary = found.get(scanned.id);
    if (boundary === undefined) {
      disagree(`no boundary '${scanned.id}'`, scanned.span);
      continue;
    }
    const expected = { enterprise: "ENTERPRISE", system: "SYSTEM", container: "CONTAINER", generic: "system" }[
      scanned.kind
    ];
    if (boundary.type !== expected) disagree(`'${scanned.id}' as a ${boundary.type} boundary`, scanned.span);
    if (boundary.parent !== (scanned.parent ?? "global"))
      disagree(`'${scanned.id}' inside '${boundary.parent}'`, scanned.span);
    const model: C4Boundary = {
      id: scanned.id,
      kind: scanned.kind,
      label: text(`label of '${scanned.id}'`, boundary.label, scanned.label) ?? "",
    };
    if (scanned.parent !== undefined) model.parentId = scanned.parent;
    boundaries.push(model);
  }

  if (data.rels.length !== scan.relationships.length) {
    disagree(`${data.rels.length} relationships, not the ${scan.relationships.length} written`);
  }
  const relationships: C4Relationship[] = [];
  scan.relationships.forEach((scanned, index) => {
    const rel = data.rels[index];
    if (rel === undefined) return;
    if (rel.from !== scanned.source || rel.to !== scanned.target || rel.type !== scanned.mermaidType) {
      disagree(`this relationship as ${rel.type} from '${rel.from}' to '${rel.to}'`, scanned.span);
      return;
    }
    const model: C4Relationship = { id: scanned.id, source: scanned.source, target: scanned.target };
    const label = text("relationship's label", rel.label, scanned.label);
    if (label !== undefined) model.label = label;
    const technology = text("relationship's technology", rel.technology, scanned.technology);
    if (technology !== undefined) model.technology = technology;
    const description = text("relationship's description", rel.description, scanned.description);
    if (description !== undefined) model.description = description;
    if (scanned.bidirectional) model.bidirectional = true;
    relationships.push(model);
  });

  // Mermaid keeps the spaces around a title; the scan trims them.
  const title = text("title", data.title.trim(), scan.title);
  if (diagnostics.some(isError)) return { model: undefined, diagnostics };
  const model: C4Model = { type: "c4-model", level: scan.level, elements, boundaries, relationships };
  if (title !== undefined) model.title = title;
  return { model: { ...reorder(model) }, diagnostics };
}

/** The model's fields in the order the wire shows them: title before the lists. */
function reorder(model: C4Model): C4Model {
  const { type, level, title, elements, boundaries, relationships } = model;
  return title === undefined
    ? { type, level, elements, boundaries, relationships }
    : { type, level, title, elements, boundaries, relationships };
}
