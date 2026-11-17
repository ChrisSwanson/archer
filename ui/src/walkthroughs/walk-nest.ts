/**
 * What a walkthrough does to the nested view (ADR 0034 §6, ADR 0029; prototype round 3). Pure, in
 * model ids; the page applies the answers through the nest state it already has.
 *
 *   - A step needs the containers that hold its parts open; following opens them before the step.
 *   - A container the person closed stays closed for the step: the step is drawn on the closed box
 *     (`nestEmphasis`) with a note that opens it; only the next step, with following on, reopens it.
 *   - A step is a pure function of the step (0.6.4, D2): the start set (the walkthrough's recorded open
 *     set, else the view saved on entering it) plus what steps 1…N need. Previous, a jump, a replay and
 *     a reopen draw the same picture; `?open=` is Explore's, never a walkthrough's.
 */
import type { ProjectedView } from "../diagrams/projection";
import { canonicalOpen } from "../nesting/nest-view";

/** The containers around a node or container, innermost first (a container's own parents, not itself). */
function around(view: ProjectedView, id: string): string[] {
  const groups = new Map(view.groups.map((group) => [group.id, group]));
  const node = view.nodes.find((n) => n.id === id);
  const chain: string[] = [];
  const seen = new Set<string>();
  for (
    let at = node !== undefined ? node.groupId : groups.get(id)?.parentId;
    at !== undefined && !seen.has(at) && groups.has(at);
    at = groups.get(at)!.parentId
  ) {
    seen.add(at);
    chain.push(at);
  }
  return chain;
}

/** The containers to open to see `parts` as themselves, canonical. */
export function neededOpen(
  view: ProjectedView,
  parts: { readonly nodes: readonly string[]; readonly edges: readonly string[] },
): string[] {
  const ids = new Set(parts.nodes);
  for (const id of parts.edges) {
    const edge = view.edges.find((e) => e.id === id);
    if (edge !== undefined) {
      ids.add(edge.source);
      ids.add(edge.target);
    }
  }
  return canonicalOpen(
    view,
    [...ids].flatMap((id) => around(view, id)),
  );
}

/** The open set a walkthrough starts from: its recorded set, else the view saved when it was entered. */
export function startOpen(view: ProjectedView, recorded: readonly string[], saved: readonly string[]): string[] {
  return canonicalOpen(view, recorded.length > 0 ? recorded : saved);
}

/** The open set of step `step` (1-based): the start set plus every container steps 1…`step` need. Pure. */
export function stepOpen(
  view: ProjectedView,
  start: readonly string[],
  needed: readonly (readonly string[])[],
  step: number,
): string[] {
  return canonicalOpen(view, [...start, ...needed.slice(0, Math.max(0, step)).flat()]);
}

/** The outermost container the step needs that is closed: what "Open … to see the detail" names. */
export function closedNote(
  view: ProjectedView,
  needed: readonly string[],
  open: readonly string[],
): { id: string; label: string } | null {
  const have = new Set(open);
  const depth = (id: string): number => around(view, id).length;
  const closed = needed.filter((id) => !have.has(id)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
  const group = closed === undefined ? undefined : view.groups.find((g) => g.id === closed);
  return group === undefined ? null : { id: group.id, label: group.label };
}
