// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { keepCommentDraft } from "../src/comments/comment-draft";
import { Composer } from "../src/comments/Composer";

const first = `sha256:${"a".repeat(64)}`;
const next = `sha256:${"b".repeat(64)}`;
const anchor = { kind: "group" as const, id: "frag-0", label: "ready" };
afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("a block composer refuses a changed diagram while keeping its words", () => {
  const onSave = vi.fn(async () => true);
  const props = {
    requestKey: 1,
    anchor,
    anchorLabel: "Group: ready",
    choices: [],
    onSave,
    onCancel: vi.fn(),
    scopeGuard: (anchor: import("../src/comments/contract").Anchor) =>
      anchor.kind === "group" ? ("block" as const) : undefined,
    keep: { scope: "block-stale-test", target: "view:sequence" as const, baseRevision: first },
  };
  const { rerender } = render(<Composer {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), {
    target: { value: "Review this original block" },
  });
  rerender(<Composer {...props} keep={{ ...props.keep, baseRevision: next }} />);
  expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Review this original block");
  expect(screen.getByText(/The diagram changed/)).toHaveTextContent("Reopen a comment on the intended block");
  expect(onSave).not.toHaveBeenCalled();
});

test("a block save carries the exact revision captured when the composer opened", async () => {
  const onSave = vi.fn(async () => true);
  render(
    <Composer
      requestKey={1}
      anchor={anchor}
      anchorLabel="Group: ready"
      choices={[]}
      onSave={onSave}
      onCancel={() => {}}
      {...{
        scopeGuard: (anchor: import("../src/comments/contract").Anchor) =>
          anchor.kind === "group" ? ("block" as const) : undefined,
      }}
      keep={{ scope: "block-save-test", target: "view:sequence", baseRevision: first }}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Review this block" } });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(anchor, "Review this block", expect.any(Function), first));
});

test("an old restored block draft without a revision cannot gain identity merely by typing", () => {
  const scope = "legacy-block-draft";
  keepCommentDraft(localStorage, {
    version: 1,
    scope,
    target: "view:sequence",
    anchor,
    body: "Old scope",
    baseRevision: null,
    savedAt: Date.now(),
  });
  render(
    <Composer
      requestKey={1}
      anchor={anchor}
      anchorLabel="Group: ready"
      choices={[]}
      onSave={async () => true}
      onCancel={() => {}}
      scopeGuard={(anchor) => (anchor.kind === "group" ? "block" : undefined)}
      keep={{ scope, target: "view:sequence", baseRevision: first }}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Old scope");
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Old scope, more words" } });
  expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
});
