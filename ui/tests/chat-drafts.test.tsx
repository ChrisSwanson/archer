// @vitest-environment jsdom
// The chat's unsent text is kept in this browser like a comment or a reply (codex-201, O100; user-flows G1): a
// reload, a closed and reopened tab, Escape and leaving give it back, said as restored, with an explicit Discard;
// a browser that will not keep it is told so. One draft per project and conversation (new thread or reply).
// And the chat's writes are the review controls' operations (codex-202): a lost answer is said as uncertain, and
// Send again repeats the same identity.
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatBubble } from "../src/chat/ChatBubble";
import {
  NO_CAPABILITIES,
  type CommentOperation,
  type OperationAck,
  type SubmitOperation,
  type Thread,
} from "../src/comments/contract";
import { ackOf, submitAckOf } from "./support/comment-writes";
import { UncertainWriteError, type CommentsTransport } from "../src/comments/transport";
import type { ReviewModel } from "../src/comments/useReview";

const A = "http://127.0.0.1:1/t/p/alpha/",
  B = "http://127.0.0.1:1/t/p/beta/";
const answered = (): Thread => ({
  id: "t1",
  target: "view:containers",
  anchor: { kind: "view" },
  status: "answered",
  revision: 2,
  comments: [
    { id: "c0", author: "person", body: "Q", createdAt: "2026-11-02T10:00:00.000Z" },
    { id: "c1", author: "agent", body: "A", createdAt: "2026-11-02T10:01:00.000Z" },
  ],
});
function transport(overrides: Partial<CommentsTransport> = {}): CommentsTransport {
  return {
    createThreadOnce: vi.fn(async (operation: CommentOperation) =>
      ackOf(operation, { ...answered(), status: "draft" }),
    ),
    replyOnce: vi.fn(async (operation: CommentOperation) => ackOf(operation, { ...answered(), status: "draft" })),
    submitOnce: vi.fn(async (operation: SubmitOperation) => submitAckOf(operation)),
    listThreads: vi.fn(async (target: string) => ({ schemaVersion: 2, target, threads: [] })),
    ...overrides,
  } as unknown as CommentsTransport;
}
function review(held: Record<string, Thread[]> = {}): ReviewModel {
  const actions = {
    markSeen: vi.fn(),
    ingest: vi.fn(),
    refresh: vi.fn(),
    load: vi.fn(),
    resolve: vi.fn(async () => true),
  };
  return {
    threads: new Map(Object.entries(held)),
    isUnread: () => false,
    actions,
    capabilities: { ...NO_CAPABILITIES, comments: true },
  } as unknown as ReviewModel;
}
function mount(
  props: {
    rm?: ReviewModel;
    t?: CommentsTransport;
    scope?: string;
    doc?: ComponentProps<typeof ChatBubble>["doc"];
  } = {},
) {
  return render(
    <ChatBubble
      review={props.rm ?? review()}
      transport={props.t ?? transport()}
      doc={props.doc ?? { viewId: "containers" }}
      title="Containers"
      sidebarHost={null}
      dockHost={null}
      openRequest={0}
      closeRequest={0}
      draftScope={props.scope ?? A}
    />,
  );
}
const open = () => fireEvent.click(screen.getByRole("button", { name: /Chat with the agent about Containers/ }));
const box = () => screen.getByRole("textbox", { name: "Message to the agent" });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const restored = () => screen.queryByText(/Restored your unsent message from earlier/);

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a new message being written (codex-201)", () => {
  it("survives a reload (a new mount), said as restored, and Discard forgets it", () => {
    const first = mount();
    open();
    type("Why two databases?");
    first.unmount();
    mount();
    open();
    expect(box()).toHaveValue("Why two databases?");
    expect(restored()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
    expect(box()).toHaveValue("");
    cleanup();
    mount();
    open();
    expect(box()).toHaveValue("");
    expect(restored()).toBeNull();
  });

  it("is kept in localStorage under the comment-draft prefix, with its conversation", () => {
    mount();
    open();
    type("Kept words");
    const keys = Object.keys(window.localStorage).filter((k) => k.startsWith("archer.comment-draft.v1:"));
    expect(keys).toHaveLength(1);
    const kept = JSON.parse(window.localStorage.getItem(keys[0]!)!);
    expect(kept).toMatchObject({
      scope: A,
      target: "view:containers",
      anchor: { kind: "view" },
      body: "Kept words",
      threadId: null,
    });
  });

  it("Escape keeps it", () => {
    mount();
    open();
    type("Before Escape");
    fireEvent.keyDown(box(), { key: "Escape" });
    open();
    expect(box()).toHaveValue("Before Escape");
  });

  it("never appears in another project", () => {
    const first = mount({ scope: A });
    open();
    type("Alpha only");
    first.unmount();
    mount({ scope: B });
    open();
    expect(box()).toHaveValue("");
  });

  it("never appears on another document", () => {
    const first = mount();
    open();
    type("Containers only");
    first.unmount();
    render(
      <ChatBubble
        review={review()}
        transport={transport()}
        doc={{ viewId: "checkout" }}
        title="Containers"
        sidebarHost={null}
        dockHost={null}
        openRequest={0}
        closeRequest={0}
        draftScope={A}
      />,
    );
    open();
    expect(box()).toHaveValue("");
  });

  it("a browser that will not keep it says so before the person relies on it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    mount();
    open();
    type("Unkept");
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot keep this message if you reload or close the page/);
  });

  it("is forgotten once sent", async () => {
    mount();
    open();
    type("Going out");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(box()).toHaveValue(""));
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith("archer.comment-draft.v1:"))).toEqual([]);
  });
});

describe("a reply being written in the chat (codex-201)", () => {
  it("survives a reload, names its thread, and does not appear in the review's reply box key", () => {
    const rm = review({ "view:containers": [answered()] });
    const first = mount({ rm });
    open();
    type("And the cache?");
    const keys = Object.keys(window.localStorage).filter((k) => k.startsWith("archer.comment-draft.v1:"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toMatch(/reply:t1$/);
    expect(JSON.parse(window.localStorage.getItem(keys[0]!)!)).toMatchObject({
      threadId: "t1",
      body: "And the cache?",
    });
    first.unmount();
    mount({ rm });
    open();
    expect(box()).toHaveValue("And the cache?");
    expect(restored()).not.toBeNull();
  });
});

describe("a lost answer in the chat (codex-202)", () => {
  function lossy() {
    const ids: string[] = [];
    let lose = 10;
    const ack = (operation: CommentOperation): OperationAck => ({
      operation: { id: operation.id, issuedAt: operation.issuedAt, name: operation.name },
      replayed: ids.indexOf(operation.id) !== ids.length - 1,
      committed: { threadId: "t9", commentId: "c9", revision: 1, committedAt: "2026-11-02T10:00:00.000Z" },
      thread: { ...answered(), id: "t9", status: "sent", comments: [answered().comments[0]!] },
    });
    const t = transport({
      createThreadOnce: vi.fn(async (operation: CommentOperation) => {
        ids.push(operation.id);
        if (lose-- > 0) throw new UncertainWriteError("Failed to fetch");
        return ack(operation);
      }),
      replyOnce: vi.fn(async () => {
        throw new Error("no reply expected");
      }),
      submitOnce: vi.fn(async (operation) => ({ operation, replayed: false, submitted: 0 })),
    });
    return {
      t,
      ids,
      stop: () => {
        lose = 0;
      },
    };
  }

  it("says the message may have been sent, keeps the text, and Send again repeats the same operation", async () => {
    const { t, ids, stop } = lossy();
    const rm = review();
    mount({ rm, t });
    open();
    type("Lost answer");
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
      await new Promise((r) => setTimeout(r, 1400));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/may have been sent or not/);
    expect(screen.queryByText(/Not saved/)).toBeNull();
    expect(box()).toHaveValue("Lost answer");
    stop();
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    await waitFor(() => expect(box()).toHaveValue(""));
    expect(new Set(ids).size).toBe(1);
  });

  it("the identity is kept with the draft: after a reload, Send repeats it", async () => {
    const { t, ids, stop } = lossy();
    const rm = review();
    const first = mount({ rm, t });
    open();
    type("Lost, then reload");
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
      await new Promise((r) => setTimeout(r, 1400));
    });
    first.unmount();
    stop();
    mount({ rm, t });
    open();
    expect(box()).toHaveValue("Lost, then reload");
    expect(screen.getByText(/may already have been sent/)).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    await waitFor(() => expect(box()).toHaveValue(""));
    expect(new Set(ids).size).toBe(1);
  });
});
