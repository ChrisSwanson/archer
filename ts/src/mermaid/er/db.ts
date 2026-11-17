// Copies what Archer needs out of Mermaid's ER database (internal API of
// mermaid 12.1.0, checked at run time; see flowchart/db.ts).
//
// `getEntities()` is a Map from the entity's name to a record whose `id` is
// Mermaid's own (`entity-NAME-0`); relationships name entities by that id.
// A relationship's `cardA` is the marker beside its SECOND entity and `cardB`
// the one beside its first.

import { call, drift, fields, optionalText, texts, type Fields } from "../db-fields.ts";

export interface ErDbAttribute {
  type: string;
  name: string;
  keys: string[];
  comment: string;
}

export interface ErDbEntity {
  name: string;
  /** Mermaid's internal id, which relationships use. */
  internalId: string;
  alias: string;
  attributes: ErDbAttribute[];
}

export interface ErDbRelationship {
  entityA: string;
  entityB: string;
  roleA: string;
  cardA: string;
  cardB: string;
  relType: string;
}

export interface ErData {
  direction: string;
  entities: ErDbEntity[];
  relationships: ErDbRelationship[];
}

const DB = "er";

const text = (value: unknown): string => optionalText(value) ?? "";

export function readErDb(db: unknown): ErData {
  const er = fields(db, DB, "not an object");
  const entities = call(er, DB, "getEntities");
  const relationships = call(er, DB, "getRelationships");
  if (!(entities instanceof Map) || !Array.isArray(relationships))
    throw drift(DB, "getEntities() or getRelationships()");
  return {
    direction: text(call(er, DB, "getDirection")),
    entities: [...entities.entries()].map(([name, value]: [unknown, unknown]) => {
      const entity: Fields = fields(value, DB, "entity");
      const attributes = entity["attributes"];
      if (!Array.isArray(attributes)) throw drift(DB, "entity attributes");
      return {
        name: text(name),
        internalId: text(entity["id"]),
        alias: text(entity["alias"]),
        attributes: attributes.map((item: unknown) => {
          const attribute: Fields = fields(item, DB, "attribute");
          return {
            type: text(attribute["type"]),
            name: text(attribute["name"]),
            keys: texts(attribute["keys"]),
            comment: text(attribute["comment"]),
          };
        }),
      };
    }),
    relationships: relationships.map((value: unknown) => {
      const relationship: Fields = fields(value, DB, "relationship");
      const spec: Fields = fields(relationship["relSpec"], DB, "relSpec");
      return {
        entityA: text(relationship["entityA"]),
        entityB: text(relationship["entityB"]),
        roleA: text(relationship["roleA"]),
        cardA: text(spec["cardA"]),
        cardB: text(spec["cardB"]),
        relType: text(spec["relType"]),
      };
    }),
  };
}
