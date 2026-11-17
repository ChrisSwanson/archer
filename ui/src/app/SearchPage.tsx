import { restoreBrowserPosition, restoredCollapsedProjects, saveBrowserPosition } from "./browser-position";
/**
 * The project browser and the search page: every diagram and note of the
 * attached projects, in three tabs -- Folders (the tree), Diagrams and Notes --
 * under one search field with modal filters (the projects-and-search
 * design). A project's own page leads with its title section
 * and README card. Enter or Search commits the field's draft, matching
 * names, paths, kinds and descriptions, and the Mermaid source, notes and
 * comments from each project's service (`api/search`, the match fields under each
 * card). One field picker applies to every card; the sort is shareable too.
 *
 * The page's state is its address (`file-index.ts`, `?q=`): a filtered
 * view is a link, and Back returns to where the reader came from. The state
 * is the App's; this page only reports changes to it.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { parseCompileStatus } from "./compile-status";
import type { ContentsNote } from "./contents";
import { queryWords } from "./diagram-filter";
import {
  DATE_PRESETS,
  diagramTypeLabel,
  EMPTY_SEARCH,
  facets as facetsOf,
  fileRows,
  filterCount,
  searchRows,
  SORT_KEYS,
  type ContentHits,
  type DatePreset,
  type DateRange,
  type FileKind,
  type FileRow,
  type IndexedProject,
  type SearchState,
  type SortKey,
  type Status,
  type ProjectTab,
} from "./file-index";
import { BrowserControls } from "./BrowserControls";
import { CountRangeFilter } from "./CountRangeFilter";
import { FilterSection } from "./FilterSection";
import { DocumentPreview } from "./DocumentPreview";
import { useResolvedTheme } from "../theme/theme";
import type { DiagramView } from "./inventory";
import {
  browserFetch,
  loadProjectCatalog,
  rememberedProjectCatalog,
  type DirectoryProject,
  type UnavailableProject,
} from "./project-directory";
import {
  parseBrowserSearch,
  type BrowserSearchTarget,
  searchHits,
  searchQuery,
  SEARCH_DEBOUNCE_MS,
  type MatchSummary,
  type SearchMatch,
} from "./search";
import { useCommentActivity } from "./comment-activity";
import { browserNavigationState, editBrowserFilters, type BrowserChangeIntent } from "./browser-navigation";
import { projectResourceBase } from "./browser-routes";
import { InactiveProjects } from "./ProjectLifecycle";
import { FolderTree } from "./FolderTree";
import { useTreeColumns } from "./project-tree";
import { ProjectReadme, ProjectTitle } from "./ProjectTitle";
import { DiagramsView } from "./project-views/DiagramsView";
import {
  NotesView,
  firstDirection,
  nextNoteSort,
  DEFAULT_NOTE_SORT,
  NOTE_SORT_KEYS,
  type NoteSort,
  type NoteSortKey,
} from "./project-views/NotesView";
import type { PreviewOptions } from "./project-views/view-facts";
import "./ProjectBrowser.css";
import { DEFAULT_PROJECT_LIFECYCLE, isInactiveProject, PROJECT_CATALOG_CHANGED } from "./project-lifecycle";
import { schedulePoll, type PollTag } from "./polls";
import { CloseGlyph } from "../diagrams/ControlGlyphs";
import { GALLERY_INTENT } from "./thumbnail-fetch-ahead";
import { markRouteReady } from "../diagrams/route-ready";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SearchPageProps = {
  readonly state: SearchState;
  readonly onChange: (next: SearchState) => void;
  /** Lets the router distinguish coalesced typing from explicit filter changes. */
  readonly onInteraction?: (intent: BrowserChangeIntent) => void;
  readonly onQueryEnd?: () => void;
  /** Project headings navigate; scope controls edit the current query instead. */
  readonly onOpenProject?: (slug: string) => void;
  readonly globalOverview?: boolean;
  /** The project this page serves: its slug (null where the service has no project catalog), name and files. */
  readonly currentSlug: string | null;
  readonly currentName: string;
  readonly views: readonly DiagramView[];
  readonly notes: readonly ContentsNote[];
  /**
   * The page's own listings of this project's diagrams or notes have not answered yet. Until both have, the files
   * wait as they do for the catalog: the catalog lists each note and diagram as its source file too, and showing
   * those rows (`.archer/notes/…`) for a moment before the note rows replaced them moved the tree (PF-6).
   */
  readonly filesSettling?: boolean;
  readonly failingViewIds?: ReadonlySet<string>;
  readonly presentedViewId?: string | null;
  /** Whether the services search source, notes and comments (`api/search`). */
  readonly serverSearch: boolean;
  /** A routed host may render once before consuming its initial URL. */
  readonly positionReady?: boolean;
  readonly baseUrl: string;
  readonly now: number;
  readonly onOpen: (row: FileRow) => void;
  readonly onOpenMatch: (row: FileRow, match: SearchMatch) => void;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly fetchImpl?: FetchLike;
  /** Advances on comment SSE and stream reconnects, so Commented never follows file-edit timing. */
  readonly commentActivityRefresh?: number;
  /** An explicit sidebar request: expand this project, or all projects for Overview. */
  readonly projectExpansion?: { readonly slug: string | null };
  /** Whether the title section (the page's `h1`) is shown, so the shell's title steps down to text. */
  readonly onTitleSection?: (shown: boolean) => void;
  /** Opens Project settings from the title section's gear; without it the gear is not shown. */
  readonly onOpenSettings?: () => void;
  /** The gear, so the settings dialog returns focus to it on close (Safari does not focus a clicked button). */
  readonly settingsButtonRef?: Ref<HTMLButtonElement>;
  /** The project's own actions (the New menu), at the end of the tab row on every tab of this project's own page. */
  readonly diagramActions?: ReactNode;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const SORT_LABEL: Readonly<Record<SortKey, string>> = {
  name: "Name",
  kind: "Kind",
  type: "Type",
  project: "Project",
  folder: "Path",
  edited: "Edited",
  created: "Created",
  total: "Total threads",
  unresolved: "Unresolved threads",
  commented: "Commented",
};

/**
 * The other projects' files, and which of their diagrams do not compile (asked once per page, and only
 * for the projects in `scope` when it names some: a project page does not ask about projects it is not
 * showing until the reader widens the search, perf #7).
 */
function useOtherProjects(
  currentSlug: string | null,
  baseUrl: string,
  fetchImpl: FetchLike,
  globalOverview = false,
  refresh = 0,
  scope: readonly string[] = [],
): {
  readonly projects: readonly DirectoryProject[];
  readonly current: DirectoryProject | undefined;
  readonly failing: ReadonlyMap<string, ReadonlySet<string>>;
  /** Projects the catalog named that this page cannot list. */
  readonly unavailable: readonly UnavailableProject[];
  readonly status: "loading" | "ready" | "none" | "error";
} {
  const remembered = currentSlug === null && !globalOverview ? undefined : rememberedProjectCatalog(fetchImpl);
  const [catalog, setCatalog] = useState<readonly DirectoryProject[]>(
    remembered?.status === "ready" ? remembered.projects : [],
  );
  const [unavailable, setUnavailable] = useState<readonly UnavailableProject[]>(
    remembered?.status === "ready" ? (remembered.unavailable ?? NONE_UNAVAILABLE) : NONE_UNAVAILABLE,
  );
  const [status, setStatus] = useState<"loading" | "ready" | "none" | "error">(
    currentSlug === null && !globalOverview ? "none" : (remembered?.status ?? "loading"),
  );
  const [failing, setFailing] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  useEffect(() => {
    if (currentSlug === null && !globalOverview) return;
    let live = true;
    const reload = (poll?: PollTag) =>
      loadProjectCatalog(fetchImpl, poll).then((result) => {
        if (!live) return;
        if (result.status === "ready") {
          setCatalog(result.projects);
          setUnavailable(result.unavailable ?? NONE_UNAVAILABLE);
        }
        setStatus(result.status);
      });
    reload();
    const wake = () => (document.hidden ? undefined : reload());
    const tick = (poll?: PollTag) => (document.hidden ? undefined : reload(poll));
    const changed = () => {
      const next = rememberedProjectCatalog(fetchImpl);
      if (next?.status === "ready") {
        setCatalog(next.projects);
        setUnavailable(next.unavailable ?? NONE_UNAVAILABLE);
        setStatus("ready");
      }
    };
    const stopPoll = schedulePoll("project-catalog", tick);
    window.addEventListener("online", wake);
    window.addEventListener(PROJECT_CATALOG_CHANGED, changed);
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false;
      stopPoll();
      window.removeEventListener("online", wake);
      window.removeEventListener(PROJECT_CATALOG_CHANGED, changed);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [currentSlug, fetchImpl, globalOverview, refresh]);
  const others = useMemo(() => catalog.filter((project) => project.slug !== currentSlug), [catalog, currentSlug]);
  const scopeKey = scope.join("\n");
  const asked = useMemo(
    () => (scope.length === 0 ? others : others.filter((project) => scope.includes(project.slug))),
    // `scope` is named by its slugs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [others, scopeKey],
  );
  const othersKey = asked.map((project) => project.slug).join("\n");
  useEffect(() => {
    if (asked.length === 0) return;
    const controller = new AbortController();
    void Promise.all(
      asked.map(async (project): Promise<readonly [string, ReadonlySet<string>]> => {
        const base = projectResourceBase(baseUrl, project.slug);
        if (base === null) return [project.slug, new Set()];
        try {
          const response = await fetchImpl(new URL("api/compile", base).href, {
            cache: "no-store",
            signal: controller.signal,
          });
          const failures = response.ok ? parseCompileStatus(await response.json()) : undefined;
          return [project.slug, new Set((failures ?? []).map((failure) => failure.viewId))];
        } catch {
          return [project.slug, new Set()];
        }
      }),
    ).then((answers) => {
      // Answers for projects asked earlier stay until asked again: widening, then narrowing, keeps them.
      if (!controller.signal.aborted) setFailing((current) => new Map([...current, ...answers]));
    });
    return () => controller.abort();
    // `asked` is named by its slugs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [othersKey, baseUrl, fetchImpl]);
  return {
    projects: others,
    current: catalog.find((project) => project.slug === currentSlug),
    failing,
    unavailable,
    status,
  };
}

const NONE_UNAVAILABLE: readonly UnavailableProject[] = [];
const UNAVAILABLE_REASON = { "too-large": "Too large to list here", malformed: "Could not be read" } as const;

/**
 * What each project's service found for what is typed, after a pause: the
 * targets, and where each matched. A word that is in a project's name has
 * already matched every file there, so it is not sent to that project.
 */
function useContentSearch(
  query: string,
  projects: readonly IndexedProject[],
  enabled: boolean,
  baseUrl: string,
  fetchImpl: FetchLike,
): {
  readonly hits: ContentHits | null;
  readonly matches: ReadonlyMap<string, MatchSummary>;
  readonly pending: boolean;
  readonly failed: readonly string[];
} {
  const sent = searchQuery(query);
  const words = queryWords(sent);
  const asking = enabled && words.length > 0;
  const projectKey = projects.map((project) => `${project.slug}:${project.name}`).join("\n");
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly hits: ContentHits;
    readonly matches: ReadonlyMap<string, MatchSummary>;
    readonly failed: readonly string[];
  } | null>(null);
  const key = `${sent}\n${projectKey}`;
  useEffect(() => {
    if (!asking) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void Promise.all(
        projects.map(async (project) => {
          const remaining = words.filter((word) => !project.name.toLowerCase().includes(word)).join(" ");
          const none = {
            slug: project.slug,
            targets: new Set<BrowserSearchTarget>(),
            matches: new Map<BrowserSearchTarget, MatchSummary>(),
            failed: false,
          };
          if (remaining === "") return none;
          // This project's service by the page's own relative path, as every other read here; another's by its page.
          const base = project.current ? null : projectResourceBase(baseUrl, project.slug);
          if (!project.current && base === null) return { ...none, failed: true };
          try {
            const query = new URLSearchParams({ q: remaining }).toString();
            const url =
              base === null ? `api/browser-search?${query}` : `${new URL("api/browser-search", base).href}?${query}`;
            const response = await fetchImpl(url, { cache: "no-store", signal: controller.signal });
            if (!response.ok) throw new Error(`search failed with HTTP ${response.status}`);
            const parsed = parseBrowserSearch(await response.json());
            if (parsed === undefined) throw new Error("not a search answer");
            // A diagram found only through a note about it is that note's hit, not its own: the note
            // has a row of its own, and every diagram it is about would otherwise match with it.
            const own = parsed.results.flatMap((result) => {
              if (!result.target.startsWith("view:")) return [result];
              const matches = result.matches.filter((match) => match.field !== "note");
              return matches.length === 0
                ? []
                : [{ ...result, matches, where: result.where.filter((place) => place !== "note") }];
            });
            const found = searchHits({ ...parsed, results: own, query: remaining });
            return {
              slug: project.slug,
              targets: new Set(own.map((result) => result.target)),
              matches: found.matches,
              failed: false,
            };
          } catch {
            return { ...none, failed: !controller.signal.aborted };
          }
        }),
      ).then((results) => {
        if (controller.signal.aborted) return;
        const matches = new Map<string, MatchSummary>();
        for (const result of results)
          for (const [target, summary] of result.matches) matches.set(`${result.slug}\0${target}`, summary);
        setAnswer({
          key,
          hits: new Map(results.map((result) => [result.slug, result.targets])),
          matches,
          failed: projects
            .filter((project) => results.find((result) => result.slug === project.slug)?.failed === true)
            .map((project) => project.name),
        });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `projects` is named by `projectKey`, and the words by `sent`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, asking, baseUrl, fetchImpl]);
  const current = asking && answer?.key === key ? answer : null;
  return {
    hits: current?.hits ?? null,
    matches: current?.matches ?? new Map(),
    pending: asking && current === null,
    failed: current?.failed ?? [],
  };
}

/** A filter of checkboxes, each with how many files it would show. */
function Choices<K extends string>(props: {
  readonly legend: string;
  readonly options: readonly { readonly id: K; readonly label: string }[];
  readonly chosen: readonly K[];
  readonly counts: ReadonlyMap<K, number>;
  readonly onChange: (next: K[]) => void;
}): JSX.Element | null {
  const { legend, options, chosen, counts, onChange } = props;
  if (options.length === 0) return null;
  return (
    <fieldset className="archer-search-facet">
      <legend>{legend}</legend>
      {options.map((option) => {
        const on = chosen.includes(option.id);
        const count = counts.get(option.id) ?? 0;
        return (
          <label key={option.id} className="archer-search-choice" data-empty={count === 0 && !on ? "true" : undefined}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onChange(on ? chosen.filter((c) => c !== option.id) : [...chosen, option.id])}
            />
            <span className="archer-search-choice-label">{option.label}</span>
            {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label replaces the bare number in the name the enclosing control or cell computes from its content (accname); tests pin it. */}
            <span className="archer-search-choice-count" aria-label={plural(count, "file", "files")}>
              {count}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

type DateMode = "" | DatePreset | "after" | "before" | "between";

const dateModeOf = (range: DateRange | null): DateMode => {
  if (range === null) return "";
  if ("preset" in range) return range.preset;
  if (range.from !== undefined && range.to !== undefined) return "between";
  if (range.from !== undefined) return "after";
  if (range.to !== undefined) return "before";
  return "";
};

/** A date filter whose incomplete custom draft does not claim to be active. */
function DateFilter(props: {
  readonly label: string;
  readonly range: DateRange | null;
  readonly counts: ReadonlyMap<DatePreset | "", number>;
  readonly onChange: (next: DateRange | null) => void;
}): JSX.Element {
  const { label, range, counts, onChange } = props;
  const id = useId();
  const fromId = useId();
  const toId = useId();
  const errorId = useId();
  const [mode, setMode] = useState<DateMode>(() => dateModeOf(range));
  const [from, setFrom] = useState(range !== null && !("preset" in range) ? (range.from ?? "") : "");
  const [to, setTo] = useState(range !== null && !("preset" in range) ? (range.to ?? "") : "");

  useEffect(() => {
    setMode(dateModeOf(range));
    setFrom(range !== null && !("preset" in range) ? (range.from ?? "") : "");
    setTo(range !== null && !("preset" in range) ? (range.to ?? "") : "");
  }, [
    range !== null && "preset" in range ? range.preset : undefined,
    range !== null && !("preset" in range) ? range.from : undefined,
    range !== null && !("preset" in range) ? range.to : undefined,
  ]);

  const commitCustom = (nextMode: DateMode, nextFrom: string, nextTo: string): void => {
    if (nextMode === "after" && nextFrom !== "") onChange({ from: nextFrom });
    else if (nextMode === "before" && nextTo !== "") onChange({ to: nextTo });
    else if (nextMode === "between" && nextFrom !== "" && nextTo !== "" && nextFrom <= nextTo)
      onChange({ from: nextFrom, to: nextTo });
  };
  const error =
    mode === "between" && from !== "" && to !== "" && from > to ? "Start date cannot be after end date." : null;
  return (
    <fieldset className="archer-search-facet archer-search-date">
      <legend className="archer-visually-hidden">{label}</legend>
      <label htmlFor={id} className="archer-search-facet-label">
        {label}
      </label>
      <select
        id={id}
        value={mode}
        onChange={(event) => {
          const next = event.target.value as DateMode;
          setMode(next);
          if (next === "") onChange(null);
          else if (DATE_PRESETS.some((preset) => preset.id === next)) onChange({ preset: next as DatePreset });
          else commitCustom(next, from, to);
        }}
      >
        <option value="">Any time ({counts.get("") ?? 0})</option>
        {DATE_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label} ({counts.get(preset.id) ?? 0})
          </option>
        ))}
        <option value="after">On or after…</option>
        <option value="before">On or before…</option>
        <option value="between">Between dates…</option>
      </select>
      {mode === "after" ? (
        <div className="archer-search-range">
          <label htmlFor={fromId}>
            Date
            <input
              id={fromId}
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                commitCustom(mode, event.target.value, to);
              }}
            />
          </label>
        </div>
      ) : null}
      {mode === "before" ? (
        <div className="archer-search-range">
          <label htmlFor={toId}>
            Date
            <input
              id={toId}
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                commitCustom(mode, from, event.target.value);
              }}
            />
          </label>
        </div>
      ) : null}
      {mode === "between" ? (
        <div className="archer-search-range">
          <label htmlFor={fromId}>
            From
            <input
              id={fromId}
              type="date"
              value={from}
              max={to || undefined}
              aria-invalid={error !== null ? "true" : undefined}
              aria-describedby={error === null ? undefined : errorId}
              onChange={(event) => {
                setFrom(event.target.value);
                commitCustom(mode, event.target.value, to);
              }}
            />
          </label>
          <label htmlFor={toId}>
            To
            <input
              id={toId}
              type="date"
              value={to}
              min={from || undefined}
              aria-invalid={error !== null ? "true" : undefined}
              aria-describedby={error === null ? undefined : errorId}
              onChange={(event) => {
                setTo(event.target.value);
                commitCustom(mode, from, event.target.value);
              }}
            />
          </label>
          <p className="archer-search-range-note">Includes both dates.</p>
        </div>
      ) : null}
      {error === null ? null : (
        <p id={errorId} className="archer-search-range-error" role="alert">
          {error} The current filter remains applied.
        </p>
      )}
    </fieldset>
  );
}

export function SearchPage(props: SearchPageProps): JSX.Element {
  const {
    state,
    onChange,
    currentSlug,
    currentName,
    views,
    notes,
    failingViewIds,
    presentedViewId,
    serverSearch,
    baseUrl,
    now,
    onOpen,
    onOpenMatch,
  } = props;
  const fetchImpl = props.fetchImpl ?? browserFetch;
  const inputId = useId();
  const summaryId = useId();
  const tabsId = useId();
  const treeColumns = useTreeColumns();
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(restoredCollapsedProjects);
  const appliedExpansion = useRef<SearchPageProps["projectExpansion"]>(undefined);
  const toggleProject = useCallback((slug: string): void => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);
  const [draftQuery, setDraftQuery] = useState(state.query);
  // Reloads, shared addresses and history navigation replace the draft. A
  // scope or filter change leaves text the reader has not submitted intact.
  useEffect(() => setDraftQuery(state.query), [state.query]);
  const theme = useResolvedTheme();
  const others = useOtherProjects(
    currentSlug,
    baseUrl,
    fetchImpl,
    props.globalOverview,
    props.commentActivityRefresh,
    state.projects,
  );
  // Until the catalog names this project its coverage is unverified. While it is read the files wait; once a read
  // has failed they show, reported incomplete (ADR 0017), not hidden as "0 files" until a later poll (O33).
  const awaitingCoverage =
    currentSlug !== null &&
    ((others.current === undefined && others.status === "loading") || props.filesSettling === true);
  const coverageUnknown = currentSlug !== null && others.current === undefined && others.status === "error";
  type LifecycleIndexedProject = IndexedProject & Pick<DirectoryProject, "lifecycle">;
  const directoryProjects: LifecycleIndexedProject[] = useMemo(
    () => [
      ...(props.globalOverview
        ? []
        : [
            {
              slug: currentSlug ?? "",
              name: currentName,
              ...(others.current?.description === undefined ? {} : { description: others.current.description }),
              views: awaitingCoverage ? [] : views,
              notes: awaitingCoverage ? [] : notes,
              ...(awaitingCoverage || others.current?.documents === undefined
                ? {}
                : { documents: others.current.documents }),
              lifecycle: others.current?.lifecycle ?? DEFAULT_PROJECT_LIFECYCLE,
              current: true,
              ...(failingViewIds === undefined ? {} : { failingViewIds }),
              presentedViewId: presentedViewId ?? null,
            },
          ]),
      ...others.projects.map((project) => ({
        ...project,
        current: false,
        failingViewIds: others.failing.get(project.slug) ?? new Set<string>(),
      })),
    ],
    [
      currentSlug,
      currentName,
      views,
      notes,
      failingViewIds,
      presentedViewId,
      others.current,
      others.projects,
      others.failing,
      props.globalOverview,
      awaitingCoverage,
    ],
  );
  useEffect(() => {
    const request = props.projectExpansion;
    if (request === undefined || request === appliedExpansion.current || others.status === "loading") return;
    appliedExpansion.current = request;
    setCollapsedProjects(
      new Set(
        request.slug === null
          ? []
          : directoryProjects.filter((project) => project.slug !== request.slug).map((project) => project.slug),
      ),
    );
  }, [props.projectExpansion, directoryProjects, others.status]);
  // Comment activity only for the projects on show (the page's scope), as for compile status above.
  const activityScope = state.projects.join("\n");
  const activityProjects = useMemo(
    () =>
      (others.status === "loading"
        ? []
        : directoryProjects.filter(
            (project) =>
              project.slug !== "" &&
              (state.projects.length === 0 || project.current || state.projects.includes(project.slug)),
          )
      ).map((project) => ({
        slug: project.slug,
        current: project.current,
        targetKey: `${project.views.map((view) => `view:${view.id}`).join("\0")}\0${project.notes.map((note) => `note:${note.path}`).join("\0")}`,
      })),
    // `state.projects` is named by `activityScope`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [directoryProjects, others.status, activityScope],
  );
  const commentActivity = useCommentActivity(activityProjects, baseUrl, fetchImpl, props.commentActivityRefresh ?? 0);
  const projects: LifecycleIndexedProject[] = useMemo(
    () =>
      directoryProjects.map((project) => ({
        ...project,
        ...(commentActivity.has(project.slug) ? { commentActivity: commentActivity.get(project.slug)! } : {}),
      })),
    [directoryProjects, commentActivity],
  );
  const rows = useMemo(() => projects.flatMap(fileRows), [projects]);
  // The list is rendered with what it will show: the list pages' route-ready point (performance rubric S7).
  const listSettled = !awaitingCoverage && others.status !== "loading";
  useEffect(() => {
    if (listSettled) markRouteReady("list");
  }, [listSettled]);
  const scopedProjects = useMemo(
    () =>
      state.projects.length === 0 ? projects : projects.filter((project) => state.projects.includes(project.slug)),
    [projects, state.projects],
  );
  const content = useContentSearch(state.query, scopedProjects, serverSearch, baseUrl, fetchImpl);
  const shown = useMemo(() => searchRows(rows, state, content.hits, now), [rows, state, content.hits, now]);
  const counts = useMemo(() => facetsOf(rows, state, content.hits, now), [rows, state, content.hits, now]);
  const many = projects.length > 1;
  const set = (patch: Partial<SearchState>, intent: BrowserChangeIntent = "filter"): void => {
    props.onInteraction?.(intent);
    onChange(editBrowserFilters(state, patch));
  };
  const submitSearch = (): void => {
    set({ query: draftQuery }, "query");
    props.onQueryEnd?.();
  };
  // An explicit move to a folder or project (its name in the tree): the row that was pressed is gone from the
  // destination, so the destination's region takes the focus once it is shown. Back restores the row instead
  // (`restoreBrowserPosition`), and sets no flag.
  const rootRef = useRef<HTMLElement>(null);
  const arrived = useRef(false);
  const place = `${state.folder ?? ""}\0${state.projects.join("\0")}`;
  useEffect(() => {
    if (!arrived.current) return;
    arrived.current = false;
    const root = rootRef.current;
    (root?.parentElement?.closest<HTMLElement>("[data-browser-region]") ?? root)?.focus({ preventScroll: true });
  }, [place]);
  const openProject = (slug: string): void => {
    arrived.current = true;
    if (props.onOpenProject) props.onOpenProject(slug);
    else {
      props.onInteraction?.("scope");
      onChange(browserNavigationState(slug, null, state));
    }
  };
  /** A folder's name: explicit navigation to its page, so the query and filters clear (ADR 0017) and only the sort stays. */
  const openFolder = (slug: string, path: string): void => {
    arrived.current = true;
    saveBrowserPosition();
    props.onInteraction?.("scope");
    onChange(browserNavigationState(slug, path, state));
  };
  const sortBy = (key: SortKey): void =>
    set({
      sort: {
        key,
        dir:
          state.sort.key === key
            ? state.sort.dir === "asc"
              ? "desc"
              : "asc"
            : key === "edited" || key === "created" || key === "commented" || key === "total" || key === "unresolved"
              ? "desc"
              : "asc",
      },
    });
  // The Notes view's Author column has no page-address sort key: that sort is the view's own until
  // the reader picks a column the address knows, which then starts at its first direction.
  const [noteSort, setNoteSort] = useState<NoteSort | null>(null);
  const sortNotesBy = (key: string): void => {
    if (!(SORT_KEYS as readonly string[]).includes(key)) {
      setNoteSort(
        nextNoteSort(
          noteSort ??
            ((NOTE_SORT_KEYS as readonly string[]).includes(state.sort.key)
              ? (state.sort as NoteSort)
              : DEFAULT_NOTE_SORT),
          key as NoteSortKey,
        ),
      );
      return;
    }
    if (noteSort === null) {
      sortBy(key as SortKey);
      return;
    }
    setNoteSort(null);
    set({ sort: { key: key as SortKey, dir: firstDirection(key as NoteSortKey) } });
  };
  const types = [
    ...new Set(rows.filter((row) => row.kind === "diagram" && row.type !== null).map((row) => row.type!)),
  ].sort((a, b) => diagramTypeLabel(a).localeCompare(diagramTypeLabel(b)));
  const folders = [
    ...new Set(
      rows.flatMap((row) => {
        const parts = row.folder === "" ? [] : row.folder.split("/");
        return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
      }),
    ),
  ].sort();
  const hasTopLevel = rows.some((row) => row.folder === "");
  const filters = filterCount(state);
  const typed = queryWords(state.query).length > 0;
  const galleryProjects =
    state.projects.length === 0 ? [...projects] : projects.filter((project) => state.projects.includes(project.slug));
  if (state.sort.key === "project") {
    const direction = state.sort.dir === "asc" ? 1 : -1;
    galleryProjects.sort(
      (a, b) => direction * a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
    );
  }

  // Until the other projects are listed, and their services have answered, an empty table is not yet an answer.
  const listing = others.status === "loading";
  const pending = content.pending || listing;
  // The tab counts wait as the files do (PF-6): a held listing is not "0" (S6; codex-205, claude-206).
  const countsPending = pending || awaitingCoverage;
  const restoreNeeded = useRef(true);
  const [restorePass, setRestorePass] = useState(0);
  useEffect(() => {
    const restore = () => {
      restoreNeeded.current = true;
      setRestorePass((pass) => pass + 1);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (props.positionReady !== false && !pending && restoreNeeded.current && restoreBrowserPosition())
      restoreNeeded.current = false;
  }, [pending, shown.length, restorePass, props.positionReady]);
  const matchedProjects = new Set(shown.map((row) => row.slug));
  const displayProjects =
    typed && !pending && state.projects.length === 0
      ? galleryProjects.filter((project) => matchedProjects.has(project.slug))
      : galleryProjects;
  const inactiveProjects = props.globalOverview
    ? displayProjects.filter((project) => isInactiveProject(project.lifecycle))
    : [];
  const inactiveSlugs = new Set(inactiveProjects.map((project) => project.slug));
  const ordinaryProjects = props.globalOverview
    ? displayProjects.filter((project) => !inactiveSlugs.has(project.slug))
    : displayProjects;
  const inactiveRows = shown.filter((row) => inactiveSlugs.has(row.slug));
  const ordinaryRows = props.globalOverview ? shown.filter((row) => !inactiveSlugs.has(row.slug)) : shown;
  const revealInactive = typed || filters > 0 || state.projects.length > 0 || state.folder !== null;
  const currentProject = projects.find((project) => project.current);
  const incomplete = [
    ...(coverageUnknown ? [{ name: currentName }] : []),
    ...[...(others.current ? [others.current] : []), ...others.projects].filter(
      (project) => project.discoveryComplete === false,
    ),
  ];
  const summary = [
    plural(shown.length, "file", "files"),
    listing ? "listing the other projects…" : null,
    content.pending ? "searching diagrams, notes and comments…" : null,
    content.failed.length > 0
      ? `content search unavailable for ${content.failed.join(", ")}; names and descriptions still match`
      : null,
    others.status === "error" ? "other projects could not be listed" : null,
    incomplete.length === 0
      ? null
      : `Documentation listing incomplete for ${incomplete.map((project) => project.name).join(", ")}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape" && (draftQuery !== "" || state.query !== "")) {
      // Its own Esc, before the page's.
      event.preventDefault();
      event.stopPropagation();
      setDraftQuery("");
      if (state.query !== "") set({ query: "" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      submitSearch();
    }
  };

  const filesFilterCount = state.kinds.length + state.types.length + (state.folder === null ? 0 : 1);
  const discussionsFilterCount =
    state.status.length + (state.totalThreads === null ? 0 : 1) + (state.unresolvedThreads === null ? 0 : 1);
  const datesFilterCount =
    (state.edited === null ? 0 : 1) + (state.created === null ? 0 : 1) + (state.commented === null ? 0 : 1);
  // A project's own page already names its project; a chip for that scope only repeats the address.
  const ownProjectScope =
    !props.globalOverview &&
    currentProject !== undefined &&
    state.projects.length === 1 &&
    state.projects[0] === currentProject.slug;
  const scopedProjectNames = ownProjectScope
    ? []
    : state.projects.map((slug) => projects.find((project) => project.slug === slug)?.name ?? slug);
  // The filters the person set: a project page's own scope is the page, not one of them.
  const setFilters = filters - (ownProjectScope ? 1 : 0);
  // Clearing them keeps the words and this page's own project, so it never widens to every project (E5, O94).
  const clearFilters = (): void =>
    onChange({
      ...EMPTY_SEARCH,
      query: state.query,
      sort: state.sort,
      tab: state.tab,
      projects: ownProjectScope ? state.projects : [],
    });
  const ownInput = useRef<HTMLInputElement | null>(null);
  const givenInputRef = props.inputRef;
  const inputRef = useCallback(
    (input: HTMLInputElement | null): void => {
      ownInput.current = input;
      if (typeof givenInputRef === "function") givenInputRef(input);
      else if (givenInputRef !== undefined && givenInputRef !== null)
        (givenInputRef as { current: HTMLInputElement | null }).current = input;
    },
    [givenInputRef],
  );
  /** The empty result's step: the words go, the filters and scope stay, and focus waits in the emptied box. */
  const clearSearch = (): void => {
    setDraftQuery("");
    set({ query: "" }, "query");
    ownInput.current?.focus();
  };

  const filterContent = (
    <div className="archer-filter-sections">
      <FilterSection title="Order" activeCount={0} defaultOpen>
        <div className="archer-search-facet">
          <label className="archer-search-facet-label">
            Sort by
            <select
              aria-label="Sort by"
              value={`${state.sort.key}:${state.sort.dir}`}
              onChange={(event) => {
                const [key, dir] = event.target.value.split(":") as [SortKey, "asc" | "desc"];
                set({ sort: { key, dir } });
              }}
            >
              {SORT_KEYS.filter((key) => many || key !== "project").flatMap((key) =>
                (["asc", "desc"] as const).map((dir) => (
                  <option key={`${key}:${dir}`} value={`${key}:${dir}`}>
                    {SORT_LABEL[key]},{" "}
                    {key === "edited" || key === "created" || key === "commented"
                      ? dir === "desc"
                        ? "newest first"
                        : "oldest first"
                      : key === "total" || key === "unresolved"
                        ? dir === "desc"
                          ? "highest first"
                          : "lowest first"
                        : dir === "asc"
                          ? "A to Z"
                          : "Z to A"}
                  </option>
                )),
              )}
            </select>
          </label>
        </div>
      </FilterSection>
      <FilterSection title="Files" activeCount={filesFilterCount} defaultOpen>
        <div className="archer-filter-files-primary">
          <Choices<FileKind>
            legend="Kind"
            options={[
              { id: "diagram", label: "Diagrams" },
              { id: "note", label: "Notes" },
            ]}
            chosen={state.kinds}
            counts={counts.kinds}
            onChange={(next) => set({ kinds: next })}
          />
          {folders.length === 0 ? null : (
            <FolderFilter
              folders={folders}
              hasTopLevel={hasTopLevel}
              value={state.folder}
              counts={counts.folders}
              onChange={(folder) => set({ folder })}
            />
          )}
        </div>
        {types.length === 0 ? null : (
          <div className="archer-filter-files-types">
            <Choices
              legend="Diagram type"
              options={types.map((type) => ({ id: type, label: diagramTypeLabel(type) }))}
              chosen={state.types}
              counts={counts.types}
              onChange={(next) => set({ types: next })}
            />
          </div>
        )}
      </FilterSection>
      <FilterSection title="Discussions" activeCount={discussionsFilterCount} defaultOpen>
        <div className="archer-filter-discussions-status">
          <Choices<Status>
            legend="Status"
            options={[
              { id: "failing", label: "Does not compile" },
              { id: "comments", label: "Has open threads" },
            ]}
            chosen={state.status}
            counts={counts.status}
            onChange={(next) => set({ status: next })}
          />
        </div>
        <div className="archer-filter-discussions-counts">
          <CountRangeFilter
            label="Total threads"
            range={state.totalThreads}
            onChange={(totalThreads) => set({ totalThreads })}
          />
          <CountRangeFilter
            label="Unresolved threads"
            range={state.unresolvedThreads}
            onChange={(unresolvedThreads) => set({ unresolvedThreads })}
          />
        </div>
      </FilterSection>
      <FilterSection title="Dates" activeCount={datesFilterCount} defaultOpen>
        <div className="archer-filter-date-facets">
          <DateFilter
            label="Edited"
            range={state.edited}
            counts={counts.edited}
            onChange={(edited) => set({ edited })}
          />
          <DateFilter
            label="Created"
            range={state.created}
            counts={counts.created}
            onChange={(created) => set({ created })}
          />
          <DateFilter
            label="Commented"
            range={state.commented}
            counts={counts.commented}
            onChange={(commented) => set({ commented })}
          />
        </div>
      </FilterSection>
      {setFilters === 0 ? null : (
        <button type="button" className="archer-search-clear" onClick={clearFilters}>
          Clear filters
        </button>
      )}
    </div>
  );

  // One project (its page, or a page whose address names no project, which reads no catalog) is a tree of its
  // folders; more are a tree of projects.
  const single =
    state.projects.length === 1 || (!props.globalOverview && currentSlug === null && others.status === "none");
  // This project's own page, at any folder: where the project's own actions belong.
  const ownPage =
    !props.globalOverview &&
    currentProject !== undefined &&
    (ownProjectScope || (state.projects.length === 0 && others.status === "none"));
  const titleProject = ownPage && state.folder === null ? currentProject : undefined;
  const titleShown = titleProject !== undefined,
    onTitleSection = props.onTitleSection;
  // Before paint: the shell's header steps its title down in the same frame the title section appears, not one
  // frame later (the header lost a line under a painted page, moving everything below it; PF-6).
  useLayoutEffect(() => {
    onTitleSection?.(titleShown);
  }, [onTitleSection, titleShown]);
  useLayoutEffect(() => () => onTitleSection?.(false), [onTitleSection]);
  const titleRows = useMemo(() => rows.filter((row) => row.current), [rows]);
  const listRows = props.globalOverview ? [...ordinaryRows, ...(revealInactive ? inactiveRows : [])] : shown;
  const diagramRows = listRows.filter((row) => row.kind === "diagram");
  // Notes are the Archer folder's notes, as the facts line counts them; a README or another
  // discovered document is a read-only file of the Folders tab.
  const noteRows = listRows.filter((row) => row.kind === "note" && row.sourceDocumentPath === undefined);
  const tabCounts: Readonly<Record<ProjectTab, number>> = {
    folders: shown.length,
    diagrams: diagramRows.length,
    notes: noteRows.length,
  };
  const tabLabel: Readonly<Record<ProjectTab, string>> = { folders: "Folders", diagrams: "Diagrams", notes: "Notes" };
  const tabOrder: readonly ProjectTab[] = ["folders", "diagrams", "notes"];
  // "In notes" is the Diagrams gallery's: it goes with the gallery, as the gallery's type chips do.
  const chooseTab = (tab: ProjectTab): void => {
    if (tab !== state.tab) set({ tab, inNotes: false });
  };
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const at = tabOrder.indexOf(state.tab);
    const next =
      event.key === "ArrowRight"
        ? tabOrder[(at + 1) % tabOrder.length]
        : event.key === "ArrowLeft"
          ? tabOrder[(at + tabOrder.length - 1) % tabOrder.length]
          : event.key === "Home"
            ? tabOrder[0]
            : event.key === "End"
              ? tabOrder.at(-1)
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    chooseTab(next);
    document.getElementById(`${tabsId}-${next}`)?.focus();
  };
  // The page's own scope (its project, its folder) is where the reader is, not a filter that hides files.
  const filtering = typed || filters - state.projects.length - (state.folder === null ? 0 : 1) > 0;
  const preview = (row: FileRow, options?: PreviewOptions): JSX.Element => (
    <DocumentPreview
      row={row}
      baseUrl={baseUrl}
      theme={theme}
      fetchImpl={fetchImpl}
      firstScreen={options?.firstScreen === true}
    />
  );
  const tree = (
    selectedProjects: readonly LifecycleIndexedProject[],
    selectedRows: readonly FileRow[],
    label: string,
  ): JSX.Element =>
    single ? (
      <FolderTree
        label={label}
        rows={selectedRows}
        under={state.folder}
        sort={state.sort}
        onSort={sortBy}
        columns={treeColumns.columns}
        onColumnsReorder={treeColumns.onColumnsChange}
        filtering={filtering}
        now={now}
        onOpen={onOpen}
        onOpenFolder={openFolder}
        currentFolder={{ slug: currentSlug ?? "", path: state.folder ?? "" }}
        matches={content.matches}
        onOpenMatch={onOpenMatch}
      />
    ) : (
      <FolderTree
        label={label}
        rows={selectedRows}
        projects={selectedProjects}
        sort={state.sort}
        onSort={sortBy}
        columns={treeColumns.columns}
        onColumnsReorder={treeColumns.onColumnsChange}
        filtering={filtering}
        now={now}
        onOpen={onOpen}
        onOpenProject={openProject}
        onOpenFolder={openFolder}
        collapsedProjects={collapsedProjects}
        onToggleProject={toggleProject}
        matches={content.matches}
        onOpenMatch={onOpenMatch}
      />
    );
  const emptyList =
    typed || filters > 0 ? "Nothing here matches. Try fewer words, or clear the search and filters." : undefined;
  const panel =
    state.tab === "diagrams" ? (
      <DiagramsView
        rows={diagramRows}
        now={now}
        showProject={!single}
        onOpen={onOpen}
        renderPreview={preview}
        emptyMessage={emptyList ?? "No diagrams yet."}
        inNotes={state.inNotes}
        onInNotes={(inNotes) => set({ inNotes })}
      />
    ) : state.tab === "notes" ? (
      <NotesView
        rows={noteRows}
        now={now}
        showProject={!single}
        onOpen={onOpen}
        renderPreview={preview}
        emptyMessage={emptyList ?? "No notes yet."}
        sort={noteSort ?? state.sort}
        onSort={sortNotesBy}
      />
    ) : (
      <>
        {ordinaryProjects.length > 0 || single ? tree(ordinaryProjects, ordinaryRows, "Project files") : null}
        {inactiveProjects.length > 0 ? (
          <InactiveProjects
            count={inactiveProjects.length}
            matchingFiles={inactiveRows.length}
            revealMatches={revealInactive}
          >
            {tree(inactiveProjects, inactiveRows, "Inactive project files")}
          </InactiveProjects>
        ) : null}
      </>
    );

  return (
    <section
      ref={rootRef}
      className="archer-contents archer-search-page archer-activity-browser"
      aria-label="Search projects and files"
      tabIndex={-1}
    >
      {titleProject === undefined ? null : (
        <>
          <ProjectTitle
            name={titleProject.name}
            {...(titleProject.description === undefined ? {} : { description: titleProject.description })}
            {...(others.current?.facts === undefined ? {} : { facts: others.current.facts })}
            rows={titleRows}
            now={now}
            {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })}
            {...(props.settingsButtonRef === undefined ? {} : { settingsButtonRef: props.settingsButtonRef })}
          />
          {others.current?.readme === undefined ? null : (
            <ProjectReadme
              path={others.current.readme.path}
              resourceBase={(currentSlug === null ? null : projectResourceBase(baseUrl, currentSlug)) ?? baseUrl}
              fetchImpl={fetchImpl}
            />
          )}
        </>
      )}
      <div className="archer-search-bar">
        <div className="archer-browser-search-field">
          <label className="archer-visually-hidden" htmlFor={inputId}>
            Search projects and files
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className="archer-search-input"
            type="search"
            placeholder={
              serverSearch ? "Names, descriptions, diagrams, notes and comments" : "Names, paths and descriptions"
            }
            autoComplete="off"
            spellCheck={false}
            aria-describedby={summaryId}
            aria-keyshortcuts="/"
            value={draftQuery}
            onChange={(event) => {
              setDraftQuery(event.target.value);
              set({ query: event.target.value }, "query");
            }}
            onBlur={props.onQueryEnd}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="archer-search-submit"
            aria-label="Search"
            title="Search"
            onClick={submitSearch}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="m12.2 12.2 4.3 4.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          {/* Filters is the field's trailing control, after Search: a separate button, in the field so the row
              ends where the field does (round 1 pass 5 O1). */}
          <BrowserControls filterContent={filterContent} filterCount={setFilters} resultCount={shown.length} />
        </div>
      </div>
      <div className="archer-search-results">
        <div className="archer-search-summary-line">
          <p id={summaryId} className="archer-search-summary" role="status">
            {summary}
          </p>
          {ownProjectScope && typed ? (
            <button type="button" className="archer-search-widen" onClick={() => set({ projects: [] }, "scope")}>
              Search all projects
            </button>
          ) : null}
          {scopedProjectNames.length === 0 ? null : (
            <button
              type="button"
              className="archer-search-project-scope"
              aria-label="Clear project filter"
              onClick={() => set({ projects: [] }, "scope")}
            >
              {scopedProjectNames.join(", ")}
              <CloseGlyph />
            </button>
          )}
          {state.folder === null ? null : (
            <button
              type="button"
              className="archer-search-project-scope"
              aria-label="Clear folder filter"
              onClick={() => set({ folder: null }, "scope")}
            >
              {state.folder || "Top level"}
              <CloseGlyph />
            </button>
          )}
        </div>
        <div className="archer-project-tab-row">
          <div className="archer-project-tabs" role="tablist" aria-label="Project content">
            {tabOrder.map((tab) => (
              <button
                key={tab}
                id={`${tabsId}-${tab}`}
                type="button"
                role="tab"
                className="archer-project-tab"
                {...(tab === "diagrams" ? { [GALLERY_INTENT]: "" } : {})}
                aria-selected={state.tab === tab}
                aria-controls={`${tabsId}-panel`}
                tabIndex={state.tab === tab ? 0 : -1}
                onClick={() => chooseTab(tab)}
                onKeyDown={tabKeyDown}
              >
                {tabLabel[tab]}
                {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label replaces the bare number in the name the enclosing control or cell computes from its content (accname); tests pin it. */}
                <span
                  className="archer-project-tab-count"
                  data-searching={filtering ? "true" : undefined}
                  data-zero={tabCounts[tab] === 0 ? "true" : undefined}
                  aria-label={plural(
                    tabCounts[tab],
                    tab === "folders" ? "file" : tab === "diagrams" ? "diagram" : "note",
                    tab === "folders" ? "files" : tab,
                  )}
                >
                  {countsPending ? "…" : tabCounts[tab]}
                </span>
              </button>
            ))}
          </div>
          {ownPage && props.diagramActions !== undefined ? (
            <div className="archer-project-tab-actions">{props.diagramActions}</div>
          ) : null}
        </div>
        <div
          id={`${tabsId}-panel`}
          role="tabpanel"
          className="archer-project-tab-panel"
          aria-labelledby={`${tabsId}-${state.tab}`}
          data-tab={state.tab}
        >
          {shown.length === 0 && !pending ? (
            <div className="archer-search-empty" role="status">
              {!typed && setFilters === 0 ? (
                <>
                  <h2>No diagrams or notes yet.</h2>
                  <p>
                    Ask your agent to draw a diagram or write a note. They appear here as soon as the agent adds them.
                  </p>
                  <p>For example, ask for a system overview, a sign-in sequence diagram, or an operations note.</p>
                </>
              ) : (
                <p>
                  {typed
                    ? `Nothing matches “${state.query.trim()}”${setFilters === 0 ? "" : " with these filters"}.`
                    : "No files match these filters."}
                </p>
              )}
              {/* The next step clears what emptied the list: the words first (E5; claude-05, codex-02). Clearing
                    the filters keeps the words and this page's own project, so it never widens to every project. */}
              {typed ? (
                <button type="button" className="archer-search-clear" onClick={clearSearch}>
                  Clear the search
                </button>
              ) : null}
              {setFilters === 0 ? null : (
                <button
                  type="button"
                  className="archer-search-clear"
                  onClick={() =>
                    set(
                      {
                        ...EMPTY_SEARCH,
                        query: state.query,
                        sort: state.sort,
                        tab: state.tab,
                        projects: ownProjectScope ? state.projects : [],
                      },
                      "scope",
                    )
                  }
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : null}
          {others.unavailable.length === 0 ? null : (
            <div className="archer-search-unavailable-block">
              <p id="archer-search-unavailable-label" className="archer-search-unavailable-label">
                Not listed:
              </p>
              <ul className="archer-search-unavailable" aria-labelledby="archer-search-unavailable-label">
                {others.unavailable.map((project, index) => (
                  <li key={project.slug === "" ? `#${index}` : project.slug}>
                    <span className="archer-search-unavailable-name">{project.name}</span>{" "}
                    <span>{UNAVAILABLE_REASON[project.problem]}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {shown.length > 0 || pending || (state.tab === "folders" && inactiveProjects.length > 0) ? (
            <section className="archer-project-documents" aria-label="Project documents">
              {panel}
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function FolderFilter(props: {
  readonly folders: readonly string[];
  readonly hasTopLevel: boolean;
  readonly value: string | null;
  readonly counts: ReadonlyMap<string, number>;
  readonly onChange: (folder: string | null) => void;
}): JSX.Element {
  const id = useId();
  const { folders, hasTopLevel, value, counts, onChange } = props;
  return (
    <div className="archer-search-facet">
      <label htmlFor={id} className="archer-search-facet-label">
        Folder
      </label>
      <select
        id={id}
        value={value ?? "\0"}
        onChange={(event) => onChange(event.target.value === "\0" ? null : event.target.value)}
      >
        <option value={"\0"}>Every folder</option>
        {hasTopLevel ? <option value="">Top level only ({counts.get("") ?? 0})</option> : null}
        {folders.map((folder) => (
          <option key={folder} value={folder}>
            {`${" ".repeat(folder.split("/").length - 1)}${folder.split("/").at(-1)}/ (${counts.get(folder) ?? 0})`}
          </option>
        ))}
        {value !== null && value !== "" && !folders.includes(value) ? (
          <option value={value}>{value}/ (0)</option>
        ) : null}
      </select>
    </div>
  );
}
