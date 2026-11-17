import { sourceDocumentPath } from "./source-documents";
/**
 * The service's search (`GET api/search?q=`, phase3-front-door.md): the
 * Mermaid source, notes and comments, which only the service can read.
 *
 * The search page (`SearchPage.tsx`) matches names, paths and descriptions
 * itself, at once, as the reader types; this is the slower half, asked of each
 * project's service after a pause in typing. Its answer names targets and the
 * fields each matched in (`SearchMatches`).
 *
 * It is a filter, not a search engine: substring, case-insensitive, every
 * word must match somewhere in the file -- each word may match in a different
 * place, and `where` names every place any of them did. A note is a result of
 * its own (`note:<path>`) as well as counting for the views it is about. An
 * empty query is never sent: the service refuses it.
 */
import type { TargetRef } from "../comments/contract";
import { isTargetRef } from "../comments/parse";
import { MATCH_PLACES, type MatchPlace } from "./diagram-filter";

/** The service's limit on a query; a longer one is cut to it before it is sent. */
export const MAX_SEARCH_QUERY_CHARS = 200;

/** How long typing has to pause before the service is asked. */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * WHICH field a match was in (phase3-front-door.md, "Match fields"), finer
 * than `MatchPlace`; and for an element, a note or a comment, which one.
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
export type SearchMatch = {
  readonly field: MatchField;
  readonly text: string;
  readonly elementId?: string;
  readonly notePath?: string;
  readonly threadId?: string;
};
/** A result's matches, and how many more the service left out. */
export type MatchSummary = { readonly matches: readonly SearchMatch[]; readonly more: number };

/** At most this many matches are read per result; the service sends five. */
export const MAX_PARSED_MATCHES = 20;
const MAX_MATCH_TEXT = 200;
const MAX_ID_CHARS = 256;

export type SearchResult = {
  readonly target: TargetRef;
  readonly title: string;
  readonly where: readonly MatchPlace[];
  readonly matches: readonly SearchMatch[];
  readonly moreMatches?: number;
};
export type SearchAnswer = { readonly query: string; readonly results: readonly SearchResult[] };

/** What the service found, by target, for the query it answers. */
export type SearchHits = {
  readonly query: string;
  readonly places: ReadonlyMap<TargetRef, readonly MatchPlace[]>;
  /** Each result's title: the one thing the page knows of a note it was not told about. */
  readonly titles?: ReadonlyMap<TargetRef, string>;
  /** Each result's match fields. */
  readonly matches: ReadonlyMap<TargetRef, MatchSummary>;
};

const isField = (value: unknown): value is MatchField =>
  typeof value === "string" && (MATCH_FIELDS as readonly string[]).includes(value);
const shortString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** A relative Markdown path inside the Archer folder: no empty, `.` or `..` segment, no backslash. */
const isNotePath = (path: string): boolean =>
  path.length <= 4096 &&
  path.endsWith(".md") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\"));

/** One match, or `undefined`; a locator it cannot read is left off, and the match kept. */
function parseMatch(value: unknown): SearchMatch | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const m = value as Record<string, unknown>;
  if (!isField(m.field) || typeof m.text !== "string") return undefined;
  const notePath =
    typeof m.notePath === "string" && isTargetRef(`note:${m.notePath}`) && isNotePath(m.notePath)
      ? m.notePath
      : undefined;
  return {
    field: m.field,
    text: [...m.text].slice(0, MAX_MATCH_TEXT).join(""),
    ...(shortString(m.elementId, MAX_ID_CHARS) ? { elementId: m.elementId } : {}),
    ...(notePath === undefined ? {} : { notePath }),
    ...(shortString(m.threadId, MAX_ID_CHARS) ? { threadId: m.threadId } : {}),
  };
}

/** An answer to `api/search`, or `undefined`. A result it cannot read (its matches included) is dropped; an unknown place is ignored. */
export function parseSearch(value: unknown): SearchAnswer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.query !== "string" || !Array.isArray(record.results)) return undefined;
  const results: SearchResult[] = [];
  for (const entry of record.results) {
    if (typeof entry !== "object" || entry === null) continue;
    const result = entry as Record<string, unknown>;
    if (
      !isTargetRef(result.target) ||
      typeof result.title !== "string" ||
      !Array.isArray(result.where) ||
      !Array.isArray(result.matches)
    )
      continue;
    const where = MATCH_PLACES.filter((place) => (result.where as unknown[]).includes(place));
    const matches = result.matches.slice(0, MAX_PARSED_MATCHES).flatMap((m) => parseMatch(m) ?? []);
    const more = result.moreMatches;
    results.push({
      target: result.target,
      title: result.title,
      where,
      matches,
      ...(typeof more === "number" && Number.isSafeInteger(more) && more > 0 ? { moreMatches: more } : {}),
    });
  }
  return { query: record.query, results };
}

export function searchHits<T extends string = TargetRef>(answer: {
  readonly query: string;
  readonly results: readonly (Omit<SearchResult, "target"> & { readonly target: T })[];
}): {
  readonly query: string;
  readonly places: ReadonlyMap<T, readonly MatchPlace[]>;
  readonly titles: ReadonlyMap<T, string>;
  readonly matches: ReadonlyMap<T, MatchSummary>;
} {
  return {
    query: answer.query,
    places: new Map(answer.results.map((result) => [result.target, result.where] as const)),
    titles: new Map(answer.results.map((result) => [result.target, result.title] as const)),
    matches: new Map(
      answer.results.map(
        (result) => [result.target, { matches: result.matches, more: result.moreMatches ?? 0 }] as const,
      ),
    ),
  };
}

/** The query as it is sent: trimmed, and cut to the service's limit. */
export function searchQuery(query: string): string {
  return [...query.trim()].slice(0, MAX_SEARCH_QUERY_CHARS).join("");
}

export type BrowserSearchTarget = TargetRef | `source:${string}`;
export type BrowserSearchAnswer = {
  readonly query: string;
  readonly results: readonly (Omit<SearchResult, "target"> & { readonly target: BrowserSearchTarget })[];
};
/** Additive browser discovery accepts source identity without widening comment targets. */
export function parseBrowserSearch(value: unknown): BrowserSearchAnswer | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  if (
    typeof body.query !== "string" ||
    body.query.length > MAX_SEARCH_QUERY_CHARS ||
    !Array.isArray(body.results) ||
    body.results.length > 20000
  )
    return undefined;
  const shared = parseSearch(value);
  if (shared === undefined) return undefined;
  const sources: BrowserSearchAnswer["results"][number][] = [];
  for (const item of body.results) {
    if (item === null || typeof item !== "object") continue;
    const result = item as Record<string, unknown>;
    if (
      typeof result.target !== "string" ||
      !result.target.startsWith("source:") ||
      !sourceDocumentPath(result.target.slice(7)) ||
      typeof result.title !== "string" ||
      result.title.length > 512 ||
      !Array.isArray(result.where)
    )
      continue;
    if (!Array.isArray(result.matches)) continue;
    const matches = result.matches.slice(0, MAX_PARSED_MATCHES).flatMap((match) => parseMatch(match) ?? []);
    sources.push({
      target: result.target as `source:${string}`,
      title: result.title,
      where: MATCH_PLACES.filter((place) => (result.where as unknown[]).includes(place)),
      matches,
      ...(typeof result.moreMatches === "number" && Number.isSafeInteger(result.moreMatches) && result.moreMatches > 0
        ? { moreMatches: result.moreMatches }
        : {}),
    });
  }
  return { query: shared.query, results: [...shared.results, ...sources] };
}

/** The query's words as the service matches them (`queryWords`): lower case, split on whitespace. */
export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
}
