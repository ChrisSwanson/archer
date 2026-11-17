/**
 * Sending a comment write as an operation (ADR 0016; O67, O83, O100): the one path every surface that adds a
 * comment, a reply or sends one uses: the review controls (`useReview`) and the chat bubble (`chat-send.ts`).
 *
 * An operation keeps one identity until it is answered or refused in a way that ends it. With no answer it is sent
 * again with that same identity after OPERATION_RETRY_DELAYS_MS (never while offline, never while the page holds
 * writes back), so the service answers a repeat from its receipt instead of writing it twice; still unanswered, the
 * caller says the outcome is uncertain and keeps the identity for the person's next try. No React here.
 */
import {
  RECEIPT_REPLAY_MS,
  type CommentOperation,
  type CommentOperationName,
  type SubmitOperation,
  type TargetRef,
  type Thread,
} from "./contract";
import { TransportError, UncertainWriteError, type CommentsTransport } from "./transport";
import { tabId } from "./draft-tabs";
import { browserStateKey } from "../runtime/address.ts";

/** How long the page waits before sending an uncertain operation again, itself, before it asks the person. */
export const OPERATION_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

/** A new operation identity (ADR 0016): 128 random bits as 32 hex characters, and when it was issued. */
export function newOperation(name: CommentOperationName, target: TargetRef): CommentOperation {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return { id, issuedAt: Date.now(), name, target };
}

/** A new submit identity (O83). A submit names no target: its payload says what it sends. */
export function newSubmitOperation(): SubmitOperation {
  const { id, issuedAt } = newOperation("comment.create", "project:");
  return { id, issuedAt, name: "comment.submit" };
}

/** How one operation's sending ended: answered, still uncertain after the retries, or refused. */
export type Settled<A> =
  | { readonly kind: "answered"; readonly ack: A }
  | { readonly kind: "uncertain"; readonly failure: unknown; readonly offline: boolean }
  /** `afterUncertain`: an earlier try in this loop got no answer, so it may have landed despite the refusal. */
  | { readonly kind: "refused"; readonly failure: unknown; readonly ended: boolean; readonly afterUncertain: boolean };

/** A refusal after which the identity cannot be sent again: the next try is a new operation. */
export const endsIdentity = (failure: unknown): boolean =>
  failure instanceof TransportError &&
  (failure.code === "operation_expired" || failure.code === "operation_payload_mismatch");

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends `operation` until it is answered, refused, or still uncertain after the page's own retries. */
export async function settle<O, A>(
  operation: O,
  send: (operation: O) => Promise<A>,
  active: () => boolean = () => true,
): Promise<Settled<A>> {
  /** An earlier try got no answer: it may have landed, whatever a later try says. */
  let unanswered: UncertainWriteError | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      return { kind: "answered", ack: await send(operation) };
    } catch (failure) {
      // The page said it is disconnected after a try got no answer, so the retry was held back, not refused:
      // that try may still have landed, and the same identity is sent again later.
      const heldBack = unanswered !== undefined && failure instanceof TransportError && failure.code === "not_sent";
      if (failure instanceof UncertainWriteError || heldBack) {
        if (failure instanceof UncertainWriteError) unanswered = failure;
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        const delay = OPERATION_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined && active() && !offline && !heldBack) {
          await wait(delay);
          continue;
        }
        return { kind: "uncertain", failure: unanswered ?? failure, offline };
      }
      return { kind: "refused", failure, ended: endsIdentity(failure), afterUncertain: unanswered !== undefined };
    }
  }
}

/** Where identities are kept while their outcome is uncertain: a `Map`, or `operationHold` (this browser). */
export interface OperationHold<O> {
  get(key: string): O | undefined;
  set(key: string, operation: O): void;
  delete(key: string): boolean | void;
}

/** What a create or a reply is kept under: what it writes (target, anchor or thread) and its text. */
export const createKey = (target: TargetRef, anchor: unknown, body: string): string =>
  `${createPlace(target, anchor)}${body}`;
export const replyKey = (target: TargetRef, threadId: string, body: string): string =>
  `${replyPlace(target, threadId)}${body}`;
/** The part of a key that names the place, without the words: a held key starting so is about the same place. */
export const createPlace = (target: TargetRef, anchor: unknown): string =>
  `create\0${target}\0${JSON.stringify(anchor)}\0`;
export const replyPlace = (target: TargetRef, threadId: string): string => `reply\0${target}\0${threadId}\0`;

export const OPERATION_HOLD_PREFIX = "archer.comment-operation.v1:";
const HOLD_LIMIT = 4 * 10_000 + 16 * 1024;
const OPERATION_ID = /^[0-9a-f]{32}$/;
const OPERATION_NAMES = new Set(["comment.create", "comment.reply", "comment.submit"]);

/** FNV-1a: a short key part (the record holds the whole key and is compared). */
function hashKey(key: string): string {
  let hash = 0x811c9dc5;
  for (const char of key) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Identities kept in this browser as well as in the page (claude-202, O102): a reload or a reopened tab after a lost
 * answer gives the same text back AND the identity it was sent under, so sending it again is answered from the
 * receipt instead of writing it twice. One record per project (`scope`), key and owner; one older than the service
 * replays (RECEIPT_REPLAY_MS) is not given back. Where the browser refuses storage the page's memory still holds it.
 *
 * The owner is the tab's (draft-tabs.ts `tabId`, codex-301, O114), as a draft's is: an identity belongs to the draft
 * it was sent from, not to its words. A reload keeps the owner, so its draft and identity come back together; two
 * tabs that each type the same words hold two identities, so both comments are written; a tab that takes over a
 * closed tab's draft takes its identity with it (`adoptHeldOperation`, called by comment-draft.ts `takeDraft`).
 */
const holdKey = (scope: string, key: string, owner: string): string =>
  `${browserStateKey(OPERATION_HOLD_PREFIX)}${scope}\0${hashKey(key)}~${owner}`;

function readHeld<O>(storage: Storage | null, stored: string, key: string): O | undefined {
  if (storage === null) return undefined;
  try {
    const raw = storage.getItem(stored);
    if (raw === null || raw.length > HOLD_LIMIT) return undefined;
    const v = JSON.parse(raw) as { version?: unknown; key?: unknown; operation?: Record<string, unknown> };
    const op = v.operation;
    if (v.version !== 1 || v.key !== key || typeof op !== "object" || op === null) return undefined;
    if (
      typeof op["id"] !== "string" ||
      !OPERATION_ID.test(op["id"]) ||
      typeof op["issuedAt"] !== "number" ||
      !Number.isSafeInteger(op["issuedAt"]) ||
      !OPERATION_NAMES.has(op["name"] as string)
    )
      return undefined;
    if (Date.now() - op["issuedAt"] > RECEIPT_REPLAY_MS) return undefined;
    return op as unknown as O;
  } catch {
    return undefined;
  }
}

export function operationHold<O extends { readonly id: string; readonly issuedAt: number; readonly name: string }>(
  storage: Storage | null,
  scope: string,
): OperationHold<O> & { has(key: string): boolean; keysLike(prefix: string): string[] } {
  const memory = new Map<string, O>();
  const read = (key: string): O | undefined => readHeld<O>(storage, holdKey(scope, key, tabId()), key);
  return {
    get: (key) => memory.get(key) ?? read(key),
    has: (key) => memory.has(key) || read(key) !== undefined,
    /** This tab's held keys that start with `prefix` (what one place holds, whatever its words: claude-304). */
    keysLike(prefix) {
      const keys = new Set([...memory.keys()].filter((k) => k.startsWith(prefix)));
      if (storage !== null) {
        try {
          const start = `${browserStateKey(OPERATION_HOLD_PREFIX)}${scope}\0`,
            end = `~${tabId()}`;
          for (let i = 0; i < storage.length; i++) {
            const stored = storage.key(i);
            if (stored === null || !stored.startsWith(start) || !stored.endsWith(end)) continue;
            const v = JSON.parse(storage.getItem(stored) ?? "null") as { key?: unknown } | null;
            if (typeof v?.key === "string" && v.key.startsWith(prefix) && read(v.key) !== undefined) keys.add(v.key);
          }
        } catch {
          /* refused */
        }
      }
      return [...keys];
    },
    set(key, operation) {
      memory.set(key, operation);
      if (storage === null) return;
      const bytes = JSON.stringify({ version: 1, key, operation, savedAt: Date.now() });
      if (bytes.length > HOLD_LIMIT) return;
      try {
        storage.setItem(holdKey(scope, key, tabId()), bytes);
      } catch {
        /* the page's memory still holds it */
      }
    },
    delete(key) {
      const had = memory.delete(key);
      try {
        storage?.removeItem(holdKey(scope, key, tabId()));
      } catch {
        /* refused */
      }
      return had;
    },
  };
}

/** The identity `from` (a closed tab) kept under `key` is removed with its draft (the person's Discard). */
export function dropHeldOperation(storage: Storage | null, scope: string, key: string, from: string): void {
  try {
    storage?.removeItem(holdKey(scope, key, from));
  } catch {
    /* refused */
  }
}

/**
 * The identity `from` (a closed tab) kept under `key` becomes this tab's, with the draft it was sent from: the next
 * Send here repeats it. False when there was none (or the browser refused).
 */
export function adoptHeldOperation(storage: Storage | null, scope: string, key: string, from: string): boolean {
  if (storage === null || from === tabId()) return false;
  const stored = holdKey(scope, key, from);
  if (readHeld(storage, stored, key) === undefined) return false;
  try {
    const bytes = storage.getItem(stored);
    if (bytes === null) return false;
    storage.setItem(holdKey(scope, key, tabId()), bytes);
    storage.removeItem(stored);
    return true;
  } catch {
    return false;
  }
}

/** `settle`, with the identity kept under `key` in `held` until an answer or a refusal that ends it. */
export async function settleHeld<O, A>(
  held: OperationHold<O>,
  key: string,
  make: () => O,
  send: (operation: O) => Promise<A>,
  active?: () => boolean,
): Promise<Settled<A>> {
  const kept = held.get(key);
  const operation = kept ?? make();
  held.set(key, operation);
  const out = await settle(operation, send, active);
  // Kept only while it may have landed: an answer settles it; a refusal ends it, unless it went unanswered before
  // (in this loop, or an earlier Send that left it held), when it may be with the service and is sent again as itself.
  if (out.kind === "answered" || (out.kind === "refused" && (out.ended || (kept === undefined && !out.afterUncertain))))
    held.delete(key);
  return out;
}

export function failureMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "the server did not answer";
}

/** What the page says of a create or reply whose outcome is not known; `noun` is "comment", "reply" or "message". */
export function uncertainWords(noun: string, failure: unknown, offline: boolean): string {
  return offline
    ? `This browser is offline, so this ${noun} may not have been sent. Your text is kept; sending it again once you are back online sends this same ${noun}, never a second copy.`
    : `Archer did not answer, so this ${noun} may have been sent or not (${failureMessage(failure)}). Your text is kept; sending it again sends this same ${noun}, never a second copy.`;
}

/** The key one thread's submit identity is kept under, the same for the review's Publish and the chat's Send. */
export const threadSubmitKey = (target: TargetRef, threadId: string): string => `thread\0${target}\0${threadId}`;

/**
 * Publishes exactly one thread as an operation, kept in `held`. A submit still unanswered is read back: what the
 * service holds says whether it went (`sent`), else it is `uncertain` (the same identity goes on the next try).
 */
export async function submitThreadOnce(
  transport: CommentsTransport,
  held: OperationHold<SubmitOperation>,
  target: TargetRef,
  threadId: string,
  active?: () => boolean,
): Promise<
  | { readonly kind: "sent" }
  | { readonly kind: "refused"; readonly failure: unknown }
  | { readonly kind: "uncertain"; readonly failure: unknown; readonly offline: boolean; readonly thread?: Thread }
> {
  const sent = await settleHeld(
    held,
    threadSubmitKey(target, threadId),
    newSubmitOperation,
    (operation) => transport.submitOnce(operation, { target, threadId }),
    active,
  );
  if (sent.kind === "answered") return { kind: "sent" };
  if (sent.kind === "refused") return { kind: "refused", failure: sent.failure };
  const now = await transport.listThreads(target).then(
    (read) => read.threads.find((t) => t.id === threadId),
    () => undefined,
  );
  if (now !== undefined && now.status !== "draft") {
    held.delete(threadSubmitKey(target, threadId));
    return { kind: "sent" };
  }
  return {
    kind: "uncertain",
    failure: sent.failure,
    offline: sent.offline,
    ...(now === undefined ? {} : { thread: now }),
  };
}
