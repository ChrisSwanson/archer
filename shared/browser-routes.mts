/**
 * Browser navigation addresses, shared by the service and the page (ADR 0017).
 * Project/source identifiers are never credentials.
 *
 * Canonical: `/projects/`, `/projects/<name>/` (the project browser),
 * `/projects/<name>/?follow` (what the agent presents), `/projects/<name>/<folder>/…/`
 * (a trailing slash is a folder), `/projects/<name>/<path>` (a file: an Archer-folder note
 * or diagram, else a project-root-relative document; `.archer` wins), `#<name>` after a
 * note path (a diagram embedded in it, ADR 0012), and `/projects/<name>/-/repo/<path>`
 * (a project document, explicitly). The first segment `-` is reserved for system routes.
 *
 * Only these parse. `note` and `view` are built, never read: building any route yields its
 * canonical address, and a standalone diagram whose file is unknown is its project's follow
 * page with the `?view=<id>` query destination, which the page replaces once it knows the file.
 * `/p/<name>/` is the project's API base (`projectResourceBase`), never a page.
 */
export type BrowserRoute =
  | { readonly kind: "projects" }
  | { readonly kind: "follow"; readonly projectSlug: string }
  | { readonly kind: "edit"; readonly projectSlug: string }
  | { readonly kind: "browse"; readonly projectSlug: string; readonly folder: string }
  /** A file by its path: resolved against the project's files by whoever reads it. */
  | { readonly kind: "file"; readonly projectSlug: string; readonly path: string; readonly fragment?: string }
  /** A project-root-relative document, explicitly (`-/repo/`). */
  | { readonly kind: "document"; readonly projectSlug: string; readonly path: string }
  /** An Archer-folder note, by its folder-relative path (built only). */
  | { readonly kind: "note"; readonly projectSlug: string; readonly path: string }
  /** A diagram by view id (built only); its file, when known, makes its address. */
  | { readonly kind: "view"; readonly projectSlug: string; readonly viewId: string; readonly sourcePath?: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,239}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_PATH_CHARS = 8192;
const MAX_COMPONENT_CHARS = 1200;
const BAD = /[\\\u0000-\u001f\u007f]/;
/** The reserved first segment for system routes, and its one route. */
const SYSTEM = "-";
const REPO = "repo";
/** The editor's system route (ADR 0027): `/projects/<name>/-/edit/`. */
const EDIT = "edit";

export const isProjectSlug = (value: string): boolean => SLUG.test(value);

function decoded(raw: string): string | null {
  try {
    const value = decodeURIComponent(raw);
    return value.length === 0 || value.length > MAX_COMPONENT_CHARS || BAD.test(value) ? null : value;
  } catch {
    return null;
  }
}
function sourceSegments(raw: readonly string[]): string | null {
  const parts: string[] = [];
  for (const component of raw) {
    const value = decoded(component);
    if (value === null || value === "." || value === ".." || value.includes("/") || value.includes(":")) return null;
    parts.push(value);
  }
  return parts.join("/");
}
function encodedSource(path: string, empty: boolean): string | null {
  if (path === "") return empty ? "" : null;
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        BAD.test(part) ||
        part.includes(":") ||
        part.length > MAX_COMPONENT_CHARS,
    )
  )
    return null;
  try {
    return parts.map(encodeURIComponent).join("/");
  } catch {
    return null;
  }
}
/** A diagram embedded in a note: `<note path>.md#<name>` (ADR 0012's shape; the service validates fully). */
function embeddedAddress(viewId: string): { notePath: string; name: string } | null {
  const hash = viewId.lastIndexOf("#");
  if (hash <= 0) return null;
  const notePath = viewId.slice(0, hash),
    name = viewId.slice(hash + 1);
  return notePath.endsWith(".md") && NAME.test(name) ? { notePath, name } : null;
}
function fragmentOf(hash: string): string | undefined {
  if (!hash.startsWith("#")) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(hash.slice(1));
  } catch {
    return undefined;
  }
  return NAME.test(value) ? value : undefined;
}
function hasFollow(search: string): boolean {
  if (search === "" || search === "?") return false;
  try {
    return new URLSearchParams(search).has("follow");
  } catch {
    return false;
  }
}

/**
 * Raw pathname (with the location's search and hash when known): unlike URL(), this
 * refuses rather than normalizes dot traversal.
 */
export function readBrowserRoute(pathname: string, search = "", hash = ""): BrowserRoute | null {
  if (
    typeof pathname !== "string" ||
    pathname.length > MAX_PATH_CHARS ||
    !pathname.startsWith("/") ||
    pathname.includes("?") ||
    pathname.includes("#")
  )
    return null;
  if (pathname === "/projects/" || pathname === "/projects") return { kind: "projects" };
  const parts = pathname.split("/");
  return parts[1] === "projects" ? readProjectRoute(parts.slice(2), search, hash) : null;
}

function readProjectRoute(parts: readonly string[], search: string, hash: string): BrowserRoute | null {
  const projectSlug = parts[0];
  if (projectSlug === undefined || !SLUG.test(projectSlug)) return null;
  const rest = parts.slice(1);
  // `/projects/<name>` and `/projects/<name>/`: the project itself.
  if (rest.length === 0 || (rest.length === 1 && rest[0] === ""))
    return hasFollow(search) ? { kind: "follow", projectSlug } : { kind: "browse", projectSlug, folder: "" };
  const folder = rest.at(-1) === "";
  const segments = folder ? rest.slice(0, -1) : rest;
  if (segments[0] === SYSTEM) {
    if (folder && segments.length === 2 && segments[1] === EDIT) return { kind: "edit", projectSlug };
    if (folder || segments[1] !== REPO || segments.length < 3) return null;
    const path = sourceSegments(segments.slice(2));
    return path === null ? null : { kind: "document", projectSlug, path };
  }
  const path = sourceSegments(segments);
  if (path === null || path === "") return null;
  if (folder) return { kind: "browse", projectSlug, folder: path };
  const fragment = fragmentOf(hash);
  return fragment === undefined ? { kind: "file", projectSlug, path } : { kind: "file", projectSlug, path, fragment };
}

/** A file or folder path the `/projects/<name>/` namespace can spell: never the reserved `-`. */
function projectPath(path: string, folder: boolean): string | null {
  if (path.split("/")[0] === SYSTEM) return null;
  return encodedSource(path, folder);
}

/**
 * The canonical address of `route`: a path, with `?follow` or `#<name>` where the route
 * has one. Clean navigation only; access-link issuance adds a credential separately.
 */
export function browserRoutePath(route: BrowserRoute): string | null {
  if (route.kind === "projects") return "/projects/";
  if (!SLUG.test(route.projectSlug)) return null;
  const root = `/projects/${route.projectSlug}/`;
  let result: string | null;
  switch (route.kind) {
    case "follow":
      result = `${root}?follow`;
      break;
    case "edit":
      result = `${root}${SYSTEM}/${EDIT}/`;
      break;
    case "browse": {
      const path = projectPath(route.folder, true);
      result = path === null ? null : `${root}${path}${path === "" ? "" : "/"}`;
      break;
    }
    case "note":
    case "file": {
      const path = projectPath(route.path, false);
      const fragment = route.kind === "file" ? route.fragment : undefined;
      if (fragment !== undefined && !NAME.test(fragment)) return null;
      result = path === null ? null : `${root}${path}${fragment === undefined ? "" : `#${fragment}`}`;
      break;
    }
    case "document": {
      const path = encodedSource(route.path, false);
      result = path === null ? null : `${root}${SYSTEM}/${REPO}/${path}`;
      break;
    }
    case "view": {
      if (route.viewId === "" || route.viewId.length > MAX_COMPONENT_CHARS || BAD.test(route.viewId)) return null;
      const embedded = embeddedAddress(route.viewId);
      if (embedded !== null)
        return browserRoutePath({
          kind: "file",
          projectSlug: route.projectSlug,
          path: embedded.notePath,
          fragment: embedded.name,
        });
      if (route.sourcePath !== undefined)
        return browserRoutePath({ kind: "file", projectSlug: route.projectSlug, path: route.sourcePath });
      // Its file unknown: the follow page names it by the `?view=` query destination.
      try {
        result = `${root}?follow&view=${encodeURIComponent(route.viewId)}`;
      } catch {
        return null;
      }
      break;
    }
  }
  return result === null || result.length > MAX_PATH_CHARS ? null : result;
}

/** Trusted same-origin resource root (`/p/<slug>/`, the project's API base), independent of the page's address. */
export function projectResourceBase(href: string, slug?: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const route = readBrowserRoute(url.pathname, url.search);
  if (route === null) return null;
  const target = slug ?? (route.kind === "projects" ? undefined : route.projectSlug);
  if (target === undefined || !SLUG.test(target)) return null;
  url.pathname = `/p/${target}/`;
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.href;
}
