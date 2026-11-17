// The last check on the way out for the state, ER, C4, architecture and
// journey models, as validate.ts is for graphs and traces: stable IDs, the
// enumerations, safe labels within the bound, unique IDs, and no reference
// to anything the model does not hold.

import {
  ARCHITECTURE_ICONS,
  ARCHITECTURE_SIDES,
  ATTRIBUTE_KEYS,
  C4_BOUNDARY_KINDS,
  C4_ELEMENT_KINDS,
  C4_ELEMENT_SHAPES,
  C4_LEVELS,
  CARDINALITIES,
  DIRECTIONS,
  isStableId,
  MAX_JOURNEY_SCORE,
  MIN_JOURNEY_SCORE,
  STATE_KINDS,
  STATE_NOTE_POSITIONS,
  type C4Model,
  type EntityRelationship,
  type ServiceArchitecture,
  type StateMachine,
  type UserJourney,
} from "../model/index.ts";
import { span } from "./diagnostics.ts";
import { checkLabel } from "./labels.ts";

const AT = span(1, 1);

class Problems {
  readonly list: string[] = [];
  readonly #ids = new Map<string, Set<string>>();

  label(where: string, label: string | null | undefined): void {
    if (label === undefined || label === null) return;
    for (const problem of checkLabel(label, AT)) this.list.push(`${where}: ${problem.code}`);
  }

  /** A stable ID, unique within `namespace`. */
  id(where: string, id: string, namespace: string): void {
    if (!isStableId(id)) this.list.push(`${where}: '${id}' is not a stable ID`);
    const seen = this.#ids.get(namespace) ?? new Set<string>();
    if (seen.has(id)) this.list.push(`${where}: '${id}' appears twice`);
    seen.add(id);
    this.#ids.set(namespace, seen);
  }

  oneOf(where: string, what: string, value: unknown, allowed: readonly string[], optional = true): void {
    if (optional && (value === undefined || value === null)) return;
    if (typeof value !== "string" || !allowed.includes(value)) this.list.push(`${where}: ${what} ${String(value)}`);
  }

  known(where: string, what: string, id: string | null | undefined, among: ReadonlySet<string>): void {
    if (id === undefined || id === null) return;
    if (!among.has(id)) this.list.push(`${where}: no ${what} '${id}'`);
  }

  /** Parents named by `parentOf` exist and never loop. */
  tree(what: string, ids: readonly string[], parentOf: (id: string) => string | null | undefined): void {
    const known = new Set(ids);
    for (const id of ids) {
      const seen = new Set([id]);
      for (let parent = parentOf(id); parent != null; parent = parentOf(parent)) {
        if (!known.has(parent)) {
          this.list.push(`${what} '${id}': no parent '${parent}'`);
          break;
        }
        if (seen.has(parent)) {
          this.list.push(`${what} '${id}': parents form a cycle`);
          break;
        }
        seen.add(parent);
      }
    }
  }
}

export function validateStateMachine(model: StateMachine): string[] {
  const p = new Problems();
  p.oneOf("direction", "direction", model.direction, DIRECTIONS);
  const parents = new Map(model.states.map((s) => [s.id, s.parentId ?? undefined]));
  for (const state of model.states) {
    const where = `state '${state.id}'`;
    p.id(where, state.id, "state");
    p.label(where, state.label);
    p.oneOf(where, "kind", state.kind, STATE_KINDS);
    if (state.note != null) {
      p.oneOf(where, "note position", state.note.position, STATE_NOTE_POSITIONS, false);
      p.label(`${where} note`, state.note.text);
    }
  }
  p.tree("state", [...parents.keys()], (id) => parents.get(id));
  const states = new Set(parents.keys());
  for (const transition of model.transitions) {
    const where = `transition '${transition.id}'`;
    p.id(where, transition.id, "transition");
    p.label(where, transition.label);
    p.known(where, "source state", transition.source, states);
    p.known(where, "target state", transition.target, states);
  }
  return p.list;
}

export function validateEntityRelationship(model: EntityRelationship): string[] {
  const p = new Problems();
  p.oneOf("direction", "direction", model.direction, DIRECTIONS);
  for (const entity of model.entities) {
    const where = `entity '${entity.id}'`;
    p.id(where, entity.id, "entity");
    p.label(where, entity.label);
    for (const attribute of entity.attributes) {
      const at = `${where} attribute '${attribute.name}'`;
      p.label(at, attribute.name);
      p.label(at, attribute.type);
      p.label(at, attribute.comment);
      if (attribute.name.trim() === "" || attribute.type.trim() === "") p.list.push(`${at}: empty name or type`);
      for (const key of attribute.keys ?? []) p.oneOf(at, "key", key, ATTRIBUTE_KEYS, false);
    }
  }
  const entities = new Set(model.entities.map((entity) => entity.id));
  for (const relationship of model.relationships) {
    const where = `relationship '${relationship.id}'`;
    p.id(where, relationship.id, "relationship");
    p.label(where, relationship.label);
    p.known(where, "source entity", relationship.source, entities);
    p.known(where, "target entity", relationship.target, entities);
    p.oneOf(where, "cardinality", relationship.sourceCardinality, CARDINALITIES, false);
    p.oneOf(where, "cardinality", relationship.targetCardinality, CARDINALITIES, false);
    if (typeof relationship.identifying !== "boolean") p.list.push(`${where}: identifying is not a boolean`);
  }
  return p.list;
}

export function validateC4(model: C4Model): string[] {
  const p = new Problems();
  p.oneOf("level", "level", model.level, C4_LEVELS, false);
  p.label("title", model.title);
  const parents = new Map(model.boundaries.map((b) => [b.id, b.parentId ?? undefined]));
  for (const boundary of model.boundaries) {
    const where = `boundary '${boundary.id}'`;
    p.id(where, boundary.id, "element");
    p.label(where, boundary.label);
    p.oneOf(where, "kind", boundary.kind, C4_BOUNDARY_KINDS, false);
  }
  p.tree("boundary", [...parents.keys()], (id) => parents.get(id));
  const boundaries = new Set(parents.keys());
  for (const element of model.elements) {
    const where = `element '${element.id}'`;
    p.id(where, element.id, "element");
    p.label(where, element.label);
    p.label(where, element.technology);
    p.label(where, element.description);
    p.oneOf(where, "kind", element.kind, C4_ELEMENT_KINDS, false);
    p.oneOf(where, "shape", element.shape, C4_ELEMENT_SHAPES);
    p.known(where, "boundary", element.boundaryId, boundaries);
  }
  const elements = new Set(model.elements.map((element) => element.id));
  for (const relationship of model.relationships) {
    const where = `relationship '${relationship.id}'`;
    p.id(where, relationship.id, "relationship");
    p.label(where, relationship.label);
    p.label(where, relationship.technology);
    p.label(where, relationship.description);
    p.known(where, "source element", relationship.source, elements);
    p.known(where, "target element", relationship.target, elements);
  }
  return p.list;
}

export function validateArchitecture(model: ServiceArchitecture): string[] {
  const p = new Problems();
  p.label("title", model.title);
  const parents = new Map(model.groups.map((g) => [g.id, g.parentId ?? undefined]));
  for (const group of model.groups) {
    const where = `group '${group.id}'`;
    p.id(where, group.id, "element");
    p.label(where, group.label);
    p.oneOf(where, "icon", group.icon, ARCHITECTURE_ICONS);
  }
  p.tree("group", [...parents.keys()], (id) => parents.get(id));
  const groups = new Set(parents.keys());
  for (const service of model.services) {
    const where = `service '${service.id}'`;
    p.id(where, service.id, "element");
    p.label(where, service.label);
    p.oneOf(where, "icon", service.icon, ARCHITECTURE_ICONS);
    p.known(where, "group", service.groupId, groups);
  }
  for (const junction of model.junctions) {
    const where = `junction '${junction.id}'`;
    p.id(where, junction.id, "element");
    p.known(where, "group", junction.groupId, groups);
  }
  const ends = new Set([...model.services.map((s) => s.id), ...model.junctions.map((j) => j.id)]);
  for (const edge of model.edges) {
    const where = `edge '${edge.id}'`;
    p.id(where, edge.id, "edge");
    p.label(where, edge.label);
    p.known(where, "service or junction", edge.source, ends);
    p.known(where, "service or junction", edge.target, ends);
    p.oneOf(where, "side", edge.sourceSide, ARCHITECTURE_SIDES, false);
    p.oneOf(where, "side", edge.targetSide, ARCHITECTURE_SIDES, false);
  }
  return p.list;
}

export function validateJourney(model: UserJourney): string[] {
  const p = new Problems();
  p.label("title", model.title);
  const actors = new Set<string>();
  for (const actor of model.actors) {
    p.label(`actor '${actor}'`, actor);
    if (actors.has(actor)) p.list.push(`actor '${actor}' appears twice`);
    actors.add(actor);
  }
  for (const section of model.sections) {
    const where = `section '${section.id}'`;
    p.id(where, section.id, "element");
    p.label(where, section.label);
    for (const task of section.tasks) {
      const at = `task '${task.id}'`;
      p.id(at, task.id, "element");
      p.label(at, task.label);
      if (!Number.isInteger(task.score) || task.score < MIN_JOURNEY_SCORE || task.score > MAX_JOURNEY_SCORE)
        p.list.push(`${at}: score ${task.score}`);
      for (const actor of task.actors) p.known(at, "actor", actor, actors);
    }
  }
  return p.list;
}
