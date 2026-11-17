// @vitest-environment jsdom
//
// The page's comment operations (ADR 0016, O67) and what it says after a write (O69), through `useReview`:
// - an answer lost after the service committed is sent again with the SAME operation, so the receipt answers
//   it and there is one comment, and the page does not say "Could not add";
// - still no answer: the page says the comment may have been sent, keeps the text, and the person's next try
//   reuses the identity (still one comment);
// - a new comment with identical text is a new operation (two comments);
// - a comment the service sent at once (comment_submission = "immediate") is announced as sent, not a draft.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import type {
  Capabilities,
  CommentOperation,
  OperationAck,
  SubmitAck,
  SubmitOperation,
  Thread,
} from "../src/comments/contract";
import { TransportError, UncertainWriteError } from "../src/comments/transport";
import { memoryTransport } from "./support/memory-transport";
import { steppedRetries } from "./support/retry-clock";
import { NO_CAPABILITIES } from "../src/comments/contract";

const OPS: Capabilities = { ...NO_CAPABILITIES, comments: true, notes: false };
const anchor = { kind: "view" } as const;

/** A memory transport whose service keeps receipts, and whose next `lose` answers are dropped after commit. */
function receiptTransport() {
  const transport = memoryTransport();
  const receipts = new Map<string, OperationAck>();
  const sent: CommentOperation[] = [];
  const control = { lose: 0, sendAtOnce: false };
  const commit = (operation: CommentOperation, make: () => Thread): OperationAck => {
    sent.push(operation);
    const held = receipts.get(operation.id);
    const ack: OperationAck =
      held === undefined
        ? (() => {
            const thread = make();
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
        : {
            ...held,
            replayed: true,
            thread: transport.store.list(operation.target).find((t) => t.id === held.committed.threadId) ?? null,
          };
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

function mount(transport: ReturnType<typeof memoryTransport>, capabilities: Capabilities = OPS) {
  const events = createReviewEvents();
  return renderHook(() => useReview({ transport, capabilities, viewId: "v", events }));
}

describe("a comment whose answer was lost", () => {
  it("is sent again with the same operation: one comment, and no 'Could not add'", async () => {
    const { transport, sent, control } = receiptTransport();
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    control.lose = 1;
    let created: Thread | null = null;
    await act(async () => {
      created = await steppedRetries(
        () => result.current.actions.create("view:v", anchor, "Why?"),
        () => sent.length,
        2,
      );
    });
    expect(created).not.toBeNull();
    expect(sent.map((o) => o.id)).toEqual([sent[0]!.id, sent[0]!.id]);
    expect(transport.store.list("view:v")).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(result.current.announcement?.text).toBe("Comment saved as a draft.");
  });

  it("still unanswered: says it may have been sent, keeps the identity, and the next try is still one comment", async () => {
    const { transport, sent, control } = receiptTransport();
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    control.lose = 10;
    let created: Thread | null = null;
    await act(async () => {
      created = await steppedRetries(
        () => result.current.actions.create("view:v", anchor, "Why?"),
        () => sent.length,
        3,
      );
    });
    expect(new Set(sent.map((o) => o.id)).size).toBe(1);
    expect(created).toBeNull();
    expect(result.current.error).toMatch(/may have been sent/);
    expect(result.current.error).not.toMatch(/could not add/i);
    control.lose = 0;
    await act(async () => {
      created = await result.current.actions.create("view:v", anchor, "Why?");
    });
    expect(created).not.toBeNull();
    expect(new Set(sent.map((o) => o.id)).size).toBe(1);
    expect(transport.store.list("view:v")).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("a new comment with identical text after it landed is a new operation: two comments", async () => {
    const { transport, sent } = receiptTransport();
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    await act(async () => {
      await result.current.actions.create("view:v", anchor, "Why?");
    });
    await act(async () => {
      await result.current.actions.create("view:v", anchor, "Why?");
    });
    expect(new Set(sent.map((o) => o.id)).size).toBe(2);
    expect(transport.store.list("view:v")).toHaveLength(2);
  });

  it("a reply whose answer was lost is one reply", async () => {
    const { transport, sent, control } = receiptTransport();
    const thread = transport.store.create({ target: "view:v", anchor, body: "Root" });
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toHaveLength(1));
    control.lose = 1;
    let ok = false;
    await act(async () => {
      ok = await steppedRetries(
        () => result.current.actions.reply(thread, "And?"),
        () => sent.length,
        2,
      );
    });
    expect(new Set(sent.map((o) => o.id)).size).toBe(1);
    expect(ok).toBe(true);
    expect(transport.store.list("view:v")[0]!.comments).toHaveLength(2);
    expect(result.current.announcement?.text).toBe("Reply saved as a draft.");
  });
});

describe("the identity outlives the page (claude-202, O102)", () => {
  it("a lost create, then a reload (a new review model): adding the same text is the same operation, one comment", async () => {
    window.localStorage.clear();
    const { transport, sent, control } = receiptTransport();
    const first = mount(transport);
    await waitFor(() => expect(first.result.current.threads.get("view:v")).toEqual([]));
    control.lose = 10;
    await act(async () => {
      await steppedRetries(
        () => first.result.current.actions.create("view:v", anchor, "Lost, then reload"),
        () => sent.length,
        3,
      );
    });
    expect(first.result.current.error).toMatch(/may have been sent/);
    first.unmount();
    control.lose = 0;
    const second = mount(transport);
    await waitFor(() => expect(second.result.current.threads.get("view:v")).toHaveLength(1));
    await act(async () => {
      await second.result.current.actions.create("view:v", anchor, "Lost, then reload");
    });
    expect(new Set(sent.map((o) => o.id)).size).toBe(1);
    expect(transport.store.list("view:v")).toHaveLength(1);
  });

  it("a lost reply, then a reload: the same reply once", async () => {
    window.localStorage.clear();
    const { transport, sent, control } = receiptTransport();
    const thread = transport.store.create({ target: "view:v", anchor, body: "Root" });
    const first = mount(transport);
    await waitFor(() => expect(first.result.current.threads.get("view:v")).toHaveLength(1));
    control.lose = 10;
    await act(async () => {
      await steppedRetries(
        () => first.result.current.actions.reply(thread, "Lost reply"),
        () => sent.length,
        3,
      );
    });
    first.unmount();
    control.lose = 0;
    const second = mount(transport);
    await waitFor(() => expect(second.result.current.threads.get("view:v")).toHaveLength(1));
    await act(async () => {
      await second.result.current.actions.reply(thread, "Lost reply");
    });
    expect(new Set(sent.map((o) => o.id)).size).toBe(1);
    expect(transport.store.list("view:v")[0]!.comments).toHaveLength(2);
  });
});

describe("what the page says after a write (O69)", () => {
  it("a comment the service sent at once is announced as sent, not as a draft", async () => {
    const transport = memoryTransport();
    const create = transport.createThreadOnce.bind(transport);
    transport.createThreadOnce = async (operation, input) => {
      const ack = await create(operation, input);
      return { ...ack, thread: { ...ack.thread!, status: "sent" } };
    };
    const { result } = mount(transport, { ...NO_CAPABILITIES, comments: true, notes: false });
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    await act(async () => {
      await result.current.actions.create("view:v", anchor, "Why?");
    });
    expect(result.current.announcement?.text).toBe("Comment sent to the agent.");
  });

  it("a reply the service sent at once is announced as sent", async () => {
    const transport = memoryTransport();
    const thread = transport.store.create({ target: "view:v", anchor, body: "Root" });
    const reply = transport.replyOnce.bind(transport);
    transport.replyOnce = async (operation, id, body) => {
      const ack = await reply(operation, id, body);
      return { ...ack, thread: { ...ack.thread!, status: "sent" } };
    };
    const { result } = mount(transport, { ...NO_CAPABILITIES, comments: true, notes: false });
    await waitFor(() => expect(result.current.threads.get("view:v")).toHaveLength(1));
    await act(async () => {
      await result.current.actions.reply(thread, "And?");
    });
    expect(result.current.announcement?.text).toBe("Reply sent to the agent.");
  });

  it("a queued comment is still announced as a draft", async () => {
    const transport = memoryTransport();
    const { result } = mount(transport, { ...NO_CAPABILITIES, comments: true, notes: false });
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    await act(async () => {
      await result.current.actions.create("view:v", anchor, "Why?");
    });
    expect(result.current.announcement?.text).toBe("Comment saved as a draft.");
  });
});

describe("the connection reported lost while retrying (user-flows J8a, a failed write)", () => {
  it("an unanswered comment is still said to be maybe sent, not 'could not', when the retry is held back", async () => {
    const { transport, sent, control } = receiptTransport();
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    const once = transport.createThreadOnce!;
    let calls = 0;
    // The first send gets no answer; by the retry the page has said it is disconnected and holds writes back.
    transport.createThreadOnce = async (operation, input) => {
      calls += 1;
      if (calls === 1) {
        sent.push(operation);
        throw new UncertainWriteError("Failed to fetch");
      }
      if (calls === 2)
        throw new TransportError(
          "Waiting for Archer to reconnect. Your text has been kept; save it after synchronization finishes.",
          undefined,
          "not_sent",
        );
      return once(operation, input);
    };
    control.lose = 0;
    await act(async () => {
      // The held-back retry is the last: the page stops trying at once, without waiting its next delay.
      await steppedRetries(
        () => result.current.actions.create("view:v", anchor, "Why?"),
        () => calls,
        2,
      );
    });
    expect(result.current.error).toMatch(/may have been sent/);
    expect(result.current.error).not.toMatch(/could not add/i);
    await act(async () => {
      await result.current.actions.create("view:v", anchor, "Why?");
    });
    expect(new Set(sent.map((o) => o.id)).size).toBe(1);
    expect(transport.store.list("view:v")).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });
});

describe("offline", () => {
  it("the page does not keep retrying by itself; the person's next try sends the same operation", async () => {
    const { transport, sent, control } = receiptTransport();
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    const online = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine")!;
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      control.lose = 10;
      await act(async () => {
        await result.current.actions.create("view:v", anchor, "Why?");
      });
      expect(sent).toHaveLength(1);
      expect(result.current.error).toMatch(/offline/);
    } finally {
      Object.defineProperty(navigator, "onLine", online);
      delete (navigator as { onLine?: boolean }).onLine;
    }
    control.lose = 0;
    await act(async () => {
      await result.current.actions.create("view:v", anchor, "Why?");
    });
    expect(new Set(sent.map((o) => o.id)).size).toBe(1);
    expect(transport.store.list("view:v")).toHaveLength(1);
  });
});

/** A memory transport whose submit keeps receipts (O83), and whose next `lose` submit answers are dropped after commit. */
function submitTransport() {
  const transport = memoryTransport();
  const receipts = new Map<string, SubmitAck>();
  const sent: SubmitOperation[] = [];
  const control = { lose: 0 };
  transport.submitOnce = async (operation, scope) => {
    await Promise.resolve();
    sent.push(operation);
    const held = receipts.get(operation.id);
    const ack: SubmitAck =
      held === undefined
        ? { operation, replayed: false, submitted: transport.store.submit(scope.target, scope.threadId).submitted }
        : { ...held, replayed: true };
    if (held === undefined) receipts.set(operation.id, ack);
    if (control.lose > 0) {
      control.lose -= 1;
      throw new UncertainWriteError("Failed to fetch");
    }
    return structuredClone(ack);
  };
  return { transport, sent, control };
}

describe("a send whose answer was lost (queued, O83)", () => {
  it("Send is sent again with the same operation: no 'Could not send', and it says what was sent", async () => {
    const { transport, sent, control } = submitTransport();
    transport.store.create({ target: "view:v", anchor, body: "Why?" });
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toHaveLength(1));
    control.lose = 1;
    await act(async () => {
      await steppedRetries(
        () => result.current.actions.submitAll(),
        () => sent.length,
        2,
      );
    });
    expect(sent.map((o) => o.id)).toEqual([sent[0]!.id, sent[0]!.id]);
    expect(sent[0]!.name).toBe("comment.submit");
    expect(transport.calls).not.toContain("submit");
    expect(result.current.error).toBeNull();
    expect(result.current.announcement?.text).toBe("Sent 1 thread to the agent.");
    await waitFor(() => expect(result.current.threads.get("view:v")?.[0]?.status).toBe("sent"));
  });

  it("still unanswered: says it may have been sent, not 'Could not send'; the next Send reuses the identity", async () => {
    const { transport, sent, control } = submitTransport();
    transport.store.create({ target: "view:v", anchor, body: "Why?" });
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toHaveLength(1));
    control.lose = 10;
    await act(async () => {
      await steppedRetries(
        () => result.current.actions.submitAll(),
        () => sent.length,
        3,
      );
    });
    expect(new Set(sent.map((o) => o.id)).size).toBe(1);
    expect(result.current.error).toMatch(/may have been sent/);
    expect(result.current.error).not.toMatch(/could not send/i);
    control.lose = 0;
    await act(async () => {
      await result.current.actions.submitAll();
    });
    expect(new Set(sent.map((o) => o.id)).size).toBe(1);
    expect(result.current.error).toBeNull();
    expect(result.current.announcement?.text).toBe("Sent 1 thread to the agent.");
  });

  it("a refusal is still said as one, and ends the identity", async () => {
    const { transport, sent } = submitTransport();
    transport.store.create({ target: "view:v", anchor, body: "Why?" });
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toHaveLength(1));
    const once = transport.submitOnce!;
    transport.submitOnce = async (operation) => {
      sent.push(operation);
      throw new TransportError("operation abc was already used", 409, "operation_payload_mismatch");
    };
    await act(async () => {
      await result.current.actions.submitAll();
    });
    expect(result.current.error).toMatch(/^Could not send: operation abc/);
    transport.submitOnce = once;
    await act(async () => {
      await result.current.actions.submitAll();
    });
    expect(new Set(sent.map((o) => o.id)).size).toBe(2);
  });

  it("Publish of one thread, its answer lost: the same operation again, published once, no failure", async () => {
    const { transport, sent, control } = submitTransport();
    const thread = transport.store.create({ target: "view:v", anchor, body: "Why?" });
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toHaveLength(1));
    control.lose = 1;
    let went = 0;
    await act(async () => {
      went = await steppedRetries(
        () => result.current.actions.publishAll!([thread]),
        () => sent.length,
        2,
      );
    });
    expect(went).toBe(1);
    expect(sent.map((o) => o.id)).toEqual([sent[0]!.id, sent[0]!.id]);
    expect(result.current.error).toBeNull();
    expect(result.current.announcement?.text).toBe("Published 1 thread.");
  });
});
