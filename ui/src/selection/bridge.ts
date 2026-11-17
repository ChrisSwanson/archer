import type { SelectionState } from "./state";

export type SelectionContext = {
  readonly schemaVersion: 1;
  readonly viewId: string;
  readonly revision: string;
  readonly presentationId: string;
  readonly selectionRevision: number;
  readonly nodes: readonly { id: string; label: string }[];
  readonly edges: readonly { id: string; source: string; target: string; label?: string }[];
};

export function buildSelectionContext(
  state: SelectionState,
  nodeDetails: ReadonlyMap<string, { label: string }>,
  edgeDetails: ReadonlyMap<string, { source: string; target: string; label?: string }>,
): SelectionContext {
  if (state.viewId.length === 0) {
    throw new Error("SelectionState.viewId must be a non-empty string");
  }
  if (state.revision.length === 0) {
    throw new Error("SelectionState.revision must be a non-empty string");
  }

  const nodes = state.selectedNodeIds.flatMap((id) => {
    const detail = nodeDetails.get(id);
    if (detail === undefined) {
      return [];
    }
    return [{ id, label: detail.label }];
  });

  const edges = state.selectedEdgeIds.flatMap((id) => {
    const detail = edgeDetails.get(id);
    if (detail === undefined) {
      return [];
    }
    return [
      detail.label !== undefined
        ? { id, source: detail.source, target: detail.target, label: detail.label }
        : { id, source: detail.source, target: detail.target },
    ];
  });

  return {
    schemaVersion: 1,
    viewId: state.viewId,
    revision: state.revision,
    presentationId: state.presentationId,
    selectionRevision: state.selectionRevision,
    nodes,
    edges,
  };
}
