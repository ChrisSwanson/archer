// The project model (ADR 0036 §1–§7, amendments A1–A5): every element and relationship of a
// project, merged from the last-good compiled views of its inventory. Pure: it reads envelopes and
// the inventory's facts (title, path, note `status` / `based-on`) and keeps no state. The service
// rebuilds it whole in its reconcile step; the one-shot CLI and MCP paths build it the same way.
//
// The model keeps every occurrence (one view's drawing of an element) and derives the rest from
// them. Kind and parent are sets of readings; more than one reading is a conflict, kept, never
// resolved by picking one (§4). Proposed views and `based-on:` copies add nothing (§5); proposed
// views stay in the occurrence index Expand reads (A5), flagged.

import type { DiagramEnvelope } from "../model/envelope.ts";
import type { C4Model } from "../model/c4.ts";
import type { GraphModel } from "../model/graph.ts";
import type { ServiceArchitecture } from "../model/architecture.ts";
import type { EntityRelationship } from "../model/er.ts";
import type { SequenceEvent, SequenceTrace } from "../model/sequence.ts";
import { isGraphModel } from "../model/kinds.ts";

export const PROJECT_MODEL_SCHEMA = 1;

/** The kinds an element can have. ER entities are `code` (tables); a flowchart `database` is a container. */
export const ELEMENT_KINDS = ["person", "system", "container", "component", "code"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/** The families that contribute, in name precedence order (§3): the first wins. */
export const FAMILIES = ["c4", "architecture", "flowchart", "er", "sequence"] as const;
export type Family = (typeof FAMILIES)[number];

/** What the merge reads of one inventory view. */
export interface ModelInputView {
  readonly id: string;
  readonly title: string;
  /** Folder-relative source: the `.mmd` file, or the note that embeds the diagram. */
  readonly path: string;
  /** A note's diagram (ADR 0012), else a file. Ties in name precedence go to a file. */
  readonly embedded: boolean;
  /** The embedding note's front matter `status`, when it has one. */
  readonly status?: string;
  /** The embedding note's front matter `based-on`, when it has one: an elaborated copy. */
  readonly basedOn?: string;
  /** The last envelope the view compiled to; null when it never compiled. */
  readonly envelope: DiagramEnvelope | null;
}

/** One view's drawing of an element. */
export interface Occurrence {
  readonly viewId: string;
  /** The element's id, which is also its id in the view (ids are project-wide, §2). */
  readonly id: string;
  readonly family: Family;
  readonly label: string;
  readonly kind?: ElementKind;
  /** The nearest enclosing element in this view; frames are passed through. */
  readonly parent?: string;
  readonly external?: true;
  readonly technology?: string;
  readonly shape?: string;
  /** Drawn open: a C4 boundary, or a flowchart subgraph whose id is an element. Else drawn as a box. */
  readonly opens?: true;
  /** A sequence participant: adds "drawn in" only, never a kind, a parent or the name (A3). */
  readonly weak?: true;
}

export interface Reading<T> {
  readonly value: T;
  /** The views that give this reading, sorted. */
  readonly views: readonly string[];
}

export type ConflictCode = "element_kind_conflict" | "element_parent_conflict";

export interface Conflict {
  readonly code: ConflictCode;
  /** `info` only for a component shared by containers (§4); every other conflict is a warning. */
  readonly severity: "info" | "warning";
  readonly views: readonly string[];
  readonly message: string;
}

export interface ModelElement {
  readonly id: string;
  /** From the highest-precedence occurrence (§3). */
  readonly name: string;
  readonly kinds: readonly Reading<ElementKind>[];
  readonly parents: readonly Reading<string>[];
  /** Ancestors, outermost first: only when there is exactly one acyclic reading all the way up (A3). */
  readonly path?: readonly string[];
  /** The highest-precedence occurrence's values (A3); a difference is never a finding. */
  readonly external?: true;
  readonly technology?: string;
  readonly shape?: string;
  /** Views that draw it as a box. */
  readonly drawnIn: readonly string[];
  /** Views that open it as a boundary or frame. */
  readonly opensIn: readonly string[];
  readonly occurrences: readonly Occurrence[];
  readonly conflicts: readonly Conflict[];
}

/**
 * How one drawing of a relationship reads (A4): `forward` from → to as written, `reverse` an arrow
 * only at the written source, `two-way` an arrowhead at each end, `undirected` no arrowhead at all.
 */
export type RelationshipDirection = "forward" | "reverse" | "two-way" | "undirected";

export interface RelationshipOccurrence {
  readonly viewId: string;
  readonly family: Family;
  /** The edge, relationship or message id in that view. */
  readonly id: string;
  /** The ends as written. */
  readonly source: string;
  readonly target: string;
  readonly direction: RelationshipDirection;
  readonly label?: string;
  readonly technology?: string;
  /** ER only: the marker at each written end. */
  readonly cardinality?: { readonly source: string; readonly target: string };
}

/** Every drawing of one ordered pair (§6). */
export interface ModelRelationship {
  readonly from: string;
  readonly to: string;
  readonly drawnIn: readonly string[];
  readonly occurrences: readonly RelationshipOccurrence[];
}

export interface ModelViewFact {
  readonly id: string;
  readonly family?: Family;
  /** A note's diagram: a file wins name precedence ties (§3). */
  readonly embedded?: true;
  /** Marked proposed by its title or its note's `status: proposed` or `proposal` (§5, A16). */
  readonly proposed?: true;
  /** An elaborated copy (`based-on:` front matter). */
  readonly basedOn?: string;
  /** No last-good envelope: it never compiled. */
  readonly uncompiled?: true;
  /** Whether it adds to the model. */
  readonly contributes: boolean;
}

/** One element id's occurrences in every view but copies, proposed views included and flagged (A5). */
export interface IndexEntry {
  readonly id: string;
  readonly occurrences: readonly (Occurrence & { readonly proposed?: true })[];
}

/**
 * A flowchart's drawing before its subgraphs join. Whether a subgraph joins depends on every other
 * view (§1, A18), so the model keeps this to redo the join when a draft replaces a view (A6).
 */
export interface FlowchartFacts {
  readonly viewId: string;
  /** Its kinded nodes, with no parent, and the subgraph each is drawn in. */
  readonly nodes: readonly { readonly occurrence: Occurrence; readonly group?: string }[];
  readonly groups: readonly { readonly id: string; readonly label: string; readonly parent?: string }[];
  /** Edges that join when both ends do: each end a kinded node, or a subgraph that is no node. As written. */
  readonly edges: readonly RelationshipOccurrence[];
}

export interface ProjectModel {
  readonly schemaVersion: typeof PROJECT_MODEL_SCHEMA;
  /** Sorted by id. */
  readonly elements: readonly ModelElement[];
  /** Sorted by (from, to). */
  readonly relationships: readonly ModelRelationship[];
  /** In inventory order. */
  readonly views: readonly ModelViewFact[];
  /** What Expand reads besides the model (A5). Sorted by id. */
  readonly index: readonly IndexEntry[];
  /** The flowcharts of the indexed views (the model's and proposed ones), before their subgraphs join. Sorted by view id. */
  readonly flowcharts: readonly FlowchartFacts[];
}

const PROPOSED_TITLE = /\(proposed\)/i;

/** The model's own family for a compiled model; null for state and journey, which add nothing. */
function familyOf(envelope: DiagramEnvelope): Family | null {
  const model = envelope.model;
  if (isGraphModel(model)) return "flowchart";
  switch (model.type) {
    case "c4-model":
      return "c4";
    case "service-architecture":
      return "architecture";
    case "entity-relationship":
      return "er";
    case "sequence-trace":
      return "sequence";
    default:
      return null;
  }
}

function isProposed(view: ModelInputView): boolean {
  // `status: proposal` reads the same (A16): archer's own notes use both words.
  const status = view.status?.trim().toLowerCase();
  if (status === "proposed" || status === "proposal") return true;
  if (PROPOSED_TITLE.test(view.title)) return true;
  const model = view.envelope?.model;
  const own = model !== undefined && "title" in model ? model.title : null;
  return typeof own === "string" && PROPOSED_TITLE.test(own);
}

const text = (value: string | null | undefined): string | undefined =>
  value == null || value === "" ? undefined : value;

// ------------------------------------------------------------------ occurrences, per family

interface Drawn {
  readonly occurrences: Occurrence[];
  readonly relationships: RelationshipOccurrence[];
}

const FLOWCHART_KINDS: Readonly<Record<string, ElementKind>> = {
  person: "person",
  system: "system",
  container: "container",
  component: "component",
  database: "container",
};

function c4(viewId: string, model: C4Model): Drawn {
  const boundaries = new Map(model.boundaries.map((b) => [b.id, b]));
  // Enterprise and generic boundaries are frames, not elements (A3): the walk passes through them.
  const isElementBoundary = (id: string): boolean => {
    const kind = boundaries.get(id)?.kind;
    return kind === "system" || kind === "container";
  };
  const parentOf = (start: string | null | undefined): string | undefined => {
    const seen = new Set<string>();
    for (
      let at = start ?? undefined;
      at !== undefined && !seen.has(at);
      at = boundaries.get(at)?.parentId ?? undefined
    ) {
      seen.add(at);
      if (isElementBoundary(at)) return at;
    }
    return undefined;
  };
  const occurrences: Occurrence[] = [];
  for (const b of model.boundaries) {
    if (!isElementBoundary(b.id)) continue;
    const parent = parentOf(b.parentId);
    occurrences.push({
      viewId,
      id: b.id,
      family: "c4",
      label: b.label,
      kind: b.kind as ElementKind,
      ...(parent === undefined ? {} : { parent }),
      opens: true,
    });
  }
  for (const e of model.elements) {
    const parent = parentOf(e.boundaryId);
    const technology = text(e.technology);
    occurrences.push({
      viewId,
      id: e.id,
      family: "c4",
      label: e.label,
      kind: e.kind,
      ...(parent === undefined ? {} : { parent }),
      ...(e.external === true ? { external: true as const } : {}),
      ...(technology === undefined ? {} : { technology }),
      ...(e.shape === undefined ? {} : { shape: e.shape }),
    });
  }
  const joined = new Set(occurrences.map((o) => o.id));
  const relationships: RelationshipOccurrence[] = [];
  for (const r of model.relationships) {
    if (!joined.has(r.source) || !joined.has(r.target)) continue;
    const label = text(r.label),
      technology = text(r.technology);
    relationships.push({
      viewId,
      family: "c4",
      id: r.id,
      source: r.source,
      target: r.target,
      direction: r.bidirectional === true ? "two-way" : "forward",
      ...(label === undefined ? {} : { label }),
      ...(technology === undefined ? {} : { technology }),
    });
  }
  return { occurrences, relationships };
}

/** A flowchart's kinded nodes; its subgraphs join later, only when their id is an element elsewhere (§1). */
function flowchartNodes(viewId: string, model: GraphModel): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const node of model.nodes) {
    // A node has at most one kind or category; `external` alone is a flag on no kind, so it does not join (A3).
    const kind = (node.classes ?? []).map((c) => FLOWCHART_KINDS[c]).find((k) => k !== undefined);
    if (kind === undefined) continue;
    const database = node.classes?.includes("database") === true;
    occurrences.push({
      viewId,
      id: node.id,
      family: "flowchart",
      label: node.label,
      kind,
      ...(database ? { shape: "database" } : {}),
    });
  }
  return occurrences;
}

function flowchartFacts(viewId: string, model: GraphModel): FlowchartFacts {
  const groupOf = new Map(model.nodes.map((n) => [n.id, n.groupId ?? undefined]));
  const kinded = flowchartNodes(viewId, model);
  const kindedIds = new Set(kinded.map((o) => o.id));
  const groupIds = new Set(model.groups.map((g) => g.id));
  // An end can join as a kinded node, or as a subgraph that is no node (and then only once it is an element).
  const canJoin = (id: string): boolean => kindedIds.has(id) || (!groupOf.has(id) && groupIds.has(id));
  const edges: RelationshipOccurrence[] = [];
  for (const e of model.edges) {
    if (!canJoin(e.source) || !canJoin(e.target)) continue;
    const label = text(e.label);
    edges.push({
      viewId,
      family: "flowchart",
      id: e.id,
      source: e.source,
      target: e.target,
      direction: e.bidirectional === true ? "two-way" : "forward",
      ...(label === undefined ? {} : { label }),
    });
  }
  return {
    viewId,
    nodes: kinded.map((occurrence) => {
      const group = groupOf.get(occurrence.id);
      return group === undefined ? { occurrence } : { occurrence, group };
    }),
    groups: model.groups.map((g) =>
      g.parentId == null ? { id: g.id, label: g.label } : { id: g.id, label: g.label, parent: g.parentId },
    ),
    edges,
  };
}

/** A flowchart's drawing once its subgraphs whose id is in `elementIds` join (§1, A17, A18). */
function joinFlowchart(facts: FlowchartFacts, elementIds: ReadonlySet<string>): Drawn {
  const { viewId } = facts;
  const groups = new Map(facts.groups.map((g) => [g.id, g]));
  const parentOf = (start: string | undefined): string | undefined => {
    const seen = new Set<string>();
    for (let at = start; at !== undefined && !seen.has(at); at = groups.get(at)?.parent) {
      seen.add(at);
      if (elementIds.has(at)) return at;
    }
    return undefined;
  };
  const occurrences: Occurrence[] = [];
  const joined = new Set<string>();
  for (const g of facts.groups) {
    if (!elementIds.has(g.id)) continue;
    joined.add(g.id);
    const parent = parentOf(g.parent);
    occurrences.push({
      viewId,
      id: g.id,
      family: "flowchart",
      label: g.label,
      ...(parent === undefined ? {} : { parent }),
      opens: true,
    });
  }
  for (const { occurrence, group } of facts.nodes) {
    joined.add(occurrence.id);
    const parent = parentOf(group);
    occurrences.push(parent === undefined ? occurrence : { ...occurrence, parent });
  }
  // An edge joins when both its ends do: a kinded node, or a subgraph that is an element.
  const relationships = facts.edges.filter((e) => joined.has(e.source) && joined.has(e.target));
  return { occurrences, relationships };
}

function architecture(viewId: string, model: ServiceArchitecture): Drawn {
  // Services join with no kind, never inferred from the icon; a group is runs on, never part of (§1, A3).
  const occurrences: Occurrence[] = model.services.map((s) => ({
    viewId,
    id: s.id,
    family: "architecture",
    label: s.label,
  }));
  const services = new Set(model.services.map((s) => s.id));
  const relationships: RelationshipOccurrence[] = [];
  for (const e of model.edges) {
    if (!services.has(e.source) || !services.has(e.target)) continue;
    const at = { source: e.sourceArrow === true, target: e.targetArrow === true };
    const direction: RelationshipDirection =
      at.source && at.target ? "two-way" : at.target ? "forward" : at.source ? "reverse" : "undirected";
    const label = text(e.label);
    relationships.push({
      viewId,
      family: "architecture",
      id: e.id,
      source: e.source,
      target: e.target,
      direction,
      ...(label === undefined ? {} : { label }),
    });
  }
  return { occurrences, relationships };
}

function er(viewId: string, model: EntityRelationship): Drawn {
  const occurrences: Occurrence[] = model.entities.map((e) => ({
    viewId,
    id: e.id,
    family: "er",
    label: e.label,
    kind: "code",
  }));
  const relationships: RelationshipOccurrence[] = model.relationships.map((r) => {
    const label = text(r.label);
    return {
      viewId,
      family: "er",
      id: r.id,
      source: r.source,
      target: r.target,
      direction: "undirected",
      ...(label === undefined ? {} : { label }),
      cardinality: { source: r.sourceCardinality, target: r.targetCardinality },
    };
  });
  return { occurrences, relationships };
}

function sequence(viewId: string, model: SequenceTrace): Drawn {
  const occurrences: Occurrence[] = model.participants.map((p) => ({
    viewId,
    id: p.id,
    family: "sequence",
    label: p.label,
    weak: true,
  }));
  const relationships: RelationshipOccurrence[] = [];
  // Messages add a (from, to) pair, without labels (§1); fragments nest.
  const walk = (events: readonly SequenceEvent[]): void => {
    for (const event of events) {
      if (event.type === "message")
        relationships.push({
          viewId,
          family: "sequence",
          id: event.id,
          source: event.from,
          target: event.to,
          direction: event.bidirectional === true ? "two-way" : "forward",
        });
      else if (event.type === "fragment") for (const section of event.sections) walk(section.events);
    }
  };
  walk(model.events);
  return { occurrences, relationships };
}

// ------------------------------------------------------------------ the merge

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(byString);

/** Name precedence (§3): family, then a file over a note, then view id. */
function precedence(
  views: ReadonlyMap<string, { readonly embedded?: boolean }>,
): (a: Occurrence, b: Occurrence) => number {
  return (a, b) => {
    const family = FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family);
    if (family !== 0) return family;
    const note = Number(views.get(a.viewId)?.embedded === true) - Number(views.get(b.viewId)?.embedded === true);
    if (note !== 0) return note;
    const view = byString(a.viewId, b.viewId);
    if (view !== 0) return view;
    // One view may draw an id twice (a flowchart node beside a subgraph of the same id): the box first.
    return Number(a.opens === true) - Number(b.opens === true);
  };
}

function readings<T extends string>(pairs: readonly (readonly [T, string])[]): Reading<T>[] {
  const views = new Map<T, Set<string>>();
  for (const [value, view] of pairs) views.set(value, (views.get(value) ?? new Set()).add(view));
  return [...views]
    .map(([value, set]) => ({ value, views: sortedUnique(set) }))
    .sort((a, b) => byString(a.value, b.value));
}

/** What the merge reads of `views`: equal signatures merge to equal models, so a rebuild can be skipped. */
export function modelSignature(views: readonly ModelInputView[]): string {
  return JSON.stringify(
    views.map((v) => [
      v.id,
      v.title,
      v.path,
      v.embedded,
      v.status ?? null,
      v.basedOn ?? null,
      v.envelope?.revision ?? null,
      v.envelope?.view.kind ?? null,
    ]),
  );
}

/** Merges `views` into the project model. Deterministic: the same inputs give the same model. */
export function mergeProjectModel(views: readonly ModelInputView[]): ProjectModel {
  const facts = views.map(factOf);
  const parts: Parts = { occurrences: new Map(), flowcharts: [], pairs: [], relationships: [] };
  views.forEach((view, i) => addView(parts, facts[i]!, view));
  return build(facts, parts);
}

/**
 * The model with `oldViewId` replaced by `draft` (ADR 0036 A6): what the project would be if the
 * draft were written, equal to merging the inventory with the draft in the old view's place. Other
 * views' own drawings are kept; every flowchart's subgraphs join again, since that depends on the draft.
 */
export function replaceView(model: ProjectModel, oldViewId: string, draft: ModelInputView): ProjectModel {
  const fact = factOf(draft);
  const keep = (viewId: string): boolean => viewId !== oldViewId && viewId !== draft.id;
  const at = model.views.findIndex((v) => v.id === oldViewId);
  const facts = model.views.filter((v) => keep(v.id) || v.id === oldViewId).map((v) => (v.id === oldViewId ? fact : v));
  if (at < 0) facts.push(fact);
  const byId = new Map(facts.map((v) => [v.id, v]));
  const flowchartView = (viewId: string): boolean => byId.get(viewId)?.family === "flowchart";
  // Other views' occurrences as each drew them: every indexed one is in the index, flagged when proposed.
  const occurrences = new Map<string, Occurrence[]>();
  for (const entry of model.index)
    for (const indexed of entry.occurrences) {
      if (!keep(indexed.viewId) || flowchartView(indexed.viewId)) continue;
      const { proposed: _proposed, ...o } = indexed;
      const list = occurrences.get(o.viewId);
      if (list === undefined) occurrences.set(o.viewId, [o]);
      else list.push(o);
    }
  const pairs: ModelRelationship[] = [];
  for (const r of model.relationships) {
    const kept = r.occurrences.filter((o) => keep(o.viewId) && !flowchartView(o.viewId));
    if (kept.length > 0) pairs.push({ ...r, occurrences: kept });
  }
  const parts: Parts = {
    occurrences,
    flowcharts: model.flowcharts.filter((f) => keep(f.viewId)),
    pairs,
    relationships: [],
  };
  addView(parts, fact, draft);
  return build(facts, parts);
}

/** What the model is built from: each view's own drawing, before flowchart subgraphs join. */
interface Parts {
  /** Every indexed view but flowcharts: its occurrences, by view id. */
  readonly occurrences: Map<string, Occurrence[]>;
  /** Every indexed flowchart. */
  readonly flowcharts: FlowchartFacts[];
  /** Contributing views' relationships but flowcharts', already paired. */
  readonly pairs: ModelRelationship[];
  /** Contributing views' relationships but flowcharts', not yet paired. */
  readonly relationships: RelationshipOccurrence[];
}

function addView(parts: Parts, fact: ModelViewFact, view: ModelInputView): void {
  if (fact.family === undefined || fact.basedOn !== undefined) return;
  const model = view.envelope!.model;
  let drawn: Drawn;
  switch (fact.family) {
    case "c4":
      drawn = c4(view.id, model as C4Model);
      break;
    case "architecture":
      drawn = architecture(view.id, model as ServiceArchitecture);
      break;
    case "er":
      drawn = er(view.id, model as EntityRelationship);
      break;
    case "sequence":
      drawn = sequence(view.id, model as SequenceTrace);
      break;
    case "flowchart":
      parts.flowcharts.push(flowchartFacts(view.id, model as GraphModel));
      return;
  }
  parts.occurrences.set(view.id, drawn.occurrences);
  if (fact.contributes) parts.relationships.push(...drawn.relationships);
}

/**
 * The model from its parts. Two populations (§5, A5): the model's views, and the index's (the
 * model's and proposed ones). A flowchart subgraph joins when its id is an element of its own
 * population, so a proposed view never promotes one into the model (§1, A18).
 */
function build(facts: readonly ModelViewFact[], parts: Parts): ProjectModel {
  const byId = new Map(facts.map((v) => [v.id, v]));
  const contributes = (viewId: string): boolean => byId.get(viewId)?.contributes === true;
  const proposed = (viewId: string): boolean => byId.get(viewId)?.proposed === true;
  const modelIds = new Set<string>(),
    indexIds = new Set<string>();
  const note = (viewId: string, id: string): void => {
    indexIds.add(id);
    if (contributes(viewId)) modelIds.add(id);
  };
  for (const [viewId, list] of parts.occurrences) for (const o of list) note(viewId, o.id);
  for (const f of parts.flowcharts) for (const n of f.nodes) note(f.viewId, n.occurrence.id);
  // With no proposed element the index joins what the model joined.
  const same = modelIds.size === indexIds.size;
  const flag = (viewId: string, list: readonly Occurrence[]): readonly (Occurrence & { proposed?: true })[] =>
    proposed(viewId) ? list.map((o) => ({ ...o, proposed: true as const })) : list;
  const occurrences: Occurrence[] = [];
  const relationships = [...parts.relationships];
  const index: (Occurrence & { proposed?: true })[] = [];
  for (const [viewId, list] of parts.occurrences) {
    if (contributes(viewId)) occurrences.push(...list);
    index.push(...flag(viewId, list));
  }
  const flowcharts = [...parts.flowcharts].sort((a, b) => byString(a.viewId, b.viewId));
  for (const f of flowcharts) {
    const drawn = contributes(f.viewId) ? joinFlowchart(f, modelIds) : null;
    if (drawn !== null) {
      occurrences.push(...drawn.occurrences);
      relationships.push(...drawn.relationships);
    }
    index.push(...flag(f.viewId, (drawn !== null && same ? drawn : joinFlowchart(f, indexIds)).occurrences));
  }
  return assemble(facts, occurrences, parts.pairs, relationships, index, flowcharts);
}

function factOf(view: ModelInputView): ModelViewFact {
  const family = view.envelope === null ? null : familyOf(view.envelope);
  const proposed = view.envelope !== null && isProposed(view);
  const basedOn = text(view.basedOn);
  return {
    id: view.id,
    ...(family === null ? {} : { family }),
    ...(view.embedded ? { embedded: true as const } : {}),
    ...(proposed ? { proposed: true as const } : {}),
    ...(basedOn === undefined ? {} : { basedOn }),
    ...(view.envelope === null ? { uncompiled: true as const } : {}),
    contributes: family !== null && !proposed && basedOn === undefined,
  };
}

/** Elements, readings, conflicts and pairs from occurrences; `seedPairs` are pairs already made, of other views. */
function assemble(
  facts: readonly ModelViewFact[],
  allOccurrences: readonly Occurrence[],
  seedPairs: readonly ModelRelationship[],
  relationshipOccurrences: readonly RelationshipOccurrence[],
  indexOccurrences: readonly (Occurrence & { proposed?: true })[],
  flowcharts: readonly FlowchartFacts[],
): ProjectModel {
  const byId = new Map(facts.map((v) => [v.id, v]));
  const occurrencesById = new Map<string, Occurrence[]>();
  for (const o of allOccurrences) {
    const list = occurrencesById.get(o.id);
    if (list === undefined) occurrencesById.set(o.id, [o]);
    else list.push(o);
  }
  const order = precedence(byId);
  const partial = new Map<
    string,
    {
      id: string;
      name: string;
      kinds: Reading<ElementKind>[];
      parents: Reading<string>[];
      first: Occurrence;
      occurrences: Occurrence[];
    }
  >();
  for (const [id, list] of occurrencesById) {
    const ranked = [...list].sort(order);
    const first = ranked[0]!;
    const strong = list.filter((o) => o.weak !== true);
    partial.set(id, {
      id,
      name: first.label,
      kinds: readings(strong.flatMap((o) => (o.kind === undefined ? [] : [[o.kind, o.viewId] as const]))),
      parents: readings(strong.flatMap((o) => (o.parent === undefined ? [] : [[o.parent, o.viewId] as const]))),
      first,
      occurrences: ranked,
    });
  }

  /** Whether following parent readings up from `id` comes back to it: a cross-view cycle, or a self-parent. */
  const cyclic = (id: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(partial.get(id)?.parents ?? []).map((r) => r.value)];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (at === id) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const r of partial.get(at)?.parents ?? []) stack.push(r.value);
    }
    return false;
  };
  const pathOf = (id: string): string[] | undefined => {
    const path: string[] = [];
    const seen = new Set([id]);
    for (let at = partial.get(id); at !== undefined; ) {
      if (at.parents.length === 0) return path;
      if (at.parents.length > 1) return undefined;
      const up = at.parents[0]!.value;
      if (seen.has(up)) return undefined;
      seen.add(up);
      path.unshift(up);
      at = partial.get(up);
    }
    return path;
  };
  const onlyKind = (id: string, kind: ElementKind): boolean => {
    const kinds = partial.get(id)?.kinds ?? [];
    return kinds.length === 1 && kinds[0]!.value === kind;
  };
  const viewsOf = (list: readonly Reading<string>[]): string[] => sortedUnique(list.flatMap((r) => r.views));

  const elements: ModelElement[] = [];
  for (const id of [...partial.keys()].sort(byString)) {
    const p = partial.get(id)!;
    const conflicts: Conflict[] = [];
    if (p.kinds.length > 1)
      conflicts.push({
        code: "element_kind_conflict",
        severity: "warning",
        views: viewsOf(p.kinds),
        message: `'${id}' is ${p.kinds.map((r) => `a ${r.value} in ${r.views.join(", ")}`).join(" and ")}`,
      });
    const loops = cyclic(id);
    if (p.parents.length > 1 || loops) {
      const self = p.parents.some((r) => r.value === id);
      const shared = !loops && onlyKind(id, "component") && p.parents.every((r) => onlyKind(r.value, "container"));
      const said = p.parents.map((r) => `${r.value} in ${r.views.join(", ")}`).join(" and ");
      conflicts.push({
        code: "element_parent_conflict",
        severity: shared ? "info" : "warning",
        views: viewsOf(p.parents),
        message: self
          ? `'${id}' is drawn inside itself (${said})`
          : loops
            ? `'${id}' is inside its own part across views (${said})`
            : shared
              ? `'${id}' is shared by ${p.parents.map((r) => r.value).join(" and ")}: fine if one codebase`
              : `'${id}' is part of ${said}`,
      });
    }
    const path = pathOf(id);
    const first = p.first;
    const drawnIn = sortedUnique(p.occurrences.filter((o) => o.opens !== true).map((o) => o.viewId));
    const opensIn = sortedUnique(p.occurrences.filter((o) => o.opens === true).map((o) => o.viewId));
    elements.push({
      id,
      name: p.name,
      kinds: p.kinds,
      parents: p.parents,
      ...(path === undefined ? {} : { path }),
      ...(first.external === true ? { external: true as const } : {}),
      ...(first.technology === undefined ? {} : { technology: first.technology }),
      ...(first.shape === undefined ? {} : { shape: first.shape }),
      drawnIn,
      opensIn,
      occurrences: p.occurrences,
      conflicts,
    });
  }

  // Relationships keyed by the ordered pair (§6, A4): two-way and undirected drawings count both ways.
  const pairs = new Map<string, { from: string; to: string; occurrences: RelationshipOccurrence[] }>();
  for (const p of seedPairs)
    pairs.set(`${p.from}\0${p.to}`, { from: p.from, to: p.to, occurrences: [...p.occurrences] });
  for (const r of relationshipOccurrences) {
    const ends: (readonly [string, string])[] =
      r.direction === "forward"
        ? [[r.source, r.target]]
        : r.direction === "reverse"
          ? [[r.target, r.source]]
          : [
              [r.source, r.target],
              [r.target, r.source],
            ];
    const keys = new Set<string>();
    for (const [from, to] of ends) {
      const key = `${from}\0${to}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const entry = pairs.get(key) ?? { from, to, occurrences: [] };
      entry.occurrences.push(r);
      pairs.set(key, entry);
    }
  }
  // Drawings in name precedence order of their views; within a view, as written.
  const viewOrder = (a: RelationshipOccurrence, b: RelationshipOccurrence): number =>
    FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family) ||
    Number(byId.get(a.viewId)?.embedded === true) - Number(byId.get(b.viewId)?.embedded === true) ||
    byString(a.viewId, b.viewId);
  const relationships: ModelRelationship[] = [...pairs.values()]
    .sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to))
    .map((p) => ({
      from: p.from,
      to: p.to,
      drawnIn: sortedUnique(p.occurrences.map((o) => o.viewId)),
      occurrences: [...p.occurrences].sort(viewOrder),
    }));

  // The occurrence index: the model's own views and proposed ones, flagged (A5); copies stay out (O11).
  const indexById = new Map<string, (Occurrence & { proposed?: true })[]>();
  for (const o of indexOccurrences) {
    const list = indexById.get(o.id);
    if (list === undefined) indexById.set(o.id, [o]);
    else list.push(o);
  }
  const index: IndexEntry[] = [...indexById.keys()]
    .sort(byString)
    .map((id) => ({ id, occurrences: [...indexById.get(id)!].sort(order) }));

  return {
    schemaVersion: PROJECT_MODEL_SCHEMA,
    elements,
    relationships,
    views: [...facts],
    index,
    flowcharts: [...flowcharts],
  };
}
