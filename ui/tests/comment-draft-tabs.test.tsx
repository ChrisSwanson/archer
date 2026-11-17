// @vitest-environment jsdom
// Two tabs of one browser writing about the same thing (claude-201, O103): each tab's draft is its own. Another
// tab's draft is restored here only once that tab is closed; while it is open this tab says so and keeps its own
// text apart, so one tab's Send never erases the other's text and no text is offered for sending twice.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Composer } from "../src/comments/Composer";
import {
  claimDraft,
  commentDraftKey,
  forgetCommentDraft,
  keepCommentDraft,
  latestCommentDraft,
  readCommentDraft,
} from "../src/comments/comment-draft";
import { setTabIdForTests } from "../src/comments/draft-tabs";
import { holdTab } from "./support/fake-locks";
import type { Anchor } from "../src/comments/contract";

const node: Anchor = { kind: "node", id: "customer", label: "Customer" };
const A = "aaaaaaaaaaaaaaaa",
  B = "bbbbbbbbbbbbbbbb";
/** Tab A, open: it answers the tabs channel as A would. */
const openTab = holdTab;
const composer = () => (
  <Composer
    requestKey={1}
    anchor={node}
    choices={[]}
    anchorLabel="Customer"
    keep={{ scope: "s", target: "view:a", baseRevision: null }}
    onSave={async () => true}
    onCancel={() => {}}
  />
);
const box = () => screen.getByRole("textbox", { name: "Comment" });
const keepAs = (owner: string, body: string) => {
  setTabIdForTests(owner);
  keepCommentDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    anchor: node,
    body,
    baseRevision: null,
    savedAt: Date.now(),
  });
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
  setTabIdForTests(null);
});

it("tab A open: tab B is not given A's text, says it is being written in another tab, and keeps its own apart", async () => {
  keepAs(A, "tab A question");
  const closeA = openTab(A);
  setTabIdForTests(B);
  render(composer());
  await waitFor(() => expect(screen.getByText(/being written in another tab/)).toBeTruthy());
  expect(box()).toHaveValue("");
  fireEvent.change(box(), { target: { value: "tab B question" } });
  // A sends: only A's draft goes.
  setTabIdForTests(A);
  forgetCommentDraft(localStorage, "s", "view:a", node);
  setTabIdForTests(B);
  expect(readCommentDraft(localStorage, "s", "view:a", node)?.body).toBe("tab B question");
  closeA();
});

it("tab A closed: tab B is not given its draft by itself; it is offered, and Use it here takes it", async () => {
  keepAs(A, "abandoned in A");
  setTabIdForTests(B);
  render(composer());
  await waitFor(() => expect(screen.getByText(/An unsent comment from another tab, now closed/)).toBeTruthy());
  expect(box()).toHaveValue("");
  expect(readCommentDraft(localStorage, "s", "view:a", node)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Use it here" }));
  await waitFor(() => expect(box()).toHaveValue("abandoned in A"));
  expect(screen.getByText(/Restored your unsent comment/)).toBeTruthy();
  expect(readCommentDraft(localStorage, "s", "view:a", node)?.body).toBe("abandoned in A");
  setTabIdForTests(A);
  expect(readCommentDraft(localStorage, "s", "view:a", node)).toBeNull();
});

it("tab A closed: Discard on its offered draft removes it, and nothing is restored", async () => {
  keepAs(A, "abandoned in A");
  setTabIdForTests(B);
  render(composer());
  await waitFor(() => expect(screen.getByRole("button", { name: "Use it here" })).toBeTruthy());
  fireEvent.click(screen.getAllByRole("button", { name: "Discard it" })[0]!);
  expect(box()).toHaveValue("");
  expect(Object.keys(localStorage).filter((k) => k.startsWith("archer.comment-draft.v1:"))).toEqual([]);
});

it("a reload of one tab keeps its own draft, with no wait", () => {
  keepAs(B, "mine");
  render(composer());
  expect(box()).toHaveValue("mine");
});

it("text typed before Use it here is never replaced: the offer is withdrawn while there is text", async () => {
  keepAs(A, "abandoned in A");
  setTabIdForTests(B);
  render(composer());
  await waitFor(() => expect(screen.getByRole("button", { name: "Use it here" })).toBeTruthy());
  fireEvent.change(box(), { target: { value: "typing already" } });
  expect(screen.queryByRole("button", { name: "Use it here" })).toBeNull();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(box()).toHaveValue("typing already");
});

import { ChatBubble } from "../src/chat/ChatBubble";
import { keepChatDraft, keepReplyDraft, readChatDraft } from "../src/comments/comment-draft";
import type { CommentsTransport } from "../src/comments/transport";
import type { ReviewModel } from "../src/comments/useReview";
import { vi } from "vitest";

const chat = () => {
  const rm = {
    threads: new Map(),
    isUnread: () => false,
    actions: { markSeen: vi.fn(), ingest: vi.fn(), refresh: vi.fn(), load: vi.fn(), resolve: vi.fn() },
    capabilities: { comments: true, notes: false },
  } as unknown as ReviewModel;
  render(
    <ChatBubble
      review={rm}
      transport={{} as CommentsTransport}
      doc={{ viewId: "containers" }}
      title="Containers"
      sidebarHost={null}
      dockHost={null}
      openRequest={0}
      closeRequest={0}
      draftScope="s"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Chat with the agent about Containers/ }));
};
const message = () => screen.getByRole("textbox", { name: "Message to the agent" });
const chatAs = (owner: string, body: string) => {
  setTabIdForTests(owner);
  keepChatDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:containers",
    anchor: { kind: "view" },
    threadId: null,
    body,
    savedAt: Date.now(),
    sending: null,
  });
};

it("chat: another open tab's message stays there and is said to be; a closed tab's is offered, then taken", async () => {
  chatAs(A, "chat in A");
  const closeA = openTab(A);
  setTabIdForTests(B);
  chat();
  await waitFor(() => expect(screen.getByText(/being written in another tab/)).toBeTruthy());
  expect(message()).toHaveValue("");
  await closeA();
  cleanup();
  chat();
  await waitFor(() => expect(screen.getByRole("button", { name: "Use it here" })).toBeTruthy());
  expect(message()).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Use it here" }));
  await waitFor(() => expect(message()).toHaveValue("chat in A"));
  expect(readChatDraft(localStorage, "s", "view:containers", { kind: "view" })?.body).toBe("chat in A");
});

it("reply: a closed tab's reply is offered in the thread's reply box, and taken by Use it here", async () => {
  setTabIdForTests(A);
  keepReplyDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    threadId: "t1",
    body: "reply in A",
    savedAt: Date.now(),
  });
  setTabIdForTests(B);
  const { ThreadCard } = await import("../src/comments/ThreadCard");
  const thread = {
    id: "t1",
    target: "view:a" as const,
    anchor: node,
    status: "answered" as const,
    revision: 1,
    comments: [{ id: "c0", author: "person" as const, body: "Q", createdAt: "2026-11-02T10:00:00.000Z" }],
  };
  render(
    <ThreadCard
      thread={thread}
      scope="view"
      onReply={async () => true}
      onEdit={async () => true}
      onDelete={async () => true}
      onResolve={async () => true}
      onDismiss={async () => true}
      draftScope="s"
    />,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Use it here" })).toBeTruthy());
  expect(screen.getByRole("textbox", { name: "Your reply" })).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Use it here" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Your reply" })).toHaveValue("reply in A"));
});

// claude-408 (O134): "being written in another tab" goes when that tab closes (its tab lock is released), and the
// draft it left is then offered, without reopening the composer.
it("tab A closes while tab B shows it as being written there: B then offers A's draft instead", async () => {
  keepAs(A, "left behind in A");
  const closeA = openTab(A);
  setTabIdForTests(B);
  render(composer());
  await waitFor(() => expect(screen.getByText(/being written in another tab/)).toBeTruthy());
  await closeA();
  await waitFor(() => expect(screen.queryByText(/being written in another tab/)).toBeNull());
  expect(await screen.findByRole("button", { name: "Use it here" })).toBeTruthy();
  expect(box()).toHaveValue("");
});

it("O190: Use it here never copies a closed tab's draft over text this tab kept while it waited", async () => {
  const { takeDraft, claimDraft, commentDraftKey, chatDraftKey } = await import("../src/comments/comment-draft");
  // A comment draft and a chat message alike: an offer is made where this tab keeps nothing, so anything kept here
  // when the lock is granted was typed meanwhile, and is newer.
  keepAs(A, "older in A");
  chatAs(A, "older chat in A");
  setTabIdForTests(B);
  const key = commentDraftKey("s", "view:a", node),
    chatKey = chatDraftKey("s", "view:containers", { kind: "view" });
  const offer = (await claimDraft(localStorage, key)).offer!,
    chatOffer = (await claimDraft(localStorage, chatKey)).offer!;
  keepCommentDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    anchor: node,
    body: "typed in B meanwhile",
    baseRevision: null,
    savedAt: Date.now(),
  });
  keepChatDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:containers",
    anchor: { kind: "view" },
    threadId: null,
    body: "chat typed in B",
    savedAt: Date.now(),
    sending: null,
  });
  expect(await takeDraft(localStorage, key, offer)).toBe(false);
  expect(await takeDraft(localStorage, chatKey, chatOffer)).toBe(false);
  expect(readCommentDraft(localStorage, "s", "view:a", node)?.body).toBe("typed in B meanwhile");
  expect(readChatDraft(localStorage, "s", "view:containers", { kind: "view" })?.body).toBe("chat typed in B");
  // The closed tab's copies stay, still offered.
  setTabIdForTests(A);
  expect(readCommentDraft(localStorage, "s", "view:a", node)?.body).toBe("older in A");
  expect(readChatDraft(localStorage, "s", "view:containers", { kind: "view" })?.body).toBe("older chat in A");
});

it("a draft kept under no tab's name is nobody's: it is neither offered nor restored", async () => {
  keepAs(A, "a tab's question");
  // The same draft under its bare key, with no `~<owner>`, as no page of 0.15 writes it.
  const owned = Object.keys(localStorage).find((key) => key.endsWith(`~${A}`))!;
  const bare = owned.slice(0, owned.lastIndexOf("~"));
  localStorage.setItem(bare, localStorage.getItem(owned)!);
  localStorage.removeItem(owned);
  setTabIdForTests(B);
  expect(await claimDraft(localStorage, commentDraftKey("s", "view:a", node))).toEqual({
    elsewhere: false,
    offer: null,
    openOwners: [],
  });
  expect(latestCommentDraft(localStorage, "s", "view:a")).toBeNull();
});
