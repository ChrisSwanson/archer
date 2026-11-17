/**
 * The query vocabulary the search page and the file index share: the words a
 * query is split into, and the places a match can be found.
 */

/** The words of a query, lowercased; empty when nothing but space was typed. */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * WHERE a match is, as the service's search says (phase3-front-door.md): the
 * title (or kind), the Mermaid source, a note about the diagram, a comment on
 * it (`search.ts`).
 */
export type MatchPlace = "title" | "diagram" | "note" | "comment";

export const MATCH_PLACES: readonly MatchPlace[] = ["title", "diagram", "note", "comment"];
