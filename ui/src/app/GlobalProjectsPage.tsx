import { saveBrowserPosition } from "./browser-position";
import { useEffect, useRef, useState, type JSX } from "react";
import { SearchPage } from "./SearchPage";
import { readSearchState, writeSearchState, EMPTY_SEARCH, type SearchState, type FileRow } from "./file-index";
import { directoryProjectUrl } from "./project-directory";
import { openInApp } from "./in-app-navigation";
import { browserRoutePath, rowRoute } from "./browser-routes";
import { WebShell, WORKSPACE_ACTIONS } from "./WebShell";
import { useShellHelp } from "./shell-help";
import { useRecents } from "./recents";
import { SEARCH_SECTION } from "./HelpOverlay";
import { runtime } from "./runtime.ts";

function initialState(): SearchState {
  const query = new URLSearchParams(window.location.search);
  query.set("q", query.get("q") ?? "");
  return readSearchState("?" + query) ?? EMPTY_SEARCH;
}
/** A service-level browser has no current project and never bootstraps a fabricated one. */
export function GlobalProjectsPage(): JSX.Element {
  const [state, setState] = useState(initialState);
  const help = useShellHelp();
  const recents = useRecents();
  const input = useRef<HTMLInputElement>(null);
  const intent = useRef("filter");
  const typing = useRef(false);
  useEffect(() => {
    const follow = () => {
      typing.current = false;
      setState(initialState());
    };
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);
  // A project opens in this page, as a project's own breadcrumb does (claude-503): no second page load, and offline the
  // person stays in Archer.
  const openProject = (slug: string) => {
    saveBrowserPosition();
    const url = directoryProjectUrl(window.location.href, slug, { overview: true });
    if (url) openInApp(url);
  };
  const open = (row: FileRow) => {
    saveBrowserPosition();
    if (row.sourceDocumentPath !== undefined) {
      const path = browserRoutePath(rowRoute(row));
      if (path) window.location.assign(path);
      return;
    }
    const url = directoryProjectUrl(
      window.location.href,
      row.slug,
      row.kind === "note"
        ? { note: row.id }
        : { view: row.id, ...(row.path.endsWith(".mmd") ? { sourcePath: row.path } : {}) },
    );
    if (url) window.location.assign(url);
  };
  const change = (next: SearchState) => {
    saveBrowserPosition();
    const route =
      next.projects.length === 1
        ? browserRoutePath({ kind: "browse", projectSlug: next.projects[0]!, folder: next.folder ?? "" })
        : browserRoutePath({ kind: "projects" });
    const url = new URL(route ?? "/projects/", window.location.href);
    writeSearchState(url, next);
    if (next.query === "") url.searchParams.delete("q");
    if (next.projects.length === 1) {
      url.searchParams.delete("project");
      url.searchParams.delete("under");
      window.location.assign(url.href);
      return;
    }
    if (intent.current === "query" && typing.current) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    typing.current = intent.current === "query";
    setState(next);
  };
  return (
    <WebShell
      context={{ kind: "service", actions: WORKSPACE_ACTIONS }}
      navigation={{
        workspace: "Projects",
        currentSlug: null,
        globalOverview: true,
        place: null,
        overviewOpen: true,
        searchOpen: false,
        recents: recents.items,
        onContents: () => window.location.assign(browserRoutePath({ kind: "projects" })!),
        onSearch: () => input.current?.focus(),
        onOpenProject: openProject,
        onOpenRecent: (item) => {
          saveBrowserPosition();
          const url = directoryProjectUrl(
            window.location.href,
            item.slug,
            item.kind === "project" ? { overview: true } : item.kind === "note" ? { note: item.id } : { view: item.id },
          );
          if (url) window.location.assign(url);
        },
      }}
      identity={{ title: "Projects" }}
      help={{ controller: help, view: "none", extra: [SEARCH_SECTION] }}
      contents
    >
      <div className="archer-contents-panel">
        <section className="archer-contents archer-project-browser" aria-label="Project files">
          <SearchPage
            globalOverview
            state={state}
            onChange={change}
            onInteraction={(next) => {
              intent.current = next;
            }}
            onQueryEnd={() => {
              typing.current = false;
            }}
            onOpenProject={openProject}
            currentSlug={null}
            currentName=""
            views={[]}
            notes={[]}
            serverSearch={runtime.features.serverSearch}
            baseUrl={window.location.href}
            now={Date.now()}
            onOpen={open}
            onOpenMatch={(row) => open(row)}
            inputRef={input}
          />
        </section>
      </div>
    </WebShell>
  );
}
