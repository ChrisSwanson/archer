/**
 * A walkthrough step as the page draws it (ADR 0034 §4). Not a new drawing channel: the step becomes
 * two emphasis groups and a focus, which the canvases already draw. Built here, never stored or sent.
 *
 *   walk-active  the current step, a teal flow (moving arrows), named "step N, current"
 *   walk-walked  every earlier step, a quieter tone of teal, named "walked"
 *   focus        active plus walked: the rest steps back
 *
 * A step draws its lines with the boxes at their ends. Out-of-date steps contribute nothing, and no group
 * names an id the model no longer has. Model ids
 * throughout: the nested view translates them to what is drawn (`nest-page.ts`), as for any emphasis.
 */
import type { Emphasis, EmphasisGroup } from "../emphasis/contract";
import type { Walk, WalkStep } from "./contract";

export const WALK_ACTIVE = "walk-active";
export const WALK_WALKED = "walk-walked";

export type WalkRender = {
  readonly emphasis: Emphasis | null;
  readonly focus: { readonly nodeIds: string[]; readonly edgeIds: string[] };
};
export type ModelIds = { readonly nodes: ReadonlySet<string>; readonly edges: ReadonlySet<string> };

const NOTHING: WalkRender = { emphasis: null, focus: { nodeIds: [], edgeIds: [] } };

/** A step's boxes (and frames) and lines that the diagram still has, each once. */
export function members(steps: readonly WalkStep[], model: ModelIds): { nodes: string[]; edges: string[] } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const step of steps) {
    if (step.status === "out-of-date") continue;
    for (const node of step.nodes) if (model.nodes.has(node.id)) nodes.add(node.id);
    for (const edge of step.edges) {
      if (!model.edges.has(edge.id)) continue;
      edges.add(edge.id);
      // A line is drawn with the boxes at its ends, as the approved prototype does.
      for (const end of [edge.source, edge.target]) if (model.nodes.has(end)) nodes.add(end);
    }
  }
  return { nodes: [...nodes], edges: [...edges] };
}

type Members = { readonly nodes: string[]; readonly edges: string[] };

/** The two groups of a step: the current one flowing, the earlier ones quiet; a group with nothing in it is left out. */
export function walkGroups(step: number, active: Members, walked: Members): EmphasisGroup[] {
  const candidates: EmphasisGroup[] = [
    {
      id: WALK_ACTIVE,
      style: "flow",
      palette: "teal",
      state: "existing",
      speed: "normal",
      label: `Step ${step}`,
      description: "",
      spoken: `step ${step}, current`,
      ...active,
    },
    {
      id: WALK_WALKED,
      style: "highlight",
      palette: "teal",
      state: "existing",
      speed: null,
      label: "Walked",
      description: "",
      tone: "walked",
      spoken: "walked",
      ...walked,
    },
  ];
  return candidates.filter((group) => group.nodes.length + group.edges.length > 0);
}

export function walkRender(walk: Walk, step: number, model: ModelIds): WalkRender {
  if (walk.status === "archived" || step < 1 || step > walk.steps.length) return NOTHING;
  const active = members(walk.steps.slice(step - 1, step), model);
  const walked = members(walk.steps.slice(0, step - 1), model);
  const groups = walkGroups(step, active, walked);
  if (groups.length === 0) return NOTHING;
  return {
    emphasis: { id: `walkthrough:${walk.id}`, viewId: "", title: walk.title, groups, legend: false },
    focus: {
      nodeIds: [...new Set([...active.nodes, ...walked.nodes])],
      edgeIds: [...new Set([...active.edges, ...walked.edges])],
    },
  };
}

/** The step a clicked element belongs to: this one if it names it, else the first (not out of date) that does. */
export function stepFor(walk: Walk, channel: "node" | "edge", id: string, current: number): number | null {
  const names = (step: WalkStep | undefined): boolean =>
    step !== undefined &&
    step.status !== "out-of-date" &&
    (channel === "node"
      ? step.nodes.some((n) => n.id === id) || step.edges.some((e) => e.source === id || e.target === id)
      : step.edges.some((e) => e.id === id));
  if (names(walk.steps[current - 1])) return current;
  const first = walk.steps.findIndex(names);
  return first < 0 ? null : first + 1;
}

/** "Customer → Storefront": the ends of a step's messages (a chain once), else of its lines, else its boxes. */
export function routeOf(step: WalkStep, label: (id: string) => string): string {
  const pairs =
    step.messages.length > 0
      ? step.messages.map((m) => [m.from, m.to] as const)
      : step.edges.map((e) => [e.source, e.target] as const);
  if (pairs.length === 0) return [...new Set(step.nodes.map((n) => label(n.id)))].join(", ");
  if (pairs.length > 1 && pairs[0]![1] === pairs[1]![0])
    return [pairs[0]![0], pairs[0]![1], pairs[1]![1]].map(label).join(" → ");
  const names = (ids: string[]): string => [...new Set(ids.map(label))].join(", ");
  return `${names(pairs.map((p) => p[0]))} → ${names(pairs.map((p) => p[1]))}`;
}
