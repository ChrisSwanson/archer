// The pure part of comment grounding, shared by the live store (`ts/src/comments/store.ts`) and the
// browser-local playground tools: what a target's anchors are checked against, and the anchor as it is now.
// Passage matching is the caller's: the store renders the note as the service does.
import { Bad } from "./comment-shapes.mts";
import { eachSequenceEvent } from "./sequence-events.mts";
import type { Anchor, TargetRef } from "../ts/src/comments/contract.ts";
import type { DiagramModel } from "../ts/src/model/envelope.ts";
import type { SequenceTrace } from "../ts/src/model/sequence.ts";
import { elementsOf as modelElements } from "../ts/src/model/elements.ts";
import { isGraphModel } from "../ts/src/model/kinds.ts";

/**
 * What a target's anchors are checked against: a view's elements, keyed
 * `<kind>:<id>` with their labels (null when the view has never compiled), or
 * a note's Markdown (null when it could not be read).
 */
export type Subject =
  | {
      readonly kind: "view";
      readonly elements: ReadonlyMap<string, string> | null;
      readonly unavailable?: string;
      /** The view's walkthroughs by id (an empty map when it has none); null or absent when they could not be read (ADR 0034 §9). */
      readonly walkthroughs?: ReadonlyMap<string, WalkthroughSubject> | null;
      /** The compiled model's revision now, recorded on a new thread (`Thread.modelRevision`). */
      readonly modelRevision?: string;
      /** Current compiler-verified scopes; absent for stable anchors, null when unavailable. */
      readonly scopedIdentities?: ReadonlyMap<string, ScopedEntry> | null;
      readonly scopedUnavailable?: string;
    }
  | { readonly kind: "note"; readonly text: string | null }
  /** The project conversation: it has one anchor, the whole project. */
  | { readonly kind: "project" };

/** A compiler adapter supplies semantics; the store only matches identity within an anchor kind. */
export interface ScopedEntry {
  readonly fingerprint: string;
  readonly unique: boolean;
  readonly label: string;
  /** A compiler-detected anchor collision refuses creation and prevents reconciliation. */
  readonly refusal?: string;
}

/** What a walkthrough or step anchor is checked against: the walkthrough's title and its steps in order. */
export interface WalkthroughSubject {
  readonly title: string;
  readonly steps: readonly { readonly id: string; readonly title: string }[];
}

/** A model's commentable elements: nodes (participants), edges (messages) and groups (fragments). */
export function elementsOf(model: DiagramModel): Map<string, string> {
  const elements = new Map<string, string>();
  if (isGraphModel(model)) {
    for (const n of model.nodes) elements.set(`node:${n.id}`, n.label);
    for (const e of model.edges) elements.set(`edge:${e.id}`, e.label ?? `${e.source} → ${e.target}`);
    for (const g of model.groups) elements.set(`group:${g.id}`, g.label);
    return elements;
  }
  if (model.type !== "sequence-trace") {
    // State, ER, C4, architecture and journey: the model's own nodes and
    // links (states and transitions, entities and relationships, ...).
    const { nodes, links } = modelElements(model);
    for (const n of nodes) elements.set(`node:${n.id}`, n.label);
    for (const l of links) elements.set(`edge:${l.id}`, l.label ?? `${l.source} → ${l.target}`);
    return elements;
  }
  for (const p of model.participants) elements.set(`node:${p.id}`, p.label);
  for (const event of eachSequenceEvent(model.events)) {
    if (event.type === "message") elements.set(`edge:${event.id}`, event.label ?? `${event.from} → ${event.to}`);
    else if (event.type === "fragment") {
      elements.set(`group:${event.id}`, event.label);
    }
  }
  return elements;
}

/** The anchor as the target holds it now, with labels from the model; refused when it names nothing there. */
export function ground(
  target: TargetRef,
  given: Anchor,
  subject: Subject,
  found: (passage: Extract<Anchor, { kind: "passage" }>, text: string) => boolean,
): Anchor {
  if (subject.kind === "project") {
    if (given.kind !== "project") throw new Bad(`the project conversation takes a project anchor, not a ${given.kind}`);
    return given;
  }
  if (given.kind === "project")
    throw new Bad("a project anchor belongs to the project conversation (target project:), not to a diagram or note");
  if (given.kind === "view") return given;
  if (subject.kind === "note") {
    if (given.kind !== "passage")
      throw new Bad(`a note takes comments on the whole note or on a passage, not on a ${given.kind}`);
    if (subject.text === null) throw new Bad(`${target} cannot be read, so a passage of it cannot be anchored`);
    if (!found(given, subject.text)) throw new Bad("the passage's quote is not found in the rendered note");
    return given;
  }
  if (given.kind === "passage") throw new Bad("a passage anchors a comment on a note, not on a diagram");
  if (given.kind === "group" && subject.scopedIdentities === null)
    throw new Bad(subject.scopedUnavailable ?? `${target} has no current compiled scopes`);
  if (given.kind === "walkthrough" || given.kind === "step") {
    const walkthroughs = subject.walkthroughs;
    if (walkthroughs === undefined || walkthroughs === null)
      throw new Bad(`the walkthroughs of ${target} cannot be read, so a walkthrough or step cannot be commented on`);
    const now = walkthroughSubjectNow(given, walkthroughs);
    if (now === "walkthrough-gone")
      throw new Bad(
        `the diagram has no walkthrough "${given.walkthrough}"${walkthroughs.size === 0 ? "" : `; it has ${[...walkthroughs.keys()].map((id) => `"${id}"`).join(", ")}`}`,
      );
    if (now === "step-gone" && given.kind === "step")
      throw new Bad(`walkthrough "${given.walkthrough}" has no step "${given.step}"`);
    return now as Anchor;
  }
  if (given.kind === "node" || given.kind === "group") {
    const scope = subject.scopedIdentities?.get(`${given.kind}:${given.id}`);
    if (scope !== undefined) {
      if (scope.refusal !== undefined) throw new Bad(scope.refusal);
      return { ...given, label: scope.label };
    }
  }
  const elements = subject.elements;
  if (elements === null)
    throw new Bad(
      subject.unavailable ?? `${target} has no current compiled model, so only the whole diagram can be commented on`,
    );
  const label = (kind: string, id: string): string => {
    const known = elements.get(`${kind}:${id}`);
    if (known === undefined) throw new Bad(`the diagram has no ${kind} "${id}"`);
    return known;
  };
  if (given.kind === "selection")
    return {
      kind: "selection",
      nodes: given.nodes.map((n) => ({ id: n.id, label: label("node", n.id) })),
      edges: given.edges.map((e) => ({ id: e.id, label: label("edge", e.id) })),
      ...(given.context === undefined ? {} : { context: given.context }),
    };
  return {
    kind: given.kind,
    id: given.id,
    label: label(given.kind, given.id),
    ...(given.context === undefined ? {} : { context: given.context }),
  };
}

/**
 * A walkthrough or step anchor against the view's walkthroughs: the anchor with its label as it is now, or why it
 * names nothing. A walkthrough that is only archived is still there, so it is not gone (ADR 0034 §9).
 */
export function walkthroughSubjectNow(
  given: Extract<Anchor, { kind: "walkthrough" | "step" }>,
  walkthroughs: ReadonlyMap<string, WalkthroughSubject>,
): Anchor | "walkthrough-gone" | "step-gone" {
  const held = walkthroughs.get(given.walkthrough);
  if (held === undefined) return "walkthrough-gone";
  if (given.kind === "walkthrough") return { kind: "walkthrough", walkthrough: given.walkthrough, label: held.title };
  const at = held.steps.findIndex((s) => s.id === given.step);
  const step = held.steps[at];
  if (step === undefined) return "step-gone";
  return { kind: "step", walkthrough: given.walkthrough, step: given.step, label: `${at + 1}. ${step.title}` };
}

/** A note whose id also names a participant cannot be anchored apart from it. */
export const noteNamesParticipant = (id: string): string =>
  `the note id "${id}" also names a participant; comment on the whole diagram until the participant is renamed`;

/**
 * A sequence trace's scoped anchors as grounding reads them: each fragment (`group:`) and note (`node:`) with
 * its label and any refusal. The live store's entries (`ts/src/comments/scoped-identities.ts`) also carry
 * fingerprints for reconciliation, which grounding a new anchor does not read.
 */
export function sequenceScopeLabels(trace: SequenceTrace): ReadonlyMap<string, ScopedEntry> {
  const participants = new Set(trace.participants.map((participant) => participant.id));
  const entries = new Map<string, ScopedEntry>();
  for (const event of eachSequenceEvent(trace.events)) {
    if (event.type === "fragment")
      entries.set(`group:${event.id}`, { fingerprint: "", unique: true, label: event.label });
    else if (event.type === "note")
      entries.set(`node:${event.id}`, {
        fingerprint: "",
        unique: true,
        label: event.text,
        ...(participants.has(event.id) ? { refusal: noteNamesParticipant(event.id) } : {}),
      });
  }
  return entries;
}
