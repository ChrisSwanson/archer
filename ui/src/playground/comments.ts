import {
  admit,
  canonicalJson,
  readLedger,
  readOperation,
  ReceiptShapeError,
} from "../../../shared/comment-receipts.mts";
import { commentActivity } from "../../../shared/comment-activity.mts";
import {
  anchor as sharedAnchor,
  Bad,
  body as sharedBody,
  commentContext,
  isObject,
} from "../../../shared/comment-shapes.mts";
import {
  COMMENTS_SCHEMA_VERSION,
  MAX_THREADS_PER_TARGET,
  type Anchor,
  type CommentContext,
  type CommentsChanged,
  type CommentOperation,
  type OperationAck,
  type ReceiptLedger,
  type TargetRef,
  type Thread,
  type ThreadReceipt,
} from "../comments/contract";
import { isTargetRef, parseAnchor, parseThread } from "../comments/parse";

export type LocalCommentsOptions = {
  readonly digest: string;
  readonly projectSlug: string;
  readonly validTarget: (target: string) => boolean;
  /** Resolves labels and rejects absent elements, passages and walkthrough steps against the immutable snapshot. */
  readonly validateAnchor?: (target: TargetRef, anchor: Anchor) => Anchor | undefined;
  readonly modelRevision?: (target: TargetRef) => string | undefined;
  readonly storage?: Storage | null;
  readonly notify: (changed: CommentsChanged) => void;
};

type State = { threads: Thread[]; ledgers: Record<string, ReceiptLedger> };
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TARGETS = 100;
const MAX_COMMENTS = 100;
const MAX_RECEIPTS = 1000;
const object = (value: unknown): Record<string, unknown> | undefined => (isObject(value) ? value : undefined);
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new Refusal(status, code, message);
};
/** The live store's own shape validators (`shared/comment-shapes.mts`), refused as the service refuses them. */
function shaped<T>(code: "invalid_comment" | "invalid_anchor", read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof Bad) return fail(422, code, error.message);
    throw error;
  }
}
const body = (value: unknown): string => shaped("invalid_comment", () => sharedBody(value));
function context(value: unknown): CommentContext | undefined {
  return value === undefined ? undefined : shaped("invalid_comment", () => commentContext(value, "the context"));
}
/** A new thread's anchor: the store's shape check (labels may be left out), then the page's own reading. */
function boundedAnchor(value: unknown): Anchor {
  const checked = shaped("invalid_anchor", () => sharedAnchor(value, true));
  return parseAnchor(checked) ?? fail(422, "invalid_anchor", "Choose an existing comment anchor.");
}
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** A bounded local overlay. It speaks the production comment response contract and never sends or delivers feedback. */
export function createLocalComments(options: LocalCommentsOptions) {
  const key = `archer:playground:${encodeURIComponent(options.digest)}:${encodeURIComponent(options.projectSlug)}:comments`;
  let storage = options.storage === undefined ? browserStorage() : options.storage;
  let state: State = { threads: [], ledgers: {} };
  const targetOf = (value: unknown): TargetRef => {
    if (!isTargetRef(value) || !options.validTarget(value))
      return fail(404, "target_not_found", "This example has no such comment target.");
    return value;
  };
  const anchorOf = (target: TargetRef, raw: unknown): Anchor => {
    const parsed = boundedAnchor(raw);
    if (
      (target === "project:") !== (parsed.kind === "project") ||
      (target.startsWith("note:") && parsed.kind !== "passage" && parsed.kind !== "view")
    )
      return fail(422, "invalid_anchor", "That anchor does not belong to this target.");
    const anchor = options.validateAnchor?.(target, parsed) ?? (options.validateAnchor ? undefined : parsed);
    if (!anchor) return fail(422, "invalid_anchor", "That element or passage is absent from this example.");
    return anchor;
  };
  try {
    const bytes = storage?.getItem(key);
    if (bytes && bytes.length <= MAX_BYTES) {
      const raw = object(JSON.parse(bytes));
      if (
        raw?.version !== 1 ||
        !Array.isArray(raw.threads) ||
        raw.threads.length > MAX_THREADS_PER_TARGET * MAX_TARGETS
      )
        throw new Error("invalid local review");
      const threads = raw.threads.map((rawThread) => {
        const t = parseThread(rawThread);
        if (t?.status !== "draft" || t.comments.length === 0 || t.comments.length > MAX_COMMENTS)
          throw new Error("invalid local thread");
        targetOf(t.target);
        anchorOf(t.target, t.anchor);
        for (const c of t.comments) {
          if (c.author !== "person") throw new Error("invalid local author");
          body(c.body);
          context(c.context);
        }
        return t;
      });
      const ledgers: Record<string, ReceiptLedger> = {};
      const rawLedgers = object(raw.ledgers);
      if (!rawLedgers || Object.keys(rawLedgers).length > MAX_TARGETS) throw new Error("invalid local receipts");
      for (const [target, ledger] of Object.entries(rawLedgers)) {
        targetOf(target);
        const parsed = readLedger(ledger);
        if (parsed.entries.length > MAX_RECEIPTS || parsed.entries.some((r) => r.operation === "comment.submit"))
          throw new Error("invalid local receipts");
        ledgers[target] = parsed;
      }
      state = { threads, ledgers };
    }
  } catch {
    state = { threads: [], ledgers: {} };
  }
  // Probe separately: a read denial and a malformed value are different; malformed data may still be replaced.
  if (storage) {
    try {
      storage.getItem(key);
    } catch {
      storage = null;
    }
  }
  const persist = (next: State): void => {
    const bytes = JSON.stringify({ version: 1, ...next });
    if (bytes.length > MAX_BYTES)
      fail(409, "local_capacity_exceeded", "This demo's local review is full. Reset it to add more comments.");
    state = next;
    if (storage) {
      try {
        storage.setItem(key, bytes);
      } catch {
        storage = null;
      }
    }
  };
  const changed = (target: TargetRef): void => options.notify({ target });
  const threadOf = (id: string): Thread =>
    state.threads.find((t) => t.id === id) ?? fail(404, "thread_not_found", "This local thread no longer exists.");
  // All work is serialized by request's synchronous mutation path; hashing is performed before entering it.
  function operationAck(
    operation: CommentOperation,
    target: TargetRef,
    digest: string,
    payload: unknown,
    threadId?: string,
  ): OperationAck {
    const admission = admit(
      state.ledgers[target],
      operation,
      digest,
      Date.now(),
      (code, message) => fail(code === "invalid_operation" ? 422 : 409, code, message),
      { maxReceipts: MAX_RECEIPTS },
    );
    if (admission.kind === "replay") {
      const receipt = admission.receipt as ThreadReceipt;
      return {
        operation,
        replayed: true,
        committed: {
          threadId: receipt.threadId,
          commentId: receipt.commentId,
          revision: receipt.revision,
          committedAt: receipt.committedAt,
        },
        thread: state.threads.find((t) => t.id === receipt.threadId) ?? null,
      };
    }
    const raw = object(payload) ?? {};
    const text = body(raw.body);
    const where = context(raw.context);
    const timestamp = new Date().toISOString();
    const comment = {
      id: `c_${crypto.randomUUID().replaceAll("-", "")}`,
      author: "person" as const,
      body: text,
      createdAt: timestamp,
      ...(where ? { context: where } : {}),
    };
    let thread: Thread;
    if (threadId === undefined) {
      if (targetOf(raw.target) !== target) fail(422, "invalid_operation", "The operation names another target.");
      if (
        state.threads.filter((t) => t.target === target).length >= MAX_THREADS_PER_TARGET ||
        (Object.keys(state.ledgers).length >= MAX_TARGETS && state.ledgers[target] === undefined)
      )
        fail(409, "local_capacity_exceeded", "This demo's local review is full. Reset it to add more comments.");
      const modelRevision = target.startsWith("view:") ? options.modelRevision?.(target) : undefined;
      if (raw.expectedModelRevision !== undefined) {
        if (typeof raw.expectedModelRevision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.expectedModelRevision))
          fail(422, "invalid_comment", "expectedModelRevision must be a sha256 model revision.");
        if (raw.expectedModelRevision !== modelRevision)
          fail(409, "write_conflict", "The diagram changed. Reopen the comment on the intended element.");
      }
      thread = {
        id: `t_${crypto.randomUUID().replaceAll("-", "")}`,
        target,
        ...(modelRevision === undefined ? {} : { modelRevision }),
        anchor: anchorOf(target, raw.anchor),
        status: "draft",
        revision: 1,
        comments: [comment],
      };
    } else {
      const old = threadOf(threadId);
      if (old.target !== target) fail(422, "invalid_operation", "The operation names another target.");
      if (old.comments.length >= MAX_COMMENTS)
        fail(409, "local_capacity_exceeded", "This thread is full. Start another local thread.");
      thread = { ...old, revision: old.revision + 1, comments: [...old.comments, comment] };
    }
    const committed = { threadId: thread.id, commentId: comment.id, revision: thread.revision, committedAt: timestamp };
    const threads = state.threads.filter((t) => t.id !== thread.id).concat(thread);
    persist({ threads, ledgers: { ...state.ledgers, [target]: admission.record(committed) } });
    changed(target);
    return { operation, replayed: false, committed, thread };
  }
  return {
    get memoryOnly(): boolean {
      return storage === null;
    },
    async request(path: string, init?: RequestInit): Promise<Response | undefined> {
      let url: URL;
      try {
        url = new URL(path, "https://playground.invalid/");
      } catch {
        return Response.json(
          { error: { code: "invalid_request", message: "The local request address is invalid." } },
          { status: 422 },
        );
      }
      const activityRequest = url.pathname.endsWith("/api/comment-activity");
      const start = url.pathname.indexOf("/api/comments");
      if (!activityRequest && (start < 0 || !["", "/", "?"].includes(url.pathname[start + 13] ?? ""))) return undefined;
      if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      let route: string[];
      try {
        route = activityRequest
          ? ["activity"]
          : url.pathname
              .slice(start + 13)
              .split("/")
              .filter(Boolean)
              .map(decodeURIComponent);
      } catch {
        return Response.json(
          { error: { code: "invalid_request", message: "The local request address is invalid." } },
          { status: 422 },
        );
      }
      const method = (init?.method ?? "GET").toUpperCase();
      try {
        if (route.length > 2) fail(404, "route_not_found", "This local comment route does not exist.");
        if (method === "GET") {
          if (route.length === 0) {
            const target = targetOf(url.searchParams.get("target"));
            return Response.json({
              schemaVersion: COMMENTS_SCHEMA_VERSION,
              target,
              threads: state.threads.filter((t) => t.target === target),
            });
          }
          if (route[0] === "pending") {
            const targets = [...new Set(state.threads.map((t) => t.target))].map((target) => ({
              target,
              title: target,
              drafts: state.threads.filter((t) => t.target === target).length,
            }));
            return Response.json({ total: state.threads.length, targets });
          }
          if (route[0] === "activity")
            return Response.json({
              schemaVersion: 1,
              agentCommentsListed: true,
              targets: Object.fromEntries(
                [...new Set(state.threads.map((t) => t.target))].map((target) => [
                  target,
                  commentActivity(state.threads.filter((t) => t.target === target)),
                ]),
              ),
            });
        }
        if (route[0] === "submit")
          return fail(403, "demo_unavailable", "Comments stay in this browser. No agent is connected.");
        if (typeof init?.body !== "string" || init.body.length > MAX_BYTES)
          fail(422, "invalid_comment", "The local comment request is invalid.");
        let raw: Record<string, unknown>;
        try {
          raw = object(JSON.parse(init!.body as string)) ?? {};
        } catch {
          return fail(422, "invalid_comment", "The local comment request is invalid JSON.");
        }
        if (method === "POST" && (route.length === 0 || (route.length === 2 && route[1] === "replies"))) {
          if (Object.keys(raw).some((field) => field !== "operation" && field !== "payload"))
            fail(422, "invalid_operation", "A comment operation takes only operation and payload.");
          const name = route.length === 0 ? "comment.create" : "comment.reply";
          const operation = readOperation(raw.operation, name, (value) => (isTargetRef(value) ? value : null));
          targetOf(operation.target);
          const payload = object(raw.payload);
          const fields =
            name === "comment.create"
              ? ["target", "anchor", "body", "context", "expectedModelRevision"]
              : ["body", "context"];
          if (!payload || Object.keys(payload).some((field) => !fields.includes(field)))
            return fail(422, "invalid_comment", "The local comment payload has an unsupported field.");
          // Validate to the contract's finite shape before canonicalization: raw JSON can contain arbitrarily
          // deep unknown fields. No untrusted container reaches the recursive canonical encoder.
          const where = context(payload.context);
          const cleanPayload: Record<string, unknown> = {
            body: body(payload.body),
            ...(where === undefined ? {} : { context: where }),
          };
          if (name === "comment.create") {
            cleanPayload.target = targetOf(payload.target);
            cleanPayload.anchor = boundedAnchor(payload.anchor);
            if (payload.expectedModelRevision !== undefined) {
              if (
                typeof payload.expectedModelRevision !== "string" ||
                !/^sha256:[a-f0-9]{64}$/.test(payload.expectedModelRevision)
              )
                fail(422, "invalid_comment", "expectedModelRevision must be a sha256 model revision.");
              cleanPayload.expectedModelRevision = payload.expectedModelRevision;
            }
          }
          // SHA-256 is browser-native, with no Node import in this runtime. Recheck abort after the async boundary.
          const bytes = new TextEncoder().encode(canonicalJson({ operation, payload: cleanPayload }));
          const hash = await crypto.subtle.digest("SHA-256", bytes);
          if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
          const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
          return Response.json(operationAck(operation, operation.target, digest, cleanPayload, route[0]));
        }
        const thread = threadOf(route[0] ?? "");
        if (method === "POST" && (route[1] === "resolve" || route[1] === "dismiss")) {
          if (route[1] === "dismiss" && thread.status !== "resolved")
            fail(409, "thread_not_resolved", "This local thread is not resolved.");
          persist({ ...state, threads: state.threads.filter((t) => t.id !== thread.id) });
          changed(thread.target);
          return Response.json({ [route[1] === "resolve" ? "resolved" : "dismissed"]: true });
        }
        const comment = thread.comments.find((c) => c.id === route[1]);
        if (!comment) fail(404, "comment_not_found", "This local comment no longer exists.");
        if (method !== "PATCH" && method !== "DELETE")
          return fail(405, "method_not_allowed", "This action is unavailable in the demo.");
        if (raw.expectedRevision !== undefined && raw.expectedRevision !== thread.revision)
          fail(409, "thread_changed", "The local thread changed. Read it again before editing.");
        if (method === "DELETE" && thread.comments[0]?.id === comment!.id && thread.comments.length > 1)
          fail(409, "has_replies", "The thread's first comment has replies. Resolve the thread to remove it all.");
        const comments =
          method === "DELETE"
            ? thread.comments.filter((c) => c.id !== comment!.id)
            : thread.comments.map((c) =>
                c.id === comment!.id ? { ...c, body: body(raw.body), editedAt: new Date().toISOString() } : c,
              );
        const next: Thread = { ...thread, comments, revision: thread.revision + 1 };
        persist({
          ...state,
          threads: state.threads.filter((t) => t.id !== thread.id).concat(comments.length ? [next] : []),
        });
        changed(thread.target);
        return Response.json(comments.length ? next : { deleted: true });
      } catch (error) {
        if (error instanceof Refusal)
          return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
        if (error instanceof ReceiptShapeError)
          return Response.json({ error: { code: "invalid_operation", message: error.message } }, { status: 422 });
        throw error;
      }
    },
    reset(): void {
      const targets = [...new Set(state.threads.map((t) => t.target))];
      state = { threads: [], ledgers: {} };
      try {
        storage?.removeItem(key);
      } catch {
        storage = null;
      }
      for (const target of targets) changed(target);
    },
  };
}
