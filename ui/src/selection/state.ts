/** What was selected when an additive marquee began. */
export type AdditiveBase = {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
};

export type SelectionState = {
  readonly viewId: string;
  readonly revision: string;
  readonly presentationId: string;
  readonly selectionRevision: number;
  readonly selectedNodeIds: readonly string[];
  readonly selectedEdgeIds: readonly string[];
  /**
   * Held only for the length of an additive drag; `null` at rest.
   *
   * The canvas reports the rectangle's CURRENT contents each time they change
   * (`useMarqueeContents`), never a delta -- so without somewhere to keep what
   * the user already had, "add to the selection" is unbuildable.
   */
  readonly additiveBase: AdditiveBase | null;
};

export type SelectionAction =
  | { type: "restore"; state: SelectionState }
  | { type: "select"; nodeIds: readonly string[]; edgeIds: readonly string[] }
  | { type: "clear" }
  | { type: "page_turn"; viewId: string; revision: string; presentationId: string }
  | {
      // The same view recompiled. `nodeIds`/`edgeIds` are what the new model
      // contains, not what is selected.
      type: "revision_change";
      revision: string;
      nodeIds: readonly string[];
      edgeIds: readonly string[];
    }
  | { type: "marquee_start"; additive: boolean }
  | { type: "marquee_end" }
  /** An additive click: the id joins the selection, or leaves it if already in. */
  | { type: "toggle"; nodeIds: readonly string[]; edgeIds: readonly string[] };

/** `base` first, then whatever `incoming` adds, each id once. */
function union(base: readonly string[], incoming: readonly string[]): readonly string[] {
  const held = new Set(base);
  return [...base, ...incoming.filter((id) => !held.has(id))];
}

export function selectionReducer(state: SelectionState | null, action: SelectionAction): SelectionState | null {
  switch (action.type) {
    case "restore":
      return action.state;
    case "page_turn":
      return {
        viewId: action.viewId,
        revision: action.revision,
        presentationId: action.presentationId,
        selectionRevision: 0,
        selectedNodeIds: [],
        selectedEdgeIds: [],
        additiveBase: null,
      };

    case "marquee_start": {
      if (state === null) {
        return null;
      }
      // No revision bump: starting a drag is not yet a selection, and the
      // revision is what the host validates the next one against.
      return {
        ...state,
        additiveBase: action.additive ? { nodeIds: state.selectedNodeIds, edgeIds: state.selectedEdgeIds } : null,
      };
    }

    case "marquee_end": {
      if (state === null || state.additiveBase === null) {
        return state;
      }
      return { ...state, additiveBase: null };
    }

    case "revision_change": {
      if (state === null) {
        return null;
      }
      // Stable IDs mean a node keeps its identity across an edit that did not
      // touch it, so what still exists stays selected; only what the edit
      // removed is dropped. The revision must move regardless -- it is the
      // stamp the host validates the next click against, and leaving it behind
      // makes every later selection stale.
      const presentNodes = new Set(action.nodeIds);
      const presentEdges = new Set(action.edgeIds);
      const selectedNodeIds = state.selectedNodeIds.filter((id) => presentNodes.has(id));
      const selectedEdgeIds = state.selectedEdgeIds.filter((id) => presentEdges.has(id));
      const survivedIntact =
        selectedNodeIds.length === state.selectedNodeIds.length &&
        selectedEdgeIds.length === state.selectedEdgeIds.length;

      return {
        ...state,
        revision: action.revision,
        selectedNodeIds,
        selectedEdgeIds,
        // Losing part of the selection is a change the host has to see; an
        // untouched selection is only re-stamped, not re-made.
        selectionRevision: survivedIntact ? state.selectionRevision : state.selectionRevision + 1,
      };
    }

    case "select": {
      if (state === null) {
        return null;
      }
      // Merged into the base the drag STARTED from, never into the previous
      // result: each report is a fresh account of what the rectangle covers
      // now, so accumulating would make the selection grow monotonically
      // and never release a node the user has dragged back off.
      const additive = state.additiveBase;
      return {
        ...state,
        selectedNodeIds: additive === null ? action.nodeIds : union(additive.nodeIds, action.nodeIds),
        selectedEdgeIds: additive === null ? action.edgeIds : union(additive.edgeIds, action.edgeIds),
        selectionRevision: state.selectionRevision + 1,
      };
    }

    case "toggle": {
      if (state === null) {
        return null;
      }
      const toggle = (held: readonly string[], incoming: readonly string[]): readonly string[] => {
        const next = new Set(held);
        for (const id of incoming) {
          if (!next.delete(id)) {
            next.add(id);
          }
        }
        // Insertion order is the order they were added, which is the order the
        // user built the selection in.
        return [...held.filter((id) => next.has(id)), ...incoming.filter((id) => next.has(id) && !held.includes(id))];
      };

      return {
        ...state,
        selectedNodeIds: toggle(state.selectedNodeIds, action.nodeIds),
        selectedEdgeIds: toggle(state.selectedEdgeIds, action.edgeIds),
        selectionRevision: state.selectionRevision + 1,
      };
    }

    case "clear": {
      if (state === null) {
        return null;
      }
      return {
        ...state,
        selectedNodeIds: [],
        selectedEdgeIds: [],
        selectionRevision: state.selectionRevision + 1,
        // A clear during a drag ends the drag's claim too, or the next report
        // would resurrect what was just cleared.
        additiveBase: null,
      };
    }

    default:
      return state;
  }
}

/** Validate an initial recovery against the model/stamp actually being drawn. */
export function recoveredSelection(
  raw: unknown,
  stamp: { viewId: string; revision: string; presentationId: string },
  ids: { nodeIds: readonly string[]; edgeIds: readonly string[] },
): SelectionState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const held = raw as Record<string, unknown>;
  if (
    held.schemaVersion !== 1 ||
    held.viewId !== stamp.viewId ||
    held.revision !== stamp.revision ||
    held.presentationId !== stamp.presentationId
  )
    return null;
  const revision = held.selectionRevision ?? 0;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) return null;
  const readIds = (items: unknown, allowed: readonly string[]): string[] | null => {
    if (!Array.isArray(items)) return null;
    const known = new Set(allowed),
      seen = new Set<string>(),
      result: string[] = [];
    for (const item of items) {
      if (
        typeof item !== "object" ||
        item === null ||
        !("id" in item) ||
        typeof item.id !== "string" ||
        !known.has(item.id) ||
        seen.has(item.id)
      )
        return null;
      seen.add(item.id);
      result.push(item.id);
    }
    return result;
  };
  const nodes = readIds(held.nodes, ids.nodeIds),
    edges = readIds(held.edges, ids.edgeIds);
  return nodes === null || edges === null
    ? null
    : {
        ...stamp,
        selectionRevision: Number(revision),
        selectedNodeIds: nodes,
        selectedEdgeIds: edges,
        additiveBase: null,
      };
}
