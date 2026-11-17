// Reads a state diagram line by line for what Mermaid's database cannot say:
// where each state, transition and note is written, which scope (composite
// state) each state belongs to, which states were declared, and the
// constructs outside the profile.
//
// The profile, statement by statement:
//   state Id                         a state
//   state "Label" as Id              a state with a label
//   Id : Label                       likewise
//   state Id <<choice>>              a choice, fork or join pseudo-state
//   state Id {  ...  }               a composite state
//   A --> B   /   A --> B : label    a transition; [*] is the scope's start or end
//   note left of Id : text           a note on a state (right of, likewise)
//   direction LR                     the diagram's direction, at the top level
//   classDef, class, style, :::name  styling: accepted and ignored

import type { Direction, StateKind, StateNotePosition } from "../../model/index.ts";
import { MAX_ID_CHARS } from "../../model/index.ts";
import type { Span } from "../diagnostics.ts";
import { MAX_NESTING_DEPTH } from "../limits.ts";
import { isBlank, isCommentLine, type SourceLine } from "../source.ts";
import { invalidIdMessage, repeatedMessage, Report, textSpan } from "../statements.ts";

export interface ScannedState {
  id: string;
  /** The composite state it is written inside; undefined at the top level. */
  scope: string | undefined;
  kind: StateKind;
  declared: boolean;
  composite: boolean;
  line: SourceLine;
  /** Its first mention. */
  span: Span;
  /** Where it is declared (`state X`, `state X {`), when it is. */
  declaredAt?: Span;
  /** Where its label is written, when it has one of its own. */
  labelSpan: Span | undefined;
  note: { position: StateNotePosition; span: Span } | undefined;
  /** Named by a transition. */
  connected: boolean;
}

export interface ScannedTransition {
  id: string;
  source: string;
  target: string;
  line: SourceLine;
  span: Span;
  labelSpan: Span | undefined;
  /** Each end as written (`[*]`, or a name with any `:::class`), as UTF-16 offsets into `line.text`. */
  sourceRange: [number, number];
  targetRange: [number, number];
}

export interface StateScan {
  report: Report;
  /** In order of first mention. */
  states: ScannedState[];
  transitions: ScannedTransition[];
  /** Transitions written again between the same two states: Mermaid reads them, Archer does not draw them. */
  ignored: ScannedTransition[];
  direction: Direction | undefined;
  stopped: boolean;
}

const STATE_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_]{0,${MAX_ID_CHARS - 1}}$`);
const PSEUDO = new Set<StateKind>(["choice", "fork", "join"]);
const DECLARATION = /^state\s+(?:"([^"]*)"\s+as\s+)?(\S+?)(?:\s*<<\s*(\w+)\s*>>)?(\s*\{)?$/d;
const EXAMPLE = '`state Idle`, `state "Waiting" as Idle` or `Idle : Waiting`';

interface Scope {
  id: string;
  line: SourceLine;
  at: Span;
}

class Scanner {
  readonly report = new Report();
  readonly scan: StateScan = {
    report: this.report,
    states: [],
    transitions: [],
    ignored: [],
    direction: undefined,
    stopped: false,
  };
  readonly #states = new Map<string, ScannedState>();
  readonly #scopes: Scope[] = [];
  #inNote: SourceLine | undefined;

  get #scope(): string | undefined {
    return this.#scopes.at(-1)?.id;
  }

  line(line: SourceLine): void {
    const text = line.text;
    const start = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (this.#inNote) {
      // The body of a refused multi-line note, up to its `end note`.
      if (/^end\s+note$/i.test(trimmed)) this.#inNote = undefined;
      return;
    }
    if (trimmed === "}") return this.#close(line, start);
    if (trimmed === "--") {
      return this.report.unsupported(
        line,
        "a concurrent region (`--`)",
        "draw the regions as separate composite states",
      );
    }
    const word = /^[^\s:]+/.exec(trimmed)?.[0] ?? "";
    if (word === "classDef" || word === "class" || word === "style") return this.report.styling(line);
    this.report.delimiters(line, ";");
    if (word === "direction") return this.#direction(line, trimmed);
    if (word === "state") {
      if (this.report.trailingComment(line, start)) return;
      return this.#declaration(line, start, trimmed);
    }
    if (word.toLowerCase() === "note") return this.#note(line, start, trimmed);
    if (/^(hide|scale|click|acctitle|accdescr)/i.test(word)) {
      return this.report.unsupported(line, `\`${word}\``, "remove it");
    }
    const arrow = text.indexOf("-->", start);
    if (arrow !== -1) return this.#transition(line, start, arrow);
    const colon = /^([^\s:]+)\s*:(?!::)/.exec(trimmed);
    if (colon) return this.#described(line, start, colon[1] ?? "");
    this.report.unsupported(
      line,
      "this statement",
      `a state diagram line is a declaration (${EXAMPLE}), a transition (\`A --> B : event\`), a note or \`}\``,
    );
  }

  /** The state named `raw` at `offset`, with any `:::class` suffix ignored as styling. */
  #name(line: SourceLine, raw: string, offset: number): string | undefined {
    let id = raw;
    const styled = raw.indexOf(":::");
    if (styled > 0) {
      id = raw.slice(0, styled);
      this.report.styling(line);
    }
    if (!STATE_ID.test(id)) {
      this.report.error(line, "invalid_id", invalidIdMessage("state", id), line.span(offset, offset + id.length), []);
      return undefined;
    }
    return id;
  }

  #mention(line: SourceLine, id: string, span: Span, kind: StateKind = "state"): ScannedState | undefined {
    const scope = this.#scope;
    const known = this.#states.get(id);
    if (known === undefined) {
      const state: ScannedState = {
        id,
        scope,
        kind,
        declared: kind === "initial" || kind === "final",
        composite: false,
        line,
        span,
        labelSpan: undefined,
        note: undefined,
        connected: false,
      };
      this.#states.set(id, state);
      this.scan.states.push(state);
      return state;
    }
    if (known.scope !== scope) {
      const where = known.scope === undefined ? "at the top level" : `inside the composite state '${known.scope}'`;
      this.report.error(
        line,
        "state_scope",
        `state '${id}' is ${where} (line ${known.line.number}), and Mermaid moves or joins a state named in two places: ` +
          `write every transition and note naming it ${where}, or make the transition to the composite state itself`,
        span,
      );
      return undefined;
    }
    return known;
  }

  /** `[*]` or a state ID, as one end of a transition. */
  #end(line: SourceLine, raw: string, offset: number, role: "source" | "target"): string | undefined {
    if (raw === "[*]") {
      const id = `${this.#scope ?? "root"}_${role === "source" ? "start" : "end"}`;
      this.#mention(line, id, line.span(offset, offset + 3), role === "source" ? "initial" : "final");
      return id;
    }
    const id = this.#name(line, raw, offset);
    if (id === undefined) return undefined;
    const state = this.#mention(line, id, line.span(offset, offset + id.length));
    if (state === undefined) return undefined;
    state.connected = true;
    return id;
  }

  #direction(line: SourceLine, trimmed: string): void {
    const match = /^direction\s+(TB|BT|LR|RL)$/.exec(trimmed);
    if (!match) return this.report.unsupported(line, "this direction", "write `direction` and one of TB, BT, LR or RL");
    if (this.#scope !== undefined) {
      return this.report.unsupported(
        line,
        "`direction` inside a composite state",
        "remove it; the diagram's direction applies throughout",
      );
    }
    if (this.scan.direction !== undefined) {
      return this.report.error(
        line,
        "duplicate_direction",
        "the direction is set more than once: keep one `direction` line",
      );
    }
    const written = (match[1] ?? "TB").toLowerCase();
    this.scan.direction = written as Direction;
  }

  #declaration(line: SourceLine, start: number, trimmed: string): void {
    const match = DECLARATION.exec(trimmed);
    if (!match) {
      return this.report.unsupported(
        line,
        "this `state` statement",
        `declare a state as ${EXAMPLE}, or a composite as \`state Id {\``,
      );
    }
    const [, label, raw = "", kindWord, brace] = match;
    const idStart = start + (match.indices?.[2]?.[0] ?? 0);
    const id = this.#name(line, raw, idStart);
    if (id === undefined) {
      if (brace) this.#open(line, raw, line.span(idStart, idStart + raw.length));
      return;
    }
    const span = line.span(idStart, idStart + id.length);
    let kind: StateKind = "state";
    if (kindWord !== undefined) {
      const lower = kindWord.toLowerCase();
      if (!PSEUDO.has(lower as StateKind)) {
        this.report.unsupported(line, `\`<<${kindWord}>>\``, "use `<<choice>>`, `<<fork>>` or `<<join>>`");
        return;
      }
      kind = lower as StateKind;
      if (brace) {
        this.report.unsupported(line, `a ${kind} with a body`, `a ${kind} is a point: remove the \`{\``);
        return;
      }
    }
    const state = this.#mention(line, id, span);
    if (state === undefined) {
      if (brace) this.#open(line, id, span);
      return;
    }
    state.declared = true;
    state.declaredAt ??= span;
    if (kind !== "state") {
      if (state.kind !== "state")
        this.report.error(
          line,
          "duplicate_declaration",
          `state '${id}' is given a kind more than once: keep one`,
          span,
        );
      state.kind = kind;
    }
    if (label !== undefined) {
      const labelStart = line.text.indexOf('"', start) + 1;
      this.#label(line, state, label, line.span(labelStart, labelStart + Math.max(label.length, 1)));
    }
    if (brace) {
      if (state.composite) {
        this.report.error(
          line,
          "duplicate_declaration",
          `composite state '${id}' is written twice: write its states in one block`,
          span,
        );
      }
      state.composite = true;
      this.#open(line, id, span);
    }
  }

  #label(line: SourceLine, state: ScannedState, label: string, at: Span): void {
    if (label.trim() === "") {
      this.report.error(line, "expected_label", `expected a label for state '${state.id}': ${EXAMPLE}`, at);
      return;
    }
    if (state.labelSpan !== undefined) {
      this.report.error(
        line,
        "duplicate_declaration",
        `state '${state.id}' already has a label (line ${state.labelSpan.start.line}): a state takes one label`,
        at,
      );
      return;
    }
    state.labelSpan = at;
  }

  #described(line: SourceLine, start: number, raw: string): void {
    const id = this.#name(line, raw, start);
    if (id === undefined) return;
    const state = this.#mention(line, id, line.span(start, start + id.length));
    if (state === undefined) return;
    state.declared = true;
    const colon = line.text.indexOf(":", start + raw.length);
    if (this.report.trailingComment(line, colon + 1)) return;
    this.#label(line, state, line.text.slice(colon + 1), textSpan(line, colon + 1));
  }

  #open(line: SourceLine, id: string, at: Span): void {
    if (this.#scopes.length >= MAX_NESTING_DEPTH) {
      this.report.error(
        line,
        "nesting_too_deep",
        `this composite state is nested ${MAX_NESTING_DEPTH + 1} deep, and composite states nest at most ${MAX_NESTING_DEPTH}. ` +
          "Flatten the nesting, or split the diagram into views. Nothing after this line was checked.",
        at,
      );
      this.scan.stopped = true;
      return;
    }
    this.#scopes.push({ id, line, at });
  }

  #close(line: SourceLine, start: number): void {
    if (this.#scopes.pop() === undefined) {
      this.report.error(line, "unexpected_token", "`}` with no composite state to close", line.span(start));
    }
  }

  #note(line: SourceLine, start: number, trimmed: string): void {
    const match = /^note\s+(left|right)\s+of\s+(\S+?)\s*(:.*)?$/di.exec(trimmed);
    if (!match) {
      return this.report.unsupported(
        line,
        "this note",
        "attach a one-line note to a state: `note right of Idle : text`",
      );
    }
    const [, side = "", raw = "", body] = match;
    if (body === undefined) {
      this.#inNote = line;
      return this.report.unsupported(
        line,
        "a note over several lines",
        "write the note on one line: `note right of Idle : text`",
      );
    }
    const idStart = start + (match.indices?.[2]?.[0] ?? 0);
    const id = this.#name(line, raw, idStart);
    if (id === undefined) return;
    const span = line.span(idStart, idStart + id.length);
    const state = this.#mention(line, id, span);
    if (state === undefined) return;
    const colon = line.text.indexOf(":", idStart + raw.length);
    if (line.text.slice(colon + 1).trim() === "") {
      return this.report.error(
        line,
        "expected_label",
        "expected the note's text after `:`: `note right of Idle : text`",
        line.span(colon),
      );
    }
    if (this.report.trailingComment(line, colon + 1)) return;
    if (state.note !== undefined) {
      return this.report.error(
        line,
        "duplicate_note",
        `state '${id}' already has a note (line ${state.note.span.start.line}): a state takes one note; put both in one`,
        span,
      );
    }
    state.note = { position: side.toLowerCase() === "left" ? "left-of" : "right-of", span: textSpan(line, colon + 1) };
  }

  #transition(line: SourceLine, start: number, arrow: number): void {
    const text = line.text;
    const left = text.slice(start, arrow).trim();
    let after = arrow + 3;
    while (text[after] === " " || text[after] === "\t") after += 1;
    let end = after;
    while (end < text.length && !/[\s:]/.test(text[end] ?? "")) end += 1;
    // A `:::class` suffix belongs to the target.
    while (text.startsWith(":::", end)) {
      end += 3;
      while (end < text.length && !/[\s:]/.test(text[end] ?? "")) end += 1;
    }
    const right = text.slice(after, end);
    const rest = text.slice(end);
    const restTrimmed = rest.trim();
    if (left === "" || right === "" || (restTrimmed !== "" && !restTrimmed.startsWith(":"))) {
      return this.report.unsupported(
        line,
        "this transition",
        "write one transition per line: `A --> B` or `A --> B : event`",
      );
    }
    const source = this.#end(line, left, start, "source");
    const target = this.#end(line, right, after, "target");
    let labelSpan: Span | undefined;
    if (restTrimmed.startsWith(":")) {
      const colon = text.indexOf(":", end);
      if (this.report.trailingComment(line, colon + 1)) return;
      if (text.slice(colon + 1).trim() === "") {
        return this.report.error(
          line,
          "expected_label",
          "expected the event after `:`, or no `:`: `A --> B : event`",
          line.span(colon),
        );
      }
      labelSpan = textSpan(line, colon + 1);
    } else if (this.report.trailingComment(line, end)) return;
    if (source === undefined || target === undefined) return;
    const id = `${source}--${target}`;
    const span = line.span(start, end);
    const transition = {
      id,
      source,
      target,
      line,
      span,
      labelSpan,
      sourceRange: [start, start + left.length] as [number, number],
      targetRange: [after, end] as [number, number],
    };
    const first = this.scan.transitions.find((written) => written.id === id);
    if (first !== undefined) {
      this.report.warning(
        line,
        "duplicate_transition",
        repeatedMessage(
          "transition",
          source,
          target,
          first.line.number,
          "Write one transition, with every event in its label (`A --> B : start / resume`).",
        ),
        span,
      );
      this.scan.ignored.push(transition);
      return;
    }
    if (id.length > MAX_ID_CHARS) {
      return this.report.error(
        line,
        "id_too_long",
        `this transition's ID, '${source}--${target}', is longer than ${MAX_ID_CHARS} characters: shorten the state IDs`,
        span,
      );
    }
    this.scan.transitions.push(transition);
  }

  finish(): void {
    if (!this.scan.stopped) {
      for (const scope of this.#scopes) {
        this.report.error(
          scope.line,
          "unclosed_block",
          `composite state '${scope.id}' is never closed: add \`}\` after its last line`,
          scope.at,
        );
      }
    }
    const composites = this.scan.states.filter((state) => state.composite).map((state) => state.id);
    const reserved = new Set(["root", ...composites].flatMap((scope) => [`${scope}_start`, `${scope}_end`]));
    for (const state of this.scan.states) {
      if (state.kind === "initial" || state.kind === "final") continue;
      if (reserved.has(state.id) || (state.id === "root" && state.composite)) {
        this.report.error(
          state.line,
          "reserved_id",
          `Mermaid names the start and end of each scope \`<scope>_start\` and \`<scope>_end\` (\`root\` at the top level), ` +
            `so '${state.id}' would be the same state as a \`[*]\`: rename it`,
          state.span,
        );
      } else if (
        state.declared &&
        !state.connected &&
        state.kind === "state" &&
        !state.composite &&
        state.labelSpan === undefined
      ) {
        // Mermaid draws nothing for a bare `state X` that no transition names
        // (mermaid 12.1.0), and a broken shape when it only has a note.
        this.report.error(
          state.line,
          "undrawn_state",
          `Mermaid does not draw state '${state.id}', which is declared but in no transition: connect it with a transition, ` +
            `or give it a label (\`${state.id} : Label\`)`,
          state.span,
        );
      } else if (!state.declared) {
        this.report.error(
          state.line,
          "undeclared_state",
          `state '${state.id}' is never declared: add \`state ${state.id}\` (or \`${state.id} : Label\`)` +
            `${state.scope === undefined ? "" : ` inside '${state.scope}'`}, or fix the name if it is a typo`,
          state.span,
        );
      }
    }
  }
}

export function scanState(header: SourceLine, statements: readonly SourceLine[]): StateScan {
  const scanner = new Scanner();
  const extra = header.text
    .trim()
    .replace(/^stateDiagram(-v2)?/, "")
    .trim();
  if (extra !== "")
    scanner.report.unsupported(header, "text after the header", "write `stateDiagram-v2` alone on its line");
  for (const line of statements) {
    if (line.number <= header.number || isBlank(line.text) || isCommentLine(line.text)) continue;
    scanner.line(line);
    if (scanner.scan.stopped) break;
  }
  scanner.finish();
  return scanner.scan;
}
