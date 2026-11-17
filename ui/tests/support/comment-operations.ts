/**
 * The page's comment writes as it sends them (ADR 0016, `src/comments/transport.ts`): each an operation,
 * `{ operation, payload }`, answered with a receipt. A create's or reply's answer is an OperationAck, whose
 * `thread` is the thread as it is now; a submit's is a SubmitAck (`submitted`, `replayed`).
 */
import { randomBytes } from "node:crypto";

/** A fresh operation identity: a 128-bit client nonce as 32 lowercase hex, and the time now. */
function identity(): { id: string; issuedAt: number } {
  return { id: randomBytes(16).toString("hex"), issuedAt: Date.now() };
}

export const commentOperation = {
  /** POST api/comments: a NewThread (`{ target, anchor, body, context? }`). */
  create: (input: { readonly target: string } & Record<string, unknown>) => ({
    operation: { ...identity(), name: "comment.create", target: input.target },
    payload: input,
  }),
  /** POST api/comments/<id>/replies: `{ body, context? }`, on the thread's target. */
  reply: (target: string, payload: { readonly body: string } & Record<string, unknown>) => ({
    operation: { ...identity(), name: "comment.reply", target },
    payload,
  }),
  /** POST api/comments/submit: `{ target?, threadId? }`. */
  submit: (payload: { readonly target?: string; readonly threadId?: string } = {}) => ({
    operation: { ...identity(), name: "comment.submit" },
    payload,
  }),
};
