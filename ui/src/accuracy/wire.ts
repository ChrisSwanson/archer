/** Bounded presentation wire validation; semantic comparison remains server-owned. */
export interface History {
  readonly status: "compiled" | "failed" | "unavailable";
  readonly commit?: string;
  readonly path?: string;
  readonly reason?: string;
  readonly result?: { readonly diagnostics: readonly { readonly severity: string; readonly message: string }[] };
}
export interface Change {
  readonly key: string;
  readonly status: "added" | "removed" | "changed" | "moved";
  readonly before?: unknown;
  readonly after?: unknown;
  readonly beforeIndex?: number;
  readonly afterIndex?: number;
}
export interface Comparison {
  readonly before: History;
  readonly after: History;
  readonly sourceChanged: boolean | null;
  readonly semantic: { readonly status: "compared" | "incompatible"; readonly changes: readonly Change[] } | null;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function readComparison(raw: unknown): Comparison {
  const history = (value: unknown): boolean =>
    record(value) &&
    ["compiled", "failed", "unavailable"].includes(String(value.status)) &&
    (value.commit === undefined || typeof value.commit === "string") &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.status === "unavailable"
      ? typeof value.reason === "string"
      : typeof value.commit === "string" &&
        typeof value.path === "string" &&
        record(value.result) &&
        Array.isArray(value.result.diagnostics) &&
        value.result.diagnostics.length <= 4096 &&
        value.result.diagnostics.every(
          (diagnostic) =>
            record(diagnostic) && typeof diagnostic.severity === "string" && typeof diagnostic.message === "string",
        ));
  if (
    !record(raw) ||
    !history(raw.before) ||
    !history(raw.after) ||
    !(raw.sourceChanged === null || typeof raw.sourceChanged === "boolean")
  )
    throw new Error("The server returned an unreadable comparison. Try comparing again.");
  const semantic = raw.semantic;
  const position = (value: unknown): boolean =>
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 4096);
  if (
    semantic !== null &&
    (!record(semantic) ||
      !["compared", "incompatible"].includes(String(semantic.status)) ||
      !Array.isArray(semantic.changes) ||
      semantic.changes.length > 16384 ||
      semantic.changes.some(
        (value) =>
          !record(value) ||
          typeof value.key !== "string" ||
          !position(value.beforeIndex) ||
          !position(value.afterIndex) ||
          !["added", "removed", "changed", "moved"].includes(String(value.status)),
      ))
  )
    throw new Error("The server returned unreadable semantic changes. Try comparing again.");
  return raw as unknown as Comparison;
}
