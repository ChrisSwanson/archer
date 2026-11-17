// Keeps the identity of every canvas item that did not change.
//
// React Flow, driven in controlled mode, re-adopts and re-measures each node
// whose object is new, and every node and edge wrapper re-renders. The canvas
// rebuilds all of them on any change -- a rename, a selection -- so on the
// 150-node flowchart one edit cost a second of main thread in React Flow alone
// (smoke-a). Handing back the previous object for an item that is equal leaves
// React Flow to update only what moved.
import { useRef } from "react";

/** Structural equality for plain canvas data; functions and other instances compare by identity. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const plain = (value: object) =>
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
  if (!plain(a) || !plain(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * `next`, with each item equal to the previous one of its id replaced by that
 * previous object; `previous` itself when nothing changed at all.
 *
 * `canReuse` vetoes an equal item. React Flow writes click and marquee
 * selection straight into its INTERNAL node copies (`getSelectionChanges(...,
 * mutateItem)`), and an internal copy is kept for as long as its user object
 * is: an unchanged `selected: true` node it unselected internally would stay
 * unselected on screen (the Shift-click tests on C4, ER, state).
 */
export function reuseUnchanged<T extends { readonly id: string }>(
  previous: T[],
  next: T[],
  canReuse: (old: T) => boolean = () => true,
): T[] {
  const before = new Map(previous.map((item) => [item.id, item]));
  let changed = previous.length !== next.length;
  const kept = next.map((item, index) => {
    const old = before.get(item.id);
    const reused = old !== undefined && sameValue(old, item) && canReuse(old) ? old : item;
    if (reused !== previous[index]) changed = true;
    return reused;
  });
  return changed ? kept : previous;
}

/** `items`, keeping the previous render's object for every item that is equal (`reuseUnchanged`). */
export function useStableItems<T extends { readonly id: string }>(items: T[], canReuse?: (old: T) => boolean): T[] {
  const held = useRef<T[]>(items);
  const stable = held.current === items ? items : reuseUnchanged(held.current, items, canReuse);
  held.current = stable;
  return stable;
}

/** `value`, or the previous render's value when the two are equal (`sameValue`): an inline prop object kept stable for memo deps. */
export function useStableValue<T>(value: T): T {
  const held = useRef<T>(value);
  if (!sameValue(held.current, value)) held.current = value;
  return held.current;
}
