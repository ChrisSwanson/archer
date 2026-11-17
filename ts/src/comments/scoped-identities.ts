// Compiler adapter: positional sequence scopes become family-neutral comment identities.
import type { SequenceTrace } from "../model/index.ts";
import type { ScopedEntry } from "./store.ts";
import { noteNamesParticipant } from "../../../shared/comment-grounding.mts";
import { sequenceBlocks, sequenceNotes, type SequenceBlock, type SequenceNote } from "./sequence-blocks.ts";

export function scopedIdentitiesOf(
  trace: SequenceTrace,
  blocks: readonly SequenceBlock[] = sequenceBlocks(trace),
  notes: readonly SequenceNote[] = sequenceNotes(trace),
): ReadonlyMap<string, ScopedEntry> {
  const entries = new Map<string, ScopedEntry>();
  const participants = new Set(trace.participants.map((participant) => participant.id));
  for (const [kind, scopes] of [
    ["group", blocks.map(({ fragment, fingerprint }) => ({ id: fragment.id, label: fragment.label, fingerprint }))],
    ["node", notes.map(({ note, fingerprint }) => ({ id: note.id, label: note.text, fingerprint }))],
  ] as const) {
    const counts = new Map<string, number>();
    for (const scope of scopes) counts.set(scope.fingerprint, (counts.get(scope.fingerprint) ?? 0) + 1);
    for (const scope of scopes) {
      entries.set(`${kind}:${scope.id}`, {
        fingerprint: scope.fingerprint,
        label: scope.label,
        unique: counts.get(scope.fingerprint) === 1,
        ...(kind === "node" && participants.has(scope.id) ? { refusal: noteNamesParticipant(scope.id) } : {}),
      });
    }
  }
  return entries;
}
