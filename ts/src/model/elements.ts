// What selection, emphasis and comments can anchor to in a model other than
// a sequence trace, in one shape: the model's points (nodes) and its
// connections (links), each by stable ID. A sequence trace is ordered, not a
// set of points and links, and its readers walk its events themselves.

import type { DiagramModel } from "./envelope.ts";
import { isGraphModel } from "./kinds.ts";
import type { StableId } from "./ids.ts";
import type { SequenceTrace } from "./sequence.ts";

export interface ElementNode {
  id: StableId;
  label: string;
}

export interface ElementLink {
  id: StableId;
  source: StableId;
  target: StableId;
  label?: string | null;
}

export interface ModelElements {
  nodes: ElementNode[];
  links: ElementLink[];
}

export type PointModel = Exclude<DiagramModel, SequenceTrace>;

const node = (id: StableId, label: string): ElementNode => ({ id, label });

function link(id: StableId, source: StableId, target: StableId, label: string | null | undefined): ElementLink {
  return label == null ? { id, source, target } : { id, source, target, label };
}

/**
 * The nodes and links of `model`: a graph's nodes and edges; a state
 * machine's states and transitions; entities and relationships; C4 elements
 * and boundaries, and relationships; architecture groups, services and
 * junctions, and edges; a journey's sections and tasks (it has no links).
 */
export function elementsOf(model: PointModel): ModelElements {
  if (isGraphModel(model)) {
    return {
      nodes: model.nodes.map((n) => node(n.id, n.label)),
      links: model.edges.map((e) => link(e.id, e.source, e.target, e.label)),
    };
  }
  switch (model.type) {
    case "state-machine":
      return {
        nodes: model.states.map((s) => node(s.id, s.label)),
        links: model.transitions.map((t) => link(t.id, t.source, t.target, t.label)),
      };
    case "entity-relationship":
      return {
        nodes: model.entities.map((e) => node(e.id, e.label)),
        links: model.relationships.map((r) => link(r.id, r.source, r.target, r.label)),
      };
    case "c4-model":
      return {
        nodes: [...model.boundaries.map((b) => node(b.id, b.label)), ...model.elements.map((e) => node(e.id, e.label))],
        links: model.relationships.map((r) => link(r.id, r.source, r.target, r.label)),
      };
    case "service-architecture":
      return {
        nodes: [
          ...model.groups.map((g) => node(g.id, g.label)),
          ...model.services.map((s) => node(s.id, s.label)),
          ...model.junctions.map((j) => node(j.id, j.id)),
        ],
        links: model.edges.map((e) => link(e.id, e.source, e.target, e.label)),
      };
    case "user-journey":
      return {
        nodes: model.sections.flatMap((s) => [node(s.id, s.label), ...s.tasks.map((t) => node(t.id, t.label))]),
        links: [],
      };
  }
}
