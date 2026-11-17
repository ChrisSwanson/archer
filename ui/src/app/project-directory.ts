import { rememberThumbnailFormat, rememberThumbnailVersion } from "./thumbnail-version";
import { withReadDeadline } from "./read-deadline.ts";
import { parseSourceDocuments, type SourceDocument } from "./source-documents";
import { parseInventory, type DiagramView } from "./inventory";
import { parseAllNotes } from "./contents-notes";
import type { ContentsNote } from "./contents";
import { readBrowserRoute, readLocationRoute } from "./browser-routes";
import { browserRoutePath } from "../../../shared/browser-routes.mts";
import { decodeAddress, encodeAddress } from "../runtime/address.ts";
import { parseProjectLifecycle, type ProjectLifecycle } from "./project-lifecycle";
import type { PollTag } from "./polls";
import { type ResourcePolicy, resources } from "./resources";
export { browserFetch } from "./browser-resource";

export interface DirectoryProject {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly views: readonly DiagramView[];
  readonly notes: readonly ContentsNote[];
  readonly documents?: readonly SourceDocument[];
  readonly discoveryComplete?: boolean;
  readonly lifecycle: ProjectLifecycle;
  /** The project's root README, when the service admits it (read at `api/documents/content`). */
  readonly readme?: { readonly path: string };
  /** The project page's facts line; each part optional, shown only when present. */
  readonly facts?: ProjectFacts;
  /** A linked git worktree, listed under its repository's name (`name`): its folder and branch. */
  readonly worktree?: ProjectWorktree;
}

export type ProjectWorktree = { readonly folder: string; readonly branch?: string };

/** What tells a worktree's entry apart from its repository's, where projects are listed by name. */
export function worktreeDetail(
  project: { readonly slug: string; readonly worktree?: ProjectWorktree } | undefined,
): { readonly text: string; readonly title: string } | null {
  const tree = project?.worktree;
  if (tree === undefined) return null;
  return {
    text: `worktree ${tree.folder}`,
    title: `Git worktree ${tree.folder}${tree.branch === undefined ? "" : `, branch ${tree.branch}`}`,
  };
}

const boundedText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(value);
/** A display detail only: absent or malformed is undefined, and never refuses the catalog. */
function parseWorktree(value: unknown): ProjectWorktree | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { folder, branch } = value as Record<string, unknown>;
  if (!boundedText(folder) || (branch !== undefined && !boundedText(branch))) return undefined;
  return { folder, ...(branch === undefined ? {} : { branch }) };
}

export type ProjectFacts = {
  readonly diagrams?: number;
  readonly notes?: number;
  readonly openThreads?: number;
  readonly lastEditedAt?: string;
  /** The project folder as the reader knows it (`~/code/archer`), never the Archer folder. */
  readonly projectFolder?: string;
  readonly git?: { readonly branch?: string; readonly commit: string };
};

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value !== "" && value.length <= max ? value : undefined;

/** Optional catalog facts: anything malformed is left out, never a reason to refuse the catalog. */
export function parseProjectFacts(value: unknown): ProjectFacts | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const git =
    typeof record.git === "object" && record.git !== null && !Array.isArray(record.git)
      ? (record.git as Record<string, unknown>)
      : undefined;
  const commit = text(git?.commit, 64);
  const branch = text(git?.branch, 255);
  const edited = text(record.lastEditedAt, 64);
  const facts: ProjectFacts = {
    ...(count(record.diagrams) === undefined ? {} : { diagrams: count(record.diagrams)! }),
    ...(count(record.notes) === undefined ? {} : { notes: count(record.notes)! }),
    ...(count(record.openThreads) === undefined ? {} : { openThreads: count(record.openThreads)! }),
    ...(edited === undefined || Number.isNaN(Date.parse(edited)) ? {} : { lastEditedAt: edited }),
    ...(text(record.projectFolder, 1024) === undefined ? {} : { projectFolder: text(record.projectFolder, 1024)! }),
    ...(commit === undefined ? {} : { git: { commit, ...(branch === undefined ? {} : { branch }) } }),
  };
  return Object.keys(facts).length === 0 ? undefined : facts;
}

function parseReadme(value: unknown): { readonly path: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const path = text((value as Record<string, unknown>).path, 1024);
  return path === undefined || path.startsWith("/") || path.split("/").includes("..") ? undefined : { path };
}
/** Where to go in another project: a diagram (by its file when known), a note, or its project page. */
export type ProjectDestination =
  | { readonly view: string; readonly sourcePath?: string }
  | { readonly note: string }
  | { readonly overview: true };
const SLUG = /^[a-z0-9][a-z0-9-]{0,239}$/;

export function projectSlugFromPath(path: string): string | null {
  const route = readLocationRoute(path);
  return route === null || route.kind === "projects" ? null : route.projectSlug;
}

/** Only same-service project URLs can be constructed; never accept a destination origin. */
export function directoryProjectUrl(base: string, slug: string, destination?: ProjectDestination): string | null {
  if (!SLUG.test(slug)) return null;
  let url: URL;
  try {
    url = new URL(decodeAddress(base));
  } catch {
    return null;
  }
  if (readBrowserRoute(url.pathname, url.search) === null) return null;
  const route =
    destination === undefined || "overview" in destination
      ? { kind: "browse" as const, projectSlug: slug, folder: "" }
      : "view" in destination
        ? {
            kind: "view" as const,
            projectSlug: slug,
            viewId: destination.view,
            ...(destination.sourcePath === undefined ? {} : { sourcePath: destination.sourcePath }),
          }
        : { kind: "note" as const, projectSlug: slug, path: destination.note };
  const path = browserRoutePath(route);
  return path === null ? null : encodeAddress(new URL(path, url.origin).href);
}

/**
 * The most views, notes and documents one project may bring to the catalog before it is left out as too large.
 * The service sends them all and the project's own page reads them with no cap, so this only guards the parse
 * on the main thread (about 100 ms at the limit); it is not a product rule. One project over it is listed as
 * unavailable. It never takes the other projects' entries away.
 */
export const PROJECT_ENTRY_BUDGET = 50_000;

/** A project the catalog named but this page cannot list: shown as an unavailable row, never linked. */
export interface UnavailableProject {
  /** Empty when the entry did not carry a usable slug. */
  readonly slug: string;
  readonly name: string;
  readonly problem: "too-large" | "malformed";
}

export interface ParsedCatalog {
  readonly projects: readonly DirectoryProject[];
  readonly unavailable: readonly UnavailableProject[];
}

const arrayLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/** One project's entry, or why it cannot be listed. */
function parseCatalogProject(entry: Record<string, unknown>): DirectoryProject | "too-large" | "malformed" {
  if (
    typeof entry.slug !== "string" ||
    !SLUG.test(entry.slug) ||
    typeof entry.name !== "string" ||
    entry.name.trim() === "" ||
    entry.name.length > 512 ||
    (entry.description !== undefined &&
      (typeof entry.description !== "string" ||
        entry.description.length > 1000 ||
        [...entry.description].length > 500)) ||
    !Array.isArray(entry.views) ||
    !Array.isArray(entry.notes)
  )
    return "malformed";
  const documentList = Array.isArray(entry.documents)
    ? entry.documents
    : typeof entry.documents === "object" && entry.documents !== null
      ? (entry.documents as Record<string, unknown>).documents
      : null;
  if (entry.views.length + entry.notes.length + arrayLength(documentList) > PROJECT_ENTRY_BUDGET) return "too-large";
  const views = parseInventory({ schemaVersion: 1, views: entry.views });
  const notes = parseAllNotes({ notes: entry.notes });
  const documents = entry.documents === undefined ? undefined : parseSourceDocuments(documentList);
  const lifecycle = parseProjectLifecycle(entry.lifecycle);
  const worktree = parseWorktree(entry.worktree);
  if (
    views === undefined ||
    views.length !== entry.views.length ||
    notes === null ||
    documents === null ||
    lifecycle === null
  )
    return "malformed";
  const readme = parseReadme(entry.readme);
  const facts = parseProjectFacts(entry.facts);
  return {
    ...(readme === undefined ? {} : { readme }),
    ...(facts === undefined ? {} : { facts }),
    ...(worktree === undefined ? {} : { worktree }),
    slug: entry.slug,
    name: entry.name,
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    views,
    notes,
    lifecycle,
    ...(documents === undefined ? {} : { documents }),
    ...(typeof entry.documents === "object" &&
    entry.documents !== null &&
    !Array.isArray(entry.documents) &&
    typeof (entry.documents as Record<string, unknown>).complete === "boolean"
      ? { discoveryComplete: (entry.documents as { complete: boolean }).complete }
      : {}),
  };
}

/**
 * Flat bounded metadata only: directory indexing never follows backend filesystem paths. The catalog as a whole
 * is refused (null) for a wrong schema, more than 64 projects or a repeated slug; past that each project stands
 * alone, so one that is too large or malformed is named in `unavailable` and the rest are listed.
 */
export function parseProjectCatalogEntries(value: unknown): ParsedCatalog | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.projects) || record.projects.length > 64) return null;
  rememberThumbnailVersion(record.thumbnailVersion);
  rememberThumbnailFormat(record.thumbnailFormat);
  const slugs = new Set<string>();
  for (const item of record.projects) {
    const slug = typeof item === "object" && item !== null ? (item as Record<string, unknown>).slug : undefined;
    if (typeof slug === "string" && SLUG.test(slug)) {
      if (slugs.has(slug)) return null;
      slugs.add(slug);
    }
  }
  const projects: DirectoryProject[] = [];
  const unavailable: UnavailableProject[] = [];
  for (const item of record.projects) {
    const entry =
      typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    const parsed = parseCatalogProject(entry);
    if (typeof parsed !== "string") {
      projects.push(parsed);
      continue;
    }
    const slug = typeof entry.slug === "string" && SLUG.test(entry.slug) ? entry.slug : "";
    const name =
      typeof entry.name === "string" && entry.name.trim() !== "" && entry.name.length <= 512
        ? entry.name
        : slug === ""
          ? "A project"
          : slug;
    unavailable.push({ slug, name, problem: parsed });
  }
  return { projects, unavailable };
}

/** The projects `parseProjectCatalogEntries` can list; null when the catalog as a whole is refused. */
export function parseProjectCatalog(value: unknown): readonly DirectoryProject[] | null {
  return parseProjectCatalogEntries(value)?.projects ?? null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CatalogResult =
  | {
      readonly status: "ready";
      readonly projects: readonly DirectoryProject[];
      readonly unavailable?: readonly UnavailableProject[];
    }
  | { readonly status: "error" };

type ReadyCatalog = Extract<CatalogResult, { readonly status: "ready" }>;
const CATALOG_ERROR: CatalogResult = { status: "error" };

/**
 * The last catalog each fetcher answered, and the read in flight, held in the page's read layer (`resources.ts`):
 * one entry per fetcher.
 *
 * Projects & files mounts each time it opens; asking afresh each time drew
 * this project first and the others a moment later. Remembering the answer
 * draws the whole list in one paint, and the page asks once on load so even
 * the first opening finds it. Every opening still refreshes it.
 *
 * Its validator is sent back, so an unchanged catalog is a 304 with no body (the answer stays `no-store`, ADR 0014),
 * and an answer that says the same again keeps the objects built from it (the page asks every 15 s): nothing
 * downstream rebuilds.
 */
const catalogPolicy: ResourcePolicy<ReadyCatalog> = {
  kind: "catalog",
  freshMs: 1500,
  conditional: true,
  parse: (raw, response) => {
    const parsed = response.ok ? parseProjectCatalogEntries(raw) : null;
    return parsed === null
      ? undefined
      : {
          status: "ready",
          projects: parsed.projects,
          ...(parsed.unavailable.length === 0 ? {} : { unavailable: parsed.unavailable }),
        };
  },
};
const fetcherIds = new WeakMap<FetchLike, string>();
let fetchers = 0;
/** The fetcher's own scope: a lifecycle edit overtakes only its reads. */
function catalogScope(fetchImpl: FetchLike): string {
  let id = fetcherIds.get(fetchImpl);
  if (id === undefined) {
    id = String(++fetchers);
    fetcherIds.set(fetchImpl, id);
  }
  return id;
}
const CATALOG_KEY = "api/browser-projects#";
const catalogKey = (fetchImpl: FetchLike): string => CATALOG_KEY + catalogScope(fetchImpl);
/** Fetchers whose only answer so far was a failure: they remember an error. */
const failed = new Set<FetchLike>();

type CatalogWatcher = (projects: readonly DirectoryProject[]) => void;

/**
 * Hears every ready catalog `fetchImpl`'s reads bring (and the one already held, at once), without
 * reading of its own: what follows the catalog (thumbnail fetch-ahead) costs the page no request.
 */
export function watchProjectCatalog(fetchImpl: FetchLike, watcher: CatalogWatcher): () => void {
  const stop = resources.subscribe<ReadyCatalog>(catalogKey(fetchImpl), (answer) => watcher(answer.body.projects));
  const held = resources.peek<ReadyCatalog>(catalogKey(fetchImpl));
  if (held !== undefined) watcher(held.body.projects);
  return stop;
}

export function rememberedProjectCatalog(fetchImpl: FetchLike): CatalogResult | undefined {
  return (
    resources.peek<ReadyCatalog>(catalogKey(fetchImpl))?.body ?? (failed.has(fetchImpl) ? CATALOG_ERROR : undefined)
  );
}

/**
 * Apply an acknowledged lifecycle mutation before the confirming catalog read. A read already out continues, but
 * can no longer publish; the caller's confirming read is a full one of its own (no validator for a catalog edited here).
 */
export function updateRememberedProjectLifecycle(
  fetchImpl: FetchLike,
  slug: string,
  lifecycle: ProjectLifecycle,
): void {
  resources.supersede("catalog", catalogScope(fetchImpl));
  resources.replace<ReadyCatalog>(catalogKey(fetchImpl), (current) => ({
    ...current,
    projects: current.projects.map((project) => (project.slug === slug ? { ...project, lifecycle } : project)),
  }));
}

/** `poll`: the tag of the scheduled tick asking (app/polls.ts), sent on the read it makes. */
export function loadProjectCatalog(fetchImpl: FetchLike, poll?: PollTag): Promise<CatalogResult> {
  const scope = catalogScope(fetchImpl);
  return withReadDeadline((signal) =>
    resources.read(catalogKey(fetchImpl), catalogPolicy, {
      fetch: fetchImpl,
      url: "api/browser-projects",
      poll,
      signal,
      scope,
    }),
  ).then(
    (result): CatalogResult => {
      // Overtaken by a lifecycle edit: the catalog held (the edited one) stands.
      if ("superseded" in result) return rememberedProjectCatalog(fetchImpl) ?? CATALOG_ERROR;
      failed.delete(fetchImpl);
      return result.body;
    },
    (): CatalogResult => {
      // A failed refresh keeps the last good list rather than taking it away.
      const held = rememberedProjectCatalog(fetchImpl);
      if (held?.status === "ready") return held;
      failed.add(fetchImpl);
      return CATALOG_ERROR;
    },
  );
}

/**
 * A `documents` event means the answer changed: the next load reads again whatever its age. Without one, a
 * load right after another (the list, the notifications bell and the editor all ask at page load) shares it.
 */
export function markProjectCatalogStale(): void {
  resources.stale("catalog");
}

/** For tests: forget every remembered catalog. */
export function forgetProjectCatalogs(): void {
  resources.forget(CATALOG_KEY);
  failed.clear();
}
