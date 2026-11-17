// Compile diagnostics: what is wrong with a source, where, and what to write
// instead. Positions are one-based lines and one-based Unicode-scalar columns;
// a span's end is exclusive (ADR 0002).

export type Severity = "error" | "warning" | "info";

export interface Position {
  line: number;
  column: number;
}

export interface Span {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  /** Stable code an agent branches on: `undeclared_node`, `label_too_long`, ... */
  code: string;
  severity: Severity;
  /** For a reader: what is wrong and what to do. May be reworded. */
  message: string;
  span: Span;
  /** The source to write instead, when there is one: the whole rewritten line. */
  hint?: string;
  /**
   * A fix a tool can apply with no judgement: the edit operation that makes it, for every such
   * problem in the source at once. `add-edge-ids` writes a readable ID on each flowchart edge
   * without one and declares each node only named (`a` → `a[a]`). Absent when the fix needs a choice only the author can make.
   */
  fix?: DiagnosticFix;
}

export interface DiagnosticFix {
  operation: "add-edge-ids";
}

/** The most errors one report lists; a longer report ends in `too_many_diagnostics`. */
export const MAX_REPORTED_DIAGNOSTICS = 20;

export function span(line: number, column: number, endColumn = column + 1, endLine = line): Span {
  return { start: { line, column }, end: { line: endLine, column: endColumn } };
}

export function error(code: string, message: string, at: Span, hint?: string): Diagnostic {
  return withHint({ code, severity: "error", message, span: at }, hint);
}

export function warning(code: string, message: string, at: Span): Diagnostic {
  return { code, severity: "warning", message, span: at };
}

export function info(code: string, message: string, at: Span): Diagnostic {
  return { code, severity: "info", message, span: at };
}

function withHint(diagnostic: Diagnostic, hint: string | undefined): Diagnostic {
  return hint === undefined ? diagnostic : { ...diagnostic, hint };
}

export function isError(diagnostic: Diagnostic): boolean {
  return diagnostic.severity === "error";
}

function compareSpans(a: Span, b: Span): number {
  return a.start.line - b.start.line || a.start.column - b.start.column;
}

/**
 * Put a report in source order and bound it: at most
 * {@link MAX_REPORTED_DIAGNOSTICS} errors, then one `too_many_diagnostics`
 * entry at the first error left out. Warnings and notes are not counted, but
 * none past that point is kept either.
 */
export function finishReport(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const ordered = dedupe([...diagnostics].sort((a, b) => compareSpans(a.span, b.span)));
  const report: Diagnostic[] = [];
  let errors = 0;
  for (const diagnostic of ordered) {
    if (isError(diagnostic)) {
      if (errors === MAX_REPORTED_DIAGNOSTICS) {
        report.push(
          error(
            "too_many_diagnostics",
            `more than ${MAX_REPORTED_DIAGNOSTICS} problems; this is the first one not listed. ` +
              "Fix the ones above and check again.",
            diagnostic.span,
          ),
        );
        return report;
      }
      errors += 1;
    }
    report.push(diagnostic);
  }
  return report;
}

/** Two rules may find the same problem at the same place; report it once. */
function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}@${diagnostic.span.start.line}:${diagnostic.span.start.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `[code] line L:C: message`, the one-line form tools print. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const { line, column } = diagnostic.span.start;
  return `[${diagnostic.code}] line ${line}:${column}: ${diagnostic.message}`;
}
