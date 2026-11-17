import { browserFetch, browserResourceUrl } from "./browser-resource";
import { takeFileRouteRead } from "./file-route";
/**
 * The project's notes, for the contents page.
 *
 * Every note at once from `GET api/notes/all` (phase 3b), with the views each
 * is about -- so a note about no diagram is in the Notes group from the
 * start, not only once the filter finds it. When that read fails, the notes
 * already shown stay. Nothing is asked while the service has not said it has notes.
 */
import { useEffect, useState } from "react";
import type { ReviewEvents } from "../comments/events";
import type { ContentsNote } from "./contents";
import { parseFileFacts } from "./file-facts";
import { parseThreadCounts } from "./inventory";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function readJson(fetchImpl: FetchLike, url: string, signal?: AbortSignal): Promise<unknown> {
  // A read nobody is waiting for any more is not made: a page that moved on
  // (or a test that ended) does not keep asking.
  if (signal?.aborted === true) throw new Error(`${url} was not read: the page moved on`);
  const response = await fetchImpl(url, { cache: "no-store", ...(signal === undefined ? {} : { signal }) });
  if (!response.ok) throw new Error(`${url} failed with HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** `api/notes/all`'s answer, or `null` when it is not one. */
export function parseAllNotes(raw: unknown): ContentsNote[] | null {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { notes?: unknown }).notes)) return null;
  const notes: ContentsNote[] = [];
  for (const entry of (raw as { notes: unknown[] }).notes) {
    if (typeof entry !== "object" || entry === null) return null;
    const { path, title, type, status, viewIds } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof title !== "string" || !isStrings(viewIds)) return null;
    const threads = parseThreadCounts((entry as Record<string, unknown>).threads);
    notes.push({
      path,
      title,
      ...(typeof type === "string" ? { type } : {}),
      ...(typeof status === "string" ? { status } : {}),
      viewIds,
      ...(threads === undefined ? {} : { threads }),
      ...parseFileFacts(entry as Record<string, unknown>),
    });
  }
  return notes;
}

/** Every note, from the project's listing; a read that fails or is not one rejects. */
export async function loadContentsNotes(fetchImpl: FetchLike, signal?: AbortSignal): Promise<ContentsNote[]> {
  const listed = parseAllNotes(await readJson(fetchImpl, "api/notes/all", signal));
  if (listed === null) throw new Error("api/notes/all answered something that is not a note listing");
  return listed;
}

/**
 * The notes, read while `enabled` and read again whenever the registry or the
 * notes change, or the stream comes back. `[]` while unread: a contents page
 * with its diagrams and no notes yet is still true. `loaded` once the first
 * listing has answered (or failed).
 */
export function useContentsNotes(
  viewIds: readonly string[],
  enabled: boolean,
  events: ReviewEvents,
  // The file route's `api/notes/all`, read a moment ago to pick this page, is taken once instead of read again.
  fetchImpl: FetchLike = (url, init) => {
    const handed = takeFileRouteRead(browserResourceUrl(url));
    return handed === undefined ? browserFetch(url, init) : handed.then((body) => Response.json(body));
  },
): { readonly notes: readonly ContentsNote[]; readonly loaded: boolean } {
  const [notes, setNotes] = useState<readonly ContentsNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [asked, setAsked] = useState(0);
  const key = viewIds.join("\n");

  useEffect(
    () =>
      events.subscribe((event) => {
        if (event.type === "notes" || event.type === "comments" || event.type === "reconnect") setAsked((n) => n + 1);
      }),
    [events],
  );

  useEffect(() => {
    if (!enabled) return;
    const reading = new AbortController();
    // The registry (`key`) changing asks again: a new diagram may be what a note is about.
    void loadContentsNotes(fetchImpl, reading.signal).then(
      (next) => {
        if (!reading.signal.aborted) {
          setNotes(next);
          setLoaded(true);
        }
      },
      () => {
        // The notes already shown stay; the next notes event or reconnect asks again.
        if (!reading.signal.aborted) setLoaded(true);
      },
    );
    return () => reading.abort();
    // `fetchImpl` is a test seam, fixed for the life of a page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, asked]);

  return enabled ? { notes, loaded } : { notes: NONE, loaded: false };
}
const NONE: readonly ContentsNote[] = [];
