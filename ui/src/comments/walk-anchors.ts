/**
 * Comments on walkthroughs, as pure rules (ADR 0034 §9): the anchors the open walkthrough offers, the
 * `context` an element comment carries while one is open, the picker's list, what a thread says of
 * its walkthrough, and the count on a step row. Nothing here touches the DOM.
 */
import { idsKey, type Kept } from "../app/diagram-mode";
import type { Walk } from "../walkthroughs/contract";
import type { AnchorChoice } from "./Composer";
import type { Anchor, Thread } from "./contract";
import { anchorLabel, pinState, type PinState } from "./state";

export type WalkContext = { readonly walkthrough: string; readonly step: string };

/** The step's anchor; `label` is a word for the panel, the server writes its own. */
export function stepAnchor(walk: Walk, number: number): Anchor {
  const step = walk.steps[number - 1];
  return { kind: "step", walkthrough: walk.id, step: step?.id ?? "", label: `${number}. ${step?.title ?? ""}` };
}

export const walkAnchor = (walk: Walk): Anchor => ({ kind: "walkthrough", walkthrough: walk.id, label: walk.title });

/** Where the person is: the step being seen. None for an archived walkthrough, which is not stepped. */
export function contextOf(walk: Walk | null, number: number): WalkContext | null {
  const step = walk === null || walk.status === "archived" ? undefined : walk.steps[number - 1];
  return walk === null || step === undefined ? null : { walkthrough: walk.id, step: step.id };
}

/** An element anchor says where it was seen; any other anchor is about what it names. */
export function withContext(anchor: Anchor, context: WalkContext | null): Anchor {
  if (context === null) return anchor;
  return anchor.kind === "node" || anchor.kind === "edge" || anchor.kind === "group" || anchor.kind === "selection"
    ? { ...anchor, context }
    : anchor;
}

/** The model ids an element anchor is about; null for any other anchor. */
function anchorIds(
  anchor: Anchor,
): { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] } | null {
  if (anchor.kind === "node" || anchor.kind === "group") return { nodeIds: [anchor.id], edgeIds: [] };
  if (anchor.kind === "edge") return { nodeIds: [], edgeIds: [anchor.id] };
  if (anchor.kind === "selection")
    return { nodeIds: anchor.nodes.map((n) => n.id), edgeIds: anchor.edges.map((e) => e.id) };
  return null;
}

/**
 * Just after a click off a walkthrough's path left it (D4): the step it left from, on an anchor about exactly what
 * that click left selected. Any other anchor (another element right-clicked, the whole diagram) is about Explore.
 */
export function keptAnchor(anchor: Anchor, kept: Kept | null): Anchor {
  const ids = kept === null ? null : anchorIds(anchor);
  return ids !== null && kept !== null && idsKey(ids) === kept.ids ? withContext(anchor, kept.context) : anchor;
}

/**
 * The picker while a walkthrough is open: what is selected (with context), then the walkthrough and
 * the step on show, then the whole diagram and its groups.
 */
export function walkChoices(base: readonly AnchorChoice[], walk: Walk | null, number: number): readonly AnchorChoice[] {
  if (walk === null) return base;
  const context = contextOf(walk, number);
  const lead =
    base[0] !== undefined &&
    (base[0].anchor.kind === "node" || base[0].anchor.kind === "edge" || base[0].anchor.kind === "selection")
      ? 1
      : 0;
  const here = (choice: AnchorChoice): AnchorChoice => ({ ...choice, anchor: withContext(choice.anchor, context) });
  const own = (anchor: Anchor): AnchorChoice => ({ anchor, label: anchorLabel(anchor, "view") });
  return [
    ...base.slice(0, lead).map(here),
    own(walkAnchor(walk)),
    ...(walk.steps[number - 1] === undefined ? [] : [own(stepAnchor(walk, number))]),
    ...base.slice(lead).map(here),
  ];
}

/** `ok`; the step is `out-of-date`; the walkthrough is `archived`; or either is `gone` (the thread is orphaned). */
export type WalkFacts = {
  readonly walkthrough: string;
  readonly title: string;
  readonly step?: string;
  /** The step's number now. */
  readonly number?: number;
  readonly state: "ok" | "out-of-date" | "archived" | "gone";
};

/** What a thread says of its walkthrough and step, or null when it is about neither. */
export function walkFacts(anchor: Anchor, walks: readonly Walk[]): WalkFacts | null {
  const ref =
    anchor.kind === "step"
      ? anchor
      : anchor.kind === "walkthrough"
        ? { walkthrough: anchor.walkthrough }
        : "context" in anchor && anchor.context !== undefined
          ? anchor.context
          : null;
  if (ref === null) return null;
  const stepId = "step" in ref ? ref.step : undefined;
  const walk = walks.find((w) => w.id === ref.walkthrough);
  if (walk === undefined)
    return {
      walkthrough: ref.walkthrough,
      title: ref.walkthrough,
      ...(stepId === undefined ? {} : { step: stepId }),
      state: "gone",
    };
  const index = stepId === undefined ? -1 : walk.steps.findIndex((s) => s.id === stepId);
  const found = index === -1 ? undefined : walk.steps[index];
  const state =
    stepId !== undefined && found === undefined
      ? "gone"
      : walk.status === "archived"
        ? "archived"
        : found?.status === "out-of-date"
          ? "out-of-date"
          : "ok";
  return {
    walkthrough: walk.id,
    title: walk.title,
    ...(stepId === undefined ? {} : { step: stepId }),
    ...(found === undefined ? {} : { number: index + 1 }),
    state,
  };
}

const URGENCY: readonly PinState[] = ["draft", "sent", "answered", "resolved"];

export type StepBadge = {
  readonly count: number;
  readonly state: PinState /** The thread that most needs the person (the first of that state), which the badge opens. */;
  readonly thread: string;
};

/** Per step id of `walk`: how many live threads are about it, in the state that most needs the person. */
export function stepBadges(threads: readonly Thread[], walk: string): ReadonlyMap<string, StepBadge> {
  const out = new Map<string, StepBadge>();
  for (const thread of threads) {
    const a = thread.anchor;
    if (a.kind !== "step" || a.walkthrough !== walk || thread.orphaned === true) continue;
    const state = pinState(thread);
    const held = out.get(a.step);
    if (held === undefined) out.set(a.step, { count: 1, state, thread: thread.id });
    else if (URGENCY.indexOf(state) < URGENCY.indexOf(held.state))
      out.set(a.step, { thread: thread.id, count: held.count + 1, state });
    else out.set(a.step, { ...held, count: held.count + 1 });
  }
  return out;
}

/**
 * What `C` (and "New comment") is about: the selection, with the step it was seen on while a walkthrough
 * is open; with nothing selected the walkthrough when one is open (ADR 0034 §9), else the whole diagram.
 */
export function defaultAnchor(selected: Anchor, walk: Walk | null, number: number): Anchor {
  if (walk === null) return selected;
  return selected.kind === "view" ? walkAnchor(walk) : withContext(selected, contextOf(walk, number));
}
