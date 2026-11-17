// Static AJV standalone output preserves the schema contract under MCP Apps CSP.
import validate from "./envelope-validator.generated.cjs";

export type ValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

export type ValidationIssue = {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message?: string;
};

type WireElement = { id: string };
type WireNode = WireElement & { groupId?: string | null };
type WireEdge = WireElement & { source: string; target: string };
type WireGroup = WireElement & { parentId?: string | null };
type WireParticipant = WireElement;
type WireMessage = WireElement & { from: string; to: string };
type WireFragment = WireElement & { sections: WireFragmentSection[] };
type WireFragmentSection = { events: WireSequenceEvent[] };
type WireSequenceEvent = { type: string } & Partial<WireMessage> &
  Partial<WireFragment> & {
    participant?: string;
    /** `note` events: where the note sits, and the lifelines it names. */
    position?: string;
    participants?: string[];
  };
type WireGraphModel = {
  type: string;
  nodes: WireNode[];
  edges: WireEdge[];
  groups: WireGroup[];
};
type WireSequenceModel = {
  type: "sequence-trace";
  participants: WireParticipant[];
  events: WireSequenceEvent[];
};
type WireEnvelope = {
  view: { kind: string };
  model: WireGraphModel | WireSequenceModel;
};

export function validateEnvelope(value: unknown): ValidationResult {
  if (validate(value)) {
    const semanticErrors = validateSemantics(value as WireEnvelope);
    if (semanticErrors.length === 0) return { ok: true, value };
    return { ok: false, errors: semanticErrors };
  }
  return { ok: false, errors: validate.errors ?? [] };
}

function validateSemantics(envelope: WireEnvelope): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const { model } = envelope;
  const architectureKinds = new Set(["c4-context", "c4-container", "c4-component", "c4-code"]);
  const compatible =
    (architectureKinds.has(envelope.view.kind) && model.type === "architecture-graph") ||
    (envelope.view.kind === "data-flow" && model.type === "data-flow-graph") ||
    (envelope.view.kind === "freeform" && model.type === "freeform-graph") ||
    (envelope.view.kind === "sequence" && model.type === "sequence-trace") ||
    MODEL_FOR_KIND[envelope.view.kind] === model.type;
  if (!compatible) {
    errors.push(issue("/model/type", "kind_model_mismatch", "model type is incompatible with view kind"));
  }

  const elements = ELEMENT_MODELS[model.type];
  if (model.type === "sequence-trace") {
    validateSequenceSemantics(model as WireSequenceModel, errors);
  } else if (elements !== undefined) {
    validateElementSemantics(elements(model as unknown as Wire), errors);
  } else {
    validateGraphSemantics(model as WireGraphModel, errors);
  }

  return errors;
}

function validateGraphSemantics(model: WireGraphModel, errors: ValidationIssue[]): void {
  checkUnique(model.nodes, "nodes", "duplicate_node_id", errors);
  checkUnique(model.edges, "edges", "duplicate_edge_id", errors);
  checkUnique(model.groups, "groups", "duplicate_group_id", errors);

  const nodeIds = new Set(model.nodes.map(({ id }) => id));
  const groupIds = new Set(model.groups.map(({ id }) => id));
  model.edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.source)) {
      errors.push(issue(`/model/edges/${index}/source`, "dangling_edge_source"));
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(issue(`/model/edges/${index}/target`, "dangling_edge_target"));
    }
  });
  model.nodes.forEach((node, index) => {
    if (node.groupId != null && !groupIds.has(node.groupId)) {
      errors.push(issue(`/model/nodes/${index}/groupId`, "dangling_node_group"));
    }
  });

  const parents = new Map(model.groups.map((group) => [group.id, group.parentId ?? undefined]));
  model.groups.forEach((group, index) => {
    const visited = new Set<string>();
    let parent = group.parentId ?? undefined;
    while (parent !== undefined) {
      if (!parents.has(parent)) {
        errors.push(issue(`/model/groups/${index}/parentId`, "dangling_group_parent"));
        break;
      }
      if (parent === group.id || visited.has(parent)) {
        errors.push(issue(`/model/groups/${index}/parentId`, "group_cycle"));
        break;
      }
      visited.add(parent);
      parent = parents.get(parent);
    }
  });
}

function validateSequenceSemantics(model: WireSequenceModel, errors: ValidationIssue[]): void {
  checkUnique(model.participants, "participants", "duplicate_participant_id", errors);

  const participantIds = new Set(model.participants.map(({ id }) => id));
  const allIds = new Set(participantIds);

  validateSequenceEvents(model.events, participantIds, allIds, "/model/events", errors);
}

function validateSequenceEvents(
  events: WireSequenceEvent[],
  participantIds: ReadonlySet<string>,
  allIds: Set<string>,
  basePath: string,
  errors: ValidationIssue[],
): void {
  events.forEach((event, index) => {
    const path = `${basePath}/${index}`;
    if (event.type === "message") {
      if (event.id !== undefined) {
        if (allIds.has(event.id)) {
          errors.push(issue(`${path}/id`, "duplicate_message_id"));
        }
        allIds.add(event.id);
      }
      if (event.from !== undefined && !participantIds.has(event.from)) {
        errors.push(issue(`${path}/from`, "dangling_message_participant"));
      }
      if (event.to !== undefined && !participantIds.has(event.to)) {
        errors.push(issue(`${path}/to`, "dangling_message_participant"));
      }
    } else if (event.type === "fragment") {
      if (event.id !== undefined) {
        if (allIds.has(event.id)) {
          errors.push(issue(`${path}/id`, "duplicate_fragment_id"));
        }
        allIds.add(event.id);
      }
      const sections = event.sections ?? [];
      sections.forEach((section, sIndex) => {
        validateSequenceEvents(section.events, participantIds, allIds, `${path}/sections/${sIndex}/events`, errors);
      });
    } else if (event.type === "note") {
      if (event.id !== undefined) {
        if (allIds.has(event.id)) {
          errors.push(issue(`${path}/id`, "duplicate_note_id"));
        }
        allIds.add(event.id);
      }
      // `over` spans one or two lifelines; `left-of`/`right-of` sit beside one.
      const named = event.participants ?? [];
      const most = event.position === "over" ? 2 : 1;
      if (named.length < 1 || named.length > most) {
        errors.push(issue(`${path}/participants`, "invalid_note_participants"));
      }
      named.forEach((participant, pIndex) => {
        if (!participantIds.has(participant)) {
          errors.push(issue(`${path}/participants/${pIndex}`, "dangling_note_participant"));
        }
      });
    } else if (event.type === "activate" || event.type === "deactivate") {
      if (event.participant !== undefined && !participantIds.has(event.participant)) {
        errors.push(issue(`${path}/participant`, "dangling_activation_participant"));
      }
    }
  });
}

function checkUnique(elements: WireElement[], collection: string, keyword: string, errors: ValidationIssue[]) {
  const seen = new Set<string>();
  elements.forEach((element, index) => {
    if (seen.has(element.id)) errors.push(issue(`/model/${collection}/${index}/id`, keyword));
    seen.add(element.id);
  });
}

function issue(instancePath: string, keyword: string, message?: string): ValidationIssue {
  return { instancePath, keyword, message };
}

/** The view kind each of the newer model types is the one model of. */
const MODEL_FOR_KIND: Readonly<Record<string, string>> = {
  state: "state-machine",
  "entity-relationship": "entity-relationship",
  c4: "c4-model",
  architecture: "service-architecture",
  journey: "user-journey",
};

/**
 * A model's elements, as the checks below need them: every id it declares and
 * where, every reference one element makes to another, and every containment
 * (which must not loop).
 */
type ElementFacts = {
  /** `link` marks a transition, relationship or edge: never something a link may end on. */
  readonly ids: readonly { readonly path: string; readonly id: string; readonly link?: boolean }[];
  readonly references: readonly { readonly path: string; readonly id: string }[];
  readonly parents: readonly { readonly path: string; readonly id: string; readonly parent: string }[];
};

type Wire = Record<string, unknown>;
const list = (model: Wire, field: string): Wire[] => (Array.isArray(model[field]) ? (model[field] as Wire[]) : []);
const idOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const LINK_FIELDS = new Set(["transitions", "relationships", "edges"]);

function declared(model: Wire, field: string): ElementFacts["ids"] {
  return list(model, field).map((element, index) => ({
    path: `/model/${field}/${index}/id`,
    id: String(element.id),
    ...(LINK_FIELDS.has(field) ? { link: true } : {}),
  }));
}

function referenced(model: Wire, field: string, keys: readonly string[]): ElementFacts["references"] {
  return list(model, field).flatMap((element, index) =>
    keys.flatMap((key) => {
      const id = idOf(element[key]);
      return id === undefined ? [] : [{ path: `/model/${field}/${index}/${key}`, id }];
    }),
  );
}

function contained(model: Wire, field: string, key: string): ElementFacts["parents"] {
  return list(model, field).flatMap((element, index) => {
    const parent = idOf(element[key]);
    return parent === undefined ? [] : [{ path: `/model/${field}/${index}/${key}`, id: String(element.id), parent }];
  });
}

/** What each newer model declares and refers to. Ids share one namespace per model, as in Mermaid. */
const ELEMENT_MODELS: Readonly<Record<string, (model: Wire) => ElementFacts>> = {
  "state-machine": (model) => ({
    ids: [...declared(model, "states"), ...declared(model, "transitions")],
    references: [
      ...referenced(model, "transitions", ["source", "target"]),
      ...referenced(model, "states", ["parentId"]),
    ],
    parents: contained(model, "states", "parentId"),
  }),
  "entity-relationship": (model) => ({
    ids: [...declared(model, "entities"), ...declared(model, "relationships")],
    references: referenced(model, "relationships", ["source", "target"]),
    parents: [],
  }),
  "c4-model": (model) => ({
    ids: [...declared(model, "elements"), ...declared(model, "boundaries"), ...declared(model, "relationships")],
    references: [
      ...referenced(model, "relationships", ["source", "target"]),
      ...referenced(model, "elements", ["boundaryId"]),
      ...referenced(model, "boundaries", ["parentId"]),
    ],
    parents: contained(model, "boundaries", "parentId"),
  }),
  "user-journey": (model) => ({
    ids: list(model, "sections").flatMap((section, index) => [
      { path: `/model/sections/${index}/id`, id: String(section.id) },
      ...list(section, "tasks").map((task, taskIndex) => ({
        path: `/model/sections/${index}/tasks/${taskIndex}/id`,
        id: String(task.id),
      })),
    ]),
    references: [],
    parents: [],
  }),
  "service-architecture": (model) => ({
    ids: [
      ...declared(model, "groups"),
      ...declared(model, "services"),
      ...declared(model, "junctions"),
      ...declared(model, "edges"),
    ],
    references: [
      ...referenced(model, "edges", ["source", "target"]),
      ...referenced(model, "services", ["groupId"]),
      ...referenced(model, "junctions", ["groupId"]),
      ...referenced(model, "groups", ["parentId"]),
    ],
    parents: contained(model, "groups", "parentId"),
  }),
};

function validateElementSemantics(facts: ElementFacts, errors: ValidationIssue[]): void {
  const seen = new Set<string>();
  const links = new Set<string>();
  for (const { path, id, link } of facts.ids) {
    if (seen.has(id)) errors.push(issue(path, "duplicate_element_id"));
    seen.add(id);
    if (link === true) links.add(id);
  }
  // Every reference names a point (a state, an entity, a service, a group),
  // never a link: the layout has nothing to end a wire on there.
  for (const { path, id } of facts.references) {
    if (!seen.has(id) || links.has(id)) errors.push(issue(path, "dangling_element_reference"));
  }
  // A containment that loops would send the layout round it for ever.
  const parentOf = new Map(facts.parents.map(({ id, parent }) => [id, parent]));
  for (const { path, id } of facts.parents) {
    const visited = new Set<string>([id]);
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) {
      if (visited.has(at)) {
        errors.push(issue(path, "containment_cycle"));
        break;
      }
      visited.add(at);
    }
  }
}
