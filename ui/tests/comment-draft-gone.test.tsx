// @vitest-environment jsdom
// A restored comment whose element is no longer in the diagram (claude-205, O104): said before Add comment, and it
// can be moved to the whole diagram with its text kept.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "../src/comments/Composer";
import { keepCommentDraft, readCommentDraft } from "../src/comments/comment-draft";
import type { Anchor } from "../src/comments/contract";

const node: Anchor = { kind: "node", id: "customer", label: "Customer" };
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("says the element is gone, offers the whole diagram, and Add comment then goes there with the text", async () => {
  keepCommentDraft(localStorage, {
    version: 1,
    scope: "s",
    target: "view:a",
    anchor: node,
    body: "About the customer",
    baseRevision: null,
    savedAt: 1,
  });
  const save = vi.fn(async () => true);
  render(
    <Composer
      requestKey={1}
      anchor={node}
      choices={[]}
      anchorLabel="Customer"
      keep={{ scope: "s", target: "view:a", baseRevision: null }}
      anchorGone={(a) => a.kind === "node" && a.id === "customer"}
      onSave={save}
      onCancel={() => {}}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(/no longer in the diagram/);
  expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Comment on the whole diagram instead" }));
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("About the customer");
  expect(readCommentDraft(localStorage, "s", "view:a", { kind: "view" })?.body).toBe("About the customer");
  expect(readCommentDraft(localStorage, "s", "view:a", node)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  expect(save).toHaveBeenCalledWith({ kind: "view" }, "About the customer", expect.any(Function));
});
