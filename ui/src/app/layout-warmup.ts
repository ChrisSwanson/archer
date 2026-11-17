import { readLocationAddress } from "./page-address";

/** Kinds the page draws without ELK: the sequence canvas lays itself out, a journey is laid out by the browser. */
const NO_GRAPH_LAYOUT = new Set(["sequence", "journey"]);

/** Whether a view of `kind` is drawn by the layout worker (ELK). */
export const drawnByLayoutWorker = (kind: string): boolean => !NO_GRAPH_LAYOUT.has(kind);

/**
 * Whether the window's address names a view the inventory lists as a graph, so the layout worker can start with the
 * view's own read instead of after it is drawn (PF-5 keeps it off pages that draw no graph).
 */
export function addressNamesGraph(
  views: readonly {
    readonly id: string;
    readonly kind: string;
    readonly sourcePath?: string;
    readonly registration?: string;
  }[],
): boolean {
  const address = readLocationAddress({ views, notes: [] });
  if (address?.kind !== "view") return false;
  const view = views.find((candidate) => candidate.id === address.viewId);
  return view !== undefined && drawnByLayoutWorker(view.kind);
}
