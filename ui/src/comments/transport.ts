import { browserFetch } from "../app/browser-resource";
import { projectResourceBase } from "../app/browser-routes";
import { bodyOf, type ResourcePolicy, resources } from "../app/resources";
/**
 * The page's side of the comments and notes routes (`ts/src/comments/contract.ts`).
 *
 * Relative URLs, like every other route this page reads: they resolve against
 * the project's API base, `/p/<name>/` (`browser-resource.ts`). Every answer is read
 * through `parse.ts` before the caller sees it, so a caller holds either what
 * the contract says or an error, never half of an answer.
 *
 * An interface, so the panel can be tested against a transport held in memory
 * and the browser test against a server that speaks the contract.
 */
import type {
  EmbeddedDiagramContent,
  CommentContext,
  CommentOperation,
  OperationAck,
  NewThread,
  NoteContent,
  NoteEmphasisRead,
  NotesForView,
  Pending,
  SubmitAck,
  SubmitOperation,
  TargetRef,
  Thread,
  ThreadList,
  UpsertNoteEmphasisInput,
} from "./contract";
import {
  parseDeleteResult,
  parseEmbeddedDiagram,
  parseNoteContent,
  parseNotesForView,
  parseOperationAck,
  parsePending,
  parseSubmitAck,
  parseThread,
  parseThreadList,
} from "./parse";
import { parseNoteEmphasisRead } from "./contract";

export type DeleteResult = { readonly deleted: true } | { readonly deleted: false; readonly thread: Thread };

export interface CommentsTransport {
  listThreads(target: TargetRef): Promise<ThreadList>;
  /**
   * A new thread sent as an operation (ADR 0016): the same operation sent again is answered from its receipt,
   * never a second thread.
   */
  createThreadOnce(operation: CommentOperation, input: NewThread): Promise<OperationAck>;
  /** A reply sent as an operation, the same way. */
  replyOnce(
    operation: CommentOperation,
    threadId: string,
    body: string,
    context?: CommentContext,
  ): Promise<OperationAck>;
  /**
   * The person's edit of their comment. `expectedRevision`, the thread revision the page last saw (O124): a thread
   * past it is refused `thread_changed` (409), so a change the page has not seen is never written over.
   */
  edit(threadId: string, commentId: string, body: string, expectedRevision?: number): Promise<Thread>;
  remove(threadId: string, commentId: string): Promise<DeleteResult>;
  /** The person resolving: the thread is removed at once. */
  resolve(threadId: string): Promise<void>;
  /** The person dismissing a thread the agent resolved: removed. */
  dismiss(threadId: string): Promise<void>;
  /** Every draft in the project, by target. */
  pending(): Promise<Pending>;
  /**
   * A submit sent as an operation (ADR 0016, O83): every draft (no scope), or one thread. The same operation
   * sent again is answered from its receipts, never sends a thread twice.
   */
  submitOnce(
    operation: SubmitOperation,
    scope: { readonly target?: TargetRef; readonly threadId?: string },
  ): Promise<SubmitAck>;
  listNotes(viewId: string): Promise<NotesForView>;
  noteContent(path: string): Promise<NoteContent>;
  noteEmphasis(path: string): Promise<NoteEmphasisRead>;
  upsertNoteEmphasis(input: UpsertNoteEmphasisInput): Promise<NoteEmphasisRead>;
  /**
   * A diagram embedded in a note, by its address (`<note>#<name>`), compiled. Given the model revision the page
   * knows, it shares the page's read of that answer (`sharedNoteDiagram`); without one it asks the service.
   */
  embeddedDiagram?(address: string, revision?: string): Promise<EmbeddedDiagramContent>;
}

/** A request the server answered with a refusal, or an answer the page cannot read. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The service's refusal code (`{ error: { code } }`), when it sent one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * A write whose outcome is not known: the request may have reached the service, but no answer came back
 * (the connection dropped, or the service failed while answering). Only an operation, which the service
 * deduplicates, may be sent again after one of these (ADR 0016).
 */
export class UncertainWriteError extends TransportError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "UncertainWriteError";
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The server's own words for a refusal, when it sent them (`{ error: { message } }`). */
async function refusal(response: Response, what: string): Promise<TransportError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // No JSON body: the status is all there is to say.
  }
  return refusalOf(response.status, body, what);
}
function refusalOf(status: number, answer: unknown, what: string): TransportError {
  const body = answer as { error?: { message?: unknown; code?: unknown } } | null | undefined;
  const message = body?.error?.message;
  return new TransportError(
    typeof message === "string" && message !== "" ? message : `${what} failed with HTTP ${status}`,
    status,
    typeof body?.error?.code === "string" ? body.error.code : undefined,
  );
}

function readable<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new TransportError(`could not read the answer to ${what}`);
  }
  return value;
}

export function httpCommentsTransport(
  fetchImpl: FetchLike = (url, init) => browserFetch(url, init),
  canWrite: () => boolean = () => true,
): CommentsTransport {
  const call = async (what: string, url: string, method = "GET", body?: unknown): Promise<unknown> => {
    if (method !== "GET" && !canWrite()) {
      throw new TransportError(
        "Waiting for Archer to reconnect. Your text is still in the box; add it once Archer is back.",
        undefined,
        "not_sent",
      );
    }
    // Every write is JSON, a body-less delete included: a cookie-admitted page may write only so (ADR 0017).
    const payload = body === undefined && method !== "GET" ? {} : body;
    const init: RequestInit =
      payload === undefined
        ? { method, cache: "no-store" }
        : { method, cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
    const response = await fetchImpl(url, init);
    if (!response.ok) {
      throw await refusal(response, what);
    }
    return (await response.json()) as unknown;
  };
  /** An operation's POST: a dropped connection or a failure while answering is uncertain, not a refusal. */
  const uncertain = async (what: string, url: string, body: unknown): Promise<unknown> => {
    let answer: unknown;
    try {
      answer = await call(what, url, "POST", body);
    } catch (failure) {
      if (failure instanceof TransportError && failure.status !== undefined && failure.status < 500) throw failure;
      if (failure instanceof TransportError && failure.code === "not_sent") throw failure;
      throw new UncertainWriteError(
        failure instanceof Error && failure.message !== "" ? failure.message : "no answer",
        failure instanceof TransportError ? failure.status : undefined,
      );
    }
    return answer;
  };
  /** A create or reply sent as an operation. */
  const once = async (what: string, url: string, body: unknown): Promise<OperationAck> =>
    readable(parseOperationAck(await uncertain(what, url, body)), what);
  const segment = encodeURIComponent;
  const query = (params: Record<string, string>): string => new URLSearchParams(params).toString();

  return {
    async listThreads(target) {
      return readable(
        parseThreadList(await call("reading comments", `api/comments?${query({ target })}`)),
        "reading comments",
      );
    },
    async createThreadOnce(operation, input) {
      return once("adding a comment", "api/comments", { operation, payload: input });
    },
    async replyOnce(operation, threadId, body, context) {
      return once("replying", `api/comments/${segment(threadId)}/replies`, {
        operation,
        payload: context === undefined ? { body } : { body, context },
      });
    },
    async edit(threadId, commentId, body, expectedRevision) {
      const url = `api/comments/${segment(threadId)}/${segment(commentId)}`;
      return readable(
        parseThread(
          await call(
            "editing a comment",
            url,
            "PATCH",
            expectedRevision === undefined ? { body } : { body, expectedRevision },
          ),
        ),
        "editing a comment",
      );
    },
    async remove(threadId, commentId) {
      const url = `api/comments/${segment(threadId)}/${segment(commentId)}`;
      return readable(parseDeleteResult(await call("deleting a comment", url, "DELETE")), "deleting a comment");
    },
    async resolve(threadId) {
      await call("resolving a thread", `api/comments/${segment(threadId)}/resolve`, "POST", {});
    },
    async dismiss(threadId) {
      await call("dismissing a thread", `api/comments/${segment(threadId)}/dismiss`, "POST", {});
    },
    async pending() {
      return readable(
        parsePending(await call("reading what waits to be sent", "api/comments/pending")),
        "reading what waits to be sent",
      );
    },
    async submitOnce(operation, scope) {
      const payload = {
        ...(scope.target === undefined ? {} : { target: scope.target }),
        ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
      };
      return readable(
        parseSubmitAck(await uncertain("submitting comments", "api/comments/submit", { operation, payload })),
        "submitting comments",
      );
    },
    async listNotes(viewId) {
      return readable(
        parseNotesForView(await call("reading notes", `api/notes?${query({ viewId })}`)),
        "reading notes",
      );
    },
    async noteContent(path) {
      return readable(
        parseNoteContent(await call("reading a note", `api/notes/content?${query({ path })}`)),
        "reading a note",
      );
    },
    async noteEmphasis(path) {
      const read = readable(
        parseNoteEmphasisRead(await call("reading note highlights", `api/note-emphases?${query({ path })}`)),
        "reading note highlights",
      );
      if (read.snapshot.notePath !== path) throw new TransportError("the note highlights named another note");
      return read;
    },
    async upsertNoteEmphasis(input) {
      const read = readable(
        parseNoteEmphasisRead(
          await call("saving note highlights", `api/note-emphases?${query({ path: input.notePath })}`, "POST", input),
        ),
        "saving note highlights",
      );
      if (read.snapshot.notePath !== input.notePath)
        throw new TransportError("the saved note highlights named another note");
      return read;
    },
    async embeddedDiagram(address, revision) {
      // A reader that knows no model revision (a note's figures) asks the service itself.
      const answer =
        revision === undefined
          ? await call("reading a diagram in a note", noteDiagramUrl(address))
          : await sharedNoteDiagram(address, revision, fetchImpl);
      return readable(parseEmbeddedDiagram(answer), "reading a diagram in a note");
    },
  };
}

const noteDiagramUrl = (address: string): string => `api/notes/diagram?${new URLSearchParams({ address }).toString()}`;
const noteDiagramPolicy: ResourcePolicy<unknown> = {
  kind: "notes",
  freshMs: 2000,
  revision: (answer) => answeredRevision(answer),
  parse: (raw, response) => {
    if (!response.ok) throw refusalOf(response.status, raw, "reading a diagram in a note");
    return raw;
  },
};
/**
 * The page's one read of a note's diagram (`api/notes/diagram`), the raw answer: the header's freshness and the
 * Source panel ask the same question, and share the answer at the model revision the page knows (`resources.ts`).
 * Whichever reader asks first makes the request, with its own fetch.
 */
export async function sharedNoteDiagram(
  address: string,
  known: string | undefined,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const project = typeof window === "undefined" ? null : projectResourceBase(window.location.href);
  return bodyOf(
    await resources.read(`notes-diagram:${project ?? ""}:${address}`, noteDiagramPolicy, {
      url: noteDiagramUrl(address),
      fetch: fetchImpl,
      revision: known,
    }),
  );
}

/** The model revision an answer was read at: the source route names it, a note's diagram carries its drawing's. */
export function answeredRevision(answer: unknown): string | undefined {
  const body = answer as { modelRevision?: unknown; envelope?: { revision?: unknown } | null } | null;
  const revision = body?.modelRevision ?? body?.envelope?.revision;
  return typeof revision === "string" ? revision : undefined;
}
