// Semantic comment identity, separate from positional sequence event ids and
// from the schema-v2 diagram contract. See ADR 0034's sequence-block amendment.
import { createHash } from "node:crypto";
import { eachSequenceEvent } from "../../../shared/sequence-events.mts";
import type { FragmentEvent, NoteEvent, SequenceEvent, SequenceTrace } from "../model/index.ts";

export interface SequenceBlock {
  readonly fragment: FragmentEvent;
  readonly fingerprint: string;
}

const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

/**
 * Bottom-up hashes avoid recursion and never serialize a whole nested model.
 * Every semantic field participates; all generated event ids are excluded.
 */
export function sequenceBlocks(trace: SequenceTrace): readonly SequenceBlock[] {
  const events = [...eachSequenceEvent(trace.events)];
  const hashes = new Map<SequenceEvent, string>();
  for (const event of [...events].reverse()) {
    let semantic: unknown;
    switch (event.type) {
      case "fragment":
        semantic = [
          event.type,
          event.kind,
          event.label,
          event.sections.map((section) => [section.label ?? "", section.events.map((child) => hashes.get(child))]),
        ];
        break;
      case "message":
        semantic = [event.type, event.from, event.to, event.kind, event.label ?? "", event.bidirectional === true];
        break;
      case "note":
        semantic = [event.type, event.position, event.participants, event.text];
        break;
      default:
        semantic = [event.type, event.participant];
    }
    hashes.set(event, digest(semantic));
  }
  const blocks: SequenceBlock[] = [];
  // A parent path contains its complete semantic subtree and the containing
  // section label. Identical scopes remain ambiguous; no ordinal is identity.
  const work: { event: SequenceEvent; ancestors: readonly (readonly [string, string])[] }[] = [...trace.events]
    .reverse()
    .map((event) => ({ event, ancestors: [] }));
  for (let next = work.pop(); next !== undefined; next = work.pop()) {
    const { event, ancestors } = next;
    if (event.type !== "fragment") continue;
    const semantic = hashes.get(event)!;
    blocks.push({ fragment: event, fingerprint: digest([semantic, ancestors]) });
    for (const section of [...event.sections].reverse()) {
      const path = [...ancestors, [semantic, section.label ?? ""] as const];
      for (const child of [...section.events].reverse()) work.push({ event: child, ancestors: path });
    }
  }
  return blocks;
}

/** Read-only agent context about the whole scope, including all nested branches. */
export function blockContents(fragment: FragmentEvent): {
  kind: FragmentEvent["kind"];
  condition: string;
  messageIds: string[];
  noteIds: string[];
} {
  const messageIds: string[] = [],
    noteIds: string[] = [];
  for (const event of eachSequenceEvent(fragment.sections.flatMap((section) => section.events))) {
    if (event.type === "message") messageIds.push(event.id);
    else if (event.type === "note") noteIds.push(event.id);
  }
  return { kind: fragment.kind, condition: fragment.label, messageIds, noteIds };
}

export interface SequenceNote {
  readonly note: NoteEvent;
  readonly fingerprint: string;
  readonly participants: readonly { readonly id: string; readonly label: string }[];
  readonly block?: { readonly id: string; readonly kind: FragmentEvent["kind"]; readonly condition: string };
}

/**
 * Notes are comment-only targets. Their enclosing scopes omit note children so
 * adding or reordering annotations does not change another note's identity.
 * The remaining semantic subtree distinguishes otherwise identical headers.
 */
export function sequenceNotes(trace: SequenceTrace): readonly SequenceNote[] {
  const events = [...eachSequenceEvent(trace.events)];
  const hashes = new Map<SequenceEvent, string>();
  for (const event of [...events].reverse()) {
    if (event.type === "note") continue;
    const semantic =
      event.type === "fragment"
        ? [
            event.type,
            event.kind,
            event.label,
            event.sections.map((section) => [
              section.label ?? "",
              section.events.filter((child) => child.type !== "note").map((child) => hashes.get(child)),
            ]),
          ]
        : event.type === "message"
          ? [event.type, event.from, event.to, event.kind, event.label ?? "", event.bidirectional === true]
          : [event.type, event.participant];
    hashes.set(event, digest(semantic));
  }
  const result: SequenceNote[] = [];
  const work: { event: SequenceEvent; ancestors: readonly (readonly [string, string])[]; block?: FragmentEvent }[] = [
    ...trace.events,
  ]
    .reverse()
    .map((event) => ({ event, ancestors: [] }));
  for (let next = work.pop(); next !== undefined; next = work.pop()) {
    const { event, ancestors, block } = next;
    if (event.type === "note") {
      result.push({
        note: event,
        fingerprint: digest([[event.type, event.position, event.participants, event.text], ancestors]),
        participants: event.participants.map((id) => ({
          id,
          label: trace.participants.find((p) => p.id === id)?.label ?? id,
        })),
        ...(block === undefined ? {} : { block: { id: block.id, kind: block.kind, condition: block.label } }),
      });
    } else if (event.type === "fragment") {
      for (const section of [...event.sections].reverse()) {
        const path = [...ancestors, [hashes.get(event)!, section.label ?? ""] as const];
        for (const child of [...section.events].reverse()) work.push({ event: child, ancestors: path, block: event });
      }
    }
  }
  return result;
}
