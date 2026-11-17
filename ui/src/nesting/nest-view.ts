/**
 * The nested view (ADR 0029, docs/proposals/ws-b-boundary-zoom.md §3).
 *
 * A pure projection of a drawn graph view: the containers it already has (C4
 * boundaries, flowchart subgraphs, architecture groups, composite states)
 * open one level at a time. A closed container is one box with the
 * container's own id; every edge with a hidden end is re-pointed to the
 * nearest drawn box; re-pointed edges that land on one pair of drawn ends are
 * one bundle, "N connections". An edge whose ends are both drawn is left
 * exactly as written, so opening everything gives back the full view.
 *
 * Presentation only: nothing here reaches the model, the source or the wire.
 */
import type { ProjectedEdge, ProjectedGroup, ProjectedNode, ProjectedView } from "../diagrams/projection";
import { arrowsOf, type EdgeFigure, type GroupFigure, type NodeFigure } from "../diagrams/figures";

/** A model element. Flowchart node, edge and subgraph ids are separate namespaces, so the kind is part of the key. */
export type ModelKey = { readonly kind: "node" | "group" | "edge"; readonly id: string };
/** Something drawn: a node (a box or a frame) or an edge, by its drawn id. */
export type DrawnKey = { readonly kind: "node" | "edge"; readonly id: string };

export type ClosedBox = {
  readonly groupId: string;
  readonly drawnId: string;
  /** "3 containers inside"; empty when nothing countable is inside. */
  readonly inside: string;
  readonly count: number;
  /** Edges with both ends inside the box: not drawn, never lost. */
  readonly hidden: readonly ProjectedEdge[];
};

export type Bundle = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly members: readonly ProjectedEdge[];
};

export type Nested = {
  readonly view: ProjectedView;
  /** The canonical open set: reachable group ids, sorted. */
  readonly open: readonly string[];
  readonly closed: ReadonlyMap<string, ClosedBox>;
  readonly bundles: ReadonlyMap<string, Bundle>;
  /** Where a model element shows: itself, the box it is inside, or the bundle it is part of. */
  drawnOf(key: ModelKey): DrawnKey | undefined;
  /** What a drawn thing stands for. */
  modelOf(key: DrawnKey): readonly ModelKey[];
  /** The groups to open for the element to be drawn as itself, sorted. */
  reveal(key: ModelKey): readonly string[];
};

/** Drawn ids no model id can collide with: model ids never hold `:` or `~`. */
const SUBGRAPH_PREFIX = "group:";
const BUNDLE_PREFIX = "bundle:";

/** The drawn id of a closed container or an open frame (`xflow-adapter.ts` `frameIdOf`). */
function drawnGroupId(group: ProjectedGroup): string {
  return group.element === true ? group.id : `${SUBGRAPH_PREFIX}${group.id}`;
}

/** A group's ancestors, nearest first. Iterative and cycle-safe: architecture groups have no depth limit. */
function ancestorsOf(groupId: string | undefined, groups: ReadonlyMap<string, ProjectedGroup>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor = groupId;
  while (cursor !== undefined && groups.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = groups.get(cursor)!.parentId;
  }
  return chain;
}

/** The ids in `open` that one click at a time can reach (every ancestor open too), sorted. */
export function canonicalOpen(view: ProjectedView, open: Iterable<string>): string[] {
  const wanted = new Set(open);
  const groups = new Map(view.groups.map((group) => [group.id, group]));
  const reachable = view.groups
    .filter((group) => wanted.has(group.id))
    .filter((group) => ancestorsOf(group.parentId, groups).every((id) => wanted.has(id)))
    .map((group) => group.id);
  return [...new Set(reachable)].sort();
}

/** Nothing open, except that a lone top-level container (and a lone one inside it, and so on) opens. */
export function defaultOpen(view: ProjectedView): string[] {
  const open: string[] = [];
  let scope: string | undefined;
  for (let depth = 0; depth <= view.groups.length; depth++) {
    const nodes = view.nodes.filter((node) => node.groupId === scope);
    const groups = view.groups.filter((group) => group.parentId === scope && !open.includes(group.id));
    if (nodes.length !== 0 || groups.length !== 1) break;
    scope = groups[0]!.id;
    open.push(scope);
  }
  return open.sort();
}

// ---- what a closed box says is inside ---------------------------------------------------

const SINGULAR: Readonly<Record<string, string>> = {
  people: "person",
  systems: "system",
  containers: "container",
  components: "component",
  states: "state",
  services: "service",
  nodes: "node",
  groups: "group",
  elements: "element",
};

/** What one child is, in the caption's words; undefined when it is not counted (a pseudo-state, a junction). */
function nodeNoun(figure: NodeFigure | undefined): string | undefined {
  if (figure === undefined) return "nodes";
  switch (figure.type) {
    case "c4":
      return figure.kind === "person" ? "people" : `${figure.kind}s`;
    case "state":
      return figure.kind === "state" ? "states" : undefined;
    case "service":
      return "services";
    case "junction":
      return undefined;
    case "entity":
      return "elements";
  }
}

function groupNoun(figure: GroupFigure | undefined): string {
  if (figure === undefined) return "groups";
  switch (figure.type) {
    case "boundary":
      return figure.kind === "system" ? "systems" : figure.kind === "container" ? "containers" : "elements";
    case "composite":
      return "states";
    case "zone":
      return "groups";
  }
}

function insideCaption(nouns: readonly string[]): string {
  if (nouns.length === 0) return "";
  const noun = nouns.every((n) => n === nouns[0]) ? nouns[0]! : "elements";
  return `${nouns.length} ${nouns.length === 1 ? SINGULAR[noun] : noun} inside`;
}

/** The box a closed container is drawn as: what it is, in its own notation. */
function closedBox(group: ProjectedGroup, drawnId: string, inside: string): ProjectedNode {
  // A closed subgraph keeps its kind or category, so its box is drawn in the panel's family.
  const base = {
    id: drawnId,
    label: group.label,
    classes: group.classes ?? ([] as readonly string[]),
    groupId: group.parentId,
  };
  const folded = { groupId: group.id, element: group.element === true, ...(inside === "" ? {} : { caption: inside }) };
  const figure = group.figure;
  if (figure?.type === "boundary" && (figure.kind === "system" || figure.kind === "container")) {
    return {
      ...base,
      shape: "rectangle",
      figure: { type: "c4", kind: figure.kind, external: false, ...(inside === "" ? {} : { description: inside }) },
      // The C4 box says what is inside in its own description slot.
      folded: { groupId: group.id, element: group.element === true },
    };
  }
  if (figure?.type === "composite") {
    // A composite's note is spoken with its name; closed, it hangs beside the box as a state's does.
    const note = figure.note === undefined ? {} : { note: { ...figure.note } };
    return { ...base, shape: "rounded", figure: { type: "state", kind: "state", ...note }, folded };
  }
  if (figure?.type === "zone") {
    return {
      ...base,
      shape: "rectangle",
      figure: figure.icon === undefined ? { type: "service" } : { type: "service", icon: figure.icon },
      folded,
    };
  }
  return { ...base, shape: "rectangle", folded };
}

// ---- edges ------------------------------------------------------------------------------

/** A single re-pointed edge: its own id, label and arrowheads; a moved end no longer meets a group's frame. */
function repointed(edge: ProjectedEdge, source: string, target: string): ProjectedEdge {
  const figure = edge.figure;
  const moved =
    figure?.type === "ports"
      ? {
          figure: {
            ...figure,
            sourceGroup: source === edge.source && figure.sourceGroup,
            targetGroup: target === edge.target && figure.targetGroup,
          },
        }
      : {};
  return { ...edge, source, target, ...moved };
}

/** One line for several connections: arrowheads wherever a member points, dotted only if every member is. */
function bundled(
  id: string,
  source: string,
  target: string,
  members: readonly ProjectedEdge[],
  ends: (edge: ProjectedEdge) => readonly [string, string],
): ProjectedEdge {
  let start = false;
  let end = false;
  for (const member of members) {
    const arrows = arrowsOf(member.figure, member.bidirectional === true);
    const forward = ends(member)[0] === source;
    start ||= forward ? arrows.start : arrows.end;
    end ||= forward ? arrows.end : arrows.start;
  }
  const first = members[0]!;
  const firstForward = ends(first)[0] === source;
  // An arrowhead only at the start is drawn as one at the end of the line turned round.
  const flip = start && !end && first.figure?.type !== "ports";
  const [from, to] = flip ? [target, source] : [source, target];
  const both = start && end;
  const line = members.every((member) => member.line === "dotted") ? { line: "dotted" as const } : {};
  const label = `${members.length} connections`;
  let figure: EdgeFigure | undefined;
  if (first.figure?.type === "c4") figure = { type: "c4", bidirectional: both };
  else if (first.figure?.type === "ports") {
    const sides = firstForward
      ? { sourceSide: first.figure.sourceSide, targetSide: first.figure.targetSide }
      : { sourceSide: first.figure.targetSide, targetSide: first.figure.sourceSide };
    figure = { type: "ports", ...sides, sourceArrow: start, targetArrow: end, sourceGroup: false, targetGroup: false };
  }
  return {
    id,
    source: from,
    target: to,
    label,
    ...line,
    ...(figure === undefined && both ? { bidirectional: true } : {}),
    ...(figure === undefined ? {} : { figure }),
  };
}

function push<T>(map: Map<string, T[]>, key: string, item: T): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [item]);
  else bucket.push(item);
}

const byId = (a: { readonly id: string }, b: { readonly id: string }): number => a.id.localeCompare(b.id);

// ---- the projection ---------------------------------------------------------------------

export function nestView(view: ProjectedView, requested: Iterable<string>): Nested {
  const open = canonicalOpen(view, requested);
  const isOpen = new Set(open);
  const groups = new Map(view.groups.map((group) => [group.id, group]));
  const nodes = new Map(view.nodes.map((node) => [node.id, node]));

  /** The first container, from the top, that is not open: the box everything under it is drawn as. */
  const closedAbove = (chain: readonly string[]): string | undefined => {
    for (let index = chain.length - 1; index >= 0; index--) if (!isOpen.has(chain[index]!)) return chain[index];
    return undefined;
  };
  const visibleGroup = (group: ProjectedGroup): boolean =>
    ancestorsOf(group.parentId, groups).every((id) => isOpen.has(id));

  // Each container's direct children, indexed once.
  const childNodes = new Map<string, ProjectedNode[]>();
  for (const node of view.nodes) if (node.groupId !== undefined) push(childNodes, node.groupId, node);
  const childGroups = new Map<string, ProjectedGroup[]>();
  for (const group of view.groups) if (group.parentId !== undefined) push(childGroups, group.parentId, group);

  // Containers.
  const closed = new Map<string, ClosedBox>();
  const keptGroups: ProjectedGroup[] = [];
  const boxes: ProjectedNode[] = [];
  const groupIdOfDrawn = new Map<string, string>();
  for (const group of view.groups) {
    if (!visibleGroup(group)) continue;
    if (isOpen.has(group.id)) {
      keptGroups.push(group);
      groupIdOfDrawn.set(drawnGroupId(group), group.id);
      continue;
    }
    const nouns = [
      ...(childNodes.get(group.id) ?? []).flatMap((node) => nodeNoun(node.figure) ?? []),
      ...(childGroups.get(group.id) ?? []).map((child) => groupNoun(child.figure)),
    ];
    const drawnId = drawnGroupId(group);
    const inside = insideCaption(nouns);
    closed.set(group.id, { groupId: group.id, drawnId, inside, count: nouns.length, hidden: [] });
    boxes.push(closedBox(group, drawnId, inside));
    groupIdOfDrawn.set(drawnId, group.id);
  }

  /** The drawn id an element is drawn under: itself, or the closed box it is inside. */
  const drawnNode = (key: ModelKey): string | undefined => {
    if (key.kind === "node") {
      const node = nodes.get(key.id);
      if (node === undefined) return undefined;
      const box = closedAbove(ancestorsOf(node.groupId, groups));
      return box === undefined ? node.id : closed.get(box)!.drawnId;
    }
    const group = groups.get(key.id);
    if (group === undefined) return undefined;
    const above = closedAbove(ancestorsOf(group.parentId, groups));
    if (above !== undefined) return closed.get(above)!.drawnId;
    return drawnGroupId(group);
  };
  /** An edge's end: a node when one has the id (a subgraph is never an end), else a composite state. */
  const endOf = (id: string): string => drawnNode({ kind: nodes.has(id) ? "node" : "group", id }) ?? id;

  // Edges.
  const keptEdges: ProjectedEdge[] = [];
  type Pair = { members: ProjectedEdge[]; ends: Map<ProjectedEdge, readonly [string, string]> };
  const pairs = new Map<string, Pair>();
  const hiddenIn = new Map<string, ProjectedEdge[]>();
  const edgeDrawn = new Map<string, DrawnKey>();
  let edgesChanged = false;
  for (const edge of view.edges) {
    const a = endOf(edge.source);
    const b = endOf(edge.target);
    if (a === edge.source && b === edge.target) {
      keptEdges.push(edge);
      continue;
    }
    edgesChanged = true;
    if (a === b) {
      const groupId = groupIdOfDrawn.get(a)!;
      push(hiddenIn, groupId, edge);
      edgeDrawn.set(edge.id, { kind: "node", id: a });
      continue;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}~${hi}`;
    const pair: Pair = pairs.get(key) ?? { members: [], ends: new Map() };
    pair.members.push(edge);
    pair.ends.set(edge, [a, b]);
    pairs.set(key, pair);
  }
  // An untouched edge joins a pair that re-pointed edges also land on.
  const bundles = new Map<string, Bundle>();
  const drawnEdges: ProjectedEdge[] = [];
  for (const edge of keptEdges) {
    const [lo, hi] = edge.source < edge.target ? [edge.source, edge.target] : [edge.target, edge.source];
    const pair = pairs.get(`${lo}~${hi}`);
    if (pair === undefined) {
      drawnEdges.push(edge);
      continue;
    }
    pair.members.push(edge);
    pair.ends.set(edge, [edge.source, edge.target]);
  }
  for (const [key, pair] of pairs) {
    const members = [...pair.members].sort(byId);
    const ends = (edge: ProjectedEdge) => pair.ends.get(edge)!;
    if (members.length === 1) {
      const [source, target] = ends(members[0]!);
      drawnEdges.push(repointed(members[0]!, source, target));
      edgeDrawn.set(members[0]!.id, { kind: "edge", id: members[0]!.id });
      continue;
    }
    const id = `${BUNDLE_PREFIX}${key}`;
    const [source, target] = ends(members[0]!);
    bundles.set(id, { id, source, target, members });
    drawnEdges.push(bundled(id, source, target, members, ends));
    for (const member of members) edgeDrawn.set(member.id, { kind: "edge", id });
  }
  for (const [groupId, hidden] of hiddenIn) {
    const box = closed.get(groupId)!;
    closed.set(groupId, { ...box, hidden: [...hidden].sort(byId) });
  }

  const keptNodes = view.nodes.filter((node) => drawnNode({ kind: "node", id: node.id }) === node.id);
  const changed = boxes.length > 0 || keptNodes.length !== view.nodes.length;
  const nested: ProjectedView = {
    ...view,
    nodes: changed ? [...keptNodes, ...boxes].sort(byId) : view.nodes,
    edges: edgesChanged ? drawnEdges.sort(byId) : view.edges,
    groups: keptGroups.length === view.groups.length ? view.groups : keptGroups,
  };

  const modelEdges = new Map(view.edges.map((edge) => [edge.id, edge]));
  const drawnEdgeIds = new Set(nested.edges.map((edge) => edge.id));
  const drawnNodeIds = new Set(nested.nodes.map((node) => node.id));
  const ancestorsToOpen = (key: ModelKey): string[] => {
    if (key.kind === "edge") {
      const edge = modelEdges.get(key.id);
      if (edge === undefined) return [];
      const ends = [edge.source, edge.target].map((id): ModelKey => ({ kind: nodes.has(id) ? "node" : "group", id }));
      return [...new Set(ends.flatMap(ancestorsToOpen))];
    }
    if (key.kind === "node") return ancestorsOf(nodes.get(key.id)?.groupId, groups);
    return ancestorsOf(groups.get(key.id)?.parentId, groups);
  };

  return {
    view: nested,
    open,
    closed,
    bundles,
    drawnOf(key) {
      if (key.kind === "edge") {
        if (edgeDrawn.has(key.id)) return edgeDrawn.get(key.id);
        return modelEdges.has(key.id) ? { kind: "edge", id: key.id } : undefined;
      }
      const id = drawnNode(key);
      return id === undefined ? undefined : { kind: "node", id };
    },
    modelOf(key) {
      if (key.kind === "edge") {
        const bundle = bundles.get(key.id);
        if (bundle !== undefined) return bundle.members.map((member) => ({ kind: "edge", id: member.id }));
        return drawnEdgeIds.has(key.id) ? [{ kind: "edge", id: key.id }] : [];
      }
      const groupId = groupIdOfDrawn.get(key.id);
      if (groupId !== undefined && (closed.has(groupId) || !nodes.has(key.id))) return [{ kind: "group", id: groupId }];
      return drawnNodeIds.has(key.id) ? [{ kind: "node", id: key.id }] : [];
    },
    reveal(key) {
      return ancestorsToOpen(key).sort();
    },
  };
}
