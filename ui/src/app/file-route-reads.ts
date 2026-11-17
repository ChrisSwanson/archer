/**
 * The listings the file route reads before the project page boots (`file-route.ts`), held in the page's read layer
 * (`resources.ts`) so that page's first read of the same listing takes the answer instead of asking the service
 * again. Its own module so the project page's readers (`http-connection.ts`, `contents-notes.ts`) can import it
 * without importing the route, which imports them.
 */
import { bodyOf, eventSeqOf, type ResourcePolicy, resources } from "./resources";

export { eventSeqOf };
/** How long a listing read here may be handed to the project page instead of read again. */
export const FILE_ROUTE_HANDOFF_MS = 3_000;

const parse = (raw: unknown, response: Response): unknown => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return raw;
};
/**
 * A listing's policy: never fresh, so the route's own reads join one in flight (opens of one file at once, React's
 * development double mount) but never take an answer already held, which is the project page's to take.
 */
const listingPolicy = (url: string): ResourcePolicy<unknown> => ({
  kind: /\/api\/diagrams\/./.test(url)
    ? "view"
    : /\/api\/notes\//.test(url)
      ? "notes"
      : /\/api\/documents/.test(url)
        ? "documents"
        : "inventory",
  freshMs: 0,
  parse,
});

export async function readListing(url: string, signal: AbortSignal): Promise<unknown> {
  return bodyOf(await resources.read(url, listingPolicy(url), { signal }));
}

/**
 * The answer this route just read from `url` (absolute: `api/diagrams` or `api/notes/all` under the
 * project's resource base), once, while it is under `FILE_ROUTE_HANDOFF_MS` old: the project page's
 * first read of the same listing takes it instead of asking the service a second time on one load.
 */
export function takeFileRouteRead(url: string, now = Date.now()): Promise<unknown> | undefined {
  const entry = takeFileRouteEntry(url, now);
  return entry === undefined ? undefined : Promise.resolve(entry.body);
}

export type FileRouteEntry = { readonly body: unknown; readonly seq: number | null; readonly etag: string | null };

/** `takeFileRouteRead`, with the publication count the listing was answered at and its ETag. */
export function takeFileRouteEntry(url: string, now = Date.now()): FileRouteEntry | undefined {
  const answer = resources.take(url);
  return answer === undefined || now - answer.at > FILE_ROUTE_HANDOFF_MS
    ? undefined
    : { body: answer.body, seq: answer.seq, etag: answer.etag };
}

/** Whether this route is still reading `url`. */
export function fileRouteReading(url: string): boolean {
  return resources.flight(url) !== undefined;
}

/**
 * `takeFileRouteEntry`, also joining a read of `url` this route still has in flight (the open diagram, read
 * ahead while the page boots): one request on the load, not two. Undefined when there is none, or it failed.
 */
export async function awaitFileRouteEntry(url: string): Promise<FileRouteEntry | undefined> {
  try {
    await resources.flight(url);
  } catch {
    return undefined;
  }
  return takeFileRouteEntry(url);
}

/**
 * Starts reading `url` now, for the project page to take (`awaitFileRouteEntry`): its own deadline, since the
 * route's reads are cancelled once the route is decided. A failure is left for the page's own read to meet.
 */
export function readAhead(url: string, deadlineMs = 10_000): void {
  if (resources.flight(url) !== undefined || resources.peek(url) !== undefined) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  void readListing(url, controller.signal)
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}

/** Tests only: forget every read. */
export function forgetFileRouteReads(): void {
  resources.forget();
}
