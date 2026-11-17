/**
 * Sending from the chat bubble (ADR 0034 §10): make the message (a reply, or a new thread), then
 * submit that one thread. Other drafts stay drafts. Nothing here knows about React.
 *
 * The create, the reply and the submit are ADR 0016 operations sent
 * through the review controls' own path (`comments/operations.ts`, codex-202, O100): an unanswered one is resent
 * with the same identity, a still-uncertain outcome is said as uncertain, and the person's next Send of the same
 * text reuses it (`ChatIntent`, kept with the draft), so a lost answer never becomes a second comment.
 */
import type { Anchor, CommentContext, SubmitOperation, TargetRef, Thread } from "../comments/contract";
import type { CommentsTransport } from "../comments/transport";
import type { ChatDraftIntent } from "../comments/comment-draft";
import { failureMessage, newOperation, settle, submitThreadOnce, uncertainWords } from "../comments/operations";

/** `context`: the page, and the file on a diagram or note page, the person sent it from (the agent is told). */
export type ChatAsk = {
  readonly target: TargetRef;
  readonly anchor: Anchor;
  readonly thread?: Thread;
  readonly body: string;
  readonly context?: CommentContext;
};

/** A create or reply whose outcome is not known: sent again as it is (same identity) while the text is the same. */
export type ChatIntent = ChatDraftIntent;

export type SendOutcome =
  | { readonly status: "sent"; readonly threadId: string; readonly thread?: Thread; readonly alsoSent: number }
  /** Saved but not published: the message is a draft ("Not sent · Retry"). */
  | { readonly status: "failed"; readonly threadId: string; readonly thread?: Thread; readonly reason: string }
  /** Not even saved: the text stays in the box. `intent`: refused after it may have landed, so still kept. */
  | { readonly status: "unsaved"; readonly reason: string; readonly intent?: ChatIntent }
  /** No answer to the create or reply: the text stays, and `intent` is what the next Send repeats. */
  | { readonly status: "unsure"; readonly stage: "save"; readonly reason: string; readonly intent: ChatIntent }
  /**
   * The text was changed after a Send whose outcome is not known (claude-304): Archer was read first. `landed`: the
   * earlier version was found there (said, and the next Send adds this one as a second message); null: it could not
   * be read, so nothing is sent and the earlier identity is kept.
   */
  | { readonly status: "earlier"; readonly landed: string | null; readonly reason: string }
  /** Saved, and no answer to the submit; the service still holds it as a draft (or could not be read): Retry. */
  | {
      readonly status: "unsure";
      readonly stage: "submit";
      readonly threadId: string;
      readonly thread?: Thread;
      readonly reason: string;
    };

export interface ChatSendOptions {
  /** What an earlier Send left uncertain; reused when its text is the text sent now. */
  readonly held?: ChatIntent | null;
  /** Submit identities kept while uncertain, by thread (`threadSubmitKey`). */
  readonly submits?: Map<string, SubmitOperation>;
  readonly active?: () => boolean;
}

/** Submit identities, for the page's life: a chat remounts with its document, an uncertain submit must not. */
const pageSubmits = new Map<string, SubmitOperation>();

const why = failureMessage;

/** A draft already on the thread (from the review panel) goes out with the new message. */
export const alsoSends = (thread: Thread | undefined): number => (thread?.status === "draft" ? 1 : 0);

async function publish(
  transport: CommentsTransport,
  target: TargetRef,
  threadId: string,
  thread: Thread | undefined,
  alsoSent: number,
  options: ChatSendOptions,
): Promise<SendOutcome> {
  const held = thread === undefined ? {} : { thread };
  const out = await submitThreadOnce(transport, options.submits ?? pageSubmits, target, threadId, options.active);
  if (out.kind === "sent") return { status: "sent", threadId, ...held, alsoSent };
  if (out.kind === "refused") return { status: "failed", threadId, ...held, reason: why(out.failure) };
  const reason = out.offline
    ? "This browser is offline, so this message may not have been sent. It is saved; Retry once you are back online sends it once, never twice."
    : `Archer did not answer, so this message may not have been sent (${why(out.failure)}). It is saved; Retry sends it once, never twice.`;
  return {
    status: "unsure",
    stage: "submit",
    threadId,
    ...(out.thread === undefined ? held : { thread: out.thread }),
    reason,
  };
}

/** The create or reply this Send makes: the held one when its text is this text, else a new identity. */
function intentFor(ask: ChatAsk, held: ChatIntent | null | undefined): ChatIntent {
  if (held != null && held.body === ask.body && held.operation.target === ask.target) return held;
  return ask.thread === undefined
    ? { kind: "create", threadId: null, body: ask.body, operation: newOperation("comment.create", ask.target) }
    : { kind: "reply", threadId: ask.thread.id, body: ask.body, operation: newOperation("comment.reply", ask.target) };
}

/** Whether the held, uncertain message's own words are on the service now; null when it cannot be read. */
async function heldLanded(transport: CommentsTransport, held: ChatIntent): Promise<boolean | null> {
  let threads: readonly Thread[];
  try {
    threads = (await transport.listThreads(held.operation.target)).threads;
  } catch {
    return null;
  }
  const mine = (thread: Thread, from: number): boolean =>
    thread.comments.slice(from).some((c) => c.author === "person" && c.body === held.body);
  return held.kind === "create"
    ? threads.some((t) => mine(t, 0) && t.comments[0]?.body === held.body)
    : threads.some((t) => t.id === held.threadId && mine(t, 1));
}

export async function sendChat(
  transport: CommentsTransport,
  ask: ChatAsk,
  options: ChatSendOptions = {},
): Promise<SendOutcome> {
  const where = ask.context === undefined ? {} : { context: ask.context };
  // A message that may already have been sent, then changed: never a second message without saying so (claude-304).
  const held = options.held;
  if (held != null && held.body !== ask.body && held.operation.target === ask.target) {
    const landed = await heldLanded(transport, held);
    if (landed === null)
      return {
        status: "earlier",
        landed: null,
        reason:
          "An earlier version of this message may already have been sent, and Archer could not be read to check. Your text is kept; Send checks again.",
      };
    if (landed)
      return {
        status: "earlier",
        landed: held.body,
        reason: `An earlier version of this message was sent when Archer did not answer: “${held.body}”. Your text is kept; Send again sends it as a second message.`,
      };
  }
  const intent = intentFor(ask, options.held);
  // A held create stays a create even if the thread it made is on screen now: replying would add it twice.
  const out = await settle(
    intent.operation,
    (operation) =>
      intent.kind === "create"
        ? transport.createThreadOnce(operation, { target: ask.target, anchor: ask.anchor, body: ask.body, ...where })
        : transport.replyOnce(operation, intent.threadId!, ask.body, ask.context),
    options.active,
  );
  if (out.kind === "uncertain")
    return { status: "unsure", stage: "save", reason: uncertainWords("message", out.failure, out.offline), intent };
  if (out.kind === "refused") {
    const mayHaveLanded = !out.ended && (out.afterUncertain || intent === options.held);
    return { status: "unsaved", reason: why(out.failure), ...(mayHaveLanded ? { intent } : {}) };
  }
  const thread = out.ack.thread ?? undefined;
  return publish(
    transport,
    ask.target,
    out.ack.committed.threadId,
    thread,
    intent.kind === "reply" ? alsoSends(ask.thread) : 0,
    options,
  );
}

/** "Not sent · Retry": the draft is there already, so only the submit is repeated (with its kept identity). */
export async function retryChat(
  transport: CommentsTransport,
  target: TargetRef,
  threadId: string,
  options: ChatSendOptions = {},
): Promise<SendOutcome> {
  return publish(transport, target, threadId, undefined, 0, options);
}
