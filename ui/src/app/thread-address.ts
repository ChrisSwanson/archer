import { readBrowserRoute } from "./browser-routes";
import { readPageAddress } from "./page-address";
import { SEARCH_PARAMS } from "./file-index";
import { FOLDER_PARAM } from "./folder-link";

const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_SEARCH_CHARS = 16 * 1024;
const MAX_HREF_CHARS = 32 * 1024;

/** Read one thread identity from untrusted location search. */
export function readThreadAddress(search: string): string | null {
  if (typeof search !== "string" || search.length > MAX_SEARCH_CHARS) return null;
  try {
    const values = new URLSearchParams(search).getAll("thread");
    return values.length === 1 && THREAD_ID.test(values[0]!) ? values[0]! : null;
  } catch {
    return null;
  }
}

/** Add a thread identity only to a real note or diagram address, or a project's own page (its conversation). */
export function withThreadAddress(href: string, threadId: string): string | null {
  if (typeof href !== "string" || href.length > MAX_HREF_CHARS || !THREAD_ID.test(threadId)) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const route = readBrowserRoute(url.pathname, url.search, url.hash);
    if (route?.kind === "follow") {
      const address = readPageAddress(url.search, url.pathname);
      const destinations = [...url.searchParams.getAll("view"), ...url.searchParams.getAll("note")];
      if (
        (address?.kind !== "note" && address?.kind !== "view") ||
        destinations.length !== 1 ||
        url.searchParams.has(FOLDER_PARAM) ||
        url.searchParams.has("overview") ||
        url.searchParams.has("q") ||
        SEARCH_PARAMS.some((key) => url.searchParams.has(key))
      )
        return null;
    } else if (
      route?.kind !== "note" &&
      route?.kind !== "view" &&
      route?.kind !== "file" &&
      !(route?.kind === "browse" && route.folder === "")
    )
      return null;
    if (url.searchParams.has("thread")) return null;
    url.searchParams.set("thread", threadId);
    // `?follow` is a bare key: URLSearchParams would write it `follow=`.
    url.search = url.searchParams.toString().replace(/(^|&)follow=(?=&|$)/, "$1follow");
    return url.href;
  } catch {
    return null;
  }
}
