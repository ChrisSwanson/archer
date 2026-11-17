import { runtime } from "./runtime.ts";
import { projectResourceBase, readBrowserRoute } from "./browser-routes";
/** Only our document-relative API names are rebased; external links retain their meaning. */
export function browserResourceUrl(path: string, href?: string): string {
  if (!path.startsWith("api/")) return path;
  const location = href ?? (typeof window === "undefined" ? undefined : window.location?.href);
  if (location === undefined) return path;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return path;
  }
  const route = readBrowserRoute(url.pathname);
  // Every page, the follow address included, reads its project at /p/<name>/, not at its own nested path.
  if (route === null) return path;
  const base = route.kind === "projects" ? `${url.origin}/` : projectResourceBase(url.href);
  return base === null ? path : new URL(path, base).href;
}
/** How long a read the browser dropped unanswered waits before it is asked the once more. */
export const DROPPED_READ_RETRY_MS = 250;
/**
 * A request the browser failed without an answer (fetch rejects with a TypeError, "Failed to fetch").
 * Chromium does this to every request in flight when the host's network changes
 * (net::ERR_NETWORK_CHANGED, loopback included: a container starting adds an interface; E11).
 * An abort the page asked for is an AbortError, and an answer of any status is an answer: neither is this.
 * Nor is an address that does not parse (also a TypeError): that request never left, and asking again changes nothing.
 */
function unanswered(error: unknown): boolean {
  return error instanceof TypeError && !/parse URL/i.test(error.message);
}
/**
 * Told when a write (any method but GET/HEAD) the page sent through browserFetch got no answer at all: fetch's own
 * TypeError, not a cancel the page asked for. That is the same evidence of a lost connection as a failed read, and
 * the connection monitor (`http-connection.ts`) checks it the same way (user-flows v1.1 J8a, O68). An answer of
 * any status is an answer and says nothing here.
 */
const unansweredWriteListeners = new Set<() => void>();
export function onUnansweredWrite(listener: () => void): () => void {
  unansweredWriteListeners.add(listener);
  return () => {
    unansweredWriteListeners.delete(listener);
  };
}
function reportUnansweredWrite(): void {
  for (const listener of [...unansweredWriteListeners]) {
    try {
      listener();
    } catch {
      /* a listener's fault is not the write's */
    }
  }
}
/**
 * The page's fetch of its own resources. A read (GET or HEAD) the browser dropped unanswered is asked
 * once more after a moment, so a blip does not leave a panel saying it could not read; when that ask
 * fails too, the failure is the caller's to report. A write is never repeated: it may have arrived.
 */
export async function browserFetch(url: string, init?: RequestInit): Promise<Response> {
  const resolved = browserResourceUrl(url);
  try {
    return await runtime.request(resolved, init);
  } catch (error) {
    const method = (init?.method ?? "GET").toUpperCase();
    const read = method === "GET" || method === "HEAD";
    if (!read && unanswered(error) && !init?.signal?.aborted) reportUnansweredWrite();
    if (!unanswered(error) || !read || init?.signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, DROPPED_READ_RETRY_MS));
    return runtime.request(resolved, init);
  }
}
