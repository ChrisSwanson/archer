/**
 * One `MediaQueryList` per CSS media query, for the life of the page (per `matchMedia`, so a test's stub gets its
 * own). Outside `app/` so the export painter, which loads no page UI, shares it with the emphasis checks. Asked
 * again on every render, `matchMedia` makes a new list each time, and the document's style engine keeps every query
 * set it was given: the page grew by a few per navigation (G6).
 */
const lists = new WeakMap<typeof window.matchMedia, Map<string, MediaQueryList>>();
export function mediaList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  const match = window.matchMedia;
  let known = lists.get(match);
  if (known === undefined) lists.set(match, (known = new Map()));
  let list = known.get(query);
  if (list === undefined) known.set(query, (list = window.matchMedia(query)));
  return list;
}
