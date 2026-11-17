// @vitest-environment jsdom
// claude-404 (O136): on return to a document, this tab's own kept draft opens first. A closed tab's comment draft on
// the same document no longer takes the place of this tab's own reply (or edit): the reply's thread opens, and the
// other tab's comment stays offered for when the person opens that composer.
import { afterEach, expect, it } from "vitest";
import { draftToOpen, keepCommentDraft, keepReplyDraft } from "../src/comments/comment-draft";
import { setTabIdForTests } from "../src/comments/draft-tabs";

const A = "aaaaaaaaaaaaaaaa",
  B = "bbbbbbbbbbbbbbbb";
const node = { kind: "node", id: "customer", label: "Customer" } as const;
const threads = [{ id: "t-1", comments: [{ id: "c-1" }] }];
afterEach(() => {
  localStorage.clear();
  setTabIdForTests(null);
});

it("this tab's own reply wins over a closed tab's comment draft", () => {
  setTabIdForTests(A);
  keepCommentDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    anchor: node,
    body: "A's comment",
    baseRevision: null,
    savedAt: 5,
  });
  setTabIdForTests(B);
  keepReplyDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    threadId: "t-1",
    body: "B's reply",
    savedAt: 1,
  });
  expect(draftToOpen(localStorage, "s", "view:a", threads)).toEqual({ kind: "thread", threadId: "t-1" });
  // Threads not read yet: wait rather than open the other tab's comment.
  expect(draftToOpen(localStorage, "s", "view:a", undefined)).toBe("wait");
});

it("this tab's own comment draft opens first; with nothing of this tab's, another tab's comment is offered", () => {
  setTabIdForTests(A);
  keepCommentDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    anchor: node,
    body: "A's comment",
    baseRevision: null,
    savedAt: 5,
  });
  setTabIdForTests(B);
  expect(draftToOpen(localStorage, "s", "view:a", [])).toEqual({ kind: "comment", anchor: node });
  keepCommentDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    anchor: node,
    body: "B's own",
    baseRevision: null,
    savedAt: 1,
  });
  keepReplyDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    threadId: "t-1",
    body: "B's reply",
    savedAt: 9,
  });
  expect(draftToOpen(localStorage, "s", "view:a", threads)).toEqual({ kind: "comment", anchor: node });
});
