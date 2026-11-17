/** Durable journal evidence is separate from a snapshot's current disk comparison. */
import type { AuthoringStore } from "./store.ts";
import type { ChangeRecord } from "../changes/index.ts";
import type { ChangeEvidence } from "../changes/review.ts";
export function savedChangeEvidence(store: AuthoringStore | undefined, change: ChangeRecord): ChangeEvidence {
  const fallback: ChangeEvidence = { kind: change.eventKind, causalApply: "unavailable", reviewOrigin: change.origin };
  if (
    !store ||
    change.target.kind !== "document" ||
    !["document.created", "document.updated"].includes(change.eventKind)
  )
    return fallback;
  try {
    const records = store.listOperations(change.projectRoot);
    for (const admission of records) {
      if (admission.state !== "terminal" || admission.completion.review.changeId !== change.changeId) continue;
      const original =
        admission.op === "operation.send" && admission.target.kind === "operation"
          ? store.getOperation(admission.target.operationId)
          : admission;
      if (
        !original ||
        original.projectRoot !== change.projectRoot ||
        original.state !== "terminal" ||
        !original.completion.document ||
        original.completion.evidence !== "observed" ||
        !original.candidate
      )
        continue;
      const expected = change.eventKind === "document.created" ? "created" : "applied";
      if (
        original.completion.outcome !== expected ||
        original.candidate.revision !== change.after.revision ||
        original.candidate.bytes !== change.after.bytes ||
        original.base?.revision !== change.before?.revision ||
        original.base?.bytes !== change.before?.bytes
      )
        continue;
      const document = original.completion.document;
      if (document.path !== change.target.path || document.blockId !== change.target.blockId) continue;
      return { ...fallback, causalApply: "observed" };
    }
  } catch {
    /* Unavailable journal evidence never prevents reading immutable saved work. */
  }
  return fallback;
}
