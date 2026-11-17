/** The grammar stays shared with the HTTP service; only public document addressing varies. */
export { isProjectSlug, type BrowserRoute } from "../../../shared/browser-routes.mts";
import {
  browserRoutePath as logicalRoutePath,
  readBrowserRoute as readLogicalRoute,
  projectResourceBase as logicalResourceBase,
  type BrowserRoute,
} from "../../../shared/browser-routes.mts";
import { decodeAddress, encodeAddress } from "../runtime/address.ts";

/** Links use the selected document codec; their logical Archer grammar is unchanged. */
export function browserRoutePath(route: BrowserRoute): string | null {
  const path = logicalRoutePath(route);
  if (path === null) return null;
  const encoded = encodeAddress(path);
  if (encoded === path) return path;
  const url = new URL(encoded);
  return url.pathname + url.search + url.hash;
}

export function readBrowserRoute(pathname: string, search?: string, hash?: string): BrowserRoute | null {
  const logical = readLogicalRoute(pathname, search ?? "", hash ?? "");
  if (logical !== null) return logical;
  const sameDocument = typeof window !== "undefined" && window.location?.pathname === pathname;
  const input =
    pathname +
    (search ?? (sameDocument ? window.location.search : "")) +
    (hash ?? (sameDocument ? window.location.hash : ""));
  const decoded = decodeAddress(input);
  if (decoded === input) return null;
  const url = new URL(decoded, "https://address.invalid");
  return readLogicalRoute(url.pathname, url.search, url.hash);
}

export function projectResourceBase(href: string, slug?: string): string | null {
  return logicalResourceBase(decodeAddress(href), slug);
}

/** The route the page's location names; the search and hash default to the window's own. */
export function readLocationRoute(pathname: string, search?: string, hash?: string): BrowserRoute | null {
  const sameDocument = typeof window !== "undefined" && window.location?.pathname === pathname;
  return readBrowserRoute(
    pathname,
    search ?? (sameDocument ? window.location.search : ""),
    hash ?? (sameDocument ? window.location.hash : ""),
  );
}

/**
 * Where the old standalone editor address for an existing diagram (`-/edit/?viewId=`) now opens it: in place, on
 * its reading address with `?edit`; the draft, its checkpoint and the Source pane travel with it. Null for any
 * other address. The entry (`main.tsx`) takes it before anything reads, in the same page load.
 */
export function legacyEditAddress(href: string): string | null {
  const url = new URL(decodeAddress(href)),
    route = readLocationRoute(url.pathname, url.search, url.hash),
    viewId = url.searchParams.get("viewId");
  if (route?.kind !== "edit" || viewId === null) return null;
  // A file path (`diagrams/flow.mmd`) lands on the diagram's canonical file address; a view id whose file is
  // unknown, on the follow page naming it (`?follow&view=<id>`), which keeps its query after `?edit`.
  const file = viewId.endsWith(".mmd") ? viewId : undefined;
  const path = logicalRoutePath(
    file !== undefined
      ? { kind: "view", projectSlug: route.projectSlug, viewId: file.split("/").at(-1)!.slice(0, -4), sourcePath: file }
      : { kind: "view", projectSlug: route.projectSlug, viewId },
  );
  if (path === null) return null;
  const draftId = url.searchParams.get("draftId"),
    checkpoint = url.searchParams.get("checkpoint");
  const kept = [
    draftId !== null && /^drf_[a-f0-9]{32}$/u.test(draftId) ? `draftId=${draftId}` : null,
    checkpoint === "draft" || checkpoint === "document" ? `checkpoint=${checkpoint}` : null,
    url.searchParams.has("source") ? "source" : null,
  ].filter((part): part is string => part !== null);
  const [bare, own] = path.includes("?")
    ? [path.slice(0, path.indexOf("?")), path.slice(path.indexOf("?") + 1)]
    : [path, ""];
  const rest = [...(own === "" ? [] : [own]), ...kept];
  return encodeAddress(`${bare}?edit${rest.length ? `&${rest.join("&")}` : ""}`);
}

/** A project document's address: its clean path, or `-/repo/` when an Archer-folder file shadows it. */
export function documentRoute(projectSlug: string, path: string, shadowed: boolean): BrowserRoute {
  return shadowed ? { kind: "document", projectSlug, path } : { kind: "file", projectSlug, path };
}
/** Where a file row opens: its note, its diagram (by its file when known), or its document. */
export function rowRoute(row: {
  readonly slug: string;
  readonly kind: "diagram" | "note";
  readonly id: string;
  readonly path: string;
  readonly sourceDocumentPath?: string;
  readonly sourceDocumentShadowed?: true;
}): BrowserRoute {
  if (row.sourceDocumentPath !== undefined)
    return documentRoute(row.slug, row.sourceDocumentPath, row.sourceDocumentShadowed === true);
  if (row.kind === "note") return { kind: "note", projectSlug: row.slug, path: row.id };
  return {
    kind: "view",
    projectSlug: row.slug,
    viewId: row.id,
    ...(row.path.endsWith(".mmd") ? { sourcePath: row.path } : {}),
  };
}
