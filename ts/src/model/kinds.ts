// Which view kinds a compiled model may be shown as, and the model a view of
// each kind carries (Rust's `model_for_kind`, widened to the new types).
//
// A flowchart compiles to a freeform graph, and a view of any graph kind
// re-tags it: the four `c4-*` kinds carry an `architecture-graph`,
// `data-flow` a `data-flow-graph`, `freeform` the graph as compiled. Every
// other kind carries exactly one model type, unchanged.

import type { DiagramKind, DiagramModel, DiagramModelType } from "./envelope.ts";
import type { GraphModel, GraphModelType } from "./graph.ts";

/** The model type a view of each kind carries. */
export const MODEL_TYPE_FOR_KIND: Readonly<Record<DiagramKind, DiagramModelType>> = {
  "c4-context": "architecture-graph",
  "c4-container": "architecture-graph",
  "c4-component": "architecture-graph",
  "c4-code": "architecture-graph",
  "data-flow": "data-flow-graph",
  freeform: "freeform-graph",
  sequence: "sequence-trace",
  state: "state-machine",
  "entity-relationship": "entity-relationship",
  c4: "c4-model",
  architecture: "service-architecture",
  journey: "user-journey",
};

const GRAPH_TYPES: ReadonlySet<string> = new Set<GraphModelType>([
  "architecture-graph",
  "data-flow-graph",
  "freeform-graph",
]);

export function isGraphModel(model: DiagramModel): model is GraphModel {
  return GRAPH_TYPES.has(model.type);
}

/** The kind a view of `model` takes when no manifest or argument names one. */
export function defaultKind(model: DiagramModel): DiagramKind {
  if (isGraphModel(model)) return "freeform";
  const found = (Object.keys(MODEL_TYPE_FOR_KIND) as DiagramKind[]).find(
    (kind) => MODEL_TYPE_FOR_KIND[kind] === model.type,
  );
  return found ?? "freeform";
}

/** The model a view of `kind` carries for the compiled `model`, or null when the kind does not fit it. */
export function modelForKind(model: DiagramModel, kind: DiagramKind): DiagramModel | null {
  const wanted = MODEL_TYPE_FOR_KIND[kind];
  if (isGraphModel(model)) return GRAPH_TYPES.has(wanted) ? { ...model, type: wanted as GraphModelType } : null;
  return model.type === wanted ? model : null;
}

export function kindFits(kind: DiagramKind, model: DiagramModel): boolean {
  return modelForKind(model, kind) !== null;
}

const DESCRIPTIONS: Readonly<Record<DiagramModelType, string>> = {
  "architecture-graph": "a flowchart",
  "data-flow-graph": "a flowchart",
  "freeform-graph": "a flowchart",
  "sequence-trace": "a sequence diagram",
  "state-machine": "a state diagram",
  "entity-relationship": "an entity-relationship diagram",
  "c4-model": "a C4 diagram",
  "service-architecture": "an architecture diagram",
  "user-journey": "a user journey",
};

/** What `model` was written as, for messages: "a flowchart", "a state diagram", ... */
export function describeModel(model: DiagramModel): string {
  return DESCRIPTIONS[model.type];
}
