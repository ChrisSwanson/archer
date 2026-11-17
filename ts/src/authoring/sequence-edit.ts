/**
 * Source-preserving sequence diagram edits with production compiler model postconditions. No filesystem writes.
 *
 * The profile holds every sequence statement to one line (scan.ts refuses `;`), so each declaration,
 * message, note, activation and fragment boundary is one physical line. This editor reads those lines into
 * the same block tree the adapter builds from Mermaid's records, numbering messages, notes and fragments
 * in the same pre-order (`msg-N`, `note-N`, `frag-N`), and checks the tree against the compiled model
 * before it trusts a single line of it. An edit is a set of splices (one token, one line removed or
 * inserted, a line moved, a run re-indented); the result must compile to exactly the expected model, and
 * every byte outside the splices is unchanged.
 *
 * Message, note and fragment IDs are ordinals in source order. They are stable only while nothing of the
 * same type is inserted, removed or moved before them: an edit that does so renumbers what follows, and the
 * expected model is renumbered the same way.
 */
import { isDeepStrictEqual } from "node:util";
import { compileCached as compile, withDiagnostic } from "./compile-cache.ts";
import { readPreamble } from "../mermaid/preamble.ts";
import { RESERVED } from "../mermaid/sequence/scan.ts";
import { checkLabel, writeLineBreaks } from "../mermaid/labels.ts";
import { isBlank, isCommentLine, type SourceLine } from "../mermaid/source.ts";
import type {
  FragmentEvent,
  MessageEvent,
  MessageKind,
  NoteEvent,
  Participant,
  SequenceEvent,
  SequenceTrace,
  StableId,
} from "../model/index.ts";
import { MAX_ID_CHARS } from "../model/index.ts";
import type { DiagramEdit, DiagramEditResult } from "./diagram-edit.ts";

export const SEQUENCE_PARTICIPANT_KINDS = ["participant", "actor"] as const;
export type SequenceParticipantKind = (typeof SEQUENCE_PARTICIPANT_KINDS)[number];
export const SEQUENCE_MESSAGE_KINDS = ["sync", "reply", "async"] as const satisfies readonly MessageKind[];
export const SEQUENCE_NOTE_POSITIONS = ["over", "left of", "right of"] as const;
export type SequenceNotePosition = (typeof SEQUENCE_NOTE_POSITIONS)[number];
/** The fragments wrap-edges takes; `critical` and `break` are outside the profile and refused by name. */
/** The fragments the profile accepts; the compiler refuses `critical` and `break`. */
export const SEQUENCE_FRAGMENTS = ["loop", "alt", "opt", "par"] as const;
export type SequenceFragment = (typeof SEQUENCE_FRAGMENTS)[number];

const ARROW_FOR: Record<MessageKind, string> = { sync: "->>", reply: "-->>", async: "-)" };
/** The arrow with a head at each end; Mermaid has none for an async message. */
const TWO_WAY_FOR: Partial<Record<MessageKind, string>> = { sync: "<<->>", reply: "<<-->>" };
const NOTE_POSITION: Record<SequenceNotePosition, NoteEvent["position"]> = {
  over: "over",
  "left of": "left-of",
  "right of": "right-of",
};
/** scan.ts's arrow reader: the first arrow on the line, longest alternative first. */
const ARROW = /<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->/u;
/** The ID grammar add-node writes: a stable ID without `-`, which an arrow could absorb (`a-x->>b`). */
const PARTICIPANT_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_]{0,${MAX_ID_CHARS - 1}}$`, "u");
const ENTITIES: Record<string, string> = { "#": "#35;", ";": "#59;", '"': "#quot;", "%": "#37;" };

/**
 * Text as Mermaid's sequence lexer reads it after `as`, after a message's or note's colon, or after a
 * fragment keyword. `#` ends the text and `;` ends the statement, so both are written as codes; `"` is
 * a code so an alias is never wrapped in quotes; `%` beside `%` is a code so no `%%` forms; and the colon
 * of a leading `wrap:`/`nowrap:` is a code, since Mermaid strips that prefix as a wrapping directive.
 */
export function encodeSequenceText(text: string): string {
  return writeLineBreaks(
    text
      .replace(/[#;"]|%(?=%)|(?<=%)%/gu, (ch) => ENTITIES[ch]!)
      .replace(/^(?:no)?wrap:/u, (m) => `${m.slice(0, -1)}#58;`),
  );
}

/** Why `text` cannot be written exactly as requested; undefined when it can. */
function textProblem(text: unknown, required: boolean): string | undefined {
  if (typeof text !== "string" || (required && text.trim() === "")) return "edit_label_required";
  if (text === "") return undefined;
  // The compiler trims text, and refuses HTML tags, control characters and overlong labels.
  if (text !== text.trim()) return "edit_invalid_label";
  return checkLabel(text, { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }).length === 0
    ? undefined
    : "edit_invalid_label";
}

/** One statement line, classified as scan.ts classifies it. */
type Statement =
  | {
      type: "declaration";
      line: SourceLine;
      id: string;
      kind: SequenceParticipantKind;
      idStart: number;
      idEnd: number;
      aliasEnd?: number;
    }
  | {
      type: "message";
      line: SourceLine;
      from: string;
      to: string;
      fromStart: number;
      arrowStart: number;
      arrowEnd: number;
      toStart: number;
      mark?: "+" | "-";
      colon: number;
    }
  | { type: "note"; line: SourceLine; colon: number }
  | { type: "activate" | "deactivate"; line: SourceLine; participant: string }
  | { type: "open"; line: SourceLine; keyword: string }
  | { type: "section" | "end" | "other"; line: SourceLine };

/** A section of a fragment, or the diagram's top level; `path` locates its events in the model. */
interface Block {
  events: Node[];
  path: [number, number][];
  line: SourceLine | undefined;
  fragment: Node | undefined;
}
/** An event of the tree: one per model event, on the line that writes it. */
interface Node {
  type: SequenceEvent["type"];
  id?: string;
  statement: Statement;
  block: Block;
  sections?: Block[];
  end?: SourceLine;
}

function classify(line: SourceLine): Statement {
  const text = line.text;
  const start = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const word = (/^[^\s:]+/u.exec(trimmed)?.[0] ?? "").toLowerCase();
  const rest = trimmed.slice(word.length);
  const spaced = /^\s/u.test(rest);
  if ((word === "participant" || word === "actor") && spaced) {
    const match = /^(\S+)\s+(\S+?)(?:(\s+as\s+)(.*?))?\s*$/su.exec(text.slice(start));
    const id = match?.[2] ?? "";
    const idStart = text.indexOf(id, start + word.length);
    const declaration: Statement = { type: "declaration", line, id, kind: word, idStart, idEnd: idStart + id.length };
    if (match?.[3] !== undefined) declaration.aliasEnd = text.trimEnd().length;
    return declaration;
  }
  if ((word === "activate" || word === "deactivate") && spaced) return { type: word, line, participant: rest.trim() };
  if (word === "note" && spaced) return { type: "note", line, colon: text.indexOf(":", start) };
  if (["loop", "alt", "opt", "par"].includes(word)) return { type: "open", line, keyword: word };
  if (word === "else" || word === "and") return { type: "section", line };
  if (word === "end" && rest.trim() === "") return { type: "end", line };
  const arrow = ARROW.exec(text.slice(start));
  if (!arrow || word === "autonumber") return { type: "other", line };
  const arrowStart = start + arrow.index;
  const arrowEnd = arrowStart + arrow[0].length;
  let after = arrowEnd;
  while (text[after] === " " || text[after] === "\t") after += 1;
  const mark = text[after] === "+" || text[after] === "-" ? (text[after] as "+" | "-") : undefined;
  if (mark) after += 1;
  else after = arrowEnd;
  const colon = text.indexOf(":", after);
  const to = text.slice(after, colon).trim();
  const message: Statement = {
    type: "message",
    line,
    from: text.slice(start, arrowStart).trim(),
    to,
    fromStart: start,
    arrowStart,
    arrowEnd,
    toStart: text.indexOf(to, after),
    colon,
  };
  if (mark) message.mark = mark;
  return message;
}

/** The statements as the adapter's block tree, numbered in its pre-order. */
function buildTree(statements: Statement[]) {
  const root: Block = { events: [], path: [], line: undefined, fragment: undefined };
  const blockAfter = new Map<SourceLine, Block>();
  const counters = { msg: 0, note: 0, frag: 0 };
  let current = root;
  const add = (node: Omit<Node, "block">): Node => {
    const full = { ...node, block: current } as Node;
    current.events.push(full);
    return full;
  };
  for (const s of statements) {
    if (s.type === "message") {
      add({ type: "message", id: `msg-${counters.msg++}`, statement: s });
      if (s.mark) add({ type: s.mark === "+" ? "activate" : "deactivate", statement: s });
    } else if (s.type === "note") add({ type: "note", id: `note-${counters.note++}`, statement: s });
    else if (s.type === "activate" || s.type === "deactivate") add({ type: s.type, statement: s });
    else if (s.type === "open") {
      const index = current.events.length;
      const fragment = add({ type: "fragment", id: `frag-${counters.frag++}`, statement: s, sections: [] });
      current = { events: [], path: [...current.path, [index, 0]], line: s.line, fragment };
      fragment.sections!.push(current);
    } else if (s.type === "section" && current.fragment) {
      const fragment = current.fragment;
      const [index] = current.path.at(-1)!;
      current = {
        events: [],
        path: [...current.path.slice(0, -1), [index, fragment.sections!.length]],
        line: s.line,
        fragment,
      };
      fragment.sections!.push(current);
    } else if (s.type === "end" && current.fragment) {
      current.fragment.end = s.line;
      current = current.fragment.block;
    }
    blockAfter.set(s.line, current);
  }
  return { root, blockAfter };
}

/** Whether the tree's events are the model's, type for type and ID for ID. */
function matches(nodes: Node[], events: SequenceEvent[]): boolean {
  return (
    nodes.length === events.length &&
    nodes.every((node, i) => {
      const event = events[i]!;
      if (node.type !== event.type || ("id" in event ? event.id : undefined) !== node.id) return false;
      if (event.type !== "fragment") return true;
      return (
        node.sections!.length === event.sections.length &&
        node.sections!.every((b, j) => matches(b.events, event.sections[j]!.events))
      );
    })
  );
}

/** The model's events at a block's path. */
function eventsAt(model: SequenceTrace, path: [number, number][]): SequenceEvent[] {
  let events = model.events;
  for (const [index, section] of path) events = (events[index] as FragmentEvent).sections[section]!.events;
  return events;
}

/** Number messages, notes and fragments in the adapter's pre-order. */
function renumber(model: SequenceTrace): void {
  const counters = { msg: 0, note: 0, frag: 0 };
  const walk = (events: SequenceEvent[]) => {
    for (const event of events) {
      if (event.type === "message") event.id = `msg-${counters.msg++}` as StableId;
      else if (event.type === "note") event.id = `note-${counters.note++}` as StableId;
      else if (event.type === "fragment") {
        event.id = `frag-${counters.frag++}` as StableId;
        for (const section of event.sections) walk(section.events);
      }
    }
  };
  walk(model.events);
}

function* allNodes(block: Block): Generator<Node> {
  for (const node of block.events) {
    yield node;
    for (const section of node.sections ?? []) yield* allNodes(section);
  }
}

export async function editSequence(source: string, edit: DiagramEdit): Promise<DiagramEditResult> {
  const refuse = (code: string, existingId?: string): DiagramEditResult =>
    existingId === undefined ? { ok: false, source, code } : { ok: false, source, code, existingId };
  const unchanged: DiagramEditResult = { ok: true, source };
  if (edit.kind === "change-shape" || edit.kind === "direction") return refuse("edit_unsupported_for_family");
  if (
    edit.kind === "add-node" &&
    (edit.shape !== undefined || edit.element !== undefined || edit.external !== undefined || edit.state !== undefined)
  )
    return refuse("edit_unsupported_for_family");
  if (
    (edit.kind === "connect" && (edit.line !== undefined || edit.relation !== undefined)) ||
    ((edit.kind === "connect" || edit.kind === "retarget-edge") &&
      (edit.cardinality !== undefined || edit.identifying !== undefined))
  )
    return refuse("edit_unsupported_for_family");
  const compiled = await compile(source);
  const preamble = readPreamble(source);
  const header = preamble.header;
  if (header === undefined || compiled.model?.type !== "sequence-trace")
    return withDiagnostic(refuse("edit_requires_valid_sequence"), compiled);
  const before = compiled.model;
  const expected = structuredClone(before);

  // Physical lines with their offsets; the preamble keeps every statement on its source line.
  const physical = [...source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/gu)].map((m) => ({
    start: m.index,
    textEnd: m.index + m[1]!.length,
    end: m.index + m[0].length,
  }));
  const at = (line: SourceLine) => physical[line.number - 1]!;
  const newline = /\r\n|\r|\n/u.exec(source)?.[0] ?? "\n";
  const statements = preamble.statements
    .filter((l) => l.number > header.number && !isBlank(l.text) && !isCommentLine(l.text))
    .map(classify);
  const declarations = statements.filter(
    (s): s is Extract<Statement, { type: "declaration" }> => s.type === "declaration",
  );
  const { root, blockAfter } = buildTree(statements);
  if (
    !isDeepStrictEqual(
      declarations.map((d) => d.id),
      before.participants.map((p) => p.id),
    ) ||
    !matches(root.events, before.events)
  )
    return refuse("edit_source_mapping_ambiguous");
  const nodes = [...allNodes(root)];
  const node = (type: SequenceEvent["type"], id: string) => nodes.find((n) => n.type === type && n.id === id);
  const declaration = (id: string) => declarations.find((d) => d.id === id);
  const blockOf = (line: SourceLine) => {
    const index = statements.findIndex((s) => s.line === line);
    return index <= 0 ? root : blockAfter.get(statements[index - 1]!.line)!;
  };
  const statementLines = statements.map((s) => s.line);
  const firstIndent = statementLines[0]?.indent || "    ";
  /** The file's indent unit: a fragment's inner indent beyond its opener's, else the first statement's. */
  const unit = (() => {
    for (const n of nodes) {
      const inner = n.sections?.[0]?.events[0]?.statement.line.indent;
      const outer = n.statement.line.indent;
      if (inner !== undefined && inner.length > outer.length && inner.startsWith(outer))
        return inner.slice(outer.length);
    }
    return firstIndent.slice(header.indent.length) || "    ";
  })();

  // Splices on the original source; the result is checked to keep every byte between them.
  const splices: { start: number; end: number; text: string }[] = [];
  const splice = (start: number, end: number, text: string) => splices.push({ start, end, text });
  const removeLine = (line: SourceLine) => {
    const here = at(line);
    // The last line has no line break of its own: take the one before it, so no break is added or left (a blank line before it stays).
    if (
      here.end === here.textEnd &&
      line.number > 1 &&
      physical[line.number - 2]!.textEnd > physical[line.number - 2]!.start
    )
      splice(physical[line.number - 2]!.textEnd, here.end, "");
    else splice(here.start, here.end, "");
  };
  const insertAfter = (line: SourceLine, text: string, term = newline) => {
    const here = at(line);
    if (here.end === here.textEnd) splice(here.textEnd, here.textEnd, term + text);
    else splice(here.end, here.end, text + term);
  };
  const insertBefore = (line: SourceLine, text: string, term = newline) =>
    splice(at(line).start, at(line).start, text + term);
  /**
   * Move a whole physical line to before `target`, or after it with `after`: its exact bytes (indentation,
   * `%%` directives and comments the preamble blanks) and its own line terminator, not the first one found.
   */
  const moveLine = (line: SourceLine, target: SourceLine, after: boolean) => {
    const here = at(line);
    const previous = line.number > 1 ? physical[line.number - 2]! : undefined;
    const own = source.slice(here.textEnd, here.end);
    const term = own !== "" ? own : previous ? source.slice(previous.textEnd, previous.end) || newline : newline;
    const raw = source.slice(here.start, here.textEnd);
    removeLine(line);
    if (after) insertAfter(target, raw, term);
    else insertBefore(target, raw, term);
  };
  /** Where a line inserted after `anchor` lands in the model, and the indent it takes. */
  const placeAfter = (anchor: SourceLine): { block: Block; index: number; indent: string } => {
    const block = anchor === header ? root : blockAfter.get(anchor)!;
    const index = block.events.filter((n) => n.statement.line.number <= anchor.number).length;
    const s = statements.find((st) => st.line === anchor);
    const indent =
      anchor === header
        ? firstIndent
        : s?.type === "open" || s?.type === "section"
          ? (block.events[0]?.statement.line.indent ?? anchor.indent + unit)
          : anchor.indent;
    return { block, index, indent };
  };
  /** Insert one event line at `after`: after a message, as the first message (null), or at the end (undefined). */
  const placeEvent = (
    after: string | null | undefined,
    text: (indent: string) => string,
  ): { events: SequenceEvent[]; index: number } | string => {
    if (after === undefined) {
      const ended = /[\r\n]$/u.test(source);
      const indent =
        root.events.at(-1)?.statement.line.indent ??
        declarations.filter((d) => blockOf(d.line) === root).at(-1)?.line.indent ??
        firstIndent;
      splice(source.length, source.length, (ended ? "" : newline) + indent + text(indent) + (ended ? newline : ""));
      return { events: expected.events, index: expected.events.length };
    }
    let anchor: SourceLine;
    if (after === null) {
      const first = nodes.find((n) => n.type === "message")?.statement.line;
      anchor = declarations.filter((d) => first === undefined || d.line.number < first.number).at(-1)?.line ?? header;
    } else {
      const message = node("message", after);
      if (!message) return "edit_target_missing";
      anchor = message.statement.line;
    }
    const place = placeAfter(anchor);
    insertAfter(anchor, place.indent + text(place.indent));
    return { events: eventsAt(expected, place.block.path), index: place.index };
  };
  const participantProblem = (ids: string[]) =>
    ids.some((id) => !declaration(id)) ? "edit_target_missing" : undefined;

  if (edit.kind === "move-node") {
    const moving = declaration(edit.id);
    const target = edit.before === null ? undefined : declaration(edit.before);
    if (!moving || (edit.before !== null && !target)) return refuse("edit_target_missing");
    if (edit.id === edit.before) return unchanged;
    if (blockOf(moving.line) !== root || (target && blockOf(target.line) !== root))
      return refuse("edit_move_in_fragment");
    const order = expected.participants.map((p) => p.id as string);
    const from = order.indexOf(edit.id);
    const to = target ? order.indexOf(target.id) : order.length;
    if (to === from + 1 || (target === undefined && from === order.length - 1)) return unchanged;
    if (target) moveLine(moving.line, target.line, false);
    else {
      const last = declarations.at(-1)!;
      if (blockOf(last.line) !== root) return refuse("edit_move_in_fragment");
      moveLine(moving.line, last.line, true);
    }
    const [moved] = expected.participants.splice(from, 1);
    expected.participants.splice(
      target ? expected.participants.findIndex((p) => p.id === target.id) : expected.participants.length,
      0,
      moved!,
    );
  } else if (edit.kind === "add-node") {
    const kind = edit.participant ?? "participant";
    if (!SEQUENCE_PARTICIPANT_KINDS.includes(kind)) return refuse("edit_invalid_participant_kind");
    if (!PARTICIPANT_ID.test(edit.id)) return refuse("edit_invalid_id");
    if (RESERVED.has(edit.id.toLowerCase()) || /^acc(?:title|descr)/iu.test(edit.id)) return refuse("edit_id_reserved");
    if (declaration(edit.id)) return refuse("edit_id_exists");
    const aliased = edit.label !== "" && edit.label !== edit.id;
    if (aliased) {
      const problem = textProblem(edit.label, false);
      if (problem) return refuse(problem);
    }
    const anchor = declarations.at(-1)?.line ?? header;
    const indent = anchor === header ? firstIndent : anchor.indent;
    insertAfter(anchor, `${indent}${kind} ${edit.id}${aliased ? ` as ${encodeSequenceText(edit.label)}` : ""}`);
    const added: Participant = { id: edit.id as StableId, label: aliased ? edit.label : edit.id };
    if (kind === "actor") added.kind = "actor";
    expected.participants.push(added);
  } else if (edit.kind === "relabel-node") {
    const d = declaration(edit.id);
    if (!d) return refuse("edit_target_missing");
    const aliased = edit.label !== "" && edit.label !== edit.id;
    if (aliased) {
      const problem = textProblem(edit.label, false);
      if (problem) return refuse(problem);
    }
    const modelled = expected.participants.find((p) => p.id === edit.id)!;
    const label = aliased ? edit.label : edit.id;
    if (modelled.label === label) return unchanged;
    const base = at(d.line).start;
    if (!aliased) splice(base + d.idEnd, base + d.aliasEnd!, "");
    else if (d.aliasEnd === undefined) splice(base + d.idEnd, base + d.idEnd, ` as ${encodeSequenceText(label)}`);
    else {
      const aliasStart = d.line.text.slice(d.idEnd).search(/\S/u) + d.idEnd + 2;
      const start = d.line.text.slice(aliasStart).search(/\S/u) + aliasStart;
      splice(base + start, base + d.aliasEnd, encodeSequenceText(label));
    }
    modelled.label = label;
  } else if (edit.kind === "delete-node") {
    const d = declaration(edit.id);
    if (!d) return refuse("edit_target_missing");
    const referenced = nodes.some((n) => {
      const s = n.statement;
      if (s.type === "message") return s.from === edit.id || s.to === edit.id;
      if (s.type === "activate" || s.type === "deactivate") return s.participant === edit.id;
      return (
        n.type === "note" &&
        (
          eventsAt(before, n.block.path).find((e) => e.type === "note" && e.id === n.id) as NoteEvent
        ).participants.includes(edit.id as StableId)
      );
    });
    if (referenced) return refuse("edit_delete_referenced_node");
    removeLine(d.line);
    expected.participants = expected.participants.filter((p) => p.id !== edit.id);
  } else if (edit.kind === "connect") {
    const kind = edit.message ?? "sync";
    if (!SEQUENCE_MESSAGE_KINDS.includes(kind)) return refuse("edit_invalid_message_kind");
    const missing = participantProblem([edit.source, edit.target]);
    if (missing) return refuse(missing);
    const label = edit.label ?? "";
    const problem = textProblem(label, false);
    if (problem) return refuse(problem);
    const placed = placeEvent(
      edit.after,
      () => `${edit.source}${ARROW_FOR[kind]}${edit.target}:${label === "" ? "" : ` ${encodeSequenceText(label)}`}`,
    );
    if (typeof placed === "string") return refuse(placed);
    const added: MessageEvent = {
      type: "message",
      id: "msg-new" as StableId,
      from: edit.source as StableId,
      to: edit.target as StableId,
      kind,
    };
    if (label !== "") added.label = label;
    placed.events.splice(placed.index, 0, added);
    renumber(expected);
    if (edit.id !== undefined && edit.id !== added.id) return refuse("edit_relationship_id_derived");
  } else if (edit.kind === "add-note") {
    const position = edit.position;
    if (!SEQUENCE_NOTE_POSITIONS.includes(position)) return refuse("edit_invalid_note");
    const names = edit.participants;
    if (
      !Array.isArray(names) ||
      names.length < 1 ||
      names.length > (position === "over" ? 2 : 1) ||
      new Set(names).size !== names.length
    )
      return refuse("edit_invalid_note");
    const missing = participantProblem(names);
    if (missing) return refuse(missing);
    const problem = textProblem(edit.text, true);
    if (problem) return refuse(problem);
    const placed = placeEvent(
      edit.after,
      () => `Note ${position} ${names.join(",")}: ${encodeSequenceText(edit.text)}`,
    );
    if (typeof placed === "string") return refuse(placed);
    placed.events.splice(placed.index, 0, {
      type: "note",
      id: "note-new" as StableId,
      position: NOTE_POSITION[position],
      participants: names as StableId[],
      text: edit.text,
    });
    renumber(expected);
  } else if (edit.kind === "relabel-edge" || edit.kind === "relabel-note") {
    const isNote = edit.kind === "relabel-note";
    const target = node(isNote ? "note" : "message", edit.id);
    if (!target) return refuse("edit_target_missing");
    const text = isNote ? edit.text : edit.label;
    const problem = textProblem(text, isNote);
    if (problem) return refuse(problem);
    const events = eventsAt(expected, target.block.path);
    const modelled = events.find((e) => "id" in e && e.id === edit.id) as MessageEvent | NoteEvent;
    if ((modelled.type === "note" ? modelled.text : (modelled.label ?? "")) === text) return unchanged;
    const s = target.statement as Extract<Statement, { colon: number }>;
    const line = s.line.text;
    const base = at(s.line).start;
    const body = line.slice(s.colon + 1);
    const textStart = s.colon + 1 + (body.length - body.trimStart().length);
    const textEnd = Math.max(textStart, line.trimEnd().length);
    if (text === "") splice(base + s.colon + 1, base + textEnd, "");
    else if (textStart === textEnd) splice(base + s.colon + 1, base + textEnd, ` ${encodeSequenceText(text)}`);
    else splice(base + textStart, base + textEnd, encodeSequenceText(text));
    if (modelled.type === "note") modelled.text = text;
    else if (text === "") delete modelled.label;
    else modelled.label = text;
  } else if (edit.kind === "delete-edge" || edit.kind === "delete-note") {
    const target = node(edit.kind === "delete-note" ? "note" : "message", edit.id);
    if (!target) return refuse("edit_target_missing");
    if (target.statement.type === "message" && target.statement.mark) return refuse("edit_activation_dependency");
    removeLine(target.statement.line);
    const events = eventsAt(expected, target.block.path);
    events.splice(
      events.findIndex((e) => "id" in e && e.id === edit.id),
      1,
    );
    renumber(expected);
  } else if (edit.kind === "retarget-edge") {
    const target = node("message", edit.id);
    if (!target) return refuse("edit_target_missing");
    const s = target.statement as Extract<Statement, { type: "message" }>;
    const source2 = edit.source ?? s.from;
    const target2 = edit.target ?? s.to;
    const kind = edit.message;
    if (kind !== undefined && !SEQUENCE_MESSAGE_KINDS.includes(kind)) return refuse("edit_invalid_message_kind");
    const missing = participantProblem([source2, target2]);
    if (missing) return refuse(missing);
    const modelled = eventsAt(expected, target.block.path).find(
      (e) => e.type === "message" && e.id === edit.id,
    ) as MessageEvent;
    // A two-way message stays two-way: its new kind needs a two-way arrow.
    if (kind !== undefined && modelled.bidirectional === true && TWO_WAY_FOR[kind] === undefined)
      return refuse("edit_invalid_message_kind");
    const changes = source2 !== s.from || target2 !== s.to;
    if (!changes && (kind === undefined || kind === modelled.kind)) return unchanged;
    // `+` activates the receiver and `-` deactivates the sender: new ends would move an activation.
    if (changes && s.mark) return refuse("edit_activation_dependency");
    const base = at(s.line).start;
    if (source2 !== s.from) splice(base + s.fromStart, base + s.fromStart + s.from.length, source2);
    if (kind !== undefined && kind !== modelled.kind)
      splice(
        base + s.arrowStart,
        base + s.arrowEnd,
        modelled.bidirectional === true ? TWO_WAY_FOR[kind]! : ARROW_FOR[kind],
      );
    if (target2 !== s.to) splice(base + s.toStart, base + s.toStart + s.to.length, target2);
    modelled.from = source2 as StableId;
    modelled.to = target2 as StableId;
    if (kind !== undefined) modelled.kind = kind;
  } else if (edit.kind === "change-arrow") {
    const target = node("message", edit.id);
    if (!target) return refuse("edit_target_missing");
    if (!["one-way", "two-way", "reverse"].includes(edit.arrow)) return refuse("edit_invalid_line");
    const s = target.statement as Extract<Statement, { type: "message" }>;
    const modelled = eventsAt(expected, target.block.path).find(
      (e) => e.type === "message" && e.id === edit.id,
    ) as MessageEvent;
    const twoWay = modelled.bidirectional === true;
    const base = at(s.line).start;
    if (edit.arrow === "reverse") {
      if (s.from === s.to) return unchanged;
      // `+` activates the receiver and `-` deactivates the sender: swapped ends would move an activation.
      if (s.mark) return refuse("edit_activation_dependency");
      splice(base + s.fromStart, base + s.fromStart + s.from.length, s.to);
      splice(base + s.toStart, base + s.toStart + s.to.length, s.from);
      modelled.from = s.to as StableId;
      modelled.to = s.from as StableId;
    } else {
      if ((edit.arrow === "two-way") === twoWay) return unchanged;
      const arrow = edit.arrow === "two-way" ? TWO_WAY_FOR[modelled.kind] : ARROW_FOR[modelled.kind];
      if (arrow === undefined) return refuse("edit_invalid_message_kind");
      splice(base + s.arrowStart, base + s.arrowEnd, arrow);
      if (edit.arrow === "two-way") modelled.bidirectional = true;
      else delete modelled.bidirectional;
    }
  } else if (edit.kind === "move-edge") {
    const moving = node("message", edit.id);
    if (!moving) return refuse("edit_target_missing");
    const block = moving.block;
    const messages = block.events.filter((n) => n.type === "message");
    let target: Node | undefined;
    if (edit.before !== null) {
      target = node("message", edit.before);
      if (!target) return refuse("edit_target_missing");
      if (target === moving) return unchanged;
      if (target.block !== block) return refuse("edit_move_cross_block");
    }
    const last = messages.at(-1)!;
    const from = block.events.indexOf(moving);
    const to = target
      ? block.events.indexOf(target)
      : block.events.lastIndexOf(last) + (last.statement.type === "message" && last.statement.mark ? 2 : 1);
    const nextMessage = block.events.slice(from + 1).find((n) => n.type === "message");
    if (target ? nextMessage === target : last === moving) return unchanged;
    // Activations count per participant along the source: refuse to move a message across any of them.
    const [low, high] = from < to ? [from, to] : [to, from + 1];
    const between = block.events.slice(low, high);
    const activating = (n: Node): boolean =>
      n.type === "activate" || n.type === "deactivate" || (n.sections ?? []).some((b) => b.events.some(activating));
    if (moving.statement.type === "message" && moving.statement.mark) return refuse("edit_activation_dependency");
    if (between.some(activating)) return refuse("edit_activation_dependency");
    if (target) moveLine(moving.statement.line, target.statement.line, false);
    else moveLine(moving.statement.line, last.statement.line, true);
    const events = eventsAt(expected, block.path);
    const [moved] = events.splice(from, 1);
    events.splice(from < to ? to - 1 : to, 0, moved!);
    renumber(expected);
  } else if (edit.kind === "wrap-edges") {
    if (!SEQUENCE_FRAGMENTS.includes(edit.fragment)) return refuse("edit_invalid_fragment");
    if (!Array.isArray(edit.ids) || edit.ids.length === 0 || new Set(edit.ids).size !== edit.ids.length)
      return refuse("edit_wrap_not_consecutive");
    const chosen = edit.ids.map((id) => node("message", id));
    if (chosen.some((n) => n === undefined)) return refuse("edit_target_missing");
    const block = chosen[0]!.block;
    if (chosen.some((n) => n!.block !== block)) return refuse("edit_wrap_cross_block");
    const problem = textProblem(edit.label, true);
    if (problem) return refuse(problem);
    const indices = chosen.map((n) => block.events.indexOf(n!));
    const low = Math.min(...indices);
    const lastMessage = block.events[Math.max(...indices)]!;
    const high =
      Math.max(...indices) + (lastMessage.statement.type === "message" && lastMessage.statement.mark ? 1 : 0);
    const run = block.events.slice(low, high + 1);
    if (run.some((n) => n.type === "fragment" || (n.type === "message" && !edit.ids.includes(n.id!))))
      return refuse("edit_wrap_not_consecutive");
    const first = run[0]!.statement.line;
    const lastLine = run.at(-1)!.statement.line;
    const spanned = statements.filter((s) => s.line.number >= first.number && s.line.number <= lastLine.number);
    if (spanned.some((s) => s.type === "declaration" || s.type === "other"))
      return refuse("edit_wrap_spans_declaration");
    const indent = first.indent;
    // The opener and the first line's added indent are one splice at the same offset.
    splice(
      at(first).start,
      at(first).start,
      `${indent}${edit.fragment} ${encodeSequenceText(edit.label)}${newline}${unit}`,
    );
    for (const line of preamble.statements) {
      if (line.number <= first.number || line.number > lastLine.number || isBlank(line.text)) continue;
      splice(at(line).start, at(line).start, unit);
    }
    insertAfter(lastLine, `${indent}end`);
    const events = eventsAt(expected, block.path);
    const wrapped = events.splice(low, run.length);
    events.splice(low, 0, {
      type: "fragment",
      id: "frag-new" as StableId,
      kind: edit.fragment as FragmentEvent["kind"],
      label: edit.label,
      sections: [{ label: edit.label, events: wrapped }],
    });
    renumber(expected);
  } else if (edit.kind === "unwrap-fragment") {
    const fragment = node("fragment", edit.id);
    if (!fragment) return refuse("edit_target_missing");
    if (fragment.sections!.length !== 1) return refuse("edit_unwrap_sections");
    const opener = fragment.statement.line;
    const end = fragment.end!;
    const inner = preamble.statements.filter(
      (l) => l.number > opener.number && l.number < end.number && !isBlank(l.text),
    );
    const prefix = inner[0]?.indent.startsWith(opener.indent) ? inner[0].indent.slice(opener.indent.length) : "";
    // Dedent only when every inner line carries the same extra indent; otherwise keep it as written.
    const dedent = prefix !== "" && inner.every((l) => l.indent.startsWith(opener.indent + prefix));
    removeLine(opener);
    if (dedent)
      for (const line of inner)
        splice(at(line).start + opener.indent.length, at(line).start + opener.indent.length + prefix.length, "");
    removeLine(end);
    const events = eventsAt(expected, fragment.block.path);
    const index = events.findIndex((e) => e.type === "fragment" && e.id === edit.id);
    events.splice(index, 1, ...(events[index] as FragmentEvent).sections[0]!.events);
    renumber(expected);
  } else {
    return refuse("edit_unsupported_for_family");
  }

  const candidate = apply(source, splices);
  if (candidate === undefined) return refuse("edit_invalid_result");
  const after = await compile(candidate);
  if (after.model?.type !== "sequence-trace" || !isDeepStrictEqual(after.model, expected))
    return refuse("edit_invalid_result");
  return { ok: true, source: candidate };
}

/** The splices applied to `source`, with every byte between them checked; undefined when two overlap. */
function apply(source: string, splices: { start: number; end: number; text: string }[]): string | undefined {
  // Ascending, and at one offset an insertion before a removal, which keeps the inserted text.
  const ordered = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  let candidate = "";
  let cursor = 0;
  const gaps: { at: number; from: number; to: number }[] = [];
  for (const s of [...ordered, { start: source.length, end: source.length, text: "" }]) {
    if (s.start < cursor) return undefined;
    gaps.push({ at: candidate.length, from: cursor, to: s.start });
    candidate += source.slice(cursor, s.start) + s.text;
    cursor = s.end;
  }
  // Every byte outside the splices is the source's own, where it was relative to the splices.
  return gaps.every((g) => candidate.slice(g.at, g.at + g.to - g.from) === source.slice(g.from, g.to))
    ? candidate
    : undefined;
}
