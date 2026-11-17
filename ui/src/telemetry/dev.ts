/**
 * The static half of dev telemetry: what product code calls.
 *
 * Every call site is guarded by `if (__ARCHER_DEBUG__)` (or `__ARCHER_DEBUG__ && …`), so a production
 * build drops the call, its arguments and, with no live import left, this module. The runtime
 * (`runtime.ts`, loaded by `main.tsx` only in debug builds) installs the sink; until then, and in
 * tests that do not install one, a report goes nowhere.
 */

export type TelemetryLevel = "info" | "warn" | "error";
export interface TelemetryReport {
  readonly level: TelemetryLevel;
  readonly code: string;
  readonly msg?: string;
  readonly data?: Record<string, unknown>;
}
export type TelemetrySink = (report: TelemetryReport) => void;

let sink: TelemetrySink | null = null;

/** Installed by the runtime; tests install their own. Returns the previous sink. */
export function setTelemetrySink(next: TelemetrySink | null): TelemetrySink | null {
  const previous = sink;
  sink = next;
  return previous;
}

/** Report a "this should not happen" (or info) event with a stable `code` from the contract. */
export function devReport(
  code: string,
  msg?: string,
  data?: Record<string, unknown>,
  level: TelemetryLevel = "warn",
): void {
  try {
    sink?.({ level, code, ...(msg === undefined ? {} : { msg }), ...(data === undefined ? {} : { data }) });
  } catch {
    // Instrumentation never breaks the page.
  }
}

/** A 32-bit FNV-1a hash of `text`: requests are compared by it, and neither is kept nor sent. */
export function contentHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const ID_VALUE = /^[A-Za-z0-9_.:/#@-]{1,120}$/;
/** Fields that name what a request acts on (ids, never content); edit endpoints are renamed `from`/`to`. */
const ID_FIELDS: Readonly<Record<string, string>> = {
  id: "id",
  source: "from",
  target: "to",
  before: "before",
  after: "after",
  draftId: "draftId",
  targetOperationId: "targetOperationId",
  viewId: "viewId",
  address: "address",
  path: "path",
  blockId: "blockId",
  direction: "direction",
  shape: "shape",
};

/**
 * What a request may say about itself in telemetry: its op (`op` or `kind`), the ids it names, numbers
 * and flags, a target's kind and id, list lengths, and the byte size of every other string — never a
 * label, a note's text or Mermaid source.
 */
export function requestMetadata(request: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof request !== "object" || request === null) return out;
  for (const [key, value] of Object.entries(request as Record<string, unknown>).slice(0, 40)) {
    if (key === "operationId" || key === "journalGeneration") continue;
    if ((key === "op" || key === "kind") && typeof value === "string" && ID_VALUE.test(value))
      out[key === "kind" ? "op" : key] = value;
    else if (typeof value === "string") {
      const name = ID_FIELDS[key];
      if (name !== undefined && ID_VALUE.test(value)) out[name] = value;
      else out[`${key}Bytes`] = new TextEncoder().encode(value).length;
    } else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[`${key}Count`] = value.length;
    else if (typeof value === "object" && value !== null) {
      const nested = value as Record<string, unknown>;
      if (typeof nested.kind === "string" && ID_VALUE.test(nested.kind)) out[`${key}Kind`] = nested.kind;
      const id = nested.viewId ?? nested.address;
      if (typeof id === "string" && ID_VALUE.test(id)) out[`${key}Id`] = id;
    }
  }
  return out;
}

/**
 * The same edit request issued twice within `windowMs` (`ui.edit.double-commit`): the bug class where
 * React ran a side effect twice. Requests are compared by a hash of `content` (which excludes the
 * random operation id); the report carries only `requestMetadata(request)` and sizes. At most
 * `maxKeys` recent hashes are held.
 */
export function doubleCommitDetector(
  windowMs = 300,
  now: () => number = () => performance.now(),
  maxKeys = 64,
): (kind: string, content: string, request?: unknown) => void {
  const seen = new Map<string, number>();
  return (kind, content, request) => {
    const at = now(),
      id = `${kind}:${contentHash(content)}:${content.length}`,
      last = seen.get(id);
    for (const [other, when] of seen) if (at - when > windowMs) seen.delete(other);
    seen.delete(id);
    seen.set(id, at);
    while (seen.size > maxKeys) seen.delete(seen.keys().next().value as string);
    if (last !== undefined && at - last <= windowMs)
      devReport("ui.edit.double-commit", `${kind} issued twice within ${windowMs} ms`, {
        kind,
        ...requestMetadata(request),
        requestBytes: new TextEncoder().encode(content).length,
        gapMs: Math.round(at - last),
      });
  };
}
