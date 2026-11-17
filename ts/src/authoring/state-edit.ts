/**
 * Source-preserving state diagram edits with production compiler model postconditions. No filesystem writes.
 *
 * The profile holds every state statement to one line (scan.ts), so the state scan maps each state's
 * label, each transition and its label to an exact span. An edit splices one span, removes one line, or
 * inserts one line (at the end, or before a composite's `}`); the result must compile to exactly the
 * expected model, and every byte outside the splice is unchanged.
 *
 * `[*]` is not an ordinary state: it exists only through a transition, takes its ID from the scope it is
 * written in (`root_start`, `Working_end`), and has no label of its own. So it is never added, relabelled
 * or deleted directly; it appears with the first transition that names it and goes with the last.
 */
import { isDeepStrictEqual } from "node:util";
import { compileCached as compile, withDiagnostic } from "./compile-cache.ts";
import { readPreamble } from "../mermaid/preamble.ts";
import { scanState, type ScannedState } from "../mermaid/state/scan.ts";
import { checkLabel, writeLineBreaks } from "../mermaid/labels.ts";
import { isBlank, isCommentLine, type SourceLine } from "../mermaid/source.ts";
import type { Position, Span } from "../mermaid/diagnostics.ts";
import type { StableId, StateMachine, StateNode, StateTransition } from "../model/index.ts";
import { MAX_ID_CHARS } from "../model/index.ts";
import type { DiagramEdit, DiagramEditResult } from "./diagram-edit.ts";

/** The kinds add-node may write; `[*]` start and end come only from transitions. */
export const STATE_NODE_KINDS = ["state", "choice", "fork", "join"] as const;
export type StateNodeKind = (typeof STATE_NODE_KINDS)[number];
/** The endpoint the UI sends for "from the start" (as a source) or "to the end" (as a target), top level only. */
export const STATE_START_END = "[*]";

/** The profile's state ID grammar (scan.ts): no hyphen, unlike a stable ID. */
const STATE_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_]{0,${MAX_ID_CHARS - 1}}$`, "u");
/** scan.ts's declaration form, with the name kept whole (it may carry a `:::class` suffix). */
const DECLARATION = /^state\s+(?:"([^"]*)"\s+as\s+)?(\S+?)(?:\s*<<\s*(\w+)\s*>>)?(\s*\{)?$/du;
const DESCRIBED = /^([^\s:]+)\s*:(?!::)/u;
const ENTITIES: Record<string, string> = {
  ";": "#59;",
  '"': "#quot;",
  "{": "#123;",
  "}": "#125;",
  "%": "#37;",
  ":": "#58;",
  ">": "#62;",
};

/**
 * A state or transition label as written in any of the three label forms (`state "L" as X`, `X : L`,
 * `A --> B : L`). Each character is written as an entity code where some form would misread it:
 * `;` ends a statement anywhere; `"` ends the quoted form; `{`/`}` break a transition label; `%%` starts
 * a comment; `::` reads as `:::class`; `-->` reads as a transition. `#` stays as written: with every `;`
 * coded, no `#name;` code can form from the label's own text.
 */
export function encodeStateLabel(label: string): string {
  return writeLineBreaks(label.replace(/[;"{}]|%(?=%)|(?<=%)%|:(?=:)|(?<=:):|(?<=--)>/gu, (ch) => ENTITIES[ch]!));
}

/** Why `label` cannot be a state or transition label exactly as requested; undefined when it can. */
function labelProblem(label: string | undefined): string | undefined {
  if (label === undefined || label.trim() === "") return "edit_label_required";
  // The compiler trims labels, and refuses HTML tags, control characters and overlong labels.
  if (label !== label.trim()) return "edit_invalid_label";
  return checkLabel(label, { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }).length === 0
    ? undefined
    : "edit_invalid_label";
}

/** The UTF-16 offset on `text` of a one-based column counted in Unicode scalar values. */
function offsetOf(text: string, column: number): number {
  let offset = 0;
  for (let c = 1; c < column && offset < text.length; c += 1)
    offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  return offset;
}

/** The name in a declaration or description, without its `:::class` suffix. */
const bareName = (raw: string) => (raw.indexOf(":::") > 0 ? raw.slice(0, raw.indexOf(":::")) : raw);

/** States in a stable order: Mermaid's first-mention order moves when a first mention is removed. */
const normalised = (m: StateMachine): StateMachine => ({
  ...m,
  states: [...m.states].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
});

/** State ids Mermaid's lexer reads as directives at the start of a statement: a transition line cannot begin with one. */
const DIRECTIVE_WORDS = new Set([
  "default",
  "class",
  "classDef",
  "style",
  "state",
  "note",
  "direction",
  "hide",
  "scale",
  "click",
  "link",
  "callback",
  "title",
  "accTitle",
  "accDescr",
]);

export async function editState(source: string, edit: DiagramEdit): Promise<DiagramEditResult> {
  const refuse = (code: string, existingId?: string): DiagramEditResult =>
    existingId === undefined ? { ok: false, source, code } : { ok: false, source, code, existingId };
  if (edit.kind === "change-shape" || edit.kind === "direction") return refuse("edit_unsupported_for_family");
  if (
    edit.kind === "add-node" &&
    (edit.shape !== undefined || edit.element !== undefined || edit.external !== undefined)
  )
    return refuse("edit_unsupported_for_family");
  if (edit.kind === "connect" && (edit.line !== undefined || edit.relation !== undefined))
    return refuse("edit_unsupported_for_family");
  const compiled = await compile(source);
  const preamble = readPreamble(source);
  const header = preamble.header;
  if (header === undefined || compiled.model?.type !== "state-machine")
    return withDiagnostic(refuse("edit_requires_valid_state"), compiled);
  const before = compiled.model;
  const expected = structuredClone(before);
  const scan = scanState(header, preamble.statements);
  if (scan.states.length !== before.states.length || scan.transitions.length !== before.transitions.length)
    return refuse("edit_source_mapping_ambiguous");
  // Written again below (the compiler warns and ignores the repeat): removing or moving this line would draw the repeat.
  if ((edit.kind === "delete-edge" || edit.kind === "retarget-edge") && scan.ignored.some((t) => t.id === edit.id))
    return refuse("edit_source_mapping_ambiguous");

  // Physical lines with their offsets; the preamble keeps every statement on its source line.
  const physical = [...source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/gu)].map((m) => ({
    start: m.index,
    textEnd: m.index + m[1]!.length,
    end: m.index + m[0].length,
  }));
  const offset = (line: SourceLine, at: Position) => physical[line.number - 1]!.start + offsetOf(line.text, at.column);
  const newline = /\r\n|\r|\n/u.exec(source)?.[0] ?? "\n";

  // Each statement line's scope, and each composite's closing `}`.
  const statements = preamble.statements.filter(
    (l) => l.number > header.number && !isBlank(l.text) && !isCommentLine(l.text),
  );
  const scopeOf = new Map<SourceLine, string | undefined>();
  const closeOf = new Map<string, SourceLine>();
  const open: string[] = [];
  for (const line of statements) {
    const trimmed = line.text.trim();
    if (trimmed === "}") {
      const closed = open.pop();
      scopeOf.set(line, open.at(-1));
      if (closed !== undefined) closeOf.set(closed, line);
      continue;
    }
    scopeOf.set(line, open.at(-1));
    const declared = DECLARATION.exec(trimmed);
    if (declared?.[4] !== undefined) open.push(bareName(declared[2]!));
  }
  /** The lines that declare `id`: `state …` forms and `id : label`. */
  const declarations = (id: string) =>
    statements.filter((line) => {
      const trimmed = line.text.trim();
      if (/^state\s/u.test(trimmed)) return bareName(DECLARATION.exec(trimmed)?.[2] ?? "") === id;
      if (trimmed.includes("-->") || /^note\s/iu.test(trimmed)) return false;
      return bareName(DESCRIBED.exec(trimmed)?.[1] ?? "") === id;
    });

  let candidate = source;
  let kept: [number, number] = [0, source.length];
  const splice = (start: number, end: number, text: string) => {
    candidate = source.slice(0, start) + text + source.slice(end);
    kept = [start, end];
  };
  const removeLine = (line: SourceLine) => {
    const here = physical[line.number - 1]!;
    // The last line has no line break of its own: take the one before it, so no break is added or left (a blank line before it stays).
    if (
      here.end === here.textEnd &&
      line.number > 1 &&
      physical[line.number - 2]!.textEnd > physical[line.number - 2]!.start
    )
      splice(physical[line.number - 2]!.textEnd, here.end, "");
    else splice(here.start, here.end, "");
  };
  /** Add a statement line at the end of `scope`: the source's end, or before the composite's `}`. */
  const insert = (scope: string | undefined, text: string): number => {
    const inside = statements.filter(
      (l) => scopeOf.get(l) === scope && (scope === undefined || l !== closeOf.get(scope)),
    );
    if (scope === undefined) {
      const ended = /[\r\n]$/u.test(source);
      const indent = inside.at(-1)?.indent ?? "    ";
      splice(source.length, source.length, (ended ? "" : newline) + indent + text + (ended ? newline : ""));
      return statements.length;
    }
    const close = closeOf.get(scope)!;
    const indent = inside.at(-1)?.indent ?? close.indent + "    ";
    const at = physical[close.number - 1]!.start;
    splice(at, at, indent + text + newline);
    return statements.indexOf(close);
  };
  const lineIndex = (line: SourceLine) => statements.indexOf(line);
  const find = (id: string): ScannedState | undefined => scan.states.find((s) => s.id === id);
  const startEnd = (s: ScannedState) => s.kind === "initial" || s.kind === "final";

  if (edit.kind === "add-node") {
    const kind = edit.state ?? "state";
    if (!STATE_NODE_KINDS.includes(kind)) return refuse("edit_invalid_state_kind");
    if (!STATE_ID.test(edit.id)) return refuse("edit_invalid_id");
    const scopes = ["root", ...scan.states.filter((s) => s.composite).map((s) => s.id)];
    if (scopes.some((scope) => edit.id === `${scope}_start` || edit.id === `${scope}_end`))
      return refuse("edit_id_reserved");
    if (find(edit.id)) return refuse("edit_id_exists");
    const added: StateNode = { id: edit.id as StableId, label: edit.id };
    if (kind === "state") {
      // Mermaid draws no unconnected `state X`, so a new state always carries a label: the UI's
      // add-then-type flow sends '' and gets the ID as the label until the name is typed.
      const label = edit.label === "" ? edit.id : edit.label;
      const problem = labelProblem(label);
      if (problem) return refuse(problem);
      added.label = label;
      insert(undefined, `state "${encodeStateLabel(label)}" as ${edit.id}`);
    } else {
      // A pseudo-state has no label in the source: it is drawn by its kind and named by its ID.
      if (edit.label !== "" && edit.label !== edit.id) return refuse("edit_label_unsupported");
      added.kind = kind;
      insert(undefined, `state ${edit.id} <<${kind}>>`);
    }
    expected.states.push(added);
  } else if (edit.kind === "connect") {
    /** How an end is written, the state ID it compiles to, and the scope it must be written in. */
    const end = (
      raw: string,
      role: "source" | "target",
    ): { written: string; id: string; scope: string | undefined; startEnd: boolean } | string => {
      if (raw === STATE_START_END)
        return { written: raw, id: role === "source" ? "root_start" : "root_end", scope: undefined, startEnd: true };
      const state = find(raw);
      if (!state) return "edit_target_missing";
      if (state.kind === "initial" || state.kind === "final") {
        // An existing start or end, chosen by its ID: written `[*]` in its own scope.
        if ((state.kind === "initial") !== (role === "source")) return "edit_invalid_endpoint";
        return { written: STATE_START_END, id: state.id, scope: state.scope, startEnd: true };
      }
      if (DIRECTIVE_WORDS.has(raw)) return "edit_id_reserved";
      return { written: raw, id: raw, scope: state.scope, startEnd: false };
    };
    const from = end(edit.source, "source");
    if (typeof from === "string") return refuse(from);
    const to = end(edit.target, "target");
    if (typeof to === "string") return refuse(to);
    // `[*] --> [*]` compiles but connects no state: refuse it like any other marker misuse.
    if (from.startEnd && to.startEnd) return refuse("edit_invalid_endpoint");
    if (from.scope !== to.scope)
      return refuse(from.startEnd || to.startEnd ? "edit_start_end_scope" : "edit_scope_mismatch");
    const id = `${from.id}--${to.id}`;
    if (edit.id !== undefined && edit.id !== id) return refuse("edit_relationship_id_derived");
    const existing = scan.transitions.find((t) => t.id === id);
    if (existing) return refuse("edit_relationship_exists", existing.id);
    if (id.length > MAX_ID_CHARS) return refuse("edit_invalid_id");
    const labelled = edit.label !== undefined && edit.label !== "";
    if (labelled) {
      const problem = labelProblem(edit.label);
      if (problem) return refuse(problem);
    }
    const index = insert(
      from.scope,
      `${from.written} --> ${to.written}${labelled ? ` : ${encodeStateLabel(edit.label!)}` : ""}`,
    );
    const added: StateTransition = { id: id as StableId, source: from.id as StableId, target: to.id as StableId };
    if (labelled) added.label = edit.label!;
    const position = scan.transitions.filter((t) => lineIndex(t.line) < index).length;
    expected.transitions.splice(position, 0, added);
    for (const e of [from, to]) {
      if (!find(e.id) && !expected.states.some((s) => s.id === e.id)) {
        expected.states.push({
          id: e.id as StableId,
          label: e === from ? "start" : "end",
          kind: e === from ? "initial" : "final",
        });
      }
    }
  } else if (edit.kind === "relabel-node") {
    const state = find(edit.id);
    if (!state) return refuse("edit_target_missing");
    if (state.kind !== "state") return refuse("edit_relabel_unsupported");
    const problem = labelProblem(edit.label);
    if (problem) return refuse(problem);
    const modelled = expected.states.find((s) => s.id === edit.id);
    if (!modelled) return refuse("edit_source_mapping_ambiguous");
    if (modelled.label === edit.label) return { ok: true, source };
    const text = encodeStateLabel(edit.label);
    if (state.labelSpan !== undefined) {
      const line = statements.find((l) => l.number === state.labelSpan!.start.line);
      if (!line) return refuse("edit_source_mapping_ambiguous");
      const span = labelRange(line, state.labelSpan);
      if (!span) return refuse("edit_source_mapping_ambiguous");
      const base = physical[line.number - 1]!.start;
      splice(base + span[0], base + span[1], text);
    } else {
      // A bare `state X` (or `state X {`): give it the quoted label form.
      const lines = declarations(edit.id);
      if (lines.length !== 1) return refuse("edit_source_mapping_ambiguous");
      const line = lines[0]!;
      const match = DECLARATION.exec(line.text.trim());
      if (!match || match[1] !== undefined || match[3] !== undefined) return refuse("edit_source_mapping_ambiguous");
      // Mermaid misreads `state "L" as X:::class`: move the class to a `class X name` line first.
      if (match[2]!.includes(":::")) return refuse("edit_relabel_styled_declaration");
      const at = physical[line.number - 1]!.start + line.indent.length + match.indices![2]![0];
      splice(at, at, `"${text}" as `);
    }
    modelled.label = edit.label;
  } else if (edit.kind === "relabel-edge") {
    const transition = scan.transitions.find((t) => t.id === edit.id);
    if (!transition) return refuse("edit_target_missing");
    const modelled = expected.transitions.find((t) => t.id === edit.id);
    if (!modelled) return refuse("edit_source_mapping_ambiguous");
    if ((modelled.label ?? "") === edit.label) return { ok: true, source };
    const targetEnd = offset(transition.line, transition.span.end);
    if (edit.label === "") {
      // Remove ` : label`, keeping whatever followed it.
      splice(targetEnd, offset(transition.line, transition.labelSpan!.end), "");
      delete modelled.label;
    } else {
      const problem = labelProblem(edit.label);
      if (problem) return refuse(problem);
      const text = encodeStateLabel(edit.label);
      if (transition.labelSpan === undefined) splice(targetEnd, targetEnd, ` : ${text}`);
      else
        splice(
          offset(transition.line, transition.labelSpan.start),
          offset(transition.line, transition.labelSpan.end),
          text,
        );
      modelled.label = edit.label;
    }
  } else if (edit.kind === "retarget-edge") {
    if (edit.message !== undefined) return refuse("edit_unsupported_for_family");
    if (edit.source === undefined && edit.target === undefined) return refuse("edit_endpoint_required");
    const transition = scan.transitions.find((t) => t.id === edit.id);
    if (!transition) return refuse("edit_target_missing");
    // The line stays where it is, so both ends must belong to the scope it is written in.
    const scope = scopeOf.get(transition.line);
    if (!scopeOf.has(transition.line)) return refuse("edit_source_mapping_ambiguous");
    /** An end as written and the state ID it compiles to; `[*]` is this scope's start (source) or end (target). */
    const end = (
      raw: string,
      role: "source" | "target",
    ): { written: string; id: string; startEnd: boolean } | string => {
      if (raw === STATE_START_END)
        return { written: raw, id: `${scope ?? "root"}_${role === "source" ? "start" : "end"}`, startEnd: true };
      const state = find(raw);
      if (!state) return "edit_target_missing";
      if (startEnd(state)) {
        if ((state.kind === "initial") !== (role === "source")) return "edit_invalid_endpoint";
        if (state.scope !== scope) return "edit_start_end_scope";
        return { written: STATE_START_END, id: state.id, startEnd: true };
      }
      if (state.scope !== scope) return "edit_scope_mismatch";
      if (DIRECTIVE_WORDS.has(raw)) return "edit_id_reserved";
      return { written: raw, id: raw, startEnd: false };
    };
    const from = edit.source === undefined ? undefined : end(edit.source, "source");
    if (typeof from === "string") return refuse(from);
    const to = edit.target === undefined ? undefined : end(edit.target, "target");
    if (typeof to === "string") return refuse(to);
    if ((from?.startEnd ?? startEnd(find(transition.source)!)) && (to?.startEnd ?? startEnd(find(transition.target)!)))
      return refuse("edit_invalid_endpoint");
    const sourceId = from?.id ?? transition.source;
    const targetId = to?.id ?? transition.target;
    const id = `${sourceId}--${targetId}`;
    if (id === transition.id) return { ok: true, source };
    const existing = scan.transitions.find((t) => t.id === id);
    if (existing) return refuse("edit_relationship_exists", existing.id);
    if (id.length > MAX_ID_CHARS) return refuse("edit_invalid_id");
    const text = transition.line.text;
    const written = (range: [number, number]) => text.slice(range[0], range[1]);
    const [left, right] = [transition.sourceRange, transition.targetRange];
    const changed = { source: sourceId !== transition.source, target: targetId !== transition.target };
    // A `:::class` on an end styles that state: a new name would move it.
    if ((changed.source && written(left).includes(":::")) || (changed.target && written(right).includes(":::")))
      return refuse("edit_retarget_inline_declaration");
    const asWritten = (range: [number, number], id: string) => {
      const raw = written(range);
      return raw === STATE_START_END ? startEnd(find(id)!) : bareName(raw) === id;
    };
    if (!asWritten(left, transition.source) || !asWritten(right, transition.target) || left[1] > right[0])
      return refuse("edit_source_mapping_ambiguous");
    // An old end this transition alone named: a start or end goes with it; a bare state would no longer be drawn.
    const others = scan.transitions.filter((t) => t !== transition);
    for (const old of [
      changed.source ? transition.source : undefined,
      changed.target ? transition.target : undefined,
    ]) {
      if (
        old === undefined ||
        old === sourceId ||
        old === targetId ||
        others.some((t) => t.source === old || t.target === old)
      )
        continue;
      const state = find(old)!;
      if (startEnd(state)) expected.states = expected.states.filter((s) => s.id !== old);
      else if (state.kind === "state" && !state.composite && state.labelSpan === undefined)
        return refuse("edit_retarget_leaves_undrawn_state");
    }
    const base = physical[transition.line.number - 1]!.start;
    if (source.slice(base, physical[transition.line.number - 1]!.textEnd) !== text)
      return refuse("edit_source_mapping_ambiguous");
    const newLeft = changed.source ? from!.written : written(left);
    const newRight = changed.target ? to!.written : written(right);
    candidate =
      source.slice(0, base + left[0]) +
      newLeft +
      source.slice(base + left[1], base + right[0]) +
      newRight +
      source.slice(base + right[1]);
    kept = [base + left[0], base + right[1]];
    const modelled = expected.transitions.find((t) => t.id === edit.id);
    if (!modelled) return refuse("edit_source_mapping_ambiguous");
    modelled.id = id as StableId;
    modelled.source = sourceId as StableId;
    modelled.target = targetId as StableId;
    for (const e of [from, to]) {
      if (e?.startEnd && !expected.states.some((s) => s.id === e.id)) {
        expected.states.push({
          id: e.id as StableId,
          label: e === from ? "start" : "end",
          kind: e === from ? "initial" : "final",
        });
      }
    }
  } else if (edit.kind === "delete-edge") {
    const transition = scan.transitions.find((t) => t.id === edit.id);
    if (!transition) return refuse("edit_target_missing");
    const others = scan.transitions.filter((t) => t !== transition);
    const used = (id: string) => others.some((t) => t.source === id || t.target === id);
    for (const id of new Set([transition.source, transition.target])) {
      const state = find(id)!;
      if (used(id)) continue;
      if (startEnd(state)) expected.states = expected.states.filter((s) => s.id !== id);
      // Mermaid draws no `state X` that has no label and no transition.
      else if (state.kind === "state" && !state.composite && state.labelSpan === undefined)
        return refuse("edit_delete_leaves_undrawn_state");
    }
    removeLine(transition.line);
    expected.transitions = expected.transitions.filter((t) => t.id !== edit.id);
  } else if (edit.kind === "delete-node") {
    const state = find(edit.id);
    if (!state) return refuse("edit_target_missing");
    if (startEnd(state) || scan.transitions.some((t) => t.source === edit.id || t.target === edit.id))
      return refuse("edit_delete_referenced_node");
    if (state.composite) return refuse("edit_delete_composite_unsupported");
    if (state.note !== undefined) return refuse("edit_delete_note_dependency");
    const styled = statements.some(
      (l) =>
        /^(?:class|style)\s/u.test(l.text.trim()) &&
        l.text
          .trim()
          .split(/[\s,]+/u)
          .slice(1)
          .includes(edit.id),
    );
    if (styled) return refuse("edit_delete_styling_dependency");
    const lines = declarations(edit.id);
    if (lines.length !== 1) return refuse("edit_delete_nonisolated_declaration");
    removeLine(lines[0]!);
    expected.states = expected.states.filter((s) => s.id !== edit.id);
  } else {
    return refuse("edit_unsupported_for_family");
  }

  // Every byte outside the splice is the source's own.
  const [start, finish] = kept;
  const tail = source.length - finish;
  if (
    candidate.slice(0, start) !== source.slice(0, start) ||
    candidate.slice(candidate.length - tail) !== source.slice(finish)
  )
    return refuse("edit_invalid_result");
  const after = await compile(candidate);
  if (after.model?.type !== "state-machine" || !isDeepStrictEqual(normalised(after.model), normalised(expected)))
    return refuse("edit_invalid_result");
  return { ok: true, source: candidate };
}

/** The offsets on `line` of a scanned label span, checked against the label form it is written in. */
function labelRange(line: SourceLine, span: Span): [number, number] | undefined {
  const start = offsetOf(line.text, span.start.column);
  const end = offsetOf(line.text, span.end.column);
  if (line.text[start - 1] === '"') {
    // `state "L" as X`: the span runs to the closing quote.
    const close = line.text.indexOf('"', start);
    return close === -1 ? undefined : [start, close];
  }
  // `X : L`: the span is the trimmed text after the colon, to the line's end.
  const colon = line.text.lastIndexOf(":", start);
  if (colon === -1 || line.text.slice(colon + 1).trim() !== line.text.slice(start, end)) return undefined;
  return [start, end];
}
