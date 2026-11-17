// Phase 3, the front door and presence: the small rules behind the contents page. Which
// group a view's kind falls in, how big its model is, what a recompile
// changed, and how the filter reads a query and matches it.
import type { ThreadStatus } from "../comments/contract.ts";
import { elementsOf } from "../comments/store.ts";
import type { DiagramKind, DiagramModel, SequenceEvent } from "../model/index.ts";
import { elementsOf as modelElements } from "../model/elements.ts";
import { isGraphModel } from "../model/kinds.ts";

export type Group = "system" | "behaviour" | "data" | "journeys" | "other";

/** By intent. Every kind is named, so a new kind fails the type check until it is placed. */
export const GROUP_OF_KIND: Readonly<Record<DiagramKind, Group>> = {
  freeform: "system",
  "c4-context": "system",
  "c4-container": "system",
  "c4-component": "system",
  "c4-code": "system",
  "data-flow": "system",
  c4: "system",
  architecture: "system",
  sequence: "behaviour",
  state: "behaviour",
  "entity-relationship": "data",
  journey: "journeys",
};

export function groupOf(kind: string): Group {
  return Object.hasOwn(GROUP_OF_KIND, kind) ? GROUP_OF_KIND[kind as DiagramKind] : "other";
}

export interface LastChange {
  readonly at: string;
  readonly by: "agent" | "person";
  readonly summary?: string;
}

export type ThreadCounts = Record<ThreadStatus, number>;

export const noThreads = (): ThreadCounts => ({ draft: 0, sent: 0, read: 0, answered: 0, resolved: 0 });

/** Nodes (participants, states, entities, ...) and links (edges, messages, transitions, ...); groups are not counted. */
export function countsOf(model: DiagramModel): { elements: number; links: number } {
  let elements = 0;
  let links = 0;
  for (const key of elementsOf(model).keys()) {
    if (key.startsWith("node:")) elements++;
    else if (key.startsWith("edge:")) links++;
  }
  return { elements, links };
}

export { diffElements, type ElementChange } from "../accuracy/elements.ts";

// ------------------------------------------------------------------ search

export const MAX_QUERY_CHARS = 200;
export const MAX_SEARCH_RESULTS = 200;

export type Where = "title" | "diagram" | "note" | "comment";
const WHERE_ORDER: readonly Where[] = ["title", "diagram", "note", "comment"];

export class SearchRefusal extends Error {
  readonly code = "invalid_request";
  override name = "SearchRefusal";
}

/** The query's words, lower-cased; a missing, empty or over-long query is refused. */
export function queryWords(raw: string | null): string[] {
  if (raw === null) throw new SearchRefusal("name what to look for: api/search?q=<words>");
  if ([...raw].length > MAX_QUERY_CHARS)
    throw new SearchRefusal(`a query is at most ${MAX_QUERY_CHARS} characters; this one is ${[...raw].length}`);
  const words = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) throw new SearchRefusal("the query has no words to look for");
  return words;
}

/** A card's text, by where it is. */
export type Sources = Partial<Record<Where, readonly string[]>>;

/**
 * Where the words were found, or null when one of them is nowhere in the
 * card: a filter, not a search engine. Every word must appear (as a
 * case-insensitive substring) in some source; `where` names each source that
 * holds any of them.
 */
export function matchCard(words: readonly string[], sources: Sources): Where[] | null {
  const found = new Set<string>();
  const where: Where[] = [];
  for (const place of WHERE_ORDER) {
    const texts = (sources[place] ?? []).map((t) => t.toLowerCase());
    let hit = false;
    for (const word of words)
      if (texts.some((t) => t.includes(word))) {
        hit = true;
        found.add(word);
      }
    if (hit) where.push(place);
  }
  return words.every((w) => found.has(w)) ? where : null;
}

// ------------------------------------------------------- match fields

/**
 * WHICH field of a card a match was in (phase3-front-door.md, "Match
 * fields"), finer than `Where`: the title (and kind), the file's path (and
 * the view's id), an element of the compiled model, the Mermaid source where
 * no element holds the word, a note's text, a comment. In this order.
 */
export const MATCH_FIELDS = [
  "title",
  "path",
  "node",
  "participant",
  "edge",
  "message",
  "group",
  "source",
  "note",
  "comment",
] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

export const MAX_MATCHES_PER_RESULT = 5;
export const MAX_EXCERPT_CHARS = 80;

/** One match: the field, a short excerpt of what matched, and what locates it. */
export interface FieldMatch {
  readonly field: MatchField;
  readonly text: string;
  /** The element of the compiled model (node, edge, group, participant, message). */
  readonly elementId?: string;
  /** The note whose text matched (on a view's card). */
  readonly notePath?: string;
  /** The comment thread that matched. */
  readonly threadId?: string;
}

/** Something a match can be in: the texts it is found by, and what it is shown as (the first text by default). */
export interface Candidate {
  readonly field: MatchField;
  readonly texts: readonly string[];
  readonly shown?: string;
  readonly elementId?: string;
  readonly notePath?: string;
  readonly threadId?: string;
}

/**
 * The compiled model's elements, each found by its label and its id: a
 * graph's nodes, edges and groups; a sequence's participants, messages and
 * fragments (as groups); the nodes and links of every other kind. An edge
 * without a label is found by its id only and shown by its ends' labels.
 */
export function elementCandidates(model: DiagramModel): Candidate[] {
  const out: Candidate[] = [];
  const element = (field: MatchField, id: string, label: string | null | undefined, fallback: string): void => {
    const texts = label == null || label === "" ? [id] : [label, id];
    out.push({ field, texts, shown: label == null || label === "" ? fallback : label, elementId: id });
  };
  if (model.type === "sequence-trace") {
    const names = new Map(model.participants.map((p) => [p.id, p.label] as const));
    for (const p of model.participants) element("participant", p.id, p.label, p.id);
    // A worklist, not recursion: fragments nest as deep as the source does.
    const pending: SequenceEvent[] = [...model.events].reverse();
    for (let event = pending.pop(); event !== undefined; event = pending.pop()) {
      if (event.type === "message")
        element(
          "message",
          event.id,
          event.label,
          `${names.get(event.from) ?? event.from} → ${names.get(event.to) ?? event.to}`,
        );
      else if (event.type === "fragment") {
        element("group", event.id, event.label, event.kind);
        for (const section of [...event.sections].reverse()) pending.push(...[...section.events].reverse());
      }
    }
    return out;
  }
  const { nodes, links } = modelElements(model);
  const names = new Map(nodes.map((n) => [n.id, n.label] as const));
  for (const n of nodes) element("node", n.id, n.label, n.id);
  for (const l of links)
    element("edge", l.id, l.label, `${names.get(l.source) ?? l.source} → ${names.get(l.target) ?? l.target}`);
  if (isGraphModel(model)) for (const g of model.groups) element("group", g.id, g.label, g.id);
  return out;
}

/** `text` with its whitespace folded, cut to about `MAX_EXCERPT_CHARS` around the first place `word` is. */
export function excerpt(text: string, word: string): string {
  const folded = [...text.replace(/\s+/g, " ").trim()];
  if (folded.length <= MAX_EXCERPT_CHARS) return folded.join("");
  const at = Math.max(0, folded.join("").toLowerCase().indexOf(word));
  const index = [...folded.join("").slice(0, at)].length;
  const start = Math.max(0, Math.min(index - Math.floor(MAX_EXCERPT_CHARS / 3), folded.length - MAX_EXCERPT_CHARS));
  const end = start + MAX_EXCERPT_CHARS;
  return `${start > 0 ? "…" : ""}${folded.slice(start, end).join("").trim()}${end < folded.length ? "…" : ""}`;
}

const FIELD_RANK = new Map<MatchField, number>(MATCH_FIELDS.map((f, i) => [f, i]));

/**
 * The matches among `candidates` (any of `words` in any of a candidate's
 * texts), and, for each word in `source` that no matched candidate holds, the
 * source line it is on: a word in a Mermaid comment, a sequence note, a
 * directive. In field order, the same text in one field once, at most
 * `MAX_MATCHES_PER_RESULT`, with how many more there were.
 */
export function fieldMatches(
  words: readonly string[],
  candidates: readonly Candidate[],
  source: string,
): { matches: FieldMatch[]; more: number } {
  const all: FieldMatch[] = [];
  const seen = new Set<string>();
  const covered = new Set<string>();
  const add = (match: FieldMatch): void => {
    const key = `${match.field}\u0000${match.text}\u0000${match.elementId ?? ""}\u0000${match.notePath ?? ""}\u0000${match.threadId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push(match);
  };
  for (const c of candidates) {
    const lower = c.texts.map((t) => t.toLowerCase());
    const hit = words.filter((w) => lower.some((t) => t.includes(w)));
    if (hit.length === 0) continue;
    for (const w of hit) covered.add(w);
    const shown = c.shown ?? c.texts[0] ?? "";
    const first = hit.find((w) => shown.toLowerCase().includes(w)) ?? hit[0]!;
    add({
      field: c.field,
      text: excerpt(shown, first),
      ...(c.elementId === undefined ? {} : { elementId: c.elementId }),
      ...(c.notePath === undefined ? {} : { notePath: c.notePath }),
      ...(c.threadId === undefined ? {} : { threadId: c.threadId }),
    });
  }
  if (source !== "") {
    const lines = source.split(/\r?\n/);
    for (const w of words) {
      if (covered.has(w)) continue;
      const line = lines.find((l) => l.toLowerCase().includes(w));
      if (line !== undefined) add({ field: "source", text: excerpt(line, w) });
    }
  }
  all.sort((a, b) => FIELD_RANK.get(a.field)! - FIELD_RANK.get(b.field)!);
  return { matches: all.slice(0, MAX_MATCHES_PER_RESULT), more: Math.max(0, all.length - MAX_MATCHES_PER_RESULT) };
}
