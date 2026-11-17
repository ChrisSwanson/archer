// @vitest-environment jsdom
//
// Whose operation is whose (codex-301, O114). An uncertain create or reply keeps its identity with the draft it
// was sent from and that draft's owner (draft-tabs.ts), not with its words: two tabs that each type the same words
// write two comments; a retry in the same tab, a reload, and a tab that takes a closed tab's draft over each send
// the identity that draft was sent under, so the service answers from its receipt and writes it once.
// Both creates and replies, in both submission modes (queued: the service keeps a draft; immediate: it sends it).
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import {
  claimDraft,
  takeDraft,
  commentDraftKey,
  commentDraftScope,
  keepCommentDraft,
  keepReplyDraft,
  readCommentDraft,
  readReplyDraft,
  replyDraftKey,
} from "../src/comments/comment-draft";
import { setTabIdForTests } from "../src/comments/draft-tabs";
import type { Capabilities, CommentOperation, OperationAck, Thread } from "../src/comments/contract";
import { UncertainWriteError } from "../src/comments/transport";
import { createKey, operationHold, replyKey } from "../src/comments/operations";
import { memoryTransport } from "./support/memory-transport";
import { steppedRetries } from "./support/retry-clock";
import { NO_CAPABILITIES } from "../src/comments/contract";

const OPS: Capabilities = { ...NO_CAPABILITIES, comments: true, notes: false };
const anchor = { kind: "view" } as const;
const A = "aaaaaaaaaaaaaaaa",
  B = "bbbbbbbbbbbbbbbb";

/** A service that keeps receipts; its next `lose` answers are dropped after commit. `immediate` sends at once. */
function service(immediate: boolean) {
  const transport = memoryTransport();
  const receipts = new Map<string, OperationAck>();
  const sent: CommentOperation[] = [];
  const control = { lose: 0 };
  const commit = (operation: CommentOperation, make: () => Thread): OperationAck => {
    sent.push(operation);
    const held = receipts.get(operation.id);
    const ack: OperationAck =
      held === undefined
        ? (() => {
            const made = make();
            const thread = immediate ? { ...made, status: "sent" as const } : made;
            const first: OperationAck = {
              operation: { id: operation.id, issuedAt: operation.issuedAt, name: operation.name },
              replayed: false,
              committed: {
                threadId: thread.id,
                commentId: thread.comments.at(-1)!.id,
                revision: thread.revision,
                committedAt: thread.comments.at(-1)!.createdAt,
              },
              thread,
            };
            receipts.set(operation.id, first);
            return first;
          })()
        : { ...held, replayed: true };
    if (control.lose > 0) {
      control.lose -= 1;
      throw new UncertainWriteError("Failed to fetch");
    }
    return structuredClone(ack);
  };
  transport.createThreadOnce = async (operation, input) => {
    await Promise.resolve();
    return commit(operation, () => transport.store.create(input));
  };
  transport.replyOnce = async (operation, threadId, body) => {
    await Promise.resolve();
    return commit(operation, () => transport.store.reply(threadId, body));
  };
  return { transport, sent, control };
}

/** One tab's page: its owner id, then a review model. */
function tab(owner: string, transport: ReturnType<typeof memoryTransport>) {
  setTabIdForTests(owner);
  const events = createReviewEvents();
  return renderHook(() => useReview({ transport, capabilities: OPS, viewId: "v", events }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setTabIdForTests(null);
});

type Kind = "create" | "reply";
const heldKey = (kind: Kind, thread: Thread | null): string =>
  kind === "create" ? createKey("view:v", anchor, "Adopt me") : replyKey("view:v", thread!.id, "Adopt me");
/**
 * Sends `body` as `kind` from the page `page` (its tab made current first). `unanswered`: every try gets no answer,
 * so the page retries on its own; its clock is stepped (support/retry-clock.ts) and every try counted by `tries`.
 */
async function send(
  kind: Kind,
  owner: string,
  page: ReturnType<typeof tab>,
  thread: Thread | null,
  body: string,
  unanswered?: { readonly tries: () => number },
): Promise<void> {
  setTabIdForTests(owner);
  const write = async () => {
    if (kind === "create") await page.result.current.actions.create("view:v", anchor, body);
    else await page.result.current.actions.reply(thread!, body);
  };
  await act(async () => {
    if (unanswered === undefined) await write();
    else await steppedRetries(write, unanswered.tries, 3);
  });
}
/** Every try of a write got no answer: three sends of one identity, the retries at the page's own delays. */
const allLost = (sent: readonly CommentOperation[]) => ({ tries: () => sent.length });
/** The identities sent from `from` on: one, the same for every try. */
const oneIdentity = (sent: readonly CommentOperation[], from: number) =>
  expect(new Set(sent.slice(from).map((o) => o.id)).size).toBe(1);
const count = (kind: Kind, transport: ReturnType<typeof memoryTransport>): number =>
  kind === "create" ? transport.store.list("view:v").length : transport.store.list("view:v")[0]!.comments.length - 1;

describe.each([
  ["queued", false],
  ["immediate", true],
] as const)("%s", (_mode, immediate) => {
  describe.each(["create", "reply"] as const)("%s", (kind) => {
    const setup = () => {
      const s = service(immediate);
      const thread = kind === "reply" ? s.transport.store.create({ target: "view:v", anchor, body: "Root" }) : null;
      return { ...s, thread };
    };
    const ready = async (page: ReturnType<typeof tab>) => {
      await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(kind === "reply" ? 1 : 0));
    };

    it("two tabs that each type the same words: two operations, two comments", async () => {
      const { transport, sent, control, thread } = setup();
      const a = tab(A, transport);
      await ready(a);
      const b = tab(B, transport);
      await ready(b);
      control.lose = 10;
      await send(kind, A, a, thread, "Same words", allLost(sent));
      oneIdentity(sent, 0);
      expect(a.result.current.error).toMatch(/may have been sent/);
      control.lose = 0;
      await send(kind, B, b, thread, "Same words");
      expect(b.result.current.error).toBeNull();
      // A's own next try is answered from its receipt.
      await send(kind, A, a, thread, "Same words");
      expect(a.result.current.error).toBeNull();
      expect(new Set(sent.map((o) => o.id)).size).toBe(2);
      expect(count(kind, transport)).toBe(2);
    });

    it("the same tab tries again: the same operation, one comment", async () => {
      const { transport, sent, control, thread } = setup();
      const a = tab(A, transport);
      await ready(a);
      control.lose = 10;
      await send(kind, A, a, thread, "Retry me", allLost(sent));
      oneIdentity(sent, 0);
      control.lose = 0;
      await send(kind, A, a, thread, "Retry me");
      expect(new Set(sent.map((o) => o.id)).size).toBe(1);
      expect(count(kind, transport)).toBe(1);
    });

    it("the tab is reloaded (its owner is kept): the same operation, one comment", async () => {
      const { transport, sent, control, thread } = setup();
      const a = tab(A, transport);
      await ready(a);
      control.lose = 10;
      await send(kind, A, a, thread, "Reload me", allLost(sent));
      oneIdentity(sent, 0);
      a.unmount();
      control.lose = 0;
      const again = tab(A, transport);
      await waitFor(() => expect(again.result.current.threads.get("view:v")).toHaveLength(1));
      await send(kind, A, again, thread, "Reload me");
      expect(new Set(sent.map((o) => o.id)).size).toBe(1);
      expect(count(kind, transport)).toBe(1);
    });

    it("a closed tab's draft taken over by another: the identity moves with it, one comment", async () => {
      const { transport, sent, control, thread } = setup();
      const scope = commentDraftScope();
      const a = tab(A, transport);
      await ready(a);
      if (kind === "create")
        keepCommentDraft(localStorage, {
          version: 1,
          scope,
          target: "view:v",
          anchor,
          body: "Adopt me",
          baseRevision: null,
          savedAt: Date.now(),
        });
      else
        keepReplyDraft(localStorage, {
          version: 1,
          scope,
          target: "view:v",
          threadId: thread!.id,
          body: "Adopt me",
          savedAt: Date.now(),
        });
      control.lose = 10;
      await send(kind, A, a, thread, "Adopt me", allLost(sent));
      oneIdentity(sent, 0);
      a.unmount(); // A is closed: nothing answers for it on the tabs channel.
      control.lose = 0;
      setTabIdForTests(B);
      const key =
        kind === "create" ? commentDraftKey(scope, "view:v", anchor) : replyDraftKey(scope, "view:v", thread!.id);
      const claim = await claimDraft(localStorage, key);
      expect(claim.offer).not.toBeNull();
      expect(await takeDraft(localStorage, key, claim.offer!)).toBe(true);
      expect(
        kind === "create"
          ? readCommentDraft(localStorage, scope, "view:v", anchor)?.body
          : readReplyDraft(localStorage, scope, "view:v", thread!.id)?.body,
      ).toBe("Adopt me");
      // A no longer holds that identity: it went with the draft.
      setTabIdForTests(A);
      expect(operationHold(localStorage, scope).has(heldKey(kind, thread))).toBe(false);
      setTabIdForTests(B);
      expect(operationHold(localStorage, scope).has(heldKey(kind, thread))).toBe(true);
      const b = tab(B, transport);
      await waitFor(() => expect(b.result.current.threads.get("view:v")).toHaveLength(1));
      await send(kind, B, b, thread, "Adopt me");
      expect(new Set(sent.map((o) => o.id)).size).toBe(1);
      expect(count(kind, transport)).toBe(1);
    });
  });
});

describe("the words corrected after a lost answer (claude-304)", () => {
  it.each(["create", "reply"] as const)(
    "%s: the earlier version is found and said before a second one is added",
    async (kind) => {
      const s = service(false);
      const thread = kind === "reply" ? s.transport.store.create({ target: "view:v", anchor, body: "Root" }) : null;
      const a = tab(A, s.transport);
      await waitFor(() => expect(a.result.current.threads.get("view:v")).toHaveLength(kind === "reply" ? 1 : 0));
      s.control.lose = 10;
      await send(kind, A, a, thread, "Teh typo", allLost(s.sent));
      oneIdentity(s.sent, 0);
      expect(a.result.current.error).toMatch(/may have been sent/);
      s.control.lose = 0;
      await send(kind, A, a, thread, "The typo");
      expect(a.result.current.error).toMatch(/An earlier version of this (comment|reply) was added .*“Teh typo”/);
      expect(count(kind, s.transport)).toBe(1);
      // The person was told; adding it again is their choice, and adds it once.
      await send(kind, A, a, thread, "The typo");
      expect(a.result.current.error).toBeNull();
      expect(count(kind, s.transport)).toBe(2);
    },
  );

  it("the earlier version did not land: the corrected one is added at once, once", async () => {
    const s = service(false);
    const a = tab(A, s.transport);
    await waitFor(() => expect(a.result.current.threads.get("view:v")).toEqual([]));
    // Every try of the first version is lost before it reaches Archer: nothing is stored.
    const real = s.transport.createThreadOnce!;
    let lost = 0;
    s.transport.createThreadOnce = async () => {
      lost += 1;
      throw new UncertainWriteError("Failed to fetch");
    };
    await send("create", A, a, null, "Teh typo", { tries: () => lost });
    s.transport.createThreadOnce = real;
    await send("create", A, a, null, "The typo");
    expect(a.result.current.error).toBeNull();
    expect(count("create", s.transport)).toBe(1);
  });
});
