import type { Category } from "./palette";
import type { SourceOrder } from "./source-order";
import { validateEnvelope, type ValidationResult } from "../protocol/validate";
import type { EdgeFigure, GraphNotation, GroupFigure, NodeFigure } from "./figures";
import {
  projectArchitecture,
  projectC4,
  projectEntityRelationship,
  projectStateMachine,
  type WireC4Model,
  type WireEntityRelationship,
  type WireServiceArchitecture,
  type WireStateMachine,
} from "./project-models";

/**
 * The projected types mirror wire contract version 2 (ADR 0009). The fields it
 * added are optional and carried exactly as the wire has them, so `undefined`
 * always means the documented default: direction `tb`, line `solid`,
 * participant kind `participant`, autonumber off.
 */

/** The flow direction a graph's source declared; absent means `tb`. */
export type GraphDirection = "tb" | "bt" | "lr" | "rl";

/** How an edge's line is drawn; absent means `solid` (ADR 0030 adds the authored dashes). */
export type EdgeLine = "solid" | "dotted" | "thick" | "dashed" | "dashdot";

/** A line pattern's meaning, in the diagram author's words (`%% archer-key`). */
export type LineKeyEntry = { readonly pattern: "dotted" | "dashed" | "dashdot" | "thick"; readonly meaning: string };

/** The model's own line key, when its author wrote one. */
function lineKeyOf(model: unknown): { lineKey?: readonly LineKeyEntry[] } {
  const key = (model as { lineKey?: readonly LineKeyEntry[] } | null)?.lineKey;
  return Array.isArray(key) && key.length > 0
    ? { lineKey: key.map((entry) => ({ pattern: entry.pattern, meaning: entry.meaning })) }
    : {};
}

/** How a participant was declared; absent means `participant`. */
export type ParticipantKind = "participant" | "actor";

export type NotePosition = "left-of" | "right-of" | "over";

export type ProjectedNode = {
  readonly id: string;
  readonly label: string;
  readonly shape: string | undefined;
  readonly classes: readonly string[];
  readonly groupId: string | undefined;
  /** What a state, an entity, a C4 element or a service is drawn as (`figures.ts`). */
  readonly figure?: NodeFigure;
  /** A closed container in the nested view (`nesting/nest-view.ts`): which group it stands for. */
  readonly folded?: {
    readonly groupId: string;
    readonly element: boolean;
    /** "3 nodes inside", drawn under the label of a box whose figure has no description slot (C4 boxes carry it as their description). */
    readonly caption?: string;
  };
};

export type ProjectedEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string | undefined;
  readonly line?: EdgeLine;
  /** A flowchart edge with an arrowhead at each end (`<-->`); absent means one, at the target. */
  readonly bidirectional?: boolean;
  /** What the edge's ends look like, beyond an arrowhead at the target. */
  readonly figure?: EdgeFigure;
  /** The words drawn on the edge when they are more than its label (a C4
   *  relationship's technology). Its label stays what the model says it is,
   *  which is what a selection reports. */
  readonly caption?: string;
};

export type ProjectedGroup = {
  readonly id: string;
  readonly label: string;
  readonly parentId: string | undefined;
  /**
   * The group is a model ELEMENT -- a composite state, a C4 boundary, an
   * architecture group -- selected, emphasised and commented on as a node.
   * A flowchart subgraph is a frame and nothing more, and carries no flag.
   */
  readonly element?: boolean;
  readonly figure?: GroupFigure;
  /** A flowchart subgraph's kind or authored category (`class groupId name`), which colours its panel. */
  readonly classes?: readonly string[];
};

export type ProjectedView = {
  readonly viewId: string;
  readonly kind: string;
  readonly title: string;
  readonly revision: string;
  readonly modelType: string;
  readonly direction?: GraphDirection;
  readonly nodes: readonly ProjectedNode[];
  readonly edges: readonly ProjectedEdge[];
  readonly groups: readonly ProjectedGroup[];
  /** The notation the view is drawn in; absent means a flowchart. */
  readonly notation?: GraphNotation;
  /** What the model says it is, drawn over the canvas (a C4 title and level). */
  readonly heading?: string;
  /** What the author says its line patterns mean (ADR 0030). */
  readonly lineKey?: readonly LineKeyEntry[];
  /** The authored `classDef` categories its nodes and groups wear (`palette.ts`). */
  readonly categories?: readonly Category[];
  /** Where the source writes its nodes, groups and edges (`source-order.ts`); absent when the lists' own order. */
  readonly sourceOrder?: SourceOrder;
};

/**
 * Everything on a graph view that is selected as a NODE: its nodes, and the
 * groups that are model elements. What the reader can select, what the host
 * is told of it, and what a comment can be about all start here.
 */
export function elementNodes(view: ProjectedView): readonly { readonly id: string; readonly label: string }[] {
  return [
    // A closed flowchart subgraph is a box, but no more selectable than its frame.
    ...view.nodes.filter((node) => node.folded?.element !== false).map((node) => ({ id: node.id, label: node.label })),
    ...view.groups.filter((group) => group.element === true).map((group) => ({ id: group.id, label: group.label })),
  ];
}

// --- Sequence types ---

export type ProjectedParticipant = {
  readonly id: string;
  readonly label: string;
  readonly kind?: ParticipantKind;
};

export type ProjectedSequenceEvent =
  | ProjectedMessageEvent
  | ProjectedFragmentEvent
  | ProjectedNoteEvent
  | ProjectedActivateEvent
  | ProjectedDeactivateEvent;

/** A `Note`: free text beside one lifeline, or over one or two of them. */
export type ProjectedNoteEvent = {
  readonly type: "note";
  readonly id: string;
  readonly position: NotePosition;
  readonly participants: readonly string[];
  readonly text: string;
};

export type ProjectedMessageEvent = {
  readonly type: "message";
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string | undefined;
  readonly kind: "sync" | "reply" | "async";
  /** An arrowhead at each end (`<<->>`, `<<-->>`); absent means one, at `to`. */
  readonly bidirectional?: boolean;
};

export type ProjectedFragmentEvent = {
  readonly type: "fragment";
  readonly id: string;
  readonly kind: "loop" | "alt" | "opt" | "par";
  readonly label: string;
  readonly sections: readonly ProjectedFragmentSection[];
};

export type ProjectedFragmentSection = {
  readonly label: string | undefined;
  readonly events: readonly ProjectedSequenceEvent[];
};

export type ProjectedActivateEvent = {
  readonly type: "activate";
  readonly participant: string;
};

export type ProjectedDeactivateEvent = {
  readonly type: "deactivate";
  readonly participant: string;
};

export type ProjectedSequence = {
  readonly viewId: string;
  readonly kind: string;
  readonly title: string;
  readonly revision: string;
  readonly modelType: string;
  readonly participants: readonly ProjectedParticipant[];
  readonly events: readonly ProjectedSequenceEvent[];
  readonly autonumber?: boolean;
};

// --- User journeys ---

export type ProjectedJourneyTask = {
  readonly id: string;
  readonly label: string;
  /** How the task feels, 1 (worst) to 5 (best). */
  readonly score: number;
  readonly actors: readonly string[];
};

export type ProjectedJourneySection = {
  readonly id: string;
  readonly label: string;
  readonly tasks: readonly ProjectedJourneyTask[];
};

/**
 * A user journey: sections in the order written, each with its tasks in
 * order. Order is the journey, so nothing here is sorted.
 */
export type ProjectedJourney = {
  readonly viewId: string;
  readonly kind: string;
  readonly title: string;
  readonly revision: string;
  readonly modelType: string;
  /** The journey's own title, when the source gives one. */
  readonly heading?: string;
  /** Every actor, in the order they first appear. */
  readonly actors: readonly string[];
  readonly sections: readonly ProjectedJourneySection[];
};

/** Every element of a journey, sections and tasks, in reading order: what is selected as a node. */
export function journeyElements(view: ProjectedJourney): readonly { readonly id: string; readonly label: string }[] {
  return view.sections.flatMap((section) => [
    { id: section.id, label: section.label },
    ...section.tasks.map((task) => ({ id: task.id, label: task.label })),
  ]);
}

type WireJourney = {
  type: "user-journey";
  title?: string | null;
  actors: string[];
  sections: { id: string; label: string; tasks: { id: string; label: string; score: number; actors: string[] }[] }[];
};

// --- Result types ---

export type ProjectionResult =
  | { readonly ok: true; readonly type: "graph"; readonly view: ProjectedView }
  | { readonly ok: true; readonly type: "sequence"; readonly view: ProjectedSequence }
  | { readonly ok: true; readonly type: "journey"; readonly view: ProjectedJourney }
  | { readonly ok: false; readonly errors: readonly ProjectionError[] };

export type ProjectionError = {
  readonly code: string;
  readonly message: string;
};

// --- Wire types ---

type WireNode = {
  id: string;
  label: string;
  shape?: string;
  classes?: string[];
  groupId?: string;
};

type WireEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  line?: EdgeLine;
  bidirectional?: boolean;
};

type WireGroup = {
  id: string;
  label: string;
  parentId?: string;
  classes?: string[];
};

type WireGraphModel = {
  type: string;
  direction?: GraphDirection;
  nodes: WireNode[];
  edges: WireEdge[];
  groups: WireGroup[];
  categories?: Category[];
  sourceOrder?: { elements: { id: string; kind: "node" | "group" }[]; edges: string[] };
};

type WireParticipant = {
  id: string;
  label: string;
  kind?: ParticipantKind;
};

type WireSequenceEvent = {
  type: string;
  id?: string;
  from?: string;
  to?: string;
  label?: string;
  kind?: string;
  bidirectional?: boolean;
  participant?: string;
  sections?: WireFragmentSection[];
  position?: NotePosition;
  participants?: string[];
  text?: string;
};

type WireFragmentSection = {
  label?: string;
  events: WireSequenceEvent[];
};

type WireSequenceModel = {
  type: "sequence-trace";
  participants: WireParticipant[];
  events: WireSequenceEvent[];
  autonumber?: boolean;
};

type WireEnvelope = {
  schemaVersion: number;
  view: {
    id: string;
    kind: string;
    title: string;
  };
  revision: string;
  model: WireGraphModel | WireSequenceModel;
};

function isSequenceModel(model: WireGraphModel | WireSequenceModel): model is WireSequenceModel {
  return model.type === "sequence-trace";
}

/**
 * Projects a list of wire events, reporting any whose type is not known.
 *
 * AN UNKNOWN TYPE IS REFUSED THROUGH THE RESULT -- not thrown, and not dropped.
 *
 * The envelope has already passed schema validation here, and the schema
 * lists the event types, so in a matched build this cannot happen. It happens
 * when the schema has gained an event type and this switch has not: a build
 * mistake, and precisely the moment the UI most needs to fail well.
 *
 *   - Throwing was wrong for the boundary. `projectEnvelope` answers with a
 *     `ProjectionResult`, and its one caller turns `ok: false` into the error
 *     banner over the last valid drawing. A throw bypasses that and escapes
 *     the bridge's message handler, leaving a stale diagram with no notice.
 *   - Skipping the event would be worse. A sequence is an ordered account; one
 *     drawn with a step missing is a different account presented as the real
 *     one, and the repository's rule is that nothing is silently ignored.
 *
 * So projection is the single gate, and the layers behind it (layout,
 * navigation, selection) are total over the event union: they see only the
 * types listed here, never throw, and give an event they have no row for no
 * row. `sequence-unknown-event.test.ts` pins all four.
 */
function projectEvents(wireEvents: WireSequenceEvent[], unknown: string[]): ProjectedSequenceEvent[] {
  return wireEvents.flatMap((e): ProjectedSequenceEvent[] => {
    const projected = projectEvent(e, unknown);
    return projected === undefined ? [] : [projected];
  });
}

function projectEvent(e: WireSequenceEvent, unknown: string[]): ProjectedSequenceEvent | undefined {
  switch (e.type) {
    case "message":
      return {
        type: "message",
        id: e.id!,
        from: e.from!,
        to: e.to!,
        label: e.label,
        kind: e.kind as "sync" | "reply" | "async",
        ...(e.bidirectional === true ? { bidirectional: true } : {}),
      };
    case "fragment":
      return {
        type: "fragment",
        id: e.id!,
        kind: e.kind as "loop" | "alt" | "opt" | "par",
        label: e.label!,
        sections: (e.sections ?? []).map((s) => ({
          label: s.label,
          events: projectEvents(s.events, unknown),
        })),
      };
    case "note":
      return {
        type: "note",
        id: e.id!,
        position: e.position!,
        participants: [...(e.participants ?? [])],
        text: e.text!,
      };
    case "activate":
      return {
        type: "activate",
        participant: e.participant!,
      };
    case "deactivate":
      return {
        type: "deactivate",
        participant: e.participant!,
      };
    default:
      unknown.push(e.type);
      return undefined;
  }
}

/** What a model projects to on the graph canvas: everything but the view's own fields. */
export type GraphDrawing = Pick<ProjectedView, "direction" | "nodes" | "edges" | "groups" | "notation" | "heading">;

/**
 * Every model type this build draws. An envelope naming another is refused by
 * NAME before the schema is consulted: a page older than the server that sent
 * it (a page the Rust server embeds never receives the new types, but a copy
 * of it can be pointed anywhere) then says which type it cannot draw, rather
 * than reciting the schema's complaints about fields it has never heard of.
 */
export const DRAWN_MODEL_TYPES: readonly string[] = [
  "architecture-graph",
  "data-flow-graph",
  "freeform-graph",
  "sequence-trace",
  "state-machine",
  "entity-relationship",
  "c4-model",
  "service-architecture",
  "user-journey",
];

function unknownModelType(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const model = (value as { model?: unknown }).model;
  if (typeof model !== "object" || model === null) return null;
  const type = (model as { type?: unknown }).type;
  return typeof type === "string" && !DRAWN_MODEL_TYPES.includes(type) ? type : null;
}

export function projectEnvelope(value: unknown): ProjectionResult {
  const unknownType = unknownModelType(value);
  if (unknownType !== null) {
    return {
      ok: false,
      errors: [
        {
          code: "unknown_model_type",
          message: `This page cannot draw a diagram of type ${JSON.stringify(unknownType.slice(0, 64))}. It may be older than the server that sent it; reload the page.`,
        },
      ],
    };
  }
  const validation: ValidationResult = validateEnvelope(value);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors.map((e) => ({
        code: e.keyword,
        message: e.message ?? e.keyword,
      })),
    };
  }

  const envelope = value as WireEnvelope;

  if (isSequenceModel(envelope.model)) {
    const participants: ProjectedParticipant[] = envelope.model.participants.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
    }));

    const unknown: string[] = [];
    const events = projectEvents(envelope.model.events, unknown);
    if (unknown.length > 0) {
      return {
        ok: false,
        errors: [...new Set(unknown)].map((type) => ({
          code: "unknown_sequence_event",
          message: `This build cannot draw a sequence event of type ${JSON.stringify(type)}`,
        })),
      };
    }

    return {
      ok: true,
      type: "sequence",
      view: {
        viewId: envelope.view.id,
        kind: envelope.view.kind,
        title: envelope.view.title,
        revision: envelope.revision,
        modelType: envelope.model.type,
        participants,
        events,
        autonumber: envelope.model.autonumber,
      },
    };
  }

  const viewOf = (drawn: GraphDrawing): ProjectionResult => ({
    ok: true,
    type: "graph",
    view: {
      viewId: envelope.view.id,
      kind: envelope.view.kind,
      title: envelope.view.title,
      revision: envelope.revision,
      modelType: envelope.model.type,
      ...drawn,
      ...lineKeyOf(envelope.model),
    },
  });

  switch (envelope.model.type) {
    case "state-machine":
      return viewOf(projectStateMachine(envelope.model as unknown as WireStateMachine));
    case "entity-relationship":
      return viewOf(projectEntityRelationship(envelope.model as unknown as WireEntityRelationship));
    case "c4-model":
      return viewOf(projectC4(envelope.model as unknown as WireC4Model));
    case "service-architecture":
      return viewOf(projectArchitecture(envelope.model as unknown as WireServiceArchitecture));
    case "user-journey": {
      const journey = envelope.model as unknown as WireJourney;
      return {
        ok: true,
        type: "journey",
        view: {
          viewId: envelope.view.id,
          kind: envelope.view.kind,
          title: envelope.view.title,
          revision: envelope.revision,
          modelType: journey.type,
          ...(journey.title == null || journey.title === "" ? {} : { heading: journey.title }),
          actors: [...journey.actors],
          sections: journey.sections.map((section) => ({
            id: section.id,
            label: section.label,
            tasks: section.tasks.map((task) => ({
              id: task.id,
              label: task.label,
              score: task.score,
              actors: [...task.actors],
            })),
          })),
        },
      };
    }
    default:
      break;
  }

  const graphModel = envelope.model as WireGraphModel;

  const nodes: ProjectedNode[] = graphModel.nodes
    .map((n) => ({
      id: n.id,
      label: n.label,
      shape: n.shape,
      classes: n.classes ?? [],
      groupId: n.groupId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const edges: ProjectedEdge[] = graphModel.edges
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      line: e.line,
      ...(e.bidirectional === true ? { bidirectional: true } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const groups: ProjectedGroup[] = graphModel.groups
    .map((g) => ({
      id: g.id,
      label: g.label,
      parentId: g.parentId,
      ...(g.classes === undefined || g.classes.length === 0 ? {} : { classes: [...g.classes] }),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    ok: true,
    type: "graph",
    view: {
      viewId: envelope.view.id,
      kind: envelope.view.kind,
      title: envelope.view.title,
      revision: envelope.revision,
      modelType: envelope.model.type,
      direction: graphModel.direction,
      nodes,
      edges,
      groups,
      ...lineKeyOf(envelope.model),
      ...(graphModel.categories === undefined || graphModel.categories.length === 0
        ? {}
        : {
            categories: graphModel.categories.map((category) => ({
              name: category.name,
              ...(category.fill === undefined ? {} : { fill: category.fill }),
              ...(category.stroke === undefined ? {} : { stroke: category.stroke }),
              ...(category.dashed === true ? { dashed: true } : {}),
              ...(category.meaning === undefined ? {} : { meaning: category.meaning }),
            })),
          }),
      ...(graphModel.sourceOrder === undefined
        ? {}
        : {
            sourceOrder: {
              elements: graphModel.sourceOrder.elements.map(({ id, kind }) => ({ id, kind })),
              edges: [...graphModel.sourceOrder.edges],
            },
          }),
    },
  };
}
