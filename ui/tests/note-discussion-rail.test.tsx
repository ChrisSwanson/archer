// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Thread } from "../src/comments/contract";
import { clampDiscussionTop, NoteDiscussionRail, solveDiscussionPositions } from "../src/comments/NoteDiscussionRail";
import { NoteReader } from "../src/comments/NoteReader";
import type { ReviewModel } from "../src/comments/useReview";
import { ThreadCard } from "../src/comments/ThreadCard";
import { NO_CAPABILITIES } from "../src/comments/contract";

afterEach(cleanup);

const passage = (id: string, quote: string): Thread => ({
  id,
  revision: 1,
  target: "note:notes/reader.md",
  anchor: { kind: "passage", quote, prefix: "", suffix: "" },
  status: "draft",
  comments: [{ id: `c-${id}`, author: "person", body: `Comment on ${quote}`, createdAt: "2026-10-11T12:00:00Z" }],
});

it("places nearby discussions deterministically without overlap", () => {
  expect(
    solveDiscussionPositions(
      [
        { id: "second", preferredTop: 18, height: 44 },
        { id: "first", preferredTop: 10, height: 44 },
        { id: "third", preferredTop: 20, height: 44 },
      ],
      8,
    ),
  ).toEqual([
    { id: "first", top: 10 },
    { id: "second", top: 62 },
    { id: "third", top: 114 },
  ]);
});

it.each([
  [
    "attached",
    { anchorTop: 300, anchorBottom: 320, visibleTop: 64, visibleBottom: 700, cardHeight: 260 },
    { top: 300, direction: null },
  ],
  [
    "above",
    { anchorTop: -30, anchorBottom: -10, visibleTop: 64, visibleBottom: 700, cardHeight: 260 },
    { top: 76, direction: "above" },
  ],
  [
    "below",
    { anchorTop: 760, anchorBottom: 780, visibleTop: 64, visibleBottom: 700, cardHeight: 260 },
    { top: 428, direction: "below" },
  ],
] as const)("keeps an expanded discussion %s until its passage leaves the reader", (_case, input, expected) => {
  expect(clampDiscussionTop(input)).toEqual(expected);
});

it("opens a compact passage discussion locally and uses the existing actions", () => {
  const thread = passage("thread-a", "quoted passage");
  const actions = {
    markSeen: vi.fn(),
    reply: vi.fn(async () => true),
    edit: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    resolve: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
  };
  const focused = vi.fn();
  function Example() {
    const [expanded, setExpanded] = useState<string | null>(null);
    return (
      <NoteDiscussionRail
        threads={[thread]}
        actions={actions}
        expandedThreadId={expanded}
        onExpandedThreadChange={setExpanded}
        onFocusedThreadChange={focused}
      />
    );
  }
  render(<Example />);
  const bubble = screen.getByRole("button", { name: /quoted passage/i });
  fireEvent.mouseEnter(bubble);
  fireEvent.click(bubble);
  expect(focused).toHaveBeenCalledWith("thread-a");
  expect(actions.markSeen).toHaveBeenCalledWith(thread);
  expect(screen.getByRole("article")).toHaveTextContent("Comment on quoted passage");
});

it("preserves the note renderer's missing-passage status in an inline discussion", () => {
  const thread = passage("missing-thread", "words no longer present");
  const actions = {
    markSeen: vi.fn(),
    reply: vi.fn(async () => true),
    edit: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    resolve: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
  };
  function Example() {
    const [expanded, setExpanded] = useState<string | null>(null);
    return (
      <NoteDiscussionRail
        threads={[thread]}
        actions={actions}
        missingThreadIds={new Set([thread.id])}
        expandedThreadId={expanded}
        onExpandedThreadChange={setExpanded}
        onFocusedThreadChange={() => {}}
      />
    );
  }
  render(<Example />);
  fireEvent.click(screen.getByRole("button", { name: /words no longer present/i }));
  expect(screen.getByRole("article")).toHaveTextContent("Orphaned");
  expect(screen.getByRole("article")).toHaveTextContent("This passage is no longer in the note.");
});

it("routes a passage mark to the margin without forwarding it to the floating discussion", async () => {
  const thread = passage("local-thread", "parser accepts");
  const onFloatingThread = vi.fn();
  const markSeen = vi.fn();
  const model: ReviewModel = {
    capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
    viewId: "system",
    viewTarget: "view:system",
    threads: new Map([["note:notes/reader.md", [thread]]]),
    notes: { status: "ready", notes: [{ path: "notes/reader.md", title: "Reader" }] },
    noteContents: new Map([
      [
        "notes/reader.md",
        {
          status: "ready",
          content: {
            path: "notes/reader.md",
            frontMatter: {},
            markdown: "The parser accepts nearby tokens.",
            revision: "1",
          },
        },
      ],
    ]),
    pending: 0,
    pendingTargets: [],
    announcement: null,
    error: null,
    submitting: false,
    actions: {
      markSeen,
      create: vi.fn(async () => null),
      reply: vi.fn(async () => true),
      edit: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      resolve: vi.fn(async () => true),
      dismiss: vi.fn(async () => true),
      submitAll: vi.fn(async () => {}),
      openNote: vi.fn(),
      dismissError: vi.fn(),
    },
  };
  render(<NoteReader model={model} path="notes/reader.md" onCompose={() => {}} onOpenThread={onFloatingThread} />);
  const mark = await screen.findByRole("button", { name: "Open discussion on this passage" });
  fireEvent.keyDown(mark, { key: "Enter" });
  expect(onFloatingThread).not.toHaveBeenCalled();
  expect(markSeen).toHaveBeenCalledWith(thread);
  expect(screen.getByRole("complementary", { name: "Note discussions" })).toHaveTextContent(
    "Comment on parser accepts",
  );
});

it("holds an incoming note thread request until its thread loads, then expands and focuses it once", async () => {
  const thread = passage("arrives-later", "parser accepts");
  const onFloatingThread = vi.fn();
  const markSeen = vi.fn();
  const base: ReviewModel = {
    capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
    viewId: "system",
    viewTarget: "view:system",
    threads: new Map(),
    notes: { status: "ready", notes: [{ path: "notes/reader.md", title: "Reader" }] },
    noteContents: new Map([
      [
        "notes/reader.md",
        {
          status: "ready",
          content: {
            path: "notes/reader.md",
            frontMatter: {},
            markdown: "The parser accepts nearby tokens.",
            revision: "1",
          },
        },
      ],
    ]),
    pending: 0,
    pendingTargets: [],
    announcement: null,
    error: null,
    submitting: false,
    actions: {
      markSeen,
      create: vi.fn(async () => null),
      reply: vi.fn(async () => true),
      edit: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      resolve: vi.fn(async () => true),
      dismiss: vi.fn(async () => true),
      submitAll: vi.fn(async () => {}),
      openNote: vi.fn(),
      dismissError: vi.fn(),
    },
  };
  const request = { key: 7, threadId: thread.id };
  const { rerender } = render(
    <NoteReader
      model={base}
      path="notes/reader.md"
      onCompose={() => {}}
      onOpenThread={onFloatingThread}
      incomingThreadRequest={request}
    />,
  );
  expect(screen.queryByRole("complementary", { name: "Note discussions" })).not.toBeInTheDocument();
  const loaded: ReviewModel = { ...base, threads: new Map([["note:notes/reader.md", [thread]]]) };
  rerender(
    <NoteReader
      model={loaded}
      path="notes/reader.md"
      onCompose={() => {}}
      onOpenThread={onFloatingThread}
      incomingThreadRequest={request}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: /Show full quoted passage “parser accepts”/ })).toHaveFocus(),
  );
  expect(screen.getByRole("complementary", { name: "Note discussions" })).toHaveTextContent(
    "Comment on parser accepts",
  );
  expect(markSeen).toHaveBeenCalledTimes(1);
  expect(onFloatingThread).not.toHaveBeenCalled();
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    fireEvent.pointerDown(outside);
    outside.focus();
    rerender(
      <NoteReader
        model={loaded}
        path="notes/reader.md"
        onCompose={() => {}}
        onOpenThread={onFloatingThread}
        incomingThreadRequest={{ ...request, key: 8 }}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: /Show full quoted passage “parser accepts”/ })).toHaveFocus(),
    );
  } finally {
    outside.remove();
  }
});

it("keeps exact-overlap threads individually reachable and cues a choice", () => {
  const first = passage("overlap-a", "same quote");
  const second = {
    ...passage("overlap-b", "same quote"),
    comments: [{ ...passage("overlap-b", "same quote").comments[0]!, body: "Second discussion" }],
  };
  const actions = {
    markSeen: vi.fn(),
    reply: vi.fn(async () => true),
    edit: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    resolve: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
  };
  function Example() {
    const [expanded, setExpanded] = useState<string | null>(null);
    return (
      <NoteDiscussionRail
        threads={[first, second]}
        actions={actions}
        expandedThreadId={expanded}
        requestedThreadIds={[first.id, second.id]}
        onExpandedThreadChange={setExpanded}
        onFocusedThreadChange={() => {}}
      />
    );
  }
  render(<Example />);
  expect(screen.getByRole("status")).toHaveTextContent("2 discussions on this passage");
  const choices = screen.getAllByRole("button", { name: /Open discussion on “same quote”/ });
  expect(choices).toHaveLength(2);
  expect(choices[0]).toHaveFocus();
  fireEvent.click(choices[1]!);
  expect(screen.getByRole("article")).toHaveTextContent("Second discussion");
});

it("collapses on an outside pointer and preserves an unfinished reply for reopening", async () => {
  const thread = passage("draft-reply", "reply passage");
  const actions = {
    markSeen: vi.fn(),
    reply: vi.fn(async () => true),
    edit: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    resolve: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
  };
  function Example() {
    const [expanded, setExpanded] = useState<string | null>(null);
    return (
      <>
        <NoteDiscussionRail
          threads={[thread]}
          actions={actions}
          expandedThreadId={expanded}
          onExpandedThreadChange={setExpanded}
          onFocusedThreadChange={() => {}}
        />
        <button type="button">Outside</button>
      </>
    );
  }
  render(<Example />);
  fireEvent.click(screen.getByRole("button", { name: /reply passage/i }));
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Your reply" }), { target: { value: "Unfinished thought" } });
  fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
  expect(screen.getByRole("textbox", { name: "Your reply", hidden: true })).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /reply passage/i }));
  const reopened = screen.getByRole("textbox", { name: "Your reply" });
  expect(reopened).toHaveValue("Unfinished thought");
  fireEvent.keyDown(reopened, { key: "Escape" });
  expect(screen.getByRole("textbox", { name: "Your reply", hidden: true })).not.toBeVisible();
  await vi.waitFor(() => expect(screen.getByRole("button", { name: /reply passage/i })).toHaveFocus());
  expect(screen.queryByRole("button", { name: "Collapse discussion" })).not.toBeInTheDocument();
});

it("does not let the persistent reply editor steal focus from the bubble that opened it", () => {
  const thread = passage("focus-stays", "focus passage");
  const focused = vi.fn();
  const actions = {
    markSeen: vi.fn(),
    reply: vi.fn(async () => true),
    edit: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    resolve: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
  };
  function Example() {
    const [expanded, setExpanded] = useState<string | null>(null);
    return (
      <NoteDiscussionRail
        threads={[thread]}
        actions={actions}
        expandedThreadId={expanded}
        onExpandedThreadChange={setExpanded}
        onFocusedThreadChange={focused}
      />
    );
  }
  render(<Example />);
  const bubble = screen.getByRole("button", { name: /focus passage/i });
  bubble.focus();
  fireEvent.click(bubble);
  expect(bubble).toHaveFocus();
  const editor = screen.getByRole("textbox", { name: "Your reply" });
  editor.focus();
  expect(editor).toHaveFocus();
  fireEvent.mouseLeave(editor.closest(".primary-note-discussion")!);
  expect(focused).toHaveBeenLastCalledWith(thread.id);
});

it("offers the margin reply editor immediately and keeps a refused draft", async () => {
  const onReply = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(
    <ThreadCard
      thread={passage("inline", "inline reply")}
      scope="note"
      inlineReply
      onReply={onReply}
      onEdit={async () => true}
      onDelete={async () => true}
      onResolve={async () => true}
      onDismiss={async () => true}
    />,
  );
  const editor = screen.getByRole("textbox", { name: "Your reply" });
  expect(editor).toHaveValue("");
  expect(screen.getByRole("button", { name: "Reply" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Resolve" })).toBeVisible();
  fireEvent.change(editor, { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  await vi.waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
  expect(editor).toHaveValue("Keep this draft");
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Reply" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  await vi.waitFor(() => expect(editor).toHaveValue(""));
});

it("lets the margin quote header own the visible anchor without losing the thread's accessible name", () => {
  render(
    <ThreadCard
      thread={passage("owned-heading", "quoted once only")}
      scope="note"
      inlineReply
      hideAnchorHeading
      onReply={async () => true}
      onEdit={async () => true}
      onDelete={async () => true}
      onResolve={async () => true}
      onDismiss={async () => true}
    />,
  );
  const thread = screen.getByRole("article", { name: "Passage: “quoted once only”" });
  expect(thread.querySelector(".archer-thread-anchor")).toHaveClass("archer-visually-hidden");
});
