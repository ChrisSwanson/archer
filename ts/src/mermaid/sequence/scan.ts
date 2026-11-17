// Reads a sequence diagram line by line for what Mermaid's database cannot
// say: which participants were declared and where, where each message, note
// and fragment is written, how deep fragments nest, which activations close
// nothing, and the constructs outside the profile.

import type { ParticipantKind } from "../../model/index.ts";
import { error, type Diagnostic, type Span } from "../diagnostics.ts";
import { moveCommentEdits, type Edit, type Finding } from "../findings.ts";
import { MAX_NESTING_DEPTH } from "../limits.ts";
import { isBlank, isCommentLine, type SourceLine } from "../source.ts";

export interface Declaration {
  id: string;
  kind: ParticipantKind;
  span: Span;
  /** Where the label is: the alias, or the ID when there is none. */
  labelSpan: Span;
}

export interface SequenceScan {
  findings: Finding[];
  /** In declaration order. */
  declarations: Declaration[];
  /** Label positions, in source order, for the records Mermaid makes of each. */
  messages: Span[];
  notes: Span[];
  /** Fragment openers and their `else`/`and` sections, in source order. */
  sections: Span[];
  stopped: boolean;
}

type FragmentKeyword = "loop" | "alt" | "opt" | "par";
interface Frame {
  keyword: FragmentKeyword | "refused";
  line: SourceLine;
  at: Span;
}

/** Arrows, longest first, and the supported arrow to write instead. */
const ARROWS: readonly (readonly [string, string | undefined])[] = [
  ["<<-->>", "<<-->>"],
  ["<<->>", "<<->>"],
  ["-->>", "-->>"],
  ["->>", "->>"],
  ["--x", "-->>"],
  ["-x", "->>"],
  ["--)", "-)"],
  ["-)", "-)"],
  ["-->", "-->>"],
  ["->", "->>"],
];
const ARROW = /<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->/;
const REFUSED_BLOCKS = new Set(["rect", "critical", "break", "box"]);
const REFUSED = new Set(["option", "create", "destroy", "link", "links", "properties", "details", "title", "par_over"]);
/**
 * Words Mermaid's sequence lexer reads as keywords wherever they stand, in any
 * case, so a participant cannot be named one (measured against mermaid
 * 12.1.0). The Rust profile allowed them.
 */
export const RESERVED: ReadonlySet<string> = new Set([
  "participant",
  "actor",
  "create",
  "destroy",
  "box",
  "loop",
  "rect",
  "opt",
  "alt",
  "else",
  "par",
  "par_over",
  "and",
  "critical",
  "option",
  "break",
  "end",
  "over",
  "note",
  "activate",
  "deactivate",
  "title",
  "autonumber",
  "off",
]);

/** The text after the first `%%` that is outside a quoted span, or undefined. */
function trailingComment(text: string): number | undefined {
  let quoted = false;
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] === '"') quoted = !quoted;
    else if (!quoted && text.startsWith("%%", index)) return index;
  }
  return undefined;
}

class Scanner {
  readonly scan: SequenceScan = {
    findings: [],
    declarations: [],
    messages: [],
    notes: [],
    sections: [],
    stopped: false,
  };
  readonly #declared = new Set<string>();
  readonly #uses: { id: string; line: SourceLine; span: Span }[] = [];
  readonly #open = new Map<string, number>();
  readonly #frames: Frame[] = [];

  report(line: SourceLine, diagnostic: Diagnostic, edits: Edit[] = []): void {
    this.scan.findings.push({ diagnostic, line, edits, legacy: false });
  }

  #use(line: SourceLine, id: string, start: number): void {
    this.#uses.push({ id, line, span: line.span(start, start + id.length) });
    this.#checkName(line, id, start);
  }

  #checkName(line: SourceLine, id: string, start: number): void {
    if (!RESERVED.has(id.toLowerCase())) return;
    this.report(
      line,
      error(
        "legacy_syntax",
        `Mermaid reads \`${id}\` as a keyword, so it cannot name a participant: rename it, as in \`${id}1\`, wherever it appears`,
        line.span(start, start + id.length),
      ),
      [{ start, end: start + id.length, replacement: `${id}1` }],
    );
  }

  /**
   * Rust read `%%` after a statement as a comment; Mermaid keeps it as label
   * text. Refused, so an old file's comment never turns into a label.
   */
  #checkComment(line: SourceLine, textStart: number): boolean {
    const comment = trailingComment(line.text.slice(textStart));
    if (comment === undefined) return false;
    const at = textStart + comment;
    this.report(
      line,
      error(
        "legacy_syntax",
        "Mermaid reads `%%` after a statement as part of its text, not as a comment: put the comment on a line of its own, or quote the text",
        line.span(at, line.text.trimEnd().length),
      ),
      moveCommentEdits(line, at),
    );
    return true;
  }

  /**
   * Mermaid's sequence lexer ends the text at `#` (a comment to the end of
   * the line) and ends the statement at `;`, wherever they stand; only entity
   * codes such as `#quot;` survive. Archer would otherwise check and show a
   * line Mermaid reads differently, so each is refused with its escape.
   */
  #checkDelimiters(line: SourceLine): void {
    const masked = line.text.replace(/#\w+;/g, (code) => " ".repeat(code.length));
    for (let index = 0; index < masked.length; index += 1) {
      const character = masked[index];
      if (character === "#") {
        this.report(
          line,
          error(
            "legacy_syntax",
            "Mermaid drops everything from `#` to the end of the line in a sequence diagram: write `#35;` for a literal `#`",
            line.span(index),
          ),
          [{ start: index, end: index + 1, replacement: "#35;" }],
        );
      } else if (character === ";") {
        this.report(
          line,
          error(
            "unsupported_construct",
            "Mermaid ends a statement at `;`, so the rest of the line would be read as another statement: write one statement per line, and `#59;` for a literal `;`",
            line.span(index),
          ),
          [{ start: index, end: index + 1, replacement: "#59;" }],
        );
      }
    }
  }

  line(line: SourceLine): void {
    this.#checkDelimiters(line);
    const text = line.text;
    const start = text.length - text.trimStart().length;
    const trimmed = text.trim();
    const word = (/^[^\s:]+/.exec(trimmed)?.[0] ?? "").toLowerCase();
    const rest = trimmed.slice(word.length);
    const spaced = /^\s/.test(rest);
    const keywordSpan = line.span(start, start + word.length);
    if ((word === "participant" || word === "actor") && spaced) return this.participant(line, start, word);
    if (word === "autonumber") {
      if (rest.trim() !== "") {
        this.report(
          line,
          error(
            "unsupported_construct",
            "only a bare `autonumber` is supported: remove its start, step or `off`",
            line.statementSpan(),
          ),
          [{ start: start + word.length, end: text.length, replacement: "" }],
        );
      }
      return;
    }
    if ((word === "activate" || word === "deactivate") && spaced) return this.activation(line, start, word);
    if (word === "note" && spaced) return this.note(line, start);
    if (["loop", "alt", "opt", "par"].includes(word)) return this.fragment(line, start, word as FragmentKeyword);
    if (word === "else" || word === "and") return this.section(line, start, word);
    if (word === "end" && rest.trim() === "") return this.end(line, keywordSpan);
    if ((REFUSED_BLOCKS.has(word) || REFUSED.has(word)) && (spaced || rest === "")) {
      // The sections and `end` of a refused block follow from refusing it.
      if (word === "option" && this.#frames.at(-1)?.keyword === "refused") return;
      this.report(
        line,
        error("unsupported_construct", `\`${word}\` is not supported in the sequence profile`, keywordSpan),
      );
      if (REFUSED_BLOCKS.has(word)) this.#frames.push({ keyword: "refused", line, at: keywordSpan });
      return;
    }
    if (/^(acctitle|accdescr)/.test(word)) {
      this.report(
        line,
        error("unsupported_construct", "accessibility titles and descriptions are not supported", keywordSpan),
      );
      return;
    }
    this.message(line, start);
  }

  participant(line: SourceLine, start: number, keyword: string): void {
    const text = line.text;
    const match = /^(\S+)\s+(\S+?)(?:(\s+as\s+)(.*?))?\s*$/s.exec(text.slice(start));
    if (!match) return;
    const [, , id = "", asPart, alias] = match;
    const idStart = text.indexOf(id, start + keyword.length);
    const span = line.span(idStart, idStart + id.length);
    if (id.includes("@{")) {
      this.report(line, error("unsupported_construct", "participant metadata (`@{ ... }`) is not supported", span));
      return;
    }
    let labelSpan = span;
    if (asPart !== undefined && alias !== undefined) {
      const aliasStart = idStart + id.length + asPart.length;
      labelSpan = line.span(aliasStart, aliasStart + alias.length);
      if (alias.trim() === "") {
        this.report(
          line,
          error("expected_label", `expected a label after \`as\`: \`${keyword} ${id} as Label\``, span),
        );
      } else if (!this.#checkComment(line, aliasStart) && /^".*"$/.test(alias.trim()) && alias.trim().length >= 2) {
        this.report(
          line,
          error(
            "legacy_syntax",
            "Mermaid shows the quotes around an alias as part of the label: write the alias without them",
            labelSpan,
          ),
          [{ start: aliasStart, end: aliasStart + alias.length, replacement: alias.trim().slice(1, -1) }],
        );
      }
    }
    this.#checkName(line, id, idStart);
    if (this.#declared.has(id)) {
      this.report(
        line,
        error(
          "duplicate_participant",
          `participant '${id}' is declared more than once: declare each participant once`,
          span,
        ),
      );
      return;
    }
    this.#declared.add(id);
    this.scan.declarations.push({ id, kind: keyword === "actor" ? "actor" : "participant", span, labelSpan });
  }

  activation(line: SourceLine, start: number, keyword: string): void {
    const id = line.text.slice(start + keyword.length).trim();
    const idStart = line.text.indexOf(id, start + keyword.length);
    this.#use(line, id, idStart);
    if (keyword === "activate") {
      this.#open.set(id, (this.#open.get(id) ?? 0) + 1);
      return;
    }
    const open = this.#open.get(id) ?? 0;
    if (open > 0) {
      this.#open.set(id, open - 1);
      return;
    }
    this.report(
      line,
      error(
        "unmatched_deactivate",
        `'${id}' has no open activation to close: activate it first (\`activate ${id}\`, or \`+\` on the arrow that calls it), or remove this line`,
        line.span(start, start + keyword.length),
      ),
    );
  }

  note(line: SourceLine, start: number): void {
    const text = line.text;
    const colon = text.indexOf(":", start);
    const head = text.slice(start, colon === -1 ? text.length : colon);
    const match = /^note\s+(left\s+of|right\s+of|over)\s+(.+?)\s*$/i.exec(head);
    const example = "`Note right of a: text`";
    if (!match) {
      this.report(
        line,
        error(
          "invalid_note",
          `a note is \`Note left of\`, \`right of\` or \`over\`, then participants and a colon: ${example}`,
          line.statementSpan(),
        ),
      );
      return;
    }
    const position = (match[1] ?? "").toLowerCase().replace(/\s+/, " ");
    const names = (match[2] ?? "").split(",").map((name) => name.trim());
    const namesStart = start + head.lastIndexOf(match[2] ?? "");
    for (const name of names) this.#use(line, name, text.indexOf(name, namesStart));
    const allowed = position === "over" ? names.length <= 2 : names.length === 1;
    if (!allowed) {
      this.report(
        line,
        error(
          "invalid_note",
          `\`${position}\` takes ${position === "over" ? "one or two participants" : "one participant"}`,
          line.statementSpan(),
        ),
      );
    }
    if (colon === -1) {
      this.report(
        line,
        error(
          "expected_colon",
          `expected ':' after the participants of a note: ${example}`,
          line.span(text.trimEnd().length),
        ),
      );
      return;
    }
    const body = text.slice(colon + 1);
    if (body.trim() === "") {
      this.report(line, error("expected_label", `expected text after ':' in a note: ${example}`, line.span(colon)));
      return;
    }
    this.#checkComment(line, colon + 1);
    this.scan.notes.push(this.#textSpan(line, colon + 1));
  }

  #textSpan(line: SourceLine, from: number): Span {
    const body = line.text.slice(from);
    const start = from + (body.length - body.trimStart().length);
    return line.span(start, Math.max(start + 1, line.text.trimEnd().length));
  }

  fragment(line: SourceLine, start: number, keyword: FragmentKeyword): void {
    const at = line.span(start, start + keyword.length);
    if (this.#frames.length >= MAX_NESTING_DEPTH) {
      this.report(
        line,
        error(
          "fragment_nesting_too_deep",
          `this fragment is nested ${MAX_NESTING_DEPTH + 1} deep, and fragments nest at most ${MAX_NESTING_DEPTH}. ` +
            "Flatten the nesting, or split the diagram into views. Nothing after this line was checked.",
          at,
        ),
      );
      this.scan.stopped = true;
      return;
    }
    this.#frames.push({ keyword, line, at });
    this.#label(line, start + keyword.length, keyword);
  }

  #label(line: SourceLine, from: number, keyword: string): void {
    if (line.text.slice(from).trim() === "") {
      this.report(
        line,
        error("expected_label", `expected label text after '${keyword}': \`${keyword} label\``, line.statementSpan()),
      );
      return;
    }
    this.#checkComment(line, from);
    this.scan.sections.push(this.#textSpan(line, from));
  }

  section(line: SourceLine, start: number, keyword: "else" | "and"): void {
    const top = this.#frames.at(-1);
    const at = line.span(start, start + keyword.length);
    const owner = keyword === "else" ? "alt" : "par";
    if (top?.keyword === "refused") return;
    if (top?.keyword !== owner) {
      const instead = keyword === "else" ? "and" : "else";
      this.report(
        line,
        top?.keyword === (keyword === "else" ? "par" : "alt")
          ? error(
              "unsupported_construct",
              `\`${keyword}\` belongs in \`${owner}\`: inside \`${top.keyword}\`, write \`${instead}\``,
              at,
            )
          : error("unexpected_token", `\`${keyword}\` outside an \`${owner}\` block`, at),
        top ? [{ start, end: start + keyword.length, replacement: instead }] : [],
      );
      return;
    }
    this.#label(line, start + keyword.length, keyword);
  }

  end(line: SourceLine, at: Span): void {
    if (this.#frames.pop() === undefined)
      this.report(line, error("unexpected_token", "`end` with no open block to close", at));
  }

  message(line: SourceLine, start: number): void {
    const text = line.text;
    const arrow = ARROW.exec(text.slice(start));
    if (!arrow) return;
    const arrowStart = start + arrow.index;
    const arrowEnd = arrowStart + arrow[0].length;
    const from = text.slice(start, arrowStart).trim();
    let after = arrowEnd;
    while (text[after] === " " || text[after] === "\t") after += 1;
    const mark = text[after] === "+" || text[after] === "-" ? text[after] : undefined;
    if (mark) after += 1;
    else after = arrowEnd;
    const colon = text.indexOf(":", after);
    const to = text.slice(after, colon === -1 ? text.length : colon).trim();
    if (from === "" || to === "") return;
    this.#use(line, from, start);
    this.#use(line, to, text.indexOf(to, after));
    const supported = ARROWS.find(([written]) => written === arrow[0])?.[1];
    if (supported !== arrow[0]) {
      this.report(
        line,
        error(
          "unsupported_construct",
          `\`${arrow[0]}\` is not supported: messages use \`->>\` (sync), \`-->>\` (reply) or \`-)\` (async), ` +
            "or `<<->>` and `<<-->>` for an arrowhead at each end",
          line.span(arrowStart, arrowEnd),
        ),
        supported === undefined ? [] : [{ start: arrowStart, end: arrowEnd, replacement: supported }],
      );
    }
    if (colon === -1) {
      this.report(
        line,
        error(
          "expected_colon",
          `expected ':' after message target '${to}': \`${from}->>${to}: text\``,
          line.span(text.trimEnd().length),
        ),
      );
      return;
    }
    this.#checkComment(line, colon + 1);
    this.scan.messages.push(this.#textSpan(line, colon + 1));
    if (mark === "+") this.#open.set(to, (this.#open.get(to) ?? 0) + 1);
    if (mark === "-") {
      const open = this.#open.get(from) ?? 0;
      if (open > 0) this.#open.set(from, open - 1);
      else {
        this.report(
          line,
          error(
            "unmatched_deactivate",
            `the \`-\` on this arrow deactivates its sender '${from}', which has no open activation to close: activate it first, or remove the \`-\``,
            line.span(after - 1, after),
          ),
        );
      }
    }
  }

  finish(): void {
    if (!this.scan.stopped) {
      for (const frame of this.#frames) {
        if (frame.keyword === "refused") continue;
        this.report(
          frame.line,
          error(
            "unclosed_fragment",
            `this \`${frame.keyword}\` is never closed: add \`end\` after its last line`,
            frame.at,
          ),
        );
      }
    }
    const reported = new Set<string>();
    for (const use of this.#uses) {
      // A keyword name is already refused where it is used; renaming it is the fix.
      if (this.#declared.has(use.id) || reported.has(use.id) || RESERVED.has(use.id.toLowerCase())) continue;
      reported.add(use.id);
      this.report(
        use.line,
        error(
          "undeclared_participant",
          `participant '${use.id}' is never declared: add \`participant ${use.id} as Label\`, or fix the name if it is a typo`,
          use.span,
        ),
      );
    }
  }
}

export function scanSequence(header: SourceLine, statements: readonly SourceLine[]): SequenceScan {
  const scanner = new Scanner();
  for (const line of statements) {
    if (line.number <= header.number || isBlank(line.text) || isCommentLine(line.text)) continue;
    scanner.line(line);
    if (scanner.scan.stopped) break;
  }
  scanner.finish();
  return scanner.scan;
}
