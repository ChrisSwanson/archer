// Pieces the line scanners of the state, ER, C4, architecture and journey
// profiles share: findings, trailing comments, ignored styling and the
// diagnostics every scanner gives in the same words.

import { error, info, warning, type Diagnostic, type Span } from "./diagnostics.ts";
import { moveCommentEdits, type Edit, type Finding } from "./findings.ts";
import type { SourceLine } from "./source.ts";

/** The offset of the first `%%` outside a quoted span, or undefined. */
export function trailingComment(text: string): number | undefined {
  let quoted = false;
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] === '"') quoted = !quoted;
    else if (!quoted && text.startsWith("%%", index)) return index;
  }
  return undefined;
}

/** The span of the trimmed text of `line` from `from` to its end, at least one column wide. */
export function textSpan(line: SourceLine, from: number, to = line.text.trimEnd().length): Span {
  const body = line.text.slice(from, to);
  const start = from + (body.length - body.trimStart().length);
  return line.span(start, Math.max(start + 1, from + body.trimEnd().length));
}

export function invalidIdMessage(what: string, id: string): string {
  return (
    `${what} ID '${id}' is not a stable ID: use 1 to 128 letters, digits and \`_\`, starting with a letter or digit ` +
    "(ASCII only: selection and comments anchor to it)"
  );
}

/**
 * The warning for a relationship written again between the same two ends, in a
 * family whose relationship IDs are made from the ends: the first is drawn, and
 * this one is ignored.
 */
export function repeatedMessage(
  what: string,
  source: string,
  target: string,
  firstLine: number,
  instead: string,
): string {
  return (
    `this ${what} repeats the one from '${source}' to '${target}' on line ${firstLine}, so it is ignored: Mermaid has no ` +
    `${what} IDs, so Archer names a ${what} by its two ends and draws the first one only. ${instead}`
  );
}

/** Collects one scan's findings, and the styling it ignored. */
export class Report {
  readonly findings: Finding[] = [];
  readonly notes: Diagnostic[] = [];
  #styling: Span | undefined;
  #stylingCount = 0;

  add(line: SourceLine, diagnostic: Diagnostic, edits: Edit[] = []): void {
    this.findings.push({ diagnostic, line, edits, legacy: false });
  }

  error(line: SourceLine, code: string, message: string, at: Span = line.statementSpan(), edits: Edit[] = []): void {
    this.add(line, error(code, message, at), edits);
  }

  /** A warning: reported, and the source still compiles. */
  warning(line: SourceLine, code: string, message: string, at: Span = line.statementSpan()): void {
    this.add(line, warning(code, message, at));
  }

  get refused(): boolean {
    return this.findings.some((finding) => finding.diagnostic.severity === "error");
  }

  /** Refuse a `%%` after a statement, which Mermaid would read as text; true when there was one. */
  trailingComment(line: SourceLine, from = 0): boolean {
    const at = trailingComment(line.text.slice(from));
    if (at === undefined) return false;
    const start = from + at;
    this.error(
      line,
      "unsupported_construct",
      "a `%%` comment after a statement is not supported: put the comment on a line of its own",
      line.span(start, line.text.trimEnd().length),
      moveCommentEdits(line, start),
    );
    return true;
  }

  /**
   * Refuse each `#` and `;` (of those in `which`) outside quotes and entity
   * codes: Mermaid's lexer for some types ends the text at `#` or the
   * statement at `;` wherever they stand. Each is refused with its entity
   * code, which Mermaid keeps as text. True when there was one.
   */
  delimiters(line: SourceLine, which: "#;" | ";" | "#"): boolean {
    const masked = line.text.replace(/#\w+;/g, (code) => " ".repeat(code.length));
    let quoted = false;
    let found = false;
    for (let index = 0; index < masked.length; index += 1) {
      const character = masked[index] ?? "";
      if (character === '"') quoted = !quoted;
      if (quoted || !which.includes(character)) continue;
      found = true;
      const code = character === "#" ? "#35;" : "#59;";
      this.error(
        line,
        "unsupported_construct",
        character === "#"
          ? `Mermaid drops everything from \`#\` to the end of the line here: write \`${code}\` for a literal \`#\``
          : `Mermaid ends a statement at \`;\`, so the rest of the line would be read as another: write \`${code}\` for a literal \`;\``,
        line.span(index),
        [{ start: index, end: index + 1, replacement: code }],
      );
    }
    return found;
  }

  /** A styling statement: accepted, left out of the model, and noted once. */
  styling(line: SourceLine): void {
    this.#styling ??= line.statementSpan();
    this.#stylingCount += 1;
  }

  unsupported(line: SourceLine, what: string, instead: string, at: Span = line.statementSpan()): void {
    this.error(line, "unsupported_construct", `${what} is not supported: ${instead}`, at);
  }

  /** The findings' notes, with the one for ignored styling. */
  finishNotes(): Diagnostic[] {
    if (this.#styling === undefined) return this.notes;
    const what =
      this.#stylingCount === 1 ? "this styling statement is" : `${this.#stylingCount} styling statements are`;
    return [
      ...this.notes,
      info(
        "ignored_styling",
        `${what} ignored${this.#stylingCount === 1 ? "" : " (the first is here)"}: Archer draws diagrams with its own theme`,
        this.#styling,
      ),
    ];
  }
}
