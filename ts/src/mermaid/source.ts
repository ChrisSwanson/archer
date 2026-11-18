// The source as lines, and the positions diagnostics point at.
//
// A line ends at `\n`, `\r\n` or a lone `\r`, as in the Rust profile and in
// Mermaid's own preprocessing. Columns count Unicode scalar values, not UTF-16
// code units, so a label in a script outside the Basic Multilingual Plane is
// pointed at correctly.

import type { Span } from "./diagnostics.ts";

export class SourceLine {
  /** Offsets of the second half of each surrogate pair; built on first need. */
  #lowSurrogates: number[] | undefined;

  constructor(
    /** One-based. */
    readonly number: number,
    readonly text: string,
  ) {}

  /** The one-based column of the UTF-16 offset `index` on this line. */
  column(index: number): number {
    this.#lowSurrogates ??= lowSurrogateOffsets(this.text);
    const pairsBefore = countBelow(this.#lowSurrogates, index);
    return index - pairsBefore + 1;
  }

  /** The span of `text.slice(start, end)`, at least one column wide. */
  span(start: number, end = start + 1): Span {
    const from = this.column(start);
    const to = Math.max(this.column(end), from + 1);
    return { start: { line: this.number, column: from }, end: { line: this.number, column: to } };
  }

  /** The span from the first non-blank character to the end of the line. */
  statementSpan(): Span {
    const start = this.text.length - this.text.trimStart().length;
    return this.span(start, this.text.trimEnd().length);
  }

  get indent(): string {
    return this.text.slice(0, this.text.length - this.text.trimStart().length);
  }
}

function lowSurrogateOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (let index = 1; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const previous = text.charCodeAt(index - 1);
    if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) offsets.push(index);
  }
  return offsets;
}

/** How many of the sorted `values` are below `limit`. */
function countBelow(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? Infinity) < limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function splitLines(source: string): SourceLine[] {
  return source.split(/\r\n|\r|\n/).map((text, index) => new SourceLine(index + 1, text));
}

/** A `%%` comment line; `%%{` opens a directive, which is not a comment. */
export function isCommentLine(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("%%") && !trimmed.startsWith("%%{");
}

export function isBlank(text: string): boolean {
  return text.trim() === "";
}

/** The span covering the whole of line `line` of `lines`, or line 1 column 1. */
export function lineSpan(lines: readonly SourceLine[], line: number): Span {
  const found = lines[line - 1];
  return found ? found.statementSpan() : { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
}

/** The 1-based line of the source that most likely declares this edge, for the diagnostic's span. */
export function edgeLineOf(source: string, id: string, label: string, ends: readonly [string, string]): number {
  const lines = source.split(/\r\n?|\n/);
  const code = (line: string) => !/^\s*%%/.test(line);
  // A flowchart edge names its id: `a e1@--> b`.
  const byId = lines.findIndex(
    (line) => code(line) && new RegExp(`(^|[\\s;])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@`).test(line),
  );
  if (byId >= 0) return byId + 1;
  // Elsewhere the id is derived from the two ends; the line naming both and the label is the declaration.
  const first = label.split(/\n|<br\s*\/?>/i)[0] ?? label;
  const byEnds = lines.findIndex(
    (line) => code(line) && line.includes(ends[0]) && line.includes(ends[1]) && line.includes(first),
  );
  if (byEnds >= 0) return byEnds + 1;
  const byLabel = lines.findIndex((line) => code(line) && line.includes(first));
  return byLabel >= 0 ? byLabel + 1 : 1;
}
