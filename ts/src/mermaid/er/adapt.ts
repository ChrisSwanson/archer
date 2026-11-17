// Mermaid's reading of an ER diagram, held to the scan's and turned into the
// entity-relationship model. Order and positions come from the scan; labels,
// attributes and cardinalities come from Mermaid, and wherever the two
// disagree the source is refused.

import type {
  AttributeKey,
  Cardinality,
  Entity,
  EntityAttribute,
  EntityRelationship,
  Relationship,
} from "../../model/index.ts";
import { error, isError, type Diagnostic, type Span } from "../diagnostics.ts";
import { restoreEntities } from "../entities.ts";
import { readLabel } from "../labels.ts";
import type { ErData } from "./db.ts";
import type { ErScan } from "./scan.ts";

const CARDINALITIES: Record<string, Cardinality> = {
  ZERO_OR_ONE: "zero-or-one",
  ONLY_ONE: "exactly-one",
  ZERO_OR_MORE: "zero-or-more",
  ONE_OR_MORE: "one-or-more",
};

export interface Adapted {
  model: EntityRelationship | undefined;
  diagnostics: Diagnostic[];
}

export function adaptEr(data: ErData, scan: ErScan, fallback: Span): Adapted {
  const diagnostics: Diagnostic[] = [];
  const disagree = (what: string, at: Span = fallback) =>
    diagnostics.push(
      error(
        "parser_disagreement",
        `Mermaid reads ${what}; rewrite the statement that holds it plainly, one statement per line`,
        at,
      ),
    );
  const label = (raw: string, at: Span): string => {
    const { label: text, problems } = readLabel(restoreEntities(raw).trim(), at);
    diagnostics.push(...problems);
    return text;
  };

  const byName = new Map(data.entities.map((entity) => [entity.name, entity]));
  const names = new Map(data.entities.map((entity) => [entity.internalId, entity.name]));
  const entities: Entity[] = [];
  for (const scanned of scan.entities) {
    const found = byName.get(scanned.id);
    if (found === undefined) {
      disagree(`no entity '${scanned.id}'`, scanned.span);
      continue;
    }
    if ((found.alias !== "") !== (scanned.labelSpan !== undefined))
      disagree(`a different label for '${scanned.id}'`, scanned.span);
    const attributes: EntityAttribute[] = [];
    if (found.attributes.length !== scanned.attributes.length) {
      disagree(
        `${found.attributes.length} attributes on '${scanned.id}', not the ${scanned.attributes.length} written`,
        scanned.span,
      );
    }
    found.attributes.forEach((attribute, index) => {
      const written = scanned.attributes[index];
      if (written === undefined) return;
      const keys = attribute.keys;
      if (
        attribute.name !== written.name ||
        attribute.type !== written.type ||
        keys.join(",") !== written.keys.join(",")
      ) {
        disagree(`the attribute '${written.name}' of '${scanned.id}' otherwise`, written.span);
        return;
      }
      const model: EntityAttribute = {
        name: label(attribute.name, written.span),
        type: label(attribute.type, written.span),
      };
      if (keys.length > 0) model.keys = keys as AttributeKey[];
      if (attribute.comment !== "") model.comment = label(attribute.comment, written.commentSpan ?? written.span);
      attributes.push(model);
    });
    entities.push({
      id: scanned.id,
      label: found.alias === "" ? scanned.id : label(found.alias, scanned.labelSpan ?? scanned.span),
      attributes,
    });
  }
  if (data.entities.length !== scan.entities.length) {
    const written = new Set(scan.entities.map((entity) => entity.id));
    for (const entity of data.entities)
      if (!written.has(entity.name)) disagree(`an entity '${entity.name}' that is not written as one`);
  }

  const relationships: Relationship[] = [];
  // Mermaid reads every relationship written, a repeated one included; the repeat is checked and left out.
  const written = [...scan.relationships, ...scan.ignored].sort((a, b) => a.line.number - b.line.number);
  const ignored = new Set(scan.ignored);
  if (data.relationships.length !== written.length) {
    disagree(`${data.relationships.length} relationships, not the ${written.length} written`);
  }
  written.forEach((scanned, index) => {
    const found = data.relationships[index];
    if (found === undefined) return;
    const source = names.get(found.entityA);
    const target = names.get(found.entityB);
    const sourceCardinality = CARDINALITIES[found.cardB];
    const targetCardinality = CARDINALITIES[found.cardA];
    if (
      source !== scanned.source ||
      target !== scanned.target ||
      sourceCardinality !== scanned.sourceCardinality ||
      targetCardinality !== scanned.targetCardinality ||
      (found.relType === "IDENTIFYING") !== scanned.identifying
    ) {
      disagree(`this relationship otherwise (${source ?? "?"} to ${target ?? "?"})`, scanned.span);
      return;
    }
    const model: Relationship = {
      id: scanned.id,
      source: scanned.source,
      target: scanned.target,
      sourceCardinality: scanned.sourceCardinality,
      targetCardinality: scanned.targetCardinality,
      identifying: scanned.identifying,
    };
    const text = label(found.roleA, scanned.labelSpan);
    if (text !== "") model.label = text;
    if (!ignored.has(scanned)) relationships.push(model);
  });

  if (diagnostics.some(isError)) return { model: undefined, diagnostics };
  const model: EntityRelationship = { type: "entity-relationship", entities, relationships };
  if (scan.direction !== undefined) {
    if (data.direction.toLowerCase() !== scan.direction) disagree(`the direction as ${data.direction}`);
    model.direction = scan.direction;
  }
  return diagnostics.some(isError) ? { model: undefined, diagnostics } : { model, diagnostics };
}
