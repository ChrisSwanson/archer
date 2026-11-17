import { useRef, useState, type MutableRefObject } from "react";

/**
 * A function of stable identity that always runs the latest `fn`. For a callback of a large component kept across
 * renders (G6, PF-3): a `useCallback` value keeps the whole render it was made in (V8 shares one context per scope),
 * and that render's other callbacks keep theirs, so two callbacks whose inputs change at different times chain one
 * render to the next, one more per navigation. This one holds only a ref to the latest, so it keeps no old render.
 * For event handlers and callbacks run after render, never during it.
 */
export function useLatestCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useLatest(fn);
  const [stable] = useState(() => forward(latest));
  return stable;
}

/**
 * A ref that holds `value` as of the latest render, for an effect or listener set up once that must read the current
 * props without re-subscribing. Assigned during render, so a callback that runs after it sees this render's value.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const latest = useRef(value);
  latest.current = value;
  return latest;
}

// Outside the hook, so the forwarder's scope holds the ref and nothing else.
function forward<A extends unknown[], R>(latest: MutableRefObject<(...args: A) => R>): (...args: A) => R {
  return (...args) => latest.current(...args);
}
