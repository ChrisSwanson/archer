// A problem the profile found in one line, with the edits that fix it. The
// hint a diagnostic carries is the whole line with every fix found on that
// line applied, so an agent can replace the line as given.

import { MAX_REPORTED_DIAGNOSTICS, type Diagnostic } from "./diagnostics.ts";
import type { SourceLine } from "./source.ts";

export interface Edit {
  /** UTF-16 offsets into the line. */
  start: number;
  end: number;
  replacement: string;
}

export interface Finding {
  diagnostic: Diagnostic;
  line: SourceLine;
  edits: Edit[];
  /**
   * A form the Rust profile accepted and Mermaid does not parse. Reported
   * only when Mermaid refuses the source, so a reading of the line that
   * Mermaid would accept is never refused.
   */
  legacy: boolean;
}

/** Move the comment that starts at `at` onto a line of its own above, with the same indent. */
export function moveCommentEdits(line: SourceLine, at: number): Edit[] {
  const before = line.text.slice(0, at).trimEnd().length;
  return [
    { start: before, end: line.text.length, replacement: "" },
    { start: 0, end: 0, replacement: `${line.indent}${line.text.slice(at).trimEnd()}\n` },
  ];
}

/**
 * The line with every edit applied, from the end so each offset still names
 * the original text. Disjoint edits (every edit the profile makes) are joined
 * in one pass; overlapping ones are applied one at a time, as before.
 */
export function rewriteLine(text: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  const pieces: string[] = [];
  let rest = text.length;
  for (const edit of ordered) {
    if (edit.end > rest)
      return ordered.reduce((line, e) => line.slice(0, e.start) + e.replacement + line.slice(e.end), text);
    pieces.push(text.slice(edit.end, rest), edit.replacement);
    rest = edit.start;
  }
  pieces.push(text.slice(0, rest));
  return pieces.reverse().join("");
}

/**
 * The most findings one line reports. More than a report lists anyway
 * (`MAX_REPORTED_DIAGNOSTICS`); the line's hint still applies every fix.
 */
export const MAX_FINDINGS_PER_LINE = MAX_REPORTED_DIAGNOSTICS + 1;

/** The findings' diagnostics, each with its line's rewrite as the hint when there is one. */
export function diagnosticsOf(findings: readonly Finding[]): Diagnostic[] {
  const byLine = new Map<number, { line: SourceLine; edits: Edit[]; count: number; hint?: string }>();
  for (const finding of findings) {
    let entry = byLine.get(finding.line.number);
    if (entry === undefined) byLine.set(finding.line.number, (entry = { line: finding.line, edits: [], count: 0 }));
    for (const edit of finding.edits) entry.edits.push(edit);
  }
  const diagnostics: Diagnostic[] = [];
  for (const finding of findings) {
    const entry = byLine.get(finding.line.number)!;
    if (entry.count >= MAX_FINDINGS_PER_LINE) continue;
    entry.count += 1;
    if (finding.edits.length === 0 || entry.edits.length === 0) {
      diagnostics.push(finding.diagnostic);
      continue;
    }
    entry.hint ??= rewriteLine(finding.line.text, entry.edits);
    diagnostics.push({ ...finding.diagnostic, hint: entry.hint });
  }
  return diagnostics;
}
