/**
 * What the agent shows is drawn as itself (J11-F1): an emphasis or a presented focus on parts inside a closed
 * container opens the containers that hold them, the way a followed walkthrough step does (`walk-nest.ts`).
 * Emphasis on a part that is still hidden keeps resolving to the box that stands for it (ADR 0029): this only
 * changes what is open. Once per thing shown, keyed on its content, so the person's own "−" afterwards holds
 * until the agent shows something else (a poll or a re-read of the same emphasis opens nothing).
 */
import { useEffect, useRef } from "react";
import type { ProjectedView } from "../diagrams/projection";
import { neededOpen } from "../walkthroughs/walk-nest";
import { canonicalOpen, type Nested } from "./nest-view";

type Ids = { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };

/** The open set that draws every target as itself: what is open plus what they need; null when that is what is open. */
export function revealOpen(full: ProjectedView, open: readonly string[], ids: Ids): string[] | null {
  const from = canonicalOpen(full, open);
  const target = canonicalOpen(full, [
    ...from,
    ...neededOpen(full, { nodes: [...ids.nodeIds], edges: [...ids.edgeIds] }),
  ]);
  return target.join(",") === from.join(",") ? null : target;
}

export function useRevealTargets(options: {
  /** What is shown, by content (null: nothing). A key handled once is not handled again. */
  readonly key: string | null;
  readonly ids: Ids;
  /** False while something else owns the open set (a walkthrough, the editor): what is shown meanwhile opens nothing. */
  readonly enabled: boolean;
  readonly nest: {
    readonly drawn: { readonly full: ProjectedView; readonly nested: Nested } | null;
    readonly current: () => readonly string[];
    readonly set: (open: readonly string[]) => number | null;
  };
}): void {
  const { key, ids, enabled, nest } = options;
  const handled = useRef<string | null>(null);
  const latest = useRef({ ids, nest });
  latest.current = { ids, nest };
  const ready = nest.drawn !== null;
  useEffect(() => {
    const { ids: now, nest: at } = latest.current;
    if (key === null || handled.current === key) return;
    // Shown while a walkthrough or the editor had the view: leaving it restores that view, which wins.
    if (!enabled) {
      handled.current = key;
      return;
    }
    if (at.drawn === null) return;
    handled.current = key;
    const target = revealOpen(at.drawn.full, at.current(), now);
    if (target !== null) at.set(target);
  }, [key, enabled, ready]);
}
