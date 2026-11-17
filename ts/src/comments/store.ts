import {
  Bad,
  isObject,
  hasControl,
  only,
  text,
  body,
  commentContext,
  anchor,
} from "../../../shared/comment-shapes.mts";
// Comments on disk (ticket 08, contract.ts): one `<name>.comments.json`
// beside each commented diagram or note in the Archer folder, written only
// through writeConfined.
//
// - Every file is validated when read. A malformed one is reported by path
//   and never rewritten, dropped or "repaired": the person or git decides.
// - Ids are made here, never taken from a caller.
// - Status moves only as the contract says: draft -> sent (submit) -> read
//   (the agent fetches) -> answered (the agent replies) -> resolved (the agent
//   resolves). Any person change to a thread that is not a draft makes it a
//   draft again: an edit, a deletion, or a reply to a sent or read thread
//   marks it changed after submit; a reply to an answered or resolved one
//   does not. The agent's reply or resolve clears the change mark.
// - Every person change advances the thread's revision. The agent names the
//   revision it read when it replies or resolves, and is refused with
//   `thread_changed` (and the thread as it is now) when that moved.
// - The person resolving removes the thread; the agent resolving keeps it as
//   `resolved` until the person dismisses it. A file left with no threads is
//   removed.
// - The service and the MCP server are separate processes writing the same
//   files, so the entire read/change/write/delete transaction holds a
//   cross-process bakery lock. The byte check also detects uncoordinated
//   editor writes observed before commit; it is not itself mutual exclusion.
import { randomBytes } from "node:crypto";
import { CommentsLockError, withCommentsLock } from "./lock.ts";
import { renderedNoteText } from "./note-text.ts";
import { parseDiagramAddress } from "../../../shared/note-diagrams.mts";
import { locatePassage } from "../../../shared/note-markdown.mts";
import { existsSync, readdirSync, lstatSync } from "node:fs";
import { join, posix } from "node:path";
import { isViewId } from "../model/index.ts";
import {
  ConfinedRefusal,
  ConfinedTooLarge,
  ProjectError,
  readInFolder,
  removeInFolder,
  resolveInFolder,
  writeConfined,
  type Project,
} from "../project/index.ts";
import { assertWriteAllowed } from "../config/write-policy.ts";
import {
  elementsOf,
  ground as groundIn,
  walkthroughSubjectNow,
  type Subject,
} from "../../../shared/comment-grounding.mts";
import {
  COMMENTS_SCHEMA_VERSION,
  COMMENTS_WALKTHROUGH_VERSION,
  COMMENTS_CONTEXT_VERSION,
  COMMENTS_RECEIPTS_VERSION,
  COMMENTS_SCOPED_IDENTITY_VERSION,
  MAX_THREADS_PER_TARGET,
  PROJECT_TARGET,
  type Anchor,
  type Author,
  type Comment,
  type CommentContext,
  type CommentsFile,
  type CommentOperation,
  type CommentReceipt,
  type SubmitOperation,
  type NewThread,
  type OperationAck,
  type ReceiptLedger,
  type TargetRef,
  type Thread,
  type ThreadList,
  type ThreadStatus,
  type ScopedIdentity,
} from "./contract.ts";
import {
  ReceiptShapeError,
  admit,
  operationDigest,
  readLedger,
  readOperation,
  readSubmitOperation,
  type ReceiptRefusal,
} from "./receipts.ts";

export { elementsOf };
export type { ScopedEntry, Subject, WalkthroughSubject } from "../../../shared/comment-grounding.mts";

export const COMMENTS_SUFFIX = ".comments.json";
/**
 * Where the `project:` conversation lives, folder-relative: a reserved name no view or note can map to. A
 * dot-name is never a note or a discovered diagram, and it does not end in `.comments.json`, the spelling
 * every view's and note's sidecar has, so not even a manifest view's source can claim it.
 */
export const PROJECT_COMMENTS_PATH = ".project-comments.json";
/** A comments file larger than this is not read, and a write that would make one is refused. */
export const MAX_COMMENTS_FILE_BYTES = 8 * 1024 * 1024;
/** How many times a write starts over when another process changed the file under it. */
const WRITE_ATTEMPTS = 4;

export type CommentsErrorCode =
  | "invalid_comment"
  | "target_not_found"
  | "thread_not_found"
  | "comment_not_found"
  | "not_editable"
  | "has_replies"
  | "thread_not_awaiting"
  | "thread_changed"
  | "thread_not_resolved"
  | "too_many_threads"
  | "comments_file_too_large"
  | "malformed_comments_file"
  | "comments_file_conflict"
  | "write_conflict"
  | ReceiptRefusal;

const HTTP_STATUS: Readonly<Record<CommentsErrorCode, number>> = {
  invalid_comment: 422,
  target_not_found: 404,
  thread_not_found: 404,
  comment_not_found: 404,
  not_editable: 403,
  has_replies: 409,
  thread_not_awaiting: 409,
  thread_changed: 409,
  thread_not_resolved: 409,
  too_many_threads: 409,
  comments_file_too_large: 409,
  malformed_comments_file: 409,
  comments_file_conflict: 409,
  write_conflict: 409,
  invalid_operation: 422,
  operation_payload_mismatch: 409,
  operation_expired: 409,
  operation_capacity_exceeded: 409,
};

/** A refusal with a stable code; `status` is what the page is answered with. `details` is data for the caller (thread_changed: the thread as it is now). */
export class CommentsError extends Error {
  constructor(
    readonly code: CommentsErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommentsError";
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

interface NewThreadInput {
  readonly anchor: unknown;
  readonly body: unknown;
  readonly context?: unknown;
  readonly expectedModelRevision?: unknown;
}

/** A target, its comments file (folder-relative) and what it is about. */
export interface Place {
  readonly target: TargetRef;
  readonly path: string;
  readonly subject: Subject;
}

/** A target and its comments file, without what it is about: enough to read its threads. */
export type PlaceRef = Pick<Place, "target" | "path">;

/** An operation's outcome and the comments file it changed. */
export interface Changed<T> {
  readonly value: T;
  readonly target: TargetRef;
  readonly path: string;
}

export interface StoreOptions {
  readonly now?: () => string;
  readonly newId?: (prefix: "t" | "c") => string;
  /** The wall clock in milliseconds, for operation receipts' expiry (ADR 0016). */
  readonly clock?: () => number;
}

/** What an operation did: its receipt, and whether it was answered from that receipt (a repeat). */
export interface OperationOutcome {
  readonly replayed: boolean;
  readonly operation: CommentOperation;
  readonly committed: OperationAck["committed"];
}

/** What a submit sent as an operation did (O83): its count, and the files it changed now (a replay changes none). */
export interface SubmitOutcome {
  readonly operation: SubmitOperation;
  /** Some of the count was answered from receipts: the operation had been committed (at least partly) before. */
  readonly replayed: boolean;
  readonly submitted: number;
  readonly changed: { target: TargetRef; path: string }[];
  readonly problems: string[];
}

// ------------------------------------------------------------- elements

// ---------------------------------------------------------------- paths

/** `a/x.mmd` or `a/x.md` -> `a/x.comments.json`. */
export function commentsPathFor(source: string): string {
  const dot = source.lastIndexOf(".");
  const slash = source.lastIndexOf("/");
  return `${dot > slash ? source.slice(0, dot) : source}${COMMENTS_SUFFIX}`;
}

const NOTE_PATH_CHARS = 4096;

/** A `view:<id>`, `note:<path>` or `project:` reference, or null. The note path is checked for shape, not existence. */
export function parseTarget(raw: unknown): TargetRef | null {
  if (typeof raw !== "string") return null;
  if (raw === PROJECT_TARGET) return raw;
  if (raw.startsWith("view:")) return isViewId(raw.slice(5)) ? (raw as TargetRef) : null;
  if (!raw.startsWith("note:")) return null;
  const path = raw.slice(5);
  if (path.length === 0 || path.length > NOTE_PATH_CHARS || !path.endsWith(".md") || hasControl(path, false))
    return null;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\"))) return null;
  return raw as TargetRef;
}

const kindOf = (target: TargetRef): "view" | "note" | "project" =>
  target === PROJECT_TARGET ? "project" : target.startsWith("view:") ? "view" : "note";

// ----------------------------------------------------------- validation

const COMMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES: readonly ThreadStatus[] = ["draft", "sent", "read", "answered", "resolved"];

function comment(value: unknown, where: string): Comment {
  if (!isObject(value)) throw new Bad(`${where} must be an object`);
  only(value, ["id", "author", "body", "createdAt", "editedAt", "context"], where);
  const id = text(value["id"], `${where}.id`);
  if (!COMMENT_ID.test(id)) throw new Bad(`${where}.id is not a comment id`);
  const author = value["author"];
  if (author !== "person" && author !== "agent") throw new Bad(`${where}.author must be "person" or "agent"`);
  const createdAt = text(value["createdAt"], `${where}.createdAt`);
  const editedAt = value["editedAt"] === undefined ? undefined : text(value["editedAt"], `${where}.editedAt`);
  if (value["context"] !== undefined && author !== "person")
    throw new Bad(`${where}.context belongs to the person's comments; the agent's have none`);
  const context = value["context"] === undefined ? undefined : commentContext(value["context"], `${where}.context`);
  return {
    id,
    author,
    body: body(value["body"], `${where}.body`),
    createdAt,
    ...(editedAt === undefined ? {} : { editedAt }),
    ...(context === undefined ? {} : { context }),
  };
}

/** Whether an anchor needs a version-3 file: a walkthrough or step anchor, or an element anchor with a context. */
const usesVersion3 = (a: Anchor): boolean =>
  a.kind === "walkthrough" || a.kind === "step" || ("context" in a && a.context !== undefined);
/** Whether a thread needs a version-4 file: the project conversation, or a person's comment context (ADR 0034 §10). */
const usesVersion4 = (t: Thread): boolean =>
  t.target === PROJECT_TARGET || t.anchor.kind === "project" || t.comments.some((c) => c.context !== undefined);

/** The version a file with these threads is written as: the lowest that holds them (ADR 0034 §9, §10). */
export const versionFor = (threads: readonly Thread[], receipts?: ReceiptLedger): CommentsFile["version"] =>
  threads.some((t) => t.identity !== undefined)
    ? COMMENTS_SCOPED_IDENTITY_VERSION
    : receipts !== undefined || threads.some((t) => t.modelRevision !== undefined)
      ? COMMENTS_RECEIPTS_VERSION
      : threads.some(usesVersion4)
        ? COMMENTS_CONTEXT_VERSION
        : threads.some((t) => usesVersion3(t.anchor))
          ? COMMENTS_WALKTHROUGH_VERSION
          : COMMENTS_SCHEMA_VERSION;

/** A thread as `version` writes it, read as the current version's. */
function thread(value: unknown, where: string, version: CommentsFile["version"]): Thread {
  if (!isObject(value)) throw new Bad(`${where} must be an object`);
  only(
    value,
    version >= COMMENTS_RECEIPTS_VERSION
      ? [
          "id",
          "target",
          "anchor",
          "status",
          "revision",
          "modelRevision",
          "changedAfterSubmit",
          "orphaned",
          "comments",
          ...(version === COMMENTS_SCOPED_IDENTITY_VERSION ? ["identity"] : []),
        ]
      : ["id", "target", "anchor", "status", "revision", "changedAfterSubmit", "orphaned", "comments"],
    where,
  );
  const modelRevision = value["modelRevision"];
  if (modelRevision !== undefined && (typeof modelRevision !== "string" || !MODEL_REVISION.test(modelRevision)))
    throw new Bad(`${where}.modelRevision is not a model revision`);
  const id = text(value["id"], `${where}.id`);
  if (!COMMENT_ID.test(id)) throw new Bad(`${where}.id is not a thread id`);
  const target = parseTarget(value["target"]);
  if (target === null) throw new Bad(`${where}.target is not a view:, note: or project: reference`);
  let parsedAnchor: Anchor;
  try {
    parsedAnchor = anchor(value["anchor"]);
  } catch (error) {
    throw new Bad(`${where}: ${(error as Error).message}`);
  }
  let identity: ScopedIdentity | undefined;
  if (value["identity"] !== undefined) {
    const raw = value["identity"];
    if (!isObject(raw)) throw new Bad(`${where}.identity must be an object`);
    only(raw, ["version", "fingerprint", "unique"], `${where}.identity`);
    if (
      raw["version"] !== 1 ||
      typeof raw["fingerprint"] !== "string" ||
      !MODEL_REVISION.test(raw["fingerprint"]) ||
      typeof raw["unique"] !== "boolean"
    )
      throw new Bad(`${where}.identity requires version 1, a sha256 fingerprint and a unique boolean`);
    if (!target.startsWith("view:") || (parsedAnchor.kind !== "group" && parsedAnchor.kind !== "node"))
      throw new Bad(`${where}.identity belongs only to a scoped diagram anchor`);
    identity = { version: 1, fingerprint: raw["fingerprint"], unique: raw["unique"] };
  }
  const raw = value["status"];
  const status = STATUSES.find((s) => s === raw);
  if (status === undefined) throw new Bad(`${where}.status must be draft, sent, read, answered or resolved`);
  const revision = value["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
    throw new Bad(`${where}.revision must be a whole number from 1`);
  const flags: { changedAfterSubmit?: boolean; orphaned?: boolean } = {};
  for (const flag of ["changedAfterSubmit", "orphaned"] as const) {
    const v = value[flag];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw new Bad(`${where}.${flag} must be true or false`);
    if (v) flags[flag] = true;
  }
  if (identity?.unique === false && flags.orphaned !== true)
    throw new Bad(`${where}.identity is ambiguous and requires orphaned: true`);
  const list = value["comments"];
  if (!Array.isArray(list) || list.length === 0)
    throw new Bad(`${where}.comments must be a list of at least one comment`);
  const comments = list.map((c, i) => comment(c, `${where}.comments[${i}]`));
  // The agent may open a thread in the answered state; later person replies move
  // that same thread through the ordinary draft -> sent -> read loop.
  if (comments[0]?.author === "agent" && comments.length === 1 && status !== "answered" && status !== "resolved")
    throw new Bad(`${where} was opened by the agent but has no person reply for its ${status} status`);
  if (status === "answered" && comments.at(-1)?.author !== "agent")
    throw new Bad(`${where} is answered but its latest comment is not from the agent`);
  if (new Set(comments.map((c) => c.id)).size !== comments.length)
    throw new Bad(`${where} has two comments with one id`);
  return {
    id,
    target,
    anchor: parsedAnchor,
    status,
    revision,
    ...(modelRevision === undefined ? {} : { modelRevision: modelRevision as string }),
    ...(identity === undefined ? {} : { identity }),
    ...flags,
    comments,
  };
}

const MODEL_REVISION = /^sha256:[0-9a-f]{64}$/;
/** A new thread's `modelRevision`: the view's compiled model now, when it has one. */
const modelRevisionOf = (subject: Subject): { modelRevision?: string } =>
  subject.kind === "view" && subject.modelRevision !== undefined && MODEL_REVISION.test(subject.modelRevision)
    ? { modelRevision: subject.modelRevision }
    : {};

function identityOf(given: Anchor, subject: Subject): Pick<Thread, "identity" | "orphaned"> {
  if (subject.kind !== "view" || (given.kind !== "node" && given.kind !== "group")) return {};
  const entry = subject.scopedIdentities?.get(`${given.kind}:${given.id}`);
  if (entry === undefined) return {};
  const identity: ScopedIdentity = { version: 1, fingerprint: entry.fingerprint, unique: entry.unique };
  return { identity, ...(identity.unique ? {} : { orphaned: true }) };
}

/** Positional anchors resolve only through their saved semantic identity. */
function scopedNow(t: Thread, subject: Subject): Partial<Thread> | null {
  if (subject.kind !== "view" || (t.anchor.kind !== "group" && t.anchor.kind !== "node")) return null;
  // Only legacy group anchors may acquire metadata, on their exact creation revision.
  if (t.identity === undefined && (t.anchor.kind !== "group" || subject.scopedIdentities === undefined)) return null;
  const entries = subject.scopedIdentities;
  if (entries == null) return { orphaned: true };
  let identity = t.identity;
  if (identity === undefined) {
    if (t.modelRevision === undefined || t.modelRevision !== subject.modelRevision) return { orphaned: true };
    identity = identityOf(t.anchor, subject).identity;
    if (identity === undefined) return { orphaned: true };
  }
  if (!identity.unique) return { identity, orphaned: true };
  const prefix = `${t.anchor.kind}:`;
  const matches = [...entries].filter(
    ([key, entry]) => key.startsWith(prefix) && entry.fingerprint === identity.fingerprint,
  );
  if (matches.length !== 1)
    return { identity: matches.length > 1 ? { ...identity, unique: false } : identity, orphaned: true };
  const [key, entry] = matches[0]!;
  if (entry.refusal !== undefined) return { identity, orphaned: true };
  return { identity, anchor: { ...t.anchor, id: key.slice(prefix.length), label: entry.label }, orphaned: false };
}

function file(value: unknown): CommentsFile {
  if (!isObject(value)) throw new Bad("it is not a JSON object");
  const version = value["version"];
  if (
    version !== COMMENTS_SCHEMA_VERSION &&
    version !== COMMENTS_WALKTHROUGH_VERSION &&
    version !== COMMENTS_CONTEXT_VERSION &&
    version !== COMMENTS_RECEIPTS_VERSION &&
    version !== COMMENTS_SCOPED_IDENTITY_VERSION
  )
    throw new Bad(
      `its version is not ${COMMENTS_SCHEMA_VERSION}, ${COMMENTS_WALKTHROUGH_VERSION}, ${COMMENTS_CONTEXT_VERSION}, ${COMMENTS_RECEIPTS_VERSION} or ${COMMENTS_SCOPED_IDENTITY_VERSION}`,
    );
  // Receipts only in version 5 (ADR 0016).
  only(
    value,
    version >= COMMENTS_RECEIPTS_VERSION
      ? ["version", "target", "threads", "receipts"]
      : ["version", "target", "threads"],
    "the file",
  );
  let receipts: ReceiptLedger | undefined;
  if (version >= COMMENTS_RECEIPTS_VERSION && value["receipts"] !== undefined) {
    try {
      receipts = readLedger(value["receipts"]);
    } catch (error) {
      if (error instanceof ReceiptShapeError) throw new Bad(error.message);
      throw error;
    }
  }
  const target = parseTarget(value["target"]);
  if (target === null) throw new Bad("its target is not a view:, note: or project: reference");
  const list = value["threads"];
  if (!Array.isArray(list)) throw new Bad("its threads are not a list");
  const threads = list.map((t, i) => thread(t, `threads[${i}]`, version));
  if (version === COMMENTS_SCOPED_IDENTITY_VERSION && !threads.some((t) => t.identity !== undefined))
    throw new Bad("version 6 is only for a file holding scoped comment identity metadata");
  if (new Set(threads.map((t) => t.id)).size !== threads.length) throw new Bad("two threads have one id");
  return receipts === undefined
    ? { version: versionFor(threads), target, threads }
    : { version: versionFor(threads, receipts), target, threads, receipts };
}

/** The additive publication selector; no selector retains the bulk send behavior. */
export function readSubmitRequest(raw: unknown): { target?: TargetRef; threadId?: string } {
  if (raw === undefined) return {};
  if (!isObject(raw) || Object.keys(raw).some((key) => key !== "target" && key !== "threadId"))
    throw new CommentsError("invalid_comment", "submit takes an optional target and threadId");
  const target = raw["target"] === undefined ? undefined : parseTarget(raw["target"]);
  if (target === null)
    throw new CommentsError(
      "invalid_comment",
      'a target is "view:<view id>", "note:<path of a .md in the Archer folder>" or "project:"',
    );
  const threadId = raw["threadId"];
  if (threadId !== undefined && (typeof threadId !== "string" || !COMMENT_ID.test(threadId)))
    throw new CommentsError(
      "invalid_comment",
      "threadId must be a thread ID (letters, digits, underscores or hyphens, at most 64 characters)",
    );
  return {
    ...(target === undefined ? {} : { target }),
    ...(threadId === undefined ? {} : { threadId: threadId as string }),
  };
}

/** A comments file's content, checked against the contract. */
export function validateCommentsFile(raw: unknown): { ok: true; file: CommentsFile } | { ok: false; problem: string } {
  try {
    return { ok: true, file: file(raw) };
  } catch (error) {
    if (error instanceof Bad) return { ok: false, problem: error.message };
    throw error;
  }
}

const invalid = (error: unknown): never => {
  if (error instanceof Bad) throw new CommentsError("invalid_comment", error.message);
  throw error;
};

/** A new thread as the page posts it: its shape only; the target and anchor are checked against the project by `create`. */
export function readNewThread(raw: unknown): NewThread {
  try {
    if (!isObject(raw)) throw new Bad("a new thread is an object with a target, an anchor and a body");
    only(raw, ["target", "anchor", "body", "context", "expectedModelRevision"], "a new thread");
    const target = parseTarget(raw["target"]);
    if (target === null)
      throw new Bad('the target must be "view:<view id>", "note:<path of a .md in the Archer folder>" or "project:"');
    return {
      target,
      anchor: anchor(raw["anchor"], true),
      body: body(raw["body"]),
      ...(raw["context"] === undefined ? {} : { context: commentContext(raw["context"], "the context") }),
      ...(raw["expectedModelRevision"] === undefined
        ? {}
        : { expectedModelRevision: creationRevision(raw["expectedModelRevision"])! }),
    };
  } catch (error) {
    return invalid(error);
  }
}

function creationRevision(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !MODEL_REVISION.test(raw))
    throw new Bad("expectedModelRevision must be a sha256 model revision");
  return raw;
}

export function requireCreationRevision(expected: string | undefined, subject: Subject): void {
  if (expected !== undefined && (subject.kind !== "view" || subject.modelRevision !== expected))
    throw new CommentsError(
      "write_conflict",
      "the diagram changed while this comment was open; reopen the comment on the intended block",
    );
}

// -------------------------------------------------------------- anchors

/** Context disambiguates a surviving quote; changing context does not orphan it. */
function found(passage: Extract<Anchor, { kind: "passage" }>, text: string): boolean {
  return locatePassage(renderedNoteText(text), passage) !== null;
}

/** The anchor as the target holds it now (`shared/comment-grounding.mts`), passages matched in the rendered note. */
const ground = (target: TargetRef, given: Anchor, subject: Subject): Anchor => groundIn(target, given, subject, found);

/** Whether the anchor still names something, and its labels refreshed where it does. Null when it cannot be told. */
function anchorNow(given: Anchor, subject: Subject): { anchor: Anchor; orphaned: boolean } | null {
  if (given.kind === "view" || given.kind === "project") return { anchor: given, orphaned: false };
  if (subject.kind === "project") return null;
  if (subject.kind === "note") {
    if (given.kind !== "passage" || subject.text === null) return null;
    return { anchor: given, orphaned: !found(given, subject.text) };
  }
  if (given.kind === "passage") return null;
  if (given.kind === "walkthrough" || given.kind === "step") {
    if (subject.walkthroughs === undefined || subject.walkthroughs === null) return null;
    const now = walkthroughSubjectNow(given, subject.walkthroughs);
    return typeof now === "string" ? { anchor: given, orphaned: true } : { anchor: now, orphaned: false };
  }
  const elements = subject.elements;
  if (elements === null) return null;
  let gone = false;
  const relabel = (kind: string, e: { id: string; label: string }) => {
    const label = elements.get(`${kind}:${e.id}`);
    if (label === undefined) gone = true;
    return { id: e.id, label: label ?? e.label };
  };
  if (given.kind === "selection") {
    const nodes = given.nodes.map((n) => relabel("node", n));
    const edges = given.edges.map((e) => relabel("edge", e));
    return {
      anchor: { kind: "selection", nodes, edges, ...(given.context === undefined ? {} : { context: given.context }) },
      orphaned: gone,
    };
  }
  const { label } = relabel(given.kind, given);
  return {
    anchor: {
      kind: given.kind,
      id: given.id,
      label,
      ...(given.context === undefined ? {} : { context: given.context }),
    },
    orphaned: gone,
  };
}

// --------------------------------------------------------------- threads

/** A thread rebuilt with fields in the contract's order, flags present only when true. */
function make(
  t: Thread,
  changes: Partial<
    Pick<
      Thread,
      "anchor" | "status" | "revision" | "changedAfterSubmit" | "orphaned" | "comments" | "target" | "identity"
    >
  >,
): Thread {
  const next = { ...t, ...changes };
  return {
    id: next.id,
    target: next.target,
    anchor: next.anchor,
    status: next.status,
    revision: next.revision,
    ...(next.modelRevision === undefined ? {} : { modelRevision: next.modelRevision }),
    ...(next.identity === undefined ? {} : { identity: next.identity }),
    ...(next.changedAfterSubmit === true ? { changedAfterSubmit: true } : {}),
    ...(next.orphaned === true ? { orphaned: true } : {}),
    comments: next.comments,
  };
}

/** What a person's edit, deletion or reply does to a thread: a draft again, at the next revision. */
function touched(t: Thread, reply: boolean): Pick<Thread, "status" | "revision" | "changedAfterSubmit"> {
  const revision = t.revision + 1;
  if (t.status === "draft") return { status: "draft", revision, changedAfterSubmit: t.changedAfterSubmit === true };
  if (reply && (t.status === "answered" || t.status === "resolved"))
    return { status: "draft", revision, changedAfterSubmit: t.changedAfterSubmit === true };
  return { status: "draft", revision, changedAfterSubmit: true };
}

/** What the agent may answer or resolve: a thread at the revision it read, sent to it and not resolved (resolving again is allowed). */
function agentMay(t: Thread, expectedRevision: number, what: "reply to" | "resolve"): void {
  if (t.revision !== expectedRevision) {
    const now = t.comments.map((c) => `- ${c.author} (${c.id}): ${JSON.stringify(c.body)}`).join("\n");
    const next =
      t.status === "draft"
        ? "It is a draft again: the person has not sent the new text yet, so leave it until they do and call get_comments then."
        : `Read the new text below, then ${what} it with expectedRevision ${t.revision}.`;
    throw new CommentsError(
      "thread_changed",
      `thread ${t.id} changed since you read it (revision ${expectedRevision}; it is now revision ${t.revision}, ${t.status}), so nothing was done. ${next}\n${now}`,
      { threadId: t.id, revision: t.revision, status: t.status, comments: t.comments },
    );
  }
  if (t.status === "draft") throw notAwaiting(t, what);
  if (t.status === "resolved" && what === "reply to")
    throw new CommentsError(
      "thread_not_awaiting",
      `thread ${t.id} is resolved, so the agent cannot reply to it; the person sees it as done until they dismiss it`,
    );
}

/** A request's context, checked; only the person's comments have one. */
function contextFor(author: Author, raw: unknown): CommentContext | undefined {
  if (raw === undefined) return undefined;
  if (author !== "person") throw new Bad("the agent's comments carry no context");
  return commentContext(raw, "the context");
}

// ---------------------------------------------------------------- store

/** A transaction's change: the threads (and, for an operation, the receipts) it leaves, and what it answers. */
type Change<T> = (
  threads: readonly Thread[],
  fileTarget: TargetRef,
  receipts: ReceiptLedger | undefined,
) => { threads: readonly Thread[]; value: T; receipts?: ReceiptLedger };

type Read =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly file: CommentsFile; readonly bytes: Buffer }
  | { readonly kind: "malformed"; readonly problem: string };

export class CommentsStore {
  readonly #now: () => string;
  readonly #newId: (prefix: "t" | "c") => string;
  readonly #clock: () => number;

  constructor(
    readonly project: Project,
    options: StoreOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? ((prefix) => `${prefix}-${randomBytes(6).toString("hex")}`);
    this.#clock = options.clock ?? (() => Date.now());
  }

  /**
   * Every comments file in the Archer folder, folder-relative and sorted: the project conversation's, then
   * the sidecars. Other names starting with "." are skipped, as are links.
   */
  files(): string[] {
    const folder = this.project.folder;
    if (!existsSync(folder)) return [];
    const found: string[] = [];
    try {
      if (lstatSync(join(folder, PROJECT_COMMENTS_PATH)).isFile()) found.push(PROJECT_COMMENTS_PATH);
    } catch {
      // None yet.
    }
    const pending: [string, string][] = [[folder, ""]];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [dir, prefix] = next;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) pending.push([join(dir, entry.name), rel]);
        else if (entry.isFile() && entry.name.endsWith(COMMENTS_SUFFIX)) found.push(rel);
      }
    }
    return found.sort();
  }

  /** A target's threads. Only where they live is needed: the subject is for checking new anchors. */
  list(place: PlaceRef): ThreadList {
    return { schemaVersion: COMMENTS_SCHEMA_VERSION, target: place.target, threads: this.#readFor(place) ?? [] };
  }

  /** A new draft thread. The anchor and body are checked again here, whoever parsed them before. */
  create(place: Place, input: NewThreadInput): Changed<Thread> {
    return this.#create(place, input, "person", "draft");
  }

  /** A thread opened by the agent, already answered and awaiting the person's response. */
  createByAgent(place: Place, input: NewThreadInput): Changed<Thread> {
    return this.#create(place, input, "agent", "answered");
  }

  #create(place: Place, input: NewThreadInput, author: Author, status: "draft" | "answered"): Changed<Thread> {
    let grounded: Anchor;
    let text: string;
    let context: CommentContext | undefined;
    try {
      text = body(input.body);
      context = contextFor(author, input.context);
      requireCreationRevision(creationRevision(input.expectedModelRevision), place.subject);
      grounded = ground(place.target, anchor(input.anchor, true), place.subject);
    } catch (error) {
      return invalid(error);
    }
    const value = this.#update(place.path, place.target, (threads) => {
      if (threads.length >= MAX_THREADS_PER_TARGET)
        throw new CommentsError(
          "too_many_threads",
          `${place.target} already has ${threads.length} threads, the most one diagram or note keeps; resolve some first`,
        );
      const taken = new Set(threads.map((t) => t.id));
      const created: Thread = {
        id: this.#fresh("t", taken),
        target: place.target,
        anchor: grounded,
        status,
        revision: 1,
        ...modelRevisionOf(place.subject),
        ...identityOf(grounded, place.subject),
        comments: [
          {
            id: this.#fresh("c", new Set()),
            author,
            body: text,
            createdAt: this.#now(),
            ...(context === undefined ? {} : { context }),
          },
        ],
      };
      return { threads: [...threads, created], value: created };
    });
    return { value, target: place.target, path: place.path };
  }

  /**
   * The person's new thread, sent as an operation (ADR 0016): created once, with its receipt in the same
   * file write; the same operation again answers that receipt and changes nothing, even after a restart or
   * once the thread is gone. `realm` is who sent it (the owner's sign-in or one grant), bound into the digest.
   */
  createOnce(
    place: Place,
    rawOperation: unknown,
    input: NewThreadInput,
    realm: string,
    beforeCreate?: () => void,
  ): Changed<OperationOutcome> {
    let operation: CommentOperation,
      given: Anchor,
      expectedModelRevision: string | undefined,
      text: string,
      context: CommentContext | undefined,
      digest: string;
    try {
      operation = this.#operation(rawOperation, "comment.create", place.target);
      text = body(input.body);
      context = contextFor("person", input.context);
      given = anchor(input.anchor, true);
      expectedModelRevision = creationRevision(input.expectedModelRevision);
      digest = operationDigest(operation, realm, {
        target: place.target,
        anchor: given,
        body: text,
        context,
        ...(expectedModelRevision === undefined ? {} : { expectedModelRevision }),
      });
    } catch (error) {
      return invalid(error);
    }
    const value = this.#update(
      place.path,
      place.target,
      (
        threads,
        _target,
        receipts,
      ): { threads: readonly Thread[]; value: OperationOutcome; receipts?: ReceiptLedger } => {
        const admission = admit(receipts, operation, digest, this.#clock(), refuseOperation);
        if (admission.kind === "replay") return { threads, value: replayOf(operation, admission.receipt) };
        requireCreationRevision(expectedModelRevision, place.subject);
        let grounded: Anchor;
        try {
          grounded = ground(place.target, given, place.subject);
        } catch (error) {
          return invalid(error);
        }
        if (threads.length >= MAX_THREADS_PER_TARGET)
          throw new CommentsError(
            "too_many_threads",
            `${place.target} already has ${threads.length} threads, the most one diagram or note keeps; resolve some first`,
          );
        beforeCreate?.();
        const committedAt = this.#now();
        const created: Thread = {
          id: this.#fresh("t", new Set(threads.map((t) => t.id))),
          target: place.target,
          anchor: grounded,
          status: "draft",
          revision: 1,
          ...modelRevisionOf(place.subject),
          ...identityOf(grounded, place.subject),
          comments: [
            {
              id: this.#fresh("c", new Set()),
              author: "person",
              body: text,
              createdAt: committedAt,
              ...(context === undefined ? {} : { context }),
            },
          ],
        };
        const committed = {
          threadId: created.id,
          commentId: created.comments[0]!.id,
          revision: created.revision,
          committedAt,
        };
        return {
          threads: [...threads, created],
          value: { replayed: false, operation, committed },
          receipts: admission.record(committed),
        };
      },
    );
    return { value, target: place.target, path: place.path };
  }

  /**
   * The person's reply, sent as an operation (ADR 0016). The operation names its target, so a repeat is
   * answered from that target's receipts even when the thread has been resolved since.
   */
  replyOnce(
    place: PlaceRef,
    threadId: string,
    rawOperation: unknown,
    raw: unknown,
    rawContext: unknown,
    realm: string,
  ): Changed<OperationOutcome> {
    let operation: CommentOperation, text: string, context: CommentContext | undefined, digest: string;
    try {
      operation = this.#operation(rawOperation, "comment.reply", place.target);
      text = body(raw, "the reply");
      context = contextFor("person", rawContext);
      digest = operationDigest(operation, realm, { threadId, body: text, context });
    } catch (error) {
      return invalid(error);
    }
    const value = this.#update(
      place.path,
      place.target,
      (
        threads,
        _target,
        receipts,
      ): { threads: readonly Thread[]; value: OperationOutcome; receipts?: ReceiptLedger } => {
        const admission = admit(receipts, operation, digest, this.#clock(), refuseOperation);
        if (admission.kind === "replay") return { threads, value: replayOf(operation, admission.receipt) };
        const t = threads.find((x) => x.id === threadId);
        if (t === undefined)
          throw new CommentsError(
            "thread_not_found",
            `no thread ${JSON.stringify(threadId.slice(0, 64))} on ${place.target}; it may have been resolved`,
          );
        const committedAt = this.#now();
        const added: Comment = {
          id: this.#fresh("c", new Set(t.comments.map((c) => c.id))),
          author: "person",
          body: text,
          createdAt: committedAt,
          ...(context === undefined ? {} : { context }),
        };
        const updated = make(t, { ...touched(t, true), comments: [...t.comments, added] });
        const committed = { threadId: t.id, commentId: added.id, revision: updated.revision, committedAt };
        return {
          threads: threads.map((x) => (x.id === threadId ? updated : x)),
          value: { replayed: false, operation, committed },
          receipts: admission.record(committed),
        };
      },
    );
    return { value, target: place.target, path: place.path };
  }

  #operation(raw: unknown, name: CommentOperation["name"], target: TargetRef): CommentOperation {
    let operation: CommentOperation;
    try {
      operation = readOperation(raw, name, parseTarget);
    } catch (error) {
      if (error instanceof ReceiptShapeError) throw new CommentsError("invalid_operation", error.message);
      throw error;
    }
    if (operation.target !== target)
      throw new CommentsError("invalid_operation", "the operation names another target than its request");
    return operation;
  }

  /** A reply in a thread. The agent answers only a thread sent to it, at the revision it read. */
  reply(
    threadId: string,
    raw: unknown,
    author: "person",
    expectedRevision?: undefined,
    rawContext?: unknown,
  ): Changed<Thread>;
  reply(threadId: string, raw: unknown, author: "agent", expectedRevision: number): Changed<Thread>;
  reply(
    threadId: string,
    raw: unknown,
    author: Author,
    expectedRevision?: number,
    rawContext?: unknown,
  ): Changed<Thread> {
    let text: string;
    let context: CommentContext | undefined;
    try {
      text = body(raw, "the reply");
      context = contextFor(author, rawContext);
    } catch (error) {
      return invalid(error);
    }
    return this.#onThread(threadId, (t) => {
      if (author === "agent") agentMay(t, expectedRevision ?? 0, "reply to");
      const added: Comment = {
        id: this.#fresh("c", new Set(t.comments.map((c) => c.id))),
        author,
        body: text,
        createdAt: this.#now(),
        ...(context === undefined ? {} : { context }),
      };
      const comments = [...t.comments, added];
      if (author === "agent") return make(t, { status: "answered", changedAfterSubmit: false, comments });
      return make(t, { ...touched(t, true), comments });
    });
  }

  /**
   * The person's edit of one of their own comments. Given `expectedRevision` (the thread's revision the page last
   * saw, O124), an edit of a thread that moved past it is refused with `thread_changed` and the thread as it is now;
   * asking for the text the comment already reads is no change whatever the revision.
   */
  edit(threadId: string, commentId: string, raw: unknown, expectedRevision?: number): Changed<Thread> {
    let text: string;
    try {
      text = body(raw);
    } catch (error) {
      return invalid(error);
    }
    return this.#onThread(threadId, (t) => {
      const at = ownComment(t, commentId, "edited");
      if (t.comments[at]?.body === text) return t;
      if (expectedRevision !== undefined && t.revision !== expectedRevision)
        throw new CommentsError(
          "thread_changed",
          `thread ${t.id} changed since the page read it (revision ${expectedRevision}; it is now revision ${t.revision}), so the edit was not saved`,
          { threadId: t.id, revision: t.revision, status: t.status, comments: t.comments },
        );
      const comments = t.comments.map((c, i) => (i === at ? { ...c, body: text, editedAt: this.#now() } : c));
      return make(t, { ...touched(t, false), comments });
    });
  }

  /** The person's deletion of one of their own comments; the first, with no replies after it, takes the thread with it. */
  remove(threadId: string, commentId: string): Changed<Thread | { deleted: true }> {
    let deleted = false;
    const changed = this.#onThread(threadId, (t) => {
      const at = ownComment(t, commentId, "deleted");
      if (at === 0) {
        if (t.comments.length > 1)
          throw new CommentsError(
            "has_replies",
            "the thread's first comment has replies after it; resolve the thread to remove it all",
          );
        deleted = true;
        return null;
      }
      const comments = t.comments.filter((_, i) => i !== at);
      if (comments[0]?.author === "agent" && !comments.some((comment) => comment.author === "person"))
        return make(t, { status: "answered", revision: t.revision + 1, changedAfterSubmit: false, comments });
      return make(t, { ...touched(t, false), comments });
    });
    return deleted ? { ...changed, value: { deleted: true } } : (changed as Changed<Thread>);
  }

  /**
   * The person's resolve removes the thread at once. The agent's keeps it as
   * `resolved` for the person to dismiss, and only at the revision it read.
   */
  resolve(threadId: string, by: "person"): Changed<{ resolved: true }>;
  resolve(threadId: string, by: "agent", expectedRevision: number): Changed<{ resolved: true }>;
  resolve(threadId: string, by: Author, expectedRevision?: number): Changed<{ resolved: true }> {
    const changed = this.#onThread(threadId, (t) => {
      if (by === "person") return null;
      agentMay(t, expectedRevision ?? 0, "resolve");
      return make(t, { status: "resolved", changedAfterSubmit: false });
    });
    return { ...changed, value: { resolved: true } };
  }

  /** The person dismisses a thread the agent resolved: it is removed. */
  dismiss(threadId: string): Changed<{ dismissed: true }> {
    const changed = this.#onThread(threadId, (t) => {
      if (t.status !== "resolved")
        throw new CommentsError(
          "thread_not_resolved",
          `thread ${t.id} is ${t.status}, not resolved by the agent; resolve it to remove it`,
        );
      return null;
    });
    return { ...changed, value: { dismissed: true } };
  }

  /** Sends drafts to the agent: one thread, one target, or every target. Bulk sends report malformed files. */
  submit(
    target?: TargetRef,
    threadId?: string,
  ): { submitted: number; changed: { target: TargetRef; path: string }[]; problems: string[] } {
    if (threadId !== undefined) {
      let submitted = 0;
      const changed = this.#onThread(threadId, (thread, fileTarget) => {
        if (thread.target !== fileTarget || (target !== undefined && fileTarget !== target))
          throw new CommentsError("thread_not_found", "the requested thread does not belong to this target");
        submitted = thread.status === "draft" ? 1 : 0;
        return submitted === 1 ? make(thread, { status: "sent" }) : thread;
      });
      return {
        submitted,
        changed: submitted === 1 ? [{ target: changed.target, path: changed.path }] : [],
        problems: [],
      };
    }
    let submitted = 0;
    const changed: { target: TargetRef; path: string }[] = [];
    const problems: string[] = [];
    for (const path of this.files()) {
      const read = this.#read(path);
      if (read.kind === "malformed") {
        problems.push(read.problem);
        continue;
      }
      if (read.kind !== "ok" || (target !== undefined && read.file.target !== target)) continue;
      const count = this.#update(path, null, (threads) => {
        let n = 0;
        const next = threads.map((t) => {
          if (t.status !== "draft") return t;
          n++;
          return make(t, { status: "sent" });
        });
        return { threads: next, value: n };
      });
      if (count > 0) {
        submitted += count;
        changed.push({ target: read.file.target, path });
      }
    }
    return { submitted, changed, problems };
  }

  /**
   * A submit sent as an operation (ADR 0016, O83): every draft, one target's, or one thread. Each file it
   * changes gets the submit's receipt, with that file's count, in the same write as the effect. Sent again,
   * a file holding the receipt answers its count and changes nothing; a file without one is submitted as
   * usual, so a first try that committed only some files completes. Refusals (another payload under the id,
   * expiry, a full ledger) are checked against every file first, so none leaves a partial effect.
   */
  submitOnce(
    target: TargetRef | undefined,
    threadId: string | undefined,
    rawOperation: unknown,
    realm: string,
  ): SubmitOutcome {
    let operation: SubmitOperation;
    try {
      operation = readSubmitOperation(rawOperation);
    } catch (error) {
      if (error instanceof ReceiptShapeError) throw new CommentsError("invalid_operation", error.message);
      throw error;
    }
    const digest = operationDigest(operation, realm, { target: target ?? null, threadId: threadId ?? null });
    const problems: string[] = [];
    const candidates: { path: string; receipts: ReceiptLedger | undefined }[] = [];
    for (const path of this.files()) {
      const read = this.#read(path);
      if (read.kind === "malformed") {
        problems.push(read.problem);
        continue;
      }
      if (read.kind !== "ok" || (target !== undefined && read.file.target !== target)) continue;
      const held = read.file.receipts?.entries.some((r) => r.id === operation.id) === true;
      const sends = read.file.threads.some(
        (t) => t.status === "draft" && (threadId === undefined || t.id === threadId),
      );
      const holds = threadId !== undefined && read.file.threads.some((t) => t.id === threadId);
      if (held || sends || holds) candidates.push({ path, receipts: read.file.receipts });
    }
    // Every refusal before any effect (a full ledger, expiry, another payload under this id).
    for (const c of candidates) admit(c.receipts, operation, digest, this.#clock(), refuseOperation);
    let submitted = 0,
      replayed = false;
    const changed: { target: TargetRef; path: string }[] = [];
    for (const { path } of candidates) {
      let fileTarget: TargetRef | undefined;
      const sent = this.#update(
        path,
        null,
        (
          threads,
          at,
          receipts,
        ): { threads: readonly Thread[]; value: number | { replayed: number }; receipts?: ReceiptLedger } => {
          fileTarget = at;
          const admission = admit(receipts, operation, digest, this.#clock(), refuseOperation);
          if (admission.kind === "replay")
            return {
              threads,
              value: { replayed: admission.receipt.operation === "comment.submit" ? admission.receipt.submitted : 0 },
            };
          let n = 0;
          const next = threads.map((t) => {
            if (t.status !== "draft" || (threadId !== undefined && t.id !== threadId)) return t;
            n++;
            return make(t, { status: "sent" });
          });
          return n === 0
            ? { threads, value: 0 }
            : { threads: next, value: n, receipts: admission.record({ submitted: n, committedAt: this.#now() }) };
        },
      );
      if (typeof sent === "object") {
        replayed = true;
        submitted += sent.replayed;
      } else if (sent > 0) {
        submitted += sent;
        changed.push({ target: fileTarget!, path });
      }
    }
    if (threadId !== undefined && candidates.length === 0)
      throw new CommentsError(
        "thread_not_found",
        `no thread ${JSON.stringify(threadId.slice(0, 64))}${target === undefined ? "" : ` on ${target}`}; it may have been resolved`,
      );
    return { operation, replayed, submitted, changed, problems };
  }

  /**
   * What the agent fetches: sent threads and read ones it has not answered,
   * every target's or one target's; the files it changed; and every comments
   * file that could not be read. "Read by the agent" means the checkout's
   * listener fetched it (ADR 0035 §7): only `asListener` moves sent threads to
   * read; any other session's fetch leaves them sent.
   */
  fetchForAgent(
    target?: TargetRef,
    { asListener = false }: { readonly asListener?: boolean } = {},
  ): {
    threads: Thread[];
    changed: { target: TargetRef; path: string }[];
    problems: string[];
    relatedTargets?: { target: TargetRef; awaitingThreads: number }[];
    relatedTargetsTruncated?: boolean;
  } {
    const threads: Thread[] = [];
    const changed: { target: TargetRef; path: string }[] = [];
    const problems: string[] = [];
    const notePath = target?.startsWith("note:") ? target.slice(5) : undefined;
    const related = new Map<TargetRef, number>();
    let relatedTargetsTruncated = false;
    for (const path of this.files()) {
      const read = this.#read(path);
      if (read.kind === "malformed") problems.push(read.problem);
      if (read.kind !== "ok") continue;
      // Observe validated sidecars in this existing scan. Related feedback is
      // only a hint: it is neither returned nor moved from sent to read here.
      if (
        notePath !== undefined &&
        read.file.target.startsWith("view:") &&
        parseDiagramAddress(read.file.target.slice(5))?.notePath === notePath
      ) {
        const awaiting = read.file.threads.filter((t) => t.status === "sent" || t.status === "read").length;
        if (awaiting > 0) {
          if (related.has(read.file.target) || related.size < 5)
            related.set(read.file.target, (related.get(read.file.target) ?? 0) + awaiting);
          else relatedTargetsTruncated = true;
        }
      }
      if (target !== undefined && read.file.target !== target) continue;
      if (!read.file.threads.some((t) => t.status === "sent" || t.status === "read")) continue;
      if (!asListener) {
        threads.push(
          ...read.file.threads
            .filter((t) => t.status === "sent" || t.status === "read")
            .map((t) => (t.target === read.file.target ? t : make(t, { target: read.file.target }))),
        );
        continue;
      }
      const { awaiting, moved } = this.#update(path, null, (all) => {
        let count = 0;
        const next = all.map((t) => {
          if (t.status !== "sent") return t;
          count++;
          return make(t, { status: "read" });
        });
        return { threads: next, value: { awaiting: next.filter((t) => t.status === "read"), moved: count } };
      });
      threads.push(...awaiting);
      if (moved > 0) changed.push({ target: read.file.target, path });
    }
    return {
      threads,
      changed,
      problems,
      ...(notePath === undefined
        ? {}
        : {
            relatedTargets: [...related].map(([target, awaitingThreads]) => ({ target, awaitingThreads })),
            relatedTargetsTruncated,
          }),
    };
  }

  /**
   * What waits for the listener (ADR 0035 §7–8): every sent thread, in file order, and every comments file
   * that could not be read. `markRead` is the listener fetching them: they move to read, as one write per file.
   */
  waiting({ markRead }: { readonly markRead: boolean }): {
    threads: Thread[];
    changed: { target: TargetRef; path: string }[];
    problems: string[];
  } {
    const threads: Thread[] = [];
    const changed: { target: TargetRef; path: string }[] = [];
    const problems: string[] = [];
    for (const path of this.files()) {
      const read = this.#read(path);
      if (read.kind === "malformed") problems.push(read.problem);
      if (read.kind !== "ok" || !read.file.threads.some((t) => t.status === "sent")) continue;
      if (!markRead) {
        threads.push(...read.file.threads.filter((t) => t.status === "sent"));
        continue;
      }
      const taken = this.#update(path, null, (all) => {
        const next = all.map((t) => (t.status === "sent" ? make(t, { status: "read" }) : t));
        return { threads: next, value: next.filter((_, i) => all[i]?.status === "sent") };
      });
      threads.push(...taken);
      if (taken.length > 0) changed.push({ target: read.file.target, path });
    }
    return { threads, changed, problems };
  }

  /**
   * The listener received every waiting person comment of this thread (ADR 0035 §7, review decision 3):
   * sent becomes read, unless the person changed the thread since (its `revision` moved on). The file
   * changed, or null when nothing moved.
   */
  markRead(threadId: string, revision: number): { target: TargetRef; path: string } | null {
    for (const path of this.files()) {
      const read = this.#read(path);
      if (read.kind !== "ok" || !read.file.threads.some((t) => t.id === threadId)) continue;
      const moved = this.#update(path, null, (all) => {
        let changed = false;
        const next = all.map((t) => {
          if (t.id !== threadId || t.status !== "sent" || t.revision !== revision) return t;
          changed = true;
          return make(t, { status: "read" });
        });
        return { threads: next, value: changed };
      });
      return moved ? { target: read.file.target, path } : null;
    }
    return null;
  }

  /** One thread by id, read-only, from whichever comments file holds it; null when none does (or its file cannot be read). */
  find(threadId: string): Thread | null {
    for (const path of this.files()) {
      const read = this.#read(path);
      if (read.kind !== "ok") continue;
      const found = read.file.threads.find((t) => t.id === threadId);
      if (found !== undefined)
        return found.target === read.file.target ? found : make(found, { target: read.file.target });
    }
    return null;
  }

  /** How many drafts each comments file holds (files with none left out), and every file that could not be read. */
  pending(): { files: { target: TargetRef; path: string; drafts: number }[]; problems: string[] } {
    const files: { target: TargetRef; path: string; drafts: number }[] = [];
    const problems: string[] = [];
    for (const path of this.files()) {
      const read = this.#read(path);
      if (read.kind === "malformed") problems.push(read.problem);
      if (read.kind !== "ok") continue;
      const drafts = read.file.threads.filter((t) => t.status === "draft").length;
      if (drafts > 0) files.push({ target: read.file.target, path, drafts });
    }
    return { files, problems };
  }

  /** Marks threads whose anchor is gone as orphaned (keeping its last label) and clears the mark when it returns. True when the file changed. */
  reconcile(place: Place): boolean {
    let read: Read;
    try {
      read = this.#read(place.path);
    } catch {
      return false;
    }
    if (read.kind !== "ok" || kindOf(read.file.target) !== kindOf(place.target)) return false;
    return this.#update(place.path, place.target, (threads) => {
      let moved = false;
      const next = threads.map((t) => {
        const block = scopedNow(t, place.subject);
        if (block !== null) {
          const updated = make(t, block);
          if (JSON.stringify(updated) !== JSON.stringify(t)) moved = true;
          return updated;
        }
        const now = anchorNow(t.anchor, place.subject);
        if (now === null) return t;
        const updated = make(t, { anchor: now.anchor, orphaned: now.orphaned });
        if (JSON.stringify(updated) !== JSON.stringify(t)) moved = true;
        return updated;
      });
      return { threads: next, value: moved };
    });
  }

  // ------------------------------------------------------------ internals

  #fresh(prefix: "t" | "c", taken: ReadonlySet<string>): string {
    for (;;) {
      const id = this.#newId(prefix);
      if (!taken.has(id)) return id;
    }
  }

  #absolute(path: string): string {
    try {
      return resolveInFolder(this.project, path);
    } catch (error) {
      if (error instanceof ProjectError) throw new CommentsError("target_not_found", error.message);
      throw error;
    }
  }

  #read(path: string): Read {
    this.#absolute(path);
    let bytes: Buffer;
    try {
      // The confined seam (G6): no link followed, one name, read from the descriptor.
      bytes = readInFolder(this.project, path, MAX_COMMENTS_FILE_BYTES);
    } catch (error) {
      if (error instanceof ConfinedTooLarge)
        return {
          kind: "malformed",
          problem: `${this.#shown(path)} is over ${MAX_COMMENTS_FILE_BYTES} bytes and was not read`,
        };
      if (error instanceof ConfinedRefusal)
        return { kind: "malformed", problem: `${this.#shown(path)} was not read: ${error.message}` };
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return {
        kind: "malformed",
        problem: `${this.#shown(path)} is not JSON in UTF-8, so its comments cannot be read; fix or remove it`,
      };
    }
    const checked = validateCommentsFile(parsed);
    if (!checked.ok)
      return {
        kind: "malformed",
        problem: `${this.#shown(path)} cannot be read as comments: ${checked.problem}; fix or remove it`,
      };
    return { kind: "ok", file: checked.file, bytes };
  }

  #shown(path: string): string {
    return posix.join(this.project.folderSetting, path);
  }

  /** The place's threads, under its target (a file beside a renamed view is that view's), or null when there is no file. */
  #readFor(place: PlaceRef): Thread[] | null {
    const read = this.#read(place.path);
    if (read.kind === "missing") return null;
    if (read.kind === "malformed") throw new CommentsError("malformed_comments_file", read.problem);
    return this.#adopt(read.file, place.target, place.path);
  }

  #adopt(found: CommentsFile, target: TargetRef, path: string): Thread[] {
    if (kindOf(found.target) !== kindOf(target))
      throw new CommentsError(
        "comments_file_conflict",
        `${this.#shown(path)} holds the comments of ${found.target}, which shares its name with ${target}; rename one of them`,
      );
    return found.threads.map((t) => (t.target === target ? t : make(t, { target })));
  }

  /**
   * Reads the file at `path`, lets `change` compute its threads, and writes
   * them back unless nothing changed; no threads left removes the file. When
   * `target` is given the file is that target's (created if missing);
   * otherwise it must exist and keeps its own.
   */
  #update<T>(path: string, target: TargetRef | null, change: Change<T>): T {
    try {
      return withCommentsLock(this.project, path, () => this.#updateLocked(path, target, change));
    } catch (error) {
      // The lock's timing rides along as the cause, for diagnosis; it is not part of the reply.
      if (error instanceof CommentsLockError)
        throw new CommentsError("write_conflict", error.message, undefined, { cause: error });
      throw error;
    }
  }

  #updateLocked<T>(path: string, target: TargetRef | null, change: Change<T>): T {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const read = this.#read(path);
      if (read.kind === "malformed") throw new CommentsError("malformed_comments_file", read.problem);
      if (read.kind === "missing" && target === null)
        throw new CommentsError("thread_not_found", `${this.#shown(path)} is gone`);
      const fileTarget = target ?? (read as Extract<Read, { kind: "ok" }>).file.target;
      const threads = read.kind === "ok" ? this.#adopt(read.file, fileTarget, path) : [];
      const held = read.kind === "ok" ? read.file.receipts : undefined;
      const outcome = change(threads, fileTarget, held);
      // Every write keeps the file's receipts (ADR 0016); only an operation adds to them.
      const receipts = outcome.receipts ?? held;
      const next: CommentsFile =
        receipts === undefined
          ? { version: versionFor(outcome.threads), target: fileTarget, threads: [...outcome.threads] }
          : {
              version: versionFor(outcome.threads, receipts),
              target: fileTarget,
              threads: [...outcome.threads],
              receipts,
            };
      const before =
        read.kind === "ok" ? read.file : { version: COMMENTS_SCHEMA_VERSION, target: fileTarget, threads: [] };
      if (JSON.stringify(next) === JSON.stringify(before)) return outcome.value;
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > MAX_COMMENTS_FILE_BYTES)
        throw new CommentsError(
          "comments_file_too_large",
          `${this.#shown(path)} would be over ${MAX_COMMENTS_FILE_BYTES} bytes; resolve some threads first`,
        );
      // Another process may have written the file since it was read: start over on its version.
      const now = this.#rawBytes(path);
      const was = read.kind === "ok" ? read.bytes : null;
      if (!(now === null ? was === null : was !== null && now.equals(was))) continue;
      // A file with receipts is kept when its threads are gone: its receipts and floor still answer repeats.
      if (next.threads.length === 0 && receipts === undefined) {
        assertWriteAllowed(this.project.root, "comments");
        this.#absolute(path);
        removeInFolder(this.project, path);
      }
      // An operation is acknowledged only once its file and directory entry are synced (ADR 0016).
      else
        writeConfined(
          this.project,
          path,
          serialized,
          "comments",
          outcome.receipts === undefined ? {} : { syncDirectory: true },
        );
      return outcome.value;
    }
    throw new CommentsError(
      "write_conflict",
      `${this.#shown(path)} kept changing while it was being written; try again`,
    );
  }

  #rawBytes(path: string): Buffer | null {
    this.#absolute(path);
    try {
      return readInFolder(this.project, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Finds the thread in whichever comments file holds it, and replaces it with `change`'s result (null removes it). */
  #onThread(threadId: string, change: (t: Thread, target: TargetRef) => Thread | null): Changed<Thread> {
    let skipped = 0;
    for (const path of this.files()) {
      const read = this.#read(path);
      if (read.kind === "malformed") skipped++;
      if (read.kind !== "ok" || !read.file.threads.some((t) => t.id === threadId)) continue;
      let target: TargetRef = read.file.target;
      const value = this.#update(path, null, (threads, fileTarget) => {
        target = fileTarget;
        const t = threads.find((x) => x.id === threadId);
        if (t === undefined) throw new CommentsError("thread_not_found", `thread ${threadId} was resolved meanwhile`);
        const updated = change(t, fileTarget);
        const next =
          updated === null
            ? threads.filter((x) => x.id !== threadId)
            : threads.map((x) => (x.id === threadId ? updated : x));
        return { threads: next, value: updated ?? t };
      });
      return { value, target, path };
    }
    throw new CommentsError(
      "thread_not_found",
      `no thread ${JSON.stringify(threadId.slice(0, 64))}; it may have been resolved` +
        (skipped > 0 ? ` (${skipped} comments file(s) could not be read and were not searched)` : ""),
    );
  }
}

const refuseOperation = (code: ReceiptRefusal, message: string, details?: Readonly<Record<string, unknown>>): never => {
  throw new CommentsError(code, message, details);
};

const replayOf = (operation: CommentOperation, receipt: CommentReceipt): OperationOutcome => {
  // admit() replays only a receipt of the same operation name, so a create's or reply's carries its ids.
  if (receipt.operation === "comment.submit")
    throw new CommentsError(
      "operation_payload_mismatch",
      `operation ${operation.id} was already used for another request; nothing was done`,
    );
  return {
    replayed: true,
    operation,
    committed: {
      threadId: receipt.threadId,
      commentId: receipt.commentId,
      revision: receipt.revision,
      committedAt: receipt.committedAt,
    },
  };
};

function ownComment(t: Thread, commentId: string, what: "edited" | "deleted"): number {
  const at = t.comments.findIndex((c) => c.id === commentId);
  if (at < 0)
    throw new CommentsError(
      "comment_not_found",
      `thread ${t.id} has no comment ${JSON.stringify(commentId.slice(0, 64))}`,
    );
  if (t.comments[at]?.author !== "person")
    throw new CommentsError(
      "not_editable",
      `only the person's own comments can be ${what} here; this one is the agent's`,
    );
  return at;
}

function notAwaiting(t: Thread, what: string): CommentsError {
  return new CommentsError(
    "thread_not_awaiting",
    `thread ${t.id} is a draft the person has not sent${t.changedAfterSubmit === true ? " (they changed it after sending)" : ""}, so the agent cannot ${what} it yet; call get_comments after they send it`,
  );
}
