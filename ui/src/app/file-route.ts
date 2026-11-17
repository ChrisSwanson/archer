/**
 * Which page opens `/projects/<name>/<path>`: the project page for an Archer-folder note
 * or diagram, else the read-only document page (a project-root-relative document, or
 * the "moved or deleted" state). The Archer folder wins a clash; a shadowed document is
 * addressed explicitly at `-/repo/<path>` (`shared/browser-routes.mts`).
 */
import { projectResourceBase } from "./browser-routes";
import { parseInventory } from "./inventory";
import { parseAllNotes } from "./contents-notes";
import { withReadDeadline } from "./read-deadline";
import { readAhead, readListing } from "./file-route-reads";
import { parseSourceDocuments } from "./source-documents";
import { browserRoutePath } from "./browser-routes";
import { drawnByLayoutWorker } from "./layout-warmup";

export { FILE_ROUTE_HANDOFF_MS, forgetFileRouteReads, takeFileRouteRead } from "./file-route-reads";

export type FileRouteTarget = "archer" | "document";
/**
 * An Archer-folder file named by its path in the project (`.archer/diagrams/x.mmd`): the project page
 * opens at its canonical address (`/projects/<name>/diagrams/x.mmd`) in this same document, without a
 * second page load (perf #3).
 */
export type FileRouteAlias = { readonly canonical: string };

type ViewFile = { readonly id?: string; readonly sourcePath?: string; readonly registration?: string };

export function resolveFileRoute(
  path: string,
  fragment: string | undefined,
  views: readonly ViewFile[],
  notes: readonly { readonly path: string }[],
): FileRouteTarget {
  if (notes.some((note) => note.path === path)) return "archer";
  if (fragment !== undefined && views.some((view) => view.registration === "embedded" && view.sourcePath === path))
    return "archer";
  if (views.some((view) => view.registration !== "embedded" && view.sourcePath?.replace(/^\.\//, "") === path))
    return "archer";
  return "document";
}

/**
 * Where the documents catalog says `path` lives when it is an Archer-folder note or diagram by its
 * project path; null when it is a document of its own (or names nothing). A diagram whose file is
 * unknown has no clean address: null too, and the document page's own redirect handles it.
 */
export function fileRouteAlias(
  slug: string,
  path: string,
  catalog: unknown,
  views: readonly ViewFile[],
): FileRouteAlias | null {
  const documents =
    typeof catalog === "object" && catalog !== null && !Array.isArray(catalog)
      ? parseSourceDocuments((catalog as Record<string, unknown>).documents)
      : null;
  const legacy = documents?.find((document) => document.source.path === path)?.legacy;
  if (legacy === undefined) return null;
  let canonical: string | null = null;
  if (legacy.notePath !== undefined)
    canonical = browserRoutePath({ kind: "note", projectSlug: slug, path: legacy.notePath });
  else if (legacy.viewId !== undefined) {
    const sourcePath = views
      .find((view) => view.id === legacy.viewId && view.registration !== "embedded")
      ?.sourcePath?.replace(/^\.\//, "");
    const route = {
      kind: "view" as const,
      projectSlug: slug,
      viewId: legacy.viewId,
      ...(sourcePath === undefined ? {} : { sourcePath }),
    };
    // Only a file address (or an embedded diagram's note address) opens without the service's redirect.
    if (sourcePath !== undefined || legacy.viewId.includes("#")) canonical = browserRoutePath(route);
  }
  return canonical === null ? null : { canonical };
}

/** Reads the project's files; when they cannot be read, the project page opens and says what it can. */
/** `onGraph`: called once the file is known to be a diagram the layout worker draws (the page starts the worker). */
export async function readFileRoute(
  href: string,
  slug: string,
  path: string,
  fragment: string | undefined,
  onGraph?: () => void,
): Promise<FileRouteTarget | FileRouteAlias> {
  const base = projectResourceBase(href, slug);
  if (base === null) return "archer";
  try {
    return await withReadDeadline(async (signal) => {
      const read = (endpoint: string): Promise<unknown> => readListing(new URL(endpoint, base).href, signal);
      const [inventory, notes] = await Promise.all([read("api/diagrams"), read("api/notes/all")]);
      const views = parseInventory(inventory),
        list = parseAllNotes(notes);
      if (views === undefined || list === null) return "archer";
      const target = resolveFileRoute(path, fragment, views, list);
      if (target === "archer") {
        // A diagram file: its envelope is what the page draws first, so it is read now, beside the page's
        // boot reads, instead of after them (the bridge takes it: `awaitFileRouteEntry`).
        const view =
          fragment === undefined && !list.some((note) => note.path === path)
            ? views.find(
                (view) =>
                  view.registration !== "embedded" &&
                  view.id !== undefined &&
                  view.sourcePath?.replace(/^\.\//, "") === path,
              )
            : undefined;
        if (view?.id !== undefined) readAhead(new URL(`api/diagrams/${encodeURIComponent(view.id)}`, base).href);
        // A graph: its layout worker starts now too, beside that read, not once the page has rendered and the
        // bridge has applied the inventory (0.11.0 flow page: ~136 ms instead of ~177 ms). Never for a sequence or a journey.
        if (view !== undefined && drawnByLayoutWorker(view.kind)) onGraph?.();
        return target;
      }
      // Not an Archer-folder file by its folder-relative path: the catalog says whether it is one by its
      // project path. The document page takes this read over (`takeFileRouteRead`), so a real document
      // does not ask twice.
      const catalog = await read("api/documents").catch(() => null);
      return fileRouteAlias(slug, path, catalog, views) ?? "document";
    });
  } catch {
    return "archer";
  }
}
