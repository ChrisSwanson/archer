// Comments and notes: the contract between the local service, the browser
// page and the MCP tools. Written before any of them so they can be built in
// parallel; change it only with all three sides' tests.
//
// Decisions it carries (the TypeScript port's tickets 08 and 09, amended
// 2026-10-03):
// - Comments are a quick, iterative exchange between the person and the
//   agent. The person can review, edit and delete their own comments at any
//   time, like a shared document, to stew on an idea or go over it with a
//   colleague; nothing reaches the agent until the person submits.
// - The person sends drafts with "Send N to agent" (every draft in the
//   project). Editing a sent comment puts its thread back to draft, marked
//   changed; the agent sees the new text when it is sent again.
// - Version 2 (phase 2, the feedback loop):
//   each state is named honestly (draft, sent, read, answered, resolved), every
//   thread carries a `revision` the person's changes advance, and the agent
//   answers or resolves only the revision it read.
// - The person resolving a thread removes it from the file (git keeps
//   history). The agent resolving one keeps it, `resolved`, until the person
//   dismisses it.
// - One comments file per diagram or note, beside it in the Archer folder:
//   `<name>.comments.json` next to `<name>.mmd` or `<name>.md`.
// - Wave 2 (agent surfaces, ticket 08): one project conversation per attached
//   project, the target `project:` (exactly that string), anchored `{ kind: "project" }`, kept in
//   `.project-comments.json` at the top of the Archer folder: a dot-name that is not `*.comments.json`, so no
//   view or note can map to it. Same lifecycle as a document conversation (ADR 0034 §10). A person's
//   comment may carry `context: { page, document? }`: where they sent it from.
//
// HTTP routes, relative to a project's resource base (`/p/<name>/`), all
// JSON, all subject to the page's token, same-origin check and body limits:
//   GET    api/notes?viewId=<id>          -> NotesForView
//   GET    api/notes/all                  -> AllNotes         (every note, those about no diagram too,
//                                                            with its dates and description)
//   GET    api/notes/content?path=<path>  -> NoteContent      (path relative to the Archer folder)
//   GET    api/notes/diagram?address=<a>  -> EmbeddedDiagramContent (a mermaid fence of a note, `<note>#<name>`)
//   GET    api/comments?target=<kind>:<id>-> ThreadList       (kind "view" with a view id, "note" with a note path,
//                                                            or exactly "project:")
//   GET    api/comments/pending           -> Pending          (every draft in the project, by target)
//   POST   api/comments                   <- { operation, payload: NewThread }        -> OperationAck (ADR 0016;
//                                                                 NewThread may carry `context`)
//   POST   api/comments/<threadId>/replies<- { operation, payload: { body, context? } } -> OperationAck
//   (POST api/comments/submit, too, takes only an operation; a plain body is refused `invalid_operation`, 422.)
//   PATCH  api/comments/<threadId>/<commentId> <- { body, expectedRevision? } -> Thread (only the person's own
//                                                                 comments; given the thread revision the page saw, a
//                                                                 thread past it is refused `thread_changed` (409) with
//                                                                 the thread now in `error.details`, O124; without it,
//                                                                 as an older page sends, the edit is taken as before)
//   DELETE api/comments/<threadId>/<commentId>                -> Thread | { deleted: true } (deleting a thread's
//                                                                 first comment with no replies deletes the thread)
//   POST   api/comments/<threadId>/resolve                    -> { resolved: true }  (the person's: removed at once)
//   POST   api/comments/<threadId>/dismiss                    -> { dismissed: true } (removes a `resolved` thread;
//                                                                 any other is refused with `thread_not_resolved`)
//   POST   api/comments/submit             <- { target?: string, threadId?: string } -> SubmitResult (threadId: exactly that thread; no selector: every draft in the
//                                                                 project; with one, that target's)
// Server-sent event (on the page's existing `api/events` stream):
//   event `comments`, data CommentsChanged    (any thread of a target changed, by the person or by the
//                                              agent: read, answered, resolved)
//   event `notes`,    data { viewId?: string } (notes or their associations changed)
// Bootstrap (`api/bootstrap`) gains `capabilities: { comments: true, notes: true }` when the server
// supports them; a page without them shows neither feature.
//
// MCP tools (agent side):
//   get_comments    { target?: string }                       -> { threads: Thread[] }  sent threads (now read)
//                                                                and read ones still unanswered, with revisions
//   create_comment  { target, anchor, body }               -> Thread                 agent-authored root, answered
//   reply_comment   { threadId, body, expectedRevision }      -> Thread                 the agent's reply; refused
//                                                                with `thread_changed` when the person changed it
//   resolve_comment { threadId, expectedRevision, note? }     -> { resolved: true }     kept as `resolved`
// A `thread_changed` refusal carries the thread as it is now: `{ threadId, revision, status, comments }`.

export const COMMENTS_SCHEMA_VERSION = 2;
/**
 * A comments file is version 3 only while a thread uses a `walkthrough` or
 * `step` anchor or an element anchor's `context` (ADR 0034 §9); otherwise it is
 * written as version 2, so an older Archer still reads every file without them.
 */
export const COMMENTS_WALKTHROUGH_VERSION = 3;
/**
 * Version 4 (wave 2, ADR 0034 §10): a file that holds a `project:` thread or a
 * person's comment `context`. 0.6.x reads version 3 and refuses a key it does
 * not know, so these are written as 4, which it reports as unreadable instead
 * of misreading. Versions 1 to 4 are all read.
 */
export const COMMENTS_CONTEXT_VERSION = 4;
/**
 * Version 5 (0.10.0): a file that holds operation receipts (`receipts`, ADR 0016) beside its threads, or a
 * thread naming its diagram's `modelRevision`. A file gains receipts on its first page write sent as an
 * operation and keeps them (a receipt-only file, once its threads are gone): 0.9.x refuses version 5 as
 * unreadable rather than dropping them.
 */
export const COMMENTS_RECEIPTS_VERSION = 5;
/** Optional scoped comment identity; older strict readers refuse this version instead of retargeting (ADR 0034). */
export const COMMENTS_SCOPED_IDENTITY_VERSION = 6;

export interface ScopedIdentity {
  readonly version: 1;
  readonly fingerprint: string;
  /** False once identical scopes have been observed; ambiguity never heals by deleting a copy. */
  readonly unique: boolean;
}

export type Author = "person" | "agent";

/**
 * Where the person was when they commented on an element: a walkthrough and its step (ADR 0034 §9).
 * It says where they were and does not change what the element anchor resolves to.
 */
export interface WalkthroughContext {
  readonly walkthrough: string;
  readonly step: string;
}

/** What a thread is about. Ids are stable view, node, edge and group ids (ticket 05). */
export type Anchor =
  | { readonly kind: "view" }
  | {
      readonly kind: "node" | "edge" | "group";
      readonly id: string;
      readonly label: string;
      readonly context?: WalkthroughContext;
    }
  | {
      readonly kind: "selection";
      readonly nodes: readonly { readonly id: string; readonly label: string }[];
      readonly edges: readonly { readonly id: string; readonly label: string }[];
      readonly context?: WalkthroughContext;
    }
  /** A whole walkthrough of the view (ADR 0034 §9); `label` is its title, written by Archer. */
  | { readonly kind: "walkthrough"; readonly walkthrough: string; readonly label: string }
  /** One step of a walkthrough, by the step's id; `label` is "<n>. <step title>", written by Archer. */
  | { readonly kind: "step"; readonly walkthrough: string; readonly step: string; readonly label: string }
  /** The whole project: the anchor of the one `project:` conversation (ADR 0034 §10, amended). */
  | { readonly kind: "project" }
  /** A passage of a note, anchored by its text so it survives edits around it. */
  | {
      readonly kind: "passage";
      readonly quote: string;
      readonly prefix: string;
      readonly suffix: string;
    };

/** The one conversation target of a whole project: exactly this string. */
export const PROJECT_TARGET = "project:" as const;

/** `view:<viewId>`, `note:<path relative to the Archer folder>` or `project:` (the whole project). */
export type TargetRef = `view:${string}` | `note:${string}` | typeof PROJECT_TARGET;

/**
 * Where the person was when they sent a comment: the page's route (`/projects/demo/search`) and, on a
 * diagram or note page, the project-relative file path (`.archer/notes/auth.md`; the page sends it
 * relative to the Archer folder and the service puts the folder in front). Only a person's comment has
 * one, and a file that holds one is version 4.
 */
export interface CommentContext {
  readonly page: string;
  readonly document?: string;
}

export interface Comment {
  readonly id: string;
  readonly author: Author;
  readonly body: string;
  readonly createdAt: string; // ISO 8601
  readonly editedAt?: string;
  /** Where the person sent it from; absent on the agent's comments and on comments from before wave 2. */
  readonly context?: CommentContext;
}

/**
 * draft     the person's, not sent
 * sent      sent; the agent has not fetched it
 * read      the agent fetched it (get_comments)
 * answered  the latest turn is the agent's (including an agent-opened root), awaiting the person
 * resolved  the agent marked it done; kept until the person dismisses it
 * Any person change to a thread that is not a draft makes it a draft again; an
 * edit (or a person reply to a sent or read thread) also marks it
 * `changedAfterSubmit`, which the agent's reply or resolve clears.
 */
export type ThreadStatus = "draft" | "sent" | "read" | "answered" | "resolved";

export interface Thread {
  readonly id: string;
  readonly target: TargetRef;
  readonly anchor: Anchor;
  readonly status: ThreadStatus;
  /** Advances on every change the person makes (new thread, edit, delete, reply). */
  readonly revision: number;
  /**
   * The diagram's model revision when the thread was created (`read_diagram`'s and `present_diagram`'s
   * `modelRevision`), so an agent can tell whether the drawing changed since. View threads from 0.10.0 on; absent
   * on older threads, on notes and the project conversation, and when the view had no compiled model. A file
   * holding one is version 5.
   */
  readonly modelRevision?: string;
  /** Optional semantic scope identity, computed by Archer; never a diagram-model field. */
  readonly identity?: ScopedIdentity;
  readonly changedAfterSubmit?: boolean;
  /** Set when an anchor is gone or a sequence block's semantic identity is unavailable/ambiguous; the last label is kept. */
  readonly orphaned?: boolean;
  readonly comments: readonly Comment[];
}

/** GET api/comments/pending -> every draft in the project, by target. */
export interface Pending {
  readonly total: number;
  readonly targets: readonly { readonly target: TargetRef; readonly title: string; readonly drafts: number }[];
}

export interface ThreadList {
  readonly schemaVersion: typeof COMMENTS_SCHEMA_VERSION;
  readonly target: TargetRef;
  readonly threads: readonly Thread[];
}

export interface NewThread {
  readonly target: TargetRef;
  readonly anchor: Anchor;
  readonly body: string;
  readonly context?: CommentContext;
  /** Optional creation precondition: prevents a positional block id moving while its composer is open. */
  readonly expectedModelRevision?: string;
}

export interface SubmitResult {
  readonly submitted: number;
  /** Comments files that could not be read, skipped and left as they are (see the notes at the end). */
  readonly problems?: readonly string[];
}

export interface CommentsChanged {
  readonly target: TargetRef;
}

/** On disk: `<name>.comments.json` beside the diagram or note it is about. */
export interface CommentsFile {
  readonly version:
    | typeof COMMENTS_SCHEMA_VERSION
    | typeof COMMENTS_WALKTHROUGH_VERSION
    | typeof COMMENTS_CONTEXT_VERSION
    | typeof COMMENTS_RECEIPTS_VERSION
    | typeof COMMENTS_SCOPED_IDENTITY_VERSION;
  readonly target: TargetRef;
  readonly threads: readonly Thread[];
  /** Versions 5 and 6: receipts of the page's comment operations on this target (ADR 0016). */
  readonly receipts?: ReceiptLedger;
}

// ------------------------------------------------------- operation receipts (ADR 0016, O67)
// The page's comment create, reply and submit, sent as operations when bootstrap says `commentOperations: 1`:
//   POST api/comments                   <- { operation, payload: NewThread }        -> OperationAck
//   POST api/comments/<threadId>/replies<- { operation, payload: { body, context? } } -> OperationAck
//   POST api/comments/submit            <- { operation, payload: { target?, threadId? } } -> SubmitAck
// A submit can change several comments files: each file it changed keeps the submit's receipt with that
// file's count, written with the effect; a repeat replays the files holding it and submits in the others (O83).
// The same identity sent again is answered with the original acknowledgement and no new effect (`replayed`),
// before or after a restart; with other content, or from another sign-in, it is refused with
// `operation_payload_mismatch` (409); older than RECEIPT_REPLAY_MS, `operation_expired` (409); on a target
// already holding MAX_RECEIPTS_PER_TARGET live receipts, `operation_capacity_exceeded` (409). A service
// without the capability refuses an envelope as `invalid_comment`, so nothing is ever written twice by a
// page that sent one. Other comment writes (edit, delete, resolve, dismiss) and the agent's writes
// are not operations: they set a named state and repeating one does not add a second effect.

export type CommentOperationName = "comment.create" | "comment.reply";

/** A submit's identity: no target of its own, its payload names what it sends (every draft, a target, a thread). */
export interface SubmitOperation {
  readonly id: string;
  readonly issuedAt: number;
  readonly name: "comment.submit";
}

/** An operation's identity: a client nonce (128 bits, 32 lowercase hex), when it was issued (ms), what and where. */
export interface CommentOperation {
  readonly id: string;
  readonly issuedAt: number;
  readonly name: CommentOperationName;
  readonly target: TargetRef;
}

/** What the service keeps of one committed create or reply: its identity, digest and result ids, never a snapshot. */
export interface ThreadReceipt {
  readonly id: string;
  readonly issuedAt: number;
  readonly operation: CommentOperationName;
  readonly digest: string;
  readonly threadId: string;
  readonly commentId: string;
  readonly revision: number;
  readonly committedAt: string;
}

/** What one comments file keeps of a submit that changed it: how many of its threads that submit sent. */
export interface SubmitReceipt {
  readonly id: string;
  readonly issuedAt: number;
  readonly operation: "comment.submit";
  readonly digest: string;
  readonly submitted: number;
  readonly committedAt: string;
}

export type CommentReceipt = ThreadReceipt | SubmitReceipt;

/** A target's receipts, with the expiry floor and clock watermark that only ever advance (ms). */
export interface ReceiptLedger {
  readonly floor: number;
  readonly watermark: number;
  readonly entries: readonly CommentReceipt[];
}

/**
 * The answer to an operation: what was committed (the first time, or as its receipt says on a repeat) and,
 * separately, the thread as it is now (null when it has been resolved or deleted since).
 */
export interface OperationAck {
  readonly operation: { readonly id: string; readonly issuedAt: number; readonly name: CommentOperationName };
  readonly replayed: boolean;
  readonly committed: {
    readonly threadId: string;
    readonly commentId: string;
    readonly revision: number;
    readonly committedAt: string;
  };
  readonly thread: Thread | null;
}

/**
 * The answer to a submit sent as an operation: how many threads it sent (on a repeat, the receipts' counts plus
 * whatever it sent now in files that held none), and whether any of that was answered from a receipt.
 */
export interface SubmitAck extends SubmitResult {
  readonly operation: SubmitOperation;
  readonly replayed: boolean;
}

/** How long a receipt answers a repeat: 30 days from its issuedAt. */
export const RECEIPT_REPLAY_MS = 30 * 24 * 60 * 60 * 1000;
/** Live receipts one target keeps; a new operation past this is refused, a live receipt is never evicted. */
export const MAX_RECEIPTS_PER_TARGET = 4_096;
/** How far ahead of the service's clock an operation may be dated. */
export const MAX_OPERATION_SKEW_MS = 5 * 60 * 1000;

export interface NoteSummary {
  readonly path: string; // relative to the Archer folder
  readonly title: string; // first heading, else the file name
  readonly type?: string;
  readonly status?: string;
}

export interface NotesForView {
  readonly viewId: string;
  readonly notes: readonly NoteSummary[];
}

/**
 * One note in the project's listing (`api/notes/all`, phase 3b): what the
 * contents page needs to show a note about no diagram, which no view's
 * `api/notes?viewId=` can name.
 */
export interface NoteListing extends NoteSummary {
  /** The note's comments by state, when its comments can be read. */
  readonly threads?: Readonly<Record<ThreadStatus, number>>;
  /** The diagrams it is about that exist, folder-relative, sorted. */
  readonly diagrams: readonly string[];
  /** The registered views whose source is one of those diagrams, sorted. */
  readonly viewIds: readonly string[];
  /**
   * When the file was created, ISO 8601, and where that came from: the file
   * system's birth time, or the commit that first added it. Absent when
   * neither knows (ts/src/project/file-dates.ts).
   */
  readonly createdAt?: string;
  readonly createdFrom?: "filesystem" | "git";
  /** The file's modification time, ISO 8601. */
  readonly modifiedAt?: string;
  /** What the note is about: its `description:` front matter, else its first paragraph (ts/src/project/describe.ts). */
  readonly description?: string;
  readonly descriptionFrom?: "frontmatter" | "derived";
  /** Who wrote the note, from its `author:` front matter; only `agent` or `person`. */
  readonly author?: "agent" | "person";
}

export interface AllNotes {
  readonly notes: readonly NoteListing[];
}

export interface NoteContent {
  readonly path: string;
  readonly frontMatter: Readonly<Record<string, unknown>>;
  /** The note's Markdown body. The page renders it without raw HTML. */
  readonly markdown: string;
  readonly revision: string;
  /** The mermaid fences of the note, in order; absent when it has none (docs/proposals/notes-with-embedded-diagrams.md). */
  readonly diagrams?: readonly EmbeddedDiagramSummary[];
  /** Fence names not taken as written, in sentences with lines of the note file. */
  readonly diagramProblems?: readonly string[];
  /** The last commit that touched the note; absent from a server that does not say. */
  readonly freshness?: NoteFreshness;
}

/**
 * How fresh a note (and every diagram in it) is: the last commit that touched
 * the note file, and whether it has changed since; or why there is none.
 */
export type NoteFreshness =
  | {
      readonly status: "committed";
      readonly commit: string;
      readonly committedAt: string;
      readonly uncommitted: boolean;
    }
  | { readonly status: "never-committed" }
  | { readonly status: "not-in-git" }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * One mermaid fence of a note: a diagram named by its note-scoped address
 * `<note path>#<name>`. Lines are of the note file, front matter included.
 */
export interface EmbeddedDiagramSummary {
  readonly name: string;
  readonly address: string;
  /** Named by a `%% archer-id:` line, rather than derived from its heading or place. */
  readonly explicit: boolean;
  /** Its place among the note's mermaid fences, from 1. */
  readonly ordinal: number;
  readonly heading: string | null;
  readonly kind: string;
  /** The opening fence's line. */
  readonly line: number;
  readonly bodyLine: number;
  /** Whether write_diagram can write it back: a closed fence at the top level of the note. */
  readonly writable: boolean;
  /** Of the fence's body: prose edits around it leave it alone. */
  readonly sourceRevision: string;
}

/** GET api/notes/diagram?address=<address> */
export interface EmbeddedDiagramContent extends EmbeddedDiagramSummary {
  readonly notePath: string;
  readonly source: string;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly severity: string;
    readonly message: string;
    readonly span: {
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    };
  }[];
  /** The compiled drawing, its view named by the diagram's name; null while it does not compile. */
  readonly envelope: unknown;
  readonly freshness: NoteFreshness;
}

/** Limits, in the spirit of Rust's: a comment body, threads per target. */
export const MAX_COMMENT_CHARS = 4_000;
export const MAX_THREADS_PER_TARGET = 500;
/** A comment's `context`: the route, and the project-relative file path (as long as a note path). */
export const MAX_CONTEXT_PAGE_CHARS = 1_024;
export const MAX_CONTEXT_DOCUMENT_CHARS = 4_096;

// Added by the server slice (2026-10-03), the smallest changes the store needed:
// - Anchor bounds, so a page knows what the service refuses: elements in one
//   selection, and the characters of a passage's quote and of each context.
// - The server re-reads an anchor's labels from the compiled model; the
//   labels a page sends are not trusted.
// - A passage is found when `prefix + quote + suffix`, read as plain text
//   (Markdown's `*`, `_`, backticks, `#`, `>`, link syntax dropped, whitespace
//   folded), occurs in the note's Markdown read the same way. Otherwise it is
//   refused on creation and orphaned later.
// - `x.mmd` and `x.md` in one folder would share `x.comments.json`; the file
//   belongs to whichever target wrote it first, and the other is refused with
//   `comments_file_conflict` until one is renamed. A file beside a renamed
//   view (same kind, other id) is that view's.
// - SubmitResult may carry `problems`: comments files that could not be read
//   and were skipped (each is left untouched).
export const MAX_SELECTION_ELEMENTS = 100;
export const MAX_PASSAGE_QUOTE_CHARS = 1_000;
export const MAX_PASSAGE_CONTEXT_CHARS = 200;
// Added by the phase 2 server slice (2026-10-04), the smallest changes the
// amendment left open:
// - `submit` moves drafts to `sent` without advancing `revision`: the
//   revision counts changes to what the person wrote, and a send changes none.
// - `POST api/comments/<id>/dismiss` answers `{ dismissed: true }`; a thread
//   that is not `resolved` is refused with `thread_not_resolved` (409).
// - The agent replies to or resolves only a sent, read or answered thread; a
//   draft, or a resolved one, is refused with `thread_not_awaiting`. The
//   revision is checked first, so a thread the person changed is refused as
//   `thread_changed` whatever its status now.
// - `Pending` lists only targets with drafts; a comments file that cannot be
//   read is left out of it (the submit's `problems` name it).
