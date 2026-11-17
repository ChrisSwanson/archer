/**
 * The reader's recent files and projects, for the sidebar
 * (the projects-and-search design).
 *
 * Per viewer and per browser: kept in `localStorage`, which every project the
 * service serves shares (one origin), so a recent item names its project.
 * Storage can be missing, full or refused (a private window, blocked site
 * data): every read and write is guarded, and the sidebar then lists what this
 * page has opened since it loaded.
 */
import { useCallback, useEffect, useState } from "react";
import { browserStateKey } from "../runtime/address.ts";

export type RecentItem = {
  readonly slug: string;
  readonly projectName: string;
  /** A project's page, a diagram (by view id) or a note (by path). */
  readonly kind: "project" | "view" | "note";
  /** "" for a project. */
  readonly id: string;
  readonly title: string;
  /** When it was last opened, in ms. */
  readonly at: number;
};

export const RECENTS_KEY = "archer.recent.v1";
/** How many the sidebar shows. */
export const RECENTS_SHOWN = 5;
/** How many are kept, so closing a few projects does not empty the list. */
const RECENTS_KEPT = 24;
const MAX_TEXT = 512;
/** ADR 0012 diagram addresses and the existing note target path limit. */
const MAX_VIEW_ID = 1200;
const MAX_NOTE_PATH = 4096;

const same = (a: Pick<RecentItem, "slug" | "kind" | "id">, b: Pick<RecentItem, "slug" | "kind" | "id">): boolean =>
  a.slug === b.slug && a.kind === b.kind && a.id === b.id;

function parse(raw: string | null): RecentItem[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const items: RecentItem[] = [];
  for (const entry of value.slice(0, RECENTS_KEPT)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const text = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_TEXT;
    if (e.kind !== "project" && e.kind !== "view" && e.kind !== "note") continue;
    const maxId = e.kind === "view" ? MAX_VIEW_ID : e.kind === "note" ? MAX_NOTE_PATH : MAX_TEXT;
    if (
      !text(e.slug) ||
      !text(e.projectName) ||
      typeof e.id !== "string" ||
      e.id.length > maxId ||
      !text(e.title) ||
      typeof e.at !== "number" ||
      !Number.isFinite(e.at)
    )
      continue;
    items.push({ slug: e.slug, projectName: e.projectName, kind: e.kind, id: e.id, title: e.title, at: e.at });
  }
  return items;
}

export function readRecents(storage: Storage | null = safeStorage()): RecentItem[] {
  try {
    return parse(storage?.getItem(browserStateKey(RECENTS_KEY)) ?? null);
  } catch {
    return [];
  }
}

/** `item` first, any earlier entry for the same place removed. */
export function withRecent(items: readonly RecentItem[], item: RecentItem): RecentItem[] {
  return [item, ...items.filter((held) => !same(held, item))].slice(0, RECENTS_KEPT);
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The recent items, and how to add one. Another tab's change shows here too
 * (the `storage` event). `remember` keeps the list in memory when storage
 * refuses it.
 */
export function useRecents(): {
  readonly items: readonly RecentItem[];
  readonly remember: (item: Omit<RecentItem, "at">) => void;
} {
  const [items, setItems] = useState<readonly RecentItem[]>(() => readRecents());
  useEffect(() => {
    const changed = (event: StorageEvent): void => {
      if (event.key === browserStateKey(RECENTS_KEY)) setItems(readRecents());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const remember = useCallback((item: Omit<RecentItem, "at">) => {
    setItems((held) => {
      // Read again first: another tab may have added since.
      const stored = readRecents();
      // Storage may still hold an older successful write after later writes
      // were refused. Merge it with this page's memory, keeping each place's
      // newest visit, so neither those visits nor another tab's are lost.
      const merged = [...held, ...stored]
        .sort((a, b) => b.at - a.at)
        .filter((entry, index, all) => all.findIndex((candidate) => same(candidate, entry)) === index);
      const next = withRecent(merged, { ...item, at: Date.now() });
      try {
        safeStorage()?.setItem(browserStateKey(RECENTS_KEY), JSON.stringify(next));
      } catch {
        // Full or refused: this page keeps the list itself.
      }
      return next;
    });
  }, []);
  return { items, remember };
}
