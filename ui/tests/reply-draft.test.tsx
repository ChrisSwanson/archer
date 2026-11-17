// @vitest-environment jsdom
// G1 for a reply being written (user-flows rubric §3 G1; ruling 2026-11-02 "Comment drafts (G1)"; round 1's
// gap left after O82, O93): a reply is kept in this browser like a new comment (comment-draft.ts, the same scheme),
// keyed to its thread, given back after a reload, a closed and reopened tab, Escape or leaving, said as restored,
// and removed only by sending it or an explicit Discard.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadCard } from "../src/comments/ThreadCard";
import {
  COMMENT_DRAFT_PREFIX,
  draftBeingWritten,
  forgetReplyDraft,
  keepReplyDraft,
  latestCommentDraft,
  latestReplyDraft,
  readReplyDraft,
  replyDraftKey,
  type ReplyDraft,
} from "../src/comments/comment-draft";
import type { Thread } from "../src/comments/contract";

const thread = (id = "t1", target: Thread["target"] = "view:a"): Thread => ({
  id,
  target,
  anchor: { kind: "node", id: "customer", label: "Customer" },
  status: "sent",
  revision: 1,
  comments: [{ id: "c1", author: "person", body: "Why two calls?", createdAt: "2026-11-02T00:00:00Z" }],
});
const reply = (over: Partial<ReplyDraft> = {}): ReplyDraft => ({
  version: 1,
  scope: "s",
  target: "view:a",
  threadId: "t1",
  body: "Because of retries",
  savedAt: 1,
  ...over,
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("keeps a reply under the comment drafts' prefix and reads it back for its own thread only", () => {
  expect(keepReplyDraft(localStorage, reply())).toBe(true);
  expect(Object.keys(localStorage).every((k) => k.startsWith(COMMENT_DRAFT_PREFIX))).toBe(true);
  expect(readReplyDraft(localStorage, "s", "view:a", "t1")?.body).toBe("Because of retries");
  expect(readReplyDraft(localStorage, "s", "view:a", "t2")).toBeNull();
  expect(readReplyDraft(localStorage, "s", "view:b", "t1")).toBeNull();
  expect(readReplyDraft(localStorage, "another project", "view:a", "t1")).toBeNull();
  // Never offered back as a new comment on the target.
  expect(latestCommentDraft(localStorage, "s", "view:a")).toBeNull();
  expect(forgetReplyDraft(localStorage, "s", "view:a", "t1")).toBe(true);
  expect(readReplyDraft(localStorage, "s", "view:a", "t1")).toBeNull();
});

it("on return, the latest reply kept for a thread still on the target is the one offered back", () => {
  keepReplyDraft(localStorage, reply({ threadId: "t1", body: "older", savedAt: 1 }));
  keepReplyDraft(localStorage, reply({ threadId: "t2", body: "newer", savedAt: 2 }));
  keepReplyDraft(localStorage, reply({ threadId: "t3", target: "view:b", body: "elsewhere", savedAt: 3 }));
  expect(latestReplyDraft(localStorage, "s", "view:a", ["t1", "t2"])?.body).toBe("newer");
  // A thread no longer there (resolved, deleted) is not opened.
  expect(latestReplyDraft(localStorage, "s", "view:a", ["t1"])?.body).toBe("older");
  expect(latestReplyDraft(localStorage, "s", "view:a", [])).toBeNull();
});

it("a reply stored under one thread's key that names another thread is not given back", () => {
  keepReplyDraft(localStorage, reply());
  const key = Object.keys(localStorage)[0]!;
  localStorage.setItem(key, JSON.stringify({ ...reply(), threadId: "t2" }));
  expect(readReplyDraft(localStorage, "s", "view:a", "t1")).toBeNull();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(keepReplyDraft(localStorage, reply())).toBe(false);
});

const card = (props: { inline?: boolean; t?: Thread; save?: (body: string) => Promise<boolean> } = {}) => {
  const save = props.save ?? (async () => true);
  return (
    <ThreadCard
      thread={props.t ?? thread()}
      scope="view"
      inlineReply={props.inline}
      draftScope="s"
      onReply={save}
      onEdit={(_id, body) => save(body)}
      onDelete={() => save("")}
      onResolve={() => save("")}
      onDismiss={() => save("")}
    />
  );
};

it.each([false, true])(
  "the reply is kept as typed and given back when the card is drawn anew (inline %s), said as restored",
  (inline) => {
    const first = render(card({ inline }));
    if (!inline) fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your reply" }), { target: { value: "Because of retries" } });
    expect(readReplyDraft(localStorage, "s", "view:a", "t1")?.body).toBe("Because of retries");
    first.unmount();
    render(card({ inline }));
    // A kept reply opens its editor by itself: the person does not have to know to press Reply again.
    expect((screen.getByRole("textbox", { name: "Your reply" }) as HTMLTextAreaElement).value).toBe(
      "Because of retries",
    );
    expect(screen.getByText(/Restored your unsent reply/)).toBeTruthy();
  },
);

// O174/O179: the page reopens a kept reply's thread unless its box is on the page and being typed in. That is asked of
// the editor, not of when the reply was saved: a box drawn anew with a kept reply is not being written until typed in.
it("a reply box is being written from its first keystroke until it leaves the page, not merely while it shows a kept reply", () => {
  const key = replyDraftKey("s", "view:a", "t1");
  const first = render(card({ inline: true }));
  expect(draftBeingWritten(key)).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "Your reply" }), { target: { value: "Because of retries" } });
  expect(draftBeingWritten(key)).toBe(true);
  first.unmount();
  expect(draftBeingWritten(key)).toBe(false);
  const again = render(card({ inline: true }));
  expect((screen.getByRole("textbox", { name: "Your reply" }) as HTMLTextAreaElement).value).toBe("Because of retries");
  expect(draftBeingWritten(key)).toBe(false);
  again.unmount();
});

it("a reply kept for one thread never appears on another", () => {
  keepReplyDraft(localStorage, reply());
  render(card({ inline: true, t: thread("t2") }));
  expect((screen.getByRole("textbox", { name: "Your reply" }) as HTMLTextAreaElement).value).toBe("");
});

it("Escape and Cancel close the reply editor and keep the text; Reply gives it back", () => {
  render(card());
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const box = screen.getByRole("textbox", { name: "Your reply" });
  fireEvent.change(box, { target: { value: "Kept across Escape" } });
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Your reply" })).toBeNull();
  expect(readReplyDraft(localStorage, "s", "view:a", "t1")?.body).toBe("Kept across Escape");
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect((screen.getByRole("textbox", { name: "Your reply" }) as HTMLTextAreaElement).value).toBe("Kept across Escape");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(readReplyDraft(localStorage, "s", "view:a", "t1")?.body).toBe("Kept across Escape");
});

it("a sent reply is forgotten; a failed one stays kept; Discard forgets a restored one", async () => {
  keepReplyDraft(localStorage, reply({ body: "Will fail" }));
  const failing = render(card({ inline: true, save: async () => false }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  });
  expect(readReplyDraft(localStorage, "s", "view:a", "t1")?.body).toBe("Will fail");
  failing.unmount();
  render(card({ inline: true }));
  fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
  expect(readReplyDraft(localStorage, "s", "view:a", "t1")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Your reply" }) as HTMLTextAreaElement).value).toBe("");
  fireEvent.change(screen.getByRole("textbox", { name: "Your reply" }), { target: { value: "Sent now" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  });
  expect(readReplyDraft(localStorage, "s", "view:a", "t1")).toBeNull();
});

it("storage refused: the reply editor says the text is not kept if the page closes", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  render(card({ inline: true }));
  fireEvent.change(screen.getByRole("textbox", { name: "Your reply" }), { target: { value: "Unkept" } });
  expect(screen.getByRole("alert").textContent).toMatch(/cannot keep this reply/);
});
