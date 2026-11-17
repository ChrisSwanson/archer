/**
 * A comment being written, kept in this browser as it is typed (user-flows G1; review flows-r1 claude-01, O82).
 *
 * The §6 promise list holds a reload and a closed and reopened tab in the same profile: the text, what it is about
 * (target and anchor) and the revision it was written against come back on return. It is the editor's scheme
 * (authoring/recovery.ts `putBounded`/`getBounded`): bounded JSON in `localStorage` under a namespaced key, a write
 * that answers false when the browser refuses it so the page can say the text is not kept, and a read that checks
 * every field and gives back nothing it cannot vouch for.
 *
 * One draft per project, target and anchor. `scope` names the project (its resource base on this origin), so a
 * draft never appears in another project; the key carries the target, and the read checks the stored target and
 * anchor again, so a draft for view A never appears on view B, whatever the key says.
 */
import { getBounded, putBounded } from "../authoring/recovery";
import { projectResourceBase } from "../app/browser-routes";
import { browserStateKey } from "../runtime/address.ts";
import { MAX_COMMENT_CHARS, type Anchor, type CommentOperation, type TargetRef } from "./contract";
import { isTargetRef, parseAnchor } from "./parse";
import { sameAnchor } from "./state";
import { liveTabs, whenTabsClose, tabId, withDraftsLock } from "./draft-tabs";
import { adoptHeldOperation, createKey, dropHeldOperation, replyKey } from "./operations";

export const COMMENT_DRAFT_PREFIX = "archer.comment-draft.v1:";
/** A draft's bytes at most: the longest comment, its anchor (a passage quotes text) and the envelope. */
const LIMIT = 4 * MAX_COMMENT_CHARS + 16 * 1024;
const REVISION = /^sha256:[a-f0-9]{64}$/;

export interface CommentDraft {
  readonly version: 1;
  /** The project it belongs to (`commentDraftScope`). */
  readonly scope: string;
  readonly target: TargetRef;
  readonly anchor: Anchor;
  readonly body: string;
  /** The model revision of the diagram on screen when it was written, or null (a note, or not known yet). */
  readonly baseRevision: string | null;
  /** When it was last kept (ms), so the latest is the one offered back. */
  readonly savedAt: number;
  /** Original positional comment scope, retained even if the current model reuses its id. */
  readonly sequenceScope?: "note" | "block";
}

/** Where a composer keeps its draft: the project, the target, and the revision the person is writing against. */
export interface CommentDraftPlace {
  readonly scope: string;
  readonly target: TargetRef;
  readonly baseRevision: string | null;
}

/** This page's project, as drafts name it: its resource base (origin and project), or the address when there is none. */
export function commentDraftScope(href: string = typeof window === "undefined" ? "" : window.location.href): string {
  return browserStateKey(projectResourceBase(href) ?? href.replace(/[?#].*$/, ""));
}

/** `localStorage`, or null where the browser denies it (reading the property itself can throw `SecurityError`). */
export function browserDraftStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** FNV-1a over the anchor's JSON: a short, stable key part (the read compares the anchor itself). */
function anchorKey(anchor: Anchor): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(anchor)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const targetPrefix = (scope: string, target: TargetRef): string =>
  `${browserStateKey(COMMENT_DRAFT_PREFIX)}${scope}\0${target}\0`;
const keyOf = (scope: string, target: TargetRef, anchor: Anchor): string =>
  `${targetPrefix(scope, target)}${anchorKey(anchor)}`;

/**
 * Each tab keeps its drafts under its own owner (draft-tabs.ts, claude-201): a stored key is the draft's key, `~`,
 * and the owner id. A key with no owner is no draft (as a recovery record needs its owner): never offered or restored.
 */
const mine = (key: string): string => `${key}~${tabId()}`;
const ownerOf = (stored: string): { readonly key: string; readonly owner: string } | null => {
  const at = stored.lastIndexOf("~");
  return at < 0 || !/^[0-9a-f]{16}$/.test(stored.slice(at + 1))
    ? null
    : { key: stored.slice(0, at), owner: stored.slice(at + 1) };
};
function storedKeys(storage: Storage, prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** A draft of this kind kept by another tab (open or closed): its stored key and owner, and when it was kept. */
export interface DraftElsewhere {
  readonly stored: string;
  readonly owner: string;
  readonly savedAt: number;
}

/** Every other tab's draft under `key` (a draft's key as `commentDraftKey`, `replyDraftKey` or `chatDraftKey` give it). */
export function draftsElsewhere(storage: Storage | null, key: string): DraftElsewhere[] {
  if (storage === null) return [];
  try {
    return storedKeys(storage, key)
      .filter((stored) => ownerOf(stored)?.key === key && stored !== mine(key))
      .map((stored) => {
        const value = getBounded(storage, stored, LIMIT) as { savedAt?: unknown } | null;
        return {
          stored,
          owner: ownerOf(stored)!.owner,
          savedAt: typeof value?.savedAt === "number" ? value.savedAt : 0,
        };
      });
  } catch {
    return [];
  }
}

/**
 * What another tab keeps under `key`, when this tab keeps nothing there (the ownership rule, draft-tabs.ts; O117):
 * `elsewhere` when its owner is open (it stays there, said so); `offer`, the latest one whose owner is closed, to be
 * taken only by the person's "Use it here" (`takeDraft`) or removed by their Discard (`dropDraft`). Nothing is moved.
 */
export type DraftClaim = {
  readonly elsewhere: boolean;
  readonly offer: DraftElsewhere | null;
  readonly openOwners: readonly string[];
};
export async function claimDraft(storage: Storage | null, key: string): Promise<DraftClaim> {
  const others = draftsElsewhere(storage, key);
  if (storage === null || others.length === 0) return { elsewhere: false, offer: null, openOwners: [] };
  const live = await liveTabs();
  const open = (d: DraftElsewhere): boolean => live?.has(d.owner) === true;
  const offer = others.filter((d) => !open(d)).sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
  return { elsewhere: others.some(open), offer, openOwners: others.filter(open).map((d) => d.owner) };
}

/**
 * `claimDraft`, kept true (claude-408): while another tab writing here is open, its closing (the lock released) claims
 * again, so "being written in another tab" goes and the draft it left is offered. `live` false stops it.
 */
export async function watchClaim(
  storage: Storage | null,
  key: string,
  onClaim: (claim: DraftClaim) => void,
  live: () => boolean,
): Promise<void> {
  for (;;) {
    const claim = await claimDraft(storage, key);
    if (!live()) return;
    onClaim(claim);
    if (!claim.elsewhere) return;
    await whenTabsClose(claim.openOwners);
    if (!live()) return;
  }
}

/**
 * The person chose "Use it here": `offer` becomes this tab's, with the identity its last Send was made under, in one
 * step under the drafts lock. False when it is no longer there (another tab took it, or its owner came back), and
 * when this tab has kept its own text here since the offer was made (O190, codex-1202): an offer is made only where
 * this tab keeps nothing, so anything kept here now was typed while the lock was awaited, and is newer than the
 * offer. Nothing is copied or removed then; the offer stays where it was.
 */
export async function takeDraft(storage: Storage | null, key: string, offer: DraftElsewhere): Promise<boolean> {
  if (storage === null) return false;
  return withDraftsLock(async () => {
    const live = await liveTabs();
    if (live?.has(offer.owner)) return false;
    try {
      // Checked after the last await, so no keystroke lands between this read and the copy.
      if (storage.getItem(mine(key)) !== null) return false;
      const bytes = storage.getItem(offer.stored);
      if (bytes === null) return false;
      storage.setItem(mine(key), bytes);
      storage.removeItem(offer.stored);
      adoptIdentity(storage, JSON.parse(bytes) as unknown, offer.owner);
      return true;
    } catch {
      return false;
    }
  });
}

/** The person chose Discard on another tab's offered draft: it and its held identity are removed. */
export function dropDraft(storage: Storage | null, offer: DraftElsewhere): boolean {
  if (storage === null) return false;
  try {
    const bytes = storage.getItem(offer.stored);
    storage.removeItem(offer.stored);
    if (bytes !== null) dropIdentity(storage, JSON.parse(bytes) as unknown, offer.owner);
    return true;
  } catch {
    return false;
  }
}

/** The body another tab's draft holds (for the offer's words), or null. */
export function offeredBody(storage: Storage | null, offer: DraftElsewhere): string | null {
  const v = storage === null ? null : (getBounded(storage, offer.stored, LIMIT) as { body?: unknown } | null);
  return typeof v?.body === "string" ? v.body : null;
}

/**
 * A taken-over comment or reply takes with it the identity its last Send was made under, if that is still uncertain
 * (codex-301, O114): the identity is the draft's, so this tab's next Send repeats it instead of writing a second copy.
 */
function heldKeyOf(draft: unknown): { readonly scope: string; readonly key: string } | null {
  if (typeof draft !== "object" || draft === null) return null;
  const v = draft as Record<string, unknown>;
  const scope = v["scope"],
    target = v["target"],
    body = v["body"];
  if (typeof scope !== "string" || !isTargetRef(target) || typeof body !== "string") return null;
  if (typeof v["threadId"] === "string" && v["commentId"] === undefined && v["anchor"] === undefined)
    return { scope, key: replyKey(target, v["threadId"], body) };
  if (v["anchor"] !== undefined && v["threadId"] === undefined)
    return { scope, key: createKey(target, v["anchor"], body) };
  return null;
}
function adoptIdentity(storage: Storage, draft: unknown, from: string): void {
  const k = heldKeyOf(draft);
  if (k !== null) adoptHeldOperation(storage, k.scope, k.key, from);
}
function dropIdentity(storage: Storage, draft: unknown, from: string): void {
  const k = heldKeyOf(draft);
  if (k !== null) dropHeldOperation(storage, k.scope, k.key, from);
}

/** The key a comment draft is kept under, without its owner (for `draftsElsewhere` and `claimDraft`). */
export const commentDraftKey = keyOf;

/** Checks bytes from storage: a draft of exactly this scope and target, or null. */
function parse(raw: unknown, scope: string, target: TargetRef): CommentDraft | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v["version"] !== 1 || v["scope"] !== scope || v["target"] !== target || !isTargetRef(v["target"])) return null;
  const anchor = parseAnchor(v["anchor"]);
  const body = v["body"],
    baseRevision = v["baseRevision"],
    savedAt = v["savedAt"];
  if (anchor === undefined || typeof body !== "string" || body.length > MAX_COMMENT_CHARS || body.trim() === "")
    return null;
  if (!(baseRevision === null || (typeof baseRevision === "string" && REVISION.test(baseRevision)))) return null;
  if (typeof savedAt !== "number" || !Number.isSafeInteger(savedAt) || savedAt < 0) return null;
  const sequenceScope = v["sequenceScope"];
  if (sequenceScope !== undefined && sequenceScope !== "note" && sequenceScope !== "block") return null;
  if (sequenceScope === "note" && (anchor.kind !== "node" || !/^note-\d+$/.test(anchor.id))) return null;
  if (sequenceScope === "block" && anchor.kind !== "group") return null;
  return {
    version: 1,
    scope,
    target,
    anchor,
    body,
    baseRevision,
    savedAt,
    ...(sequenceScope === undefined ? {} : { sequenceScope }),
  };
}

/** Keeps a draft; false when the browser would not keep it (full, denied) or it is too large. */
export function keepCommentDraft(storage: Storage | null, draft: CommentDraft): boolean {
  if (storage === null) return false;
  return putBounded(storage, mine(keyOf(draft.scope, draft.target, draft.anchor)), draft, LIMIT);
}

/** The draft this tab keeps for this scope, target and anchor, or null. */
export function readCommentDraft(
  storage: Storage | null,
  scope: string,
  target: TargetRef,
  anchor: Anchor,
): CommentDraft | null {
  if (storage === null) return null;
  const draft = parse(getBounded(storage, mine(keyOf(scope, target, anchor)), LIMIT), scope, target);
  return draft !== null && sameAnchor(draft.anchor, anchor) ? draft : null;
}

/**
 * The most recently kept draft on this target (any anchor), the one offered back on return; this tab's first, else
 * another tab's (the composer then claims it or says where it is, `claimDraft`); null when none.
 */
export function latestCommentDraft(
  storage: Storage | null,
  scope: string,
  target: TargetRef,
  ownOnly = false,
): CommentDraft | null {
  if (storage === null) return null;
  const prefix = targetPrefix(scope, target);
  let own: CommentDraft | null = null,
    other: CommentDraft | null = null;
  try {
    for (const stored of storedKeys(storage, prefix)) {
      const draft = parse(getBounded(storage, stored, LIMIT), scope, target);
      if (draft === null || ownerOf(stored)?.key !== keyOf(scope, target, draft.anchor)) continue;
      if (stored === mine(keyOf(scope, target, draft.anchor))) {
        if (own === null || draft.savedAt > own.savedAt) own = draft;
      } else if (other === null || draft.savedAt > other.savedAt) other = draft;
    }
  } catch {
    return null;
  }
  return ownOnly ? own : (own ?? other);
}

/**
 * What a return to this document opens first (claude-404): this tab's own comment draft; else this tab's own reply or
 * edit (its thread); else another tab's comment draft (its composer, which offers it). `wait` while the threads are
 * not read yet and only another tab's comment is kept; null when there is nothing to open here.
 */
export function draftToOpen(
  storage: Storage | null,
  scope: string,
  target: TargetRef,
  threads: readonly { readonly id: string; readonly comments: readonly { readonly id: string }[] }[] | undefined,
):
  | { readonly kind: "comment"; readonly anchor: Anchor }
  | { readonly kind: "thread"; readonly threadId: string }
  | "wait"
  | null {
  const own = latestCommentDraft(storage, scope, target, true);
  if (own !== null) return { kind: "comment", anchor: own.anchor };
  const other = latestCommentDraft(storage, scope, target);
  if (other === null) return null;
  if (threads === undefined) return "wait";
  const reply = latestReplyDraft(
      storage,
      scope,
      target,
      threads.map((t) => t.id),
    ),
    edit = latestEditDraft(storage, scope, target, threads);
  const replyAt = reply?.savedAt ?? 0,
    editAt = edit?.savedAt ?? 0;
  if (replyAt > 0 || editAt > 0)
    return { kind: "thread", threadId: replyAt >= editAt ? reply!.threadId : edit!.threadId };
  return { kind: "comment", anchor: other.anchor };
}

/** Forgets the draft for this scope, target and anchor; false when the browser refused. */
export function forgetCommentDraft(storage: Storage | null, scope: string, target: TargetRef, anchor: Anchor): boolean {
  if (storage === null) return false;
  try {
    storage.removeItem(mine(keyOf(scope, target, anchor)));
    return true;
  } catch {
    return false;
  }
}

/**
 * A reply being written, kept like a new comment (the same prefix, bounds and checks; ruling 2026-11-02, O93):
 * one per project, target and thread, given back only to that thread's reply editor, removed by sending it or an
 * explicit Discard. Its key ends in `reply:<thread id>`, which no anchor key can (those are 8 hex digits), so a
 * reply is never offered back as a new comment and a new comment never as a reply.
 */
export interface ReplyDraft {
  readonly version: 1;
  readonly scope: string;
  readonly target: TargetRef;
  readonly threadId: string;
  readonly body: string;
  readonly savedAt: number;
}

const replyKeyOf = (scope: string, target: TargetRef, threadId: string): string =>
  `${targetPrefix(scope, target)}reply:${threadId}`;

function parseReply(raw: unknown, scope: string, target: TargetRef, threadId: string): ReplyDraft | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (
    v["version"] !== 1 ||
    v["scope"] !== scope ||
    v["target"] !== target ||
    v["threadId"] !== threadId ||
    !isTargetRef(v["target"])
  )
    return null;
  const body = v["body"],
    savedAt = v["savedAt"];
  if (typeof body !== "string" || body.length > MAX_COMMENT_CHARS || body.trim() === "") return null;
  if (typeof savedAt !== "number" || !Number.isSafeInteger(savedAt) || savedAt < 0) return null;
  return { version: 1, scope, target, threadId, body, savedAt };
}

/** Keeps a reply; false when the browser would not keep it (full, denied) or it is too large. */
export function keepReplyDraft(storage: Storage | null, draft: ReplyDraft): boolean {
  if (storage === null) return false;
  return putBounded(storage, mine(replyKeyOf(draft.scope, draft.target, draft.threadId)), draft, LIMIT);
}

/** The reply kept for this thread, or null. */
export function readReplyDraft(
  storage: Storage | null,
  scope: string,
  target: TargetRef,
  threadId: string,
): ReplyDraft | null {
  if (storage === null) return null;
  return parseReply(getBounded(storage, mine(replyKeyOf(scope, target, threadId)), LIMIT), scope, target, threadId);
}

/** Forgets the reply kept for this thread; false when the browser refused. */
export function forgetReplyDraft(storage: Storage | null, scope: string, target: TargetRef, threadId: string): boolean {
  if (storage === null) return false;
  try {
    storage.removeItem(mine(replyKeyOf(scope, target, threadId)));
    return true;
  } catch {
    return false;
  }
}

/** The key a reply draft is kept under, without its owner. */
export const replyDraftKey = replyKeyOf;

/**
 * The reply and edit drafts (by `replyDraftKey`/`editDraftKey`) whose editor is on the page now and has been typed in
 * since it mounted: still being written there, not kept from an earlier visit, so the page does not reopen their
 * thread and take the focus from them (O174). An editor leaving the page (the project page unmounting on the way to
 * Projects, the thread closing) takes its key out, so the draft comes back when the page does (O179, codex-1001).
 * Counted, since two boxes of one thread can briefly both be mounted.
 */
const writing = new Map<string, number>();
/** Marks `key` as being written in a mounted editor; the returned function unmarks it (call it once, on unmount). */
export function markDraftWriting(key: string): () => void {
  writing.set(key, (writing.get(key) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (writing.get(key) ?? 1) - 1;
    if (left <= 0) writing.delete(key);
    else writing.set(key, left);
  };
}
/** Whether a mounted editor is writing the draft kept under `key` (see `markDraftWriting`). */
export const draftBeingWritten = (key: string): boolean => writing.has(key);

/**
 * One text per reply or edit on this page (O188, codex-1101): a box that changes its text says so here, and every
 * other mounted box of the same key (Project Review's, kept mounted while the review is closed, and the diagram's)
 * takes it, so no box holds an older copy it could write back over the kept one. `text` null: the draft was sent or
 * discarded. A box mounting reads the kept draft, which every change has written.
 *
 * A box's text now, with the comment text an edit began from (null for a reply).
 */
export interface DraftText {
  readonly body: string;
  readonly base: string | null;
}
type DraftListener = (text: DraftText | null, from: object) => void;
const listeners = new Map<string, Set<DraftListener>>();
/** Tells the other boxes of `key` that the box `from` now reads `text`. */
export function announceDraft(key: string, text: DraftText | null, from: object): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener(text, from);
}
/** Hears every change to `key`'s text, its own included (compare `from`); the returned function stops it. */
export function onDraftAnnounced(key: string, listener: DraftListener): () => void {
  const set = listeners.get(key) ?? new Set<DraftListener>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
  };
}

/** A reply on this thread kept by this tab, or by another (to claim or point at): its editor opens for it. */
export const anyReplyDraft = (storage: Storage | null, scope: string, target: TargetRef, threadId: string): boolean =>
  readReplyDraft(storage, scope, target, threadId) !== null ||
  draftsElsewhere(storage, replyKeyOf(scope, target, threadId)).length > 0;

/** The most recently kept reply on one of `threadIds` (threads still on the target), offered back on return; null when none. */
export function latestReplyDraft(
  storage: Storage | null,
  scope: string,
  target: TargetRef,
  threadIds: readonly string[],
): ReplyDraft | null {
  let latest: ReplyDraft | null = null;
  for (const threadId of threadIds) {
    const draft =
      readReplyDraft(storage, scope, target, threadId) ??
      (draftsElsewhere(storage, replyKeyOf(scope, target, threadId)).length > 0
        ? { version: 1 as const, scope, target, threadId, body: "", savedAt: 0 }
        : null);
    if (draft !== null && (latest === null || draft.savedAt > latest.savedAt)) latest = draft;
  }
  return latest;
}

/**
 * A chat message being written (codex-201, O100): kept like a comment and a reply (the same prefix, bounds and
 * checks), one per project and conversation: the target and the conversation's anchor (the document, a walkthrough,
 * the project). `threadId` names the thread it answers, null for a new conversation. Its key ends in
 * `chat:<anchor key>`, which no comment (8 hex digits) or reply (`reply:`) key can, so the review's composers never
 * offer it back and it never offers theirs.
 *
 * `sending` is the create or reply an earlier Send left uncertain (ADR 0016): the next Send of the same text, after a
 * reload too, repeats that identity instead of making a second comment.
 */
export interface ChatDraftIntent {
  readonly kind: "create" | "reply";
  readonly threadId: string | null;
  readonly body: string;
  readonly operation: CommentOperation;
}
export interface ChatDraft {
  readonly version: 1;
  readonly scope: string;
  readonly target: TargetRef;
  readonly anchor: Anchor;
  readonly threadId: string | null;
  readonly body: string;
  readonly savedAt: number;
  readonly sending: ChatDraftIntent | null;
}

const chatKeyOf = (scope: string, target: TargetRef, anchor: Anchor): string =>
  `${targetPrefix(scope, target)}chat:${anchorKey(anchor)}`;
const OPERATION_ID = /^[0-9a-f]{32}$/;

function parseIntent(raw: unknown, target: TargetRef): ChatDraftIntent | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const op = v["operation"] as Record<string, unknown> | null;
  const kind = v["kind"],
    threadId = v["threadId"],
    body = v["body"];
  if ((kind !== "create" && kind !== "reply") || typeof body !== "string" || body.length > MAX_COMMENT_CHARS)
    return undefined;
  if (!(threadId === null || typeof threadId === "string") || (kind === "reply") !== (typeof threadId === "string"))
    return undefined;
  if (
    typeof op !== "object" ||
    op === null ||
    typeof op["id"] !== "string" ||
    !OPERATION_ID.test(op["id"]) ||
    typeof op["issuedAt"] !== "number" ||
    !Number.isSafeInteger(op["issuedAt"])
  )
    return undefined;
  if (op["name"] !== (kind === "create" ? "comment.create" : "comment.reply") || op["target"] !== target)
    return undefined;
  return {
    kind,
    threadId: threadId as string | null,
    body,
    operation: {
      id: op["id"],
      issuedAt: op["issuedAt"],
      name: kind === "create" ? "comment.create" : "comment.reply",
      target,
    },
  };
}

function parseChat(raw: unknown, scope: string, target: TargetRef, anchor: Anchor): ChatDraft | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v["version"] !== 1 || v["scope"] !== scope || v["target"] !== target || !isTargetRef(v["target"])) return null;
  const stored = parseAnchor(v["anchor"]);
  if (stored === undefined || !sameAnchor(stored, anchor)) return null;
  const body = v["body"],
    savedAt = v["savedAt"],
    threadId = v["threadId"];
  if (typeof body !== "string" || body.length > MAX_COMMENT_CHARS || body.trim() === "") return null;
  if (!(threadId === null || typeof threadId === "string")) return null;
  if (typeof savedAt !== "number" || !Number.isSafeInteger(savedAt) || savedAt < 0) return null;
  const sending = parseIntent(v["sending"] ?? null, target);
  if (sending === undefined) return null;
  return { version: 1, scope, target, anchor: stored, threadId, body, savedAt, sending };
}

/** Keeps a chat message; false when the browser would not keep it (full, denied) or it is too large. */
export function keepChatDraft(storage: Storage | null, draft: ChatDraft): boolean {
  if (storage === null) return false;
  return putBounded(storage, mine(chatKeyOf(draft.scope, draft.target, draft.anchor)), draft, LIMIT);
}

/** The chat message kept for this project and conversation, or null. */
export function readChatDraft(
  storage: Storage | null,
  scope: string,
  target: TargetRef,
  anchor: Anchor,
): ChatDraft | null {
  if (storage === null) return null;
  return parseChat(getBounded(storage, mine(chatKeyOf(scope, target, anchor)), LIMIT), scope, target, anchor);
}

/** Forgets the chat message kept for this conversation; false when the browser refused. */
export function forgetChatDraft(storage: Storage | null, scope: string, target: TargetRef, anchor: Anchor): boolean {
  if (storage === null) return false;
  try {
    storage.removeItem(mine(chatKeyOf(scope, target, anchor)));
    return true;
  } catch {
    return false;
  }
}

/** The key a chat draft is kept under, without its owner. */
export const chatDraftKey = chatKeyOf;

/**
 * A change to one of the person's own comments being written (the Edit box; the last G1 gap after O93): kept like a
 * reply (the same prefix, bounds, checks and owner), one per project, target, thread and comment, given back only to
 * that comment's editor, removed by saving it or an explicit Discard. `base` is the comment's text when the edit
 * began: when the comment reads otherwise now (changed in another tab or on another device meanwhile), the editor
 * says so and keeps the person's text instead of quietly writing over the other change. Its key ends in
 * `edit:<thread id>:<comment id>`, which no anchor (8 hex digits), reply (`reply:`) or chat (`chat:`) key can.
 */
export interface EditDraft {
  readonly version: 1;
  readonly scope: string;
  readonly target: TargetRef;
  readonly threadId: string;
  readonly commentId: string;
  readonly body: string;
  readonly base: string;
  readonly savedAt: number;
}

const editKeyOf = (scope: string, target: TargetRef, threadId: string, commentId: string): string =>
  `${targetPrefix(scope, target)}edit:${threadId}:${commentId}`;

function parseEdit(
  raw: unknown,
  scope: string,
  target: TargetRef,
  threadId: string,
  commentId: string,
): EditDraft | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (
    v["version"] !== 1 ||
    v["scope"] !== scope ||
    v["target"] !== target ||
    v["threadId"] !== threadId ||
    v["commentId"] !== commentId ||
    !isTargetRef(v["target"])
  )
    return null;
  const body = v["body"],
    base = v["base"],
    savedAt = v["savedAt"];
  if (typeof body !== "string" || body.length > MAX_COMMENT_CHARS || body.trim() === "") return null;
  if (typeof base !== "string" || base.length > MAX_COMMENT_CHARS) return null;
  if (typeof savedAt !== "number" || !Number.isSafeInteger(savedAt) || savedAt < 0) return null;
  return { version: 1, scope, target, threadId, commentId, body, base, savedAt };
}

/** Keeps an edit; false when the browser would not keep it (full, denied) or it is too large. */
export function keepEditDraft(storage: Storage | null, draft: EditDraft): boolean {
  if (storage === null) return false;
  return putBounded(storage, mine(editKeyOf(draft.scope, draft.target, draft.threadId, draft.commentId)), draft, LIMIT);
}

/** The edit this tab keeps for this comment, or null. */
export function readEditDraft(
  storage: Storage | null,
  scope: string,
  target: TargetRef,
  threadId: string,
  commentId: string,
): EditDraft | null {
  if (storage === null) return null;
  return parseEdit(
    getBounded(storage, mine(editKeyOf(scope, target, threadId, commentId)), LIMIT),
    scope,
    target,
    threadId,
    commentId,
  );
}

/** Forgets the edit kept for this comment; false when the browser refused. */
export function forgetEditDraft(
  storage: Storage | null,
  scope: string,
  target: TargetRef,
  threadId: string,
  commentId: string,
): boolean {
  if (storage === null) return false;
  try {
    storage.removeItem(mine(editKeyOf(scope, target, threadId, commentId)));
    return true;
  } catch {
    return false;
  }
}

/** The key an edit draft is kept under, without its owner. */
export const editDraftKey = editKeyOf;

/** An edit of this comment kept by this tab, or by another (to claim or point at): its editor opens for it. */
export const anyEditDraft = (
  storage: Storage | null,
  scope: string,
  target: TargetRef,
  threadId: string,
  commentId: string,
): boolean =>
  readEditDraft(storage, scope, target, threadId, commentId) !== null ||
  draftsElsewhere(storage, editKeyOf(scope, target, threadId, commentId)).length > 0;

/**
 * The most recently kept edit on one of `threads` (still on the target, with the comment still in them), offered back
 * on return: its thread and comment and when it was kept (0 for another tab's); null when none.
 */
export function latestEditDraft(
  storage: Storage | null,
  scope: string,
  target: TargetRef,
  threads: readonly { readonly id: string; readonly comments: readonly { readonly id: string }[] }[],
): { readonly threadId: string; readonly commentId: string; readonly savedAt: number } | null {
  let latest: { threadId: string; commentId: string; savedAt: number } | null = null;
  for (const thread of threads) {
    for (const comment of thread.comments) {
      const own = readEditDraft(storage, scope, target, thread.id, comment.id);
      const savedAt =
        own?.savedAt ??
        (draftsElsewhere(storage, editKeyOf(scope, target, thread.id, comment.id)).length > 0 ? 0 : null);
      if (savedAt !== null && (latest === null || savedAt > latest.savedAt))
        latest = { threadId: thread.id, commentId: comment.id, savedAt };
    }
  }
  return latest;
}
