import type { BrowserSearchTarget } from "./search";
import type { SourceDocument } from "./source-documents";
import type { ContentsNote } from "./contents";
import { queryWords } from "./diagram-filter";
import type { FileFacts } from "./file-facts";
import { folderOf } from "./folders";
import { parseDiagramAddress } from "../../../shared/note-diagrams.mjs";
import { kindLabel, type DiagramView } from "./inventory";
import { createdSourcePhrase, longDate } from "./file-facts";
import type { CommentActivityByTarget } from "./comment-activity";

export type FileKind = "diagram" | "note";

export type FileRow = FileFacts & {
  /** Unique across projects: the project's slug and the target. */
  readonly key: string;
  readonly slug: string;
  readonly projectName: string;
  readonly projectDescription?: string;
  /** Whether the row is in the project this page is serving. */
  readonly current: boolean;
  readonly kind: FileKind;
  readonly target: BrowserSearchTarget;
  /** A diagram's view id, or a note's path. */
  readonly id: string;
  readonly title: string;
  /** A diagram's kind as Archer names it (`flowchart`), or a note's `type`; null when it has none. */
  readonly type: string | null;
  /** Folder-relative path of the file; a diagram with no source path is named by its id. */
  readonly path: string;
  /** Project-relative source identity for configured documentation outside legacy inventory. */
  readonly sourceDocumentPath?: string;
  /** An Archer-folder file has the document's path, so the document is addressed at `-/repo/`. */
  readonly sourceDocumentShadowed?: true;
  /** Configured project-relative identity, while path retains legacy folder navigation. */
  readonly sourcePath?: string;
  /** The folder it is in, "" for the Archer folder itself. */
  readonly folder: string;
  readonly failing: boolean;
  /** A diagram's served model revision, which addresses its service thumbnail; absent while it has never compiled. */
  readonly modelRevision?: string;
  /** Its comment threads not yet resolved. */
  readonly openThreads: number;
  /** How many walkthroughs a diagram has (ADR 0034); absent when none. */
  readonly walkthroughs?: number;
  /** A diagram embedded in a note (ADR 0012): the note's path and title, the block's name and its canonical address `note.md#name`. */
  readonly embedded?: {
    readonly note: string;
    readonly noteTitle: string;
    readonly name: string;
    readonly address: string;
  };
  /** Whether the agent is presenting it. */
  readonly presented: boolean;
  /** Project-wide discovery stats; absent when that project's activity endpoint was unavailable. */
  readonly totalThreads?: number;
  readonly unresolvedThreads?: number;
  /** Null means activity is available and no retained comment or reply exists. */
  readonly lastCommentedAt?: string | null;
};

export type IndexedProject = {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly views: readonly DiagramView[];
  readonly notes: readonly ContentsNote[];
  readonly current: boolean;
  readonly documents?: readonly SourceDocument[];
  readonly failingViewIds?: ReadonlySet<string>;
  readonly presentedViewId?: string | null;
  readonly commentActivity?: CommentActivityByTarget;
};

/**
 * A diagram's kind in the reader's words: "Sequence", "Containers". `freeform`
 * is a flowchart nobody gave a kind (the tab strip leaves it unsaid; a table's
 * Type column has to say something), so it reads "Flowchart".
 */
export function diagramTypeLabel(kind: string): string {
  return kind === "freeform" ? "Flowchart" : (kindLabel(kind) ?? kind);
}

/** A row's type in the reader's words: a diagram's kind, a note's `type`. */
export function typeLabel(row: Pick<FileRow, "kind" | "type">): string {
  if (row.type === null) return row.kind === "diagram" ? "Diagram" : "Note";
  return row.kind === "diagram" ? diagramTypeLabel(row.type) : row.type;
}

/** The note an embedded view lives in and its name there, as the view says or its address spells them. */
function embeddedAt(view: DiagramView): { readonly note: string; readonly name: string } | null {
  if (view.registration !== "embedded") return null;
  if (view.note !== undefined && view.name !== undefined) return { note: view.note, name: view.name };
  const at = parseDiagramAddress(view.id);
  return at === null ? null : { note: at.notePath, name: at.name };
}

/**
 * One project's files as rows: its diagram files, the diagrams embedded in its notes (each a row of its
 * own at the block's address, admitted through its note), and its notes.
 */
export function fileRows(project: IndexedProject): FileRow[] {
  const allowedViews =
    project.documents === undefined
      ? null
      : new Set(
          project.documents.flatMap((document) =>
            document.legacy?.viewId === undefined ? [] : [document.legacy.viewId],
          ),
        );
  const allowedNotes =
    project.documents === undefined
      ? null
      : new Set(
          project.documents.flatMap((document) =>
            document.legacy?.notePath === undefined ? [] : [document.legacy.notePath],
          ),
        );
  const sourceViews = new Map(
    project.documents?.flatMap((document) =>
      document.legacy?.viewId === undefined ? [] : [[document.legacy.viewId, document.source.path] as const],
    ) ?? [],
  );
  const sourceNotes = new Map(
    project.documents?.flatMap((document) =>
      document.legacy?.notePath === undefined ? [] : [[document.legacy.notePath, document.source.path] as const],
    ) ?? [],
  );
  const noteTitles = new Map(project.notes.map((note) => [note.path, note.title]));
  // Two blocks of one note under the same heading would read alike; the name tells them apart.
  const headings = new Map<string, number>();
  for (const view of project.views) {
    const at = embeddedAt(view);
    if (at !== null) headings.set(`${at.note}\0${view.title}`, (headings.get(`${at.note}\0${view.title}`) ?? 0) + 1);
  }
  const views: FileRow[] = project.views
    .filter((view) => {
      if (view.registration !== "embedded") return allowedViews === null || allowedViews.has(view.id);
      const at = embeddedAt(view);
      return at !== null && (allowedNotes === null || allowedNotes.has(at.note));
    })
    .map((view) => {
      const at = embeddedAt(view);
      const path = at === null ? (view.sourcePath ?? view.id) : view.id;
      const threads = view.threads;
      const activity = project.commentActivity?.get(`view:${view.id}`);
      return {
        ...facts(view),
        key: `${project.slug}\0view:${view.id}`,
        slug: project.slug,
        projectName: project.name,
        ...(project.description === undefined ? {} : { projectDescription: project.description }),
        current: project.current,
        kind: "diagram",
        target: `view:${view.id}`,
        id: view.id,
        ...(sourceViews.has(view.id) ? { sourcePath: sourceViews.get(view.id)! } : {}),
        title:
          at !== null && (headings.get(`${at.note}\0${view.title}`) ?? 0) > 1
            ? `${view.title}, ${at.name}`
            : view.title,
        type: view.kind,
        path,
        folder: folderOf(at === null ? view.sourcePath : at.note),
        ...(at === null
          ? {}
          : {
              embedded: {
                note: at.note,
                noteTitle: noteTitles.get(at.note) ?? at.note.split("/").at(-1)!,
                name: at.name,
                address: view.id,
              },
            }),
        failing: project.failingViewIds?.has(view.id) ?? false,
        ...(view.modelRevision === undefined ? {} : { modelRevision: view.modelRevision }),
        ...(view.walkthroughs === undefined ? {} : { walkthroughs: view.walkthroughs }),
        openThreads: threads === undefined ? 0 : threads.draft + threads.sent + threads.read + threads.answered,
        presented: project.presentedViewId === view.id,
        ...(activity ?? {}),
      };
    });
  const notes: FileRow[] = project.notes
    .filter((note) => allowedNotes === null || allowedNotes.has(note.path))
    .map((note) => {
      const activity = project.commentActivity?.get(`note:${note.path}`);
      return {
        ...facts(note),
        key: `${project.slug}\0note:${note.path}`,
        slug: project.slug,
        projectName: project.name,
        ...(project.description === undefined ? {} : { projectDescription: project.description }),
        current: project.current,
        kind: "note",
        target: `note:${note.path}`,
        id: note.path,
        ...(sourceNotes.has(note.path) ? { sourcePath: sourceNotes.get(note.path)! } : {}),
        title: note.title,
        type: note.type ?? null,
        path: note.path,
        folder: folderOf(note.path),
        failing: false,
        openThreads:
          note.threads === undefined
            ? 0
            : note.threads.draft + note.threads.sent + note.threads.read + note.threads.answered,
        presented: false,
        ...(activity ?? {}),
      };
    });
  const noteIds = new Set(notes.map((note) => note.id)),
    viewIds = new Set(views.map((view) => view.id));
  const archerFiles = new Set([
    ...project.notes.map((note) => note.path),
    ...project.views.flatMap((view) =>
      view.registration === "embedded" || view.sourcePath === undefined ? [] : [view.sourcePath.replace(/^\.\//, "")],
    ),
  ]);
  const documents: FileRow[] = (project.documents ?? [])
    .filter(
      (document) =>
        !(document.legacy?.notePath !== undefined && noteIds.has(document.legacy.notePath)) &&
        !(document.legacy?.viewId !== undefined && viewIds.has(document.legacy.viewId)),
    )
    .map((document) => ({
      key: `${project.slug}\0source:${document.source.path}`,
      slug: project.slug,
      projectName: project.name,
      current: project.current,
      kind: document.kind === "markdown" ? ("note" as const) : ("diagram" as const),
      id: document.source.path,
      sourceDocumentPath: document.source.path,
      sourcePath: document.source.path,
      ...(archerFiles.has(document.source.path) ? { sourceDocumentShadowed: true as const } : {}),
      target: `source:${document.source.path}` as const,
      title: document.title,
      type: null,
      path: document.source.path,
      folder: folderOf(document.source.path),
      failing: false,
      openThreads: 0,
      presented: false,
      ...(document.description === undefined ? {} : { description: document.description }),
    }));
  return [...views, ...notes, ...documents];
}

/** The row of the note an embedded diagram lives in, for opening it from the diagram's row; null for any other row. */
export function noteRowOf(row: FileRow): FileRow | null {
  const at = row.embedded;
  if (at === undefined) return null;
  const { embedded: _embedded, modelRevision: _revision, walkthroughs: _walkthroughs, ...rest } = row;
  return {
    ...rest,
    key: `${row.slug}\0note:${at.note}`,
    kind: "note",
    target: `note:${at.note}`,
    id: at.note,
    title: at.noteTitle,
    type: null,
    path: at.note,
    failing: false,
    presented: false,
    openThreads: 0,
  };
}

function facts(item: FileFacts): FileFacts {
  return {
    ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
    ...(item.createdFrom === undefined ? {} : { createdFrom: item.createdFrom }),
    ...(item.modifiedAt === undefined ? {} : { modifiedAt: item.modifiedAt }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.descriptionFrom === undefined ? {} : { descriptionFrom: item.descriptionFrom }),
    ...(item.author === undefined ? {} : { author: item.author }),
  };
}

// ------------------------------------------------------------ the search state

export type DatePreset = "1d" | "7d" | "30d" | "365d";
export const DATE_PRESETS: readonly { readonly id: DatePreset; readonly label: string; readonly days: number }[] = [
  { id: "1d", label: "Past day", days: 1 },
  { id: "7d", label: "Past week", days: 7 },
  { id: "30d", label: "Past month", days: 30 },
  { id: "365d", label: "Past year", days: 365 },
];
/** A preset, or a range of calendar days (`YYYY-MM-DD`, either end open). */
export type DateRange = { readonly preset: DatePreset } | { readonly from?: string; readonly to?: string };
export type CountRange = { readonly min?: number; readonly max?: number };

export const SORT_KEYS = [
  "name",
  "kind",
  "type",
  "project",
  "folder",
  "edited",
  "created",
  "total",
  "unresolved",
  "commented",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type Sort = { readonly key: SortKey; readonly dir: "asc" | "desc" };
/** Newest edits first: what a reader coming back to a project usually wants. */
export const DEFAULT_SORT: Sort = { key: "edited", dir: "desc" };

export const STATUSES = ["failing", "comments"] as const;
export type Status = (typeof STATUSES)[number];

/** The project browser's tabs (`?tab=`); Folders, the default, is left out of the address. */
export const PROJECT_TABS = ["folders", "diagrams", "notes"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
export const DEFAULT_PROJECT_TAB: ProjectTab = "folders";

export type SearchState = {
  readonly query: string;
  readonly projects: readonly string[];
  readonly kinds: readonly FileKind[];
  readonly types: readonly string[];
  /** A folder and everything under it; null for every folder. */
  readonly folder: string | null;
  readonly status: readonly Status[];
  readonly edited: DateRange | null;
  readonly created: DateRange | null;
  readonly totalThreads: CountRange | null;
  readonly unresolvedThreads: CountRange | null;
  readonly commented: DateRange | null;
  readonly sort: Sort;
  /** Which tab shows the files; the search and filters apply to every tab. */
  readonly tab: ProjectTab;
  /** The Diagrams gallery's "In notes" chip: only the diagrams embedded in notes (`?in=notes`). */
  readonly inNotes: boolean;
};

export const EMPTY_SEARCH: SearchState = {
  query: "",
  projects: [],
  kinds: [],
  types: [],
  folder: null,
  status: [],
  edited: null,
  created: null,
  totalThreads: null,
  unresolvedThreads: null,
  commented: null,
  sort: DEFAULT_SORT,
  tab: DEFAULT_PROJECT_TAB,
  inNotes: false,
};

/** The search page's parameters. Its words are `q` (flows-r1 S4: one spelling), and `q` alone says the page is open. */
export const SEARCH_PARAMS = [
  "q",
  "project",
  "kind",
  "type",
  "under",
  "status",
  "edited",
  "created",
  "total",
  "unresolved",
  "commented",
  "sort",
  "tab",
  "in",
] as const;

const MAX_PARAM_CHARS = 512;
const MAX_VALUES = 64;
const DAY = /^\d{4}-\d\d-\d\d$/;

function readRange(raw: string | null): DateRange | null {
  if (raw === null) return null;
  const preset = DATE_PRESETS.find((p) => p.id === raw);
  if (preset !== undefined) return { preset: preset.id };
  const [from, to, ...rest] = raw.split("..");
  if (rest.length > 0 || to === undefined) return null;
  const range = { ...(DAY.test(from ?? "") ? { from: from! } : {}), ...(DAY.test(to) ? { to } : {}) };
  return "from" in range || "to" in range ? range : null;
}

function writeRange(range: DateRange): string {
  return "preset" in range ? range.preset : `${range.from ?? ""}..${range.to ?? ""}`;
}

function readCountRange(raw: string | null): CountRange | null {
  if (raw === null) return null;
  const [minRaw, maxRaw, ...rest] = raw.split("..");
  if (rest.length > 0 || maxRaw === undefined) return null;
  const integer = (part: string): number | undefined => {
    if (!/^\d+$/u.test(part)) return undefined;
    const value = Number(part);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const min = integer(minRaw ?? "");
  const max = integer(maxRaw);
  if (min === undefined && max === undefined) return null;
  if (min !== undefined && max !== undefined && min > max) return null;
  return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}

const writeCountRange = (range: CountRange): string => `${range.min ?? ""}..${range.max ?? ""}`;

/** The search page `q` names, or null when the address names none. */
export function readSearchState(search: string): SearchState | null {
  const query = new URLSearchParams(search);
  const typed = query.get("q");
  if (typed === null) return null;
  const many = (name: string): string[] =>
    [...new Set(query.getAll(name).filter((v) => v !== "" && v.length <= MAX_PARAM_CHARS))].slice(0, MAX_VALUES);
  const sortRaw = query.get("sort") ?? "";
  const sortKey = sortRaw.replace(/^-/, "");
  const under = query.get("under");
  return {
    query: typed.slice(0, MAX_PARAM_CHARS),
    projects: many("project"),
    kinds: many("kind").filter((k): k is FileKind => k === "diagram" || k === "note"),
    types: many("type"),
    folder: under === null || under.length > MAX_PARAM_CHARS ? null : under.replace(/^\/+|\/+$/g, ""),
    status: many("status").filter((s): s is Status => (STATUSES as readonly string[]).includes(s)),
    edited: readRange(query.get("edited")),
    created: readRange(query.get("created")),
    totalThreads: readCountRange(query.get("total")),
    unresolvedThreads: readCountRange(query.get("unresolved")),
    commented: readRange(query.get("commented")),
    sort: (SORT_KEYS as readonly string[]).includes(sortKey)
      ? { key: sortKey as SortKey, dir: sortRaw.startsWith("-") ? "desc" : "asc" }
      : DEFAULT_SORT,
    tab: PROJECT_TABS.find((tab) => tab === query.get("tab")) ?? DEFAULT_PROJECT_TAB,
    inNotes: query.get("in") === "notes",
  };
}

/** `url` naming the search page `state`, its parameters in one order, the defaults left out. */
export function writeSearchState(url: URL, state: SearchState): void {
  for (const name of SEARCH_PARAMS) url.searchParams.delete(name);
  url.searchParams.set("q", state.query);
  for (const slug of state.projects) url.searchParams.append("project", slug);
  for (const kind of state.kinds) url.searchParams.append("kind", kind);
  for (const type of state.types) url.searchParams.append("type", type);
  if (state.folder !== null) url.searchParams.set("under", state.folder);
  for (const status of state.status) url.searchParams.append("status", status);
  if (state.edited !== null) url.searchParams.set("edited", writeRange(state.edited));
  if (state.created !== null) url.searchParams.set("created", writeRange(state.created));
  if (state.totalThreads !== null) url.searchParams.set("total", writeCountRange(state.totalThreads));
  if (state.unresolvedThreads !== null) url.searchParams.set("unresolved", writeCountRange(state.unresolvedThreads));
  if (state.commented !== null) url.searchParams.set("commented", writeRange(state.commented));
  if (state.sort.key !== DEFAULT_SORT.key || state.sort.dir !== DEFAULT_SORT.dir)
    url.searchParams.set("sort", `${state.sort.dir === "desc" ? "-" : ""}${state.sort.key}`);
  if (state.tab !== DEFAULT_PROJECT_TAB) url.searchParams.set("tab", state.tab);
  if (state.inNotes) url.searchParams.set("in", "notes");
}

/** Equal for two states that name the same search page. */
export function searchKey(state: SearchState): string {
  const url = new URL("https://archer.invalid/");
  writeSearchState(url, state);
  return url.search;
}

/** How many filters are set, besides what is typed: the phone's "Filters (n)". */
export function filterCount(state: SearchState): number {
  return (
    state.projects.length +
    state.kinds.length +
    state.types.length +
    state.status.length +
    (state.folder === null ? 0 : 1) +
    (state.edited === null ? 0 : 1) +
    (state.created === null ? 0 : 1) +
    (state.totalThreads === null ? 0 : 1) +
    (state.unresolvedThreads === null ? 0 : 1) +
    (state.commented === null ? 0 : 1)
  );
}

// --------------------------------------------------------------- filtering

/** The targets the service found for what is typed, by project slug. */
export type ContentHits = ReadonlyMap<string, ReadonlySet<BrowserSearchTarget>>;

/** The milliseconds a range admits, from its start to its end; `now` is the page's clock. */
export function rangeBounds(range: DateRange, now: number): { readonly from: number; readonly to: number } {
  if ("preset" in range) {
    const days = DATE_PRESETS.find((p) => p.id === range.preset)?.days ?? 0;
    return { from: now - days * 86_400_000, to: Infinity };
  }
  // Calendar days in the reader's own time zone, the end day included.
  const day = (text: string | undefined, end: boolean): number => {
    if (text === undefined) return end ? Infinity : -Infinity;
    const [y, m, d] = text.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, end ? d + 1 : d).getTime() - (end ? 1 : 0);
  };
  return { from: day(range.from, false), to: day(range.to, true) };
}

function within(iso: string | undefined, range: DateRange | null, now: number): boolean {
  if (range === null) return true;
  if (iso === undefined) return false;
  const at = Date.parse(iso);
  const { from, to } = rangeBounds(range, now);
  return at >= from && at <= to;
}

/** Whether every word of the query is in the row's own words, or the service found the row for it. */
export function matchesQuery(row: FileRow, words: readonly string[], hits: ContentHits | null): boolean {
  if (words.length === 0) return true;
  const own = [
    row.projectName,
    row.projectDescription ?? "",
    row.title,
    row.path,
    row.kind,
    row.type ?? "",
    typeLabel(row),
    row.description ?? "",
    row.modifiedAt ?? "",
    row.modifiedAt === undefined ? "" : longDate(row.modifiedAt),
    row.createdAt ?? "",
    row.createdAt === undefined ? "" : longDate(row.createdAt),
    row.createdFrom === undefined ? "" : createdSourcePhrase(row.createdFrom),
    row.presented ? "Presented by the agent" : "",
    row.failing ? "Does not compile" : "",
    row.openThreads > 0 ? `${row.openThreads} open ${row.openThreads === 1 ? "thread" : "threads"}` : "",
    row.totalThreads === undefined ? "" : `${row.totalThreads} total ${row.totalThreads === 1 ? "thread" : "threads"}`,
    row.unresolvedThreads === undefined
      ? ""
      : `${row.unresolvedThreads} unresolved ${row.unresolvedThreads === 1 ? "thread" : "threads"}`,
    row.lastCommentedAt == null ? "" : `${row.lastCommentedAt} ${longDate(row.lastCommentedAt)}`,
  ]
    .join("\n")
    .toLowerCase();
  if (words.every((word) => own.includes(word))) return true;
  return hits?.get(row.slug)?.has(row.target) === true;
}

type Facet = "projects" | "kinds" | "types" | "folder" | "status" | "edited" | "created" | "commented";

function withinCount(value: number | undefined, range: CountRange | null): boolean {
  if (range === null) return true;
  if (value === undefined) return false;
  return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
}

function passes(row: FileRow, state: SearchState, now: number, skip: Facet | null): boolean {
  if (skip !== "projects" && state.projects.length > 0 && !state.projects.includes(row.slug)) return false;
  if (skip !== "kinds" && state.kinds.length > 0 && !state.kinds.includes(row.kind)) return false;
  // A diagram type names diagrams: a note has none.
  if (
    skip !== "types" &&
    state.types.length > 0 &&
    (row.kind !== "diagram" || row.type === null || !state.types.includes(row.type))
  )
    return false;
  if (
    skip !== "folder" &&
    state.folder !== null &&
    state.folder !== "" &&
    row.folder !== state.folder &&
    !row.folder.startsWith(`${state.folder}/`)
  )
    return false;
  if (skip !== "folder" && state.folder === "" && row.folder !== "") return false;
  if (skip !== "status" && state.status.includes("failing") && !row.failing) return false;
  if (skip !== "status" && state.status.includes("comments") && row.openThreads === 0) return false;
  if (skip !== "edited" && !within(row.modifiedAt, state.edited, now)) return false;
  if (skip !== "created" && !within(row.createdAt, state.created, now)) return false;
  if (!withinCount(row.totalThreads, state.totalThreads)) return false;
  if (!withinCount(row.unresolvedThreads, state.unresolvedThreads)) return false;
  if (skip !== "commented" && !within(row.lastCommentedAt ?? undefined, state.commented, now)) return false;
  return true;
}

/** The rows the state admits, sorted by it. */
export function searchRows(
  rows: readonly FileRow[],
  state: SearchState,
  hits: ContentHits | null,
  now: number,
): FileRow[] {
  const words = queryWords(state.query);
  return sortRows(
    rows.filter((row) => matchesQuery(row, words, hits) && passes(row, state, now, null)),
    state.sort,
  );
}

/** For each choice in each filter, how many rows it would show with the other filters as they are. */
export type Facets = {
  readonly projects: ReadonlyMap<string, number>;
  readonly kinds: ReadonlyMap<FileKind, number>;
  readonly types: ReadonlyMap<string, number>;
  readonly folders: ReadonlyMap<string, number>;
  readonly status: ReadonlyMap<Status, number>;
  /** Empty key is Any time, including files whose date is unknown. */
  readonly edited: ReadonlyMap<DatePreset | "", number>;
  readonly created: ReadonlyMap<DatePreset | "", number>;
  readonly commented: ReadonlyMap<DatePreset | "", number>;
};

export function facets(rows: readonly FileRow[], state: SearchState, hits: ContentHits | null, now: number): Facets {
  const words = queryWords(state.query);
  const typed = rows.filter((row) => matchesQuery(row, words, hits));
  const count = <K>(facet: Facet, keys: (row: FileRow) => readonly K[]): Map<K, number> => {
    const counts = new Map<K, number>();
    for (const row of typed)
      if (passes(row, state, now, facet)) for (const key of keys(row)) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  };
  const dates = (facet: "edited" | "created" | "commented"): Map<DatePreset | "", number> => {
    const eligible = typed.filter((row) => passes(row, state, now, facet));
    return new Map<DatePreset | "", number>([
      ["", eligible.length],
      ...DATE_PRESETS.map((preset): [DatePreset, number] => [
        preset.id,
        eligible.filter((row) =>
          within(
            facet === "edited"
              ? row.modifiedAt
              : facet === "created"
                ? row.createdAt
                : (row.lastCommentedAt ?? undefined),
            { preset: preset.id },
            now,
          ),
        ).length,
      ]),
    ]);
  };
  return {
    projects: count("projects", (row) => [row.slug]),
    kinds: count("kinds", (row) => [row.kind]),
    types: count("types", (row) => (row.kind === "diagram" && row.type !== null ? [row.type] : [])),
    // A row counts for its folder and every folder above it.
    folders: count("folder", (row) => {
      const parts = row.folder === "" ? [] : row.folder.split("/");
      return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))].filter((f, i) => i > 0 || row.folder === "");
    }),
    status: count("status", (row) => [
      ...(row.failing ? ["failing" as const] : []),
      ...(row.openThreads > 0 ? ["comments" as const] : []),
    ]),
    edited: dates("edited"),
    created: dates("created"),
    commented: dates("commented"),
  };
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Sorted by `sort`; a row without the date sorts last whichever way. Ties by name, then path. */
export function sortRows(rows: readonly FileRow[], sort: Sort): FileRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const text = (row: FileRow): string => {
    switch (sort.key) {
      case "name":
        return row.title;
      case "kind":
        return row.kind;
      case "type":
        return typeLabel(row);
      case "project":
        return row.projectName;
      case "folder":
        return row.path;
      default:
        return "";
    }
  };
  const date = (row: FileRow): number | null => {
    const iso =
      sort.key === "edited"
        ? row.modifiedAt
        : sort.key === "created"
          ? row.createdAt
          : sort.key === "commented"
            ? (row.lastCommentedAt ?? undefined)
            : undefined;
    return iso === undefined ? null : Date.parse(iso);
  };
  const numeric = (row: FileRow): number | null =>
    sort.key === "total"
      ? (row.totalThreads ?? null)
      : sort.key === "unresolved"
        ? (row.unresolvedThreads ?? null)
        : null;
  const tie = (a: FileRow, b: FileRow): number =>
    collator.compare(a.title, b.title) ||
    collator.compare(a.path, b.path) ||
    collator.compare(a.projectName, b.projectName);
  return [...rows].sort((a, b) => {
    if (sort.key === "edited" || sort.key === "created" || sort.key === "commented") {
      const [x, y] = [date(a), date(b)];
      if (x === null || y === null) return x === y ? tie(a, b) : x === null ? 1 : -1;
      return (x - y) * sign || tie(a, b);
    }
    if (sort.key === "total" || sort.key === "unresolved") {
      const [x, y] = [numeric(a), numeric(b)];
      if (x === null || y === null) return x === y ? tie(a, b) : x === null ? 1 : -1;
      return (x - y) * sign || tie(a, b);
    }
    return collator.compare(text(a), text(b)) * sign || tie(a, b);
  });
}
