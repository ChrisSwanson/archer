import { browserFetch } from "../app/browser-resource";
import type { AccuracyOperationCaller } from "./RevisionCompare";

export class PageOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "PageOperationError";
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Preserve bounded JSON refusal details without recursively traversing untrusted data. */
function readDetails(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!object(value)) return undefined;
  const pending = [{ value: value as unknown, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (++visited > 10_000 || entry.depth > 32) return undefined;
    if (typeof entry.value === "string" && entry.value.length > 100_000) return undefined;
    if (entry.value === null || typeof entry.value === "string" || typeof entry.value === "boolean") continue;
    if (typeof entry.value === "number" && Number.isFinite(entry.value)) continue;
    if (!object(entry.value) && !Array.isArray(entry.value)) return undefined;
    for (const child of Object.values(entry.value)) pending.push({ value: child, depth: entry.depth + 1 });
  }
  return value;
}

/** Same-origin adapter; semantic operations remain in the shared application core. */
export const callAccuracyOperation: AccuracyOperationCaller = async (name, args) => {
  const response = await browserFetch("api/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Archer returned an unreadable response. Try again.");
  }
  if (!response.ok) {
    const error = object(body) && object(body.error) ? body.error : {};
    const message =
      typeof error.message === "string" ? error.message : `Operation failed (HTTP ${response.status}). Try again.`;
    const code = typeof error.code === "string" ? error.code : "operation_failed";
    throw new PageOperationError(code, message, readDetails(error.details));
  }
  return body;
};
