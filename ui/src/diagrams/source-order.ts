/**
 * The order a graph's source writes things in (`sourceOrder`, ADR 0009 amended 2026-11-12): nodes and groups by
 * where each is first written, interleaved and tagged (a subgraph may share its id with a node), and edges as
 * written. A model leaves it out when it says nothing its own lists do not -- every node, then every group, each
 * as listed (by id for a flowchart, as written for C4 and architecture); edges as listed -- so this reads either.
 * The layout's model order and the Key's rows read it; no colour does.
 */
export type SourceElement = { readonly id: string; readonly kind: "node" | "group" };
export type SourceOrder = { readonly elements: readonly SourceElement[]; readonly edges: readonly string[] };

/** What a view or layout carries that this reads. */
export type Ordered = {
  readonly nodes: readonly { readonly id: string }[];
  readonly groups: readonly { readonly id: string }[];
  readonly edges?: readonly { readonly id: string }[];
  readonly sourceOrder?: SourceOrder;
};

/** The written order: the model's own `sourceOrder`, else its lists' order. */
export function writtenOrder(drawing: Ordered): SourceOrder {
  return (
    drawing.sourceOrder ?? {
      elements: [
        ...drawing.nodes.map((node) => ({ id: node.id, kind: "node" as const })),
        ...drawing.groups.map((group) => ({ id: group.id, kind: "group" as const })),
      ],
      edges: (drawing.edges ?? []).map((edge) => edge.id),
    }
  );
}
