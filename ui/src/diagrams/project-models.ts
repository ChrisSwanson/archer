/**
 * The graph-like models beyond the flowchart, each turned into the graph the
 * canvas draws (`figures.ts` says why one canvas serves them all).
 *
 * The wire shapes here are what `schema/diagram-envelope.schema.json` states
 * for each model, already validated by the time a projector sees them.
 * Every list comes out sorted by id, as a flowchart's does, so the same model
 * always lays out the same way.
 */
import type { EdgeLine, GraphDrawing, ProjectedEdge, ProjectedGroup, ProjectedNode } from "./projection";
import { captionWithDetail, type NodeShape } from "../layout/graph-metrics";
import type {
  ArchitectureIcon,
  ArchitectureSide,
  AttributeKey,
  C4BoundaryKind,
  C4ElementKind,
  C4ElementShape,
  C4Level,
  Cardinality,
  StateKind,
  StateNotePosition,
} from "./figures";

type Direction = "tb" | "bt" | "lr" | "rl";

const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const present = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

// ---- state machines -----------------------------------------------------------

export type WireStateMachine = {
  type: "state-machine";
  direction?: Direction | null;
  states: {
    id: string;
    label: string;
    kind?: StateKind;
    parentId?: string | null;
    note?: { position: StateNotePosition; text: string } | null;
  }[];
  transitions: { id: string; source: string; target: string; label?: string | null; line?: EdgeLine }[];
};

/**
 * The outline each state kind is drawn with, so the layout ends every wire on
 * what is drawn: the pseudo-states are a dot and a ring, a choice a diamond,
 * a fork or a join a bar, and a state a rounded box, as UML draws them.
 */
const STATE_OUTLINE: Readonly<Record<StateKind, NodeShape>> = {
  state: "rounded",
  initial: "circle",
  final: "circle",
  choice: "diamond",
  fork: "rectangle",
  join: "rectangle",
};

/**
 * States, and composite states as groups.
 *
 * A state some other state names as its parent is a COMPOSITE: drawn as a
 * frame around its children, and still a state -- an element the reader can
 * select and comment on, and a transition can start or end on.
 */
export function projectStateMachine(model: WireStateMachine): GraphDrawing {
  const parents = new Set(model.states.flatMap((state) => (state.parentId == null ? [] : [state.parentId])));
  const nodes: ProjectedNode[] = [];
  const groups: ProjectedGroup[] = [];
  for (const state of model.states) {
    if (parents.has(state.id)) {
      groups.push({
        id: state.id,
        label: state.label,
        parentId: present(state.parentId),
        element: true,
        // A composite's note is spoken with its name; a frame has no side to hang a sheet on.
        figure: state.note == null ? { type: "composite" } : { type: "composite", note: { ...state.note } },
      });
      continue;
    }
    const kind = state.kind ?? "state";
    nodes.push({
      id: state.id,
      label: state.label,
      shape: STATE_OUTLINE[kind],
      classes: [],
      groupId: present(state.parentId),
      figure: state.note == null ? { type: "state", kind } : { type: "state", kind, note: { ...state.note } },
    });
  }
  const edges: ProjectedEdge[] = model.transitions.map((transition) => ({
    id: transition.id,
    source: transition.source,
    target: transition.target,
    label: present(transition.label),
    ...(transition.line === undefined || transition.line === "solid" ? {} : { line: transition.line }),
  }));
  return {
    direction: present(model.direction),
    nodes: nodes.sort(byId),
    edges: edges.sort(byId),
    groups: groups.sort(byId),
    notation: "state",
  };
}

// ---- entity relationships ------------------------------------------------------

export type WireEntityRelationship = {
  type: "entity-relationship";
  direction?: Direction | null;
  entities: {
    id: string;
    label: string;
    attributes: { name: string; type: string; keys?: AttributeKey[]; comment?: string | null }[];
  }[];
  relationships: {
    id: string;
    source: string;
    target: string;
    sourceCardinality: Cardinality;
    targetCardinality: Cardinality;
    identifying: boolean;
    label?: string | null;
  }[];
};

/**
 * Entities as tables and relationships as wires with a cardinality at each
 * end. A non-identifying relationship (`..`) is drawn as a flowchart's dotted
 * line is, so the two notations read the same way.
 */
export function projectEntityRelationship(model: WireEntityRelationship): GraphDrawing {
  const nodes: ProjectedNode[] = model.entities.map((entity) => ({
    id: entity.id,
    label: entity.label,
    shape: "rectangle",
    classes: [],
    groupId: undefined,
    figure: {
      type: "entity",
      attributes: entity.attributes.map((attribute) => ({
        name: attribute.name,
        type: attribute.type,
        keys: [...(attribute.keys ?? [])],
        comment: present(attribute.comment),
      })),
    },
  }));
  const edges: ProjectedEdge[] = model.relationships.map((relationship) => ({
    id: relationship.id,
    source: relationship.source,
    target: relationship.target,
    // An empty label (`: ""`) is no caption.
    label: present(relationship.label) || undefined,
    ...(relationship.identifying ? {} : { line: "dotted" as const }),
    figure: { type: "cardinality", source: relationship.sourceCardinality, target: relationship.targetCardinality },
  }));
  return {
    direction: present(model.direction),
    nodes: nodes.sort(byId),
    edges: edges.sort(byId),
    groups: [],
    notation: "er",
  };
}

// ---- C4 --------------------------------------------------------------------------

export type WireC4Model = {
  type: "c4-model";
  level: C4Level;
  title?: string | null;
  elements: {
    id: string;
    kind: C4ElementKind;
    label: string;
    external?: boolean;
    shape?: C4ElementShape | null;
    technology?: string | null;
    description?: string | null;
    boundaryId?: string | null;
  }[];
  boundaries: { id: string; kind: C4BoundaryKind; label: string; parentId?: string | null }[];
  relationships: {
    id: string;
    source: string;
    target: string;
    label?: string | null;
    technology?: string | null;
    description?: string | null;
    bidirectional?: boolean;
    line?: EdgeLine;
  }[];
};

/**
 * The outline each C4 element is drawn with: a database is a cylinder; a
 * queue uses horizontal-cylinder styling and its full end ellipse (`FigureNode`).
 */
function c4Outline(kind: C4ElementKind, shape: C4ElementShape | null | undefined): string {
  if (shape === "database") return "cylinder";
  if (shape === "queue") return "rectangle";
  return kind === "person" ? "rounded" : "rectangle";
}

/** What the diagram is, over the canvas: its title, and which C4 level it draws. */
function c4Heading(title: string | null | undefined, level: C4Level): string {
  const level_ = `C4 ${level} diagram`;
  return title == null || title === "" ? level_ : `${title} · ${level_}`;
}

/**
 * C4 elements as boxes that say what they are (`[Container: TypeScript]`),
 * boundaries as frames, and relationships with their technology on the wire.
 * C4 states no direction; the diagram flows down, as Mermaid draws it.
 */
export function projectC4(model: WireC4Model): GraphDrawing {
  const nodes: ProjectedNode[] = model.elements.map((element) => ({
    id: element.id,
    label: element.label,
    shape: c4Outline(element.kind, element.shape),
    classes: [],
    groupId: present(element.boundaryId),
    figure: {
      type: "c4",
      kind: element.kind,
      external: element.external === true,
      ...(element.shape == null ? {} : { shape: element.shape }),
      ...(element.technology == null ? {} : { technology: element.technology }),
      ...(element.description == null ? {} : { description: element.description }),
    },
  }));
  const groups: ProjectedGroup[] = model.boundaries.map((boundary) => ({
    id: boundary.id,
    label: boundary.label,
    parentId: present(boundary.parentId),
    element: true,
    figure: { type: "boundary", kind: boundary.kind },
  }));
  const edges: ProjectedEdge[] = model.relationships.map((relationship) => {
    const label = present(relationship.label) || undefined;
    const technology = present(relationship.technology) || undefined;
    // The technology and description are drawn on the caption's plate under the label (ADR 0030, amended
    // 2026-10-31: they should be seen, not hidden behind an ⓘ). With no label, they stand alone.
    const description = present(relationship.description) || undefined;
    const caption = captionWithDetail(label, technology, description);
    return {
      id: relationship.id,
      source: relationship.source,
      target: relationship.target,
      label,
      ...(caption === undefined ? {} : { caption }),
      ...(relationship.line === undefined || relationship.line === "solid" ? {} : { line: relationship.line }),
      figure: {
        type: "c4",
        ...(technology === undefined ? {} : { technology }),
        ...(relationship.description == null ? {} : { description: relationship.description }),
        bidirectional: relationship.bidirectional === true,
      },
    };
  });
  return {
    direction: "tb",
    nodes: nodes.sort(byId),
    edges: edges.sort(byId),
    groups: groups.sort(byId),
    notation: "c4",
    heading: c4Heading(model.title, model.level),
  };
}

// ---- architecture --------------------------------------------------------------

export type WireServiceArchitecture = {
  type: "service-architecture";
  title?: string | null;
  groups: { id: string; label: string; icon?: ArchitectureIcon | null; parentId?: string | null }[];
  services: { id: string; label: string; icon?: ArchitectureIcon | null; groupId?: string | null }[];
  junctions: { id: string; groupId?: string | null }[];
  edges: {
    id: string;
    source: string;
    target: string;
    sourceSide: ArchitectureSide;
    targetSide: ArchitectureSide;
    sourceArrow?: boolean;
    targetArrow?: boolean;
    sourceGroup?: boolean;
    targetGroup?: boolean;
    label?: string | null;
    line?: EdgeLine;
  }[];
};

/**
 * Services with their icons, junctions as points, groups as frames, and
 * edges that leave and enter by their declared sides. Mermaid lays an
 * architecture out freely; here it flows to the right, the way `L` and `R`
 * sides read.
 */
export function projectArchitecture(model: WireServiceArchitecture): GraphDrawing {
  const nodes: ProjectedNode[] = [
    ...model.services.map((service) => ({
      id: service.id,
      label: service.label,
      shape: "rectangle",
      classes: [],
      groupId: present(service.groupId),
      figure: service.icon == null ? { type: "service" as const } : { type: "service" as const, icon: service.icon },
    })),
    ...model.junctions.map((junction) => ({
      // A junction has no label; its id is what the agent reads back.
      id: junction.id,
      label: junction.id,
      shape: "circle",
      classes: [],
      groupId: present(junction.groupId),
      figure: { type: "junction" as const },
    })),
  ];
  const groups: ProjectedGroup[] = model.groups.map((group) => ({
    id: group.id,
    label: group.label,
    parentId: present(group.parentId),
    element: true,
    figure: group.icon == null ? { type: "zone" } : { type: "zone", icon: group.icon },
  }));
  const edges: ProjectedEdge[] = model.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: present(edge.label) || undefined,
    ...(edge.line === undefined || edge.line === "solid" ? {} : { line: edge.line }),
    figure: {
      type: "ports",
      sourceSide: edge.sourceSide,
      targetSide: edge.targetSide,
      sourceArrow: edge.sourceArrow === true,
      targetArrow: edge.targetArrow === true,
      sourceGroup: edge.sourceGroup === true,
      targetGroup: edge.targetGroup === true,
    },
  }));
  return {
    direction: "lr",
    nodes: nodes.sort(byId),
    edges: edges.sort(byId),
    groups: groups.sort(byId),
    notation: "architecture",
    ...(model.title == null || model.title === "" ? {} : { heading: model.title }),
  };
}
