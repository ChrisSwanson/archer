/**
 * Which registered diagrams do not compile right now (ADR 0010).
 *
 * A drawing on this page is the last version of its file that compiled. Most
 * of the time that is also the file as it stands; when it is not, the page
 * has to say so, or a reader cannot tell a current drawing from a stale one.
 *
 * Wire shape:
 *   { "schemaVersion": 1,
 *     "failures": [{ "viewId", "sourceRevision", "lastValidRevision",
 *                    "diagnostics": [{ "code", "message", "span"? }] }] }
 * carried by `GET api/compile`, by the `compile` SSE event, and by the
 * `compile` key of the tool results an MCP-App page is handed. `failures` is
 * the WHOLE state -- every failing view and nothing else -- so a payload
 * replaces what the page held rather than amending it.
 */

/** The one compile-status wire version this page reads; its own number. */
export const COMPILE_STATUS_SCHEMA_VERSION = 1;

export type CompileProblem = {
  readonly code: string;
  /** Written for the agent that will fix it; shown to the reader verbatim. */
  readonly message: string;
  /** One-based, and absent together: a problem with no position has neither. */
  readonly line?: number;
  readonly column?: number;
};

export type CompileFailure = {
  readonly viewId: string;
  /** The revision of the source that failed: the file as it stands; null when there is no file to read (deleted). */
  readonly sourceRevision: string | null;
  /** The revision of the drawing still served, or `null` if there never was one. */
  readonly lastValidRevision: string | null;
  readonly problems: readonly CompileProblem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A positive whole number, which is all a line or a column can be. */
function ordinal(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseProblem(value: unknown): CompileProblem | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    return undefined;
  }
  const start = isRecord(value.span) && isRecord(value.span.start) ? value.span.start : undefined;
  const line = ordinal(start?.line);
  const column = ordinal(start?.column);
  // Both or neither. Half a position would be printed as a whole one.
  return line === undefined || column === undefined
    ? { code: value.code, message: value.message }
    : { code: value.code, message: value.message, line, column };
}

function parseFailure(value: unknown): CompileFailure | undefined {
  if (
    !isRecord(value) ||
    typeof value.viewId !== "string" ||
    // null: the file is gone (no bytes to hash). Still a failure the reader must be told about (claude-204).
    (value.sourceRevision !== null && typeof value.sourceRevision !== "string") ||
    (value.lastValidRevision !== null && typeof value.lastValidRevision !== "string") ||
    !Array.isArray(value.diagnostics)
  ) {
    return undefined;
  }
  const problems: CompileProblem[] = [];
  for (const entry of value.diagnostics) {
    const problem = parseProblem(entry);
    if (problem !== undefined) {
      problems.push(problem);
    }
  }
  return {
    viewId: value.viewId,
    sourceRevision: value.sourceRevision,
    lastValidRevision: value.lastValidRevision,
    problems,
  };
}

/**
 * Reads a compile-status payload, or reports that it was not one.
 *
 * The rules are `parseInventory`'s, for its reasons. One malformed failure is
 * dropped rather than failing the payload: it costs its own notice, where
 * rejecting the payload would cost every other view's. A payload at any other
 * `schemaVersion` is rejected whole and logged: it is a shape this code was not
 * written against, and reading it as version 1 would put a guess on screen
 * under the words "this file no longer compiles".
 *
 * `undefined` is "this was not a compile status", which callers must not treat
 * as "nothing is failing": the page keeps what it held.
 */
export function parseCompileStatus(payload: unknown): CompileFailure[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.failures)) {
    return undefined;
  }
  if (payload.schemaVersion !== COMPILE_STATUS_SCHEMA_VERSION) {
    console.error(
      `[archer] compile status schemaVersion ${JSON.stringify(payload.schemaVersion)} is not supported; ` +
        `this page reads version ${COMPILE_STATUS_SCHEMA_VERSION}`,
    );
    return undefined;
  }
  const failures: CompileFailure[] = [];
  for (const entry of payload.failures) {
    const failure = parseFailure(entry);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  return failures;
}

function sameProblem(a: CompileProblem, b: CompileProblem): boolean {
  return a.code === b.code && a.message === b.message && a.line === b.line && a.column === b.column;
}

function sameFailure(a: CompileFailure, b: CompileFailure): boolean {
  return (
    a.viewId === b.viewId &&
    a.sourceRevision === b.sourceRevision &&
    a.lastValidRevision === b.lastValidRevision &&
    a.problems.length === b.problems.length &&
    a.problems.every((problem, index) => sameProblem(problem, b.problems[index]))
  );
}

/**
 * The state after a payload lands: the payload, which is the whole state.
 *
 * It returns the HELD array when the payload says the same thing. The server
 * already stays quiet when nothing moved, but an MCP-App page is handed the
 * status on every tool result, and `App` re-renders the canvas's parent
 * whenever this value changes identity -- which a controlled React Flow turns
 * into work, and has before turned into a render loop.
 */
export function applyCompileStatus(
  held: readonly CompileFailure[],
  next: readonly CompileFailure[],
): readonly CompileFailure[] {
  const unchanged = held.length === next.length && held.every((failure, index) => sameFailure(failure, next[index]));
  return unchanged ? held : next;
}

/**
 * The person saved this view's file from the editor (O157): the service accepted a source that compiles, so the
 * failure held from before (a missing file, a parse error) is stale until the next payload says otherwise.
 */
export function forgetSavedFailure(held: readonly CompileFailure[], viewId: string | null): readonly CompileFailure[] {
  return viewId === null || !held.some((failure) => failure.viewId === viewId)
    ? held
    : held.filter((failure) => failure.viewId !== viewId);
}

/** The standing failure for one view, if it has one. */
export function failureFor(failures: readonly CompileFailure[], viewId: string | null): CompileFailure | undefined {
  return viewId === null ? undefined : failures.find((failure) => failure.viewId === viewId);
}

/** Where a problem is, in the reader's words; empty when it has no position. */
export function problemPosition(problem: CompileProblem): string {
  return problem.line === undefined || problem.column === undefined
    ? ""
    : `Line ${problem.line}, column ${problem.column}`;
}

/**
 * Whether the view fails because its file is gone rather than because of what
 * is in it. The server lists a durable view whose source was deleted with this
 * one diagnostic, and "no longer compiles" would be the wrong sentence for it.
 */
export function sourceIsMissing(failure: CompileFailure): boolean {
  return failure.problems.length === 1 && failure.problems[0].code === "source_missing";
}
