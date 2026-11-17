// find_elements' matching (ADR 0036 §8): trigram similarity over an element's id, every label it
// carries and its C4 technology, with a short built-in synonym list; a query under 3 characters
// matches by prefix. Filters are exact: kind and parent match any reading (A3, O2). In memory over
// the model: at a few hundred elements brute force takes well under a millisecond per query.
import type { ModelLookup } from "./lookup.ts";
import type { Conflict, ElementKind, ModelElement } from "./merge.ts";

export const MAX_QUERY_CHARS = 200;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 20;
/** Below this a hit is noise, not a candidate. */
const MIN_SCORE = 0.1;

const SYNONYMS: readonly (readonly string[])[] = [
  ["db", "database"],
  ["pg", "postgres", "postgresql"],
  ["k8s", "kubernetes"],
];
/** Field weights: the id and the name above other labels above technology. */
const WEIGHT = { id: 1, name: 1, label: 0.9, technology: 0.7 } as const;

export type Matched = "id" | "name" | "label" | "technology" | "synonym" | "filter";

export interface FindArguments {
  readonly query?: string;
  readonly id?: string;
  readonly kind?: ElementKind;
  readonly parent?: string;
  readonly diagram?: string;
  readonly limit?: number;
}

export interface FoundElement {
  readonly id: string;
  readonly name: string;
  readonly kinds: readonly ElementKind[];
  readonly parents: readonly string[];
  readonly path?: readonly string[];
  readonly external?: true;
  readonly technology?: string;
  readonly labels: readonly { readonly viewId: string; readonly label: string }[];
  readonly drawnIn: readonly string[];
  readonly opensIn: readonly string[];
  readonly relationships: {
    readonly out: number;
    readonly in: number;
    /** With `id` only: every pair, either way. */
    readonly list?: readonly {
      readonly from: string;
      readonly to: string;
      readonly drawnIn: readonly string[];
      readonly labels: readonly { readonly viewId: string; readonly label: string }[];
    }[];
  };
  readonly conflicts: readonly Conflict[];
  readonly score: number;
  readonly matched: Matched;
}

export interface FindResult {
  /** Every hit, before the limit. */
  readonly total: number;
  readonly elements: readonly FoundElement[];
}

/** Words of an id or a label: camelCase, kebab-case and snake_case split, lower case. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

function trigrams(list: readonly string[]): Set<string> {
  const grams = new Set<string>();
  for (const word of list) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / (a.size + b.size - shared);
}

/** The query's words, and each variant with one synonym swapped in. */
function variants(query: readonly string[]): { words: readonly string[]; synonym: boolean }[] {
  const out = [{ words: query, synonym: false }];
  for (const [i, word] of query.entries()) {
    const group = SYNONYMS.find((g) => g.includes(word));
    for (const other of group ?? [])
      if (other !== word) out.push({ words: query.map((w, j) => (j === i ? other : w)), synonym: true });
  }
  return out.slice(0, 16);
}

/** A name prepared for comparing with others: its words, and the trigrams of each synonym variant. */
export interface NameProfile {
  readonly words: readonly string[];
  readonly key: string;
  readonly variants: readonly ReadonlySet<string>[];
}

export function nameProfile(name: string): NameProfile {
  const list = words(name);
  return { words: list, key: list.join(" "), variants: variants(list).map((v) => trigrams(v.words)) };
}

/** How alike two names are, 0 to 1: trigram similarity, with a synonym swapped in on `a`'s side. */
export function nameSimilarity(a: NameProfile, b: NameProfile): number {
  const other = b.variants[0]!;
  let best = 0;
  for (const grams of a.variants) best = Math.max(best, similarity(grams, other));
  return best;
}

interface Field {
  readonly kind: "id" | "name" | "label" | "technology";
  readonly grams: ReadonlySet<string>;
  readonly words: readonly string[];
}

function fieldsOf(element: ModelElement): Field[] {
  const fields: Field[] = [];
  const add = (kind: Field["kind"], text: string): void => {
    const list = words(text);
    fields.push({ kind, grams: trigrams(list), words: list });
  };
  add("id", element.id);
  add("name", element.name);
  for (const label of new Set(element.occurrences.map((o) => o.label))) if (label !== element.name) add("label", label);
  for (const tech of new Set(element.occurrences.flatMap((o) => (o.technology === undefined ? [] : [o.technology]))))
    add("technology", tech);
  return fields;
}

function score(element: ModelElement, query: string): { score: number; matched: Matched } {
  const fields = fieldsOf(element);
  const trimmed = query.trim();
  if ([...trimmed].length < 3) {
    const q = trimmed.toLowerCase();
    if (q === "") return { score: 0, matched: "id" };
    if (element.id.toLowerCase() === q) return { score: 1, matched: "id" };
    if (element.id.toLowerCase().startsWith(q)) return { score: 0.9, matched: "id" };
    // Fields go id, name, labels, technology: the first word that matches has the highest weight.
    for (const f of fields)
      if (f.words.some((w) => w.startsWith(q))) return { score: 0.7 * WEIGHT[f.kind], matched: f.kind };
    return { score: 0, matched: "id" };
  }
  let best = { score: 0, matched: "id" as Matched };
  for (const variant of variants(words(trimmed))) {
    const grams = trigrams(variant.words);
    for (const f of fields) {
      const s = similarity(grams, f.grams) * WEIGHT[f.kind];
      if (s > best.score) best = { score: s, matched: variant.synonym ? "synonym" : f.kind };
    }
  }
  return best;
}

function found(
  lookup: ModelLookup,
  element: ModelElement,
  scored: { score: number; matched: Matched },
  withList: boolean,
): FoundElement {
  const { out, in: incoming } = lookup.relationshipsOf(element.id);
  const pairLabels = (occurrences: readonly { viewId: string; label?: string }[]) =>
    occurrences.flatMap((o) => (o.label === undefined ? [] : [{ viewId: o.viewId, label: o.label }]));
  const labels: { viewId: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const o of element.occurrences) {
    const key = `${o.viewId}\0${o.label}`;
    if (!seen.has(key)) labels.push({ viewId: o.viewId, label: o.label });
    seen.add(key);
  }
  return {
    id: element.id,
    name: element.name,
    kinds: element.kinds.map((r) => r.value),
    parents: element.parents.map((r) => r.value),
    ...(element.path === undefined ? {} : { path: element.path }),
    ...(element.external === true ? { external: true as const } : {}),
    ...(element.technology === undefined ? {} : { technology: element.technology }),
    labels,
    drawnIn: element.drawnIn,
    opensIn: element.opensIn,
    relationships: {
      out: out.length,
      in: incoming.length,
      ...(withList
        ? {
            list: [...out, ...incoming].map((r) => ({
              from: r.from,
              to: r.to,
              drawnIn: r.drawnIn,
              labels: pairLabels(r.occurrences),
            })),
          }
        : {}),
    },
    conflicts: element.conflicts,
    score: Math.round(scored.score * 1000) / 1000,
    matched: scored.matched,
  };
}

export function findElements(lookup: ModelLookup, args: FindArguments): FindResult {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const passes = (e: ModelElement): boolean =>
    (args.kind === undefined || e.kinds.some((r) => r.value === args.kind)) &&
    (args.parent === undefined || e.parents.some((r) => r.value === args.parent)) &&
    (args.diagram === undefined || e.drawnIn.includes(args.diagram) || e.opensIn.includes(args.diagram));
  if (args.id !== undefined) {
    const element = lookup.element(args.id);
    if (element === undefined || !passes(element)) return { total: 0, elements: [] };
    return { total: 1, elements: [found(lookup, element, { score: 1, matched: "id" }, true)] };
  }
  const candidates = lookup.model.elements.filter(passes);
  const hits =
    args.query === undefined || args.query.trim() === ""
      ? candidates.map((e) => ({ e, s: { score: 1, matched: "filter" as Matched } }))
      : candidates.map((e) => ({ e, s: score(e, args.query!) })).filter((h) => h.s.score >= MIN_SCORE);
  hits.sort((a, b) => b.s.score - a.s.score || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
  return { total: hits.length, elements: hits.slice(0, limit).map((h) => found(lookup, h.e, h.s, false)) };
}
