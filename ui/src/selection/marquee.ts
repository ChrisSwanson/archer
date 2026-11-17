/**
 * The edges a marquee selects along with its nodes.
 *
 * AN EDGE COMES WITH THE MARQUEE WHEN BOTH ITS ENDS DO. The rectangle selects
 * every node it touches (`SelectionMode.Partial`); the edges are then the ones
 * that run between two of those nodes, so what is selected is a piece of the
 * diagram and not a set of boxes with the lines between them left out. A
 * marquee round everything selects exactly what Select all does.
 *
 * Not "every edge the rectangle crosses": a wire routed through the rectangle
 * on its way between two nodes outside it is not part of what was framed, and
 * hit-testing a rectangle against routed polylines would make the result
 * depend on the router. Not React Flow's own rule either -- every edge
 * CONNECTED to a covered node -- which reaches out of the rectangle to edges
 * whose other end the reader did not touch. (React Flow never applied it here
 * in any case: the flow is controlled, and the edge changes were dropped, so a
 * marquee used to select nodes and no edges at all.)
 *
 * Order is the edges' own, so the result is stable while the rectangle moves.
 */
export function edgesAmong(
  nodeIds: readonly string[],
  edges: readonly { readonly id: string; readonly source: string; readonly target: string }[],
): string[] {
  const covered = new Set(nodeIds);
  return edges.filter((edge) => covered.has(edge.source) && covered.has(edge.target)).map((edge) => edge.id);
}
