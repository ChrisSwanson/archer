/**
 * The compiler's diagnostics, placed on the text the person is looking at.
 *
 * Archer's server compiles every source change (preview, compile, read) and reports problems with
 * one-based lines and one-based Unicode-scalar columns, the span's end exclusive (ADR 0002). The
 * editor works in UTF-16 offsets, so a column past an astral character (an emoji in a label) moves
 * by two code units. This module is plain data in and out: no CodeMirror import, so it is cheap to
 * test and to use for a summary outside the editor.
 */

export type SourceSeverity = "error" | "warning" | "info";

/** A fix the server can apply without judgement (`fix` on a diagnostic). */
export interface SourceFix {
  readonly operation: string;
}

/** One problem, at UTF-16 offsets in the document it was mapped onto. */
export interface PlacedDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly line: number;
  readonly severity: SourceSeverity;
  readonly message: string;
  readonly code?: string;
  readonly fix?: SourceFix;
}

interface Point {
  readonly line: number;
  readonly column: number;
}

/** What a fix is called on its button, in the person's words. */
export function fixLabel(fix: SourceFix): string {
  if (fix.operation === "add-edge-ids") return "Add edge IDs";
  return fix.operation.replace(/-/gu, " ").replace(/^./u, (first) => first.toUpperCase());
}

/** A server diagnostic read defensively: null when it carries nothing a reader can act on. */
function read(value: unknown): {
  start: Point | null;
  end: Point | null;
  severity: SourceSeverity;
  message: string;
  code?: string;
  fix?: SourceFix;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const d = value as {
    message?: unknown;
    code?: unknown;
    severity?: unknown;
    span?: unknown;
    line?: unknown;
    fix?: unknown;
  };
  const message = typeof d.message === "string" ? d.message : typeof d.code === "string" ? d.code : null;
  if (message === null) return null;
  const severity: SourceSeverity = d.severity === "warning" || d.severity === "info" ? d.severity : "error";
  const span = typeof d.span === "object" && d.span !== null ? (d.span as { start?: unknown; end?: unknown }) : null;
  const start = point(span?.start) ?? (typeof d.line === "number" ? { line: d.line, column: 1 } : null);
  const end = point(span?.end);
  const fix =
    typeof d.fix === "object" && d.fix !== null && typeof (d.fix as { operation?: unknown }).operation === "string"
      ? { operation: (d.fix as { operation: string }).operation }
      : undefined;
  return {
    start,
    end,
    severity,
    message,
    ...(typeof d.code === "string" ? { code: d.code } : {}),
    ...(fix ? { fix } : {}),
  };
}

function point(value: unknown): Point | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as { line?: unknown; column?: unknown };
  return typeof p.line === "number" && Number.isFinite(p.line)
    ? {
        line: Math.trunc(p.line),
        column: typeof p.column === "number" && Number.isFinite(p.column) ? Math.max(1, Math.trunc(p.column)) : 1,
      }
    : null;
}

/** Line starts of `text` (UTF-16 offsets), one per line, the first at 0. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** The offset of a one-based scalar column on a line, clamped to the line's end. */
function offsetOf(text: string, starts: readonly number[], at: Point): { offset: number; line: number } {
  const line = Math.min(Math.max(at.line, 1), starts.length);
  const start = starts[line - 1];
  const lineEnd = line < starts.length ? starts[line] - 1 : text.length;
  let offset = start;
  for (let column = 1; column < at.column && offset < lineEnd; column += 1) {
    const code = text.charCodeAt(offset);
    offset += code >= 0xd800 && code <= 0xdbff && offset + 1 < lineEnd ? 2 : 1;
  }
  return { offset, line };
}

/**
 * The server's diagnostics placed on `text`. A span past the end clamps to the last line; one with
 * no width (or no end) covers the rest of its line's word, else the whole line, so an underline is
 * always visible. Unreadable entries are dropped; the order is the server's.
 */
export function placeDiagnostics(text: string, diagnostics: readonly unknown[] | undefined): PlacedDiagnostic[] {
  if (!diagnostics?.length) return [];
  const starts = lineStarts(text);
  const placed: PlacedDiagnostic[] = [];
  for (const value of diagnostics) {
    const d = read(value);
    if (d === null) continue;
    const startAt = d.start ?? { line: 1, column: 1 };
    const start = offsetOf(text, starts, startAt);
    let to = d.end ? offsetOf(text, starts, d.end).offset : start.offset;
    const lineEnd = start.line < starts.length ? starts[start.line] - 1 : text.length;
    if (to <= start.offset) {
      const word = /^[^\s]+/u.exec(text.slice(start.offset, lineEnd));
      to = word ? start.offset + word[0].length : lineEnd;
    }
    let from = start.offset;
    // Nothing on the line from there on (a problem reported at the line's end): mark the line.
    if (to <= from) {
      from = starts[start.line - 1];
      to = lineEnd;
    }
    placed.push({
      from,
      to,
      line: start.line,
      severity: d.severity,
      message: d.message,
      ...(d.code ? { code: d.code } : {}),
      ...(d.fix ? { fix: d.fix } : {}),
    });
  }
  return placed;
}

/** Counts for a one-line summary ("2 errors, 1 warning"). */
export function summarize(placed: readonly PlacedDiagnostic[]): { errors: number; warnings: number; infos: number } {
  let errors = 0,
    warnings = 0,
    infos = 0;
  for (const d of placed) {
    if (d.severity === "error") errors += 1;
    else if (d.severity === "warning") warnings += 1;
    else infos += 1;
  }
  return { errors, warnings, infos };
}
