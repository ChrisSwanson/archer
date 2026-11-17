// @vitest-environment jsdom
// The bubble as a reader meets it: launcher, dialog, ticks, keys (ADR 0034 §10).
import { useState, type JSX } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatBubble } from "../src/chat/ChatBubble";
import { ChatPanel } from "../src/chat/ChatPanel";
import { AGENT_DELIVERY, chatStatus, deliveryLine } from "../src/chat/chat-status";
import { CHAT_POSITION_KEY } from "../src/chat/chat-position";
import type { CommentOperation, SubmitOperation, Thread } from "../src/comments/contract";
import type { CommentsTransport } from "../src/comments/transport";
import type { ReviewModel } from "../src/comments/useReview";
import { ackOf, submitAckOf } from "./support/comment-writes";

const thread = (status: Thread["status"], comments: readonly [string, string][] = [["person", "Hi"]]): Thread => ({
  id: "t1",
  target: "view:containers",
  anchor: { kind: "view" },
  status,
  revision: 1,
  comments: comments.map(([author, body], i) => ({
    id: `c${i}`,
    author: author as "person" | "agent",
    body,
    createdAt: "2026-10-23T10:00:00.000Z",
  })),
});

function model(threads: Thread[], unread = false) {
  const actions = { markSeen: vi.fn(), ingest: vi.fn(), refresh: vi.fn(), resolve: vi.fn(async () => true) };
  const review = {
    threads: new Map([["view:containers", threads]]),
    isUnread: () => unread,
    actions,
  } as unknown as ReviewModel;
  return { review, actions };
}
function transport(overrides: Partial<CommentsTransport> = {}) {
  const t = {
    createThreadOnce: vi.fn(async (operation: CommentOperation) => ackOf(operation, thread("draft"))),
    replyOnce: vi.fn(async (operation: CommentOperation) => ackOf(operation, thread("draft"))),
    submitOnce: vi.fn(async (operation: SubmitOperation) => submitAckOf(operation)),
    ...overrides,
  } as unknown as CommentsTransport;
  return t;
}
function mount(
  review: ReviewModel,
  t: CommentsTransport = transport(),
  extra: {
    openRequest?: number;
    closeRequest?: number;
    onOpenChange?: (open: boolean) => void;
    sidebarHost?: HTMLElement | null;
    viewId?: string;
  } = {},
) {
  const ui = (openRequest: number, closeRequest = extra.closeRequest ?? 0, viewId = extra.viewId ?? "containers") => (
    <ChatBubble
      key={viewId}
      review={review}
      transport={t}
      doc={{ viewId }}
      title={viewId === "containers" ? "Containers" : viewId}
      sidebarHost={extra.sidebarHost ?? null}
      dockHost={null}
      openRequest={openRequest}
      closeRequest={closeRequest}
      {...(extra.onOpenChange === undefined ? {} : { onOpenChange: extra.onOpenChange })}
      drafts={drafts}
    />
  );
  const view = render(ui(extra.openRequest ?? 0));
  return {
    ...view,
    ask: (n: number) => view.rerender(ui(n)),
    close: (n: number) => view.rerender(ui(extra.openRequest ?? 0, n)),
    goto: (id: string) => view.rerender(ui(extra.openRequest ?? 0, extra.closeRequest ?? 0, id)),
  };
}
let drafts = new Map<string, string>();
const fab = (): HTMLElement => screen.getByRole("button", { name: /Chat with the agent about Containers/ });

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  window.localStorage.clear();
  drafts = new Map();
});
afterEach(cleanup);

const SAVED = "Saved · the agent sees this the next time it checks";
const text = (status: ReturnType<typeof chatStatus>): string | null => status?.text ?? null;

describe("chatStatus (D7: one status slot, one source)", () => {
  it("says Saved and that the agent sees it when it next checks, then Read by the agent; the reply is its own bubble", () => {
    expect(text(chatStatus(thread("sent"), false, false))).toBe(SAVED);
    expect(text(chatStatus(thread("read"), false, false))).toBe("Read by the agent");
    expect(
      chatStatus(
        thread("answered", [
          ["person", "Q"],
          ["agent", "A"],
        ]),
        false,
        false,
      ),
    ).toBeNull();
    expect(chatStatus(thread("draft"), true, false)).toEqual({ text: "Not sent", retry: true });
    expect(text(chatStatus(thread("draft"), false, true))).toBe("Sending…");
    expect(chatStatus(undefined, false, false)).toBeNull();
  });
  it("never implies delivery or a reply while the agent has not checked", () => {
    const line = deliveryLine(AGENT_DELIVERY);
    expect(line).toBe(SAVED);
    expect(line).not.toMatch(/\bsent\b|deliver|repl|answer|listening|soon/i);
    expect(line.length).toBeLessThanOrEqual(60);
  });
  it("takes how the agent gets messages as its one input, so a live listener status replaces the line in one place", () => {
    expect(text(chatStatus(thread("sent"), false, false, AGENT_DELIVERY))).toBe(deliveryLine(AGENT_DELIVERY));
  });
});

describe("the launcher", () => {
  it("is a button named for the document, with the unread count", () => {
    mount(
      model(
        [
          thread("answered", [
            ["person", "Q"],
            ["agent", "A"],
          ]),
        ],
        true,
      ).review,
    );
    expect(fab()).toHaveAccessibleName("Chat with the agent about Containers, 1 new reply");
    expect(screen.getByTestId("chat-unread-dot")).toBeInTheDocument();
  });
  it("has no dot when nothing is unread", () => {
    mount(
      model([
        thread("answered", [
          ["person", "Q"],
          ["agent", "A"],
        ]),
      ]).review,
    );
    expect(fab()).toHaveAccessibleName("Chat with the agent about Containers");
    expect(screen.queryByTestId("chat-unread-dot")).toBeNull();
  });
  it("moves 10 px with an arrow, 50 px with Shift, and Home sends it to the corner", () => {
    mount(model([]).review);
    const left = (): number => parseFloat(fab().style.left);
    const before = left();
    fireEvent.keyDown(fab(), { key: "ArrowLeft" });
    expect(left()).toBe(before - 10);
    fireEvent.keyDown(fab(), { key: "ArrowLeft", shiftKey: true });
    expect(left()).toBe(before - 60);
    expect(JSON.parse(window.localStorage.getItem(CHAT_POSITION_KEY)!)).toMatchObject({ x: expect.any(Number) });
    fireEvent.keyDown(fab(), { key: "Home" });
    expect(left()).toBe(before);
    expect(window.localStorage.getItem(CHAT_POSITION_KEY)).toBeNull();
  });
  it("has a right-click menu with Move to corner", () => {
    mount(model([]).review);
    fireEvent.keyDown(fab(), { key: "ArrowUp", shiftKey: true });
    const top = fab().style.top;
    fireEvent.contextMenu(fab());
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to corner/ }));
    expect(fab().style.top).not.toBe(top);
  });
});

describe("the chat", () => {
  it("opens as a non-modal dialog labelled by the document, on its latest unresolved thread", () => {
    mount(
      model([
        thread("answered", [
          ["person", "Why SQS?"],
          ["agent", "Cheaper."],
        ]),
      ]).review,
    );
    fireEvent.click(fab());
    const dialog = screen.getByRole("dialog", { name: /Chat with the agent\s+Containers/ });
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(screen.getByRole("log", { name: "Conversation" })).toHaveTextContent("Why SQS?");
    expect(screen.getByRole("log")).toHaveTextContent("Cheaper.");
    expect(fab()).toHaveAttribute("aria-expanded", "true");
  });
  it("shows the thread's status in the status slot", () => {
    mount(model([thread("read")]).review);
    fireEvent.click(fab());
    expect(screen.getByTestId("chat-status")).toHaveTextContent("Read by the agent");
  });
  it("after a send, says plainly that the message is saved for the agent's next check, as a status, keeping focus in the box", async () => {
    const { review } = model([]);
    function Live(): JSX.Element {
      const [held, setHeld] = useState<Thread[]>([]);
      const live = {
        ...review,
        threads: new Map([["view:containers", held]]),
        actions: { ...review.actions, ingest: (next: Thread) => setHeld([next]) },
      } as unknown as ReviewModel;
      return (
        <ChatBubble
          review={live}
          transport={transport({
            submitOnce: vi.fn(async (operation: SubmitOperation) => submitAckOf(operation)),
            createThreadOnce: vi.fn(async (operation: CommentOperation) => ackOf(operation, thread("sent"))),
          } as Partial<CommentsTransport>)}
          doc={{ viewId: "containers" }}
          title="Containers"
          sidebarHost={null}
          dockHost={null}
          openRequest={0}
          closeRequest={0}
        />
      );
    }
    render(<Live />);
    fireEvent.click(fab());
    const box = screen.getByRole("textbox", { name: "Message to the agent" });
    const slot = screen.getByTestId("chat-status");
    expect(slot).toHaveAttribute("role", "status");
    expect(slot).toBeEmptyDOMElement();
    fireEvent.change(box, { target: { value: "Hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("chat-status")).toHaveTextContent(SAVED));
    expect(screen.getByTestId("chat-status")).toBe(slot);
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/\bSent\b/);
    expect(box).toHaveFocus();
  });
  it("says nothing about delivery under the input", () => {
    mount(model([]).review);
    fireEvent.click(fab());
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/listening|delivered|will see/i);
    expect(screen.getByRole("log")).toHaveTextContent("Nothing yet. Ask the agent about this diagram.");
  });
  it("collapses on Escape and returns focus to the launcher", () => {
    mount(model([]).review);
    fireEvent.click(fab());
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message to the agent" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fab()).toHaveFocus();
  });
  it("opens when the page asks (C), and marks the reply seen", () => {
    const { review, actions } = model(
      [
        thread("answered", [
          ["person", "Q"],
          ["agent", "A"],
        ]),
      ],
      true,
    );
    const { ask } = mount(review);
    ask(1);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message to the agent" })).toHaveFocus();
    expect(actions.markSeen).toHaveBeenCalled();
  });
  it("sends on Enter, creating the thread and submitting that one thread; Shift+Enter is a new line", async () => {
    const { review, actions } = model([]);
    const t = transport();
    mount(review, t);
    fireEvent.click(fab());
    const box = screen.getByRole("textbox", { name: "Message to the agent" });
    fireEvent.change(box, { target: { value: "Hello" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(t.createThreadOnce).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(t.submitOnce).toHaveBeenCalledWith(expect.anything(), { target: "view:containers", threadId: "t1" }),
    );
    expect(t.createThreadOnce).toHaveBeenCalledWith(expect.anything(), {
      target: "view:containers",
      anchor: { kind: "view" },
      body: "Hello",
    });
    await waitFor(() => expect(box).toHaveValue(""));
    expect(actions.ingest).toHaveBeenCalledWith(expect.objectContaining({ id: "t1", status: "sent" }));
    expect(actions.refresh).toHaveBeenCalledWith("view:containers");
  });
  it("keeps a failed send as a draft, 'Not sent', with Retry that submits again", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue({ submitted: 1 });
    const t = transport({ submitOnce: submit } as Partial<CommentsTransport>);
    function Live(): JSX.Element {
      const [held, setHeld] = useState<Thread[]>([]);
      const review = {
        threads: new Map([["view:containers", held]]),
        isUnread: () => false,
        actions: { ingest: (next: Thread) => setHeld([next]), refresh: () => undefined, markSeen: () => undefined },
      } as unknown as ReviewModel;
      return (
        <ChatBubble
          review={review}
          transport={t}
          doc={{ viewId: "containers" }}
          title="Containers"
          sidebarHost={null}
          dockHost={null}
          openRequest={0}
          closeRequest={0}
        />
      );
    }
    render(<Live />);
    fireEvent.click(fab());
    const box = screen.getByRole("textbox", { name: "Message to the agent" });
    fireEvent.change(box, { target: { value: "Hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByTestId("chat-status")).toHaveTextContent("Not sent");
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(submit).toHaveBeenCalledTimes(2);
    expect(t.createThreadOnce).toHaveBeenCalledTimes(1);
  });
  it("says 'Also sends 1 draft' when a draft sits on the thread", () => {
    mount(model([thread("draft")]).review);
    fireEvent.click(fab());
    expect(screen.getByText("Also sends 1 draft")).toBeInTheDocument();
  });
  it("does not send an empty message", () => {
    const t = transport();
    mount(model([]).review, t);
    fireEvent.click(fab());
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message to the agent" }), { key: "Enter" });
    expect(t.createThreadOnce).not.toHaveBeenCalled();
  });
});

/** A review model that keeps what the bubble ingests, as the page does. */
function liveReview(start: Thread[] = [], unread = false) {
  const spies = { ingest: vi.fn(), resolve: vi.fn() };
  const state = { held: start, set: (_: Thread[]) => undefined as void };
  function Live(props: { transport: CommentsTransport }): JSX.Element {
    const [held, setHeld] = useState<Thread[]>(start);
    state.held = held;
    const review = {
      threads: new Map([["view:containers", held]]),
      isUnread: () => unread,
      actions: {
        ingest: (next: Thread) => {
          spies.ingest(next);
          setHeld([next]);
        },
        refresh: () => undefined,
        markSeen: () => undefined,
        resolve: async (t: Thread) => {
          spies.resolve(t);
          setHeld([{ ...t, status: "resolved" }]);
          return true;
        },
      },
    } as unknown as ReviewModel;
    return (
      <ChatBubble
        review={review}
        transport={props.transport}
        doc={{ viewId: "containers" }}
        title="Containers"
        sidebarHost={null}
        dockHost={null}
        openRequest={0}
        closeRequest={0}
        drafts={drafts}
      />
    );
  }
  return { Live, spies };
}
async function say(text: string): Promise<void> {
  const box = screen.getByRole("textbox", { name: "Message to the agent" });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

describe("the bubble's rules, each pinned by breaking it", () => {
  it("a retry that succeeds shows Saved, not the draft it was", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue({ submitted: 1 });
    const { Live, spies } = liveReview();
    render(<Live transport={transport({ submitOnce: submit } as Partial<CommentsTransport>)} />);
    fireEvent.click(fab());
    await say("Hello");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(spies.ingest).toHaveBeenLastCalledWith(expect.objectContaining({ id: "t1", status: "sent" }));
    expect(screen.getByTestId("chat-status")).toHaveTextContent(SAVED);
    expect(screen.getByTestId("chat-status")).not.toHaveTextContent("Draft, not sent");
  });
  it("a failed send is ingested as the draft it is, and does not say 'Also sends 1 draft'", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("down"));
    const { Live, spies } = liveReview();
    render(<Live transport={transport({ submitOnce: submit } as Partial<CommentsTransport>)} />);
    fireEvent.click(fab());
    await say("Hello");
    await screen.findByRole("button", { name: "Retry" });
    expect(spies.ingest).toHaveBeenCalledTimes(1);
    expect(spies.ingest.mock.calls[0]![0]).toMatchObject({ status: "draft" });
    expect(screen.queryByText(/Also sends/)).toBeNull();
    expect(screen.getByTestId("chat-status")).toHaveTextContent("Not sent");
  });
  it("a resolved thread never lights the dot, however unread", () => {
    mount(
      model(
        [
          thread("resolved", [
            ["person", "Q"],
            ["agent", "A"],
          ]),
        ],
        true,
      ).review,
    );
    expect(screen.queryByTestId("chat-unread-dot")).toBeNull();
    expect(fab()).toHaveAccessibleName("Chat with the agent about Containers");
  });
  it("counts threads, not replies, in the launcher's name", () => {
    const two = [
      {
        ...thread("answered", [
          ["person", "Q"],
          ["agent", "A"],
        ]),
        id: "a",
      },
      {
        ...thread("answered", [
          ["person", "Q"],
          ["agent", "A"],
        ]),
        id: "b",
      },
    ];
    mount(model(two, true).review);
    expect(fab()).toHaveAccessibleName("Chat with the agent about Containers, 2 threads with new replies");
  });
  it("Resolve ends the conversation: the next message starts a new thread, not a reply", async () => {
    const t = transport();
    const { Live, spies } = liveReview([thread("sent")]);
    render(<Live transport={t} />);
    fireEvent.click(fab());
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(spies.resolve).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("Nothing yet"));
    await say("A new question");
    await waitFor(() =>
      expect(t.createThreadOnce).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: "A new question" }),
      ),
    );
    expect(t.replyOnce).not.toHaveBeenCalled();
  });
  it("announces a send once: the log has it, the status line does not repeat it", async () => {
    mount(model([]).review);
    fireEvent.click(fab());
    await say("Hello");
    await waitFor(() => expect(screen.getByRole("log")).toBeInTheDocument());
    for (const status of screen.getAllByRole("status")) expect(status).not.toHaveTextContent(/^Sent\.?$/);
  });
});

describe("one conversation surface at a time", () => {
  it("tells the page when it opens and closes, and closes when the page asks", () => {
    const seen: boolean[] = [];
    const { close } = mount(model([]).review, transport(), { onOpenChange: (open) => seen.push(open) });
    fireEvent.click(fab());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(seen.at(-1)).toBe(true);
    close(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(seen.at(-1)).toBe(false);
  });
});

describe("the right-click menu", () => {
  const sized = (w: number, h: number) => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(w);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(h);
  };
  afterEach(() => vi.restoreAllMocks());
  it("is kept inside the window, measured after it is drawn", () => {
    sized(180, 44);
    mount(model([]).review);
    fireEvent.contextMenu(fab(), { clientX: 1275, clientY: 795 });
    const menu = screen.getByRole("menu");
    expect(parseFloat(menu.style.left) + 180).toBeLessThanOrEqual(1280);
    expect(parseFloat(menu.style.top) + 44).toBeLessThanOrEqual(800);
  });
  it("closes when focus leaves it, and on Tab", () => {
    mount(model([]).review);
    fireEvent.contextMenu(fab(), { clientX: 400, clientY: 400 });
    const item = screen.getByRole("menuitem");
    fireEvent.keyDown(item, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(fab(), { clientX: 400, clientY: 400 });
    fireEvent.blur(screen.getByRole("menuitem"), { relatedTarget: document.body });
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("a long press (pointer down, context menu, pointer up) opens the menu and not the chat", () => {
    mount(model([]).review);
    fireEvent.pointerDown(fab(), { button: 0, pointerId: 1, clientX: 600, clientY: 400 });
    fireEvent.contextMenu(fab(), { clientX: 600, clientY: 400 });
    fireEvent.pointerUp(fab(), { button: 0, pointerId: 1, clientX: 600, clientY: 400 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a draft is kept for its document", () => {
  it("is back when the person returns to the document, and not on another", () => {
    const { goto } = mount(model([]).review);
    fireEvent.click(fab());
    fireEvent.change(screen.getByRole("textbox", { name: "Message to the agent" }), {
      target: { value: "half a thought" },
    });
    goto("other");
    fireEvent.click(screen.getByRole("button", { name: /Chat with the agent about other/ }));
    expect(screen.getByRole("textbox", { name: "Message to the agent" })).toHaveValue("");
    goto("containers");
    fireEvent.click(fab());
    expect(screen.getByRole("textbox", { name: "Message to the agent" })).toHaveValue("half a thought");
  });
  it("is forgotten once sent", async () => {
    mount(model([]).review);
    fireEvent.click(fab());
    await say("Sent soon");
    // The kept draft follows the textbox in an effect after the render; waitFor wakes on the DOM change,
    // which can come before that effect runs (seen on CI), so wait for both together.
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Message to the agent" })).toHaveValue("");
      expect(drafts.get("view:containers") ?? "").toBe("");
    });
  });
});

describe("the chat's room", () => {
  let observers: { cb: () => void; targets: Element[]; disconnected: boolean }[] = [];
  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly entry = { cb: () => undefined as void, targets: [] as Element[], disconnected: false };
        constructor(cb: () => void) {
          this.entry.cb = cb;
          observers.push(this.entry);
        }
        observe(el: Element): void {
          this.entry.targets.push(el);
        }
        unobserve(): void {}
        disconnect(): void {
          this.entry.disconnected = true;
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not rebuild its observers on every window resize, nor measure at all once the launcher is placed", () => {
    mount(model([]).review);
    const built = observers.length;
    for (let i = 0; i < 5; i += 1) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 - i });
      fireEvent(window, new Event("resize"));
    }
    expect(observers.length).toBe(built);
    cleanup();
    observers.length = 0;
    window.localStorage.setItem(CHAT_POSITION_KEY, JSON.stringify({ x: 0.5, y: 0.5 }));
    mount(model([]).review);
    expect(observers).toHaveLength(0);
  });

  it("follows the walkthrough panel's width: the sidebar's room is measured again when the row resizes", () => {
    const row = document.createElement("div");
    const panel = document.createElement("div");
    const stage = document.createElement("div");
    stage.className = "archer-stage";
    const host = document.createElement("div");
    row.append(panel, stage, host);
    document.body.append(row);
    let panelW = 300;
    Object.defineProperty(row, "clientWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(panel, "offsetWidth", { configurable: true, get: () => panelW });
    Object.defineProperty(stage, "offsetWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(host, "offsetWidth", { configurable: true, get: () => 400 });
    window.localStorage.setItem("archer.chat.window", JSON.stringify({ w: 340, h: 460, dw: 560, mode: "side" }));
    mount(model([]).review, transport(), { sidebarHost: host });
    fireEvent.click(fab());
    const side = (): HTMLElement => screen.getByRole("complementary");
    expect(parseFloat(side().style.width)).toBe(560);
    panelW = 520; // the walkthrough divider moved
    const watching = observers.filter((o) => o.targets.includes(row));
    expect(watching.length).toBeGreaterThan(0);
    act(() => watching.forEach((o) => o.cb()));
    expect(parseFloat(side().style.width)).toBe(1280 - 520 - 380);
    row.remove();
  });
});

describe("the composer's fit", () => {
  const props = (over: Partial<Parameters<typeof ChatPanel>[0]> = {}): Parameters<typeof ChatPanel>[0] => ({
    mode: "side",
    title: "T",
    what: "this diagram",
    thread: undefined,
    failed: false,
    sending: false,
    alsoSends: 0,
    notice: null,
    scope: null,
    draft: "",
    style: {},
    corner: "tl",
    width: 360,
    canExpand: true,
    panelId: "p",
    panelRef: () => undefined,
    max: 640,
    onDraft: () => undefined,
    onSend: () => undefined,
    onRetry: () => undefined,
    onResolve: () => undefined,
    onScope: () => undefined,
    onCollapse: () => undefined,
    onMode: () => undefined,
    onResize: () => undefined,
    ...over,
  });
  it("is made again when a notice or the 'Also sends' line appears, and when a side or sheet panel is resized by its row", async () => {
    const win = await import("../src/chat/chat-window");
    const spy = vi.spyOn(win, "composerHeight");
    const created: { cb: () => void }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          created.push({ cb });
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const view = render(<ChatPanel {...props()} />);
    const first = spy.mock.calls.length;
    view.rerender(<ChatPanel {...props({ notice: "Not saved: down." })} />);
    expect(spy.mock.calls.length).toBeGreaterThan(first);
    const second = spy.mock.calls.length;
    view.rerender(<ChatPanel {...props({ notice: "Not saved: down.", alsoSends: 1 })} />);
    expect(spy.mock.calls.length).toBeGreaterThan(second);
    const third = spy.mock.calls.length;
    act(() => created.forEach((o) => o.cb()));
    expect(spy.mock.calls.length).toBeGreaterThan(third);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

describe("the resize separators", () => {
  const status = (): string =>
    screen
      .getAllByRole("status")
      .map((el) => el.textContent)
      .join(" ");
  it("on the sidebar edge, Up and Down change nothing and say nothing; Left and Right resize and say so", () => {
    window.localStorage.setItem("archer.chat.window", JSON.stringify({ w: 340, h: 460, dw: 400, mode: "side" }));
    const row = document.createElement("div");
    const host = document.createElement("div");
    row.append(host);
    Object.defineProperty(row, "clientWidth", { configurable: true, value: 1280 });
    document.body.append(row);
    mount(model([]).review, transport(), { sidebarHost: host });
    fireEvent.click(fab());
    const edge = screen.getByRole("separator");
    fireEvent.keyDown(edge, { key: "ArrowUp" });
    expect(status()).not.toMatch(/Chat resized/);
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(status()).toMatch(/Chat resized/);
    row.remove();
  });

  it("the floating window's separator gives the real largest width, not a fixed 640", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
    mount(model([]).review);
    fireEvent.click(fab());
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuemax", "484");
  });
});
