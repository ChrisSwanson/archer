/**
 * A test's own comment writes, made the only way the page makes them: as ADR 0016 operations, each with a new
 * identity. For tests that set up threads through a transport (`memoryTransport`, the HTTP transport against the
 * fake or the service) and then exercise something else.
 */
import { newOperation, newSubmitOperation } from "../../src/comments/operations";
import type {
  CommentContext,
  CommentOperation,
  NewThread,
  OperationAck,
  SubmitAck,
  SubmitOperation,
  SubmitResult,
  TargetRef,
  Thread,
} from "../../src/comments/contract";
import type { CommentsTransport } from "../../src/comments/transport";

const result = ({ submitted, problems }: SubmitResult): SubmitResult =>
  problems === undefined ? { submitted } : { submitted, problems };

export function commentWrites(transport: CommentsTransport) {
  return {
    async createThread(input: NewThread): Promise<Thread> {
      const ack = await transport.createThreadOnce(newOperation("comment.create", input.target), input);
      if (ack.thread === null) throw new Error("the new thread was not answered");
      return ack.thread;
    },
    async reply(thread: Pick<Thread, "id" | "target">, body: string, context?: CommentContext): Promise<Thread> {
      const ack = await transport.replyOnce(newOperation("comment.reply", thread.target), thread.id, body, context);
      if (ack.thread === null) throw new Error("the replied thread was not answered");
      return ack.thread;
    },
    async submit(target?: TargetRef): Promise<SubmitResult> {
      return result(await transport.submitOnce(newSubmitOperation(), target === undefined ? {} : { target }));
    },
    async submitThread(threadId: string, target: TargetRef): Promise<SubmitResult> {
      return result(await transport.submitOnce(newSubmitOperation(), { target, threadId }));
    },
  };
}

/** A fake transport's answer to a create or reply sent as an operation: `thread` committed under `operation`. */
export function ackOf(operation: CommentOperation, thread: Thread): OperationAck {
  return {
    operation: { id: operation.id, issuedAt: operation.issuedAt, name: operation.name },
    replayed: false,
    committed: {
      threadId: thread.id,
      commentId: thread.comments.at(-1)?.id ?? "c0",
      revision: thread.revision,
      committedAt: "2026-10-23T10:00:00.000Z",
    },
    thread,
  };
}

/** A fake transport's answer to a submit sent as an operation. */
export function submitAckOf(operation: SubmitOperation, submitted = 1): SubmitAck {
  return { operation, replayed: false, submitted };
}
