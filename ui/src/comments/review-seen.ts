import { browserStateKey } from "../runtime/address.ts";
import type { TargetRef, Thread } from "./contract";
import { readTargetRef } from "./target";

/** Persistence bounds keep a corrupt or hostile browser value cheap to parse and hold. */
export const MAX_SEEN_STORAGE_CHARS = 512 * 1024;
export const MAX_SEEN_ENTRIES = 4096;
export const MAX_SEEN_PROJECT_CHARS = 256;
export const MAX_SEEN_TARGET_CHARS = 5 + 4096;
export const MAX_SEEN_THREAD_ID_CHARS = 64;
export const MAX_SEEN_COMMENT_ID_CHARS = 64;

const PREFIX = "archer-comments-seen:v1:";

export type SeenEntry = {
  readonly target: TargetRef;
  readonly threadId: string;
  readonly commentId: string;
};

export type SeenState = {
  readonly entries: readonly SeenEntry[];
};

export const EMPTY_SEEN_STATE: SeenState = { entries: [] };

export function browserReviewStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function seenStorageKey(projectIdentity: string): string | null {
  return validProjectIdentity(projectIdentity)
    ? browserStateKey(`${PREFIX}${encodeURIComponent(projectIdentity)}`)
    : null;
}

function validProjectIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SEEN_PROJECT_CHARS && /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function validTarget(value: unknown): value is TargetRef {
  return readTargetRef(value, MAX_SEEN_TARGET_CHARS) !== null;
}

function validCommentIdentity(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && /^[A-Za-z0-9_-]+$/u.test(value);
}

function entryKey(entry: SeenEntry): string {
  return JSON.stringify([entry.target, entry.threadId, entry.commentId]);
}

export function seenEntryIndex(state: SeenState): ReadonlySet<string> {
  return new Set(state.entries.map(entryKey));
}

function commentEntryKey(thread: Thread, commentId: string): string {
  return entryKey({ target: thread.target, threadId: thread.id, commentId });
}

/** Parses untrusted localStorage bytes. Every input returns a bounded usable state. */
export function parseSeenState(raw: unknown): SeenState {
  if (typeof raw !== "string" || raw.length > MAX_SEEN_STORAGE_CHARS) return EMPTY_SEEN_STATE;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return EMPTY_SEEN_STATE;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.entries)) return EMPTY_SEEN_STATE;
    const entries: SeenEntry[] = [];
    const unique = new Set<string>();
    for (const candidate of record.entries) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
      const item = candidate as Record<string, unknown>;
      if (!validTarget(item.target)) continue;
      if (
        !validCommentIdentity(item.threadId, MAX_SEEN_THREAD_ID_CHARS) ||
        !validCommentIdentity(item.commentId, MAX_SEEN_COMMENT_ID_CHARS)
      )
        continue;
      const entry = { target: item.target, threadId: item.threadId, commentId: item.commentId };
      const key = entryKey(entry);
      if (unique.has(key)) continue;
      unique.add(key);
      entries.push(entry);
      if (entries.length === MAX_SEEN_ENTRIES) break;
    }
    return { entries };
  } catch {
    return EMPTY_SEEN_STATE;
  }
}

export function loadSeenState(projectIdentity: string | null | undefined, storage: Storage | null): SeenState {
  const identity = projectIdentity ?? null;
  if (identity === null || storage === null) return EMPTY_SEEN_STATE;
  const key = seenStorageKey(identity);
  if (key === null) return EMPTY_SEEN_STATE;
  try {
    return parseSeenState(storage.getItem(key));
  } catch {
    return EMPTY_SEEN_STATE;
  }
}

export function storeSeenState(
  projectIdentity: string | null | undefined,
  state: SeenState,
  storage: Storage | null,
): void {
  const key = projectIdentity === null || projectIdentity === undefined ? null : seenStorageKey(projectIdentity);
  if (key === null || storage === null) return;
  try {
    const entries = state.entries.slice(-MAX_SEEN_ENTRIES);
    const fit = <T>(values: readonly T[], serialize: (suffix: readonly T[]) => string): readonly T[] => {
      let low = 0;
      let high = values.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (serialize(values.slice(values.length - middle)).length <= MAX_SEEN_STORAGE_CHARS) low = middle;
        else high = middle - 1;
      }
      return values.slice(values.length - low);
    };
    const keptEntries = fit(entries, (suffix) => JSON.stringify({ version: 1, entries: suffix }));
    storage.setItem(key, JSON.stringify({ version: 1, entries: keptEntries }));
  } catch {
    /* Storage can be disabled or full; the caller retains in-memory state. */
  }
}

export function isSeen(index: ReadonlySet<string>, thread: Thread, commentId: string): boolean {
  return index.has(commentEntryKey(thread, commentId));
}

export function mergeSeenStates(memory: SeenState, persisted: SeenState): SeenState {
  const entries = [...memory.entries];
  const keys = new Set(entries.map(entryKey));
  for (const entry of persisted.entries) {
    const key = entryKey(entry);
    if (!keys.has(key)) {
      keys.add(key);
      entries.push(entry);
    }
  }
  if (entries.length === memory.entries.length) return memory;
  return { entries: entries.slice(-MAX_SEEN_ENTRIES) };
}

export function rememberSeen(state: SeenState, threads: readonly Thread[]): SeenState {
  const entries = [...state.entries];
  const keys = new Set(entries.map(entryKey));
  let changed = false;
  for (const thread of threads) {
    if (!validTarget(thread.target) || !validCommentIdentity(thread.id, MAX_SEEN_THREAD_ID_CHARS)) continue;
    for (const comment of thread.comments) {
      if (comment.author !== "agent" || !validCommentIdentity(comment.id, MAX_SEEN_COMMENT_ID_CHARS)) continue;
      const entry = { target: thread.target, threadId: thread.id, commentId: comment.id };
      const key = entryKey(entry);
      if (keys.has(key)) continue;
      keys.add(key);
      entries.push(entry);
      changed = true;
    }
  }
  if (!changed) return state;
  return entries.length > MAX_SEEN_ENTRIES
    ? { ...state, entries: entries.slice(entries.length - MAX_SEEN_ENTRIES) }
    : { ...state, entries };
}
