/**
 * Whether emphasised elements carry their group's number (ADR 0030, "Group
 * numbers"): the reader's Auto / On / Off, kept per browser like the flow
 * animation choice beside it in the legend.
 *
 * Auto is off, unless the viewer has told the system they need more than
 * colour: `prefers-contrast: more`, or forced colours (Windows high contrast),
 * where the hues are replaced by system colours and only the number still
 * tells one group from another. On and Off are the reader's own and override
 * both.
 *
 * Read in JavaScript, like reduced motion, so the canvases and the legend draw
 * from one answer: the surface publishes it as a class
 * (`archer-emph-numbered`) that the stylesheet keys off.
 */
import { useSyncExternalStore } from "react";
import { browserStateKey } from "../runtime/address.ts";
import { mediaList } from "../theme/media-list";

export type GroupNumbersPreference = "auto" | "on" | "off";

const STORAGE_KEY = "archer.group-numbers";
const QUERIES = ["(prefers-contrast: more)", "(forced-colors: active)"] as const;

/** The class on an emphasis surface whose groups are numbered. */
export const EMPHASIS_NUMBERED_CLASS = "archer-emph-numbered";

const isPreference = (value: unknown): value is GroupNumbersPreference =>
  value === "auto" || value === "on" || value === "off";

/** What this document chose when storage refused it: a blocked store still permits a choice here. */
let volatile: GroupNumbersPreference | null = null;
const listeners = new Set<() => void>();

function readPreference(): GroupNumbersPreference {
  if (volatile !== null) return volatile;
  try {
    const stored = window.localStorage.getItem(browserStateKey(STORAGE_KEY));
    return isPreference(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

export function setGroupNumbersPreference(preference: GroupNumbersPreference): void {
  try {
    window.localStorage.setItem(browserStateKey(STORAGE_KEY), preference);
    volatile = null;
  } catch {
    volatile = preference;
  }
  for (const listener of [...listeners]) listener();
}

function subscribePreference(onChange: () => void): () => void {
  listeners.add(onChange);
  const storage = (event: StorageEvent): void => {
    if (event.key === browserStateKey(STORAGE_KEY) || event.key === null) onChange();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", storage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", storage);
  };
}

function lists(): MediaQueryList[] {
  return QUERIES.flatMap((query) => mediaList(query) ?? []);
}

/** Whether the system asks for more than colour. */
export function systemAsksForMore(): boolean {
  return lists().some((list) => list.matches);
}

function subscribeSystem(onChange: () => void): () => void {
  const all = lists();
  for (const list of all) list.addEventListener("change", onChange);
  return () => {
    for (const list of all) list.removeEventListener("change", onChange);
  };
}

/**
 * Whether groups are numbered: the reader's On or Off, else (Auto) when the system asks for more than colour,
 * or when the drawing is in family colours -- teal and violet families sit close to two emphasis hues, so a
 * number says which group a box is in (ADR 0030, amended 2026-11-11).
 */
export function groupsNumbered(preference: GroupNumbersPreference, system: boolean, familyColours: boolean): boolean {
  return preference === "on" || (preference === "auto" && (system || familyColours));
}

/** The reader's choice, and whether groups are numbered now. */
export function useGroupNumbers(familyColours = false): {
  readonly preference: GroupNumbersPreference;
  readonly numbered: boolean;
  readonly setPreference: (value: GroupNumbersPreference) => void;
} {
  const preference = useSyncExternalStore(subscribePreference, readPreference, () => "auto" as const);
  const system = useSyncExternalStore(subscribeSystem, systemAsksForMore, () => false);
  return {
    preference,
    numbered: groupsNumbered(preference, system, familyColours),
    setPreference: setGroupNumbersPreference,
  };
}
