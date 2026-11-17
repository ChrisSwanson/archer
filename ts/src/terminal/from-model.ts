// State machines and ER diagrams, as the graph input the terminal painter
// draws (ticket 10: graph-like types reuse the ELK terminal layout).
//
// A state machine: each state a node; initial and final states small
// circles, a choice a diamond; each composite state a frame holding its
// states. A transition may name a composite itself, so a composite that one
// does is also a node inside its own frame. Notes are not drawn.
//
// An ER diagram: each entity a node (its attributes are not drawn), each
// relationship an edge labelled with its cardinalities around its label
// (`1 places 0..*`), dotted when it is not identifying.

import type { Cardinality, EntityRelationship, StateMachine } from "../model/index.ts";
import type { GraphEdge, GraphGroup, GraphInput, GraphNode } from "./input.ts";

/** A frame's id: state IDs cannot hold `-`, so this never names a state. */
const frame = (id: string): string => `${id}-composite`;

function stateGraph(model: StateMachine): GraphInput {
  const parents = new Set(model.states.flatMap((s) => (s.parentId == null ? [] : [s.parentId])));
  const named = new Set(model.transitions.flatMap((t) => [t.source, t.target]));
  const groups: GraphGroup[] = model.states
    .filter((s) => parents.has(s.id))
    .map((s) => ({ id: frame(s.id), label: s.label, ...(s.parentId == null ? {} : { parentId: frame(s.parentId) }) }));
  const nodes: GraphNode[] = [];
  for (const state of model.states) {
    const composite = parents.has(state.id);
    if (composite && !named.has(state.id)) continue;
    const groupId = composite ? frame(state.id) : state.parentId == null ? undefined : frame(state.parentId);
    const shape =
      state.kind === "initial" || state.kind === "final" ? "circle" : state.kind === "choice" ? "diamond" : "rounded";
    nodes.push({ id: state.id, label: state.label, shape, ...(groupId === undefined ? {} : { groupId }) });
  }
  const edges: GraphEdge[] = model.transitions.map((t) => ({
    id: t.id,
    source: t.source,
    target: t.target,
    ...(t.label == null ? {} : { label: t.label }),
  }));
  return {
    type: "freeform-graph",
    ...(model.direction == null ? {} : { direction: model.direction }),
    nodes,
    edges,
    groups,
  };
}

const MARK: Record<Cardinality, string> = {
  "zero-or-one": "0..1",
  "exactly-one": "1",
  "zero-or-more": "0..*",
  "one-or-more": "1..*",
};

function erGraph(model: EntityRelationship): GraphInput {
  const nodes: GraphNode[] = model.entities.map((e) => ({ id: e.id, label: e.label }));
  const edges: GraphEdge[] = model.relationships.map((r) => ({
    id: r.id,
    source: r.source,
    target: r.target,
    label: [MARK[r.sourceCardinality], r.label, MARK[r.targetCardinality]]
      .filter((part) => part != null && part !== "")
      .join(" "),
    ...(r.identifying ? {} : { line: "dotted" as const }),
  }));
  return {
    type: "freeform-graph",
    ...(model.direction == null ? {} : { direction: model.direction }),
    nodes,
    edges,
    groups: [],
  };
}

export function graphInputOf(model: StateMachine | EntityRelationship): GraphInput {
  return model.type === "state-machine" ? stateGraph(model) : erGraph(model);
}
