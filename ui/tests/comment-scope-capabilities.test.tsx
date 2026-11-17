// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Composer } from "../src/comments/Composer";
import type { Anchor } from "../src/comments/contract";

const revision = `sha256:${"a".repeat(64)}`;
afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("a host-provided scope guard preserves the opening revision and scope after the model changes", async () => {
  const anchor = { kind: "group" as const, id: "frag-0", label: "Ready" };
  const onSave = vi.fn(async () => true);
  const props = {
    requestKey: 1,
    anchor,
    anchorLabel: "Ready",
    choices: [],
    scopeGuard: (about: Anchor) => (about.kind === "group" ? ("block" as const) : undefined),
    onSave,
    onCancel: vi.fn(),
    keep: { scope: "scope-capability", target: "view:sequence" as const, baseRevision: revision },
  };
  const { rerender } = render(<Composer {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Review ready" } });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(anchor, "Review ready", expect.any(Function), revision));
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "More about ready" } });
  rerender(
    <Composer
      {...props}
      scopeGuard={() => undefined}
      keep={{ ...props.keep, baseRevision: `sha256:${"b".repeat(64)}` }}
    />,
  );
  expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("More about ready");
  expect(screen.getByText(/The diagram changed/)).toHaveTextContent("intended block");
});
