/**
 * The `change` event (phase3-front-door.md): a view recompiled, and what the
 * service found different from the previous good model.
 *
 *   { viewId, at, by: "agent" | "person", summary?, added: string[],
 *     changed: string[], removed: { id, label }[] }
 *
 * Added and changed elements are still on the drawing, so they are shown
 * there (`ChangePulse`); a removed one is not, so it is named.
 */
export type RemovedElement = { readonly id: string; readonly label: string };

export type ViewChange = {
  readonly viewId: string;
  readonly at: string;
  readonly by: "agent" | "person";
  readonly summary?: string;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly RemovedElement[];
};

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

export function parseChange(value: unknown): ViewChange | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.viewId !== "string" || typeof record.at !== "string") return undefined;
  if (record.by !== "agent" && record.by !== "person") return undefined;
  if (!strings(record.added) || !strings(record.changed) || !Array.isArray(record.removed)) return undefined;
  const removed: RemovedElement[] = [];
  for (const entry of record.removed) {
    const element = entry as Record<string, unknown> | null;
    if (typeof element?.id !== "string" || typeof element.label !== "string") return undefined;
    removed.push({ id: element.id, label: element.label });
  }
  return {
    viewId: record.viewId,
    at: record.at,
    by: record.by,
    summary: typeof record.summary === "string" && record.summary.trim() !== "" ? record.summary : undefined,
    added: record.added,
    changed: record.changed,
    removed,
  };
}

/** What is still on the drawing to be shown: added and changed elements. */
export function changedCount(change: ViewChange): number {
  return change.added.length + change.changed.length;
}

const elements = (n: number): string => `${n} element${n === 1 ? "" : "s"}`;

/**
 * "The agent changed 3 elements", or, when it only removed, "The agent
 * removed 1 element". The lists may all be empty -- a change of shape or
 * style the element diff does not see -- and that is still a change: "The
 * agent changed this diagram", never "0 elements".
 */
export function changeHeadline(change: ViewChange): string {
  const who = change.by === "agent" ? "The agent" : "An editor";
  const count = changedCount(change);
  if (count > 0) return `${who} changed ${elements(count)}`;
  if (change.removed.length > 0) return `${who} removed ${elements(change.removed.length)}`;
  return `${who} changed this diagram`;
}
