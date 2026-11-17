/**
 * A CSS media query, as React state that follows it.
 *
 * For the few layout facts that change what the page RENDERS rather than how
 * it is styled: a tab strip that is not rendered on a phone, a hint that names
 * a key only where there is a keyboard. Styling alone stays in `styles.css`.
 *
 * `false` where there is no `matchMedia` at all (jsdom without a stub, an old
 * host), which is the desktop, pointer-and-keyboard answer for every query the
 * page asks.
 */
import { useEffect, useState } from "react";

/** A phone-width window: the switcher replaces the tabs, the side panel takes the stage. */
export const NARROW_QUERY = "(max-width: 720px)";

/** The reader asked for less motion: what would move is shown still instead. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** A touch screen, with no hover and no right-click to speak of. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

export { mediaList } from "../theme/media-list";
import { mediaList } from "../theme/media-list";

function current(query: string): boolean {
  return mediaList(query)?.matches ?? false;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => current(query));
  useEffect(() => {
    const list = mediaList(query);
    if (list === null) return;
    const update = (): void => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
