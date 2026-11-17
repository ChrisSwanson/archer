// Copies what Archer needs out of Mermaid's sequence database: the actors and
// the ordered list of records Mermaid makes of messages, notes, activations
// and fragment boundaries. Internal API of mermaid 12.1.0, checked at run time
// (see flowchart/db.ts).

import { call, drift, fields, optionalText, type Fields } from "../db-fields.ts";

export interface SequenceActor {
  name: string;
  description: string;
  /** `participant`, `actor`, or one of Mermaid's other participant types. */
  type: string;
}

export interface SequenceRecord {
  /** Mermaid's LINETYPE number. */
  type: number;
  from: string | undefined;
  to: string | undefined;
  /** The record's text; empty when it has none. */
  text: string;
  /** For a note: Mermaid's PLACEMENT number. */
  placement: number | undefined;
  /** For `autonumber`: true for the bare keyword, with no start, step or `off`. */
  bareAutonumber: boolean;
}

export interface SequenceData {
  actors: SequenceActor[];
  records: SequenceRecord[];
}

/** Mermaid's LINETYPE values that Archer's profile reads. */
export const LINE = {
  SOLID: 0,
  DOTTED: 1,
  NOTE: 2,
  LOOP_START: 10,
  LOOP_END: 11,
  ALT_START: 12,
  ALT_ELSE: 13,
  ALT_END: 14,
  OPT_START: 15,
  OPT_END: 16,
  ACTIVE_START: 17,
  ACTIVE_END: 18,
  PAR_START: 19,
  PAR_AND: 20,
  PAR_END: 21,
  SOLID_POINT: 24,
  AUTONUMBER: 26,
  BIDIRECTIONAL_SOLID: 33,
  BIDIRECTIONAL_DOTTED: 34,
} as const;

/** Mermaid's PLACEMENT values. */
export const PLACEMENT = { LEFTOF: 0, RIGHTOF: 1, OVER: 2 } as const;

const DB = "sequence";

function record(value: unknown, what: string): Fields {
  return fields(value, DB, what);
}

function checkConstants(db: Fields): void {
  const lineTypes = record(db["LINETYPE"], "LINETYPE");
  for (const [name, value] of Object.entries(LINE)) {
    if (lineTypes[name] !== value) throw drift(DB, `LINETYPE.${name} is not ${value}`);
  }
  const placements = record(db["PLACEMENT"], "PLACEMENT");
  for (const [name, value] of Object.entries(PLACEMENT)) {
    if (placements[name] !== value) throw drift(DB, `PLACEMENT.${name} is not ${value}`);
  }
}

export function readSequenceDb(db: unknown): SequenceData {
  const sequence = record(db, "not an object");
  checkConstants(sequence);
  const actors = call(sequence, DB, "getActors");
  const messages = call(sequence, DB, "getMessages");
  if (!(actors instanceof Map) || !Array.isArray(messages)) throw drift(DB, "getActors() or getMessages()");
  return {
    actors: [...actors.values()].map((value: unknown) => {
      const actor = record(value, "actor");
      return {
        name: optionalText(actor["name"]) ?? "",
        description: optionalText(actor["description"]) ?? "",
        type: optionalText(actor["type"]) ?? "",
      };
    }),
    records: messages.map((value: unknown) => {
      const message = record(value, "message");
      const body = message["message"];
      const autonumber = typeof body === "object" && body !== null ? (body as Fields) : undefined;
      return {
        type: typeof message["type"] === "number" ? message["type"] : -1,
        from: optionalText(message["from"]),
        to: optionalText(message["to"]),
        text: optionalText(body) ?? "",
        placement: typeof message["placement"] === "number" ? message["placement"] : undefined,
        bareAutonumber:
          autonumber !== undefined &&
          autonumber["visible"] === true &&
          autonumber["start"] === undefined &&
          autonumber["step"] === undefined,
      };
    }),
  };
}
