/**
 * The comments contract, schema version 2 (`ts/src/comments/contract.ts` as
 * amended by phase 2, the feedback loop), held in memory: the fake behind the
 * jsdom unit tests' transport (`memory-transport.ts`). Page tests that mount
 * the App use the real service instead (`page-on-service.ts`).
 *
 * Held to the contract by `comments-contract.test.ts`, which drives it through
 * that transport with the same cases it drives the TypeScript service with.
 *
 * What it does is what the contract says, and nothing it does not:
 *   - a new thread is a draft at revision 1; every change the person makes
 *     (edit, delete, reply) advances the revision;
 *   - editing or deleting a person's comment on a thread that is not a draft
 *     puts it back to draft, flagged `changedAfterSubmit`; so does the
 *     person replying to a thread the agent has not answered (sent or read);
 *     replying to an answered or resolved thread is the conversation going
 *     on, and makes a plain draft;
 *   - only the person's own comments can be edited or deleted;
 *   - deleting a thread's first comment with no replies deletes the thread;
 *     with replies it is refused (`has_replies`: resolve the thread instead);
 *   - a body holding a control character other than tab and line breaks is refused;
 *   - the person resolving removes the thread at once;
 *   - submitting moves every draft (or one target's) to `sent`, keeping
 *     `changedAfterSubmit` so the agent knows it is a revision;
 *   - the agent fetching (`get_comments`) moves `sent` to `read`, and hands
 *     it `sent` and `read` threads with their revisions;
 *   - the agent's reply answers the thread and clears `changedAfterSubmit`;
 *     the agent resolving moves it to `resolved`, kept until the person
 *     dismisses it; either is refused with `thread_changed` when the person
 *     changed the thread since the revision the agent names;
 *   - dismissing removes a `resolved` thread, and only one;
 *   - create, reply and submit sent as operations (ADR 0016, the only way the page sends them) keep a
 *     receipt by identity: the same operation again is answered from it (`replayed`) with no second effect,
 *     and with another payload it is refused `operation_payload_mismatch` (409).
 */
import { noteDescription } from "../../../ts/src/project/describe.ts";
import {
  MAX_COMMENT_CHARS,
  type Anchor,
  type Comment,
  type CommentContext,
  type CommentOperation,
  type NewThread,
  type OperationAck,
  type SubmitAck,
  type SubmitOperation,
  type NoteContent,
  type NoteSummary,
  type Pending,
  type TargetRef,
  type Thread,
} from "../../src/comments/contract";

export class StoreRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type HeldThread = Mutable<Omit<Thread, "comments">> & { comments: Mutable<Comment>[] };

export type StoreNote = NoteSummary & {
  readonly markdown: string;
  readonly views: readonly string[];
  /** The file's dates, as the service lists them; `modifiedAt` defaults to when the store was made. */
  readonly createdAt?: string;
  readonly createdFrom?: "filesystem" | "git";
  readonly modifiedAt?: string;
};

export class CommentsStore {
  #threads: HeldThread[] = [];
  #ids = 0;
  #clock: () => string;
  readonly notes: StoreNote[];
  /** A view's title, for the pending list; a test that names its views says their titles. */
  viewTitle: (viewId: string) => string = (viewId) => viewId;
  /** Called with the target whose threads changed, after every change. */
  onChange: (target: TargetRef) => void = () => {};

  readonly #made: string;
  constructor(options: { notes?: StoreNote[]; clock?: () => string } = {}) {
    this.notes = options.notes ?? [];
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#made = this.#clock();
  }

  #id(prefix: string): string {
    this.#ids += 1;
    return `${prefix}${this.#ids}`;
  }

  /** Operation receipts by identity, with the payload each was first sent with. */
  readonly #receipts = new Map<string, { readonly payload: string; readonly ack: OperationAck | SubmitAck }>();

  #receipt<A extends OperationAck | SubmitAck>(id: string, payload: unknown): A | undefined {
    const held = this.#receipts.get(id);
    if (held === undefined) return undefined;
    if (held.payload !== JSON.stringify(payload))
      throw new StoreRefusal(409, "operation_payload_mismatch", "this operation was sent before with other content");
    return held.ack as A;
  }

  #threadAck(operation: CommentOperation, thread: Thread, commentId: string): OperationAck {
    return {
      operation: { id: operation.id, issuedAt: operation.issuedAt, name: operation.name },
      replayed: false,
      committed: { threadId: thread.id, commentId, revision: thread.revision, committedAt: this.#clock() },
      thread,
    };
  }

  #replayed(ack: OperationAck): OperationAck {
    const thread = this.#threads.find((t) => t.id === ack.committed.threadId);
    return { ...ack, replayed: true, thread: thread === undefined ? null : this.#out(thread) };
  }

  /** `create` sent as an operation. */
  createOnce(operation: CommentOperation, input: NewThread): OperationAck {
    const held = this.#receipt<OperationAck>(operation.id, { operation, input });
    if (held !== undefined) return this.#replayed(held);
    const thread = this.create(input);
    const ack = this.#threadAck(operation, thread, thread.comments[0]!.id);
    this.#receipts.set(operation.id, { payload: JSON.stringify({ operation, input }), ack });
    return ack;
  }

  /** `reply` sent as an operation. */
  replyOnce(operation: CommentOperation, threadId: string, body: unknown, context?: CommentContext): OperationAck {
    const payload = { operation, threadId, body, context };
    const held = this.#receipt<OperationAck>(operation.id, payload);
    if (held !== undefined) return this.#replayed(held);
    const thread = this.reply(threadId, body, context);
    const ack = this.#threadAck(operation, thread, thread.comments.at(-1)!.id);
    this.#receipts.set(operation.id, { payload: JSON.stringify(payload), ack });
    return ack;
  }

  /** `submit` sent as an operation. */
  submitOnce(operation: SubmitOperation, target?: TargetRef, threadId?: string): SubmitAck {
    const payload = { operation, target, threadId };
    const held = this.#receipt<SubmitAck>(operation.id, payload);
    if (held !== undefined) return { ...held, replayed: true };
    const ack: SubmitAck = {
      operation: { id: operation.id, issuedAt: operation.issuedAt, name: "comment.submit" },
      replayed: false,
      ...this.submit(target, threadId),
    };
    this.#receipts.set(operation.id, { payload: JSON.stringify(payload), ack });
    return ack;
  }

  #body(body: unknown): string {
    if (typeof body !== "string" || body.trim() === "") {
      throw new StoreRefusal(422, "invalid_request", "the comment is empty");
    }
    if ([...body].length > MAX_COMMENT_CHARS) {
      throw new StoreRefusal(
        422,
        "invalid_request",
        `the comment is ${[...body].length} characters, and a comment holds at most ${MAX_COMMENT_CHARS}`,
      );
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) {
      throw new StoreRefusal(422, "invalid_request", "the comment holds a control character");
    }
    return body;
  }

  #thread(threadId: string): HeldThread {
    const thread = this.#threads.find((t) => t.id === threadId);
    if (thread === undefined) {
      throw new StoreRefusal(404, "thread_not_found", `no thread '${threadId}'`);
    }
    return thread;
  }

  /** The person changed what the agent was sent: a draft again, flagged. */
  #changed(thread: HeldThread): void {
    thread.revision += 1;
    if (thread.status !== "draft") {
      thread.status = "draft";
      thread.changedAfterSubmit = true;
    }
  }

  #emit(target: TargetRef): void {
    this.onChange(target);
  }

  /** A copy, so nothing a caller does reaches what is held. */
  #out(thread: HeldThread): Thread {
    return structuredClone(thread) as Thread;
  }

  list(target: TargetRef): Thread[] {
    return this.#threads.filter((t) => t.target === target).map((t) => this.#out(t));
  }

  create(input: NewThread): Thread {
    const thread: HeldThread = {
      id: this.#id("t"),
      target: input.target,
      anchor: structuredClone(input.anchor) as Anchor,
      status: "draft",
      revision: 1,
      comments: [
        {
          id: this.#id("c"),
          author: "person",
          body: this.#body(input.body),
          createdAt: this.#clock(),
          ...(input.context === undefined ? {} : { context: structuredClone(input.context) }),
        },
      ],
    };
    this.#threads.push(thread);
    this.#emit(thread.target);
    return this.#out(thread);
  }

  /** The person's reply. The agent's goes through `agentReply`. */
  reply(threadId: string, body: unknown, context?: CommentContext): Thread {
    const thread = this.#thread(threadId);
    thread.comments.push({
      id: this.#id("c"),
      author: "person",
      body: this.#body(body),
      createdAt: this.#clock(),
      ...(context === undefined ? {} : { context: structuredClone(context) }),
    });
    thread.revision += 1;
    // Answering the agent is the conversation going on; adding to a thread
    // the agent has not answered yet changes what it was sent.
    if (thread.status === "sent" || thread.status === "read") thread.changedAfterSubmit = true;
    thread.status = "draft";
    this.#emit(thread.target);
    return this.#out(thread);
  }

  #own(thread: HeldThread, commentId: string): Mutable<Comment> {
    const comment = thread.comments.find((c) => c.id === commentId);
    if (comment === undefined) {
      throw new StoreRefusal(404, "comment_not_found", `no comment '${commentId}'`);
    }
    if (comment.author !== "person") {
      throw new StoreRefusal(403, "not_yours", "only your own comments can be changed");
    }
    return comment;
  }

  edit(threadId: string, commentId: string, body: unknown, expectedRevision?: number): Thread {
    const thread = this.#thread(threadId);
    const comment = this.#own(thread, commentId);
    // As the service (O124): asking for the text it already reads is no change; otherwise a stale revision is refused.
    if (comment.body === body) return this.#out(thread);
    if (expectedRevision !== undefined && thread.revision !== expectedRevision)
      throw new StoreRefusal(
        409,
        "thread_changed",
        `thread ${threadId} changed since revision ${expectedRevision}; it is at ${thread.revision}`,
      );
    comment.body = this.#body(body);
    comment.editedAt = this.#clock();
    this.#changed(thread);
    this.#emit(thread.target);
    return this.#out(thread);
  }

  remove(threadId: string, commentId: string): Thread | { deleted: true } {
    const thread = this.#thread(threadId);
    this.#own(thread, commentId);
    if (thread.comments[0]?.id === commentId && thread.comments.length > 1) {
      throw new StoreRefusal(
        409,
        "has_replies",
        "the thread's first comment has replies after it; resolve the thread to remove it all",
      );
    }
    if (thread.comments.length === 1) {
      this.#threads = this.#threads.filter((t) => t !== thread);
      this.#emit(thread.target);
      return { deleted: true };
    }
    thread.comments = thread.comments.filter((c) => c.id !== commentId);
    this.#changed(thread);
    this.#emit(thread.target);
    return this.#out(thread);
  }

  /** The person resolving: removed at once. */
  resolve(threadId: string): { resolved: true } {
    const thread = this.#thread(threadId);
    this.#threads = this.#threads.filter((t) => t !== thread);
    this.#emit(thread.target);
    return { resolved: true };
  }

  /** The person dismissing what the agent resolved: removed. Only a resolved thread. */
  dismiss(threadId: string): { dismissed: true } {
    const thread = this.#thread(threadId);
    if (thread.status !== "resolved") {
      throw new StoreRefusal(409, "thread_not_resolved", "only a thread the agent resolved can be dismissed");
    }
    this.#threads = this.#threads.filter((t) => t !== thread);
    this.#emit(thread.target);
    return { dismissed: true };
  }

  /**
   * Comments files the real service could not read and skipped on submit.
   * The fake has no files; a test that needs the answer sets it.
   */
  unreadableFiles: string[] = [];

  submit(target?: TargetRef, threadId?: string): { submitted: number; problems?: string[] } {
    if (threadId !== undefined) {
      const thread = this.#thread(threadId);
      if (target !== undefined && thread.target !== target)
        throw new StoreRefusal(404, "thread_not_found", "the requested thread does not belong to this target");
      if (thread.status !== "draft") return { submitted: 0 };
      thread.status = "sent";
      this.#emit(thread.target);
      return { submitted: 1 };
    }
    const touched = new Set<TargetRef>();
    let submitted = 0;
    for (const thread of this.#threads) {
      if (thread.status === "draft" && (target === undefined || thread.target === target)) {
        thread.status = "sent";
        submitted += 1;
        touched.add(thread.target);
      }
    }
    for (const changed of touched) this.#emit(changed);
    return this.unreadableFiles.length === 0 ? { submitted } : { submitted, problems: [...this.unreadableFiles] };
  }

  #title(target: TargetRef): string {
    if (target.startsWith("note:")) {
      const path = target.slice("note:".length);
      return this.notes.find((note) => note.path === path)?.title ?? path;
    }
    return this.viewTitle(target.slice("view:".length));
  }

  /** `GET api/comments/pending`: every draft in the project, by target, in the order first written. */
  pending(): Pending {
    const counts = new Map<TargetRef, number>();
    for (const thread of this.#threads) {
      if (thread.status === "draft") counts.set(thread.target, (counts.get(thread.target) ?? 0) + 1);
    }
    const targets = [...counts].map(([target, drafts]) => ({ target, title: this.#title(target), drafts }));
    return { total: targets.reduce((sum, t) => sum + t.drafts, 0), targets };
  }

  // ---- The agent's side: what the MCP tools do. ----

  /** `get_comments`: sent threads move to read; sent and read are handed over. */
  agentRead(target?: TargetRef): Thread[] {
    const touched = new Set<TargetRef>();
    const handed: Thread[] = [];
    for (const thread of this.#threads) {
      if (target !== undefined && thread.target !== target) continue;
      if (thread.status === "sent") {
        thread.status = "read";
        touched.add(thread.target);
      }
      if (thread.status === "read") handed.push(this.#out(thread));
    }
    for (const changed of touched) this.#emit(changed);
    return handed;
  }

  /**
   * What the agent may act on, at the revision it read. The revision is
   * checked first, so a changed thread is `thread_changed` whatever its
   * status; then the status (`thread_not_awaiting`), as the service does.
   */
  #forAgent(
    threadId: string,
    expectedRevision: number | undefined,
    allowed: readonly Thread["status"][],
    what: string,
  ): HeldThread {
    const thread = this.#thread(threadId);
    if (expectedRevision !== undefined && thread.revision !== expectedRevision) {
      throw new StoreRefusal(
        409,
        "thread_changed",
        `thread ${threadId} changed since revision ${expectedRevision}; it is at ${thread.revision}`,
      );
    }
    if (!allowed.includes(thread.status)) {
      throw new StoreRefusal(
        409,
        "thread_not_awaiting",
        `thread ${threadId} is ${thread.status}, so the agent cannot ${what} it`,
      );
    }
    return thread;
  }

  /** `reply_comment`: the thread is answered. Only a sent, read or answered thread. */
  agentReply(threadId: string, body: unknown, expectedRevision?: number): Thread {
    const thread = this.#forAgent(threadId, expectedRevision, ["sent", "read", "answered"], "answer");
    thread.comments.push({ id: this.#id("c"), author: "agent", body: this.#body(body), createdAt: this.#clock() });
    thread.status = "answered";
    delete thread.changedAfterSubmit;
    this.#emit(thread.target);
    return this.#out(thread);
  }

  /** `resolve_comment`: kept, as resolved, for the person to dismiss. The note is the tool's echo, not a comment. */
  agentResolve(threadId: string, expectedRevision?: number, _note?: string): Thread {
    const thread = this.#forAgent(threadId, expectedRevision, ["sent", "read", "answered", "resolved"], "resolve");
    thread.status = "resolved";
    delete thread.changedAfterSubmit;
    this.#emit(thread.target);
    return this.#out(thread);
  }

  /** The threads awaiting the agent without moving them: what `get_comments` would hand it. */
  submitted(): Thread[] {
    return this.#threads.filter((t) => t.status === "sent" || t.status === "read").map((t) => this.#out(t));
  }

  /** Marks a thread's anchor as gone, as the server does when its element is removed. */
  orphan(threadId: string): void {
    const thread = this.#thread(threadId);
    thread.orphaned = true;
    this.#emit(thread.target);
  }

  /** `api/notes/all`: every note, its diagrams named as the service names them (`<view>.mmd`). */
  allNotes(): {
    notes: (NoteSummary & {
      diagrams: string[];
      viewIds: string[];
      modifiedAt: string;
      description?: string;
      threads?: Record<Thread["status"], number>;
    })[];
  } {
    return {
      notes: this.notes.map(({ path, title, type, status, views, markdown, createdAt, createdFrom, modifiedAt }) => ({
        path,
        title,
        ...(type === undefined ? {} : { type }),
        ...(status === undefined ? {} : { status }),
        diagrams: views.map((view) => `${view}.mmd`).sort(),
        viewIds: [...views].sort(),
        ...this.#noteCounts(path),
        ...(createdAt === undefined ? {} : { createdAt, createdFrom: createdFrom ?? "filesystem" }),
        modifiedAt: modifiedAt ?? this.#made,
        // The service's own reading (ts/src/project/describe.ts).
        ...(noteDescription(markdown) ?? {}),
      })),
    };
  }

  #noteCounts(path: string): { threads?: Record<Thread["status"], number> } {
    const held = this.list(`note:${path}`);
    if (held.length === 0) return {};
    const threads = { draft: 0, sent: 0, read: 0, answered: 0, resolved: 0 };
    for (const thread of held) threads[thread.status]++;
    return { threads };
  }

  notesFor(viewId: string): NoteSummary[] {
    return this.notes
      .filter((note) => note.views.includes(viewId))
      .map(({ path, title, type, status }) => ({
        path,
        title,
        ...(type === undefined ? {} : { type }),
        ...(status === undefined ? {} : { status }),
      }));
  }

  note(path: string): NoteContent {
    const note = this.notes.find((n) => n.path === path);
    if (note === undefined) {
      throw new StoreRefusal(404, "note_not_found", `no note '${path}'`);
    }
    return { path, frontMatter: {}, markdown: note.markdown, revision: `r${note.markdown.length}` };
  }
}
