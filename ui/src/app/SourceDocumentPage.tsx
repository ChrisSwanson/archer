import { runtime } from "./runtime.ts";
import { listenForFileUpdates } from "./file-updates";
import { createHttpConnection, type RecoveryStatus } from "./http-connection";
import { useEffect, useId, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { browserRoutePath, documentRoute, projectResourceBase, readBrowserRoute } from "./browser-routes";
import { sourceDocumentPath, parseSourceDocuments, type SourceDocument } from "./source-documents";
import { resolveFileRoute } from "./file-route";
import { parseInventory } from "./inventory";
import { WebShell, WORKSPACE_ACTIONS } from "./WebShell";
import { Breadcrumb } from "./Breadcrumb";
import { useShellHelp } from "./shell-help";
import { SEARCH_SECTION } from "./HelpOverlay";
import { useRecents } from "./recents";
import {
  browserFetch,
  rememberedProjectCatalog,
  watchProjectCatalog,
  type DirectoryProject,
} from "./project-directory";
import { NoteOutline } from "../comments/NoteOutline";
import { renderNoteMarkdown, placeNoteHtml } from "../comments/markdown";
import { mountFigureHosts, ownIds, type Painting } from "../comments/note-figures";
import { paintSourceDocument } from "./source-document-paint";
import { StaleConnectionNotice } from "./PageNotice";
import "../comments/primary-comments.css";
import "./SourceDocumentPage.css";

type Preview = {
  readonly name: string;
  readonly heading: string | null;
  readonly source: string;
  readonly model: unknown;
  readonly diagnostics: readonly unknown[];
};
type Content = {
  readonly source: { readonly path: string };
  readonly kind: "markdown" | "mermaid";
  readonly revision: string;
  readonly text: string;
  readonly markdown?: string;
  readonly model?: unknown;
  readonly embedded?: readonly Preview[];
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseContent(value: unknown, path: string): Content | null {
  if (
    !record(value) ||
    !record(value.source) ||
    value.source.path !== path ||
    !sourceDocumentPath(value.source.path) ||
    !(value.kind === "markdown" || value.kind === "mermaid") ||
    typeof value.revision !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.revision) ||
    typeof value.text !== "string" ||
    value.text.length > 1024 * 1024
  )
    return null;
  if (
    value.kind === "markdown" &&
    (typeof value.markdown !== "string" ||
      value.markdown.length > 1024 * 1024 ||
      !Array.isArray(value.embedded) ||
      value.embedded.length > 256 ||
      !value.embedded.every(
        (item) =>
          record(item) &&
          typeof item.name === "string" &&
          item.name.length <= 128 &&
          (item.heading === null || (typeof item.heading === "string" && item.heading.length <= 200)) &&
          typeof item.source === "string" &&
          item.source.length <= 1024 * 1024 &&
          Array.isArray(item.diagnostics),
      ))
  )
    return null;
  return value as unknown as Content;
}
function SourceFigure({
  content,
  title,
  source,
}: {
  readonly content: unknown;
  readonly title: string;
  readonly source: string;
}): JSX.Element {
  const [drawing, setDrawing] = useState<Painting | null>(null),
    [error, setError] = useState<string | null>(null);
  const prefix = useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    let live = true;
    setDrawing(null);
    setError(null);
    void paintSourceDocument(content, title).then(
      (value) => {
        if (live) setDrawing(value);
      },
      () => {
        if (live) setError("This diagram could not be drawn. Its source is shown below.");
      },
    );
    return () => {
      live = false;
    };
  }, [content, title]);
  return (
    <figure className="archer-source-figure">
      <figcaption>{title}</figcaption>
      {drawing ? (
        <svg
          role="img"
          aria-label={title}
          viewBox={`${drawing.originX - 20} ${drawing.originY - 20} ${drawing.width + 40} ${drawing.height + 40}`}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: the export painter's SVG (paintSourceDocument → paintExport), which escapes every label and value it writes (xml(), static-markup-page); xss-corpus.e2e.ts holds project documents of the hostile corpus inert.
          dangerouslySetInnerHTML={{ __html: ownIds(drawing.content, `source-${prefix}-`) }}
        />
      ) : error ? (
        <>
          <p role="status">{error}</p>
          <pre>
            <code>{source}</code>
          </pre>
        </>
      ) : (
        <p role="status">Drawing diagram…</p>
      )}
    </figure>
  );
}
/** The project's Archer-folder diagrams, by their folder paths, as the router reads them (`api/diagrams`). */
type ViewFiles = readonly { readonly id?: string; readonly sourcePath?: string; readonly registration?: string }[];

/**
 * The repository documents whose clean address (`/projects/<name>/<path>`) opens an Archer-folder note or diagram
 * instead, so they are opened at their explicit one (`-/repo/<path>`). Decided as the router decides that address
 * (`resolveFileRoute`): by the catalog's notes and the inventory's diagrams, each named by its Archer-folder path.
 */
export function shadowedDocuments(catalog: readonly SourceDocument[], views: ViewFiles): ReadonlySet<string> {
  const notes = catalog.flatMap((document) =>
    document.legacy?.notePath === undefined ? [] : [{ path: document.legacy.notePath }],
  );
  return new Set(
    catalog
      .filter(
        (document) =>
          document.legacy === undefined && resolveFileRoute(document.source.path, undefined, views, notes) === "archer",
      )
      .map((document) => document.source.path),
  );
}

/**
 * A link in a project document names a file by its path from the document (`.archer/notes/x.md`, `NOTICE.md`). It
 * is given the page's own address for that file, so it opens in Archer in every runtime: the static Playground's
 * page is one fixed document, where the bare path led off the site. A repository document an Archer-folder file
 * shadows keeps its explicit address (the catalog says which), as the page's own `-/repo/` address did.
 */
export function addressDocumentLinks(
  root: HTMLElement,
  projectSlug: string,
  path: string,
  catalog: readonly SourceDocument[] | null,
  views: ViewFiles = [],
): void {
  const page = `https://archer.invalid/projects/${projectSlug}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const shadowed = catalog === null ? new Set<string>() : shadowedDocuments(catalog, views);
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    if (href === "" || href.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href)) continue;
    let target: URL;
    try {
      target = new URL(href, page);
    } catch {
      continue;
    }
    const prefix = `/projects/${projectSlug}/`;
    let file: string | null = null;
    try {
      file = target.pathname.startsWith(prefix) ? decodeURIComponent(target.pathname.slice(prefix.length)) : null;
    } catch {
      file = null;
    }
    const route =
      file !== null && shadowed.has(file)
        ? documentRoute(projectSlug, file, true)
        : readBrowserRoute(target.pathname, target.search, target.hash);
    const address = route === null || route.kind === "projects" ? null : browserRoutePath(route);
    if (address !== null) link.setAttribute("href", address);
  }
}

function MarkdownBody({
  content,
  projectSlug,
  catalog,
  views,
}: {
  readonly content: Content;
  readonly projectSlug: string;
  /** The project's documents and diagrams, which say which links need their explicit address; null when unread. */
  readonly catalog: readonly SourceDocument[] | null;
  readonly views: ViewFiles;
}): JSX.Element {
  const body = useRef<HTMLDivElement>(null);
  const [hosts, setHosts] = useState<readonly HTMLElement[]>([]);
  useEffect(() => {
    const root = body.current;
    if (root === null) return;
    placeNoteHtml(root, renderNoteMarkdown(content.markdown ?? "", { internalLinks: true, headingOffset: 1 }));
    addressDocumentLinks(root, projectSlug, content.source.path, catalog, views);
    setHosts(mountFigureHosts(root, content.embedded?.length ?? 0));
    return () => {
      root.replaceChildren();
    };
  }, [content, projectSlug, catalog, views]);
  return (
    <>
      <div ref={body} className="archer-note-body" />
      {hosts.map((host, index) => {
        const diagram = content.embedded?.[index];
        return diagram === undefined
          ? null
          : createPortal(
              <SourceFigure
                content={{ model: diagram.model, revision: content.revision }}
                title={diagram.heading ?? diagram.name}
                source={diagram.source}
              />,
              host,
              `${content.source.path}-${index}`,
            );
      })}
    </>
  );
}
/**
 * The project's name, as every other page shows it (App.tsx's `workspace`), from the catalog the navigation reads
 * (no request of its own); its slug until that answers (round 1 pass 6, R5-claude-08).
 */
function useProjectName(slug: string): string {
  const find = (projects: readonly DirectoryProject[] | undefined): string | undefined =>
    projects?.find((project) => project.slug === slug)?.name;
  const [name, setName] = useState<string | undefined>(() => {
    const held = rememberedProjectCatalog(browserFetch);
    return held?.status === "ready" ? find(held.projects) : undefined;
  });
  useEffect(
    () =>
      watchProjectCatalog(browserFetch, (projects) => {
        const found = find(projects);
        if (found !== undefined) setName(found);
      }),
    [slug],
  );
  return name ?? slug;
}
/** Expanded documentation is readable without granting source, discussion or highlight writes. */
export function SourceDocumentPage({
  projectSlug,
  path,
  missing,
}: {
  readonly projectSlug: string;
  readonly path: string;
  /** Reached by a file address that names no Archer-folder file: a missing document was moved or deleted. */
  readonly missing?: "moved";
}): JSX.Element {
  const [content, setContent] = useState<Content | null>(null),
    [catalog, setCatalog] = useState<readonly SourceDocument[] | null>(null),
    [views, setViews] = useState<ViewFiles>([]),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  const help = useShellHelp();
  const recents = useRecents();
  const projectName = useProjectName(projectSlug);
  const reader = useRef<HTMLElement>(null),
    column = useRef<HTMLDivElement>(null);
  const connection = useRef<ReturnType<typeof createHttpConnection> | null>(null);
  // "unsynced": the stream is back but the page has not yet re-read what it missed (as the diagram page says).
  const [connectionStatus, setConnectionStatus] = useState<RecoveryStatus | "unsynced" | null>(null);
  useEffect(() => {
    // Only the native stream needs EventSource; a runtime with its own connection supplies the events.
    if (runtime.connection === undefined && typeof EventSource === "undefined") return;
    const current = createHttpConnection(setConnectionStatus);
    connection.current = current;
    current.events.addEventListener("documents", () => setRetry((value) => value + 1));
    listenForFileUpdates(current.events);
    // The first open only confirms the read already under way; a reopen may have missed a change, so it reads again.
    let opened = false;
    current.events.onopen = () => {
      setConnectionStatus(opened ? "unsynced" : null);
      if (opened) setRetry((value) => value + 1);
      opened = true;
    };
    return () => {
      connection.current = null;
      current.disconnect();
    };
  }, [projectSlug]);
  const resource = projectResourceBase(window.location.href, projectSlug);
  const open = (route: Parameters<typeof browserRoutePath>[0]): void => {
    const target = browserRoutePath(route);
    if (target !== null) window.location.assign(target);
  };
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setContent((current) => (current?.source.path === path ? current : null));
    setError(null);
    if (resource === null || !sourceDocumentPath(path)) {
      setError("This document address is unavailable.");
      return () => controller.abort();
    }
    const notFound =
      missing === "moved"
        ? "This file was moved or deleted, or is outside the configured scope."
        : "This document is unavailable or outside the configured scope.";
    const url = new URL("api/documents/content", resource);
    url.searchParams.set("path", path);
    const read = async (target: string): Promise<unknown> => {
      if (connection.current !== null) return connection.current.read(target);
      const response = await browserFetch(target, { signal: controller.signal });
      if (!response.ok)
        throw new Error(response.status === 404 ? notFound : "The document could not be loaded. Try again.");
      return response.json();
    };
    void Promise.all([
      read(url.href),
      read(new URL("api/documents", resource).href).catch(() => null),
      read(new URL("api/diagrams", resource).href).catch(() => null),
    ])
      .then(async ([body, catalog, inventory]) => {
        if (!live) return;
        const documents = record(catalog) ? parseSourceDocuments(catalog.documents) : null;
        const alias = documents?.find((document) => document.source.path === path)?.legacy;
        if (alias?.notePath !== undefined || alias?.viewId !== undefined) {
          const target = browserRoutePath(
            alias.notePath !== undefined
              ? { kind: "note", projectSlug, path: alias.notePath }
              : { kind: "view", projectSlug, viewId: alias.viewId! },
          );
          if (target !== null) {
            window.location.replace(target);
            return;
          }
        }
        const parsed = parseContent(body, path);
        if (parsed === null) throw new Error("The server returned an unreadable document.");
        if (live) {
          setCatalog(documents);
          setViews(parseInventory(inventory) ?? []);
          setContent(parsed);
          setConnectionStatus((status) => (status === "unsynced" ? null : status));
        }
      })
      .catch((failure) => {
        if (live)
          setError(
            (failure as { status?: unknown } | null)?.status === 404
              ? notFound
              : failure instanceof Error
                ? failure.message
                : "The document could not be loaded.",
          );
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [resource, path, projectSlug, retry, missing]);
  const title = path.split("/").at(-1) ?? path;
  return (
    <WebShell
      context={{
        kind: "source",
        slug: projectSlug,
        path,
        annotation: content === null ? null : "read-only",
        actions: WORKSPACE_ACTIONS,
      }}
      navigation={{
        workspace: projectName,
        currentSlug: projectSlug,
        activeProjectSlug: projectSlug,
        place: null,
        overviewOpen: false,
        searchOpen: false,
        recents: recents.items,
        onContents: () => open({ kind: "projects" }),
        onSearch: () => open({ kind: "browse", projectSlug, folder: "" }),
        onOpenProject: (slug) => open({ kind: "browse", projectSlug: slug, folder: "" }),
        onOpenRecent: (item) =>
          open(
            item.kind === "project"
              ? { kind: "browse", projectSlug: item.slug, folder: "" }
              : item.kind === "note"
                ? { kind: "note", projectSlug: item.slug, path: item.id }
                : { kind: "view", projectSlug: item.slug, viewId: item.id },
          ),
      }}
      identity={{
        title,
        trail: (
          <Breadcrumb
            project={projectName}
            trail={[]}
            current={path}
            onProjects={() => open({ kind: "projects" })}
            onProject={() => open({ kind: "browse", projectSlug, folder: "" })}
            onFolder={() => undefined}
          />
        ),
      }}
      help={{ controller: help, view: "none", extra: [SEARCH_SECTION] }}
    >
      {connectionStatus === null ? null : <StaleConnectionNotice status={connectionStatus} subject="document" />}
      <article ref={reader} className="primary-note-reader archer-source-reader" aria-label={`Reading ${title}`}>
        {error ? (
          <div role="alert" className="archer-source-error">
            <p>{error}</p>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              Try again
            </button>
          </div>
        ) : content === null ? (
          <p role="status">Loading document…</p>
        ) : (
          <div ref={column} className="primary-note-document-column">
            <NoteOutline documentRoot={column} scrollRoot={reader} path={path} />
            {content.kind === "markdown" ? (
              <MarkdownBody key={path} content={content} projectSlug={projectSlug} catalog={catalog} views={views} />
            ) : (
              <SourceFigure content={content} title={title} source={content.text} />
            )}
          </div>
        )}
      </article>
    </WebShell>
  );
}
