// Semantic models are regenerated from owner Mermaid or verified last-good bytes.
// Runtime context and exact recovery sources live privately outside the project;
// accepted presentation, selection, captions and emphasis survive service restart.
// One attached project's live state: its views compiled from the Archer
// folder, what the agent presents (with its caption), the agent's emphases
// per view, and the reader's selection (ticket 07).
//
// The page reads it through the routes in http.ts and is told of changes by
// named events: `inventory`, `compile`, `presentation`, `emphasis`,
// `note-emphasis`, `comments`, `notes` and `walkthroughs`, each
// carrying the whole standing state, so a page that missed one converges on
// the next (ADR 0010, "Reconnection"). `change` is the exception: it says
// what one recompile changed and who changed it (phase 3), and a page that
// missed it still has `lastChange` in the inventory.
import { parseWalkthroughPosition } from "../../../shared/walkthrough-position.mts";
import { projectDisplayName, repositoryOf, type RepositoryIdentity } from "../project/repository.ts";
import { assertWriteAllowed } from "../config/write-policy.ts";
import {
  discoverDocuments,
  discoveredDirectories,
  readDiscoveredDocument,
  resolveDiscoverySettings,
  type DiscoverySettings,
  type DocumentEntry,
  type DocumentCatalog,
} from "../project/discovery.ts";
import { noteDiagrams } from "../../../shared/note-diagrams.mts";
import { compile } from "../mermaid/index.ts";
import { scopedIdentitiesOf } from "../comments/scoped-identities.ts";
import { splitFrontMatter } from "../project/inventory.ts";
import { type AccountStateStore, PersistenceError } from "../state/account.ts";
import type { ContinuityRecord } from "../state/continuity.ts";
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Diagnostic } from "../mermaid/index.ts";
import { kindOfSource } from "../mermaid/preamble.ts";
import { isStableId, isViewId, type DiagramEnvelope, type DiagramKind, type Revision } from "../model/index.ts";
import {
  compileDiagram,
  compileDiagramBytes,
  findProject,
  listDiagrams,
  readInFolder,
  readInFolderOrNull,
  resolveInFolder,
  revisionOf,
  type Project,
  type View,
} from "../project/index.ts";
import type { DiagramEntry, NoteEntry } from "../project/inventory.ts";
import {
  addressable,
  EmphasisStore,
  MAX_EMPHASES_PER_VIEW,
  parseEmphasis,
  rejection,
  type Emphasis,
  type EmphasisCaller,
  type EmphasisPayload,
  type Issue,
} from "./emphasis.ts";
import { acceptSelection, stillCurrent, type ResolvedSelection, type SelectionOutcome } from "./selection-check.ts";
import { MAX_SOURCE_BYTES } from "../mermaid/limits.ts";
import { AGENT_WRITE_WINDOW_MS, MAX_SUMMARY_CHARS, type Results } from "./protocol.ts";
import {
  countsOf,
  diffElements,
  elementCandidates,
  fieldMatches,
  groupOf,
  matchCard,
  MAX_SEARCH_RESULTS,
  noThreads,
  queryWords,
  type Candidate,
  type ElementChange,
  type FieldMatch,
  type Group,
  type LastChange,
  type ThreadCounts,
  type Where,
} from "./front-door.ts";
import { parseDiagramAddress } from "../../../shared/note-diagrams.mts";
import {
  allEmbedded,
  compileEmbedded,
  embeddedCommentsPath,
  embeddedSources,
  pinEmbedded,
  readEmbedded,
  type EmbeddedRead,
} from "../notes/embedded.ts";
import { FreshnessCache } from "../notes/freshness.ts";
import { noteEmphasisPath, NoteEmphasisStore } from "../notes/emphasis.ts";
import type { NoteEmphasisAuthor, NoteEmphasisRead } from "../../../shared/note-emphasis.mts";
import { diagramDescription, noteDescription, type DescriptionSource } from "../project/describe.ts";
import { FileDateBook, type CreatedSource, type FileDates } from "../project/file-dates.ts";
import { GitHeadBook } from "../project/git-head.ts";
import { projectFacts, type FactsInput, type ProjectFacts } from "./project-facts.ts";
import { ConfinedFileSystem } from "../project/confined-fs.ts";
import type { ProjectContent } from "../state/project-lifecycle.ts";
import {
  MAX_CONTEXT_DOCUMENT_CHARS,
  PROJECT_TARGET,
  type AllNotes,
  type CommentsChanged,
  type EmbeddedDiagramContent,
  type NoteContent,
  type NotesForView,
  type OperationAck,
  type Pending,
  type SubmitAck,
  type SubmitResult,
  type TargetRef,
  type Thread,
  type ThreadList,
} from "../comments/contract.ts";
import { activeTelemetry, phaseEnd, phaseStart } from "../telemetry/index.ts";
import { mergeProjectModel, modelSignature, type ModelInputView, type ProjectModel } from "../project-model/merge.ts";
import { expandMenu, type ExpandMenu, type MenuRefusal } from "../expand/menu.ts";
import {
  EXPLORATION_LIMITS,
  MAX_FRAME_SELECTION,
  expansionOf,
  type Expansion,
  type ExplorationStamp,
  type FrameSelection,
} from "../../../shared/explorations.mts";
import {
  explorationOf,
  expandIssues,
  replayOn,
  reportOf,
  stampOf,
  type CommentPin,
  type Exploration,
  type ExplorationReport,
  type ExplorationSources,
} from "../expand/exploration.ts";
import { LISTENER_CAPABILITY, LISTENER_EVENT } from "../agents/contract.ts";
import { commentActivity as activityOf, type CommentActivityPayload } from "../../../shared/comment-activity.mts";
import {
  allNotes,
  firstHeading,
  noteBytes,
  noteContent,
  noteMarkdown,
  notesForView,
  notesOf,
  noteTitle,
} from "../comments/notes.ts";
import {
  COMMENTS_SUFFIX,
  CommentsError,
  CommentsStore,
  PROJECT_COMMENTS_PATH,
  commentsPathFor,
  elementsOf,
  parseTarget,
  readNewThread,
  type Changed,
  type OperationOutcome,
  type Place,
  readSubmitRequest,
} from "../comments/store.ts";
import type { OldVersionResponse, WalkthroughsChanged, WalkthroughsForView } from "../walkthroughs/contract.ts";
import { findOldVersion } from "../walkthroughs/old-version.ts";
import { deadCode } from "../walkthroughs/ground.ts";
import { refusedHost, resolveWalkthrough } from "../walkthroughs/resolve.ts";
import type { PlaceRef, WalkthroughSubject } from "../comments/store.ts";
import { walkthroughsPlaces, WalkthroughsStore, type WalkthroughsPlace } from "../walkthroughs/store.ts";
import { ReadMemo } from "./project-state/memo.ts";
import { Publisher } from "./project-state/publisher.ts";
import { type Durability, Persister } from "./project-state/persister.ts";
import { readableName } from "../state/project-names.ts";

export { READ_MEMO_MS, READ_WARM_DELAY_MS } from "./project-state/memo.ts";

/** Rust's MAX_ANNOTATION_CHARS. */
export const MAX_ANNOTATION_CHARS = 500;

export type EventName =
  | "inventory"
  | "compile"
  | "presentation"
  | "emphasis"
  | "note-emphasis"
  | "comments"
  | "notes"
  | "documents"
  | "change"
  | "files"
  | "walkthroughs"
  | typeof LISTENER_EVENT;

/** At most this many files in one `files` event; a larger burst says `truncated` (ADR 0028). */
export const MAX_FILES_EVENT = 200;
/**
 * How long after open a page that connects is told of the files changed while the service was
 * stopped (against the baseline saved before it stopped): the page's longest reconnect wait, twice.
 */
export const RESTART_CUE_MS = 60_000;
export type FileKind = "diagram" | "note" | "document";
export interface FileEntry {
  readonly path: string;
  readonly kind: FileKind;
  readonly revision?: Revision;
}
/**
 * The `files` event: which files changed in one reload, by project-relative path. It carries no
 * content and names no one, because who wrote a file is not reliably known (ADR 0028).
 */
export interface FilesChanged {
  readonly changed: readonly FileEntry[];
  readonly added: readonly FileEntry[];
  readonly removed: readonly { readonly path: string; readonly kind: FileKind }[];
  readonly truncated?: true;
}

/** One view on the contents page (api/diagrams), phase 3's fields after Rust's four. */
export interface InventoryEntry {
  /** Actual Archer-folder-relative source path for browser navigation; no inferred file names. */
  readonly sourcePath?: string;
  readonly id: string;
  readonly kind: DiagramKind;
  readonly title: string;
  /** `embedded` for a diagram in a note, named by its address (ADR 0012); `durable` for every file view. */
  readonly registration: "durable" | "embedded";
  /** For an embedded diagram: its note (folder-relative) and its name there. */
  readonly note?: string;
  readonly name?: string;
  readonly group: Group;
  readonly lastChange?: LastChange;
  readonly threads?: ThreadCounts;
  /** The agent's caption the last time it presented this view; absent when that presentation had none. */
  readonly caption?: string;
  /** How many walkthroughs it has (ADR 0034); absent when none. */
  readonly walkthroughs?: number;
  /** When the agent last presented this view. */
  readonly presentedAt?: string;
  /** Of the last model that compiled; absent when none has. */
  readonly counts?: { readonly elements: number; readonly links: number };
  /**
   * The served model's revision (the last that compiled): it keys the view's thumbnail URL, and the page re-reads a
   * view it shows when this moves (no timer: every change, the first compile included, is an `inventory` event).
   * Absent only while the view has never compiled: there is no model, so nothing to read.
   */
  readonly modelRevision?: string;
  /** A diagram file's bytes revision, as authoring receipts name it (not an embedded block's): "Saved" is said for that write only. */
  readonly sourceRevision?: string;
  /**
   * When the file was created, ISO 8601, and where that came from: the file
   * system's birth time, or the commit that first added it (`file-dates.ts`).
   * Absent when neither knows. An embedded diagram's are its note's.
   */
  readonly createdAt?: string;
  readonly createdFrom?: CreatedSource;
  /** The file's modification time, ISO 8601; an embedded diagram's is its note's. */
  readonly modifiedAt?: string;
  /** What the diagram is about (`describe.ts`): its `%% description:` line, else its leading comments. */
  readonly description?: string;
  readonly descriptionFrom?: DescriptionSource;
  /** Its source file (or note block) is gone; the drawing served is the last that compiled. */
  readonly sourceMissing?: true;
  /** Where it went: the one other diagram file now holding the bytes it last compiled from. */
  readonly movedTo?: { readonly id: string; readonly sourcePath: string };
}

/** The `change` event: what a recompile changed in a view's model, and who changed it. */
export interface ChangeEvent extends LastChange, ElementChange {
  readonly viewId: string;
}

/**
 * One search result. `where` is the coarse place list older pages read;
 * `matches` names each field (and element, note or thread) that matched,
 * capped, with `moreMatches` when some were left out.
 */
export interface SearchResult {
  readonly target: TargetRef;
  readonly title: string;
  readonly where: readonly Where[];
  readonly matches: readonly FieldMatch[];
  readonly moreMatches?: number;
}

export interface BrowserSearchResult extends Omit<SearchResult, "target"> {
  readonly target: TargetRef | `source:${string}`;
}
export interface BrowserSearchResults {
  readonly query: string;
  readonly results: readonly BrowserSearchResult[];
}

export interface SearchResults {
  readonly query: string;
  readonly results: readonly SearchResult[];
}

/** Recorded writes kept at once; older ones are dropped first. */
const MAX_RECORDED_WRITES = 256;
/** A reload compiles for at most about this long before letting waiting requests run. */
const RELOAD_SLICE_MS = 16;

export interface StateOptions {
  /** The service's clock, in milliseconds; Date.now by default. */
  readonly now?: () => number;
  readonly store?: AccountStateStore;
  readonly restoreState?: boolean;
  /**
   * The project's persisted readable name for `root` (the service's name store, which records one on first attach).
   * Without it (a state opened outside the service, as in tests) the folder's readable name, recorded nowhere.
   */
  readonly projectName?: (root: string) => string;
}

/** Sent in bootstrap: the page enables only the review features the server names. */
/** `commentOperations: 1`: comment create and reply are taken as operations with durable receipts (ADR 0016). */
const CAPABILITIES = {
  comments: true,
  notes: true,
  noteEmphasis: true,
  instanceSettings: true,
  [LISTENER_CAPABILITY]: true,
  commentOperations: 1,
} as const;
export type Listener = (event: EventName, payload: unknown) => void;

interface ViewState {
  readonly id: string;
  readonly kind: DiagramKind;
  readonly title: string;
  /** Folder-relative source path. */
  readonly path: string;
  /** Of the bytes last read; null when there were none. */
  readonly sourceRevision: Revision | null;
  /** The last envelope that compiled; kept while the source does not. */
  readonly envelope: DiagramEnvelope | null;
  /** The diagnostics of the last compile. */
  readonly diagnostics: readonly Diagnostic[];
  /** Whether the source as it stands fails to compile. */
  readonly failing: boolean;
  readonly manifestView: View | undefined;
  readonly lastGoodSource?: Uint8Array;
  /** A diagram embedded in the note at `path`, under this name (ADR 0012). */
  readonly embedded?: { readonly name: string; readonly bodyLine?: number };
  /** Read from the source with the compile (`describe.ts`). */
  readonly description?: { readonly description: string; readonly descriptionFrom: DescriptionSource };
}

interface Presentation {
  readonly presentationId: string;
  readonly viewId: string;
  revision: string;
  readonly viewport: "fit-all";
  readonly annotation?: string;
  /** The walkthrough and step the agent opened the page on (ADR 0034 §6); the page moves to it. */
  readonly walkthrough?: PresentedWalkthroughRef;
  diagnostics: unknown[];
  /**
   * The agent's exploration (ADR 0036 §14, A11): the (element, source) additions as presented, in order. Each
   * refresh after a source recompiles or leaves keeps those that still hold and moves `generation`.
   */
  expand?: Expansion[];
  generation?: number;
  /** Lines the page says after a refresh ("Runtime was removed, so its frame is gone"). */
  notices?: string[];
  /** What the frames were last cut from: the kept list and each source's revision. */
  cut?: string;
}

/** What the reader's page last said it added and selected in frames (O1, route 4): transient, like a selection. */
interface ReaderExploration {
  readonly viewId: string;
  readonly expand: readonly Expansion[];
  readonly selection: readonly FrameSelection[];
  /** Ordered against presents: the later of the two is the exploration the agent reads. */
  readonly seq: number;
}

/** What the project model reads of a note's front matter (ADR 0036 §5, A1). */
interface NoteFacts {
  readonly status?: string;
  readonly basedOn?: string;
}

/** A saved presentation's exploration (A11), or nothing when it has none or it is malformed: dropped, never fatal. */
function savedExploration(p: Record<string, unknown>): Pick<Presentation, "expand" | "generation" | "notices" | "cut"> {
  const expand = p["expand"];
  if (!Array.isArray(expand) || expand.length === 0 || expand.length > EXPLORATION_LIMITS.maxExpansions) return {};
  const pairs: Expansion[] = [];
  for (const e of expand) {
    if (
      !isRecord(e) ||
      typeof e["element"] !== "string" ||
      typeof e["source"] !== "string" ||
      (e["neighbour"] !== undefined && typeof e["neighbour"] !== "string")
    )
      return {};
    pairs.push(expansionOf(e["element"], e["source"], e["neighbour"] as string | undefined));
  }
  const generation =
    Number.isSafeInteger(p["generation"]) && Number(p["generation"]) >= 0 ? Number(p["generation"]) : 0;
  const notices = Array.isArray(p["notices"])
    ? p["notices"].filter((n): n is string => typeof n === "string").slice(0, 8)
    : undefined;
  return {
    expand: pairs,
    generation,
    ...(notices === undefined || notices.length === 0 ? {} : { notices }),
    ...(typeof p["cut"] === "string" ? { cut: p["cut"] } : {}),
  };
}

function noteFactsOf(noteText: string): NoteFacts {
  const { fields } = splitFrontMatter(noteText);
  return {
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.basedOn === undefined ? {} : { basedOn: fields.basedOn }),
  };
}

/** A walkthrough position: 1-based step. */
export interface PresentedWalkthroughRef {
  readonly id: string;
  readonly step: number;
}
/** What the reader's page says it is showing: a walkthrough of a view at a step. */
export interface ReadingWalkthrough extends PresentedWalkthroughRef {
  readonly viewId: string;
}

/** A refusal with a stable code, for the management socket to pass on. */
export class StateRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "StateRefusal";
  }
}

export class ProjectState {
  /** The project's page/API name (`/projects/<slug>/`, `/p/<slug>/api/`). */
  readonly slug: string;
  /** archer.toml's name as last loaded, else the git repository's, else the directory's; follows reloads. */
  get name(): string {
    return projectDisplayName(this.#project, this.repository);
  }
  /** The git repository the root checks out: read again at most once a second, so a checkout's branch stays current. */
  get repository(): RepositoryIdentity | null {
    const now = Date.now();
    if (this.#repositoryRead === undefined || now - this.#repositoryRead.at >= 1_000)
      this.#repositoryRead = { at: now, value: repositoryOf(this.#project.root) };
    return this.#repositoryRead.value;
  }
  #repositoryRead: { readonly at: number; readonly value: RepositoryIdentity | null } | undefined;
  #project: Project;
  #freshnessCache: FreshnessCache | undefined;
  get #freshness(): FreshnessCache {
    return (this.#freshnessCache ??= new FreshnessCache(this.#project));
  }
  #datesBook: FileDateBook | undefined;
  /** Created and edited dates of the folder's files. */
  get #dates(): FileDateBook {
    return (this.#datesBook ??= new FileDateBook(this.#project));
  }
  #gitHeadBook: GitHeadBook | undefined;
  /** The checkout's branch and short commit, from Git in the background (`git-head.ts`). */
  get #gitHead(): GitHeadBook {
    return (this.#gitHeadBook ??= new GitHeadBook(this.#project.root));
  }
  #views = new Map<string, ViewState>();
  /** Each note's front matter fields the project model reads (A1): a front-matter-only edit compiles nothing. */
  #noteFacts = new Map<string, NoteFacts>();
  /** The project model (ADR 0036 §7, A1), rebuilt whole in the reconcile step when what it reads moves. */
  #model: { readonly model: ProjectModel; readonly generation: number; readonly signature: string } = {
    model: mergeProjectModel([]),
    generation: 0,
    signature: "[]",
  };
  #presentation: Presentation | null = null;
  /** Moves on every present with `expand` and every refresh of one (A11); kept with the presentation across a restart. */
  #explorationGeneration = 0;
  #readerExploration: ReaderExploration | null = null;
  /** Orders presents and reader reports: whichever spoke last is the exploration (O1). */
  #explorationSeq = 0;
  #presentedSeq = 0;
  /** The walkthrough and step the reader's page shows, as it last said (transient: a page that closes says nothing more). */
  #reading: ReadingWalkthrough | null = null;
  /** How many walkthroughs each view has, as last read (the inventory's `walkthroughs`). */
  #walkthroughCounts = new Map<string, number>();
  #selection: ResolvedSelection | null = null;
  readonly #emphasis = new EmphasisStore();
  /** Listeners, the service-wide publication count and a transaction's held events (`publisher.ts`). */
  readonly #publisher = new Publisher<EventName>((line) => this.log(line));
  #announcedInventory = "";
  #announcedCompile = "";
  /** Each comments file's revision as last announced, and each note's. */
  #commentRevisions = new Map<string, string>();
  #noteRevisions = new Map<string, string | null>();
  /** Note text plus adjacent emphasis-sidecar identity, last seen by the watcher reload. */
  #noteEmphasisRevisions = new Map<string, string>();
  /** Each view's walkthroughs file and its resolution, as last announced (ADR 0034 §6). */
  #walkthroughSignatures = new Map<string, string>();
  /** Views whose walkthroughs moved in the latest reload: their comments are reconciled (ADR 0034 §9). */
  #walkthroughsMoved = new Set<string>();
  #announcedNotes = "";
  #announcedDocuments = "";
  /** The files last announced, by project-relative path; null until the first load sets it. */
  #announcedFiles: ReadonlyMap<string, FileEntry> | null = null;
  /** The discovery policy those files were listed under: a policy change re-baselines silently. */
  #announcedFilesPolicy = "";
  /** The baseline saved before the last stop, until the first comparison after open uses or drops it. */
  #savedFiles: { readonly policy: string; readonly entries: ReadonlyMap<string, FileEntry> } | null = null;
  /** The files changed while the service was stopped, told to each page that connects soon after open. */
  #heldFiles: { readonly event: FilesChanged; readonly policy: string; readonly until: number } | null = null;
  #discoverySettings: (() => DiscoverySettings) | undefined;
  #reloading: Promise<void> = Promise.resolve();
  #pending = false;
  #reloadFailure: PersistenceError | null = null;
  #closed = false;
  /** Whether the first load is done: until then a view's last change is its file's time. */
  #loaded = false;
  #lastChange = new Map<string, LastChange>();
  /** The MCP server's writes, by view id, not yet seen recompiled. */
  readonly #recorded = new Map<string, { readonly at: number; readonly summary?: string }>();
  #captions = new Map<string, { readonly at: string; readonly caption?: string }>();
  readonly #now: () => number;
  /** Saves the recovery record and the continuity file (`persister.ts`). */
  readonly #persister: Persister;
  #initializing = true;
  /** Reads a page load repeats (the note list, discovery, the catalog, every note), until a file event (`memo.ts`). */
  readonly #memo = new ReadMemo({
    warmParts: () => this.#warmParts(),
    ready: () => !this.#initializing,
    warmFailed: (failure) =>
      this.log(
        `[archer] warming reads failed for ${this.#project.root}: ${failure instanceof Error ? failure.message : String(failure)}`,
      ),
  });

  /** Drops every memoized read: the files may have changed. The page's common reads are made again soon after. */
  forgetReads(): void {
    this.#memo.forget();
  }

  #warmParts(): (() => unknown)[] {
    const settings = this.#effectiveDiscovery();
    return [
      () => this.documentCatalog(settings),
      () => this.lifecycleContent(settings),
      () => this.allNotes(),
      () => this.inventory(),
    ];
  }

  /** Makes the reads a page load asks for (the project catalog's), memoizing them. */
  warmReads(): void {
    this.#memo.warm();
  }

  /** A file's dates: a stat and a confined path check, memoized with the reads (Git's answers forget them). */
  #datesOf(path: string): FileDates {
    return this.#memo.get(`dates:${path}`, () => this.#dates.of(path));
  }

  #notes(): NoteEntry[] {
    return this.#memo.get("notes", () => notesOf(this.#project));
  }

  #discover(settings: DiscoverySettings, options?: { readme: false }): DocumentCatalog {
    return this.#memo.get(`discover:${options === undefined ? "" : "noreadme:"}${JSON.stringify(settings)}`, () =>
      options === undefined
        ? discoverDocuments(this.#project, settings)
        : discoverDocuments(this.#project, settings, {}, options),
    );
  }

  private constructor(
    project: Project,
    readonly url: string,
    readonly log: (line: string) => void,
    options: StateOptions,
    slug: string,
  ) {
    this.#now = options.now ?? Date.now;
    this.#persister = new Persister(options.store, () => this.root, log);
    this.#project = project;
    this.slug = slug;
  }

  /** Finds the project `start` belongs to and compiles its diagrams. `pageUrl` is given its slug. */
  static async open(
    start: string,
    pageUrl: (slug: string) => string,
    log: (line: string) => void = () => {},
    options: StateOptions = {},
  ): Promise<ProjectState> {
    const project = findProject(start);
    const slug = options.projectName?.(project.root) ?? readableName(project.root);
    const state = new ProjectState(project, pageUrl(slug), log, options, slug);
    const saved = options.restoreState === false ? null : (options.store?.load(project.root) ?? null);
    if (options.restoreState !== false && options.store !== undefined)
      state.#restoreContinuity(options.store.continuity(project.root));
    const oldModels = new Map<string, ReturnType<typeof addressable>>();
    let byId: Map<string, DiagramEntry> | undefined;
    if (saved !== null) {
      for (const v of saved.views) {
        // A diagram embedded in a note is restored from its saved source as the view its address names (ADR 0012).
        const embeddedAt = parseDiagramAddress(v.id);
        if (embeddedAt !== null) {
          if (embeddedAt.notePath !== v.path) continue;
          const bytes = options.store!.source(project.root, v.blob);
          const result = await compileDiagramBytes(
            { path: v.path, view: { id: v.id, kind: v.kind as DiagramKind, title: v.title, source: v.path } },
            bytes,
          );
          if (result.envelope === null || result.envelope.revision !== v.revision)
            throw new PersistenceError(
              "invalid_saved_state",
              "saved last-good source no longer compiles at its recorded revision",
            );
          state.#views.set(v.id, {
            id: v.id,
            kind: result.envelope.view.kind,
            title: result.envelope.view.title,
            path: v.path,
            sourceRevision: null,
            envelope: result.envelope,
            diagnostics: [],
            failing: false,
            manifestView: undefined,
            lastGoodSource: bytes,
            embedded: { name: embeddedAt.name },
          });
          oldModels.set(v.id, addressable(result.envelope.model));
          continue;
        }
        const entry = (byId ??= entriesById(project)).get(v.id);
        if (entry === undefined || entry.path !== v.path || (entry.view !== undefined && entry.view.kind !== v.kind))
          continue;
        const bytes = options.store!.source(project.root, v.blob);
        const result = await compileDiagramBytes(entry, bytes);
        if (result.envelope === null || result.envelope.revision !== v.revision)
          throw new PersistenceError(
            "invalid_saved_state",
            "saved last-good source no longer compiles at its recorded revision",
          );
        state.#views.set(v.id, {
          id: v.id,
          kind: result.envelope.view.kind,
          title: result.envelope.view.title,
          path: v.path,
          sourceRevision: v.revision as Revision,
          envelope: result.envelope,
          diagnostics: [],
          failing: false,
          manifestView: entry.view,
          lastGoodSource: bytes,
          ...describedBy(bytes.toString("utf8")),
        });
        oldModels.set(v.id, addressable(result.envelope.model));
      }
    }
    await state.reload();
    if (saved !== null) {
      state.#captions = new Map(saved.captions.filter(([id]) => state.#views.has(id)));
      for (const [id, change] of saved.lastChange)
        if (
          state.#views.has(id) &&
          state.#views.get(id)?.sourceRevision === saved.views.find((v) => v.id === id)?.sourceRevision
        )
          state.#lastChange.set(id, change);
      try {
        state.#emphasis.restore(saved.emphases, oldModels);
      } catch (e) {
        throw new PersistenceError("invalid_saved_state", String(e));
      }
      for (const [id, v] of state.#views)
        if (v.envelope !== null) state.#emphasis.revalidate(id, addressable(v.envelope.model));
      const p = saved.presentation;
      if (p !== null) {
        if (
          !isRecord(p) ||
          typeof p.presentationId !== "string" ||
          !/^present-[a-f0-9]{12}$/.test(p.presentationId) ||
          typeof p.viewId !== "string" ||
          typeof p.revision !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(p.revision) ||
          p.viewport !== "fit-all" ||
          (p.annotation !== undefined &&
            (typeof p.annotation !== "string" || [...p.annotation].length > MAX_ANNOTATION_CHARS))
        )
          throw new PersistenceError("invalid_saved_state", "saved presentation is malformed");
        const view = state.#views.get(p.viewId);
        if (view?.envelope != null)
          state.#presentation = {
            presentationId: p.presentationId,
            viewId: p.viewId,
            revision: view.envelope.revision,
            viewport: "fit-all",
            ...(typeof p.annotation === "string" ? { annotation: p.annotation } : {}),
            ...(isRecord(p.walkthrough) &&
            typeof p.walkthrough.id === "string" &&
            Number.isSafeInteger(p.walkthrough.step)
              ? { walkthrough: { id: p.walkthrough.id, step: Number(p.walkthrough.step) } }
              : {}),
            diagnostics: view.diagnostics.map(wireDiagnostic),
            ...savedExploration(p),
          };
        // A presented exploration survives a restart (A11): replayed on what the service loaded, refreshed if a source moved.
        if (state.#presentation?.expand !== undefined) {
          state.#explorationGeneration = Math.max(state.#explorationGeneration, state.#presentation.generation ?? 0);
          state.#refreshExploration(false);
        }
      }
      if (saved.selection !== null) {
        if (
          !isRecord(saved.selection) ||
          saved.selection.schemaVersion !== 1 ||
          (saved.selection.selectionRevision !== undefined &&
            (!Number.isSafeInteger(saved.selection.selectionRevision) || Number(saved.selection.selectionRevision) < 0))
        )
          throw new PersistenceError("invalid_saved_state", "saved selection is malformed");
        const outcome = acceptSelection(saved.selection, state.#world());
        if (outcome.ok) state.#selection = outcome.selection;
        else if (outcome.status === 422) throw new PersistenceError("invalid_saved_state", outcome.message);
        else log(`[archer] recovery: ${outcome.code}: ${outcome.message}`);
      }
    }
    state.#initializing = false;
    return state;
  }

  /** A provider keeps global defaults and freshly reloaded project overrides consistent. */
  configureDiscovery(settings: DiscoverySettings | (() => DiscoverySettings)): void {
    const before = JSON.stringify(this.#effectiveDiscovery());
    this.#discoverySettings = typeof settings === "function" ? settings : () => settings;
    // Reads made under the same settings stay good: an attach no longer walks the catalog twice (~120 ms at M).
    if (JSON.stringify(this.#effectiveDiscovery()) !== before) this.forgetReads();
    this.#announcedDocuments = this.#documentSignature();
    const files = this.#fileEntries(),
      policy = JSON.stringify(this.#effectiveDiscovery());
    this.#announcedFiles = files;
    this.#announcedFilesPolicy = policy;
    // The cue held at the first load was listed under that load's policy; a different one re-baselines silently.
    if (this.#heldFiles !== null && this.#heldFiles.policy !== policy) this.#heldFiles = null;
    this.#holdSavedCue(files, policy);
    this.#savedFiles = null;
  }

  /** Takes up what the continuity file kept: the saved baseline, and announced writes still inside their window. */
  #restoreContinuity(saved: ContinuityRecord | null): void {
    if (saved === null) return;
    if (saved.files !== undefined)
      this.#savedFiles = {
        policy: saved.files.policy,
        entries: new Map(saved.files.entries.map((entry): [string, FileEntry] => [entry.path, entry as FileEntry])),
      };
    const now = this.#now();
    for (const write of saved.writes)
      if (write.at <= now && now - write.at <= AGENT_WRITE_WINDOW_MS)
        this.#recorded.set(write.viewId, {
          at: write.at,
          ...(write.summary === undefined ? {} : { summary: write.summary }),
        });
  }

  /**
   * At the first comparison after open: the files changed against the baseline saved before the
   * stop, when it was listed under this same policy, held for the pages that connect next.
   */
  #holdSavedCue(now: ReadonlyMap<string, FileEntry>, policy: string): void {
    const saved = this.#savedFiles;
    if (saved === null || this.#heldFiles !== null || saved.policy !== revisionOf(Buffer.from(policy, "utf8"))) return;
    this.#savedFiles = null;
    const event = filesChanged(saved.entries, now);
    if (event !== null) this.#heldFiles = { event, policy, until: this.#now() + RESTART_CUE_MS };
  }

  #effectiveDiscovery(): DiscoverySettings {
    return this.#discoverySettings?.() ?? resolveDiscoverySettings(this.#project);
  }

  #documentSignature(): string {
    const catalog = this.documentCatalog();
    const diagnostics = [...catalog.diagnostics].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return revisionOf(Buffer.from(JSON.stringify({ ...catalog, diagnostics }), "utf8"));
  }

  #fileEntries(): Map<string, FileEntry> {
    const folder = `${this.#project.folderSetting}/`;
    return new Map(
      this.documentCatalog().documents.map((entry): [string, FileEntry] => {
        const kind: FileKind =
          entry.kind === "mermaid" ? "diagram" : entry.source.path.startsWith(folder) ? "note" : "document";
        return [
          entry.source.path,
          { path: entry.source.path, kind, ...(entry.revision === undefined ? {} : { revision: entry.revision }) },
        ];
      }),
    );
  }

  /** After a reload: the files whose revision changed, appeared or went away since the last one. */
  #announceFiles(): void {
    const now = this.#fileEntries(),
      before = this.#announcedFiles,
      policy = JSON.stringify(this.#effectiveDiscovery());
    this.#announcedFiles = now;
    const samePolicy = policy === this.#announcedFilesPolicy;
    this.#announcedFilesPolicy = policy;
    // A file a new policy hides was not deleted, and must not be named again: no event then.
    // Unreadable files carry no revision, so a change between two unreadable versions is not seen.
    if (before === null || !samePolicy) {
      this.#holdSavedCue(now, policy);
      return;
    }
    const event = filesChanged(before, now);
    if (event !== null) this.#publish("files", event);
  }

  #announceDocuments(): void {
    this.#announceFiles();
    const signature = this.#documentSignature();
    if (signature === this.#announcedDocuments) return;
    this.#announcedDocuments = signature;
    this.#publish("documents", {});
  }

  /** Additive project-relative catalog; the legacy diagram/note APIs keep their identities. */
  documentCatalog(settings?: DiscoverySettings): {
    documents: (DocumentEntry & {
      title: string;
      revision?: Revision;
      description?: string;
      descriptionFrom?: string;
    })[];
    complete: boolean;
    diagnostics: DocumentCatalog["diagnostics"];
  } {
    const effective = settings ?? this.#effectiveDiscovery();
    return this.#memo.get(`catalog:${JSON.stringify(effective)}`, () => this.#readDocumentCatalog(effective));
  }

  #readDocumentCatalog(settings: DiscoverySettings): ReturnType<ProjectState["documentCatalog"]> {
    const catalog = this.#discover(settings);
    const diagnostics = [...catalog.diagnostics];
    // One descriptor anchor for the whole catalog read, not one per document (each costs a root walk).
    let shared: ConfinedFileSystem | undefined;
    if (catalog.documents.length > 1)
      try {
        shared = new ConfinedFileSystem(this.#project.root);
      } catch {
        /* each read reports it */
      }
    try {
      const documents = catalog.documents.map((entry) => {
        const read = readDiscoveredDocument(this.#project, catalog, entry.source.path, shared);
        if (read === null)
          diagnostics.push({
            code: "source_unreadable",
            path: entry.source.path,
            message: "document content is not readable as bounded UTF-8",
          });
        const legacyView = entry.legacy?.viewId === undefined ? undefined : this.#views.get(entry.legacy.viewId);
        const title =
          (entry.kind === "markdown" && read !== null
            ? firstHeading(splitFrontMatter(read.text).body)
            : legacyView?.title) ?? posix.basename(entry.source.path);
        const description =
          read === null ? null : entry.kind === "markdown" ? noteDescription(read.text) : diagramDescription(read.text);
        return {
          ...entry,
          title,
          ...(read === null ? {} : { revision: revisionOf(read.bytes) }),
          ...(description ?? {}),
        };
      });
      return { documents, complete: catalog.complete && diagnostics.length === 0, diagnostics };
    } finally {
      shared?.close();
    }
  }

  /**
   * Lifecycle classification uses the raw admitted inventory. A present source
   * counts even when compilation or its bounded UTF-8 body read fails.
   */
  lifecycleContent(settings?: DiscoverySettings): ProjectContent {
    const configured = settings ?? this.#effectiveDiscovery();
    // Lifecycle always names its effective scope explicitly. Discovery's
    // legacy implicit default intentionally suppresses a missing-folder
    // diagnostic, which is too ambiguous for an inactivity decision.
    const effective: Required<DiscoverySettings> = {
      roots: configured.roots ?? [this.#project.folderSetting],
      exclude: configured.exclude ?? [],
    };
    // The implicit root README belongs to the code project, not to Archer: it never makes a project active.
    const catalog = this.#discover(effective, { readme: false });
    if (catalog.documents.length > 0) return "content";
    const defaultScope =
      effective.roots.length === 1 &&
      effective.roots[0] === this.#project.folderSetting &&
      effective.exclude.length === 0;
    if (
      defaultScope &&
      (this.#project.problems.length > 0 ||
        [...this.#views.values()].some((view) =>
          view.diagnostics.some((diagnostic) => diagnostic.code === "source_missing"),
        ))
    )
      return "unknown";
    if (catalog.complete) return "empty";

    // A brand-new default authoring folder is the one incomplete catalog that
    // can conclusively mean empty. Require exactly that effective scope and
    // independently prove ENOENT through the descriptor-confined filesystem.
    const roots = effective.roots;
    if (
      roots.length !== 1 ||
      roots[0] !== this.#project.folderSetting ||
      catalog.diagnostics.length === 0 ||
      !catalog.diagnostics.every(
        (diagnostic) => diagnostic.code === "root_unavailable" && diagnostic.path === this.#project.folderSetting,
      )
    )
      return "unknown";
    let confined: ConfinedFileSystem | undefined;
    try {
      confined = new ConfinedFileSystem(this.#project.root);
      const handle = confined.open(this.#project.folderSetting);
      closeSync(handle.fd);
      return "unknown";
    } catch (failure) {
      return (failure as NodeJS.ErrnoException).code === "ENOENT" ? "empty" : "unknown";
    } finally {
      confined?.close();
    }
  }

  /** Bounded source reads, admitted by the configured catalog, without widening write authority. */
  async readDocument(path: string, settings?: DiscoverySettings) {
    const catalog = discoverDocuments(this.#project, settings ?? this.#effectiveDiscovery());
    const entry = catalog.documents.find((candidate) => candidate.source.path === path);
    if (entry === undefined) return null;
    const read = readDiscoveredDocument(this.#project, catalog, path);
    if (read === null) return null;
    const base = { source: entry.source, kind: entry.kind, revision: revisionOf(read.bytes), text: read.text };
    if (entry.kind === "mermaid") return { ...base, ...(await compile(read.text)) };
    const { body, fields } = splitFrontMatter(read.text);
    const parsed = noteDiagrams(body);
    const embedded = [];
    for (const diagram of parsed.diagrams)
      embedded.push({
        name: diagram.name,
        heading: diagram.heading,
        source: diagram.source,
        ...(await compile(diagram.source)),
      });
    return { ...base, markdown: body, frontMatter: fields, embedded, diagramProblems: parsed.problems };
  }

  /** Caller re-syncs these subscriptions after reload; root watches missing selected roots appear. */
  discoveryWatchDirectories(settings?: DiscoverySettings): readonly string[] {
    return discoveredDirectories(this.#discover(settings ?? this.#effectiveDiscovery()));
  }

  get root(): string {
    return this.#project.root;
  }

  get project(): Project {
    return this.#project;
  }

  get description(): string | undefined {
    return this.#project.description;
  }

  /**
   * The project page's title facts from this inventory and what Git last said.
   * Never waits on Git: a stale answer is refreshed in the background and a
   * changed one announced as `documents`, which makes the page re-read the catalog.
   */
  facts(views: FactsInput["views"], notes: FactsInput["notes"]): ProjectFacts {
    this.#askGit();
    return projectFacts({ views, notes, root: this.#project.root, git: this.#gitHead.current() });
  }

  #askGit(): void {
    void this.#gitHead.refresh(() => {
      if (!this.#closed) {
        this.forgetReads();
        this.#publish("documents", {});
      }
    });
  }

  subscribe(listener: Listener): () => void {
    const unsubscribe = this.#publisher.subscribe(listener);
    const held = this.#heldFiles;
    if (held !== null) {
      if (this.#now() > held.until) this.#heldFiles = null;
      // After the subscriber's own turn, so a stream has sent its standing state first. There is no
      // other replay: a page connecting later, or a second time, is not told again once this lapses.
      else
        queueMicrotask(() => {
          if (this.#closed || !this.#publisher.has(listener)) return;
          try {
            listener("files", held.event);
          } catch (e) {
            this.log(`[archer] state publication failed: ${String(e)}`);
          }
        });
    }
    return unsubscribe;
  }

  /**
   * Saves what a deferred commit holds (synchronously: the service closes a state before it releases the
   * project or its lock, on stop, hand-over and detach), then stops.
   */
  close(): void {
    this.#persister.close();
    this.#closed = true;
    this.#memo.close();
    this.#datesBook?.close();
    this.#publisher.close();
  }

  /** Where this project's publications are in the service's count (`Publisher.seq`). */
  get eventSeq(): number {
    return this.#publisher.seq;
  }

  #publish(event: EventName, payload: unknown): void {
    this.#publisher.publish(event, payload);
  }

  /**
   * Candidate commit is durable before any queued publication or successful return. `recovery: false` is for a
   * change that touches nothing the recovery record holds (views, presentation, selection, captions, last
   * changes, emphases): only the continuity file is brought up to date. `durability: "deferred"` is for a
   * change the reader's page makes often (a selection): it holds and is told at once, and is saved within
   * DEFER_MS, coalesced, never refused for the save (`persister.ts`).
   */
  #transaction<T>(
    change: () => T,
    { recovery = true, durability = "durable" }: { readonly recovery?: boolean; readonly durability?: Durability } = {},
  ): T {
    if (this.#publisher.queuing) return change();
    const before = {
      views: this.#views,
      noteFacts: this.#noteFacts,
      model: this.#model,
      presentation: this.#presentation === null ? null : { ...this.#presentation },
      selection: this.#selection,
      captions: new Map(this.#captions),
      lastChange: new Map(this.#lastChange),
      emphasis: this.#emphasis.snapshot(),
      inventory: this.#announcedInventory,
      compile: this.#announcedCompile,
      loaded: this.#loaded,
      recorded: new Map(this.#recorded),
      comments: this.#commentRevisions,
      notes: this.#noteRevisions,
      noteEmphasis: this.#noteEmphasisRevisions,
      walkthroughs: this.#walkthroughSignatures,
      walkthroughCounts: this.#walkthroughCounts,
      walkthroughsMoved: this.#walkthroughsMoved,
      announcedNotes: this.#announcedNotes,
      announcedDocuments: this.#announcedDocuments,
      announcedFiles: this.#announcedFiles,
      explorationGeneration: this.#explorationGeneration,
      explorationSeq: this.#explorationSeq,
      presentedSeq: this.#presentedSeq,
      readerExploration: this.#readerExploration,
      reading: this.#reading,
    };
    this.#publisher.queue();
    try {
      const result = change();
      if (!this.#initializing) {
        if (recovery) this.#commit(durability);
        else this.#persistContinuity();
      }
      this.#publisher.flush();
      return result;
    } catch (e) {
      this.#views = before.views;
      this.#noteFacts = before.noteFacts;
      this.#model = before.model;
      this.#presentation = before.presentation;
      this.#selection = before.selection;
      this.#captions = before.captions;
      this.#lastChange = before.lastChange;
      this.#announcedInventory = before.inventory;
      this.#announcedCompile = before.compile;
      this.#loaded = before.loaded;
      this.#recorded.clear();
      for (const [id, value] of before.recorded) this.#recorded.set(id, value);
      this.#commentRevisions = before.comments;
      this.#noteRevisions = before.notes;
      this.#noteEmphasisRevisions = before.noteEmphasis;
      this.#walkthroughSignatures = before.walkthroughs;
      this.#walkthroughCounts = before.walkthroughCounts;
      this.#walkthroughsMoved = before.walkthroughsMoved;
      this.#announcedNotes = before.announcedNotes;
      this.#announcedDocuments = before.announcedDocuments;
      this.#announcedFiles = before.announcedFiles;
      this.#explorationGeneration = before.explorationGeneration;
      this.#explorationSeq = before.explorationSeq;
      this.#presentedSeq = before.presentedSeq;
      this.#readerExploration = before.readerExploration;
      this.#reading = before.reading;
      this.#emphasis.restore(
        before.emphasis,
        new Map(
          [...before.views].flatMap(([id, v]) => (v.envelope === null ? [] : [[id, addressable(v.envelope.model)]])),
        ),
      );
      this.forgetReads();
      this.#publisher.discard();
      throw e;
    }
  }
  /** Saves the recovery record and the continuity file now; a PersistenceError when the store refuses. */
  persist(): void {
    this.#commit("durable");
  }

  #commit(how: Durability): void {
    this.#persister.commit(
      () => ({
        views: this.#views.values(),
        presentation: this.#presentation,
        selection: this.#selection,
        captions: this.#captions,
        lastChange: this.#lastChange,
        emphases: () => this.#emphasis.snapshot(),
      }),
      () => this.#continuityRecord(),
      how,
    );
  }

  /** Writes the continuity file when it changed; advisory, never refusing the change (`Persister.continuity`). */
  #persistContinuity(): void {
    this.#persister.continuity(() => this.#continuityRecord());
  }

  /** The files-cue baseline and the agent's writes still inside their window, as the continuity file keeps them (ADR 0032). */
  #continuityRecord(): ContinuityRecord {
    const now = this.#now(),
      files = this.#announcedFiles;
    return {
      version: 1,
      root: this.root,
      ...(files === null
        ? {}
        : {
            files: {
              policy: revisionOf(Buffer.from(this.#announcedFilesPolicy, "utf8")),
              entries: [...files.values()],
            },
          }),
      writes: [...this.#recorded]
        .filter(([, r]) => now - r.at <= AGENT_WRITE_WINDOW_MS)
        .map(([viewId, r]) => ({ viewId, ...r })),
    };
  }
  // ---------------------------------------------------------------- reads

  inventory(): { schemaVersion: 1; views: InventoryEntry[] } {
    const owners = this.#commentPathOwners();
    return { schemaVersion: 1, views: [...this.#views.values()].map((v) => this.#entry(v, owners)) };
  }

  /**
   * Where a view whose file is gone went, when exactly one other diagram file now holds the bytes it
   * last compiled from (a rename or a move); null when none or more than one does, so nothing is guessed.
   */
  #movedTo(v: ViewState): { id: string; sourcePath: string } | null {
    if (v.embedded !== undefined || v.lastGoodSource === undefined) return null;
    const was = revisionOf(Buffer.from(v.lastGoodSource));
    const there = [...this.#views.values()].filter(
      (u) => u !== v && u.embedded === undefined && !u.failing && u.sourceRevision === was,
    );
    return there.length === 1 ? { id: there[0]!.id, sourcePath: there[0]!.path } : null;
  }

  #entry(v: ViewState, owners: ReadonlyMap<string, ReadonlySet<TargetRef>>): InventoryEntry {
    const lastChange = this.#lastChange.get(v.id);
    const threads = this.#threadCounts(v, owners);
    const presented = this.#captions.get(v.id);
    const missing = v.diagnostics.some((d) => d.code === "source_missing");
    const movedTo = missing ? this.#movedTo(v) : null;
    return {
      id: v.id,
      kind: v.kind,
      title: v.title,
      registration: v.embedded === undefined ? "durable" : "embedded",
      ...(v.embedded === undefined ? {} : { note: v.path, name: v.embedded.name }),
      sourcePath: v.path,
      group: groupOf(v.kind),
      ...(lastChange === undefined ? {} : { lastChange }),
      ...(threads === null ? {} : { threads }),
      ...(presented?.caption === undefined ? {} : { caption: presented.caption }),
      ...(presented === undefined ? {} : { presentedAt: presented.at }),
      ...(this.#walkthroughCounts.has(v.id) ? { walkthroughs: this.#walkthroughCounts.get(v.id)! } : {}),
      ...(v.envelope === null ? {} : { counts: countsOf(v.envelope.model), modelRevision: v.envelope.revision }),
      // The file's bytes revision: a browser's own save names it, so "Saved" is said for that write only (claude-308).
      ...(v.sourceRevision === null || v.embedded !== undefined ? {} : { sourceRevision: v.sourceRevision }),
      ...this.#datesOf(v.path),
      ...(v.description ?? {}),
      // Its file is gone (flows-r1 S4): the agent and the page say so, and where it went when that is known.
      ...(missing ? { sourceMissing: true as const } : {}),
      ...(movedTo === null ? {} : { movedTo }),
    };
  }

  /** The view's threads by state, or null when its comments file cannot be read. */
  #threadCounts(view: ViewState, owners: ReadonlyMap<string, ReadonlySet<TargetRef>>): ThreadCounts | null {
    if (this.#collides(view, owners)) return null;
    try {
      const counts = noThreads();
      for (const t of this.#threads(`view:${view.id}`, this.#viewCommentsPath(view))) counts[t.status]++;
      return counts;
    } catch {
      return null;
    }
  }

  #announceInventory(): void {
    const inventory = this.inventory();
    const signature = JSON.stringify(inventory);
    if (signature === this.#announcedInventory) return;
    this.#announcedInventory = signature;
    this.#publish("inventory", inventory);
  }

  /**
   * The contents page's filter: every view by its title and kind, Mermaid
   * source, the notes about it and its comments; every note by its title,
   * text and comments. Every word must be in the card somewhere.
   */
  /** Browser-only source targets extend search without widening semantic or legacy target contracts. */
  browserSearch(raw: string | null): BrowserSearchResults {
    const words = queryWords(raw);
    const catalog = this.#discover(this.#effectiveDiscovery());
    const notePaths = new Set(
      catalog.documents.flatMap((entry) => (entry.legacy?.notePath === undefined ? [] : [entry.legacy.notePath])),
    );
    const viewIds = new Set(
      catalog.documents.flatMap((entry) => (entry.legacy?.viewId === undefined ? [] : [entry.legacy.viewId])),
    );
    for (const view of this.#views.values())
      if (view.embedded !== undefined && notePaths.has(view.path)) viewIds.add(view.id);
    const legacy = this.#search(raw, { notePaths, viewIds });
    const results: BrowserSearchResult[] = [...legacy.results];
    for (const entry of catalog.documents) {
      if (results.length >= MAX_SEARCH_RESULTS) break;
      if (entry.legacy !== undefined) continue;
      const read = readDiscoveredDocument(this.#project, catalog, entry.source.path);
      if (read === null) continue;
      const text = entry.kind === "markdown" ? splitFrontMatter(read.text).body : read.text;
      const title = (entry.kind === "markdown" ? firstHeading(text) : null) ?? posix.basename(entry.source.path);
      const where = matchCard(words, {
        title: [title, entry.source.path],
        ...(entry.kind === "markdown" ? { note: [text] } : { diagram: [text] }),
      });
      if (where === null) continue;
      const candidates: Candidate[] = [
        { field: "title", texts: [title] },
        { field: "path", texts: [entry.source.path] },
        ...(entry.kind === "markdown" ? [{ field: "note" as const, texts: [text] }] : []),
      ];
      const found = fieldMatches(words, candidates, entry.kind === "mermaid" ? text : "");
      results.push({
        target: `source:${entry.source.path}`,
        title,
        where,
        matches: found.matches,
        ...(found.more > 0 ? { moreMatches: found.more } : {}),
      });
    }
    return { query: legacy.query, results };
  }

  search(raw: string | null): SearchResults {
    return this.#search(raw);
  }

  #search(
    raw: string | null,
    coverage?: { readonly notePaths: ReadonlySet<string>; readonly viewIds: ReadonlySet<string> },
  ): SearchResults {
    const words = queryWords(raw);
    const results: SearchResult[] = [];
    const notes = this.#notes().filter((note) => coverage === undefined || coverage.notePaths.has(note.path));
    // The notes about each diagram, once, instead of a scan of every note per view.
    const notesAbout = new Map<string, NoteEntry[]>();
    for (const note of notes)
      for (const source of note.diagrams) {
        const held = notesAbout.get(source);
        if (held === undefined) notesAbout.set(source, [note]);
        else held.push(note);
      }
    const markdown = new Map<string, string>();
    const textOf = (path: string): string => {
      let text = markdown.get(path);
      if (text === undefined) markdown.set(path, (text = noteMarkdown(this.#project, path) ?? ""));
      return text;
    };
    const threads = (target: TargetRef, path: string): { id: string; bodies: string[] }[] => {
      try {
        return this.#threads(target, path).map((t) => ({ id: t.id, bodies: t.comments.map((c) => c.body) }));
      } catch {
        return [];
      }
    };
    const commentCandidates = (held: readonly { id: string; bodies: string[] }[]): Candidate[] =>
      held.flatMap((t) => t.bodies.map((body): Candidate => ({ field: "comment", texts: [body], threadId: t.id })));
    const result = (
      target: TargetRef,
      title: string,
      where: Where[],
      found: { matches: FieldMatch[]; more: number },
    ): SearchResult => ({
      target,
      title,
      where,
      matches: found.matches,
      ...(found.more > 0 ? { moreMatches: found.more } : {}),
    });
    // Each kind is gathered up to the cap on its own, then shares it (below): neither notes nor diagrams can
    // crowd the other kind out.
    const noteResults: SearchResult[] = [];
    for (const note of notes) {
      if (noteResults.length >= MAX_SEARCH_RESULTS) break;
      const title = firstHeading(textOf(note.path)) ?? posix.basename(note.path);
      const held = threads(`note:${note.path}`, commentsPathFor(note.path));
      const where = matchCard(words, {
        title: [title, note.path],
        note: [textOf(note.path)],
        comment: held.flatMap((t) => t.bodies),
      });
      if (where === null) continue;
      const candidates: Candidate[] = [
        { field: "title", texts: [title] },
        { field: "path", texts: [note.path] },
        { field: "note", texts: [textOf(note.path)] },
        ...commentCandidates(held),
      ];
      noteResults.push(result(`note:${note.path}`, title, where, fieldMatches(words, candidates, "")));
    }
    for (const view of this.#views.values()) {
      if (coverage !== undefined && !coverage.viewIds.has(view.id)) continue;
      if (results.length >= MAX_SEARCH_RESULTS) break;
      // A diagram in a note is its block, its address, its title (the nearest heading) and its name: never the
      // note around it, which is a result of its own, and never a sibling's text.
      const source = this.#viewSourceText(view);
      const embedded = view.embedded !== undefined;
      const about = embedded ? [] : (notesAbout.get(view.path) ?? []);
      const held = threads(`view:${view.id}`, this.#viewCommentsPath(view));
      const where = matchCard(words, {
        title: embedded
          ? [view.title, view.kind, view.id, view.embedded!.name]
          : [view.title, view.kind, view.path, view.id],
        diagram: [source],
        note: about.map((n) => textOf(n.path)),
        comment: held.flatMap((t) => t.bodies),
      });
      if (where === null) continue;
      const candidates: Candidate[] = [
        { field: "title", texts: [view.title] },
        { field: "title", texts: [view.kind] },
        ...(embedded
          ? [
              { field: "title" as const, texts: [view.embedded!.name] },
              { field: "path" as const, texts: [view.id], shown: view.id },
            ]
          : [{ field: "path" as const, texts: [view.path, view.id], shown: view.path }]),
        ...(view.envelope === null ? [] : elementCandidates(view.envelope.model)),
        ...about.map((n): Candidate => ({ field: "note", texts: [textOf(n.path)], notePath: n.path })),
        ...commentCandidates(held),
      ];
      const found = fieldMatches(words, candidates, source);
      if (coverage === undefined) {
        results.push(result(`view:${view.id}`, view.title, where, found));
        continue;
      }
      // The page's search: a diagram found only through a note about it is that note's hit, not its own, so it
      // is left out here, before the cap, rather than by the page after it (where it would have taken the room
      // of a diagram that matches on its own).
      const own = found.matches.filter((match) => match.field !== "note");
      if (own.length === 0) continue;
      results.push(
        result(
          `view:${view.id}`,
          view.title,
          where.filter((place) => place !== "note"),
          { matches: own, more: found.more },
        ),
      );
    }
    const [views, notesKept] = shareCap(results, noteResults, MAX_SEARCH_RESULTS);
    return { query: raw ?? "", results: [...views, ...notesKept] };
  }

  /** What a search reads of a view: a file diagram's file, an embedded diagram's block alone; each within the size limit. */
  #viewSourceText(view: ViewState): string {
    if (view.embedded === undefined) return this.#sourceText(view.path);
    const block =
      this.#memo
        .get(`embedded:${view.path}`, () => embeddedSources(this.#project, view.path))
        .get(view.embedded.name) ?? "";
    return Buffer.byteLength(block) > MAX_SOURCE_BYTES ? "" : block;
  }

  #sourceText(path: string): string {
    // The confined seam (G6): no link followed, one name, read from the descriptor; over the limit reads as "".
    return readInFolderOrNull(this.#project, path, MAX_SOURCE_BYTES)?.toString("utf8") ?? "";
  }

  /** The envelope served for a view: the last one that compiled. */
  envelope(viewId: string): DiagramEnvelope | null {
    return this.#views.get(viewId)?.envelope ?? null;
  }

  /**
   * A file diagram's raw Mermaid, for reading and copying; null for an unknown view. `modelRevision`: the served
   * model's, so a page holding this text knows which revision it read (perf #10). A file newer than the compiled
   * view (a Save the watcher has not reloaded yet) is reloaded first, so the text is never named by the revision
   * before it; when it still differs, no revision is named.
   */
  async diagramSource(viewId: string): Promise<{
    readonly viewId: string;
    readonly path: string;
    readonly source: string;
    readonly modelRevision?: string;
  } | null> {
    let view = this.#views.get(viewId);
    if (view === undefined) return null;
    // A diagram in a note is its block, never the whole note (ADR 0012); its revision is the block's.
    if (view.embedded !== undefined) {
      let read = readEmbedded(this.#project, viewId);
      if (read !== null && read.sourceRevision !== view.sourceRevision) {
        await this.reload().catch(() => {});
        view = this.#views.get(viewId);
        if (view === undefined) return null;
        read = readEmbedded(this.#project, viewId);
      }
      const block = read === null || Buffer.byteLength(read.source) > MAX_SOURCE_BYTES ? "" : read.source;
      const fresh = read !== null && read.sourceRevision === view.sourceRevision && view.envelope !== null;
      return { viewId, path: view.path, source: block, ...(fresh ? { modelRevision: view.envelope!.revision } : {}) };
    }
    if (readRevision(this.#project, view.path) !== view.sourceRevision) {
      await this.reload().catch(() => {});
      view = this.#views.get(viewId);
      if (view === undefined) return null;
    }
    const source = this.#sourceText(view.path);
    const current =
      view.envelope !== null &&
      view.sourceRevision !== null &&
      revisionOf(Buffer.from(source, "utf8")) === view.sourceRevision;
    return { viewId, path: view.path, source, ...(current ? { modelRevision: view.envelope!.revision } : {}) };
  }

  /** Shared front-door context, independent of the connection that presented it. */
  context(): Results["getContext"] {
    const shown = this.#presentation;
    const presentation =
      shown === null
        ? null
        : {
            presentationId: shown.presentationId,
            viewId: shown.viewId,
            revision: shown.revision,
            ...(shown.annotation === undefined ? {} : { annotation: shown.annotation }),
            ...(shown.walkthrough === undefined ? {} : { walkthrough: shown.walkthrough }),
          };
    const exploration = this.#explorationReport();
    return {
      presentation,
      selection: this.selection(),
      walkthrough: this.#reading,
      ...(exploration === null ? {} : { exploration }),
    };
  }

  /** The exploration the agent reads (ADR 0036 §14, O1, A10): the later of what it presented and what the reader's page said. */
  #explorationReport(): ExplorationReport | null {
    const shown = this.#presentation,
      reader = this.#readerExploration;
    const sources = this.#explorationSources();
    if (reader !== null && reader.seq > this.#presentedSeq) {
      const at = replayOn(sources, reader.viewId, reader.expand);
      if (at !== null && (reader.expand.length > 0 || reader.selection.length > 0))
        return reportOf(sources, "reader", reader.viewId, at.replayed, { selection: reader.selection });
      if (at !== null) return null;
    }
    if (shown?.expand === undefined || shown.expand.length === 0) return null;
    const at = replayOn(sources, shown.viewId, shown.expand);
    return at === null
      ? null
      : reportOf(sources, "presentation", shown.viewId, at.replayed, {
          generation: shown.generation ?? 0,
          ...(shown.notices === undefined ? {} : { notices: shown.notices }),
        });
  }

  /** What an exploration reads: the model, last-good envelopes, titles and open comment pins on sources (ticket 14). */
  #explorationSources(): ExplorationSources {
    const { model, generation } = this.#model;
    return {
      model,
      generation,
      envelope: (id) => this.envelope(id),
      title: (id) => this.#views.get(id)?.title ?? id,
      pins: (source, ids) => this.#pins(source, ids),
    };
  }

  /** Open threads anchored to `ids` on view `source`, as counts per part; none when the comments cannot be read. */
  #pins(source: string, ids: ReadonlySet<string>): CommentPin[] {
    const view = this.#views.get(source);
    if (view === undefined) return [];
    let threads: readonly Thread[];
    try {
      threads = this.#threads(`view:${source}` as TargetRef, this.#viewCommentsPath(view));
    } catch {
      return [];
    }
    const by = new Map<string, { kind: CommentPin["kind"]; id: string; open: number; latest: number }>();
    for (const t of threads) {
      const a = t.anchor as { kind: string; id?: string };
      if (
        t.status === "resolved" ||
        t.orphaned === true ||
        (a.kind !== "node" && a.kind !== "edge" && a.kind !== "group") ||
        a.id === undefined ||
        !ids.has(a.id)
      )
        continue;
      const key = `${a.kind}\0${a.id}`;
      const at = by.get(key) ?? {
        kind: a.kind as CommentPin["kind"],
        id: a.id,
        open: 0,
        latest: Number.NEGATIVE_INFINITY,
      };
      at.open++;
      for (const c of t.comments) {
        const when = Date.parse(c.createdAt);
        if (!Number.isNaN(when) && when > at.latest) at.latest = when;
      }
      by.set(key, at);
    }
    return [...by.values()].map((p) => ({
      kind: p.kind,
      id: p.id,
      open: p.open,
      ...(Number.isFinite(p.latest) ? { latestPostAt: new Date(p.latest).toISOString() } : {}),
    }));
  }

  /** GET api/exploration (routes 2 and 3): every frame of a link's list, or of the presented exploration, in one answer. */
  exploration(
    viewId: string,
    ask: { readonly expand: readonly Expansion[] } | { readonly presentationId: string },
  ): Exploration | { readonly status: 404; readonly code: string; readonly message: string } {
    const sources = this.#explorationSources();
    if ("presentationId" in ask) {
      const shown = this.#presentation;
      if (shown === null || shown.presentationId !== ask.presentationId || shown.viewId !== viewId)
        return {
          status: 404,
          code: "presentation_not_found",
          message:
            "that presentation is no longer the one shown; the page reads the current one from its next presentation event",
        };
      const answer = explorationOf(sources, viewId, shown.expand ?? [], {
        kind: "presentation",
        presentationId: shown.presentationId,
        generation: shown.generation ?? 0,
        notices: shown.notices ?? [],
      });
      if (answer !== null) return answer;
    } else {
      const answer = explorationOf(sources, viewId, ask.expand, { kind: "link" });
      if (answer !== null) return answer;
    }
    return {
      status: 404,
      code: "diagram_not_found",
      message: `no diagram view is registered as '${viewId.slice(0, 200)}'`,
    };
  }

  /** POST api/reader-exploration (O1, route 4): what the reader's page added and selected; never changes another page. */
  postReaderExploration(raw: unknown): { readonly ok: true } | { readonly ok: false; readonly message: string } {
    const bad = (message: string) => ({ ok: false, message }) as const;
    const body =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (body === null)
      return bad(
        "a report is {viewId, revision, expand: [{element, source, neighbour?}], selection?: [{source, kind, id}]}",
      );
    const extra = Object.keys(body).filter(
      (k) => k !== "viewId" && k !== "revision" && k !== "expand" && k !== "selection",
    );
    if (extra.length > 0) return bad(`a report has no field ${extra[0]}`);
    const { viewId, revision, expand, selection } = body;
    if (typeof viewId !== "string" || !this.#views.has(viewId))
      return bad("name a registered view: {viewId, revision, expand}");
    if (typeof revision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(revision))
      return bad("revision is the base view's model revision");
    const pairs = (
      value: unknown,
      max: number,
      check: (v: Record<string, unknown>) => boolean,
    ): Record<string, unknown>[] | null =>
      Array.isArray(value) &&
      value.length <= max &&
      value.every(
        (v) => typeof v === "object" && v !== null && !Array.isArray(v) && check(v as Record<string, unknown>),
      )
        ? (value as Record<string, unknown>[])
        : null;
    const name = (v: unknown, max: number): boolean => typeof v === "string" && v.length > 0 && v.length <= max;
    const list = pairs(
      expand,
      EXPLORATION_LIMITS.maxExpansions,
      (v) =>
        Object.keys(v).length === (v["neighbour"] === undefined ? 2 : 3) &&
        name(v["element"], 256) &&
        name(v["source"], 512) &&
        (v["neighbour"] === undefined || name(v["neighbour"], 256)),
    );
    if (list === null)
      return bad(`expand is at most ${EXPLORATION_LIMITS.maxExpansions} {element, source, neighbour?} entries`);
    const picked =
      selection === undefined
        ? []
        : pairs(
            selection,
            MAX_FRAME_SELECTION,
            (v) =>
              Object.keys(v).length === 3 &&
              name(v["source"], 512) &&
              (v["kind"] === "node" || v["kind"] === "edge") &&
              name(v["id"], 256),
          );
    if (picked === null) return bad(`selection is at most ${MAX_FRAME_SELECTION} {source, kind, id} parts`);
    // A report on an older revision of the base says nothing about what the reader sees now.
    if (this.envelope(viewId)?.revision !== revision)
      return bad(
        "the report is for another revision of the view; the page sends it again once it draws the current one",
      );
    this.#readerExploration = {
      viewId,
      expand: list.map((v) =>
        expansionOf(v["element"] as string, v["source"] as string, v["neighbour"] as string | undefined),
      ),
      selection: picked.map((v) => ({
        source: v["source"] as string,
        kind: v["kind"] as "node" | "edge",
        id: v["id"] as string,
      })),
      seq: ++this.#explorationSeq,
    };
    return { ok: true };
  }

  /**
   * After a reload (or a restart's restore): the presented exploration replayed on what is loaded now (A11). A
   * source that recompiled refreshes its frame and a source that left drops it, with a line; either moves the
   * generation and, when `announce`, says so to every page.
   */
  #refreshExploration(announce: boolean): boolean {
    const shown = this.#presentation;
    if (shown?.expand === undefined || shown.expand.length === 0) return false;
    const sources = this.#explorationSources();
    const at = replayOn(sources, shown.viewId, shown.expand);
    if (at === null) return false;
    const cut = JSON.stringify([at.replayed.kept, at.replayed.pieces.map((p) => [p.source, p.revision])]);
    if (cut === shown.cut) return false;
    const first = shown.cut === undefined;
    shown.cut = cut;
    if (first) return false;
    const notices: string[] = [];
    const titleOf = (id: string): string => this.#views.get(id)?.title ?? id;
    for (const d of at.replayed.dropped) {
      notices.push(
        this.#views.has(d.source)
          ? d.reason === "limit_passed"
            ? `${titleOf(d.source)} now adds more around ${d.element} than one view holds, so that part is gone`
            : `${titleOf(d.source)} no longer adds anything around ${d.element}, so that part is gone`
          : `${d.source} was removed, so its frame is gone`,
      );
    }
    shown.expand = at.replayed.kept;
    shown.notices = [...new Set(notices)].slice(0, 8);
    shown.generation = ++this.#explorationGeneration;
    if (announce) this.#publish("presentation", this.bootstrap());
    return true;
  }

  /** POST api/walkthrough-position: the walkthrough and step the reader is on, or `id: null` for none. */
  postReading(raw: unknown): { readonly ok: true } | { readonly ok: false; readonly message: string } {
    const parsed = parseWalkthroughPosition(raw, (viewId) => this.#views.has(viewId));
    if (!parsed.ok) return parsed;
    const position = parsed.position;
    if (position.id === null) {
      if (this.#reading?.viewId === position.viewId) this.#reading = null;
    } else this.#reading = position;
    return { ok: true };
  }

  /** A registered view's last-good model; unknown IDs are a refusal rather than a cache miss. */
  modelSnapshot(viewId: string): Results["getModel"] {
    if (!isViewId(viewId))
      throw new StateRefusal("invalid_params", "viewId must be a view id: a stable ID or a diagram address");
    if (!this.#views.has(viewId)) throw this.#notFound(viewId);
    return { envelope: this.envelope(viewId) };
  }

  /** One element's Expand menu on `viewId` with `expand` on the canvas (ADR 0036 §11–§13), cut from one snapshot. */
  expandMenu(viewId: string, element: string, expand: readonly Expansion[]): ExpandMenu | MenuRefusal {
    const { model, generation } = this.#model;
    return expandMenu(
      { model, generation, envelope: (id) => this.envelope(id), title: (id) => this.#views.get(id)?.title ?? id },
      viewId,
      element,
      expand,
    );
  }

  /** The project model and its generation, which moves only when the model is rebuilt (ADR 0036 §7). */
  projectModel(): { readonly model: ProjectModel; readonly generation: number } {
    return { model: this.#model.model, generation: this.#model.generation };
  }

  /** The project model as the management socket serves it, with the views failing to compile now. */
  projectModelSnapshot(): Results["getProjectModel"] {
    const failing = [...this.#views.values()]
      .filter((v) => v.failing)
      .map((v) => v.id)
      .sort();
    return { ...this.projectModel(), failing };
  }

  /** Rebuilds the project model whole when a view joined or left, or moved in anything the merge reads (A1). */
  #rebuildModel(): void {
    const inputs: ModelInputView[] = [...this.#views.values()].map((v) => {
      const facts = v.embedded === undefined ? undefined : this.#noteFacts.get(v.path);
      return {
        id: v.id,
        title: v.title,
        path: v.path,
        embedded: v.embedded !== undefined,
        ...(facts?.status === undefined ? {} : { status: facts.status }),
        ...(facts?.basedOn === undefined ? {} : { basedOn: facts.basedOn }),
        envelope: v.envelope,
      };
    });
    const signature = modelSignature(inputs);
    if (signature === this.#model.signature) return;
    this.#model = { model: mergeProjectModel(inputs), generation: this.#model.generation + 1, signature };
  }

  compileStatus(): { schemaVersion: 1; failures: unknown[] } {
    const failing = [...this.#views.values()]
      .filter((v) => v.failing)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      schemaVersion: 1,
      failures: failing.map((v) => ({
        viewId: v.id,
        sourceRevision: v.sourceRevision,
        lastValidRevision: v.envelope?.revision ?? null,
        diagnostics: v.diagnostics.filter((d) => d.severity === "error").map(wireDiagnostic),
      })),
    };
  }

  /** What is on screen, or null when nothing is presented. */
  /**
   * What is on screen, and what this server supports. With nothing presented
   * it carries only `capabilities`: no `presentation` key, which the page
   * reads as "nothing is presented".
   */
  bootstrap(): unknown {
    const presentation = this.#presentation;
    const selection = this.selection();
    const recovery = selection === null ? null : { selection, envelope: this.envelope(selection.viewId) };
    const named = {
      capabilities: CAPABILITIES,
      project: { name: this.name, ...(this.#project.nestedView === false ? { nestedView: false } : {}) },
      ...(recovery === null ? {} : { recovery }),
    };
    if (presentation === null) return named;
    const envelope = this.envelope(presentation.viewId);
    if (envelope === null) return named;
    const {
      diagnostics,
      expand: _expand,
      generation: _generation,
      notices: _notices,
      cut: _cut,
      ...stamp
    } = presentation;
    const exploration = this.#explorationStamp();
    return {
      presentation: { ...stamp, ...(exploration === null ? {} : { exploration }) },
      envelope,
      diagnostics,
      ui: { mode: "http", url: this.url },
      ...named,
    };
  }

  /** The presented exploration's stamp (A8), or null when the presentation has none. Older pages never see it (http.ts). */
  #explorationStamp(): ExplorationStamp | null {
    const shown = this.#presentation;
    if (shown?.expand === undefined || shown.expand.length === 0) return null;
    const at = replayOn(this.#explorationSources(), shown.viewId, shown.expand);
    return at === null ? null : stampOf(at.replayed, shown.generation ?? 0);
  }

  /** Snapshot the current project state; discovery never changes presentation or emphasis. */
  listEmphases(viewId?: string): { schemaVersion: 1; views: readonly EmphasisPayload[] } {
    if (viewId !== undefined) {
      if (!isViewId(viewId))
        throw new StateRefusal("invalid_params", "viewId must be a view id: a stable ID or a diagram address");
      if (!this.#views.has(viewId))
        throw new StateRefusal("diagram_not_found", `no view is named ${JSON.stringify(viewId)}`);
    }
    const ids = viewId === undefined ? [...this.#views.keys()] : [viewId];
    return { schemaVersion: 1, views: ids.map((id) => this.#emphasis.payload(id)) };
  }

  emphasisPayload(viewId: string): EmphasisPayload {
    return this.#emphasis.payload(viewId);
  }

  /** The stored selection, if it is still on a current model; a stale one is dropped. */
  selection(): ResolvedSelection | null {
    const held = this.#selection;
    if (held === null) return null;
    if (stillCurrent(held, this.#world())) return held;
    this.#selection = null;
    return null;
  }

  // -------------------------------------------------------------- changes

  present(
    viewId: string,
    annotation?: string,
    emphases?: readonly unknown[],
    walkthrough?: PresentedWalkthroughRef,
    expand?: readonly Expansion[],
  ): { presentationId: string; emphasis?: EmphasisPayload; exploration?: ExplorationStamp } {
    return this.#transaction(() => {
      if (annotation !== undefined && [...annotation].length > MAX_ANNOTATION_CHARS)
        throw new StateRefusal(
          "invalid_params",
          `the annotation is ${[...annotation].length} characters, and a caption holds at most ${MAX_ANNOTATION_CHARS}; say it in fewer`,
        );
      const view = this.#views.get(viewId);
      if (view === undefined) throw this.#notFound(viewId);
      if (view.envelope === null)
        throw new StateRefusal(
          "diagram_not_compiled",
          `${view.path} has not compiled yet, so there is nothing to present; fix it and present again`,
          {
            diagnostics: view.diagnostics.map(wireDiagnostic),
          },
        );
      // An exploration is checked whole against this one snapshot (A11): one bad entry refuses the call, naming every one.
      const expansions =
        expand === undefined || expand.length === 0
          ? undefined
          : expand.map((e) => expansionOf(e.element, e.source, e.neighbour));
      if (expansions !== undefined && walkthrough !== undefined)
        throw new StateRefusal(
          "invalid_params",
          "expand cannot be sent with walkthrough: a walkthrough's steps are drawn over the view itself (ADR 0036 §15). Send one or the other.",
        );
      if (expansions !== undefined) {
        const issues = expandIssues(this.#explorationSources(), viewId, expansions);
        if (issues.length > 0)
          throw new StateRefusal(
            "invalid_expand",
            `present_diagram refused expand (${issues.length} problem(s)). Nothing was done.\n${issues.map((i) => `- expand[${i.index}] {element: ${i.element}, source: ${i.source}${i.neighbour === undefined ? "" : `, neighbour: ${i.neighbour}`}}: ${i.problem}`).join("\n")}`,
            { issues },
          );
      }
      // Emphasis once the presentation's own arguments hold (setting one can pin a name into its note),
      // and before it, in the same transaction: the page opens on it, and a refusal of either undoes both.
      const emphasis = emphases === undefined ? undefined : this.setEmphasis(viewId, emphases, "present_diagram");
      const pageTurn = this.#presentation?.viewId !== viewId;
      this.#presentation = {
        presentationId: `present-${randomBytes(6).toString("hex")}`,
        viewId,
        revision: view.envelope.revision,
        viewport: "fit-all",
        ...(annotation === undefined || annotation === "" ? {} : { annotation }),
        ...(walkthrough === undefined ? {} : { walkthrough: { id: walkthrough.id, step: walkthrough.step } }),
        diagnostics: [],
        ...(expansions === undefined ? {} : { expand: expansions, generation: ++this.#explorationGeneration }),
      };
      if (expansions !== undefined) this.#refreshExploration(false);
      // A present takes the page (A11): what the reader added before is no longer what anyone sees.
      this.#presentedSeq = ++this.#explorationSeq;
      // The reader's walkthrough place stands until the page says otherwise (it moves or closes on a presentation).
      // The page turns to what the agent presents: a selection elsewhere is not what the reader is looking at.
      if (pageTurn || this.#selection?.viewId !== viewId) this.#selection = null;
      this.#captions.set(viewId, {
        at: new Date(this.#now()).toISOString(),
        ...(this.#presentation.annotation === undefined ? {} : { caption: this.#presentation.annotation }),
      });
      this.#publish("presentation", this.bootstrap());
      this.#announceInventory();
      const exploration = this.#explorationStamp();
      return {
        presentationId: this.#presentation.presentationId,
        ...(emphasis === undefined ? {} : { emphasis }),
        ...(exploration === null ? {} : { exploration }),
      };
    });
  }

  /** Validates every payload against the view's model, then applies them all; nothing on any problem. */
  setEmphasis(viewId: string, payloads: readonly unknown[], caller: EmphasisCaller = "set_emphasis"): EmphasisPayload {
    const refuse = (issues: readonly Issue[]) => emphasisRefusal(issues, caller);
    return this.#transaction(() => {
      const view = this.#views.get(viewId);
      if (view?.envelope == null) {
        const issue: Issue = {
          where: "viewId",
          problem: `no diagram view is registered as ${JSON.stringify(viewId)}${view === undefined ? "" : " that has compiled"}`,
          fix: "Call list_diagrams to see which views are registered.",
        };
        throw refuse([issue]);
      }
      if (payloads.length > MAX_EMPHASES_PER_VIEW)
        throw refuse([
          {
            where: "emphases",
            problem: `has ${payloads.length} emphases, more than the ${MAX_EMPHASES_PER_VIEW} a view keeps`,
            fix: "Send fewer; a view keeps its newest eight named emphases.",
          },
        ]);
      const known = addressable(view.envelope.model);
      const resolved: Emphasis[] = [];
      const issues: Issue[] = [];
      payloads.forEach((raw, index) => {
        const result = parseEmphasis(raw, viewId, known);
        if (result.ok) resolved.push(result.emphasis);
        else
          issues.push(
            ...result.issues.map((i) => (payloads.length === 1 ? i : { ...i, where: `emphases[${index}] ${i.where}` })),
          );
      });
      if (issues.length > 0) throw refuse(issues);
      if (resolved.some((e) => e.groups.length > 0)) {
        // Emphasis on an embedded diagram may pin its name into the note: the emphasis rule first.
        if (this.#views.get(viewId)?.embedded !== undefined) assertWriteAllowed(this.#project.root, "emphasis");
        const refusal = this.#pin(viewId, true);
        if (refusal !== null)
          throw refuse([
            {
              where: "viewId",
              problem: refusal.message,
              fix:
                refusal.code === "stale"
                  ? "Read the diagram again and retry."
                  : "Move the diagram to the top level of its note.",
            },
          ]);
      }
      for (const emphasis of resolved) this.#publish("emphasis", this.#emphasis.apply(emphasis, known));
      return this.#emphasis.payload(viewId);
    });
  }

  /**
   * The MCP server is about to write this view's source (or archer.toml for
   * it): its next recompile within AGENT_WRITE_WINDOW_MS is the agent's. The
   * view need not exist yet; a registration may be naming it.
   */
  recordWrite(viewId: string, summary?: string): void {
    this.forgetReads();
    if (!isViewId(viewId))
      throw new StateRefusal("invalid_params", `${JSON.stringify(String(viewId).slice(0, 100))} is not a view id`);
    if (summary !== undefined && [...summary].length > MAX_SUMMARY_CHARS)
      throw new StateRefusal(
        "invalid_params",
        `a summary is at most ${MAX_SUMMARY_CHARS} characters; this one is ${[...summary].length}`,
      );
    this.#recorded.delete(viewId);
    this.#recorded.set(viewId, {
      at: this.#now(),
      ...(summary === undefined || summary.trim() === "" ? {} : { summary: summary.trim() }),
    });
    for (const id of this.#recorded.keys()) {
      if (this.#recorded.size <= MAX_RECORDED_WRITES) break;
      this.#recorded.delete(id);
    }
    // The write may land after a restart: the next service attributes it from the saved record.
    this.#persistContinuity();
  }

  /** Whether the agent said, within the window, that it would write `viewId`. */
  #announcedWrite(viewId: string): boolean {
    const recorded = this.#recorded.get(viewId);
    return recorded !== undefined && this.#now() - recorded.at <= AGENT_WRITE_WINDOW_MS;
  }

  /** Who made the change a recompile of `viewId` shows, now: the agent if it said it would write, else the person. */
  #attribute(viewId: string): LastChange {
    const now = this.#now();
    const at = new Date(now).toISOString();
    const recorded = this.#recorded.get(viewId);
    this.#recorded.delete(viewId);
    for (const [id, r] of this.#recorded) if (now - r.at > AGENT_WRITE_WINDOW_MS) this.#recorded.delete(id);
    if (recorded === undefined || now - recorded.at > AGENT_WRITE_WINDOW_MS) return { at, by: "person" };
    return { at, by: "agent", ...(recorded.summary === undefined ? {} : { summary: recorded.summary }) };
  }

  /** The file's modification time, by the person: all that is known of a change made before the service saw it. */
  #fileChange(path: string): LastChange | undefined {
    try {
      return { at: statSync(resolveInFolder(this.#project, path)).mtime.toISOString(), by: "person" };
    } catch {
      return undefined;
    }
  }

  /** The reader's selection: current at once; saved deferred (a drag posts many), so a full disk never refuses it. */
  postSelection(raw: unknown): SelectionOutcome {
    return this.#transaction(
      () => {
        const outcome = acceptSelection(raw, this.#world());
        if (outcome.ok) this.#selection = outcome.selection;
        return outcome;
      },
      { durability: "deferred" },
    );
  }

  #world() {
    const p = this.#presentation;
    const envelope = p === null ? null : this.envelope(p.viewId);
    return {
      presentation:
        p === null || envelope === null
          ? null
          : { presentationId: p.presentationId, viewId: p.viewId, revision: p.revision, envelope },
      served: (viewId: string) => this.envelope(viewId),
    };
  }

  #notFound(viewId: string): StateRefusal {
    const ids = [...this.#views.keys()];
    return new StateRefusal(
      "diagram_not_found",
      ids.length === 0
        ? `no view "${viewId}": the Archer folder (${this.#project.folderSetting}) has no diagrams yet`
        : `no view "${viewId}"; the views are: ${ids.join(", ")}`,
    );
  }

  // ---------------------------------------------------- comments and notes
  // The files are the state (ts/src/comments/store.ts); the agent's side
  // writes them from another process, and the watcher brings that back here.

  /** The notes about a view, or null when there is no such view. */
  notesFor(viewId: string): NotesForView | null {
    const view = this.#views.get(viewId);
    return view === undefined ? null : notesForView(this.#project, viewId, view.path);
  }

  /** Every note, with the views each is about: the contents page's Notes group. */
  allNotes(): AllNotes {
    return this.#memo.get("allNotes", () => this.#readAllNotes());
  }

  #readAllNotes(): AllNotes {
    const bySource = new Map<string, string[]>();
    for (const view of this.#views.values()) bySource.set(view.path, [...(bySource.get(view.path) ?? []), view.id]);
    return allNotes(
      this.#project,
      bySource,
      this.#notes(),
      (path) => this.#datesOf(path),
      (path) => {
        try {
          const threads = this.#threads(`note:${path}`, commentsPathFor(path));
          if (threads.length === 0) return null;
          const counts = noThreads();
          for (const thread of threads) counts[thread.status]++;
          return counts;
        } catch {
          return null;
        }
      },
    );
  }

  /** A note's content; NoteNotFound for anything the inventory does not list as a note. */
  note(path: string): NoteContent {
    return noteContent(this.#project, path);
  }

  /** Durable passage emphasis for one listed note, separate from graph emphasis and recovery state. */
  noteEmphases(notePath: string): NoteEmphasisRead {
    return new NoteEmphasisStore(this.#project).read(notePath);
  }

  /** Replaces one named note emphasis on behalf of a trusted publishing actor. */
  setNoteEmphasis(raw: unknown, author: NoteEmphasisAuthor): NoteEmphasisRead {
    const result = new NoteEmphasisStore(this.#project).upsert(raw, author);
    this.forgetReads();
    // The HTTP route publishes now. Record exactly what the watcher will see
    // before its debounced reload so that one write produces one event.
    this.#noteEmphasisRevisions.set(result.snapshot.notePath, this.#noteEmphasisRevision(result.snapshot.notePath));
    this.#publish("note-emphasis", { notePath: result.snapshot.notePath });
    return result;
  }

  /** A note's content with its freshness, which may ask Git (once per note revision and repository state). */
  async noteWithFreshness(path: string): Promise<NoteContent> {
    const content = noteContent(this.#project, path);
    return { ...content, freshness: await this.#freshness.of(path) };
  }

  /** A diagram embedded in a note, by its address, compiled; null when the address names none. */
  async embeddedDiagram(address: string): Promise<EmbeddedDiagramContent | null> {
    // Only a note the inventory lists (a plain file in the folder) is ever opened.
    // Server-Timing (S9): finding and reading the fence is `read`, the note's git freshness `freshness`; the
    // compile names itself (mermaid/compile.ts).
    const reading = phaseStart();
    const notePath = typeof address === "string" ? parseDiagramAddress(address)?.notePath : undefined;
    const read =
      notePath === undefined || !this.#notes().some((n) => n.path === notePath)
        ? null
        : readEmbedded(this.#project, address);
    phaseEnd("read", reading);
    if (read === null) return null;
    const compiled = await compileEmbedded(read);
    const dating = phaseStart();
    const freshness = await this.#freshness.of(read.notePath);
    phaseEnd("freshness", dating);
    return {
      name: read.name,
      address: read.address,
      explicit: read.explicit,
      ordinal: read.ordinal,
      heading: read.heading,
      kind: read.kind,
      line: read.line,
      bodyLine: read.bodyLine,
      writable: read.writable,
      sourceRevision: read.sourceRevision,
      notePath: read.notePath,
      source: read.source,
      diagnostics: compiled.diagnostics,
      envelope: compiled.envelope,
      freshness,
    };
  }

  listComments(rawTarget: unknown): ThreadList {
    const target = targetOf(rawTarget);
    const where = this.#where(target);
    const store = this.#comments();
    const view = target.startsWith("view:") ? this.#views.get(target.slice(5)) : undefined;
    // Comments can be restored or edited independently of the source. A
    // source-change watcher alone cannot validate their positional block ids.
    if (view?.kind === "sequence") store.reconcile(this.#viewPlace(view));
    return store.list(where);
  }

  /**
   * Thread counts and latest retained post time for every current view and note, and for the project
   * conversation (`project:`), which the chat's unread dot reads.
   */
  commentActivity(): CommentActivityPayload {
    const notes = this.#notes();
    const owners = this.#commentPathOwners(notes.map((note) => note.path));
    const store = this.#comments();
    const targets: Record<string, ReturnType<typeof activityOf>> = {};
    for (const view of this.#views.values()) {
      const place = { target: `view:${view.id}` as TargetRef, path: this.#viewCommentsPath(view) };
      if (this.#placeCollides(place, owners))
        throw new CommentsError(
          "comments_file_conflict",
          `${place.path} already holds the comments of another view or note, so ${view.id} cannot keep comments until one of them is renamed`,
        );
      targets[place.target] = activityOf(this.#threads(place.target, place.path, store));
    }
    for (const note of notes) {
      const place = { target: `note:${note.path}` as TargetRef, path: commentsPathFor(note.path) };
      if (this.#placeCollides(place, owners))
        throw new CommentsError(
          "comments_file_conflict",
          `${place.path} already holds the comments of another view or note, so ${place.target} cannot keep comments until one of them is renamed`,
        );
      targets[place.target] = activityOf(this.#threads(place.target, place.path, store));
    }
    const project = this.#projectPlace();
    if (this.#placeCollides(project, owners))
      throw new CommentsError(
        "comments_file_conflict",
        `${project.path} already holds the comments of another view or note, so the project conversation cannot keep comments until one of them is renamed`,
      );
    targets[project.target] = activityOf(this.#threads(project.target, project.path, store));
    return { schemaVersion: 1, agentCommentsListed: true, targets };
  }

  /**
   * Writes an embedded diagram's name into its block, once, if it is the
   * block this service shows; null when it is pinned (or needs no pin),
   * else why not. The watcher recompiles the note.
   */
  #pin(viewId: string, isView: boolean): { code: "stale" | "unpinnable"; message: string } | null {
    const view = isView ? this.#views.get(viewId) : undefined;
    if (view?.embedded === undefined) return null;
    const outcome = pinEmbedded(this.#project, viewId, view.sourceRevision);
    if (outcome === "pinned") this.forgetReads();
    switch (outcome) {
      case "pinned":
      case "already":
        return null;
      case "stale":
        return {
          code: "stale",
          message: `the diagram ${viewId} changed in its note since it was shown; look at it again and retry`,
        };
      case "nested":
        return {
          code: "unpinnable",
          message: `the diagram ${viewId} is nested in a list or blockquote, so Archer cannot write its name into the note to keep comments and emphasis on it; move it to the top level of the note`,
        };
      default:
        return {
          code: "unpinnable",
          message: `Archer could not write the name of ${viewId} into its note; nothing was kept`,
        };
    }
  }

  /**
   * The page's new thread sent as an operation (ADR 0016): `{ operation, payload }`, the payload a NewThread.
   * A repeat of the operation answers its receipt and changes nothing. `realm` is who sent it.
   */
  createThreadOnce(raw: unknown, realm: string): OperationAck {
    const { operation, payload } = envelopeOf(raw);
    const read = readNewThread(payload);
    const input =
      read.context === undefined ? read : { ...read, context: inProject(read.context, this.#project.folderSetting) };
    const place = this.#place(input.target);
    assertWriteAllowed(this.#project.root, "comments");
    const store = this.#comments();
    // Replayed acknowledgements use this request's compiled snapshot too,
    // never a thread whose positional anchor has not been reconciled.
    store.reconcile(place);
    return this.#acknowledged(
      store.createOnce(place, operation, input, realm, () => {
        const refusal = this.#pin(input.target.slice(5), input.target.startsWith("view:"));
        if (refusal !== null)
          throw new CommentsError(refusal.code === "stale" ? "write_conflict" : "invalid_comment", refusal.message);
      }),
    );
  }

  /** The page's reply sent as an operation (ADR 0016): `{ operation, payload: { body, context? } }`; the operation names the target. */
  replyThreadOnce(threadId: string, raw: unknown, realm: string): OperationAck {
    const { operation, payload } = envelopeOf(raw);
    const { body, context } = replyOf(payload);
    const target = parseTarget(isRecord(operation) ? operation["target"] : undefined);
    if (target === null)
      throw new CommentsError(
        "invalid_operation",
        'the operation target must be "view:<view id>", "note:<path>" or "project:"',
      );
    const place = this.#where(target);
    assertWriteAllowed(this.#project.root, "comments");
    return this.#acknowledged(
      this.#comments().replyOnce(
        place,
        threadId,
        operation,
        body,
        context === undefined ? undefined : inProject(context, this.#project.folderSetting),
        realm,
      ),
    );
  }

  /** An operation's answer: what it committed, and the thread as it is now (null once gone). Only a first commit is announced. */
  #acknowledged(changed: Changed<OperationOutcome>): OperationAck {
    const outcome = changed.value.replayed ? changed.value : this.#announce(changed);
    const { id, issuedAt, name } = outcome.operation;
    const thread =
      this.#comments()
        .list({ target: changed.target, path: changed.path })
        .threads.find((t) => t.id === outcome.committed.threadId) ?? null;
    return { operation: { id, issuedAt, name }, replayed: outcome.replayed, committed: outcome.committed, thread };
  }

  /** `{ body, expectedRevision? }`: the revision the page last saw, refused as `thread_changed` once passed (O124). */
  editComment(threadId: string, commentId: string, raw: unknown): Thread {
    const { body, expectedRevision } = editOf(raw);
    return this.#announce(this.#comments().edit(threadId, commentId, body, expectedRevision));
  }

  deleteComment(threadId: string, commentId: string): Thread | { deleted: true } {
    return this.#announce(this.#comments().remove(threadId, commentId));
  }

  resolveThread(threadId: string): { resolved: true } {
    return this.#announce(this.#comments().resolve(threadId, "person"));
  }

  dismissThread(threadId: string): { dismissed: true } {
    return this.#announce(this.#comments().dismiss(threadId));
  }

  /** Every draft in the project, by target, with the target's title; a comments file that cannot be read is left out. */
  pendingComments(): Pending {
    const counts = new Map<TargetRef, number>();
    for (const { path, target, drafts } of this.#comments().pending().files) {
      const at = this.#targetOfComments(path) ?? target;
      counts.set(at, (counts.get(at) ?? 0) + drafts);
    }
    const targets = [...counts].map(([target, drafts]) => ({ target, title: this.#titleOf(target), drafts }));
    return { total: targets.reduce((sum, t) => sum + t.drafts, 0), targets };
  }

  #titleOf(target: TargetRef): string {
    if (target === PROJECT_TARGET) return this.name;
    const id = target.slice(5);
    if (target.startsWith("view:")) return this.#views.get(id)?.title ?? id;
    return noteTitle(this.#project, id);
  }

  submitComments(raw: unknown): SubmitResult {
    const { target, threadId } = readSubmitRequest(raw);
    if (target !== undefined) this.#where(target);
    const { submitted, changed, problems } = this.#comments().submit(target, threadId);
    for (const c of changed) this.#announce({ value: null, ...c });
    return { submitted, ...(problems.length > 0 ? { problems } : {}) };
  }

  /**
   * The page's submit sent as an operation (ADR 0016, O83): `{ operation, payload: { target?, threadId? } }`.
   * A repeat answers from the receipts in the files it changed and sends what is still a draft elsewhere;
   * only the files changed now are announced.
   */
  submitCommentsOnce(raw: unknown, realm: string): SubmitAck {
    const { operation, payload } = envelopeOf(raw);
    const { target, threadId } = readSubmitRequest(payload);
    if (target !== undefined) this.#where(target);
    const outcome = this.#comments().submitOnce(target, threadId, operation, realm);
    for (const c of outcome.changed) this.#announce({ value: null, ...c });
    return {
      operation: outcome.operation,
      replayed: outcome.replayed,
      submitted: outcome.submitted,
      ...(outcome.problems.length > 0 ? { problems: outcome.problems } : {}),
    };
  }

  /** Publishes exactly the person thread just changed and returns its persisted current value. */
  publishThread(thread: Thread): Thread {
    this.submitComments({ target: thread.target, threadId: thread.id });
    const current = this.listComments(thread.target).threads.find((candidate) => candidate.id === thread.id);
    if (current === undefined) throw new CommentsError("thread_not_found", `thread ${thread.id} is no longer present`);
    return current;
  }

  #comments(): CommentsStore {
    return new CommentsStore(this.#project);
  }

  /**
   * The sent threads waiting for an agent (ADR 0035 §8), left as they are: delivery records them read
   * with `markThreadRead` once its answer was written. Malformed comments files are skipped here: the
   * agent's own get_comments reports them.
   */
  waitingThreads(): Thread[] {
    return this.#comments().waiting({ markRead: false }).threads;
  }

  /** The listener received this thread's waiting comments: sent becomes read (unless the person changed it since), and the page is told. */
  markThreadRead(threadId: string, revision: number): boolean {
    const changed = this.#comments().markRead(threadId, revision);
    if (changed !== null) this.#announce({ value: null, ...changed });
    return changed !== null;
  }

  /** One thread by id, wherever it lives, or null. */
  threadById(threadId: string): Thread | null {
    return this.#comments().find(threadId);
  }

  /** Who listens in this checkout and its worktrees changed: the page's bubble is told (`listeners`). */
  announceListeners(listing: unknown): void {
    if (!this.#closed) this.#publish(LISTENER_EVENT, listing);
  }

  /** A target's threads for counts and activity, memoized with the other file reads (a write announces and forgets). */
  #threads(target: TargetRef, path: string, store?: CommentsStore): readonly Thread[] {
    return this.#memo.get(
      `threads:${target}\0${path}`,
      () => (store ?? this.#comments()).list({ target, path }).threads,
    );
  }

  /** Where a target's comments live and what its anchors are checked against. */
  #place(target: TargetRef): Place {
    this.#where(target);
    if (target === PROJECT_TARGET) return this.#projectPlace();
    if (target.startsWith("view:")) return this.#viewPlace(this.#views.get(target.slice(5))!);
    return this.#notePlace(target.slice(5));
  }

  /** Where a target's comments live, checked (the target exists and owns its file), without reading a note or model. */
  #where(target: TargetRef): PlaceRef {
    const notes = this.#notes();
    const owners = this.#commentPathOwners(notes.map((note) => note.path));
    let where: PlaceRef, who: string;
    if (target === PROJECT_TARGET) {
      where = { target, path: PROJECT_COMMENTS_PATH };
      who = "the project conversation";
    } else if (target.startsWith("view:")) {
      const view = this.#views.get(target.slice(5));
      if (view === undefined)
        throw new CommentsError("target_not_found", `no diagram view "${target.slice(5)}" to comment on`);
      where = { target, path: this.#viewCommentsPath(view) };
      who = view.id;
    } else {
      const path = target.slice(5);
      if (!notes.some((n) => n.path === path))
        throw new CommentsError(
          "target_not_found",
          `no note ${JSON.stringify(path.slice(0, 200))} in the Archer folder to comment on`,
        );
      where = { target, path: commentsPathFor(path) };
      who = target;
    }
    if (this.#placeCollides(where, owners))
      throw new CommentsError(
        "comments_file_conflict",
        `${where.path} already holds the comments of another view or note, so ${who} cannot keep comments until one of them is renamed`,
      );
    return where;
  }

  /** The one project conversation: no model or text to check an anchor against, only the whole project. */
  #projectPlace(): Place {
    return { target: PROJECT_TARGET, path: PROJECT_COMMENTS_PATH, subject: { kind: "project" } };
  }

  #viewCommentsPath(view: ViewState): string {
    return view.embedded === undefined
      ? commentsPathFor(view.path)
      : embeddedCommentsPath(view.path, view.embedded.name);
  }

  /** `places` is the walkthrough map of all views; a caller building many places passes one it computed once. */
  #viewPlace(view: ViewState, places: () => Map<string, WalkthroughsPlace> = () => this.#walkthroughsPlaces()): Place {
    return {
      target: `view:${view.id}`,
      path: this.#viewCommentsPath(view),
      subject: {
        kind: "view",
        elements: view.envelope === null ? null : elementsOf(view.envelope.model),
        ...(view.envelope?.model.type === "sequence-trace" && !view.failing
          ? { scopedIdentities: scopedIdentitiesOf(view.envelope.model) }
          : view.kind === "sequence"
            ? {
                scopedIdentities: null,
                scopedUnavailable:
                  "the sequence source does not compile, so its block cannot be anchored; fix the source and reopen the comment on the intended block",
              }
            : {}),
        walkthroughs: this.#walkthroughSubjects(view.id, places()),
        ...(view.envelope === null ? {} : { modelRevision: view.envelope.revision }),
      },
    };
  }

  /** What walkthrough and step comment anchors are checked against (ADR 0034 §9); null when the file cannot be read. */
  #walkthroughSubjects(viewId: string, places: Map<string, WalkthroughsPlace>): Map<string, WalkthroughSubject> | null {
    return new WalkthroughsStore(this.#project).subjects(places.get(viewId));
  }

  /** Whether this view shares its sidecar path with any other current target. */
  #collides(view: ViewState, owners: ReadonlyMap<string, ReadonlySet<TargetRef>>): boolean {
    const path = this.#viewCommentsPath(view),
      target = `view:${view.id}`;
    for (const owner of owners.get(path) ?? []) if (owner !== target) return true;
    return false;
  }

  /** Every current inventory target keyed by its frozen sidecar spelling. */
  #commentPathOwners(
    notePaths: readonly string[] = this.#notes().map((note) => note.path),
  ): ReadonlyMap<string, ReadonlySet<TargetRef>> {
    const owners = new Map<string, Set<TargetRef>>();
    const claim = (path: string, target: TargetRef) => {
      const held = owners.get(path);
      if (held === undefined) owners.set(path, new Set([target]));
      else held.add(target);
    };
    for (const view of this.#views.values()) claim(this.#viewCommentsPath(view), `view:${view.id}`);
    for (const notePath of notePaths) claim(commentsPathFor(notePath), `note:${notePath}`);
    claim(PROJECT_COMMENTS_PATH, PROJECT_TARGET);
    return owners;
  }

  #placeCollides(place: Pick<Place, "target" | "path">, owners: ReadonlyMap<string, ReadonlySet<TargetRef>>): boolean {
    return [...(owners.get(place.path) ?? [])].some((target) => target !== place.target);
  }

  #notePlace(path: string): Place {
    return {
      target: `note:${path}`,
      path: commentsPathFor(path),
      subject: { kind: "note", text: noteMarkdown(this.#project, path) },
    };
  }

  /** Records what a change from the page wrote, so the watcher does not announce it twice, and announces it. */
  #announce<T>(changed: Changed<T>): T {
    this.forgetReads();
    const revision = this.#commentsRevision(changed.path);
    if (revision === null) this.#commentRevisions.delete(changed.path);
    else this.#commentRevisions.set(changed.path, revision);
    if (this.#publisher.gather(changed.target)) return changed.value;
    this.#publish("comments", { target: changed.target } satisfies CommentsChanged);
    this.#announceInventory();
    return changed.value;
  }

  /**
   * One page write that changes a comments file more than once (a create or reply, then its publish in immediate
   * mode) announces each target once, after its last change (O250): the page reads a target once per `comments`
   * event, and the state between the two writes (a draft about to be sent) is one no page should be told about.
   */
  announcingOnce<T>(run: () => T): T {
    // Also when the second write fails: what the first one wrote is still told.
    return this.#publisher.gathering(run, (gathered) => {
      for (const target of gathered) this.#publish("comments", { target } satisfies CommentsChanged);
      if (gathered.size > 0) this.#announceInventory();
    });
  }

  #commentsRevision(path: string): string | null {
    try {
      return revisionOf(readInFolder(this.#project, path));
    } catch {
      return null;
    }
  }

  /** Which target a comments file is about: its one current owner (the project conversation, a view or note beside it), else what the file says. */
  #targetOfComments(path: string): TargetRef | null {
    const owners = this.#commentPathOwners();
    const held = owners.get(path);
    if (held !== undefined && held.size === 1 && held.has(PROJECT_TARGET)) return PROJECT_TARGET;
    for (const view of this.#views.values())
      if (this.#viewCommentsPath(view) === path && !this.#collides(view, owners)) return `view:${view.id}`;
    const note = `${path.slice(0, -COMMENTS_SUFFIX.length)}.md`;
    if (this.#noteRevisions.has(note)) {
      const place = this.#notePlace(note);
      if (!this.#placeCollides(place, owners)) return place.target;
    }
    try {
      const raw = JSON.parse(readInFolder(this.#project, path).toString("utf8")) as unknown;
      return isRecord(raw) ? parseTarget(raw["target"]) : null;
    } catch {
      return null;
    }
  }

  /**
   * After a reload: orphans or restores threads on views whose model moved
   * and notes whose text moved, then announces every comments file that
   * changed on disk (the agent's replies among them) and any change to notes.
   */
  #refreshCommentsAndNotes(previous: ReadonlyMap<string, ViewState>): void {
    const store = this.#comments();
    const quietly = (what: string, run: () => unknown): void => {
      try {
        run();
      } catch (error) {
        this.log(`[archer] service: ${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const notes = notesOf(this.#project);
    const owners = this.#commentPathOwners(notes.map((note) => note.path));
    const places = once(() => this.#walkthroughsPlaces());
    for (const view of this.#views.values()) {
      const before = previous.get(view.id);
      const moved =
        before?.envelope?.revision !== view.envelope?.revision ||
        before?.failing !== view.failing ||
        before?.path !== view.path ||
        this.#walkthroughsMoved.has(view.id);
      if (
        !this.#collides(view, owners) &&
        (view.envelope !== null || view.kind === "sequence" || this.#walkthroughsMoved.has(view.id)) &&
        moved
      )
        quietly(`comments on ${view.path}`, () => store.reconcile(this.#viewPlace(view, places)));
    }

    const revisions = new Map<string, string | null>();
    for (const n of notes) {
      const bytes = noteBytes(this.#project, n.path);
      revisions.set(n.path, bytes === null ? null : revisionOf(bytes));
    }
    for (const n of notes)
      if (
        !this.#placeCollides({ target: `note:${n.path}`, path: commentsPathFor(n.path) }, owners) &&
        (!this.#noteRevisions.has(n.path) || this.#noteRevisions.get(n.path) !== revisions.get(n.path))
      )
        quietly(`comments on ${n.path}`, () => store.reconcile(this.#notePlace(n.path)));
    const emphasisRevisions = new Map(notes.map((note) => [note.path, this.#noteEmphasisRevision(note.path)]));
    if (this.#loaded) {
      for (const path of new Set([...emphasisRevisions.keys(), ...this.#noteEmphasisRevisions.keys()]))
        if (emphasisRevisions.get(path) !== this.#noteEmphasisRevisions.get(path))
          this.#publish("note-emphasis", { notePath: path });
    }
    this.#noteEmphasisRevisions = emphasisRevisions;
    this.#noteRevisions = revisions;
    const signature = JSON.stringify(
      notes.map((n) => [n.path, n.type ?? null, n.status ?? null, n.diagrams, revisions.get(n.path)]),
    );
    if (signature !== this.#announcedNotes) {
      this.#announcedNotes = signature;
      this.#publish("notes", {});
    }

    let files: string[] = [];
    quietly("listing comments files", () => (files = store.files()));
    const now = new Map<string, string>();
    for (const path of files) {
      const revision = this.#commentsRevision(path);
      if (revision !== null) now.set(path, revision);
    }
    for (const path of new Set([...now.keys(), ...this.#commentRevisions.keys()])) {
      if (now.get(path) === this.#commentRevisions.get(path)) continue;
      const target = this.#targetOfComments(path);
      if (target !== null) this.#publish("comments", { target } satisfies CommentsChanged);
    }
    this.#commentRevisions = now;
  }

  // ---------------------------------------------------------- walkthroughs
  // The files are the state (ts/src/walkthroughs/store.ts), written by the
  // agent's side; the service only reads them, and resolves them against the
  // current model on every read. Nothing here writes a walkthroughs file.

  #walkthroughsPlaces(): Map<string, WalkthroughsPlace> {
    return walkthroughsPlaces(
      [...this.#views.values()].map((v) => ({
        id: v.id,
        path: v.path,
        ...(v.embedded === undefined ? {} : { embedded: v.embedded }),
      })),
    );
  }

  /** GET api/walkthroughs?viewId=: the view's walkthroughs, each resolved against its current model. */
  walkthroughsFor(
    viewId: string,
    phase: <T>(name: string, compute: () => T) => T = (_name, compute) => compute(),
  ): WalkthroughsForView {
    // `phase` names each part's time for the route's Server-Timing (S9): the walkthroughs read, their resolution
    // against the view's model, and the dead-code check of the files they name.
    const { view, walkthroughs } = phase("read", () => {
      const view = this.#views.get(viewId);
      const place = this.#walkthroughsPlaces().get(viewId);
      if (view === undefined || place === undefined) throw this.#notFound(viewId);
      return { view, walkthroughs: new WalkthroughsStore(this.#project).read(place).walkthroughs };
    });
    const model = view.envelope?.model ?? null;
    const { unsupported, resolution } = phase("resolve", () => ({
      unsupported: model === null ? null : refusedHost(model),
      resolution: model === null ? null : walkthroughs.map((w) => resolveWalkthrough(w, model)),
    }));
    return {
      schemaVersion: 1,
      viewId,
      walkthroughs,
      resolution,
      deadCode: phase("dead-code", () => deadCode(this.#project.root, walkthroughs)),
      ...(unsupported === null ? {} : { unsupported }),
    };
  }

  /**
   * GET api/walkthroughs/old: the model walkthrough `id` was written on, from Git; null when the view has no such
   * walkthrough. Nothing here writes or reads the working tree for the old model.
   */
  async oldVersion(
    viewId: string,
    id: string,
    phase: <T>(name: string, compute: () => T) => T = (_name, compute) => compute(),
  ): Promise<OldVersionResponse | null> {
    // `phase` names the route's Server-Timing parts (S9): the walkthroughs read, then the model's search in Git.
    const { view, walkthrough } = phase("read", () => {
      const view = this.#views.get(viewId);
      const place = this.#walkthroughsPlaces().get(viewId);
      if (view === undefined || place === undefined) throw this.#notFound(viewId);
      return {
        view,
        walkthrough: new WalkthroughsStore(this.#project).read(place).walkthroughs.find((w) => w.id === id),
      };
    });
    if (walkthrough === undefined) return null;
    const base = { schemaVersion: 1, viewId, id } as const;
    const found = await phase("git", () =>
      findOldVersion(
        this.#project,
        {
          viewId,
          path: view.path,
          ...(view.embedded === undefined ? {} : { embedded: view.embedded.name }),
          ...(view.manifestView === undefined ? {} : { view: view.manifestView }),
        },
        {
          modelRevision: walkthrough.modelRevision,
          ...(walkthrough.commit === undefined ? {} : { commit: walkthrough.commit }),
        },
      ),
    );
    if (found.status === "not-in-history") return { ...base, status: "not-in-history", reason: found.reason };
    const at = { how: found.how, commit: found.commit, committedAt: found.committedAt } as const;
    return found.diagram.result.envelope === null
      ? { ...base, status: "refused", ...at, diagnostics: found.diagram.result.diagnostics }
      : { ...base, status: "found", ...at, envelope: found.diagram.result.envelope };
  }

  /**
   * After a reload: announces each view whose walkthroughs file changed, or
   * whose walkthroughs now resolve differently (a recompile that moved a
   * status). A recompile that leaves every reference as it was is not news.
   */
  #refreshWalkthroughs(): void {
    const store = new WalkthroughsStore(this.#project);
    const next = new Map<string, string>();
    this.#walkthroughsMoved = new Set();
    const counts = new Map<string, number>();
    for (const [viewId, place] of this.#walkthroughsPlaces()) {
      const read = store.peek(place);
      if (read.kind === "ok" && place.conflict === undefined && read.file.walkthroughs.length > 0)
        counts.set(viewId, read.file.walkthroughs.length);
      if (read.kind === "missing") continue;
      const model = this.#views.get(viewId)?.envelope?.model ?? null;
      next.set(
        viewId,
        place.conflict !== undefined
          ? `conflict\0${place.path}`
          : read.kind === "malformed"
            ? `malformed\0${read.problem}`
            : `${revisionOf(read.bytes)}\0${model === null ? "uncompiled" : JSON.stringify(read.file.walkthroughs.map((w) => resolveWalkthrough(w, model)))}`,
      );
    }
    for (const viewId of new Set([...next.keys(), ...this.#walkthroughSignatures.keys()])) {
      if (next.get(viewId) === this.#walkthroughSignatures.get(viewId)) continue;
      this.#walkthroughsMoved.add(viewId);
      if (this.#loaded) this.#publish("walkthroughs", { viewId } satisfies WalkthroughsChanged);
    }
    this.#walkthroughSignatures = next;
    this.#walkthroughCounts = counts;
  }

  /**
   * A no-follow fingerprint for watcher classification. Metadata is enough:
   * supported writers replace the sidecar atomically, and ctime also moves
   * for an in-place edit. Non-regular and unreadable entries remain visible
   * as state changes without opening a FIFO or following a link.
   */
  #noteEmphasisRevision(notePath: string): string {
    const bytes = noteBytes(this.#project, notePath);
    const noteRevision = bytes === null ? "unreadable" : revisionOf(bytes);
    const absolute = join(this.#project.folder, ...noteEmphasisPath(notePath).split("/"));
    try {
      const info = lstatSync(absolute, { bigint: true });
      const kind = info.isFile() ? "file" : info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "other";
      return `${noteRevision}|${kind}:${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException).code;
      return `${noteRevision}|${code === "ENOENT" ? "missing" : `unreadable:${code ?? "unknown"}`}`;
    }
  }

  // --------------------------------------------------------------- reload

  /**
   * Re-reads the project and recompiles whatever changed. Reloads run one at
   * a time; calls made while one runs are folded into one more after it.
   */
  reload(): Promise<void> {
    if (this.#pending)
      return this.#reloading.then(() => {
        if (this.#reloadFailure !== null) throw this.#reloadFailure;
      });
    this.#pending = true;
    this.#reloading = this.#reloading.then(async () => {
      this.#pending = false;
      if (this.#closed) return;
      const telemetry = activeTelemetry(),
        started = telemetry === null ? 0 : performance.now();
      try {
        await this.#reloadNow();
        this.#reloadFailure = null;
        telemetry?.reloaded(this.root, performance.now() - started, true);
      } catch (error) {
        telemetry?.reloaded(this.root, performance.now() - started, false);
        if (error instanceof PersistenceError) this.#reloadFailure = error;
        this.log(
          `[archer] service: reload of ${this.root} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return this.#reloading.then(() => {
      if (this.#reloadFailure !== null) throw this.#reloadFailure;
    });
  }

  async #reloadNow(): Promise<void> {
    let project: Project;
    try {
      project = findProject(this.#project.root);
    } catch (error) {
      // An archer.toml that cannot be read keeps what was served until it can.
      this.log(`[archer] service: ${this.#project.root}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.#project = project;
    this.forgetReads();
    const previous = this.#views;
    const next = new Map<string, ViewState>();
    // A compile awaits only microtasks, so a project of many diagrams would otherwise hold the event
    // loop for the whole reload (archer-self: ~1 s at attach); requests run between compiles instead.
    let ranSince = performance.now();
    const letOthersRun = async (): Promise<void> => {
      if (performance.now() - ranSince < RELOAD_SLICE_MS) return;
      await new Promise<void>((done) => setImmediate(done));
      ranSince = performance.now();
    };
    for (const entry of entries(project)) {
      const id = entry.view?.id ?? posix.basename(entry.path, ".mmd");
      if (!isStableId(id) || next.has(id)) continue;
      next.set(id, await this.#compileView(project, entry, id, previous.get(id)));
      await letOthersRun();
    }
    // The diagrams embedded in notes, under their addresses (ADR 0012).
    const noteFacts = new Map<string, NoteFacts>();
    for (const read of allEmbedded(project)) {
      if (!noteFacts.has(read.notePath)) noteFacts.set(read.notePath, noteFactsOf(read.noteText));
      if (next.has(read.address)) continue;
      next.set(read.address, await this.#compileEmbeddedView(read, previous.get(read.address)));
      await letOthersRun();
    }
    // The page's Git fact is asked for the same way, at most once a minute.
    this.#askGit();
    // Creation dates from Git, where the file system keeps none, are asked for
    // in the background: this reload publishes now, and Git's answer is
    // announced when it comes (file-dates.ts).
    void this.#dates.refresh(
      project,
      [...new Set([...[...next.values()].map((v) => v.path), ...notesOf(project).map((n) => n.path)])],
      () => {
        if (this.#closed) return;
        this.forgetReads();
        this.#transaction(() => {
          this.#announceInventory();
          this.#publish("notes", {});
        });
      },
    );
    if (this.#closed) return;
    this.#transaction(() => {
      this.#views = next;
      this.#noteFacts = noteFacts;
      // Before this step's events go out, so whatever they prompt reads the model they describe (A1).
      this.#rebuildModel();
      this.forgetReads();

      // Who changed what: a view first seen at attach is dated by its file;
      // after that, by the recompile that saw it change.
      const changes: ChangeEvent[] = [];
      const lastChange = new Map<string, LastChange>();
      for (const [id, view] of next) {
        const before = previous.get(id);
        const kept = this.#lastChange.get(id);
        if (before === view && kept !== undefined) {
          lastChange.set(id, kept);
          continue;
        }
        // At open, a model that moved from the one saved at the stop is the agent's when it said, just before, that it would write it.
        const announced =
          !this.#loaded &&
          before?.envelope != null &&
          view.envelope !== null &&
          before.envelope.revision !== view.envelope.revision &&
          this.#announcedWrite(id);
        const change =
          (this.#loaded && before !== view) || announced ? this.#attribute(id) : this.#fileChange(view.path);
        if (change === undefined) continue;
        lastChange.set(id, change);
        const was = before?.envelope;
        if (this.#loaded && was != null && view.envelope !== null && was.revision !== view.envelope.revision)
          changes.push({ viewId: id, ...change, ...diffElements(was.model, view.envelope.model) });
      }
      this.#lastChange = lastChange;

      // Emphasis follows the model it points into.
      for (const [id, before] of previous) {
        const now = next.get(id);
        if (now === undefined) {
          if (this.#emphasis.clear(id)) this.#publish("emphasis", this.#emphasis.payload(id));
        } else if (now.envelope !== null && now.envelope.revision !== before.envelope?.revision) {
          if (this.#emphasis.revalidate(id, addressable(now.envelope.model)))
            this.#publish("emphasis", this.#emphasis.payload(id));
        }
      }

      const presentation = this.#presentation;
      // A presented view that is gone leaves nothing to present; the inventory event says so.
      if (presentation !== null && !next.has(presentation.viewId)) this.#presentation = null;

      this.#announceInventory();
      const compile = JSON.stringify(this.compileStatus());
      if (compile !== this.#announcedCompile) {
        this.#announcedCompile = compile;
        this.#publish("compile", this.compileStatus());
      }

      const shown = this.#presentation;
      const envelope = shown === null ? null : this.envelope(shown.viewId);
      // A presented exploration follows its sources (A11): one announcement covers it and the base's own move.
      const refreshed = this.#refreshExploration(false);
      if (shown !== null && envelope !== null && envelope.revision !== shown.revision) {
        shown.revision = envelope.revision;
        shown.diagnostics = (next.get(shown.viewId)?.diagnostics ?? []).map(wireDiagnostic);
        // The page clears its own selection when the revision moves; so does the service.
        this.#selection = null;
        this.#publish("presentation", this.bootstrap());
      } else if (refreshed) this.#publish("presentation", this.bootstrap());
      for (const change of changes) this.#publish("change", change);

      this.#refreshWalkthroughs();
    });
    // The rest commits in phases, each on a turn of its own (O12: at scale M the whole commit held the event
    // loop for ~775 ms at attach). Requests between them see the new views before their threads are reconciled
    // and the catalog announced, as they would see a write arrive. Reloads stay one at a time: a burst during
    // this one folds into one more reload after it, which reads everything again.
    await new Promise<void>((done) => setImmediate(done));
    if (this.#closed) return;
    this.#transaction(
      () => {
        this.#refreshCommentsAndNotes(previous);
        // Reconciling may have rewritten comments files read above.
        this.forgetReads();
      },
      { recovery: false },
    );
    await new Promise<void>((done) => setImmediate(done));
    if (this.#closed) return;
    this.#transaction(
      () => {
        this.#announceDocuments();
        // Reconciling may have orphaned threads, and the agent may have answered some.
        this.#announceInventory();
        this.#loaded = true;
      },
      { recovery: false },
    );
  }

  async #compileEmbeddedView(read: EmbeddedRead, before: ViewState | undefined): Promise<ViewState> {
    // Kept only while its body, its title and its place in the note are the
    // same: a renamed heading or prose above it moves what is shown.
    const unchanged =
      before?.embedded !== undefined &&
      before.path === read.notePath &&
      before.sourceRevision === read.sourceRevision &&
      before.title === (read.heading ?? read.name) &&
      before.embedded.bodyLine === read.bodyLine;
    // A first compile is a cold load, not a cache miss (it would trip svc.cache-miss-storm on every start).
    if (before !== undefined) activeTelemetry()?.compileCache(unchanged);
    if (unchanged) return before!;
    const compiled = await compileEmbedded(read);
    const sameBinding = before?.embedded !== undefined && before.path === read.notePath;
    const envelope = compiled.envelope ?? (sameBinding ? before.envelope : null) ?? null;
    return {
      id: read.address,
      kind: compiled.envelope?.view.kind ?? read.kind,
      title: compiled.envelope?.view.title ?? read.heading ?? read.name,
      path: read.notePath,
      sourceRevision: read.sourceRevision,
      envelope,
      diagnostics: compiled.diagnostics,
      failing: compiled.envelope === null,
      manifestView: undefined,
      embedded: { name: read.name, bodyLine: read.bodyLine },
      ...describedBy(read.source),
      ...(compiled.sourceBytes !== undefined
        ? { lastGoodSource: compiled.sourceBytes }
        : sameBinding && before.lastGoodSource !== undefined
          ? { lastGoodSource: before.lastGoodSource }
          : {}),
    };
  }

  async #compileView(
    project: Project,
    entry: DiagramEntry,
    id: string,
    before: ViewState | undefined,
  ): Promise<ViewState> {
    const sourceRevision = readRevision(project, entry.path);
    const sameSource =
      before !== undefined &&
      before.path === entry.path &&
      before.sourceRevision === sourceRevision &&
      sameView(before.manifestView, entry.view);
    if (before !== undefined) activeTelemetry()?.compileCache(sameSource);
    if (sameSource) return before;
    const compiled = await compileDiagram(project, entry);
    const failing = compiled.envelope === null;
    // A source that stops compiling keeps the last drawing that did (ADR 0010).
    const sameBinding = before?.path === entry.path && (entry.view === undefined || entry.view.kind === before.kind);
    const envelope = compiled.envelope ?? (sameBinding ? before?.envelope : null) ?? null;
    return {
      id,
      kind: compiled.envelope?.view.kind ?? entry.view?.kind ?? before?.kind ?? sniffKind(project, entry.path),
      title: compiled.envelope?.view.title ?? entry.view?.title ?? before?.title ?? id,
      path: entry.path,
      sourceRevision: compiled.revision,
      envelope,
      diagnostics: compiled.diagnostics,
      failing,
      manifestView: entry.view,
      ...describedBy(
        compiled.sourceBytes === undefined
          ? readText(project, entry.path)
          : Buffer.from(compiled.sourceBytes).toString("utf8"),
      ),
      ...(compiled.sourceBytes !== undefined
        ? { lastGoodSource: compiled.sourceBytes }
        : sameBinding && before?.lastGoodSource !== undefined
          ? { lastGoodSource: before.lastGoodSource }
          : {}),
    };
  }
}

/** archer.toml's views first, in its order (a missing source included), then the other files. */
/** The files whose revision changed, appeared or went away from `before` to `now`; null when none did. */
function filesChanged(
  before: ReadonlyMap<string, FileEntry>,
  now: ReadonlyMap<string, FileEntry>,
): FilesChanged | null {
  const changed: FileEntry[] = [],
    added: FileEntry[] = [],
    removed: { path: string; kind: FileKind }[] = [];
  for (const [path, entry] of now) {
    const was = before.get(path);
    if (was === undefined) added.push(entry);
    else if (was.revision !== entry.revision) changed.push(entry);
  }
  for (const [path, entry] of before) if (!now.has(path)) removed.push({ path, kind: entry.kind });
  const total = changed.length + added.length + removed.length;
  if (total === 0) return null;
  const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let room = MAX_FILES_EVENT;
  const take = <T extends { path: string }>(list: T[]): T[] => {
    const kept = list.sort(byPath).slice(0, Math.max(0, room));
    room -= kept.length;
    return kept;
  };
  return {
    changed: take(changed),
    added: take(added),
    removed: take(removed),
    ...(total > MAX_FILES_EVENT ? { truncated: true as const } : {}),
  };
}

/** `compute`, run on first use and then remembered: for work that a loop over every view would repeat. */
function once<T>(compute: () => T): () => T {
  let held: { value: T } | undefined;
  return () => (held ??= { value: compute() }).value;
}

function entries(project: Project): DiagramEntry[] {
  const files = listDiagrams(project);
  const listed: DiagramEntry[] = project.views.map((view) => ({ path: view.source, view }));
  const sources = new Set(project.views.map((v) => v.source));
  return [...listed, ...files.filter((f) => !sources.has(f.path))];
}

/** The folder's diagrams by the id they are shown under; the first of any two sharing one. */
function entriesById(project: Project): Map<string, DiagramEntry> {
  const byId = new Map<string, DiagramEntry>();
  for (const entry of entries(project)) {
    const id = entry.view?.id ?? posix.basename(entry.path, ".mmd");
    if (!byId.has(id)) byId.set(id, entry);
  }
  return byId;
}

/** What a diagram's source says it is about, as a ViewState field. */
function describedBy(source: string | null): { description?: NonNullable<ViewState["description"]> } {
  const found = source === null ? null : diagramDescription(source);
  return found === null ? {} : { description: found };
}

/** A bounded regular-file read for descriptions, with no blocking device or FIFO opens. */
export function readText(project: Project, path: string): string | null {
  // The confined seam (G6): no link followed, one name, a regular file read from its descriptor without blocking.
  const bytes = readInFolderOrNull(project, path, MAX_SOURCE_BYTES);
  if (bytes === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function readRevision(project: Project, path: string): Revision | null {
  try {
    return revisionOf(readInFolder(project, path));
  } catch {
    return null;
  }
}

function sameView(a: View | undefined, b: View | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.id === b.id &&
      a.kind === b.kind &&
      a.title === b.title &&
      a.source === b.source)
  );
}

function sniffKind(project: Project, path: string): DiagramKind {
  try {
    return kindOfSource(readInFolder(project, path).toString("utf8"));
  } catch {
    return "freeform";
  }
}

/** Rust's serialize_diagnostic: code, message, and the span when there is one. */
function wireDiagnostic(d: Diagnostic): { code: string; message: string; span: Diagnostic["span"] } {
  return { code: d.code, message: d.message, span: d.span };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function targetOf(raw: unknown): TargetRef {
  const target = parseTarget(raw);
  if (target === null)
    throw new CommentsError(
      "invalid_comment",
      'a target is "view:<view id>", "note:<path of a .md in the Archer folder>" or "project:"',
    );
  return target;
}

/**
 * A comment's `context.document` as stored: relative to the project (ADR 0034 §10). The page names the
 * document relative to the Archer folder, so the folder is put in front; anything else about the context is
 * the store's to check. A path that is absolute, climbs out, or no longer fits once joined is dropped, so the
 * agent is never handed a file outside the project; the page the person sent from is kept.
 */
function inProject(context: unknown, folderSetting: string): unknown {
  if (!isRecord(context) || typeof context["document"] !== "string") return context;
  const document = context["document"];
  const { document: _dropped, ...rest } = context;
  if (document === "" || document.startsWith("/") || document.split("/").includes("..")) return rest;
  const joined = posix.join(folderSetting, document);
  return joined.length > MAX_CONTEXT_DOCUMENT_CHARS ? rest : { ...context, document: joined };
}

/** An operation envelope as the page posts it: exactly an operation and its payload (ADR 0016). */
function envelopeOf(raw: unknown): { operation: unknown; payload: unknown } {
  if (
    !isRecord(raw) ||
    Object.keys(raw).some((k) => k !== "operation" && k !== "payload") ||
    !("operation" in raw) ||
    !("payload" in raw)
  )
    throw new CommentsError(
      "invalid_operation",
      'send { "operation": { "id", "issuedAt", "name", "target" }, "payload": { ... } }',
    );
  return { operation: raw["operation"], payload: raw["payload"] };
}

/** A reply as the page posts it: the text, and optionally where the person sent it from. */
function replyOf(raw: unknown): { body: unknown; context?: unknown } {
  if (!isRecord(raw) || Object.keys(raw).some((k) => k !== "body" && k !== "context"))
    throw new CommentsError("invalid_comment", 'send { "body": "<the comment>", "context": { "page": "<route>" } }');
  return raw["context"] === undefined ? { body: raw["body"] } : { body: raw["body"], context: raw["context"] };
}

/** `{ "body": "..." }`, as an edit is posted; the text itself is the store's to check. */
/** A comment edit's body: `{ body, expectedRevision? }`; an older page sends `{ body }` alone. */
function editOf(raw: unknown): { readonly body: unknown; readonly expectedRevision: number | undefined } {
  if (!isRecord(raw) || Object.keys(raw).some((k) => k !== "body" && k !== "expectedRevision"))
    throw new CommentsError(
      "invalid_comment",
      'send { "body": "<the comment>", "expectedRevision"?: <the thread revision you saw> }',
    );
  const expected = raw["expectedRevision"];
  if (expected !== undefined && !(typeof expected === "number" && Number.isSafeInteger(expected) && expected >= 0))
    throw new CommentsError("invalid_comment", "expectedRevision must be the thread's revision, a whole number");
  return { body: raw["body"], expectedRevision: expected as number | undefined };
}

function emphasisRefusal(issues: readonly Issue[], caller: EmphasisCaller = "set_emphasis"): StateRefusal {
  return new StateRefusal("invalid_emphasis", rejection(issues, caller), { issues });
}

/**
 * Two kinds of results under one cap: each keeps up to half of it, and what one kind does not use is the
 * other's. Both lists keep their order.
 */
export function shareCap<T>(first: readonly T[], second: readonly T[], cap: number): [T[], T[]] {
  const half = Math.floor(cap / 2);
  const secondKept = Math.min(second.length, Math.max(cap - half, cap - first.length));
  const firstKept = Math.min(first.length, cap - secondKept);
  return [first.slice(0, firstKept), second.slice(0, secondKept)];
}
