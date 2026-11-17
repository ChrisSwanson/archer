// Resolution (ADR 0034 §2): each step reference against the current model,
// pure and derived on read. Nothing here writes; a recompile never rewrites a
// walkthrough, and an element that comes back revives its step.
import type { DiagramModel } from "../model/index.ts";
import { elementsOf } from "../model/elements.ts";
import { isGraphModel } from "../model/kinds.ts";
import {
  REFUSED_HOSTS,
  type NodeKind,
  type RefResolution,
  type RefStatus,
  type Resolution,
  type Step,
  type StepResolution,
  type Walkthrough,
  type WalkthroughStatus,
} from "./contract.ts";

/** What a walkthrough can name in one model, by id. */
export interface ModelIndex {
  /** Boxes: a graph's nodes; every other family's points (C4 boundaries and architecture groups among them). */
  readonly nodes: ReadonlyMap<string, string>;
  /** Containers: flowchart subgraphs, C4 boundaries, architecture groups. */
  readonly groups: ReadonlyMap<string, { readonly label: string; readonly parentId: string | null }>;
  readonly edges: ReadonlyMap<string, { readonly source: string; readonly target: string; readonly label?: string }>;
}

/** Why the model cannot host a walkthrough, or null when it can. */
export function refusedHost(model: DiagramModel): string | null {
  return REFUSED_HOSTS[model.type] ?? null;
}

/** The model's nameable elements. Null for a family that cannot host a walkthrough. */
export function indexOf(model: DiagramModel): ModelIndex | null {
  if (model.type === "sequence-trace" || refusedHost(model) !== null) return null;
  const { nodes, links } = elementsOf(model);
  const groups = new Map<string, { label: string; parentId: string | null }>();
  if (isGraphModel(model))
    for (const g of model.groups) groups.set(g.id, { label: g.label, parentId: g.parentId ?? null });
  else if (model.type === "c4-model")
    for (const b of model.boundaries) groups.set(b.id, { label: b.label, parentId: b.parentId ?? null });
  else if (model.type === "service-architecture")
    for (const g of model.groups) groups.set(g.id, { label: g.label, parentId: g.parentId ?? null });
  return {
    nodes: new Map(nodes.map((n) => [n.id, n.label])),
    groups,
    edges: new Map(
      links.map((l) => [l.id, { source: l.source, target: l.target, ...(l.label == null ? {} : { label: l.label }) }]),
    ),
  };
}

/** The label a node reference of `kind` finds, or undefined when the id is not that kind here. */
export function nodeLabel(index: ModelIndex, kind: NodeKind, id: string): string | undefined {
  return kind === "group" ? index.groups.get(id)?.label : index.nodes.get(id);
}

const RANK: Readonly<Record<RefStatus, number>> = { current: 0, changed: 1, "out-of-date": 2 };
const worst = (statuses: readonly RefStatus[]): RefStatus =>
  statuses.reduce<RefStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), "current");

function labelled(stored: string | undefined, now: string | undefined): RefResolution {
  return stored === now ? { status: "current" } : { status: "changed", ...(now === undefined ? {} : { label: now }) };
}

export function resolveStep(step: Step, index: ModelIndex): StepResolution {
  const nodes = (step.nodes ?? []).map((ref): RefResolution => {
    const now = nodeLabel(index, ref.kind, ref.id);
    return now === undefined ? { status: "out-of-date" } : labelled(ref.label, now);
  });
  const edges = (step.edges ?? []).map((ref): RefResolution => {
    const now = index.edges.get(ref.id);
    // An id that now joins other ends is another line: the step no longer points at what it said.
    if (now === undefined || now.source !== ref.source || now.target !== ref.target) return { status: "out-of-date" };
    return labelled(ref.label, now.label);
  });
  // A message names two boxes; it needs no line between them (open question 1), only its ends.
  const messages = (step.messages ?? []).map(
    (m): RefResolution => ({ status: index.nodes.has(m.from) && index.nodes.has(m.to) ? "current" : "out-of-date" }),
  );
  return { status: worst([...nodes, ...edges, ...messages].map((r) => r.status)), nodes, edges, messages };
}

/**
 * A walkthrough's resolution against `model`. A family that cannot host one
 * (a file written by hand beside a sequence diagram) resolves no step: archived.
 */
export function resolveWalkthrough(walkthrough: Walkthrough, model: DiagramModel): Resolution {
  const index = indexOf(model);
  const steps = walkthrough.steps.map((step): StepResolution => {
    if (index !== null) return resolveStep(step, index);
    const gone = (n: number) => Array.from({ length: n }, (): RefResolution => ({ status: "out-of-date" }));
    return {
      status: "out-of-date",
      nodes: gone(step.nodes?.length ?? 0),
      edges: gone(step.edges?.length ?? 0),
      messages: gone(step.messages?.length ?? 0),
    };
  });
  const numbers = (status: RefStatus) => steps.flatMap((s, i) => (s.status === status ? [i + 1] : []));
  const outOfDate = numbers("out-of-date");
  const status: WalkthroughStatus =
    outOfDate.length === steps.length ? "archived" : outOfDate.length > 0 ? "partly-out-of-date" : "current";
  return { id: walkthrough.id, status, outOfDate, changed: numbers("changed"), steps };
}
