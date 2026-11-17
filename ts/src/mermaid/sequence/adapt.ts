// Mermaid's records of a sequence diagram, held to Archer's profile and
// turned into the ordered trace model. Participants come in declaration
// order from the scan; labels and structure come from Mermaid.

import {
  isStableId,
  type FragmentEvent,
  type FragmentKind,
  type MessageEvent,
  type MessageKind,
  type NotePosition,
  type Participant,
  type SequenceEvent,
  type SequenceTrace,
} from "../../model/index.ts";
import { error, isError, type Diagnostic, type Span } from "../diagnostics.ts";
import { restoreEntities } from "../entities.ts";
import { readLabel } from "../labels.ts";
import { LINE, PLACEMENT, type SequenceData, type SequenceRecord } from "./db.ts";
import type { SequenceScan } from "./scan.ts";

const MESSAGES: Partial<Record<number, MessageKind>> = {
  [LINE.SOLID]: "sync",
  [LINE.DOTTED]: "reply",
  [LINE.SOLID_POINT]: "async",
  [LINE.BIDIRECTIONAL_SOLID]: "sync",
  [LINE.BIDIRECTIONAL_DOTTED]: "reply",
};
const TWO_WAY = new Set<number>([LINE.BIDIRECTIONAL_SOLID, LINE.BIDIRECTIONAL_DOTTED]);
const OPENERS: Partial<Record<number, FragmentKind>> = {
  [LINE.LOOP_START]: "loop",
  [LINE.ALT_START]: "alt",
  [LINE.OPT_START]: "opt",
  [LINE.PAR_START]: "par",
};
const SECTIONS = new Set<number>([LINE.ALT_ELSE, LINE.PAR_AND]);
const CLOSERS = new Set<number>([LINE.LOOP_END, LINE.ALT_END, LINE.OPT_END, LINE.PAR_END]);
const POSITIONS: Partial<Record<number, NotePosition>> = {
  [PLACEMENT.LEFTOF]: "left-of",
  [PLACEMENT.RIGHTOF]: "right-of",
  [PLACEMENT.OVER]: "over",
};

export interface Adapted {
  model: SequenceTrace | undefined;
  diagnostics: Diagnostic[];
}

/** Hands out the scan's positions in source order, as Mermaid's records arrive. */
class Positions {
  #next = 0;
  /** Every position was taken, and no record went without one. */
  get exhausted(): boolean {
    return this.#next === this.spans.length;
  }
  constructor(
    readonly spans: readonly Span[],
    readonly fallback: Span,
  ) {}
  take(): Span {
    const span = this.spans[this.#next] ?? this.fallback;
    this.#next += 1;
    return span;
  }
}

class Adapter {
  readonly diagnostics: Diagnostic[] = [];
  readonly messages: Positions;
  readonly notes: Positions;
  readonly sections: Positions;
  readonly counters = { msg: 0, frag: 0, note: 0 };
  autonumber = false;

  constructor(
    readonly scan: SequenceScan,
    readonly fallback: Span,
    /** The scan refused something, so a record outside the profile is already explained. */
    readonly scanRefused: boolean,
  ) {
    this.messages = new Positions(scan.messages, fallback);
    this.notes = new Positions(scan.notes, fallback);
    this.sections = new Positions(scan.sections, fallback);
  }

  consumedAll(): boolean {
    return this.messages.exhausted && this.notes.exhausted && this.sections.exhausted;
  }

  label(raw: string, at: Span): string {
    const { label, problems } = readLabel(restoreEntities(raw), at);
    this.diagnostics.push(...problems);
    return label;
  }

  participants(data: SequenceData): Participant[] {
    const actors = new Map(data.actors.map((actor) => [actor.name, actor]));
    return this.scan.declarations.map((declaration) => {
      const actor = actors.get(declaration.id);
      if (!isStableId(declaration.id)) {
        this.diagnostics.push(
          error(
            "invalid_id",
            `participant ID '${declaration.id}' is not a stable ID: use 1 to 128 letters, digits, \`_\` and \`-\`, starting with a letter or digit`,
            declaration.span,
          ),
        );
      }
      if (actor && actor.type !== "participant" && actor.type !== "actor") {
        this.diagnostics.push(
          error(
            "unsupported_construct",
            `the ${actor.type} participant type is not supported: use \`participant\` or \`actor\``,
            declaration.span,
          ),
        );
      }
      const participant: Participant = {
        id: declaration.id,
        label: this.label(actor?.description ?? declaration.id, declaration.labelSpan),
      };
      if (actor?.type === "actor") participant.kind = "actor";
      return participant;
    });
  }

  /** The events of `records` from `index`, up to the record that ends their block; returns where it stopped. */
  events(records: readonly SequenceRecord[], index: number, into: SequenceEvent[]): number {
    let at = index;
    while (at < records.length) {
      const record = records[at] as SequenceRecord;
      if (SECTIONS.has(record.type) || CLOSERS.has(record.type)) return at;
      at += 1;
      const kind = MESSAGES[record.type];
      const opens = OPENERS[record.type];
      if (kind !== undefined) {
        const span = this.messages.take();
        const event: MessageEvent = {
          type: "message",
          id: `msg-${this.counters.msg++}`,
          from: record.from ?? "",
          to: record.to ?? "",
          kind,
        };
        if (record.text.trim() !== "") event.label = this.label(record.text.trim(), span);
        if (TWO_WAY.has(record.type)) event.bidirectional = true;
        into.push(event);
      } else if (record.type === LINE.NOTE) {
        const span = this.notes.take();
        const from = record.from ?? "";
        const participants = record.to === undefined || record.to === from ? [from] : [from, record.to];
        into.push({
          type: "note",
          id: `note-${this.counters.note++}`,
          position: POSITIONS[record.placement ?? -1] ?? "over",
          participants,
          text: this.label(record.text.trim(), span),
        });
      } else if (record.type === LINE.ACTIVE_START || record.type === LINE.ACTIVE_END) {
        into.push({
          type: record.type === LINE.ACTIVE_START ? "activate" : "deactivate",
          participant: record.from ?? "",
        });
      } else if (opens !== undefined) {
        at = this.fragment(records, at, record, opens, into);
      } else if (record.type === LINE.AUTONUMBER && record.bareAutonumber) {
        this.autonumber = true;
      } else if (!this.scanRefused && !this.diagnostics.some(isError)) {
        // The scan refuses each construct outside the profile by name; this
        // catches one it could not read, so nothing is silently dropped.
        this.diagnostics.push(
          error(
            "unsupported_construct",
            `this diagram uses a sequence construct outside the profile (Mermaid record ${record.type})`,
            this.fallback,
          ),
        );
      }
    }
    return at;
  }

  fragment(
    records: readonly SequenceRecord[],
    at: number,
    opener: SequenceRecord,
    kind: FragmentKind,
    into: SequenceEvent[],
  ): number {
    const label = this.label(opener.text.trim(), this.sections.take());
    const fragment: FragmentEvent = { type: "fragment", id: `frag-${this.counters.frag++}`, kind, label, sections: [] };
    into.push(fragment);
    let sectionLabel = label;
    let cursor = at;
    for (;;) {
      const events: SequenceEvent[] = [];
      cursor = this.events(records, cursor, events);
      fragment.sections.push({ label: sectionLabel, events });
      const boundary = records[cursor];
      if (boundary === undefined) return cursor;
      cursor += 1;
      if (CLOSERS.has(boundary.type)) return cursor;
      sectionLabel = this.label(boundary.text.trim(), this.sections.take());
    }
  }
}

/**
 * Where Mermaid's records and the scan disagree (a participant Mermaid knows
 * that the source never declares, or a different number of messages, notes
 * or fragment sections), the two read the source differently, and Archer's
 * checks would be of something Mermaid does not draw. Refused.
 */
function disagreements(data: SequenceData, scan: SequenceScan, adapter: Adapter, fallback: Span): Diagnostic[] {
  const declared = new Set(scan.declarations.map((declaration) => declaration.id));
  const problems = data.actors
    .filter((actor) => !declared.has(actor.name))
    .map((actor) => `a participant '${actor.name}' that is not declared as written`);
  if (!adapter.consumedAll()) problems.push("a different number of messages, notes or fragments than are written");
  return problems.map((what) =>
    error(
      "parser_disagreement",
      `Mermaid reads ${what}; rewrite the statement that holds it plainly, one statement per line`,
      fallback,
    ),
  );
}

export function adaptSequence(data: SequenceData, scan: SequenceScan, fallback: Span, scanRefused: boolean): Adapted {
  const adapter = new Adapter(scan, fallback, scanRefused);
  const participants = adapter.participants(data);
  const events: SequenceEvent[] = [];
  adapter.events(data.records, 0, events);
  if (!scanRefused) adapter.diagnostics.push(...disagreements(data, scan, adapter, fallback));
  if (adapter.diagnostics.some(isError)) return { model: undefined, diagnostics: adapter.diagnostics };
  const model: SequenceTrace = { type: "sequence-trace", participants, events };
  if (adapter.autonumber) model.autonumber = true;
  return { model, diagnostics: adapter.diagnostics };
}
