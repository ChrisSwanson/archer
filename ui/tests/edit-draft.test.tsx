// @vitest-environment jsdom
// G1 for a change to an existing comment (user-flows rubric §3 G1; ruling 2026-11-02 "Comment drafts (G1)";
// the last gap after O93, O100): the Edit box keeps what is typed in this browser like a reply does (comment-draft.ts),
// keyed to the comment and owned by this tab; it is given back after a reload, a closed and reopened tab or Escape,
// said as restored, and removed only by saving it or an explicit Discard. When the comment changed meanwhile, the
// editor says so and keeps the person's text: Save never writes over the other change silently.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadCard } from "../src/comments/ThreadCard";
import {
  COMMENT_DRAFT_PREFIX,
  forgetEditDraft,
  keepEditDraft,
  latestCommentDraft,
  latestEditDraft,
  latestReplyDraft,
  readEditDraft,
  readReplyDraft,
  type EditDraft,
} from "../src/comments/comment-draft";
import { setTabIdForTests } from "../src/comments/draft-tabs";
import { holdTab } from "./support/fake-locks";
import type { Thread } from "../src/comments/contract";

const ORIGINAL = "Why two calls?";
const thread = (body = ORIGINAL, id = "t1"): Thread => ({
  id,
  target: "view:a",
  anchor: { kind: "node", id: "customer", label: "Customer" },
  status: "sent",
  revision: 1,
  comments: [{ id: "c1", author: "person", body, createdAt: "2026-11-02T00:00:00Z" }],
});
const edit = (over: Partial<EditDraft> = {}): EditDraft => ({
  version: 1,
  scope: "s",
  target: "view:a",
  threadId: "t1",
  commentId: "c1",
  body: "Why two calls to the bank?",
  base: ORIGINAL,
  savedAt: 1,
  ...over,
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  setTabIdForTests(null);
});

const card = (props: { t?: Thread; onEdit?: (body: string) => Promise<boolean>; scope?: string | null } = {}) => {
  const onEdit = props.onEdit ?? (async () => true);
  return (
    <ThreadCard
      thread={props.t ?? thread()}
      scope="view"
      {...(props.scope === null ? {} : { draftScope: props.scope ?? "s" })}
      onReply={async () => true}
      onEdit={(_id, body) => onEdit(body)}
      onDelete={async () => true}
      onResolve={async () => true}
      onDismiss={async () => true}
    />
  );
};
const editBox = () => screen.getByRole("textbox", { name: "Edit your comment" }) as HTMLTextAreaElement;

it("keeps an edit under the drafts' prefix, for its own comment only, never offered as a new comment or a reply", () => {
  expect(keepEditDraft(localStorage, edit())).toBe(true);
  expect(Object.keys(localStorage).every((k) => k.startsWith(COMMENT_DRAFT_PREFIX))).toBe(true);
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")?.body).toBe("Why two calls to the bank?");
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c2")).toBeNull();
  expect(readEditDraft(localStorage, "s", "view:a", "t2", "c1")).toBeNull();
  expect(readEditDraft(localStorage, "other", "view:a", "t1", "c1")).toBeNull();
  expect(latestCommentDraft(localStorage, "s", "view:a")).toBeNull();
  expect(readReplyDraft(localStorage, "s", "view:a", "t1")).toBeNull();
  expect(latestReplyDraft(localStorage, "s", "view:a", ["t1"])).toBeNull();
  expect(latestEditDraft(localStorage, "s", "view:a", [thread()])?.threadId).toBe("t1");
  expect(latestEditDraft(localStorage, "s", "view:a", [thread(ORIGINAL, "t2")])).toBeNull();
  expect(forgetEditDraft(localStorage, "s", "view:a", "t1", "c1")).toBe(true);
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")).toBeNull();
});

it("an edit is kept as typed and given back when the card is drawn anew (a reload), its editor open, said as restored", () => {
  const first = render(card());
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(editBox(), { target: { value: "Why two calls to the bank?" } });
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")).toMatchObject({
    body: "Why two calls to the bank?",
    base: ORIGINAL,
  });
  first.unmount();
  render(card());
  expect(editBox().value).toBe("Why two calls to the bank?");
  expect(screen.getByText(/Restored your unsaved edit from earlier/)).toBeTruthy();
  expect(screen.queryByText(/changed since you started/)).toBeNull();
});

it("text equal to the comment is nothing to keep", () => {
  render(card());
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(editBox(), { target: { value: "Why two calls?!" } });
  fireEvent.change(editBox(), { target: { value: ORIGINAL } });
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")).toBeNull();
});

it("Escape and Cancel close the editor and keep the text; Edit gives it back", () => {
  render(card());
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(editBox(), { target: { value: "Kept across Escape" } });
  fireEvent.keyDown(editBox(), { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Edit your comment" })).toBeNull();
  expect(screen.getByText(ORIGINAL)).toBeTruthy();
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")?.body).toBe("Kept across Escape");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(editBox().value).toBe("Kept across Escape");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")?.body).toBe("Kept across Escape");
});

it("a saved edit is forgotten; a refused one stays kept; Discard forgets it and the comment reads as it is", async () => {
  keepEditDraft(localStorage, edit({ body: "Will fail" }));
  const failing = render(card({ onEdit: async () => false }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  });
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")?.body).toBe("Will fail");
  failing.unmount();
  render(card());
  fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Edit your comment" })).toBeNull();
  expect(screen.getByText(ORIGINAL)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(editBox().value).toBe(ORIGINAL);
  fireEvent.change(editBox(), { target: { value: "Saved now" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  });
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")).toBeNull();
});

it("the comment changed meanwhile (restored): says so, shows what it reads now, keeps the person's text, and Save says it replaces it", async () => {
  keepEditDraft(localStorage, edit({ body: "My rewrite" }));
  const onEdit = vi.fn(async () => true);
  render(card({ t: thread("Changed in another tab"), onEdit }));
  expect(editBox().value).toBe("My rewrite");
  const note = screen.getByText(/This comment changed since you started editing it/);
  expect(note.textContent).toMatch(/Changed in another tab/);
  const save = screen.getByRole("button", { name: "Save over it" });
  await act(async () => {
    fireEvent.click(save);
  });
  expect(onEdit).toHaveBeenCalledWith("My rewrite");
});

it("the comment changes while it is being edited: the open editor says so and keeps the text", () => {
  const view = render(card());
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(editBox(), { target: { value: "Typing my change" } });
  view.rerender(card({ t: thread("Changed elsewhere") }));
  expect(editBox().value).toBe("Typing my change");
  expect(screen.getByText(/This comment changed since you started editing it/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save over it" })).toBeTruthy();
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")?.base).toBe(ORIGINAL);
});

it("the comment changed to the person's own text meanwhile: nothing to keep or warn about", () => {
  keepEditDraft(localStorage, edit({ body: "Same words" }));
  render(card({ t: thread("Same words") }));
  expect(screen.queryByText(/changed since you started/)).toBeNull();
});

it("storage refused: the editor says the edit is not kept if the page closes", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  render(card());
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(editBox(), { target: { value: "Unkept" } });
  expect(screen.getByRole("alert").textContent).toMatch(/cannot keep this edit/);
});

it("with no draft scope the editor works from memory, as before", () => {
  render(card({ scope: null }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(editBox(), { target: { value: "memory only" } });
  expect(Object.keys(localStorage)).toEqual([]);
});

const A = "aaaaaaaaaaaaaaaa",
  B = "bbbbbbbbbbbbbbbb";
const openTab = holdTab;

it("two tabs: another open tab's edit stays there and is said to be; a closed tab's is offered, and taken only by Use it here", async () => {
  setTabIdForTests(A);
  keepEditDraft(localStorage, edit({ body: "edit in A", savedAt: Date.now() }));
  const closeA = openTab(A);
  setTabIdForTests(B);
  render(card());
  await waitFor(() => expect(screen.getByText(/An edit on this is being written in another tab/)).toBeTruthy());
  expect(editBox().value).toBe(ORIGINAL);
  await closeA();
  cleanup();
  render(card());
  await waitFor(() => expect(screen.getByText(/An unsaved edit from another tab, now closed/)).toBeTruthy());
  expect(editBox().value).toBe(ORIGINAL);
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Use it here" }));
  await waitFor(() => expect(editBox().value).toBe("edit in A"));
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")?.body).toBe("edit in A");
});

// claude-309: Escape and Cancel kept the text and said nothing, so the person could not tell it was kept.
it("Escape or Cancel with text kept says so under the comment, with Discard; closing with nothing changed says nothing", () => {
  render(card());
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.keyDown(editBox(), { key: "Escape" });
  expect(screen.queryByText(/unsaved edit .*kept/i)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(editBox(), { target: { value: "Kept across Escape" } });
  fireEvent.keyDown(editBox(), { key: "Escape" });
  const said = screen.getByRole("status");
  expect(said.textContent).toMatch(/Your unsaved edit of this comment is kept in this browser/);
  expect(said.textContent).toMatch(/Edit/);

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText(/Your unsaved edit of this comment is kept in this browser/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
  expect(readEditDraft(localStorage, "s", "view:a", "t1", "c1")).toBeNull();
  expect(screen.queryByText(/unsaved edit .*kept/i)).toBeNull();
  expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
});
