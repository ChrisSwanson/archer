/**
 * What a page address names, read by the page's own reader (`src/app/page-address.ts`), so a
 * test asserts the place and the filters rather than one spelling of the address.
 */
import { readPageAddress, type PageAddress } from "../../../src/app/page-address";
import type { SearchState } from "../../../src/app/file-index";
import { readBrowserRoute, type BrowserRoute } from "../../../../shared/browser-routes.mts";

export function placeOf(href: string): PageAddress | null {
  const url = new URL(href);
  return readPageAddress(url.search, url.pathname, { hash: url.hash });
}

/** The search page an address names, or null. */
export function searchOf(href: string): SearchState | null {
  const place = placeOf(href);
  return place?.kind === "search" ? place.state : null;
}

export function routeOf(href: string): BrowserRoute | null {
  const url = new URL(href);
  return readBrowserRoute(url.pathname, url.search, url.hash);
}

/** A project's clean browser address, from any of its page URLs. */
export function projectPath(href: string): string {
  const url = new URL(href);
  const name = /\/(?:projects|p)\/([^/]+)\//.exec(url.pathname)?.[1];
  return `/projects/${name}/`;
}
