// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewPanel } from "../src/comments/ReviewPanel";
import { NoteReader } from "../src/comments/NoteReader";
import type { ReviewModel } from "../src/comments/useReview";
import type { Thread } from "../src/comments/contract";
import { installMatchMedia } from "./match-media";
import { createReviewEvents } from "../src/comments/events";
import type { CommentsTransport } from "../src/comments/transport";
import { useReview } from "../src/comments/useReview";
import { NO_CAPABILITIES } from "../src/comments/contract";
afterEach(cleanup);
const existing: Thread = {
  id: "durable",
  revision: 7,
  target: "view:system",
  anchor: { kind: "node", id: "web", label: "Web" },
  status: "answered",
  comments: [
    { id: "person", author: "person", body: "Existing server discussion", createdAt: "2026-10-05T12:00:00Z" },
    { id: "agent", author: "agent", body: "A durable agent answer", createdAt: "2026-10-06T12:00:00Z" },
  ],
};
function model(): ReviewModel {
  return {
    capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
    viewId: "system",
    viewTarget: "view:system",
    threads: new Map([["view:system", [existing]]]),
    notes: { status: "ready", notes: [] },
    noteContents: new Map(),
    pending: 2,
    pendingTargets: [{ target: "view:other", title: "Other diagram", drafts: 2 }],
    announcement: null,
    error: null,
    submitting: false,
    actions: {
      create: vi.fn(async () => existing),
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
}
it("uses old durable threads, separates reader unread from agent status, and sends the whole project", async () => {
  installMatchMedia(false);
  const held = model();
  render(
    <ReviewPanel
      mode="floating"
      model={held}
      open
      compose={null}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /^Unread/ }));
  fireEvent.click(screen.getByRole("button", { name: /Existing server discussion|A durable agent answer/ }));
  expect(screen.getByText("Existing server discussion")).toBeVisible();
  expect(screen.getByText("A durable agent answer")).toBeVisible();
  // Read now: the unread filter lets it go once it is shown on the diagram.
  fireEvent.click(screen.getByRole("button", { name: "Show on diagram" }));
  expect(screen.getByText("Nothing unread.")).toBeVisible();
  fireEvent.click(screen.getAllByRole("button", { name: "Send queued comments (2)" })[0]!);
  expect(held.actions.submitAll).toHaveBeenCalledOnce();
  const move = screen.getByRole("button", { name: "Move discussion" });
  fireEvent.keyDown(move, { key: "ArrowLeft" });
  expect(screen.getByRole("region", { name: "Contextual discussion" })).toHaveAttribute("data-detached", "true");
  fireEvent.click(screen.getByRole("button", { name: "Reattach" }));
  expect(screen.getByRole("region", { name: "Contextual discussion" })).toHaveAttribute("data-detached", "false");
});
it("renders a standalone note with production Markdown and safe links", async () => {
  const held: ReviewModel = {
    ...model(),
    noteContents: new Map([
      [
        "notes/parsing.md",
        {
          status: "ready",
          content: {
            path: "notes/parsing.md",
            frontMatter: {},
            markdown: "# Parsing\n\n**Production** [external](https://example.com) and [diagram](../system.mmd).",
            revision: "1",
          },
        },
      ],
    ]),
  };
  const openLink = vi.fn(() => true);
  render(
    <NoteReader
      model={held}
      path="notes/parsing.md"
      note={{ path: "notes/parsing.md", title: "Parsing" }}
      onCompose={() => {}}
      onOpenLink={openLink}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "external" })).toHaveAttribute("href", "https://example.com"),
  );
  expect(screen.getByRole("article", { name: "Reading Parsing" })).toBeVisible();
  fireEvent.click(screen.getByRole("link", { name: "diagram" }));
  expect(openLink).toHaveBeenCalledWith("../system.mmd", "notes/parsing.md");
});
it("keeps a refused draft and its fixed selection anchor available to retry", async () => {
  installMatchMedia(false);
  const held = model();
  const create = vi.fn(async () => null);
  const refused: ReviewModel = {
    ...held,
    error: "Revision changed. Refresh the discussion and retry.",
    actions: { ...held.actions, create },
  };
  render(
    <ReviewPanel
      mode="floating"
      model={refused}
      open={false}
      compose={{
        key: 1,
        target: "view:system",
        anchor: { kind: "selection", nodes: [{ id: "web", label: "Web" }], edges: [{ id: "e1", label: "calls" }] },
      }}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );
  const editor = screen.getByRole("textbox", { name: "Comment" });
  fireEvent.change(editor, { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      "view:system",
      expect.objectContaining({
        kind: "selection",
        nodes: [{ id: "web", label: "Web" }],
        edges: [{ id: "e1", label: "calls" }],
      }),
      "Keep this draft",
    ),
  );
  expect(editor).toHaveValue("Keep this draft");
  expect(screen.getByRole("alert")).toContainHTML("Revision changed");
});
it("preserves a durable passage anchor and exposes its discussion to keyboard readers", async () => {
  const passage: Thread = {
    ...existing,
    id: "passage",
    target: "note:notes/parsing.md",
    anchor: { kind: "passage", quote: "The parser", prefix: "", suffix: " accepts tokens." },
  };
  const held: ReviewModel = {
    ...model(),
    threads: new Map([["note:notes/parsing.md", [passage]]]),
    noteContents: new Map([
      [
        "notes/parsing.md",
        {
          status: "ready",
          content: { path: "notes/parsing.md", frontMatter: {}, markdown: "The parser accepts tokens.", revision: "1" },
        },
      ],
    ]),
  };
  const onThread = vi.fn();
  render(
    <NoteReader
      model={held}
      path="notes/parsing.md"
      note={{ path: "notes/parsing.md", title: "Parsing" }}
      onCompose={() => {}}
      onOpenThread={onThread}
    />,
  );
  const mark = await screen.findByRole("button", { name: "Open discussion on this passage" });
  fireEvent.keyDown(mark, { key: "Enter" });
  expect(onThread).not.toHaveBeenCalled();
  expect(screen.getByRole("complementary", { name: "Note discussions" })).toHaveTextContent(
    "Existing server discussion",
  );
  expect(mark).toHaveTextContent("The parser");
  expect(screen.queryByRole("button", { name: "Parsing parsing.md" })).not.toBeInTheDocument();
});

it("keeps an agent-opened passage in the agent voice after the person replies", async () => {
  const { ThreadCard } = await import("../src/comments/ThreadCard");
  const opened: Thread = {
    id: "agent-passage",
    revision: 2,
    target: "note:notes/parsing.md",
    anchor: { kind: "passage", quote: "The parser", prefix: "", suffix: " accepts tokens." },
    status: "answered",
    comments: [
      {
        id: "agent-root",
        author: "agent",
        body: "Please check how this handles a very long token stream without losing the original passage context.".repeat(
          8,
        ),
        createdAt: "2026-10-11T12:00:00Z",
      },
      { id: "person-reply", author: "person", body: "I will take a look.", createdAt: "2026-10-11T12:05:00Z" },
    ],
  };
  render(
    <ThreadCard
      thread={opened}
      scope="note"
      onReply={async () => true}
      onEdit={async () => true}
      onDelete={async () => true}
      onResolve={async () => true}
      onDismiss={async () => true}
    />,
  );
  expect(screen.getByText("Agent opened")).toBeVisible();
  expect(screen.getByText("I will take a look.")).toBeVisible();
  cleanup();
  const held: ReviewModel = {
    ...model(),
    threads: new Map([["note:notes/parsing.md", [opened]]]),
    noteContents: new Map([
      [
        "notes/parsing.md",
        {
          status: "ready",
          content: { path: "notes/parsing.md", frontMatter: {}, markdown: "The parser accepts tokens.", revision: "1" },
        },
      ],
    ]),
  };
  render(
    <ReviewPanel
      mode="floating"
      model={held}
      open
      compose={null}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );
  expect(screen.getByRole("region", { name: "Project Review" })).toHaveTextContent("Agent opened");
  cleanup();
  const onThread = vi.fn();
  render(
    <NoteReader
      model={held}
      path="notes/parsing.md"
      note={{ path: "notes/parsing.md", title: "Parsing" }}
      onCompose={() => {}}
      onOpenThread={onThread}
    />,
  );
  const mark = await screen.findByRole("button", { name: "Open discussion on this passage" });
  expect(mark).toHaveClass("archer-passage--agent");
  fireEvent.keyDown(mark, { key: " " });
  expect(onThread).not.toHaveBeenCalled();
  expect(screen.getByRole("complementary", { name: "Note discussions" })).toHaveTextContent(
    "Please check how this handles",
  );
});

it("keeps a person-opened answered thread labelled Answered", async () => {
  const { ThreadCard } = await import("../src/comments/ThreadCard");
  render(
    <ThreadCard
      thread={existing}
      scope="view"
      onReply={async () => true}
      onEdit={async () => true}
      onDelete={async () => true}
      onResolve={async () => true}
      onDismiss={async () => true}
    />,
  );
  expect(screen.getByText("Answered")).toBeVisible();
  expect(screen.queryByText("Agent opened")).not.toBeInTheDocument();
});

it("announces a newly arriving agent-opened discussion", async () => {
  const events = createReviewEvents();
  let threads: readonly Thread[] = [];
  const transport: CommentsTransport = {
    listThreads: async (target) => ({ schemaVersion: 2, target, threads }),
    createThreadOnce: async () => {
      throw new Error("unused");
    },
    replyOnce: async () => {
      throw new Error("unused");
    },
    edit: async () => {
      throw new Error("unused");
    },
    remove: async () => {
      throw new Error("unused");
    },
    resolve: async () => {},
    dismiss: async () => {},
    pending: async () => ({ total: 0, targets: [] }),
    submitOnce: async () => {
      throw new Error("unused");
    },
    listNotes: async (viewId) => ({ viewId, notes: [] }),
    noteContent: async () => {
      throw new Error("unused");
    },
    noteEmphasis: async () => {
      throw new Error("unused");
    },
    upsertNoteEmphasis: async () => {
      throw new Error("unused");
    },
  };
  const { result } = renderHook(() =>
    useReview({
      transport,
      events,
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: "system",
    }),
  );
  await waitFor(() => expect(result.current.threads.get("view:system")).toEqual([]));
  threads = [
    {
      id: "agent-new",
      revision: 1,
      target: "view:system",
      anchor: { kind: "view" },
      status: "answered",
      comments: [
        {
          id: "agent-root",
          author: "agent",
          body: "Could you verify this boundary?",
          createdAt: "2026-10-11T12:00:00Z",
        },
      ],
    },
  ];
  act(() => events.emit({ type: "comments", target: "view:system" }));
  await waitFor(() => expect(result.current.announcement?.text).toBe("Agent opened Whole diagram."));
  expect(result.current.unreadAnswers).toBe(1);
});

it.each([
  [
    "sequence participant",
    'data-seq-id="web" data-seq-channel="participants"',
    { kind: "node", id: "web", label: "Web" },
  ],
  ["sequence message", 'data-seq-id="e1" data-seq-channel="messages"', { kind: "edge", id: "e1", label: "calls" }],
  ["journey task", 'data-journey-id="web"', { kind: "node", id: "web", label: "Web" }],
  ["graph group", 'class="react-flow__node" data-id="group:web"', { kind: "group", id: "web", label: "Web" }],
] as const)("reattaches to the production %s marker", async (_name, attributes, anchor) => {
  const marker = document.createElement("div");
  marker.innerHTML = `<div ${attributes}></div>`;
  document.body.append(marker);
  vi.spyOn(marker.firstElementChild!, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 200, 120, 60));
  const { FloatingDiscussion } = await import("../src/comments/FloatingDiscussion");
  render(
    <FloatingDiscussion anchor={anchor} title="Web" onClose={() => {}}>
      Message
    </FloatingDiscussion>,
  );
  expect(screen.queryByText(/Original location is unavailable/)).not.toBeInTheDocument();
  marker.remove();
});

it("focuses the original durable thread when a pin requests it", async () => {
  installMatchMedia(false);
  render(
    <ReviewPanel
      mode="floating"
      model={model()}
      open={false}
      compose={null}
      threadRequest={{ key: 1, threadId: "durable" }}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );
  await waitFor(() => expect(document.getElementById("archer-thread-durable")).toHaveFocus());
});
it("keeps the same pin number in the selected durable thread as on its diagram", () => {
  installMatchMedia(false);
  render(
    <ReviewPanel
      mode="floating"
      model={model()}
      open={false}
      compose={null}
      threadRequest={{ key: 1, threadId: "durable" }}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );
  expect(document.querySelector("#archer-thread-durable .archer-pin")).toHaveTextContent("1");
});
it("refuses an unmatched internal link without leaving the note", async () => {
  const held: ReviewModel = {
    ...model(),
    noteContents: new Map([
      [
        "notes/parsing.md",
        {
          status: "ready",
          content: {
            path: "notes/parsing.md",
            frontMatter: {},
            markdown: "[Missing diagram](../missing.mmd)",
            revision: "1",
          },
        },
      ],
    ]),
  };
  render(
    <NoteReader
      model={held}
      path="notes/parsing.md"
      note={{ path: "notes/parsing.md", title: "Parsing" }}
      onCompose={() => {}}
      onOpenLink={() => false}
    />,
  );
  fireEvent.click(await screen.findByRole("link", { name: "Missing diagram" }));
  expect(screen.getByRole("status")).toHaveTextContent("Unavailable");
  expect(screen.getByRole("article", { name: "Reading Parsing" })).toBeVisible();
});
it("offers bulk send in both surfaces without a list of where the drafts are (decided 2026-10-29)", () => {
  installMatchMedia(false);
  render(
    <ReviewPanel
      mode="floating"
      model={model()}
      open
      compose={null}
      threadRequest={{ key: 1, threadId: "durable" }}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );
  expect(screen.getAllByRole("button", { name: "Send queued comments (2)" }).length).toBeGreaterThan(0);
  expect(screen.queryByText("Where the drafts are")).toBeNull();
  expect(screen.queryByRole("list", { name: "Where the drafts are" })).toBeNull();
});
it("offers Reattach only after the discussion has been moved", async () => {
  const { FloatingDiscussion } = await import("../src/comments/FloatingDiscussion");
  render(
    <FloatingDiscussion anchor={{ kind: "view" }} title="Whole diagram" onClose={() => {}}>
      Message
    </FloatingDiscussion>,
  );
  expect(screen.queryByRole("button", { name: "Reattach" })).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("button", { name: "Move discussion" }), { key: "ArrowLeft" });
  expect(screen.getByRole("button", { name: "Reattach" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reattach" }));
  expect(screen.queryByRole("button", { name: "Reattach" })).not.toBeInTheDocument();
});
it("focuses the newly requested thread after another thread is selected", async () => {
  installMatchMedia(false);
  const other: Thread = { ...existing, id: "other", anchor: { kind: "node", id: "db", label: "Database" } };
  const held: ReviewModel = { ...model(), threads: new Map([["view:system", [existing, other]]]) };
  const props = {
    mode: "floating" as const,
    model: held,
    open: false,
    compose: null,
    onClose: () => {},
    onCompose: () => {},
    onComposeEnd: () => {},
    diagramChoices: [],
  };
  const { rerender } = render(<ReviewPanel {...props} threadRequest={{ key: 1, threadId: "durable" }} />);
  await waitFor(() => expect(document.getElementById("archer-thread-durable")).toHaveFocus());
  rerender(<ReviewPanel {...props} threadRequest={{ key: 2, threadId: "other" }} />);
  await waitFor(() => expect(document.getElementById("archer-thread-other")).toHaveFocus());
});
it("retains an unsent graph reply when Escape closes and a pin reopens its discussion", async () => {
  installMatchMedia(false);
  const props = {
    mode: "floating" as const,
    model: model(),
    open: false,
    compose: null,
    onClose: () => {},
    onCompose: () => {},
    onComposeEnd: () => {},
    diagramChoices: [],
  };
  const { rerender } = render(<ReviewPanel {...props} threadRequest={{ key: 1, threadId: "durable" }} />);
  const reply = await screen.findByRole("textbox", { name: "Your reply" });
  fireEvent.change(reply, { target: { value: "Still composing" } });
  fireEvent.keyDown(reply, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Contextual discussion" })).toBeNull());
  rerender(<ReviewPanel {...props} threadRequest={{ key: 2, threadId: "durable" }} />);
  expect(await screen.findByRole("textbox", { name: "Your reply" })).toHaveValue("Still composing");
});
it("places a right-edge anchored preview to the left so its source stays clickable", async () => {
  const marker = document.createElement("div");
  marker.className = "react-flow__node";
  marker.dataset.id = "web";
  document.body.append(marker);
  const rect = new DOMRect(window.innerWidth - 220, 100, 120, 60);
  vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(rect);
  const { FloatingDiscussion } = await import("../src/comments/FloatingDiscussion");
  render(
    <FloatingDiscussion anchor={{ kind: "node", id: "web", label: "Web" }} title="Web" onClose={() => {}}>
      Message
    </FloatingDiscussion>,
  );
  const discussion = screen.getByRole("region", { name: "Contextual discussion" });
  expect(Number.parseFloat(discussion.style.left) + 360).toBeLessThan(rect.left);
  marker.remove();
});
it("gives direct note discussion controls a valid named group", () => {
  const held: ReviewModel = {
    ...model(),
    noteContents: new Map([
      [
        "notes/parsing.md",
        {
          status: "ready",
          content: { path: "notes/parsing.md", frontMatter: {}, markdown: "The parser accepts tokens.", revision: "1" },
        },
      ],
    ]),
  };
  render(
    <NoteReader
      model={held}
      path="notes/parsing.md"
      note={{ path: "notes/parsing.md", title: "Parsing" }}
      onCompose={() => {}}
      onOpenThread={() => {}}
    />,
  );
  expect(screen.getByRole("group", { name: "Note discussions" })).toBeVisible();
});
it.each(["save", "cancel"] as const)(
  "returns focus after reply %s even when animation frames run before React commits",
  async (action) => {
    const { ThreadCard } = await import("../src/comments/ThreadCard");
    const onReply = vi.fn(async () => true);
    render(
      <ThreadCard
        thread={existing}
        scope="view"
        onReply={onReply}
        onEdit={async () => true}
        onDelete={async () => true}
        onResolve={async () => true}
        onDismiss={async () => true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const editor = screen.getByRole("textbox", { name: "Your reply" });
    fireEvent.change(editor, { target: { value: "Keep the reply" } });
    const frame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    try {
      // Focus is back on Reply in the same commit that removes the editor, not in a later passive effect:
      // a check woken by that DOM change ran first on a loaded runner and found focus on the body (O35).
      const focusWhenGone = new Promise<Element | null>((resolve) => {
        const observer = new MutationObserver(() => {
          if (!editor.isConnected) {
            observer.disconnect();
            resolve(document.activeElement);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      fireEvent.keyDown(editor, action === "save" ? { key: "Enter", metaKey: true } : { key: "Escape" });
      expect(await focusWhenGone).toBe(screen.getByRole("button", { name: "Reply" }));
      if (action === "save") expect(onReply).toHaveBeenCalledWith("Keep the reply");
      else expect(onReply).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Reply" })).toHaveFocus();
    } finally {
      frame.mockRestore();
    }
  },
);

it("closes a requested discussion when contents replaces its document despite the retained view target", async () => {
  installMatchMedia(false);
  const props = {
    mode: "floating" as const,
    model: model(),
    open: false,
    compose: null,
    threadRequest: { key: 1, threadId: "durable" },
    onClose: () => {},
    onCompose: () => {},
    onComposeEnd: () => {},
    diagramChoices: [],
  };
  const { rerender } = render(<ReviewPanel {...props} documentKey="view:system" />);
  await waitFor(() => expect(screen.getByRole("region", { name: "Contextual discussion" })).toBeVisible());
  rerender(<ReviewPanel {...props} documentKey="contents" />);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Contextual discussion" })).toBeNull());
});
it("does not replay an old graph thread request when a note replaces its document", async () => {
  installMatchMedia(false);
  const props = {
    mode: "floating" as const,
    model: model(),
    open: false,
    compose: null,
    threadRequest: { key: 1, threadId: "durable" },
    onClose: () => {},
    onCompose: () => {},
    onComposeEnd: () => {},
    diagramChoices: [],
  };
  const { rerender } = render(<ReviewPanel {...props} documentKey="view:system" />);
  await waitFor(() => expect(screen.getByRole("region", { name: "Contextual discussion" })).toBeVisible());
  rerender(<ReviewPanel {...props} documentKey="note:notes/auth.md" selectedNotePath="notes/auth.md" />);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Contextual discussion" })).toBeNull());
});
it("shows a note title once: a leading Markdown heading that repeats it is not drawn again (G6)", async () => {
  const note = (markdown: string): ReviewModel => ({
    ...model(),
    noteContents: new Map([
      [
        "notes/parsing.md",
        { status: "ready", content: { path: "notes/parsing.md", frontMatter: {}, markdown, revision: "1" } },
      ],
    ]),
  });
  const view = render(
    <NoteReader
      model={note("# Parsing\n\nThe body.")}
      path="notes/parsing.md"
      note={{ path: "notes/parsing.md", title: "Parsing" }}
      onCompose={() => {}}
      onOpenLink={() => true}
    />,
  );
  await screen.findByText("The body.");
  expect(screen.getAllByRole("heading", { name: "Parsing" }).map((h) => h.tagName)).toEqual(["H1"]);
  view.unmount();
  render(
    <NoteReader
      model={note("# Background\n\nThe body.")}
      path="notes/parsing.md"
      note={{ path: "notes/parsing.md", title: "Parsing" }}
      onCompose={() => {}}
      onOpenLink={() => true}
    />,
  );
  await screen.findByText("The body.");
  expect(screen.getByRole("heading", { name: "Background" })).toBeVisible();
});
it("keeps heading levels sequential under the note title once a repeated title is dropped (G6)", async () => {
  const note = (markdown: string): ReviewModel => ({
    ...model(),
    noteContents: new Map([
      [
        "notes/parsing.md",
        { status: "ready", content: { path: "notes/parsing.md", frontMatter: {}, markdown, revision: "1" } },
      ],
    ]),
  });
  render(
    <NoteReader
      model={note("# Parsing\n\n## Tokens\n\n### Edge cases\n\nThe body.")}
      path="notes/parsing.md"
      note={{ path: "notes/parsing.md", title: "Parsing" }}
      onCompose={() => {}}
      onOpenLink={() => true}
    />,
  );
  await screen.findByText("The body.");
  expect(screen.getAllByRole("heading").map((h) => `${h.tagName} ${h.textContent}`)).toEqual([
    "H1 Parsing",
    "H2 Tokens",
    "H3 Edge cases",
  ]);
  cleanup();
  render(
    <NoteReader
      model={note("# Parsing\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nThe body.")}
      path="notes/parsing.md"
      note={{ path: "notes/parsing.md", title: "Parsing" }}
      onCompose={() => {}}
      onOpenLink={() => true}
    />,
  );
  await screen.findByText("The body.");
  expect(screen.getAllByRole("heading").map((h) => h.tagName)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6"]);
});

it("keeps the precise whole-block scope in the picker, discussion and Project Review entry", async () => {
  installMatchMedia(false);
  const anchor = { kind: "group" as const, id: "frag-0", label: "additions unavailable" };
  const label = "opt block: additions unavailable";
  const thread = { ...existing, anchor, status: "draft" as const };
  const held: ReviewModel = { ...model(), threads: new Map([[thread.target, [thread]]]) };
  const props = {
    mode: "floating" as const,
    model: held,
    open: true,
    compose: { key: 1, target: "view:system" as const, anchor },
    onClose: () => {},
    onCompose: () => {},
    onComposeEnd: () => {},
    commentScopes: {
      choices: true,
      guard: (anchor: import("../src/comments/contract").Anchor) =>
        anchor.kind === "group" ? ("block" as const) : undefined,
    },
    diagramChoices: [
      { anchor: { kind: "view" as const }, label: "Whole diagram" },
      { anchor, label },
    ],
  };
  const mounted = render(<ReviewPanel {...props} />);
  expect(screen.getByRole("combobox", { name: "Comment on" })).toHaveDisplayValue(label);
  expect(document.querySelector(".primary-floating-context")).toHaveTextContent(label);
  mounted.rerender(<ReviewPanel {...props} compose={null} />);
  fireEvent.click(screen.getByRole("tab", { name: /^All/ }));
  expect(screen.getByRole("button", { name: /Existing server discussion|A durable agent answer/ })).toHaveTextContent(
    label,
  );
});
