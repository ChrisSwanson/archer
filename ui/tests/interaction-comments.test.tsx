// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteItem } from "../src/comments/NoteItem";
import { NoteReader } from "../src/comments/NoteReader";
import { ReviewPanel } from "../src/comments/ReviewPanel";
import type { ReviewModel } from "../src/comments/useReview";
import type { Thread } from "../src/comments/contract";
import { installMatchMedia } from "./match-media";
import { NO_CAPABILITIES } from "../src/comments/contract";
afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});
const thread: Thread = {
  id: "durable",
  revision: 1,
  target: "view:system",
  anchor: { kind: "node", id: "web", label: "Web" },
  status: "draft",
  comments: [{ id: "person", author: "person", body: "Existing discussion", createdAt: "2026-10-06T12:00:00Z" }],
};
function model(): ReviewModel {
  return {
    capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
    viewId: "system",
    viewTarget: "view:system",
    threads: new Map([["view:system", [thread]]]),
    notes: { status: "ready", notes: [] },
    noteContents: new Map([
      [
        "notes/auth.md",
        {
          status: "ready",
          content: { path: "notes/auth.md", frontMatter: {}, markdown: "Tokens expire after an hour.", revision: "1" },
        },
      ],
    ]),
    pending: 1,
    pendingTargets: [{ target: "view:system", title: "System", drafts: 1 }],
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
function select(root: HTMLElement, quote: string) {
  const node = root.querySelector("p")!.firstChild!;
  const start = node.textContent!.indexOf(quote);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + quote.length);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}
it("offers selection comments beside selected note text without footer controls", () => {
  const compose = vi.fn();
  render(
    <NoteReader
      model={model()}
      path="notes/auth.md"
      note={{ path: "notes/auth.md", title: "Auth" }}
      onCompose={compose}
    />,
  );
  expect(screen.queryByRole("button", { name: "Comment on selection" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Comment on note" })).not.toBeInTheDocument();
  select(screen.getByRole("document", { name: "Note: Auth" }), "expire");
  const action = screen.getByRole("button", { name: "Comment on selection" });
  fireEvent.mouseDown(action);
  fireEvent.click(action);
  expect(compose).toHaveBeenCalledWith("note:notes/auth.md", {
    kind: "passage",
    quote: "expire",
    prefix: "Tokens ",
    suffix: " after an hour.",
  });
});
it("opens an accessible whole-note action from the reading body context menu", () => {
  const compose = vi.fn();
  render(
    <NoteReader
      model={model()}
      path="notes/auth.md"
      note={{ path: "notes/auth.md", title: "Auth" }}
      onCompose={compose}
    />,
  );
  fireEvent.keyDown(screen.getByRole("document", { name: "Note: Auth" }), { key: "F10", shiftKey: true });
  const action = screen.getByRole("menuitem", { name: "Comment on note" });
  expect(action).toHaveFocus();
  fireEvent.click(action);
  expect(compose).toHaveBeenCalledWith("note:notes/auth.md", { kind: "view" });
});
it("portals only the inbox into the shared navigation host while retaining discussion state", () => {
  installMatchMedia(false);
  const host = document.createElement("div");
  host.id = "review-host";
  document.body.append(host);
  const held = { ...model(), holdDrafts: true };
  const props = {
    mode: "floating" as const,
    inboxHostId: "review-host",
    model: held,
    open: true,
    compose: null,
    onClose: () => {},
    onCompose: () => {},
    onComposeEnd: () => {},
    diagramChoices: [],
  };
  const { rerender } = render(<ReviewPanel {...props} />);
  try {
    const inbox = within(host).getByRole("region", { name: "Project Review" });
    fireEvent.click(within(inbox).getByRole("tab", { name: /^Drafts/ }));
    fireEvent.click(within(inbox).getByRole("button", { name: /Existing discussion/ }));
    fireEvent.click(within(inbox).getByRole("button", { name: "Show on diagram" }));
    expect(host.contains(screen.getByRole("region", { name: "Contextual discussion" }))).toBe(false);
    rerender(<ReviewPanel {...props} open={false} />);
    rerender(<ReviewPanel {...props} />);
    expect(within(host).getByRole("tab", { name: /^Drafts/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(host).getByRole("button", { name: "Send queued comments (1)" }));
    expect(held.actions.submitAll).toHaveBeenCalledOnce();
  } finally {
    host.remove();
  }
});
it("clears collapsed and cross-note selections and preserves the native link menu", () => {
  const held = { ...model(), noteContents: new Map(model().noteContents) };
  held.noteContents.set("notes/other.md", {
    status: "ready",
    content: {
      path: "notes/other.md",
      frontMatter: {},
      markdown: "Other text [external](https://example.com).",
      revision: "1",
    },
  });
  const compose = vi.fn();
  const { rerender } = render(
    <NoteReader
      model={held}
      path="notes/auth.md"
      note={{ path: "notes/auth.md", title: "Auth" }}
      onCompose={compose}
    />,
  );
  const body = screen.getByRole("document", { name: "Note: Auth" });
  select(body, "expire");
  expect(screen.getByRole("button", { name: "Comment on selection" })).toBeVisible();
  document.getSelection()!.collapseToStart();
  fireEvent(document, new Event("selectionchange"));
  expect(screen.queryByRole("button", { name: "Comment on selection" })).not.toBeInTheDocument();
  select(body, "expire");
  rerender(
    <NoteReader
      model={held}
      path="notes/other.md"
      note={{ path: "notes/other.md", title: "Other" }}
      onCompose={compose}
    />,
  );
  expect(screen.queryByRole("button", { name: "Comment on selection" })).not.toBeInTheDocument();
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  screen.getByRole("link", { name: "external" }).dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(compose).not.toHaveBeenCalled();
});
it("does not reopen a dismissed selection action on the Escape key release", () => {
  render(
    <NoteReader
      model={model()}
      path="notes/auth.md"
      note={{ path: "notes/auth.md", title: "Auth" }}
      onCompose={() => {}}
    />,
  );
  const body = screen.getByRole("document", { name: "Note: Auth" });
  select(body, "expire");
  const action = screen.getByRole("button", { name: "Comment on selection" });
  action.focus();
  fireEvent.keyDown(action, { key: "Escape" });
  fireEvent.keyUp(body, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Comment on selection" })).not.toBeInTheDocument();
  expect(body).toHaveFocus();
});
it("refuses an overlong Unicode passage without replacing its native context menu", async () => {
  const { MAX_PASSAGE_QUOTE_CHARS } = await import("../src/comments/contract");
  const long = "😀".repeat(MAX_PASSAGE_QUOTE_CHARS + 1);
  const held = { ...model(), noteContents: new Map(model().noteContents) };
  held.noteContents.set("notes/auth.md", {
    status: "ready",
    content: { path: "notes/auth.md", frontMatter: {}, markdown: long, revision: "1" },
  });
  const compose = vi.fn();
  render(
    <NoteReader
      model={held}
      path="notes/auth.md"
      note={{ path: "notes/auth.md", title: "Auth" }}
      onCompose={compose}
    />,
  );
  const body = screen.getByRole("document", { name: "Note: Auth" });
  select(body, long);
  expect(screen.getByRole("button", { name: "Comment on selection" })).toBeDisabled();
  const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  body.dispatchEvent(context);
  expect(context.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(compose).not.toHaveBeenCalled();
});
it("keeps the standalone inbox when an optional host is unavailable", () => {
  installMatchMedia(false);
  render(
    <ReviewPanel
      mode="floating"
      inboxHostId="missing-host"
      model={model()}
      open
      compose={null}
      onClose={() => {}}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );
  expect(screen.getByRole("region", { name: "Project Review" })).not.toHaveAttribute("data-hosted");
});

it("retains the legacy sidebar disabled-selection explanation", () => {
  const held = model();
  render(
    <NoteItem
      note={{ path: "notes/auth.md", title: "Auth" }}
      state={held.noteContents.get("notes/auth.md")}
      threads={[]}
      commentsEnabled
      onOpen={() => {}}
      onCompose={() => {}}
      onMissing={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Auth/ }));
  const button = screen.getByRole("button", { name: "Comment on selection" });
  expect(button).toBeDisabled();
  expect(button).toHaveAccessibleDescription("Select some text in the note to comment on that passage.");
});

it("consumes hosted inbox Escape and delegates close without changing thread state", () => {
  const host = document.createElement("div");
  host.id = "escape-review-host";
  document.body.append(host);
  const close = vi.fn();
  const held = model();
  render(
    <ReviewPanel
      mode="floating"
      inboxHostId="escape-review-host"
      model={held}
      open
      compose={null}
      onClose={close}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
    />,
  );
  try {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(within(host).getByRole("button", { name: "Close project review" }), event);
    expect(event.defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(held.threads.get("view:system")).toEqual([thread]);
  } finally {
    host.remove();
  }
});
