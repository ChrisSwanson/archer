import { runtime } from "./runtime.ts";
import { thumbnailFormat, thumbnailVersion } from "./thumbnail-version";
import { paintSourceDocument } from "./source-document-paint";
import { browserFetch } from "./browser-resource";
import { parseNoteContent } from "../comments/parse";
import { renderNoteMarkdown } from "../comments/markdown";
import { readArtifact } from "../export/download";
import { DEFAULT_SORT, fileRows, readSearchState, sortRows, type FileRow } from "./file-index";
import type { DiagramView } from "./inventory";
import { projectResourceBase } from "./browser-routes";

export type DocumentPreview =
  | { readonly kind: "diagram"; readonly src: string; readonly revision: string }
  | { readonly kind: "note"; readonly text: string; readonly source: "description" | "excerpt" }
  | { readonly kind: "unavailable"; readonly message: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type CacheablePreview = Exclude<DocumentPreview, { readonly kind: "unavailable" }>;
type QueueJob<T> = {
  readonly run: () => Promise<T>;
  readonly signal: AbortSignal;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  started: boolean;
};
type Flight = {
  readonly key: string;
  readonly controller: AbortController;
  readonly promise: Promise<DocumentPreview>;
  subscribers: number;
  settled: boolean;
};

export const MAX_PREVIEW_PENDING = 128;
export const MAX_PREVIEW_CACHE_ENTRIES = 48;
/** Cache accounting uses the retained UTF-16 data URL size, not SVG dimensions. */
export const MAX_PREVIEW_CACHE_BYTES = 8 * 1024 * 1024;
export const NOTE_EXCERPT_CHARS = 220;
const MAX_NOTE_SOURCE_CHARS = 1_048_576;
const MAX_NOTE_RENDER_CHARS = 4_096;
const SVG_DATA_PREFIX = "data:image/svg+xml;base64,";
const DEFAULT_FETCH: FetchLike = (url, init) => browserFetch(url, init);

let fetcherSequence = 0;
const fetcherIds = new WeakMap<FetchLike, number>();
const cache = new Map<string, { readonly value: CacheablePreview; readonly bytes: number }>();
const flights = new Map<string, Flight>();
const pending: QueueJob<unknown>[] = [];
let active = 0;
let cachedBytes = 0;

const unavailable = (message: string): DocumentPreview => ({ kind: "unavailable", message });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fetcherId(fetchImpl: FetchLike): number {
  const existing = fetcherIds.get(fetchImpl);
  if (existing !== undefined) return existing;
  const id = ++fetcherSequence;
  fetcherIds.set(fetchImpl, id);
  return id;
}

function projectPage(row: FileRow, baseUrl: string): string | null {
  return projectResourceBase(baseUrl, row.slug) ?? (row.current ? baseUrl : null);
}

/**
 * The service's thumbnail of a compiled diagram at its served model revision,
 * or null when the row has none to ask for (a note, a source document, a
 * failing diagram, or one that has never compiled and so has no `modelRevision`). The
 * address names one drawing exactly -- its revision, theme and the painter's
 * version (`thumbnail-version.ts`) -- so the browser's cache keeps it. A `png` service format adds
 * `&format=png`; `svg` is the address as it always was. Every
 * thumbnail ask (cards, `prefetchServiceThumbnails`, `fetchThumbnailsAhead`) spells it here, so one
 * drawing has one address and is fetched once.
 */
export function serviceThumbnailUrl(row: FileRow, baseUrl: string, theme: "light" | "dark"): string | null {
  if (row.kind !== "diagram" || row.failing || row.sourceDocumentPath !== undefined || row.modelRevision === undefined)
    return null;
  const pageUrl = projectPage(row, baseUrl);
  if (pageUrl === null) return null;
  try {
    // Without a known version the service redirects to the versioned address.
    const version = thumbnailVersion(),
      format = thumbnailFormat();
    const address = new URL(
      `api/thumbnails/${encodeURIComponent(row.id)}?rev=${row.modelRevision}&theme=${theme}${version === undefined ? "" : `&v=${version}`}${format === "svg" ? "" : `&format=${format}`}`,
      pageUrl,
    ).href;
    return runtime.resourceUrl ? runtime.resourceUrl(address) : address;
  } catch {
    return null;
  }
}

/**
 * A project's views in its Diagrams gallery's order (the page address's sort; newest edit first by
 * default), so the prefetch asks first for the cards that show first. Embedded diagrams have no card.
 */
export function galleryOrder<V extends DiagramView>(views: readonly V[], slug: string, search: string): V[] {
  const byId = new Map(views.map((view) => [view.id, view]));
  const rows = fileRows({ slug, name: "", views, notes: [], current: true }).filter((row) => row.kind === "diagram");
  return sortRows(rows, readSearchState(search)?.sort ?? DEFAULT_SORT).flatMap((row) => byId.get(row.id) ?? []);
}

/** How many thumbnails `prefetchServiceThumbnails` asks for at most: about two screens of cards. */
export const THUMBNAIL_PREFETCH_LIMIT = 24;
const prefetched = new Set<string>();
/**
 * Asks the browser for the current project's diagram thumbnails the moment its listing arrives, before
 * the cards that show them have rendered (perf #7): each card's `<img>` then names an address already in
 * the browser's image cache. The same addresses as `serviceThumbnailUrl`, so nothing is fetched twice.
 * The views at the first `firstScreen` places (`views` in the gallery's order: pass `galleryOrder`) go at
 * high priority. A card cannot
 * raise the priority of a request already made for it, so the prefetch must say it. Returns the
 * addresses asked for.
 */
export function prefetchServiceThumbnails(
  views: readonly { readonly id: string; readonly registration?: string; readonly modelRevision?: string }[],
  failing: ReadonlySet<string>,
  slug: string,
  baseUrl: string,
  theme: "light" | "dark",
  limit = THUMBNAIL_PREFETCH_LIMIT,
  firstScreen = 0,
): string[] {
  if (typeof Image === "undefined") return [];
  const asked: string[] = [];
  for (const [position, view] of views.entries()) {
    if (asked.length >= limit) break;
    if (failing.has(view.id)) continue;
    const url = serviceThumbnailUrl(
      {
        kind: "diagram",
        failing: false,
        slug,
        current: true,
        id: view.id,
        ...(view.modelRevision === undefined ? {} : { modelRevision: view.modelRevision }),
      } as FileRow,
      baseUrl,
      theme,
    );
    if (url === null || !claimThumbnail(url)) continue;
    const image = new Image();
    image.decoding = "async";
    if (position < firstScreen) image.fetchPriority = "high";
    image.src = url;
    asked.push(url);
  }
  return asked;
}
/**
 * Records that this page has asked for `url`; false when it already had. Every ahead-of-the-card ask
 * (`prefetchServiceThumbnails`, `fetchThumbnailsAhead`) claims its address first, so none is asked twice.
 */
export function claimThumbnail(url: string): boolean {
  if (prefetched.has(url)) return false;
  prefetched.add(url);
  return true;
}
/** For tests. */
export function forgetPrefetchedThumbnails(): void {
  prefetched.clear();
}

/** Includes all metadata hints but never mistakes `modifiedAt` for a source revision. */
export function documentPreviewKey(
  row: FileRow,
  baseUrl: string,
  theme: "light" | "dark",
  fetchImpl: FetchLike,
): string {
  let page: URL;
  try {
    page = new URL(projectPage(row, baseUrl) ?? "");
  } catch {
    return `${fetcherId(fetchImpl)}|invalid|${row.key}|${row.modifiedAt ?? ""}|${row.kind}|${row.type ?? ""}|${row.title}|${row.failing}|${theme}`;
  }
  return [
    fetcherId(fetchImpl),
    page.origin,
    page.pathname,
    row.key,
    row.modifiedAt ?? "",
    row.kind,
    row.type ?? "",
    row.title,
    row.failing,
    row.description ?? "",
    theme,
  ].join("\0");
}

function touch(key: string): { readonly value: CacheablePreview; readonly bytes: number } | undefined {
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function retainedSize(value: CacheablePreview): number {
  return value.kind === "diagram" ? value.src.length * 2 : value.text.length * 2;
}

function remember(key: string, value: CacheablePreview): boolean {
  const bytes = retainedSize(value);
  if (bytes > MAX_PREVIEW_CACHE_BYTES) return false;
  const prior = cache.get(key);
  if (prior !== undefined) {
    cachedBytes -= prior.bytes;
    cache.delete(key);
  }
  while (cache.size >= MAX_PREVIEW_CACHE_ENTRIES || cachedBytes + bytes > MAX_PREVIEW_CACHE_BYTES) {
    const oldest = cache.entries().next().value as
      | [string, { readonly value: CacheablePreview; readonly bytes: number }]
      | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest[0]);
    cachedBytes -= oldest[1].bytes;
  }
  cache.set(key, { value, bytes });
  cachedBytes += bytes;
  return true;
}

function abortError(): Error {
  return new DOMException("Preview request was cancelled.", "AbortError");
}

function schedule<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    if (pending.length >= MAX_PREVIEW_PENDING) {
      reject(new Error("The preview queue is full; this thumbnail could not be loaded."));
      return;
    }
    const job: QueueJob<T> = { run, signal, resolve, reject, started: false };
    const cancelled = (): void => {
      if (job.started) return;
      const index = pending.indexOf(job as QueueJob<unknown>);
      if (index >= 0) pending.splice(index, 1);
      reject(abortError());
      pump();
    };
    signal.addEventListener("abort", cancelled, { once: true });
    pending.push(job as QueueJob<unknown>);
    pump();
  });
}

function pump(): void {
  while (active < 2 && pending.length > 0) {
    const job = pending.shift()!;
    if (job.signal.aborted) {
      job.reject(abortError());
      continue;
    }
    job.started = true;
    active++;
    void job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

function subscribe(flight: Flight, signal?: AbortSignal): Promise<DocumentPreview> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  flight.subscribers++;
  return new Promise((resolve, reject) => {
    let subscribed = true;
    const release = (): void => {
      if (!subscribed) return;
      subscribed = false;
      signal?.removeEventListener("abort", cancelled);
      flight.subscribers--;
      if (flight.subscribers === 0 && !flight.settled) {
        flight.controller.abort();
        // Do not let a new subscriber inherit an already-cancelled request
        // while an abort-ignoring fetch implementation is still settling.
        if (flights.get(flight.key) === flight) flights.delete(flight.key);
      }
    };
    const cancelled = (): void => {
      release();
      reject(abortError());
    };
    signal?.addEventListener("abort", cancelled, { once: true });
    flight.promise.then(
      (value) => {
        if (!subscribed) return;
        release();
        resolve(value);
      },
      (error: unknown) => {
        if (!subscribed) return;
        release();
        reject(error);
      },
    );
  });
}

async function jsonResponse(fetchImpl: FetchLike, url: string, init: RequestInit, what: string): Promise<unknown> {
  const response = await fetchImpl(url, { cache: "no-store", ...init });
  let value: unknown;
  try {
    value = (await response.json()) as unknown;
  } catch {
    throw new Error(`${what} returned unreadable data.`);
  }
  if (!response.ok) throw new Error(`${what} is unavailable (HTTP ${response.status}).`);
  return value;
}

function noteExcerpt(markdown: string): string {
  const html = renderNoteMarkdown(markdown.slice(0, MAX_NOTE_RENDER_CHARS));
  const document = new DOMParser().parseFromString(html, "text/html");
  const text = (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
  let result = text.slice(0, NOTE_EXCERPT_CHARS).trimEnd();
  if (text.length > result.length) {
    // Do not leave a lone high surrogate at the cut.
    if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
    result += "…";
  }
  return result;
}

async function readNote(
  row: FileRow,
  pageUrl: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<DocumentPreview> {
  const url = new URL(`api/notes/content?${new URLSearchParams({ path: row.id }).toString()}`, pageUrl).href;
  const raw = await jsonResponse(fetchImpl, url, { method: "GET", signal }, "Note preview");
  if (
    !isRecord(raw) ||
    typeof raw.markdown !== "string" ||
    raw.markdown.length > MAX_NOTE_SOURCE_CHARS ||
    (Array.isArray(raw.diagrams) && raw.diagrams.length > 256)
  ) {
    return unavailable("Note preview is too large or unreadable.");
  }
  const note = parseNoteContent(raw);
  if (note === undefined || note.path !== row.id) return unavailable("Note preview is unavailable.");
  const text = noteExcerpt(note.markdown);
  return text === "" ? unavailable("No note text is available to preview.") : { kind: "note", source: "excerpt", text };
}

async function readDiagram(
  row: FileRow,
  pageUrl: string,
  theme: "light" | "dark",
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<DocumentPreview> {
  const url = new URL("api/operations", pageUrl).href;
  const raw = await jsonResponse(
    fetchImpl,
    url,
    {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "export_diagram",
        arguments: { viewId: row.id, format: "svg", mode: "diagram", theme, scale: 1, allowLastGood: false },
      }),
    },
    "Diagram thumbnail",
  );
  if (
    !isRecord(raw) ||
    typeof raw.revision !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(raw.revision) ||
    raw.lastGood !== false ||
    typeof raw.data !== "string" ||
    raw.data.length * 2 + SVG_DATA_PREFIX.length * 2 > MAX_PREVIEW_CACHE_BYTES
  ) {
    return unavailable("A current, small diagram export is unavailable.");
  }
  try {
    // The revision belongs to the export response itself. `modifiedAt` is only a cache hint, never a revision.
    const artifact = readArtifact(raw, "svg", raw.revision);
    if (!atob(artifact.data).trimStart().startsWith("<svg")) {
      return unavailable("The diagram export was not a readable SVG.");
    }
    const preview: CacheablePreview = {
      kind: "diagram",
      src: `${SVG_DATA_PREFIX}${artifact.data}`,
      revision: artifact.revision,
    };
    return retainedSize(preview) > MAX_PREVIEW_CACHE_BYTES
      ? unavailable("The diagram export is too large for a gallery thumbnail.")
      : preview;
  } catch {
    return unavailable("The diagram export is invalid or oversized.");
  }
}

async function readSourcePreview(
  row: FileRow,
  pageUrl: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<DocumentPreview> {
  const raw = await jsonResponse(
    fetchImpl,
    new URL(`api/documents/content?${new URLSearchParams({ path: row.sourceDocumentPath! })}`, pageUrl).href,
    { method: "GET", signal },
    "Document preview",
  );
  if (
    !isRecord(raw) ||
    !isRecord(raw.source) ||
    raw.source.path !== row.sourceDocumentPath ||
    typeof raw.revision !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(raw.revision)
  )
    return unavailable("Document preview is unavailable.");
  if (row.kind === "note") {
    if (typeof raw.markdown !== "string" || raw.markdown.length > MAX_NOTE_SOURCE_CHARS)
      return unavailable("Note preview is too large or unreadable.");
    const text = noteExcerpt(raw.markdown);
    return text === ""
      ? unavailable("No note text is available to preview.")
      : { kind: "note", source: "excerpt", text };
  }
  const drawing = await paintSourceDocument(raw, row.title);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${drawing.width}" height="${drawing.height}" viewBox="${drawing.originX} ${drawing.originY} ${drawing.width} ${drawing.height}">${drawing.content}</svg>`;
  if (svg.length * 4 > MAX_PREVIEW_CACHE_BYTES)
    return unavailable("This preview is too large to keep in the gallery cache.");
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { kind: "diagram", src: SVG_DATA_PREFIX + btoa(binary), revision: raw.revision };
}

async function fetchPreview(
  row: FileRow,
  pageUrl: string,
  theme: "light" | "dark",
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<DocumentPreview> {
  try {
    if (row.sourceDocumentPath !== undefined) return await readSourcePreview(row, pageUrl, fetchImpl, signal);
    return row.kind === "diagram"
      ? await readDiagram(row, pageUrl, theme, fetchImpl, signal)
      : await readNote(row, pageUrl, fetchImpl, signal);
  } catch (error) {
    if (signal.aborted) throw abortError();
    return unavailable(error instanceof Error ? error.message : "Preview is unavailable.");
  }
}

/**
 * Fetches one bounded gallery preview. Work is globally limited to two active
 * requests and 128 queued requests; successful previews use a 48-entry / 8 MiB
 * LRU keyed by fetcher, service/project URL, row identity and freshness hints.
 */
export function loadDocumentPreview(
  row: FileRow,
  baseUrl: string,
  theme: "light" | "dark",
  fetchImpl: FetchLike = DEFAULT_FETCH,
  signal?: AbortSignal,
): Promise<DocumentPreview> {
  if (row.kind === "diagram" && row.failing)
    return Promise.resolve(unavailable("This diagram does not compile; no thumbnail was requested."));
  if (row.kind === "note" && row.description !== undefined) {
    const text = row.description.slice(0, NOTE_EXCERPT_CHARS).trim();
    return Promise.resolve(
      text === "" ? unavailable("No note description is available.") : { kind: "note", text, source: "description" },
    );
  }
  if (signal?.aborted === true) return Promise.reject(abortError());
  const pageUrl = projectPage(row, baseUrl);
  if (pageUrl === null) return Promise.resolve(unavailable("This project's page address is unavailable."));

  const key = documentPreviewKey(row, baseUrl, theme, fetchImpl);
  const saved = touch(key);
  if (saved !== undefined) return Promise.resolve(saved.value);

  let flight = flights.get(key);
  if (flight === undefined) {
    const controller = new AbortController();
    const promise = schedule(() => fetchPreview(row, pageUrl, theme, fetchImpl, controller.signal), controller.signal)
      .then((preview) => {
        if (!controller.signal.aborted && preview.kind !== "unavailable" && !remember(key, preview)) {
          return unavailable("This preview is too large to keep in the gallery cache.");
        }
        return preview;
      })
      .finally(() => {
        const current = flights.get(key);
        if (current?.controller === controller) flights.delete(key);
      });
    flight = { key, controller, promise, subscribers: 0, settled: false };
    flights.set(key, flight);
    void promise
      .finally(() => {
        flight!.settled = true;
      })
      .catch(() => undefined);
  }
  return subscribe(flight, signal);
}

/** The description is already part of the project index; this path never fetches note content. */
export function noteDescriptionPreview(description: string): DocumentPreview {
  const text = description.slice(0, NOTE_EXCERPT_CHARS).trim();
  return text === "" ? unavailable("No note description is available.") : { kind: "note", text, source: "description" };
}
