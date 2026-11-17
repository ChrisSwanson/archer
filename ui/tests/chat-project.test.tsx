// @vitest-environment jsdom
// The project conversation in the bubble (wave 2, ticket 08; ADR 0034 §10 as amended): "This diagram /
// Whole project" on a diagram or note page, the project's chat alone on a page with no document, and every
// send carrying the page and file it was sent from.
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatBubble } from "../src/chat/ChatBubble";
import type { CommentOperation, SubmitOperation, Thread } from "../src/comments/contract";
import type { CommentsTransport } from "../src/comments/transport";
import type { ReviewModel } from "../src/comments/useReview";
import { ackOf, submitAckOf } from "./support/comment-writes";

const CONTEXT = { page: "/projects/shop/diagrams/containers", document: ".archer/containers.mmd" };
const projectThread = (status: Thread["status"] = "sent"): Thread => ({
  id: "p1",
  target: "project:",
  anchor: { kind: "project" },
  status,
  revision: 1,
  comments: [{ id: "pc0", author: "person", body: "About the whole shop", createdAt: "2026-10-25T10:00:00.000Z" }],
});
const draftThread = (): Thread => ({ ...projectThread("draft"), id: "p9" });

function transport(overrides: Partial<CommentsTransport> = {}): CommentsTransport {
  return {
    createThreadOnce: vi.fn(async (operation: CommentOperation) => ackOf(operation, draftThread())),
    replyOnce: vi.fn(async (operation: CommentOperation) => ackOf(operation, projectThread("draft"))),
    submitOnce: vi.fn(async (operation: SubmitOperation) => submitAckOf(operation)),
    ...overrides,
  } as unknown as CommentsTransport;
}
function review(held: Record<string, Thread[]> = {}) {
  // The seen state and the read on opening go through the real review model in chat-project-review.test.tsx.
  const actions = {
    markSeen: vi.fn(),
    ingest: vi.fn(),
    refresh: vi.fn(),
    load: vi.fn(),
    resolve: vi.fn(async () => true),
  };
  return {
    review: { threads: new Map(Object.entries(held)), isUnread: () => false, actions } as unknown as ReviewModel,
    actions,
  };
}
let drafts = new Map<string, string>();
function mountDoc(
  rm: ReviewModel,
  t: CommentsTransport,
  doc: ComponentProps<typeof ChatBubble>["doc"],
  title = "Containers",
) {
  return render(
    <ChatBubble
      review={rm}
      transport={t}
      doc={doc}
      title={title}
      projectTitle="Pageturner"
      context={CONTEXT}
      sidebarHost={null}
      dockHost={null}
      openRequest={0}
      closeRequest={0}
      drafts={drafts}
    />,
  );
}
const fab = (): HTMLElement => screen.getByRole("button", { name: /Chat with the agent about Containers/ });
const talk = () => screen.getByRole("group", { name: "Talk about" });
const box = () => screen.getByRole("textbox", { name: "Message to the agent" });
async function say(text: string): Promise<void> {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  window.localStorage.clear();
  drafts = new Map();
});
afterEach(cleanup);

describe("the switch on a diagram or note page", () => {
  it("offers 'This diagram / Whole project', starting on the diagram", () => {
    mountDoc(review().review, transport(), { viewId: "containers" });
    fireEvent.click(fab());
    expect(within(talk()).getByRole("button", { name: "This diagram" })).toHaveAttribute("aria-pressed", "true");
    expect(within(talk()).getByRole("button", { name: "Whole project" })).toHaveAttribute("aria-pressed", "false");
    expect(within(talk()).queryByRole("button", { name: "Walkthrough" })).toBeNull();
  });

  it("says 'This note' on a note page, and adds Walkthrough while one is open", () => {
    const { unmount } = mountDoc(review().review, transport(), { viewId: null, notePath: "notes/auth.md" }, "Auth");
    fireEvent.click(screen.getByRole("button", { name: /Chat with the agent about Auth/ }));
    expect(within(talk()).getByRole("button", { name: "This note" })).toHaveAttribute("aria-pressed", "true");
    unmount();
    mountDoc(review().review, transport(), { viewId: "containers", walk: { id: "tour", title: "The tour" } });
    fireEvent.click(fab());
    expect(
      within(talk())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Walkthrough", "This diagram", "Whole project"]);
  });

  it("Whole project switches to the project's thread, loads it, and names the project", () => {
    const { review: rm, actions } = review({ "project:": [projectThread()] });
    mountDoc(rm, transport(), { viewId: "containers" });
    fireEvent.click(fab());
    fireEvent.click(within(talk()).getByRole("button", { name: "Whole project" }));
    expect(actions.load).toHaveBeenCalledWith("project:");
    expect(screen.getByRole("log")).toHaveTextContent("About the whole shop");
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/Pageturner/);
    expect(within(talk()).getByRole("button", { name: "Whole project" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a draft per conversation: the diagram's and the project's do not mix", () => {
    mountDoc(review().review, transport(), { viewId: "containers" });
    fireEvent.click(fab());
    fireEvent.change(box(), { target: { value: "diagram words" } });
    fireEvent.click(within(talk()).getByRole("button", { name: "Whole project" }));
    expect(box()).toHaveValue("");
    fireEvent.click(within(talk()).getByRole("button", { name: "This diagram" }));
    expect(box()).toHaveValue("diagram words");
  });
});

describe("what a send carries", () => {
  it("to the project: its target, a project anchor, and the page and file it was sent from; then that thread is submitted", async () => {
    const { review: rm, actions } = review();
    const t = transport();
    mountDoc(rm, t, { viewId: "containers" });
    fireEvent.click(fab());
    fireEvent.click(within(talk()).getByRole("button", { name: "Whole project" }));
    await say("Does the worker retry?");
    await waitFor(() =>
      expect(t.submitOnce).toHaveBeenCalledWith(expect.anything(), { target: "project:", threadId: "p9" }),
    );
    expect(t.createThreadOnce).toHaveBeenCalledWith(expect.anything(), {
      target: "project:",
      anchor: { kind: "project" },
      body: "Does the worker retry?",
      context: CONTEXT,
    });
    expect(actions.refresh).toHaveBeenCalledWith("project:");
  });

  it("to the diagram: still the diagram, and the context too", async () => {
    const t = transport();
    mountDoc(review().review, t, { viewId: "containers" });
    fireEvent.click(fab());
    await say("Why a queue?");
    await waitFor(() =>
      expect(t.createThreadOnce).toHaveBeenCalledWith(expect.anything(), {
        target: "view:containers",
        anchor: { kind: "view" },
        body: "Why a queue?",
        context: CONTEXT,
      }),
    );
  });
});

describe("on a page with no document (project, folder, search)", () => {
  it("is the project's chat alone: no switch, named for the project, continuing its latest thread", async () => {
    const { review: rm, actions } = review({ "project:": [projectThread("answered")] });
    const t = transport();
    mountDoc(rm, t, { viewId: null, projectOnly: true }, "Pageturner");
    fireEvent.click(screen.getByRole("button", { name: "Chat with the agent about Pageturner" }));
    expect(screen.queryByRole("group", { name: "Talk about" })).toBeNull();
    expect(actions.load).toHaveBeenCalledWith("project:");
    expect(screen.getByRole("log")).toHaveTextContent("About the whole shop");
    await say("And the search?");
    await waitFor(() => expect(t.replyOnce).toHaveBeenCalledWith(expect.anything(), "p1", "And the search?", CONTEXT));
    await waitFor(() =>
      expect(t.submitOnce).toHaveBeenCalledWith(expect.anything(), { target: "project:", threadId: "p1" }),
    );
  });

  it("an empty conversation says what it is about", () => {
    mountDoc(review().review, transport(), { viewId: null, projectOnly: true }, "Pageturner");
    fireEvent.click(screen.getByRole("button", { name: /Chat with the agent about/ }));
    expect(screen.getByRole("log")).toHaveTextContent("Nothing yet. Ask the agent about the whole project.");
  });
});

describe("the project conversation asked for by name (a review entry, the bell's link)", () => {
  it("opens the chat on the project, on a diagram's page too", () => {
    const { review: rm } = review({ "project:": [projectThread()] });
    const props = {
      review: rm,
      transport: transport(),
      doc: { viewId: "containers" },
      title: "Containers",
      projectTitle: "Pageturner",
      context: CONTEXT,
      sidebarHost: null,
      dockHost: null,
      openRequest: 0,
      closeRequest: 0,
      drafts,
    } as const;
    const { rerender } = render(<ChatBubble {...props} projectRequest={0} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<ChatBubble {...props} projectRequest={1} />);
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/Pageturner/);
    expect(within(talk()).getByRole("button", { name: "Whole project" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("log")).toHaveTextContent("About the whole shop");
  });
});
