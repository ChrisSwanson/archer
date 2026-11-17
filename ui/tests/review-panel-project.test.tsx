// @vitest-environment jsdom
// The review panel and the project conversation (wave 2 review, finding 16): a project thread opens in the
// chat bubble, never as a floating card with a dead "Show on diagram".
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewPanel } from "../src/comments/ReviewPanel";
import type { ReviewModel } from "../src/comments/useReview";
import type { Thread } from "../src/comments/contract";
import { installMatchMedia } from "./match-media";
afterEach(cleanup);

const projectThread: Thread = {
  id: "proj",
  revision: 2,
  target: "project:",
  anchor: { kind: "project" },
  status: "answered",
  comments: [
    { id: "q", author: "person", body: "Where do I start?", createdAt: "2026-10-05T12:00:00Z" },
    { id: "a", author: "agent", body: "With the overview.", createdAt: "2026-10-06T12:00:00Z" },
  ],
};
function model(): ReviewModel {
  return {
    capabilities: { comments: true, notes: true },
    viewId: "system",
    viewTarget: "view:system",
    threads: new Map([["project:", [projectThread]]]),
    notes: { status: "ready", notes: [] },
    noteContents: new Map(),
    pending: 0,
    pendingTargets: [],
    announcement: null,
    error: null,
    submitting: false,
    actions: {
      create: vi.fn(),
      reply: vi.fn(async () => true),
      edit: vi.fn(),
      remove: vi.fn(),
      resolve: vi.fn(),
      dismiss: vi.fn(),
      submitAll: vi.fn(),
      openNote: vi.fn(),
      dismissError: vi.fn(),
      markSeen: vi.fn(),
    },
  } as unknown as ReviewModel;
}
const base = {
  mode: "floating" as const,
  compose: null,
  onClose: () => {},
  onCompose: () => {},
  onComposeEnd: () => {},
  diagramChoices: [],
};

it("the inbox's entry for a project thread opens the chat, titled with the project", () => {
  installMatchMedia(false);
  const onOpenTarget = vi.fn();
  const held = model();
  render(
    <ReviewPanel
      {...base}
      model={held}
      open
      onOpenTarget={onOpenTarget}
      targetTitle={(t) => (t === "project:" ? "Pageturner" : t)}
    />,
  );
  expect(screen.getByRole("heading", { name: /Pageturner/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Whole project/ }));
  expect(screen.queryByRole("button", { name: "Show on diagram" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open in chat" }));
  expect(onOpenTarget).toHaveBeenCalledWith("project:");
  expect(held.actions.markSeen).toHaveBeenCalled();
  expect(document.getElementById("archer-thread-proj")).toBeNull();
});

it("a request for a project thread opens the chat instead of a floating card", () => {
  installMatchMedia(false);
  const onOpenTarget = vi.fn();
  render(
    <ReviewPanel
      {...base}
      model={model()}
      open={false}
      threadRequest={{ key: 1, threadId: "proj" }}
      onOpenTarget={onOpenTarget}
    />,
  );
  expect(onOpenTarget).toHaveBeenCalledWith("project:");
  expect(document.getElementById("archer-thread-proj")).toBeNull();
});
