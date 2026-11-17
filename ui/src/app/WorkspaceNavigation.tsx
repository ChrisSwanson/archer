/**
 * The sidebar (the projects-and-search design): a
 * rail that expands over the page, with
 *
 * - Projects: the all-project overview, attached projects by name, and the
 *   reader's five most recent files (`recents.ts`);
 * - the shortcuts sheet.
 *
 * No paths and no file tree: a project's files are its project page's. Short
 * enough not to scroll in the usual case. At phone width it is a drawer the
 * document bar's menu button opens.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import "./WorkspaceNavigation.css";
import {
  browserFetch,
  loadProjectCatalog,
  rememberedProjectCatalog,
  worktreeDetail,
  type DirectoryProject,
} from "./project-directory";
import { RECENTS_SHOWN, type RecentItem } from "./recents";
import { Glyph } from "./FileTable";
import { DEFAULT_PROJECT_LIFECYCLE, isInactiveProject, PROJECT_CATALOG_CHANGED } from "./project-lifecycle";
import { schedulePoll, type PollTag } from "./polls";

/**
 * How long a mouse rests on the collapsed rail before it opens (wave 2 review, finding 17). A pointer
 * crossing the rail on its way to the drawing's tools, key or legend at the bottom left passes in less,
 * so the rail never expands over what it was headed for.
 */
export const HOVER_INTENT_MS = 180;

export type NavigationPlace = { readonly slug: string; readonly kind: RecentItem["kind"]; readonly id: string } | null;

export function WorkspaceNavigation(props: {
  readonly workspace: string;
  /** This project's slug; null where the service lists no projects. */
  readonly currentSlug: string | null;
  readonly globalOverview?: boolean;
  /** What is on screen, marked in Projects and Recent. */
  readonly place: NavigationPlace;
  /** The project actually displayed or most recently visited. */
  readonly activeProjectSlug?: string | null;
  /** The all-project overview is on screen rather than one project's page. */
  readonly overviewOpen?: boolean;
  readonly searchOpen: boolean;
  readonly recents: readonly RecentItem[];
  readonly onContents: () => void;
  readonly onSearch: () => void;
  readonly onOpenProject: (slug: string) => void;
  readonly onOpenRecent: (item: RecentItem) => void;
  readonly onDismissReview?: () => void;
  readonly onHelp: () => void;
  readonly settings?: ReactNode;
  /** At phone width: whether the drawer is open, and how it closes. */
  readonly drawer: boolean;
  readonly onDrawer: (open: boolean) => void;
}): JSX.Element {
  const root = useRef<HTMLElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [catalogRequest, setCatalogRequest] = useState(0);
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const keyboardIntent = useRef(false),
    suppressFocus = useRef(false);
  const dismissedUnderPointer = useRef(false);
  const { drawer, onDrawer } = props;
  const remembered =
    props.currentSlug === null && !props.globalOverview ? undefined : rememberedProjectCatalog(browserFetch);
  const [projects, setProjects] = useState<
    readonly Pick<DirectoryProject, "slug" | "name" | "lifecycle" | "worktree">[] | null
  >(remembered?.status === "ready" ? remembered.projects : null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  // Hover intent: a real move over the rail starts the clock, leaving stops it. A move is real when the
  // pointer is somewhere it was not: the browser's own move after a layout or scroll (the rail arriving
  // under a parked pointer) repeats the last position.
  const intent = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointer = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const stopIntent = (): void => {
    if (intent.current !== null) clearTimeout(intent.current);
    intent.current = null;
  };
  useEffect(() => stopIntent, []);
  const dismiss = (): void => {
    stopIntent();
    setHovered(false);
    dismissedUnderPointer.current = true;
    if (drawer) onDrawer(false);
  };
  const expanded = hovered || drawer;
  const hoveredRef = useRef(hovered);
  hoveredRef.current = hovered;
  // Ask once on load, when the current project changes, and whenever the
  // navigation is revealed so a long-lived page discovers attached projects.
  useEffect(() => {
    if (props.currentSlug === null && !props.globalOverview) return;
    let live = true;
    const reload = (poll?: PollTag) =>
      loadProjectCatalog(browserFetch, poll).then((result) => {
        if (!live) return;
        if (result.status === "ready") setProjects(result.projects);
        setCatalogFailed(result.status === "error");
      });
    const changed = () => {
      const next = rememberedProjectCatalog(browserFetch);
      if (next?.status === "ready") {
        setProjects(next.projects);
        setCatalogFailed(false);
      }
    };
    reload();
    const stopPoll = schedulePoll("project-catalog", (poll) =>
      expanded && !document.hidden ? reload(poll) : undefined,
    );
    window.addEventListener(PROJECT_CATALOG_CHANGED, changed);
    return () => {
      live = false;
      stopPoll();
      window.removeEventListener(PROJECT_CATALOG_CHANGED, changed);
    };
  }, [props.currentSlug, expanded, catalogRequest, props.globalOverview]);
  useEffect(() => {
    const outside = (e: PointerEvent): void => {
      // A modal opened from the drawer (Settings) makes the page behind it inert; presses in that
      // modal are not presses outside the drawer, and closing it should return to the open drawer.
      if (root.current?.closest("[inert]")) return;
      if (e.target instanceof Node && !root.current?.contains(e.target)) dismiss();
    };
    const keyboard = (): void => {
      keyboardIntent.current = true;
    };
    // Keyboard focus moving on in the page while the pointer holds the rail open: the open rail would cover the
    // control that has it (Zoom in, at the canvas' left edge), so it folds, as a press outside folds it (R6-claude-09).
    const focusMoved = (e: FocusEvent): void => {
      if (!keyboardIntent.current || !hoveredRef.current || drawer || root.current?.closest("[inert]")) return;
      if (e.target instanceof Node && !root.current?.contains(e.target)) dismiss();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    document.addEventListener("focusin", focusMoved);
    const element = root.current;
    const moved = (e: PointerEvent): void => {
      if (e.pointerType !== "mouse") return;
      const last = lastPointer.current;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      const real = last === null || last.x !== e.clientX || last.y !== e.clientY;
      if (!real || dismissedUnderPointer.current || intent.current !== null) return;
      if (!(e.target instanceof Node && element?.contains(e.target))) return;
      intent.current = setTimeout(() => {
        intent.current = null;
        setHovered(true);
      }, HOVER_INTENT_MS);
    };
    // Coming in from outside forgets a dismissal made with the pointer elsewhere; the move that follows opens it.
    const entered = (e: PointerEvent): void => {
      if (e.pointerType === "mouse") dismissedUnderPointer.current = false;
    };
    const departed = (): void => {
      stopIntent();
      dismissedUnderPointer.current = false;
      setHovered(false);
    };
    document.addEventListener("pointermove", moved, true);
    element?.addEventListener("pointerenter", entered);
    element?.addEventListener("pointerleave", departed);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
      document.removeEventListener("focusin", focusMoved);
      document.removeEventListener("pointermove", moved, true);
      element?.removeEventListener("pointerenter", entered);
      element?.removeEventListener("pointerleave", departed);
    };
    // `dismiss` reads the drawer through its props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onDismissReview, drawer]);
  // The drawer takes the focus when it opens, on its first control.
  useEffect(() => {
    if (drawer) root.current?.querySelector<HTMLButtonElement>(".primary-brand")?.focus();
  }, [drawer]);
  const close = (): void => {
    dismiss();
    if (!drawer) {
      suppressFocus.current = true;
      root.current?.querySelector<HTMLButtonElement>(".primary-brand")?.focus();
      suppressFocus.current = false;
    }
  };
  const go = (action: () => void): void => {
    action();
    dismiss();
  };
  const currentSlug = props.currentSlug ?? "";
  const fallback = { slug: currentSlug, name: props.workspace, lifecycle: DEFAULT_PROJECT_LIFECYCLE };
  // Until the catalog arrives, the page's own project stands in. Once it has,
  // the catalog is the truth: a slug it does not list is no project at all.
  const names = projects ?? (props.globalOverview ? [] : [fallback]);
  const ordinaryNames = names.filter((project) => !isInactiveProject(project.lifecycle));
  const inactiveNames = names.filter((project) => isInactiveProject(project.lifecycle));
  const contextSlug = props.globalOverview
    ? null
    : props.overviewOpen
      ? props.currentSlug
      : (props.activeProjectSlug ?? props.currentSlug);
  const inactiveCurrent = inactiveNames.some((project) => project.slug === contextSlug);
  const recent = props.recents.filter((item) => item.kind !== "project").slice(0, RECENTS_SHOWN);
  const here = (slug: string, kind: RecentItem["kind"], id: string): boolean =>
    props.place !== null && props.place.slug === slug && props.place.kind === kind && props.place.id === id;
  const projectItem = (project: (typeof names)[number]): JSX.Element => {
    const active = project.slug === props.activeProjectSlug;
    return (
      <li key={project.slug}>
        <button
          type="button"
          className="primary-place"
          data-active-project={active ? "true" : undefined}
          aria-current={here(project.slug, "project", "") ? "page" : undefined}
          onClick={() => go(() => props.onOpenProject(project.slug))}
        >
          <Glyph icon="folder" className="primary-place-glyph" />
          <span className="primary-place-name">
            {project.name}
            {(() => {
              const detail = worktreeDetail(project);
              return detail === null ? null : (
                <span className="archer-project-worktree" title={detail.title}>
                  {" "}
                  · {detail.text}
                </span>
              );
            })()}
          </span>
          {active ? (
            <span className="primary-active-project" role="img" title="Active project" aria-label="Active project" />
          ) : null}
        </button>
      </li>
    );
  };
  const projectsSection = (): JSX.Element => (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container is a Tab stop so a keyboard can scroll it (axe scrollable-region-focusable; UI_UX.md, RS1-02).
    <div className="primary-sections" role="region" aria-label="Projects and recent files" tabIndex={0}>
      <section className="primary-navigation-section" aria-labelledby="primary-projects-heading">
        <h2 id="primary-projects-heading" className="primary-projects-heading" aria-label="Projects" title="Projects">
          <Glyph icon="folder" />
          <span>Projects</span>
        </h2>
        <div className="primary-flyout">
          <div className="primary-places">
            <nav aria-label="Projects" className="primary-place-group">
              <ul>
                <li>
                  <button
                    type="button"
                    className="primary-place primary-overview"
                    aria-current={props.overviewOpen && props.place === null ? "page" : undefined}
                    onClick={() => go(props.onContents)}
                  >
                    <Glyph icon="folder" className="primary-place-glyph" />
                    <span className="primary-place-name">Overview</span>
                  </button>
                </li>
                {ordinaryNames.map(projectItem)}
              </ul>
              {inactiveNames.length === 0 ? null : (
                <details
                  className="primary-inactive-projects"
                  open={inactiveCurrent || inactiveOpen}
                  onToggle={(event) => setInactiveOpen(event.currentTarget.open)}
                  aria-label={`Inactive projects (${inactiveNames.length})`}
                >
                  <summary>
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                      <path
                        d={inactiveCurrent || inactiveOpen ? "M3 4.5 6 7.5 9 4.5" : "M4.5 3 7.5 6 4.5 9"}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>Inactive projects</span>
                    <span>{inactiveNames.length}</span>
                  </summary>
                  <ul>{inactiveNames.map(projectItem)}</ul>
                </details>
              )}
              {catalogFailed ? (
                <p className="primary-directory-status" role="status">
                  Other projects could not be listed.{" "}
                  <button
                    type="button"
                    className="primary-directory-retry"
                    onClick={() => setCatalogRequest((request) => request + 1)}
                  >
                    Reload projects
                  </button>
                </p>
              ) : null}
            </nav>
            <nav aria-labelledby={`primary-recent-heading`} className="primary-place-group">
              <h2 id={`primary-recent-heading`} className="primary-place-heading">
                Recent
              </h2>
              {recent.length === 0 ? (
                <p className="primary-empty">The files you open appear here.</p>
              ) : (
                <ul>
                  {recent.map((item) => {
                    return (
                      <li key={`${item.slug}\0${item.kind}\0${item.id}`}>
                        <button
                          type="button"
                          className="primary-place primary-recent"
                          data-kind={item.kind}
                          aria-current={here(item.slug, item.kind, item.id) ? "page" : undefined}
                          aria-label={`${item.title}, ${item.kind === "view" ? "diagram" : "note"}, ${item.projectName}`}
                          title={`${item.id} · ${item.projectName}`}
                          onClick={() => go(() => props.onOpenRecent(item))}
                        >
                          <Glyph icon={item.kind === "view" ? "diagram" : "note"} className="primary-place-glyph" />
                          <span className="primary-place-name">{item.title}</span>
                          <span className="archer-visually-hidden">
                            {item.kind === "view" ? ", diagram" : ", note"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </nav>
          </div>
        </div>
      </section>
    </div>
  );
  return (
    <aside
      ref={root}
      className="primary-navigation"
      data-expanded={expanded}
      data-pinned={drawer}
      data-drawer={drawer ? "true" : undefined}
      onPointerDown={() => {
        keyboardIntent.current = false;
      }}
      onFocusCapture={() => {
        if (suppressFocus.current) return;
        if (keyboardIntent.current) setHovered(true);
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !root.current?.contains(event.relatedTarget) &&
          keyboardIntent.current
        )
          dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      {drawer ? <div className="primary-scrim" aria-hidden="true" onClick={dismiss} /> : null}
      <nav className="primary-rail" aria-label="Workspace">
        <div className="primary-navigation-head">
          <button
            type="button"
            className="primary-brand"
            aria-label="Archer contents"
            onClick={() => go(props.onContents)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m4 20 8-16 8 16 M8 13h8" />
            </svg>
            <span>Archer</span>
          </button>
        </div>
        {projectsSection()}
        {props.settings}
        <button type="button" className="primary-help" aria-label="Keyboard shortcuts" onClick={() => go(props.onHelp)}>
          <span className="primary-help-glyph" aria-hidden="true">
            ?
          </span>
          <span className="primary-help-label">Shortcuts</span>
        </button>
      </nav>
    </aside>
  );
}
