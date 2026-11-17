// @vitest-environment jsdom
// A restored draft whose last Send got no answer (claude-202, O102): the page kept the identity with it, so it is
// said to be possibly sent already, and sending it again repeats that identity, never a second copy.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Composer } from "../src/comments/Composer";
import { keepCommentDraft } from "../src/comments/comment-draft";
import { createKey, newOperation, operationHold } from "../src/comments/operations";
import type { Anchor } from "../src/comments/contract";

const node: Anchor = { kind: "node", id: "customer", label: "Customer" };
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

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

it("a restored comment with a kept identity says it may already have been sent", () => {
  keepCommentDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    anchor: node,
    body: "Lost answer",
    baseRevision: null,
    savedAt: 1,
  });
  operationHold(localStorage, "s").set(
    createKey("view:a", node, "Lost answer"),
    newOperation("comment.create", "view:a"),
  );
  render(composer());
  expect(screen.getByRole("status")).toHaveTextContent(/may already have been sent/);
  expect(screen.getByRole("status")).toHaveTextContent(/never a second copy/);
  expect(screen.queryByText(/Restored your unsent comment/)).toBeNull();
});

it("without one it is unsent, as before", () => {
  keepCommentDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    anchor: node,
    body: "Plain",
    baseRevision: null,
    savedAt: 1,
  });
  render(composer());
  expect(screen.getByRole("status")).toHaveTextContent(/Restored your unsent comment from earlier/);
});
