// The advisory lint (ADR 0036 §9, A6, A7): findings that never refuse a write. Per-diagram rules read
// one compiled model; the model rules read the project model with the written view's occurrences
// replaced by the draft's, so a view's own ids never match themselves. Severity is `info` only for
// a component shared by containers (§4); every other finding is a warning.
import type { DiagramModel } from "../model/envelope.ts";
import type { C4Model } from "../model/c4.ts";
import type { GraphModel } from "../model/graph.ts";
import type { ServiceArchitecture } from "../model/architecture.ts";
import { isGraphModel } from "../model/kinds.ts";
import { nameProfile, nameSimilarity, words, type NameProfile } from "./find.ts";
import { mergeProjectModel, replaceView, type ModelElement, type ModelInputView, type ProjectModel } from "./merge.ts";

export type AdviceCode =
  | "too_many_elements"
  | "description_too_long"
  | "technology_too_long"
  | "technology_is_path"
  | "boundary_too_deep"
  | "code_in_label"
  | "response_arrow"
  | "arrow_from_store"
  | "code_relationship"
  | "step_reuses_element_id"
  | "label_holds_file"
  | "unkinded_node"
  | "possible_duplicate"
  | "element_kind_conflict"
  | "element_parent_conflict";

export interface Advice {
  readonly code: AdviceCode;
  readonly severity: "info" | "warning";
  /** The element (or node, state, task) the finding is about. */
  readonly element?: string;
  /** The relationship (edge, arrow) the finding is about. */
  readonly edge?: string;
  /** possible_duplicate: the element it looks like. */
  readonly other?: string;
  /** One sentence: what to change. */
  readonly fix: string;
}

/** Elements per C4 view before it stops reading at a glance (§9; the 0.7.2 bands). */
export const C4_ELEMENT_BUDGET = { context: 10, container: 15, component: 12 } as const;
const DESCRIPTION_WORDS = 15;
const TECHNOLOGY_WORDS = 5;
const BOUNDARY_LEVELS = 2;
/** A flowchart label longer than this that names a file is a description, not a name (N11). */
const FILE_LABEL_WORDS = 4;
/**
 * possible_duplicate: a name this alike another element's name (trigram similarity), unless the two
 * differ only by a sibling marker ("Agent host A" / "Agent host"). Ids are not compared: on archer's
 * model id matches were mostly noise (prefixes such as app / app_t, meta entities such as MODEL / model).
 */
export const DUPLICATE_SCORE = 0.85;

/** Words, not counting punctuation such as "+" or "&". */
const count = (text: string): number =>
  text
    .trim()
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const quoted = (id: string): string => `'${id}'`;

// A leading ~ / ./ ../, two slashes, dir/File.ext, or a lower-case file name (archer.js, but not Node.js or Vue.js).
const EXT = "(ts|tsx|js|mjs|cjs|py|go|rs|java|kt|rb|md|json|toml|ya?ml|sh|sql)\\b";
const PATH = new RegExp(`^(~|\\.{0,2}/)|[\\w-]/[\\w.-]+/|[\\w-]/[\\w-]+\\.${EXT}|(^|[\\s,(])[a-z0-9_-]+\\.${EXT}`);
const FILE = /(^|[\s(`'"])[\w.-]+\.(ts|tsx|js|mjs|cjs|py|go|rs|java|kt|rb|md|json|toml|ya?ml|sh|css|html|mmd|sql)\b/i;
/** snake_case, lower camelCase, a call `name()`, or a route `/path` (C4 arrow labels, §9). */
const CODE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b\w+\(\)|(^|\s)\/[\w{}:.-]+/;
const RESPONSE = /^\s*(returns?|responds?|replies|reply|response)\b/i;
const CODE_RELATION = /^\s*(implements|extends|inherits)\b/i;

// ------------------------------------------------------------------ per diagram

/** Findings one diagram earns on its own (§9 "Per diagram"), plus the two that need the model's ids. */
export function diagramAdvice(model: DiagramModel, project: ProjectModel | null): Advice[] {
  const out: Advice[] = [];
  if (model.type === "c4-model") c4Advice(model, out);
  else if (isGraphModel(model)) flowchartAdvice(model, project, out);
  else if (model.type === "service-architecture") architectureAdvice(model, out);
  else if (model.type === "state-machine" && project !== null) {
    const elements = new Set(project.elements.map((e) => e.id));
    for (const s of model.states) if (elements.has(s.id)) out.push(stepReuses(s.id, "state"));
  } else if (model.type === "user-journey" && project !== null) {
    const elements = new Set(project.elements.map((e) => e.id));
    for (const section of model.sections)
      for (const t of section.tasks) if (elements.has(t.id)) out.push(stepReuses(t.id, "journey task"));
  }
  return out;
}

const stepReuses = (id: string, what: string): Advice => ({
  code: "step_reuses_element_id",
  severity: "warning",
  element: id,
  fix: `The ${what} ${quoted(id)} reuses an element's id; give it a local id (for example ${quoted(`${id}Step`)}) so it is not read as the element.`,
});

function responseArrows(
  edges: readonly { id: string; source: string; target: string; label?: string | null }[],
  out: Advice[],
): void {
  const pairs = new Set(edges.map((e) => `${e.source}\0${e.target}`));
  for (const e of edges)
    if (e.label != null && RESPONSE.test(e.label) && pairs.has(`${e.target}\0${e.source}`))
      out.push({
        code: "response_arrow",
        severity: "warning",
        edge: e.id,
        fix: `Drop ${quoted(e.id)}: a structure view draws one arrow per interaction, from the element that acts; draw replies in a sequence.`,
      });
}

function codeRelations(edges: readonly { id: string; label?: string | null }[], out: Advice[]): void {
  for (const e of edges)
    if (e.label != null && CODE_RELATION.test(e.label))
      out.push({
        code: "code_relationship",
        severity: "warning",
        edge: e.id,
        fix: `${quoted(e.id)} is a code-level relationship; group the implementations into one component and drop the arrow.`,
      });
}

function c4Advice(model: C4Model, out: Advice[]): void {
  const budget = C4_ELEMENT_BUDGET[model.level];
  if (model.elements.length > budget)
    out.push({
      code: "too_many_elements",
      severity: "warning",
      fix: `This ${model.level} view draws ${model.elements.length} elements, more than ${budget}; group or split it so it reads at a glance.`,
    });
  const technology = (id: string, tech: string | null | undefined, edge: boolean): void => {
    if (tech == null || tech.trim() === "") return;
    const at = edge ? { edge: id } : { element: id };
    if (PATH.test(tech.trim()) && !/^[A-Za-z][A-Za-z0-9 +#.-]*\/[A-Za-z0-9 +#.-]+$/.test(tech.trim()))
      out.push({
        code: "technology_is_path",
        severity: "warning",
        ...at,
        fix: `The technology of ${quoted(id)} is a path; name the technology (TypeScript, Postgres) and put the path in the note.`,
      });
    else if (count(tech) > TECHNOLOGY_WORDS)
      out.push({
        code: "technology_too_long",
        severity: "warning",
        ...at,
        fix: `Cut the technology of ${quoted(id)} to ${TECHNOLOGY_WORDS} words or fewer.`,
      });
  };
  for (const e of model.elements) {
    if (e.description != null && count(e.description) > DESCRIPTION_WORDS)
      out.push({
        code: "description_too_long",
        severity: "warning",
        element: e.id,
        fix: `Cut the description of ${quoted(e.id)} to ${DESCRIPTION_WORDS} words or fewer; the rest belongs in the note.`,
      });
    technology(e.id, e.technology, false);
  }
  const parents = new Map(model.boundaries.map((b) => [b.id, b.parentId ?? null]));
  let deepest: { id: string; depth: number } | null = null;
  for (const b of model.boundaries) {
    let depth = 0;
    const seen = new Set<string>();
    for (let at: string | null = b.id; at !== null && !seen.has(at); at = parents.get(at) ?? null) {
      seen.add(at);
      depth++;
    }
    if (depth > BOUNDARY_LEVELS && (deepest === null || depth > deepest.depth)) deepest = { id: b.id, depth };
  }
  if (deepest !== null)
    out.push({
      code: "boundary_too_deep",
      severity: "warning",
      element: deepest.id,
      fix: `Boundaries nest ${deepest.depth} deep at ${quoted(deepest.id)}; keep to ${BOUNDARY_LEVELS} levels and show the inside in a view of its own.`,
    });
  for (const r of model.relationships) {
    if (r.label != null && CODE.test(r.label))
      out.push({
        code: "code_in_label",
        severity: "warning",
        edge: r.id,
        fix: `The label of ${quoted(r.id)} names code or a route; say what it does in plain words, and put the identifier in the technology or the note.`,
      });
    technology(r.id, r.technology, true);
  }
  responseArrows(model.relationships, out);
  const stores = new Set(model.elements.filter((e) => e.shape === "database" || e.shape === "queue").map((e) => e.id));
  for (const r of model.relationships)
    if (stores.has(r.source) && r.bidirectional !== true) out.push(fromStore(r.id, r.source, r.target));
  codeRelations(model.relationships, out);
}

const fromStore = (edge: string, store: string, other: string): Advice => ({
  code: "arrow_from_store",
  severity: "warning",
  edge,
  fix: `A data store never starts a relationship: draw ${quoted(edge)} from ${quoted(other)} to ${quoted(store)} ("Reads from").`,
});

function flowchartAdvice(model: GraphModel, project: ProjectModel | null, out: Advice[]): void {
  responseArrows(model.edges, out);
  codeRelations(model.edges, out);
  // N2 is not checked here: a flowchart arrow is flow (data leaving a store, the next step), not who acts.
  for (const n of model.nodes)
    if (FILE.test(n.label) && count(n.label) > FILE_LABEL_WORDS)
      out.push({
        code: "label_holds_file",
        severity: "warning",
        element: n.id,
        fix: `The label of ${quoted(n.id)} holds a file name and a description; label it with a name and put the file and detail in the note.`,
      });
  if (project === null) return;
  const byId = new Map(project.elements.map((e) => [e.id, e]));
  const byName = new Map<string, string>();
  for (const e of project.elements) {
    const key = words(e.name).join(" ");
    if (key !== "" && !byName.has(key)) byName.set(key, e.id);
  }
  const kinded = (classes: readonly string[] | undefined): boolean =>
    (classes ?? []).some(
      (c) => c === "person" || c === "system" || c === "container" || c === "component" || c === "database",
    );
  for (const n of model.nodes) {
    if (kinded(n.classes)) continue;
    const element = byId.get(n.id);
    if (element !== undefined) {
      // A decision reuses the id (N5). A box may be the element unkinded or a step under its id: say both.
      if (n.shape === "diamond") out.push(stepReuses(n.id, "decision"));
      else
        out.push({
          code: "unkinded_node",
          severity: "warning",
          element: n.id,
          fix: `${quoted(n.id)} has the id of the element ${quoted(n.id)} (${element.name}); if it is that element, give it a kind class (${kindHint(element.kinds.map((r) => r.value))}) so it joins; if it is a step, give it a local id.`,
        });
      continue;
    }
    const named = byName.get(words(n.label).join(" "));
    if (named !== undefined)
      out.push({
        code: "unkinded_node",
        severity: "warning",
        element: n.id,
        fix: `${quoted(n.id)} looks like the element ${quoted(named)}; use the id ${quoted(named)} and a kind class so it joins.`,
      });
  }
}

const kindHint = (kinds: readonly string[]): string =>
  kinds.length === 0 ? "person, system, container, component or database" : kinds.join(" or ");

function architectureAdvice(model: ServiceArchitecture, out: Advice[]): void {
  const stores = new Set(model.services.filter((s) => s.icon === "database" || s.icon === "disk").map((s) => s.id));
  for (const e of model.edges) {
    // Only an arrow that starts at the store: one arrowhead, at the far end.
    if (stores.has(e.source) && e.targetArrow === true && e.sourceArrow !== true)
      out.push(fromStore(e.id, e.source, e.target));
    else if (stores.has(e.target) && e.sourceArrow === true && e.targetArrow !== true)
      out.push(fromStore(e.id, e.target, e.source));
  }
  responseArrows(model.edges, out);
  codeRelations(model.edges, out);
}

// ------------------------------------------------------------------ against the model

/**
 * Advice on writing `draft` as the view `previousId` (the same id unless an embedded rename moves
 * it). Only findings about the draft: its own rules, the conflicts it takes part in, and new ids
 * that look like an existing element (A6).
 */
export function draftAdvice(
  model: ProjectModel,
  previousId: string,
  draft: ModelInputView,
  previous?: ReadonlySet<string>,
): Advice[] {
  if (draft.envelope === null) return [];
  const next = replaceView(model, previousId, draft);
  const out = diagramAdvice(draft.envelope.model, next);
  for (const e of next.elements)
    for (const c of e.conflicts)
      if (c.views.includes(draft.id))
        out.push({ code: c.code, severity: c.severity, element: e.id, fix: conflictFix(c.code, c.message) });
  // New: not in the view's last-good drawing. Reused: already an element elsewhere, which is the point.
  // `previous` when the caller compiled the source it replaces; else the model's own record of the view.
  const before =
    previous ?? new Set(model.index.flatMap((x) => (x.occurrences.some((o) => o.viewId === previousId) ? [x.id] : [])));
  const base = replaceView(model, previousId, { ...draft, envelope: null });
  const existing = new Set(base.elements.map((e) => e.id));
  const mine = next.index.flatMap((x) => x.occurrences.filter((o) => o.viewId === draft.id));
  const others = base.elements;
  const seen = new Set<string>();
  for (const o of mine) {
    if (seen.has(o.id) || before.has(o.id) || existing.has(o.id)) continue;
    seen.add(o.id);
    const hit = duplicateOf({ id: o.id, names: [o.label] }, others);
    if (hit !== null)
      out.push({
        code: "possible_duplicate",
        severity: "warning",
        element: o.id,
        other: hit.id,
        fix: `${quoted(o.id)} (${o.label}) looks like ${quoted(hit.id)} (${hit.name}); if it is the same thing, use the id ${quoted(hit.id)}.`,
      });
  }
  return out;
}

const SIBLING = /^([a-z]|\d+)$/;

/** Two word lists that differ only by a one-letter or numeric marker: siblings (host A, host B), not one thing. */
function siblings(a: readonly string[], b: readonly string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length === 1) {
    const rest = [...long];
    for (const w of short) {
      const i = rest.indexOf(w);
      if (i < 0) return false;
      rest.splice(i, 1);
    }
    return SIBLING.test(rest[0]!);
  }
  if (long.length !== short.length) return false;
  const differ = short.flatMap((w, i) => (w === long[i] ? [] : [[w, long[i]!] as const]));
  return differ.length === 1 && SIBLING.test(differ[0]![0]) && SIBLING.test(differ[0]![1]);
}

/** A name an element is drawn with, prepared once. */
interface Named extends NameProfile {
  readonly name: string;
}

/** Each name an element is drawn with, prepared once (sequence labels are not names, A3). */
function profilesOf(names: Iterable<string>): Named[] {
  return [...new Set(names)].map((name) => ({ ...nameProfile(name), name })).filter((p) => p.words.length > 0);
}
const elementProfiles = (e: ModelElement): Named[] =>
  profilesOf([e.name, ...e.occurrences.filter((o) => o.weak !== true).map((o) => o.label)]);

/** The best match between two sets of names, with the two names that gave it. */
interface Match {
  readonly score: number;
  readonly names: readonly [string, string];
}

/** How alike two sets of names are: 1 for the same name, else the best similarity. Ids are not compared: case-only variants were different things. */
function match(a: readonly Named[], b: readonly Named[]): Match {
  let best: Match = { score: 0, names: ["", ""] };
  for (const n of a)
    for (const m of b) {
      if (m.key === n.key) return { score: 1, names: [n.name, m.name] };
      if (siblings(n.words, m.words)) continue;
      const score = nameSimilarity(n, m);
      if (score > best.score) best = { score, names: [n.name, m.name] };
    }
  return best;
}
const alike = (a: readonly Named[], b: readonly Named[]): number => match(a, b).score;

/** The ids a view draws, as the model would index them: for "new id" when the model may already hold the write. */
export function drawnIds(view: ModelInputView): Set<string> {
  if (view.envelope === null) return new Set();
  const { status: _status, basedOn: _basedOn, ...plain } = view;
  return new Set(mergeProjectModel([plain]).index.map((e) => e.id));
}

function duplicateOf(
  a: { readonly id: string; readonly names: readonly string[] },
  elements: readonly ModelElement[],
): { id: string; name: string; score: number } | null {
  const mine = profilesOf(a.names);
  let best: { id: string; name: string; score: number } | null = null;
  for (const e of elements) {
    if (e.id === a.id) continue;
    const score = alike(mine, elementProfiles(e));
    if (score >= DUPLICATE_SCORE && (best === null || score > best.score)) best = { id: e.id, name: e.name, score };
  }
  return best;
}

const conflictFix = (code: "element_kind_conflict" | "element_parent_conflict", message: string): string =>
  code === "element_kind_conflict"
    ? `${message}; if they are one thing, draw it as one kind, else give one of them its own id.`
    : `${message}; if they are one thing, draw it inside one parent, else give one of them its own id.`;

// ------------------------------------------------------------------ the project report (A7)

export interface ViewAdvice {
  readonly viewId: string;
  readonly advice: readonly Advice[];
}

export interface ProjectReport {
  /** Findings per view, from its last-good drawing; views with none are left out. */
  readonly views: readonly ViewAdvice[];
  /** Model findings, once each: conflicts, and element pairs that look like one thing. */
  readonly model: readonly Advice[];
  readonly total: number;
}

export function projectReport(model: ProjectModel, inputs: readonly ModelInputView[]): ProjectReport {
  const views: ViewAdvice[] = [];
  for (const v of inputs) {
    if (v.envelope === null) continue;
    const advice = diagramAdvice(v.envelope.model, model);
    if (advice.length > 0) views.push({ viewId: v.id, advice });
  }
  const findings: Advice[] = [];
  for (const e of model.elements)
    for (const c of e.conflicts)
      findings.push({ code: c.code, severity: c.severity, element: e.id, fix: conflictFix(c.code, c.message) });
  for (const { a, b } of similarPairs(model))
    findings.push({
      code: "possible_duplicate",
      severity: "warning",
      element: a.id,
      other: b.id,
      fix: `${quoted(a.id)} (${a.name}) and ${quoted(b.id)} (${b.name}) look like one thing; if they are, use one id in every view.`,
    });
  return { views, model: findings, total: views.reduce((n, v) => n + v.advice.length, 0) + findings.length };
}

/** Two elements that look like one thing (A22): `a.id < b.id`; `labels[0]` is a's name that matched `labels[1]`, b's. */
export interface SimilarPair {
  readonly a: ModelElement;
  readonly b: ModelElement;
  readonly score: number;
  readonly labels: readonly [string, string];
}

/** What a scan may score, and what it did: `scored` counts the pairs compared; past `limit` it stops and sets `exhausted`. */
export interface ScanBudget {
  scored: number;
  readonly limit?: number;
  exhausted?: true;
}

/** Each element's names, prepared once per model (the model is immutable once merged). */
const profileCache = new WeakMap<readonly ModelElement[], Named[][]>();
function profilesFor(elements: readonly ModelElement[]): Named[][] {
  let known = profileCache.get(elements);
  if (known === undefined) profileCache.set(elements, (known = elements.map(elementProfiles)));
  return known;
}

/**
 * The element pairs that look like one thing, each once. With `touching`, only the pairs with at least
 * one of those ids, enumerated as touching × population (k × n, not every pair filtered: the project
 * report's scan is the quadratic one), less the ids in `scanned`, already compared with everyone.
 * With `budget`, it stops after `limit` pairs scored.
 */
export function similarPairs(
  model: ProjectModel,
  touching?: ReadonlySet<string>,
  budget?: ScanBudget,
  scanned?: ReadonlySet<string>,
): SimilarPair[] {
  const elements = model.elements;
  const profiles = profilesFor(elements);
  const out: SimilarPair[] = [];
  const score = (i: number, j: number): boolean => {
    if (budget !== undefined) {
      if (budget.limit !== undefined && budget.scored >= budget.limit) {
        budget.exhausted = true;
        return false;
      }
      budget.scored++;
    }
    // Similarity is not symmetric (synonyms swap on one side): checked both ways, reported once.
    const there = match(profiles[i]!, profiles[j]!),
      back = match(profiles[j]!, profiles[i]!);
    const best =
      there.score >= back.score ? there : { score: back.score, names: [back.names[1], back.names[0]] as const };
    if (best.score >= DUPLICATE_SCORE) {
      const swap = elements[i]!.id > elements[j]!.id;
      const [a, b] = swap ? [elements[j]!, elements[i]!] : [elements[i]!, elements[j]!];
      out.push({ a, b, score: best.score, labels: swap ? [best.names[1], best.names[0]] : best.names });
    }
    return true;
  };
  if (touching === undefined) {
    for (let i = 0; i < elements.length; i++)
      for (let j = i + 1; j < elements.length; j++) if (!score(i, j)) return out;
    return out;
  }
  const mine: number[] = [];
  // 1: touching; 2: already scanned.
  const mark = new Uint8Array(elements.length);
  for (let i = 0; i < elements.length; i++) {
    const id = elements[i]!.id;
    if (scanned?.has(id) === true) mark[i] = 2;
    else if (touching.has(id)) {
      mine.push(i);
      mark[i] = 1;
    }
  }
  for (const i of mine)
    for (let j = 0; j < elements.length; j++) {
      // Two touching ids are one pair, scored from the first of them; a scanned id met everyone already.
      if (j === i || mark[j] === 2 || (mark[j] === 1 && j < i)) continue;
      if (!score(i, j)) return out;
    }
  return out;
}
