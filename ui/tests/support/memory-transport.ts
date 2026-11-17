/**
 * The page's `CommentsTransport` over the in-memory `CommentsStore`, for jsdom
 * unit tests: what the panel is tested against is what
 * `comments-contract.test.ts` holds to the contract, beside the service.
 *
 * Every answer is a deep copy that arrives on a later microtask, as a real
 * response would; `fail` makes the next call of one method refuse.
 */
import { CommentsStore, StoreRefusal, type StoreNote } from "./comments-store";
import type { CommentContext } from "../../src/comments/contract";
import type { CommentsTransport } from "../../src/comments/transport";
import { TransportError } from "../../src/comments/transport";

/**
 * As the service stores it: the page sends `context.document` relative to the Archer folder (`.archer/`), and
 * the service keeps it relative to the project (`comments-contract.test.ts` holds this transport to that).
 */
function projectRelative(context: CommentContext): CommentContext {
  const document = context.document;
  if (document === undefined || document === "" || document.startsWith("/") || document.split("/").includes(".."))
    return context;
  return { ...context, document: `.archer/${document}` };
}

export type MemoryTransport = CommentsTransport & {
  readonly store: CommentsStore;
  readonly calls: string[];
  fail(method: keyof CommentsTransport, message: string): void;
};

export function memoryTransport(notes: StoreNote[] = []): MemoryTransport {
  const store = new CommentsStore({ notes, clock: () => "2026-10-03T10:00:00.000Z" });
  const calls: string[] = [];
  const failures = new Map<string, string>();

  const run = async <T>(method: keyof CommentsTransport, work: () => T): Promise<T> => {
    calls.push(method);
    await Promise.resolve();
    const failure = failures.get(method);
    if (failure !== undefined) {
      failures.delete(method);
      throw new TransportError(failure, 500);
    }
    try {
      return structuredClone(work());
    } catch (error) {
      if (error instanceof StoreRefusal) throw new TransportError(error.message, error.status, error.code);
      throw error;
    }
  };

  return {
    store,
    calls,
    fail(method, message) {
      failures.set(method, message);
    },
    listThreads: (target) =>
      run("listThreads", () => ({ schemaVersion: 2 as const, target, threads: store.list(target) })),
    createThreadOnce: (operation, input) =>
      run("createThreadOnce", () =>
        store.createOnce(
          operation,
          input.context === undefined ? input : { ...input, context: projectRelative(input.context) },
        ),
      ),
    replyOnce: (operation, threadId, body, context) =>
      run("replyOnce", () =>
        store.replyOnce(operation, threadId, body, context === undefined ? undefined : projectRelative(context)),
      ),
    edit: (threadId, commentId, body, expectedRevision) =>
      run("edit", () => store.edit(threadId, commentId, body, expectedRevision)),
    remove: (threadId, commentId) =>
      run("remove", () => {
        const result = store.remove(threadId, commentId);
        return "deleted" in result ? { deleted: true as const } : { deleted: false as const, thread: result };
      }),
    resolve: (threadId) => run("resolve", () => void store.resolve(threadId)),
    dismiss: (threadId) => run("dismiss", () => void store.dismiss(threadId)),
    pending: () => run("pending", () => store.pending()),
    submitOnce: (operation, scope) =>
      run("submitOnce", () => store.submitOnce(operation, scope.target, scope.threadId)),
    listNotes: (viewId) => run("listNotes", () => ({ viewId, notes: store.notesFor(viewId) })),
    noteContent: (path) => run("noteContent", () => store.note(path)),
    noteEmphasis: (path) =>
      run("noteEmphasis", () => ({
        snapshot: { schemaVersion: 1 as const, notePath: path, revision: 0, emphases: [] },
        orphans: [],
      })),
    upsertNoteEmphasis: (input) =>
      run("upsertNoteEmphasis", () => {
        throw new StoreRefusal(422, "invalid_request", `the memory transport keeps no highlights (${input.notePath})`);
      }),
  };
}
