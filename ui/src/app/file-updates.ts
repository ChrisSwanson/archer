/**
 * Change cues (ADR 0028): the service's `files` event becomes a transient "<file> updated" popup
 * next to the notifications inbox. One owner for the whole page (the App Shell renders the popup);
 * pages feed it the event and tell it about the person's own saves. Nothing here is kept: no read
 * state, no inbox entry, nothing in storage.
 */

export type FileKind = "diagram" | "note" | "document";
export type FileEntry = { readonly path: string; readonly kind: FileKind; readonly revision?: string };
export type FilesEvent = {
  readonly changed: readonly FileEntry[];
  readonly added: readonly FileEntry[];
  readonly removed: readonly { readonly path: string; readonly kind: FileKind }[];
  readonly truncated?: true;
};
/** A choice in the popup; returning false keeps the popup (a cancelled confirmation). */
export type FilePopupAction = { readonly label: string; readonly run: () => boolean | void };
export type FileUpdatesPopupState = {
  readonly id: number;
  readonly text: string;
  readonly paths: readonly string[];
  /** A choice the person must make (unsaved work): it stays until they act. */
  readonly persistent?: boolean;
  readonly actions?: readonly FilePopupAction[];
} | null;

/** How long a burst gathers into one popup, and how long the popup shows before it fades. */
export const COALESCE_MS = 1500;
export const SHOWN_MS = 5000;
/** How long a save of the person's own is remembered, so its echo stays quiet. */
const OWN_WRITE_MS = 10_000;
const MAX_ENTRIES = 200;
const KINDS: ReadonlySet<string> = new Set(["diagram", "note", "document"]);
const REVISION = /^sha256:[0-9a-f]{64}$/u;

const validPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.split("/").includes("..");

function entries(value: unknown): FileEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ENTRIES).flatMap((raw): FileEntry[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const r = raw as Record<string, unknown>;
    if (!validPath(r.path) || typeof r.kind !== "string" || !KINDS.has(r.kind)) return [];
    return [
      {
        path: r.path,
        kind: r.kind as FileKind,
        ...(typeof r.revision === "string" && REVISION.test(r.revision) ? { revision: r.revision } : {}),
      },
    ];
  });
}

/** The event as the page accepts it: bounded, project-relative paths only; null when malformed. */
export function parseFilesEvent(value: unknown): FilesEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.changed) || !Array.isArray(v.added) || !Array.isArray(v.removed)) return null;
  return {
    changed: entries(v.changed),
    added: entries(v.added),
    removed: entries(v.removed).map(({ path, kind }) => ({ path, kind })),
    ...(v.truncated === true ? { truncated: true as const } : {}),
  };
}

type Pending = { path: string; revision?: string; removed: boolean };
let pending: Pending[] = [];
let pendingTruncated = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let own: { path: string; revision: string | null; until: number }[] = [];
let current: FileUpdatesPopupState = null;
let nextId = 1;
const listeners = new Set<(state: FileUpdatesPopupState) => void>();
/** The open file's own handler (S7): it speaks for that file instead of the generic popup. */
let openFile: {
  path: string;
  onUpdate: (entry: { path: string; removed: boolean; revision?: string }) => void;
} | null = null;

const name = (path: string): string => path.split("/").at(-1) ?? path;
const emit = (state: FileUpdatesPopupState): void => {
  current = state;
  for (const listener of listeners) listener(state);
};

/**
 * Whether this entry is the echo of the person's own save. An exact revision matches only that
 * version. Without one (an embedded block) only the next change of that note matches, once: a
 * removal, or a second change, is someone else's.
 */
function isOwn(entry: Pending, now: number): boolean {
  own = own.filter((write) => write.until > now);
  const at = own.findIndex(
    (write) =>
      write.path === entry.path &&
      !entry.removed &&
      (write.revision === null ? true : write.revision === entry.revision),
  );
  if (at < 0) return false;
  if (own[at]!.revision === null) own.splice(at, 1);
  return true;
}

function describe(updated: readonly string[], removed: readonly string[], truncated: boolean): string {
  const list = (names: readonly string[], more: boolean): string => {
    if (names.length === 1) return more ? `${names[0]} and more` : names[0]!;
    if (names.length === 2 && !more) return `${names[0]} and ${names[1]}`;
    return `${names[0]}, ${names[1]} and ${more ? "more" : names.length - 2 + " more"}`;
  };
  const parts: string[] = [];
  if (updated.length > 0) parts.push(`${list(updated, truncated)} updated`);
  if (removed.length > 0) parts.push(`${list(removed, truncated && updated.length === 0)} removed`);
  return parts.join("; ");
}

function flush(): void {
  flushTimer = undefined;
  const now = Date.now();
  // The latest state of each path wins (an update then a removal is a removal).
  const latest = new Map<string, Pending>();
  for (const entry of pending) {
    latest.delete(entry.path);
    latest.set(entry.path, entry);
  }
  const truncated = pendingTruncated;
  pending = [];
  pendingTruncated = false;
  const unique = [...latest.values()].filter((entry) => !isOwn(entry, now));
  const forOpen = openFile === null ? [] : unique.filter((entry) => entry.path === openFile!.path);
  for (const entry of forOpen)
    openFile?.onUpdate({
      path: entry.path,
      removed: entry.removed,
      ...(entry.revision === undefined ? {} : { revision: entry.revision }),
    });
  const rest = unique.filter((entry) => !forOpen.includes(entry));
  // A choice the person has not made yet is never replaced by a passing update.
  if (rest.length === 0 || current?.persistent === true) return;
  const updated = rest.filter((entry) => !entry.removed).map((entry) => name(entry.path));
  const removed = rest.filter((entry) => entry.removed).map((entry) => name(entry.path));
  emit({ id: nextId++, text: describe(updated, removed, truncated), paths: rest.map((entry) => entry.path) });
}

/** One `files` event from the service: gathered for a moment, then shown as one popup. */
export function announceFiles(event: FilesEvent): void {
  for (const entry of [...event.changed, ...event.added])
    pending.push({
      path: entry.path,
      ...(entry.revision === undefined ? {} : { revision: entry.revision }),
      removed: false,
    });
  for (const entry of event.removed) pending.push({ path: entry.path, removed: true });
  if (event.truncated) pendingTruncated = true;
  if (pending.length > MAX_ENTRIES * 4) pending = pending.slice(-MAX_ENTRIES * 4);
  if (flushTimer === undefined) flushTimer = setTimeout(flush, COALESCE_MS);
}

/**
 * The person's own save of `path` (project-relative): its echo stays quiet. With the file's exact
 * revision only that version is quiet; with null (an embedded block, whose note revision the page
 * does not know) the path is quiet for a few seconds.
 */
export function expectOwnWrite(path: string, revision: string | null): void {
  const now = Date.now();
  own = own.filter((write) => write.until > now && !(write.path === path && write.revision === revision)).slice(-31);
  own.push({ path, revision, until: now + OWN_WRITE_MS });
}

/** A new project stream: what was gathered for the previous one is not shown. */
export function clearPendingFileUpdates(): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  pending = [];
  pendingTruncated = false;
}

/** Lets the open file speak for its own updates (ADR 0028, open-file popup). Returns an unregister. */
export function watchOpenFile(
  path: string,
  onUpdate: (entry: { path: string; removed: boolean; revision?: string }) => void,
): () => void {
  const mine = { path, onUpdate };
  openFile = mine;
  return () => {
    if (openFile === mine) openFile = null;
  };
}

/** Shows a popup now (the open file's own message); a persistent one stays until acted on. */
export function showFilePopup(
  text: string,
  paths: readonly string[],
  choice?: { readonly actions: readonly FilePopupAction[] },
): void {
  emit({ id: nextId++, text, paths, ...(choice === undefined ? {} : { persistent: true, actions: choice.actions }) });
}
/** Whether a persistent choice is showing now. */
export function filePopupIsChoice(): boolean {
  return current?.persistent === true;
}
export function dismissFilePopup(): void {
  emit(null);
}
/** An editor leaving: its own persistent choice goes with it. */
export function dismissFilePopupFor(path: string): void {
  if (current?.persistent === true && current.paths.includes(path)) emit(null);
}

export function subscribeFileUpdates(listener: (state: FileUpdatesPopupState) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only. */
export function resetFileUpdates(): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  pending = [];
  pendingTruncated = false;
  own = [];
  current = null;
  openFile = null;
  listeners.clear();
}

const filesListeners = new Set<() => void>();
/** Called on every `files` event that parses: anything laid out ahead from the files is stale (the nested view's prefetch). */
export function onFilesChanged(listener: () => void): () => void {
  filesListeners.add(listener);
  return () => {
    filesListeners.delete(listener);
  };
}

/** Feeds a project stream's `files` events to the popup; every page with a project stream uses it. */
export function listenForFileUpdates(
  events: Pick<EventTarget, "addEventListener">,
  report: (error: unknown) => void = () => {},
): void {
  clearPendingFileUpdates();
  events.addEventListener("files", (event) => {
    try {
      const files = parseFilesEvent(JSON.parse((event as MessageEvent<string>).data));
      if (files !== null) {
        for (const listener of [...filesListeners]) listener();
        announceFiles(files);
      }
    } catch (error) {
      report(error);
    }
  });
}
