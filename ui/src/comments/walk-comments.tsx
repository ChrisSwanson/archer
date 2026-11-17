/**
 * What the walkthrough panel and the thread cards need of each other (ADR 0034 §9), handed down by
 * `App` so neither imports the other: the diagram's walkthroughs, its threads, and the four things
 * a person does there. Absent (no walkthroughs, or no comments) the panel and the cards are as before.
 */
import { createContext, useContext, useMemo } from "react";
import type { Walk } from "../walkthroughs/contract";
import type { TargetRef, Thread } from "./contract";
import { stepBadges, type StepBadge } from "./walk-anchors";

export type WalkComments = {
  /** The diagram these walkthroughs belong to; a thread on another one is not read against them. */
  readonly target: TargetRef;
  readonly walks: readonly Walk[];
  readonly threads: readonly Thread[];
  /** Open the composer on a step (right-click, the context-menu key, `C` on a row). */
  readonly comment: (walk: Walk, step: number) => void;
  /** Open a thread (a badge was pressed). */
  readonly openThread: (threadId: string) => void;
  /** Open the walkthrough at a step (a card's chip). */
  readonly openStep: (walkthrough: string, step: string) => void;
};

export const WalkCommentsContext = createContext<WalkComments | null>(null);
export const useWalkComments = (): WalkComments | null => useContext(WalkCommentsContext);

/** The badge on each of `walk`'s step rows, by step id. */
export function useStepBadges(walk: Walk | null): ReadonlyMap<string, StepBadge> {
  const held = useWalkComments();
  const threads = held?.threads;
  const id = walk?.id;
  return useMemo(() => (threads === undefined || id === undefined ? NONE : stepBadges(threads, id)), [threads, id]);
}

const NONE: ReadonlyMap<string, StepBadge> = new Map();
