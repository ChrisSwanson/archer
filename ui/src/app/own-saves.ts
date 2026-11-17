/**
 * The person's own saves (flows-r1 claude-206): which diagram revision this browser saved, so the header says
 * "Saved · time" only for that, and "Changed on disk · time" for a write Archer did not make for this person (another
 * editor, Git, a script, another person's browser). The service's `lastChange.by` is "person" for all of those.
 *
 * A save's receipt names no model revision, so an entry keeps the revision the view showed when the save was sent
 * (`prior`); the first different revision after it is the save's, and is claimed for it (`claimed`). Kept in
 * localStorage, bounded, so a reload or a reopened tab still knows its own last save.
 */
import { useSyncExternalStore } from "react";
import { getBounded, putBounded } from "../authoring/recovery";
import type { DiagramView } from "./inventory";

export type OwnSave = {
  readonly prior?: string;
  readonly savedAt: number;
  readonly claimed?: string;
  readonly source?: string;
};
type Saves = Record<string, OwnSave>;

const PREFIX = "archer.own-saves.v1:";
const MAX = 200;
const LIMIT = 64 * 1024;
let version = 0;
const listeners = new Set<() => void>();
const changed = (): void => {
  version++;
  for (const listener of listeners) listener();
};

function read(slug: string): Saves {
  let value: unknown = null;
  try {
    value = getBounded(localStorage, PREFIX + slug, LIMIT);
  } catch {
    /* blocked storage */
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const saves: Saves = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.savedAt !== "number" || !Number.isFinite(r.savedAt)) continue;
    saves[id] = {
      savedAt: r.savedAt,
      ...(typeof r.prior === "string" ? { prior: r.prior } : {}),
      ...(typeof r.claimed === "string" ? { claimed: r.claimed } : {}),
      ...(typeof r.source === "string" ? { source: r.source } : {}),
    };
  }
  return saves;
}

function write(slug: string, saves: Saves): void {
  const kept = Object.entries(saves)
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, MAX);
  try {
    putBounded(localStorage, PREFIX + slug, Object.fromEntries(kept), LIMIT);
  } catch {
    /* blocked storage: the header then says Changed on disk */
  }
  changed();
}

/**
 * The person's save of `viewId` succeeded; `prior` is the model revision the view showed when it was sent. A save
 * answered `unchanged` made no new revision: the one shown is the person's.
 */
export function noteOwnSave(
  slug: string,
  viewId: string,
  prior: string | undefined,
  unchanged = false,
  now: number = Date.now(),
  source?: string,
): void {
  const saves = read(slug);
  saves[viewId] = {
    savedAt: now,
    ...(prior === undefined ? {} : unchanged ? { prior, claimed: prior } : { prior }),
    ...(source === undefined ? {} : { source }),
  };
  write(slug, saves);
}

export function ownSaveOf(slug: string, viewId: string): OwnSave | null {
  return read(slug)[viewId] ?? null;
}

/**
 * Whether the view's current revision is the person's own last save: the revision claimed for it, or (not yet
 * claimed) the first one after the revision the save started from. Without `prior` (the standalone editor), the
 * first change dated from the save on.
 */
export function savedByYou(
  save: OwnSave | null | undefined,
  view: Pick<DiagramView, "modelRevision" | "lastChange" | "sourceRevision"> | undefined,
): boolean {
  if (!save || !view?.lastChange || view.lastChange.by !== "person") return false;
  // The file revision the save wrote, when both sides name it: exact, whether or not this tab saw it arrive (claude-308).
  if (save.source !== undefined && view.sourceRevision !== undefined) return save.source === view.sourceRevision;
  if (save.claimed !== undefined) return save.claimed === view.modelRevision;
  if (save.prior !== undefined) return view.modelRevision !== undefined && view.modelRevision !== save.prior;
  return Date.parse(view.lastChange.at) >= save.savedAt - 5_000;
}

/** Keep the revision the save made, so a later write to the file is not called the person's. */
export function claimOwnSave(slug: string, viewId: string, modelRevision: string): void {
  const saves = read(slug),
    save = saves[viewId];
  if (!save || save.claimed === modelRevision) return;
  saves[viewId] = { ...save, claimed: modelRevision };
  write(slug, saves);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of this browser saved: its entry counts here too.
  const storage = (event: StorageEvent): void => {
    if (event.key?.startsWith(PREFIX)) changed();
  };
  window.addEventListener("storage", storage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", storage);
  };
}

/** Re-renders when an own save is noted or claimed (here or in another tab). */
export function useOwnSavesVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}
