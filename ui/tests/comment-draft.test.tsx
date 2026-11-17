// @vitest-environment jsdom
// G1 for a comment being written (user-flows rubric §3 G1, §6 promise list; review flows-r1 claude-01, O82): the
// text, what it is about and the revision it was written against are kept in this browser as the person types, so
// a reload or a closed and reopened tab gives them back, on that target only; a browser that refuses to keep it
// is said to, and nothing claims the text is kept.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "../src/comments/Composer";
import {
  COMMENT_DRAFT_PREFIX,
  forgetCommentDraft,
  keepCommentDraft,
  latestCommentDraft,
  readCommentDraft,
  type CommentDraft,
} from "../src/comments/comment-draft";
import type { Anchor } from "../src/comments/contract";

const node: Anchor = { kind: "node", id: "customer", label: "Customer" };
const other: Anchor = { kind: "node", id: "api", label: "Shop API" };
const draft = (over: Partial<CommentDraft> = {}): CommentDraft => ({
  version: 1,
  scope: "s",
  target: "view:a",
  anchor: node,
  body: "Why two calls?",
  baseRevision: "sha256:" + "a".repeat(64),
  savedAt: 1,
  ...over,
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("keeps a draft and reads it back for its own target and anchor only", () => {
  expect(keepCommentDraft(localStorage, draft())).toBe(true);
  expect(readCommentDraft(localStorage, "s", "view:a", node)?.body).toBe("Why two calls?");
  expect(readCommentDraft(localStorage, "s", "view:a", node)?.baseRevision).toBe("sha256:" + "a".repeat(64));
  expect(readCommentDraft(localStorage, "s", "view:b", node)).toBeNull();
  expect(readCommentDraft(localStorage, "s", "view:a", other)).toBeNull();
  expect(readCommentDraft(localStorage, "another project", "view:a", node)).toBeNull();
});

it("offers back the latest draft of the target asked about, never another target's", () => {
  keepCommentDraft(localStorage, draft({ body: "older", savedAt: 1 }));
  keepCommentDraft(localStorage, draft({ anchor: other, body: "newer", savedAt: 2 }));
  keepCommentDraft(localStorage, draft({ target: "view:b", body: "view B", savedAt: 3 }));
  expect(latestCommentDraft(localStorage, "s", "view:a")?.body).toBe("newer");
  expect(latestCommentDraft(localStorage, "s", "view:b")?.body).toBe("view B");
  expect(latestCommentDraft(localStorage, "s", "view:c")).toBeNull();
});

it("a stored draft under one key that names another target is not given back (copied or tampered bytes)", () => {
  keepCommentDraft(localStorage, draft());
  const key = Object.keys(localStorage).find((k) => k.startsWith(COMMENT_DRAFT_PREFIX))!;
  localStorage.setItem(key, JSON.stringify({ ...draft(), target: "view:b" }));
  expect(readCommentDraft(localStorage, "s", "view:a", node)).toBeNull();
  expect(latestCommentDraft(localStorage, "s", "view:a")).toBeNull();
  localStorage.setItem(key, "{not json");
  expect(latestCommentDraft(localStorage, "s", "view:a")).toBeNull();
});

it("forgets a draft, and a full or denied store answers false instead of throwing", () => {
  keepCommentDraft(localStorage, draft());
  expect(forgetCommentDraft(localStorage, "s", "view:a", node)).toBe(true);
  expect(latestCommentDraft(localStorage, "s", "view:a")).toBeNull();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(keepCommentDraft(localStorage, draft())).toBe(false);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(readCommentDraft(localStorage, "s", "view:a", node)).toBeNull();
});

const composer = (props: { target?: string; anchor?: Anchor; save?: () => Promise<boolean>; key?: number } = {}) => (
  <Composer
    key={props.key}
    requestKey={1}
    anchor={props.anchor ?? node}
    choices={[]}
    anchorLabel="Customer"
    keep={{
      scope: "s",
      target: (props.target ?? "view:a") as `view:${string}`,
      baseRevision: "sha256:" + "b".repeat(64),
    }}
    onSave={props.save ?? (async () => true)}
    onCancel={() => {}}
  />
);

it("the composer keeps what is typed, gives it back after it is drawn anew (a reload), and says so", () => {
  const { unmount } = render(composer());
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Kept across a reload" } });
  expect(readCommentDraft(localStorage, "s", "view:a", node)).toMatchObject({
    body: "Kept across a reload",
    target: "view:a",
    baseRevision: "sha256:" + "b".repeat(64),
  });
  unmount();
  render(composer());
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Kept across a reload");
  expect(screen.getByText(/Restored your unsent comment/)).toBeInTheDocument();
});

it("a draft for view A never appears in a composer for view B", () => {
  const { unmount } = render(composer());
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "About view A" } });
  unmount();
  render(composer({ target: "view:b" }));
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("");
  expect(screen.queryByText(/Restored your unsent comment/)).toBeNull();
});

it("a comment added is forgotten; Discard forgets a restored one", async () => {
  const { unmount } = render(composer());
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "To send" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  });
  expect(readCommentDraft(localStorage, "s", "view:a", node)).toBeNull();
  unmount();
  keepCommentDraft(localStorage, draft({ scope: "s", body: "Restored then discarded" }));
  render(composer());
  fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("");
  expect(readCommentDraft(localStorage, "s", "view:a", node)).toBeNull();
});

it("a failed Add comment keeps the stored draft", async () => {
  render(composer({ save: async () => false }));
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Not added yet" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  });
  expect(readCommentDraft(localStorage, "s", "view:a", node)?.body).toBe("Not added yet");
});

it.each([
  ["full", "QuotaExceededError"],
  ["denied", "SecurityError"],
])("storage %s: the composer says the text is not kept if the page closes", (_, name) => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException(name, name);
  });
  render(composer());
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Cannot be kept" } });
  expect(screen.getByText(/cannot keep this comment if you reload or close/i)).toBeInTheDocument();
  expect(screen.queryByText(/Restored your unsent comment/)).toBeNull();
});

it("Escape in a composer with text closes it and keeps the draft; asking again on the same anchor gives it back (codex-01, G3)", () => {
  const cancel = vi.fn();
  const { unmount } = render(
    <Composer
      requestKey={1}
      anchor={node}
      choices={[]}
      anchorLabel="Customer"
      keep={{ scope: "s", target: "view:a", baseRevision: null }}
      onSave={async () => true}
      onCancel={cancel}
    />,
  );
  const box = screen.getByRole("textbox", { name: "Comment" });
  fireEvent.change(box, { target: { value: "Escaped, not lost" } });
  fireEvent.keyDown(box, { key: "Escape" });
  expect(cancel).toHaveBeenCalledTimes(1);
  unmount();
  expect(readCommentDraft(localStorage, "s", "view:a", node)?.body).toBe("Escaped, not lost");
  render(composer());
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Escaped, not lost");
});
