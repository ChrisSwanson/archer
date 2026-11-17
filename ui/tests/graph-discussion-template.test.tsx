// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewPanel } from "../src/comments/ReviewPanel";
import type { Thread } from "../src/comments/contract";
import type { ReviewModel } from "../src/comments/useReview";
import { installMatchMedia } from "./match-media";
import { NO_CAPABILITIES } from "../src/comments/contract";

afterEach(cleanup);

const thread: Thread = {
  id: "graph-template",
  revision: 2,
  target: "view:system",
  anchor: { kind: "node", id: "web", label: "Web" },
  status: "answered",
  comments: [
    { id: "person", author: "person", body: "How is this connected?", createdAt: "2026-10-11T12:00:00Z" },
    { id: "agent", author: "agent", body: "Through the API.", createdAt: "2026-10-11T12:01:00Z" },
  ],
};

function model(): ReviewModel {
  return {
    capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
    viewId: "system",
    viewTarget: "view:system",
    threads: new Map([["view:system", [thread]]]),
    notes: { status: "ready", notes: [] },
    noteContents: new Map(),
    pending: 0,
    pendingTargets: [],
    announcement: null,
    error: null,
    submitting: false,
    actions: {
      create: vi.fn(async () => thread),
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

it("opens a graph discussion with the shared reply template already visible", async () => {
  installMatchMedia(false);
  render(
    <ReviewPanel
      mode="floating"
      model={model()}
      open={false}
      compose={null}
      threadRequest={{ key: 1, threadId: thread.id }}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );

  const discussion = await screen.findByRole("region", { name: "Contextual discussion" });
  expect(await screen.findByRole("textbox", { name: "Your reply" })).toBeVisible();
  expect(screen.getByRole("button", { name: /^Reply$/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /^Resolve$/ })).toBeVisible();
  await waitFor(() => expect(discussion.querySelector("article")).toHaveFocus());
});

it("uses the shared reply template in expanded graph inbox details", () => {
  installMatchMedia(false);
  render(
    <ReviewPanel
      mode="floating"
      model={model()}
      open
      compose={null}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );

  const entry = screen.getByRole("button", { name: /How is this connected/ });
  fireEvent.click(entry);
  const card = screen.getByRole("article", { name: "Node: Web" });
  expect(within(card).getByRole("textbox", { name: "Your reply" })).toBeVisible();
  expect(within(card).getByRole("button", { name: /^Reply$/ })).toBeDisabled();
  expect(within(card).getByRole("button", { name: /^Resolve$/ })).toBeVisible();
});

it("keeps queued sending available without a draft-publication explanation in the discussion", async () => {
  installMatchMedia(false);
  const held = { ...model(), pending: 2 };
  render(
    <ReviewPanel
      mode="floating"
      model={held}
      open={false}
      compose={null}
      threadRequest={{ key: 1, threadId: thread.id }}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );
  const discussion = await screen.findByRole("region", { name: "Contextual discussion" });
  expect(within(discussion).queryByText(/drafts in this project, not published yet/)).toBeNull();
  fireEvent.click(await within(discussion).findByRole("button", { name: "Send queued comments (2)" }));
  expect(held.actions.submitAll).toHaveBeenCalledOnce();
});

it("routes an open-note thread to the reader instead of a second floating discussion", () => {
  installMatchMedia(false);
  const noteThread: Thread = {
    ...thread,
    id: "note-template",
    target: "note:notes/auth.md",
    anchor: { kind: "passage", quote: "Tokens expire", prefix: "", suffix: " after an hour." },
  };
  const held = model();
  const noteModel: ReviewModel = {
    ...held,
    threads: new Map([[noteThread.target, [noteThread]]]),
    noteContents: new Map([
      [
        "notes/auth.md",
        {
          status: "ready",
          content: { path: "notes/auth.md", frontMatter: {}, markdown: "Tokens expire after an hour.", revision: "1" },
        },
      ],
    ]),
  };
  const onOpenInlineNoteThread = vi.fn();
  render(
    <ReviewPanel
      mode="floating"
      model={noteModel}
      open
      selectedNotePath="notes/auth.md"
      inlineNoteDiscussions
      onOpenInlineNoteThread={onOpenInlineNoteThread}
      compose={null}
      threadRequest={{ key: 1, threadId: noteThread.id }}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );

  expect(screen.queryByRole("region", { name: "Contextual discussion" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /How is this connected/ }));
  fireEvent.click(screen.getByRole("button", { name: "Show in note" }));
  expect(onOpenInlineNoteThread).toHaveBeenCalledWith(noteThread.id);
  expect(screen.queryByRole("region", { name: "Contextual discussion" })).not.toBeInTheDocument();
});
