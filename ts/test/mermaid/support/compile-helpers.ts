import type { Diagnostic } from "../../../src/mermaid/index.ts";

/** Diagnostics as `code@line:column`, for compact assertions. */
export function located(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map(
    (diagnostic) => `${diagnostic.code}@${diagnostic.span.start.line}:${diagnostic.span.start.column}`,
  );
}

export function errorsOf(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}

/**
 * The source with each diagnostic's line replaced by its hint, as an agent
 * acting on the report would do. Lines are split as the compiler splits them.
 */
export function applyHints(source: string, diagnostics: readonly Diagnostic[]): string {
  const lines = source.split(/\r\n|\r|\n/);
  for (const diagnostic of diagnostics) {
    if (diagnostic.hint !== undefined) lines[diagnostic.span.start.line - 1] = diagnostic.hint;
  }
  return lines.join("\n");
}
