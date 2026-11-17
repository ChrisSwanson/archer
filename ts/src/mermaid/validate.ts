// The last check before a model leaves the compiler. Everything in a model
// was copied out of Mermaid's internal databases; none of it is trusted for
// that. The model is held to the envelope schema and the profile on the way
// out: stable IDs, the enumerations, safe labels within the bound, unique IDs
// and no reference to anything the model does not hold.

import {
  EDGE_LINES,
  FRAGMENT_KINDS,
  isStableId,
  MESSAGE_KINDS,
  NODE_SHAPES,
  NOTE_POSITIONS,
  type DiagramModel,
  type GraphModel,
  type SequenceEvent,
  type SequenceTrace,
} from "../model/index.ts";
import { span } from "./diagnostics.ts";
import { checkLabel } from "./labels.ts";
import {
  validateArchitecture,
  validateC4,
  validateEntityRelationship,
  validateJourney,
  validateStateMachine,
} from "./validate-types.ts";

const AT = span(1, 1);

function labelProblems(where: string, label: string | null | undefined): string[] {
  if (label === undefined || label === null) return [];
  return checkLabel(label, AT).map((problem) => `${where}: ${problem.code}`);
}

function idProblems(where: string, id: string): string[] {
  return isStableId(id) ? [] : [`${where}: '${id}' is not a stable ID`];
}

function duplicates(where: string, ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return ids.flatMap((id) => {
    if (!seen.has(id)) {
      seen.add(id);
      return [];
    }
    return [`${where}: '${id}' appears twice`];
  });
}

function validateGraph(model: GraphModel): string[] {
  const problems: string[] = [];
  const nodes = new Set(model.nodes.map((node) => node.id));
  const groups = new Map(model.groups.map((group) => [group.id, group.parentId ?? undefined]));
  problems.push(
    ...duplicates(
      "node",
      model.nodes.map((node) => node.id),
    ),
  );
  problems.push(
    ...duplicates(
      "edge",
      model.edges.map((edge) => edge.id),
    ),
  );
  problems.push(
    ...duplicates(
      "group",
      model.groups.map((group) => group.id),
    ),
  );
  for (const node of model.nodes) {
    const where = `node '${node.id}'`;
    problems.push(...idProblems(where, node.id), ...labelProblems(where, node.label));
    if (node.shape != null && !(NODE_SHAPES as readonly string[]).includes(node.shape))
      problems.push(`${where}: shape ${node.shape}`);
    if (node.groupId != null && !groups.has(node.groupId)) problems.push(`${where}: no group '${node.groupId}'`);
    for (const name of node.classes ?? []) problems.push(...labelProblems(`${where} class`, name));
  }
  for (const edge of model.edges) {
    const where = `edge '${edge.id}'`;
    problems.push(...idProblems(where, edge.id), ...labelProblems(where, edge.label));
    if (!nodes.has(edge.source)) problems.push(`${where}: no source node '${edge.source}'`);
    if (!nodes.has(edge.target)) problems.push(`${where}: no target node '${edge.target}'`);
    if (edge.line !== undefined && !(EDGE_LINES as readonly string[]).includes(edge.line))
      problems.push(`${where}: line ${edge.line}`);
    if (edge.bidirectional !== undefined && typeof edge.bidirectional !== "boolean")
      problems.push(`${where}: bidirectional ${String(edge.bidirectional)}`);
  }
  for (const group of model.groups) {
    const where = `group '${group.id}'`;
    problems.push(...idProblems(where, group.id), ...labelProblems(where, group.label));
    const seen = new Set([group.id]);
    for (let parent = group.parentId ?? undefined; parent !== undefined; parent = groups.get(parent)) {
      if (!groups.has(parent)) {
        problems.push(`${where}: no parent group '${parent}'`);
        break;
      }
      if (seen.has(parent)) {
        problems.push(`${where}: groups nest in a cycle`);
        break;
      }
      seen.add(parent);
    }
  }
  return problems;
}

function validateEvents(events: readonly SequenceEvent[], participants: ReadonlySet<string>, ids: string[]): string[] {
  const problems: string[] = [];
  const known = (where: string, id: string) => (participants.has(id) ? [] : [`${where}: no participant '${id}'`]);
  for (const event of events) {
    if (event.type === "message") {
      const where = `message '${event.id}'`;
      ids.push(event.id);
      problems.push(
        ...idProblems(where, event.id),
        ...labelProblems(where, event.label),
        ...known(where, event.from),
        ...known(where, event.to),
      );
      if (!(MESSAGE_KINDS as readonly string[]).includes(event.kind)) problems.push(`${where}: kind ${event.kind}`);
      if (event.bidirectional !== undefined && (event.bidirectional !== true || event.kind === "async"))
        problems.push(`${where}: bidirectional ${String(event.bidirectional)}`);
    } else if (event.type === "note") {
      const where = `note '${event.id}'`;
      ids.push(event.id);
      problems.push(...idProblems(where, event.id), ...labelProblems(where, event.text));
      if (!(NOTE_POSITIONS as readonly string[]).includes(event.position))
        problems.push(`${where}: position ${event.position}`);
      const count = event.participants.length;
      if (count < 1 || count > (event.position === "over" ? 2 : 1)) problems.push(`${where}: ${count} participants`);
      for (const id of event.participants) problems.push(...known(where, id));
    } else if (event.type === "fragment") {
      const where = `fragment '${event.id}'`;
      ids.push(event.id);
      problems.push(...idProblems(where, event.id), ...labelProblems(where, event.label));
      if (!(FRAGMENT_KINDS as readonly string[]).includes(event.kind)) problems.push(`${where}: kind ${event.kind}`);
      if (event.sections.length === 0) problems.push(`${where}: no sections`);
      for (const section of event.sections) {
        problems.push(
          ...labelProblems(`${where} section`, section.label),
          ...validateEvents(section.events, participants, ids),
        );
      }
    } else {
      problems.push(...known(event.type, event.participant));
    }
  }
  return problems;
}

function validateTrace(model: SequenceTrace): string[] {
  const problems: string[] = [];
  const participants = new Set(model.participants.map((participant) => participant.id));
  problems.push(
    ...duplicates(
      "participant",
      model.participants.map((participant) => participant.id),
    ),
  );
  for (const participant of model.participants) {
    const where = `participant '${participant.id}'`;
    problems.push(...idProblems(where, participant.id), ...labelProblems(where, participant.label));
  }
  const ids: string[] = [];
  problems.push(...validateEvents(model.events, participants, ids));
  problems.push(...duplicates("event", ids));
  return problems;
}

/** Every way `model` breaks the schema or the profile; empty when it is sound. */
export function validateModel(model: DiagramModel): string[] {
  switch (model.type) {
    case "sequence-trace":
      return validateTrace(model);
    case "state-machine":
      return validateStateMachine(model);
    case "entity-relationship":
      return validateEntityRelationship(model);
    case "c4-model":
      return validateC4(model);
    case "service-architecture":
      return validateArchitecture(model);
    case "user-journey":
      return validateJourney(model);
    default:
      return validateGraph(model);
  }
}
