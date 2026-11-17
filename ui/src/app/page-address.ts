/**
 * The page's address: what a reload, a shared link, and Back and Forward
 * open (`shared/browser-routes.mts`, ADR 0017). One place at most:
 *
 * - `/projects/<name>/<path>`, a file: an Archer-folder note, else the
 *   standalone diagram whose file it is (a view id is never an address);
 * - `/projects/<name>/<note path>#<name>`, a diagram embedded in that note
 *   (its view id, ADR 0012);
 * - `/projects/<name>/<folder>/…/` and `/projects/<name>/`, the project
 *   browser at that folder, with its search and filters in the query
 *   (`file-index.ts`);
 * - `/projects/<name>/?follow`, nothing named: the page shows what the agent
 *   presents. There the query destinations (`?view=`, `?note=`, `?folder=`,
 *   `?overview=1`, `?q=`) name places, and the page replaces them with the
 *   canonical address once it knows its files; `?view=<id>` is the address of a
 *   diagram whose file is not known.
 *
 * `App.tsx` writes the address when the page goes somewhere (see THE PAGE'S
 * ADDRESS there); `project-directory.ts` builds the same one for another
 * project.
 */
import { FOLDER_PARAM, readFolderLink } from "./folder-link";
import { readSearchState, SEARCH_PARAMS, searchKey, writeSearchState, type SearchState } from "./file-index";
import { readBrowserRoute, type BrowserRoute } from "./browser-routes";
import { browserRoutePath } from "../../../shared/browser-routes.mts";
import { decodeAddress, encodeAddress } from "../runtime/address.ts";

export type PageAddress =
  | { readonly kind: "view"; readonly viewId: string }
  | { readonly kind: "note"; readonly path: string }
  /** A null path is a `?folder=` that names no folder; it is read, never written. */
  | { readonly kind: "folder"; readonly path: string | null }
  | { readonly kind: "overview" }
  | { readonly kind: "search"; readonly state: SearchState }
  /** A file the page cannot yet name as a note or a diagram: its files are not known yet. */
  | { readonly kind: "file"; readonly path: string };

/** What the page knows of its project's files: enough to turn a file path into a place and back. */
export type ProjectFiles = {
  readonly views: readonly { readonly id: string; readonly sourcePath?: string; readonly registration?: string }[];
  readonly notes?: readonly { readonly path: string }[];
};

const DESTINATIONS = ["thread", "view", "note", FOLDER_PARAM, "overview", "follow", ...SEARCH_PARAMS] as const;

const fileOf = (sourcePath: string | undefined): string | undefined => sourcePath?.replace(/^\.\//, "");

/** The standalone diagram whose file is `path`. */
function viewAt(files: ProjectFiles | undefined, path: string): string | undefined {
  return files?.views.find((view) => view.registration !== "embedded" && fileOf(view.sourcePath) === path)?.id;
}
/** The file of a standalone diagram. */
function fileOfView(files: ProjectFiles | undefined, viewId: string): string | undefined {
  const view = files?.views.find((candidate) => candidate.id === viewId && candidate.registration !== "embedded");
  return fileOf(view?.sourcePath);
}

/** The place a file address names: a note before a diagram (`.archer` wins; documents are another page). */
function fileAddress(path: string, fragment: string | undefined, files: ProjectFiles | undefined): PageAddress {
  if (fragment !== undefined) return { kind: "view", viewId: `${path}#${fragment}` };
  if (files?.notes?.some((note) => note.path === path)) return { kind: "note", path };
  const view = viewAt(files, path);
  if (view !== undefined) return { kind: "view", viewId: view };
  return path.endsWith(".md") ? { kind: "note", path } : { kind: "file", path };
}

export type ReadOptions = { readonly hash?: string; readonly files?: ProjectFiles };

/** The address opens the search page: its words, `q` (a bare project or folder does not). */
export function searchAddressed(search_: string): boolean {
  return new URLSearchParams(search_).has("q");
}

/** The destination the address names, or null for one that follows the agent. Read in the order the page opens them. */
export function readPageAddress(search_: string, pathname?: string, options: ReadOptions = {}): PageAddress | null {
  const query = new URLSearchParams(search_);
  const route = pathname === undefined ? null : readBrowserRoute(pathname, search_, options.hash ?? "");
  if (route?.kind === "view") return { kind: "view", viewId: route.viewId };
  if (route?.kind === "note") return { kind: "note", path: route.path };
  if (route?.kind === "file") return fileAddress(route.path, route.fragment, options.files);
  if (route?.kind === "browse" || route?.kind === "projects") {
    query.set("q", query.get("q") ?? "");
    const state = readSearchState(`?${query}`)!;
    return {
      kind: "search",
      state:
        route.kind === "projects"
          ? state
          : { ...state, projects: [route.projectSlug], folder: route.folder === "" ? null : route.folder },
    };
  }
  const view = query.get("view");
  if (view !== null) return { kind: "view", viewId: view };
  const note = query.get("note");
  if (note !== null) return { kind: "note", path: note };
  const folder = readFolderLink(search_);
  if (folder !== null) return { kind: "folder", path: folder.path };
  if (query.get("overview") === "1") return { kind: "overview" };
  const search = readSearchState(search_);
  if (search !== null) return { kind: "search", state: search };
  return null;
}

/** The window's own address, read against what the page knows of its files. */
export function readLocationAddress(files?: ProjectFiles): PageAddress | null {
  return readPageAddress(window.location.search, window.location.pathname, {
    hash: window.location.hash,
    ...(files === undefined ? {} : { files }),
  });
}

/** Equal when the two name the same place. */
export function sameAddress(a: PageAddress | null, b: PageAddress | null): boolean {
  return addressKey(a) === addressKey(b);
}

export function addressKey(address: PageAddress | null): string {
  if (address === null) return "";
  switch (address.kind) {
    case "view":
      return `view:${address.viewId}`;
    case "note":
      return `note:${address.path}`;
    case "folder":
      return `folder:${address.path ?? "\0"}`;
    case "overview":
      return "overview";
    case "search":
      return `search:${searchKey(address.state)}`;
    case "file":
      return `file:${address.path}`;
  }
}

/** The route of `address` in project `slug`, or null when it names no writable place. */
function placeRoute(slug: string, address: PageAddress, files: ProjectFiles | undefined): BrowserRoute | null {
  switch (address.kind) {
    case "view": {
      const sourcePath = fileOfView(files, address.viewId);
      return {
        kind: "view",
        projectSlug: slug,
        viewId: address.viewId,
        ...(sourcePath === undefined ? {} : { sourcePath }),
      };
    }
    case "note":
      return { kind: "note", projectSlug: slug, path: address.path };
    case "file":
      return { kind: "file", projectSlug: slug, path: address.path };
    case "folder":
      return address.path === null ? null : { kind: "browse", projectSlug: slug, folder: address.path };
    case "overview":
      return { kind: "browse", projectSlug: slug, folder: "" };
    case "search":
      return null;
  }
}

/** The search page `state` names as its own page: a project's browser, or all projects. A navigation, not an in-place write. */
export function searchPageHref(href: string, state: SearchState): string {
  const url = new URL(decodeAddress(href));
  const path =
    state.projects.length === 1
      ? browserRoutePath({ kind: "browse", projectSlug: state.projects[0]!, folder: state.folder ?? "" })
      : "/projects/";
  url.pathname = path ?? "/projects/";
  url.search = "";
  url.hash = "";
  // A project's or all projects' own page is a search with or without words: no empty `q`.
  writeSearchState(url, state);
  if (state.query === "") url.searchParams.delete("q");
  if (state.projects.length === 1) {
    url.searchParams.delete("project");
    url.searchParams.delete("under");
  }
  return encodeAddress(url.href);
}

/** `href` naming `address` and no other destination; anything else in it stays. */
export function withPageAddress(href: string, address: PageAddress, files?: ProjectFiles): string {
  const url = new URL(decodeAddress(href));
  const route = readBrowserRoute(url.pathname);
  // A search across projects, or scoped to another project, shown in place on a project's clean
  // page stays on that project's follow address, in the query: the page keeps its project (and its
  // resources), as the legacy follow page did. Going to another project's or all projects' page is
  // a navigation (`searchPageHref`).
  const clean = readBrowserRoute(url.pathname, url.search);
  if (
    clean !== null &&
    clean.kind !== "projects" &&
    address.kind === "search" &&
    !(address.state.projects.length === 1 && address.state.projects[0] === clean.projectSlug)
  ) {
    url.pathname = `/projects/${clean.projectSlug}/`;
    url.search = "";
    url.hash = "";
    writeSearchState(url, address.state);
    url.search = `?follow&${url.searchParams.toString()}`;
    return encodeAddress(url.href);
  }
  if (route !== null) {
    const slug = route.kind === "projects" ? null : route.projectSlug;
    let path: string | null = null;
    if (address.kind === "search")
      path =
        address.state.projects.length === 1
          ? browserRoutePath({
              kind: "browse",
              projectSlug: address.state.projects[0]!,
              folder: address.state.folder ?? "",
            })
          : "/projects/";
    else if (slug !== null) {
      const target = placeRoute(slug, address, files);
      path = target === null ? null : browserRoutePath(target);
    }
    if (path !== null) {
      const target = new URL(path, url.origin);
      url.pathname = target.pathname;
      // A diagram whose file is unknown is the follow page naming it (`?follow&view=<id>`): its query is its place.
      url.search = target.search;
      url.hash = target.hash;
      if (address.kind === "search") {
        writeSearchState(url, address.state);
        if (address.state.query === "") url.searchParams.delete("q");
        if (address.state.projects.length === 1) {
          url.searchParams.delete("project");
          url.searchParams.delete("under");
        }
      }
      return encodeAddress(url.href);
    }
  }
  for (const key of DESTINATIONS) url.searchParams.delete(key);
  switch (address.kind) {
    case "view":
      url.searchParams.set("view", address.viewId);
      break;
    case "note":
      url.searchParams.set("note", address.path);
      break;
    case "folder":
      if (address.path !== null) url.searchParams.set(FOLDER_PARAM, address.path);
      break;
    case "overview":
      url.searchParams.set("overview", "1");
      break;
    case "search":
      writeSearchState(url, address.state);
      break;
    case "file":
      break;
  }
  return encodeAddress(url.href);
}

/** Preserve caller query/fragment while taking a file's canonical logical address. */
export function canonicalFileHref(href: string, canonical: string): string {
  const here = new URL(decodeAddress(href)),
    there = new URL(decodeAddress(new URL(canonical, href).href));
  here.pathname = there.pathname;
  if (there.hash) here.hash = there.hash;
  for (const [key, value] of there.searchParams) here.searchParams.set(key, value);
  return encodeAddress(here.href);
}
