// Browser-safe: the live service and the playground overlay summarize threads the same way.
import type { Thread } from "../ts/src/comments/contract.ts";

/** The comment activity shown beside one registered view or listed note. */
export interface CommentActivity {
  readonly totalThreads: number;
  readonly unresolvedThreads: number;
  readonly lastCommentedAt: string | null;
  /** The agent's comments, by thread and id: what the bell counts as answers without reading the threads (PF-2).
   * Absent when there are none. */
  readonly agentComments?: readonly { readonly thread: string; readonly comment: string }[];
}

/** The private UI response for all current commentable targets in one project. */
export interface CommentActivityPayload {
  readonly schemaVersion: 1;
  /** Every target lists its agent comments (`agentComments`); one with none has no list. */
  readonly agentCommentsListed: true;
  readonly targets: Readonly<Record<string, CommentActivity>>;
}

/** Summarizes the retained threads of one target without changing their lifecycle. */
export function commentActivity(threads: readonly Thread[]): CommentActivity {
  let lastTime = Number.NEGATIVE_INFINITY;
  const agentComments: { thread: string; comment: string }[] = [];
  for (const thread of threads) {
    for (const comment of thread.comments) {
      const posted = Date.parse(comment.createdAt);
      if (!Number.isNaN(posted) && posted > lastTime) lastTime = posted;
      if (comment.author === "agent") agentComments.push({ thread: thread.id, comment: comment.id });
    }
  }
  return {
    totalThreads: threads.length,
    unresolvedThreads: threads.filter((thread) => thread.status !== "resolved").length,
    lastCommentedAt: Number.isFinite(lastTime) ? new Date(lastTime).toISOString() : null,
    ...(agentComments.length === 0 ? {} : { agentComments }),
  };
}
