// The nesting profile (ADR 0029; docs/proposals/ws-b-boundary-zoom.md §7).
//
// Findings over a compiled model that steer agents to nesting the page's nested view can open one
// level at a time: C4 levels in their boundary kinds, bounded depth, no subgraph sharing a node's
// id, and two advisory notes. Each message says what is wrong and what to write instead. None is
// an error: a model is never refused for its nesting. The structural findings carry an identity
// (code and the ids involved) so a write can be refused for ADDING one (`application/nesting.ts`).

import type { DiagramModel } from "../model/index.ts";
import { info, span, warning, type Diagnostic, type Span } from "./diagnostics.ts";

/** Where each element and container is declared, from the family's scan; absent ids fall back. */
export interface Declarations {
  readonly elements: ReadonlyMap<string, Span>;
  readonly groups: ReadonlyMap<string, Span>;
}

export interface NestingFinding {
  readonly diagnostic: Diagnostic;
  /** `code:id[:id]`: the same problem in two versions of a source has the same identity. */
  readonly identity: string;
  /** A structural finding, which a write may not add; an advisory one never refuses. */
  readonly ratcheted: boolean;
}

/** More containers than this, one inside another, is too deep to open one level at a time. */
export const MAX_NESTED_CONTAINERS = 4;
/** More loose top-level elements than this beside a container crowd the nested view. */
export const MAX_LOOSE_TOP_LEVEL = 6;

type Family = "c4" | "flowchart" | "architecture" | "state";

interface Element {
  readonly id: string;
  readonly parent: string | undefined;
  /** C4 element kind: person, system, container, component. */
  readonly kind?: string;
  /** Counted as something inside its container (not a junction or a pseudo-state). */
  readonly countable: boolean;
}

interface Group {
  readonly id: string;
  readonly parent: string | undefined;
  readonly label: string;
  /** C4 boundary kind: enterprise, system, container, generic. */
  readonly kind?: string;
}

interface Tree {
  readonly family: Family;
  readonly elements: readonly Element[];
  readonly groups: readonly Group[];
}

function treeOf(model: DiagramModel): Tree | undefined {
  switch (model.type) {
    case "c4-model":
      return {
        family: "c4",
        elements: model.elements.map((e) => ({
          id: e.id,
          parent: e.boundaryId ?? undefined,
          kind: e.kind,
          countable: true,
        })),
        groups: model.boundaries.map((b) => ({
          id: b.id,
          parent: b.parentId ?? undefined,
          label: b.label,
          kind: b.kind,
        })),
      };
    case "architecture-graph":
    case "data-flow-graph":
    case "freeform-graph":
      return {
        family: "flowchart",
        elements: model.nodes.map((n) => ({ id: n.id, parent: n.groupId ?? undefined, countable: true })),
        groups: model.groups.map((g) => ({ id: g.id, parent: g.parentId ?? undefined, label: g.label })),
      };
    case "service-architecture":
      return {
        family: "architecture",
        elements: [
          ...model.services.map((s) => ({ id: s.id, parent: s.groupId ?? undefined, countable: true })),
          ...model.junctions.map((j) => ({ id: j.id, parent: j.groupId ?? undefined, countable: false })),
        ],
        groups: model.groups.map((g) => ({ id: g.id, parent: g.parentId ?? undefined, label: g.label })),
      };
    case "state-machine": {
      const parents = new Set(model.states.flatMap((s) => (s.parentId == null ? [] : [s.parentId])));
      return {
        family: "state",
        elements: model.states
          .filter((s) => !parents.has(s.id))
          .map((s) => ({ id: s.id, parent: s.parentId ?? undefined, countable: (s.kind ?? "state") === "state" })),
        groups: model.states
          .filter((s) => parents.has(s.id))
          .map((s) => ({ id: s.id, parent: s.parentId ?? undefined, label: s.label })),
      };
    }
    default:
      return undefined;
  }
}

const BOUNDARY_MACRO: Readonly<Record<string, string>> = {
  enterprise: "Enterprise_Boundary",
  system: "System_Boundary",
  container: "Container_Boundary",
  generic: "Boundary",
};
const ELEMENT_WORD: Readonly<Record<string, string>> = {
  person: "Person",
  system: "System",
  container: "Container",
  component: "Component",
};
const CONTAINER_WORD: Readonly<Record<Family, string>> = {
  c4: "boundary",
  flowchart: "subgraph",
  architecture: "group",
  state: "composite state",
};
const LOOSE_WORD: Readonly<Record<Family, [string, string]>> = {
  c4: ["elements", "boundary"],
  flowchart: ["nodes", "subgraph"],
  architecture: ["services", "group"],
  state: ["states", "composite state"],
};

/** What is wrong with an element's place in its C4 boundary, and the fix; undefined when it fits. */
function levelFix(element: string, kind: string, boundary: string, boundaryKind: string): string | undefined {
  // Mermaid's own C4 samples group systems in a System_Boundary: allowed, as containers are.
  if (boundaryKind === "system" && kind !== "container" && kind !== "system") {
    return kind === "component"
      ? `put it in a Container_Boundary inside '${boundary}', or make it a Container`
      : `move it out of '${boundary}': a System_Boundary holds the system's containers`;
  }
  if (boundaryKind === "container" && kind !== "component") {
    return kind === "container"
      ? `move it out of '${boundary}', or make it a Component`
      : `move it out of '${boundary}': a Container_Boundary holds the container's components`;
  }
  if (boundaryKind === "enterprise" && kind === "container") return `put it in a System_Boundary inside '${boundary}'`;
  if (boundaryKind === "enterprise" && kind === "component")
    return `put it in a Container_Boundary inside a System_Boundary in '${boundary}'`;
  void element;
  return undefined;
}

/** What is wrong with a C4 boundary inside another, and the fix; undefined when it fits. */
function orderFix(child: string, childKind: string, parent: string, parentKind: string): string | undefined {
  if (childKind === "enterprise") return "an Enterprise_Boundary goes at the top level: move it out";
  if (parentKind === "container" && childKind === "system") return `swap them, or make '${child}' a generic Boundary`;
  if (parentKind === "container" && childKind === "container")
    return `make '${child}' a generic Boundary, or move it out of '${parent}'`;
  if (parentKind === "system" && childKind === "system")
    return `make '${child}' a Container_Boundary, or a generic Boundary`;
  return undefined;
}

/**
 * The nesting findings for a compiled model, in no particular order (the report sorts them).
 * `declared` places each at its declaration; `fallback` is where one with no known place goes.
 */
export function nestingFindings(
  model: DiagramModel,
  declared?: Declarations,
  fallback: Span = span(1, 1),
): NestingFinding[] {
  const tree = treeOf(model);
  if (tree === undefined) return [];
  const groups = new Map(tree.groups.map((g) => [g.id, g]));
  const at = (kind: "elements" | "groups", id: string): Span => declared?.[kind].get(id) ?? fallback;
  const findings: NestingFinding[] = [];
  const add = (diagnostic: Diagnostic, identity: string, ratcheted: boolean) =>
    findings.push({ diagnostic, identity, ratcheted });

  // The chain of containers above a group, outermost first. Iterative and bounded: architecture
  // groups have no depth limit of their own, and a cycle is refused by the model check.
  const chainOf = (id: string): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    for (
      let cursor: string | undefined = id;
      cursor !== undefined && groups.has(cursor) && !seen.has(cursor);
      cursor = groups.get(cursor)!.parent
    ) {
      seen.add(cursor);
      chain.unshift(cursor);
    }
    return chain;
  };

  if (tree.family === "c4") {
    for (const element of tree.elements) {
      const boundary = element.parent === undefined ? undefined : groups.get(element.parent);
      if (boundary === undefined || element.kind === undefined || boundary.kind === undefined) continue;
      const fix = levelFix(element.id, element.kind, boundary.id, boundary.kind);
      if (fix === undefined) continue;
      add(
        warning(
          "nest_level_mismatch",
          `'${element.id}' is a ${ELEMENT_WORD[element.kind]} inside ${BOUNDARY_MACRO[boundary.kind]} '${boundary.id}': ${fix}.`,
          at("elements", element.id),
        ),
        `nest_level_mismatch:${element.id}:${boundary.id}`,
        true,
      );
    }
    for (const group of tree.groups) {
      const parent = group.parent === undefined ? undefined : groups.get(group.parent);
      if (parent === undefined || group.kind === undefined || parent.kind === undefined) continue;
      const fix = orderFix(group.id, group.kind, parent.id, parent.kind);
      if (fix === undefined) continue;
      add(
        warning(
          "nest_kind_order",
          `${BOUNDARY_MACRO[group.kind]} '${group.id}' is inside ${BOUNDARY_MACRO[parent.kind]} '${parent.id}': ${fix}.`,
          at("groups", group.id),
        ),
        `nest_kind_order:${group.id}:${parent.id}`,
        true,
      );
    }
  }

  if (tree.family === "flowchart") {
    const nodeIds = new Set(tree.elements.map((e) => e.id));
    for (const group of tree.groups) {
      if (!nodeIds.has(group.id)) continue;
      add(
        warning(
          "nest_id_clash",
          `subgraph '${group.id}' has the same ID as node '${group.id}': closed, the subgraph is drawn as a box, and two things named '${group.id}' are ambiguous. Rename one, for example \`subgraph ${group.id}_group[${group.label}]\`.`,
          at("groups", group.id),
        ),
        `nest_id_clash:${group.id}`,
        true,
      );
    }
  }

  for (const group of tree.groups) {
    // Every level past the bound is its own finding, so a chain already too deep cannot grow.
    const chain = chainOf(group.id);
    if (chain.length <= MAX_NESTED_CONTAINERS) continue;
    add(
      warning(
        "nest_too_deep",
        `'${group.id}' is nested ${chain.length} deep (${chain.join(" › ")}): the nested view opens one level at a time, so keep to ${MAX_NESTED_CONTAINERS} levels; split the innermost part into its own diagram.`,
        at("groups", group.id),
      ),
      `nest_too_deep:${group.id}`,
      true,
    );
  }

  // Advisory: never refused.
  const children = new Map<string, string[]>();
  for (const element of tree.elements)
    if (element.parent !== undefined && element.countable)
      children.set(element.parent, [...(children.get(element.parent) ?? []), element.id]);
  for (const group of tree.groups)
    if (group.parent !== undefined) children.set(group.parent, [...(children.get(group.parent) ?? []), group.id]);
  if (tree.family !== "state") {
    for (const group of tree.groups) {
      const inside = children.get(group.id) ?? [];
      if (inside.length !== 1) continue;
      add(
        info(
          "nest_single_child",
          `'${group.id}' holds only '${inside[0]}'; if nothing else belongs inside it, the ${CONTAINER_WORD[tree.family]} can go.`,
          at("groups", group.id),
        ),
        `nest_single_child:${group.id}`,
        false,
      );
    }
  }
  if (tree.family === "flowchart" || tree.family === "architecture") {
    const loose = tree.elements.filter((e) => e.parent === undefined && e.countable);
    const [things, container] = LOOSE_WORD[tree.family];
    if (loose.length > MAX_LOOSE_TOP_LEVEL && tree.groups.some((g) => g.parent === undefined)) {
      add(
        info(
          "nest_mixed_root",
          `${loose.length} ${things} sit outside every ${container}; grouping them makes the nested view clearer.`,
          at("elements", loose[0]!.id),
        ),
        "nest_mixed_root",
        false,
      );
    }
  }
  return findings;
}

/** The structural findings of a model, counted by code. */
export function structuralCounts(model: DiagramModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of nestingFindings(model))
    if (finding.ratcheted) counts.set(finding.diagnostic.code, (counts.get(finding.diagnostic.code) ?? 0) + 1);
  return counts;
}

/**
 * What a write may not add: for each code, `next` may have no more structural findings than
 * `base`. Counting rather than matching ids lets a person or agent rename an element that already
 * breaks the profile; the findings listed are those of `next` that `base` does not have by id.
 */
export function addedNestingFindings(
  base: DiagramModel,
  next: DiagramModel,
  declared?: Declarations,
): NestingFinding[] {
  const before = structuralCounts(base);
  const known = new Set(
    nestingFindings(base)
      .filter((f) => f.ratcheted)
      .map((f) => f.identity),
  );
  const found = nestingFindings(next, declared).filter((f) => f.ratcheted);
  const grown = new Set(
    [...new Set(found.map((f) => f.diagnostic.code))].filter(
      (code) => found.filter((f) => f.diagnostic.code === code).length > (before.get(code) ?? 0),
    ),
  );
  return found.filter((f) => grown.has(f.diagnostic.code) && !known.has(f.identity));
}
