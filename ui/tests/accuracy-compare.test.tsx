// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RevisionCompare } from "../src/accuracy/RevisionCompare";
afterEach(cleanup);
const history = (commit: string) => ({
  status: "compiled",
  viewId: "shop",
  commit,
  path: ".archer/shop.mmd",
  sourceRevision: `sha256:${commit}`,
  source: { status: "text", text: "source" },
  result: { diagnostics: [], envelope: { model: { type: "c4-model" } } },
});
const comparison = (changes: unknown[] = []) => ({
  before: history("a".repeat(40)),
  after: history("b".repeat(40)),
  sourceChanged: true,
  semantic: { status: "compared", changes },
});
async function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
}
test("comparison controls dispatch exact view and refs and show full semantic attributes", async () => {
  const callOperation = vi.fn().mockResolvedValue(
    comparison([
      {
        key: "element:shop",
        status: "changed",
        before: { id: "shop", technology: "SQLite", shape: "database" },
        after: { id: "shop", technology: "PostgreSQL", shape: "database" },
      },
    ]),
  );
  render(<RevisionCompare viewId="shop" callOperation={callOperation} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText("From commit"), { target: { value: "v1" } });
  fireEvent.change(screen.getByLabelText("To commit"), { target: { value: "main" } });
  await submit();
  expect(callOperation).toHaveBeenCalledWith("compare_diagrams", { viewId: "shop", from: "v1", to: "main" });
  expect(await screen.findByText("1 semantic change")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Changed · element:shop"));
  expect(screen.getByText(/PostgreSQL/)).toBeInTheDocument();
  expect(screen.getByText(/SQLite/)).toBeInTheDocument();
  expect(screen.getByText("a".repeat(40))).toBeInTheDocument();
});
test.each(["node:a", "event:msg-1", "state:Idle", "entity:CUSTOMER", "element:shop", "service:api", "task:buy"])(
  "renders full semantics for %s without recomputing server comparison",
  async (key) => {
    const callOperation = vi.fn().mockResolvedValue(
      comparison([
        {
          key,
          status: "changed",
          before: {
            score: 3,
            attributes: [{ name: "id", type: "int" }],
            context: [{ kind: "alt", section: "approved" }],
          },
          after: {
            score: 5,
            attributes: [{ name: "id", type: "uuid" }],
            context: [{ kind: "alt", section: "delayed" }],
          },
          beforeIndex: 2,
          afterIndex: 3,
        },
      ]),
    );
    render(<RevisionCompare viewId="shop" callOperation={callOperation} onClose={() => {}} />);
    await submit();
    expect(await screen.findByText(`Changed · ${key}`)).toBeInTheDocument();
    fireEvent.click(screen.getByText(`Changed · ${key}`));
    expect(screen.getByText("Event order: position 3 to position 4")).toBeInTheDocument();
    expect(screen.getByText(/uuid/)).toBeInTheDocument();
    expect(screen.getByText(/approved/)).toBeInTheDocument();
  },
);
test("source-only change is distinguished from an unchanged diagram", async () => {
  const callOperation = vi.fn().mockResolvedValue(comparison());
  render(<RevisionCompare viewId="shop" callOperation={callOperation} onClose={() => {}} />);
  await submit();
  expect(await screen.findByText("Source changed; diagram semantics are unchanged.")).toBeInTheDocument();
  expect(screen.queryByText(/semantic changes$/)).not.toBeInTheDocument();
});
test.each([
  ["git_unavailable", "Git history is unavailable for this project."],
  ["historical_registry_missing", "This commit has no Archer registry."],
])("history failure %s stays explicit", async (reason, message) => {
  const callOperation = vi.fn().mockResolvedValue({
    before: { status: "unavailable", viewId: "shop", reason },
    after: history("b".repeat(40)),
    sourceChanged: null,
    semantic: null,
  });
  render(<RevisionCompare viewId="shop" callOperation={callOperation} onClose={() => {}} />);
  await submit();
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.getByText(/Semantic comparison unavailable/)).toBeInTheDocument();
  expect(screen.queryByText(/semantics are unchanged/)).not.toBeInTheDocument();
});
test("failed historical compilation displays its diagnostics and no comparison", async () => {
  const failed = {
    ...history("a".repeat(40)),
    status: "failed",
    result: { envelope: null, diagnostics: [{ severity: "error", message: "Unsupported historical arrow" }] },
  };
  const callOperation = vi
    .fn()
    .mockResolvedValue({ before: failed, after: history("b".repeat(40)), sourceChanged: true, semantic: null });
  render(<RevisionCompare viewId="shop" callOperation={callOperation} onClose={() => {}} />);
  await submit();
  expect(await screen.findByText("Unsupported historical arrow")).toBeInTheDocument();
  expect(screen.getByText(/Semantic comparison unavailable/)).toBeInTheDocument();
});
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test("a changed view ignores an older response and its previous results", async () => {
  const older = deferred(),
    latest = deferred();
  const callOperation = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
  const mounted = render(<RevisionCompare viewId="old" callOperation={callOperation} onClose={() => {}} />);
  await submit();
  mounted.rerender(<RevisionCompare viewId="new" callOperation={callOperation} onClose={() => {}} />);
  await submit();
  await act(async () => latest.resolve(comparison([{ key: "node:latest", status: "added", after: { id: "latest" } }])));
  expect(await screen.findByText("Added · node:latest")).toBeInTheDocument();
  await act(async () =>
    older.resolve(comparison([{ key: "node:obsolete", status: "added", after: { id: "obsolete" } }])),
  );
  expect(screen.queryByText("Added · node:obsolete")).not.toBeInTheDocument();
  expect(screen.getByText("Added · node:latest")).toBeInTheDocument();
});
test("ref edits invalidate pending requests; out-of-order completion preserves the latest submitted refs", async () => {
  const older = deferred(),
    latest = deferred();
  const callOperation = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
  render(<RevisionCompare viewId="shop" callOperation={callOperation} onClose={() => {}} />);
  await submit();
  fireEvent.change(screen.getByLabelText("From commit"), { target: { value: "release" } });
  await submit();
  await act(async () => latest.resolve(comparison([{ key: "node:latest", status: "added", after: { id: "latest" } }])));
  await act(async () => older.reject(new Error("Outdated failure")));
  expect(await screen.findByText("Added · node:latest")).toBeInTheDocument();
  expect(screen.queryByText("Outdated failure")).not.toBeInTheDocument();
  expect(screen.getByText("release")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("To commit"), { target: { value: "next" } });
  expect(screen.queryByText("Added · node:latest")).not.toBeInTheDocument();
});
test("focus enters the first input, Escape requests dismissal, and unmount returns focus", () => {
  const trigger = document.createElement("button");
  trigger.textContent = "History";
  document.body.append(trigger);
  trigger.focus();
  const onClose = vi.fn();
  const mounted = render(<RevisionCompare viewId="shop" callOperation={vi.fn()} onClose={onClose} />);
  expect(screen.getByLabelText("From commit")).toHaveFocus();
  fireEvent.keyDown(screen.getByLabelText("From commit"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  mounted.unmount();
  expect(trigger).toHaveFocus();
  trigger.remove();
});
test("operation errors and malformed results are actionable and cannot masquerade as unchanged", async () => {
  const callOperation = vi
    .fn()
    .mockRejectedValueOnce(new Error("Unknown commit; choose a valid Git ref."))
    .mockResolvedValueOnce({ semantic: { changes: [] } });
  render(<RevisionCompare viewId="shop" callOperation={callOperation} onClose={() => {}} />);
  await submit();
  expect(await screen.findByRole("alert")).toHaveTextContent("Unknown commit");
  await submit();
  expect(await screen.findByRole("alert")).toHaveTextContent("unreadable comparison");
  expect(screen.queryByText(/semantics are unchanged/)).not.toBeInTheDocument();
});
test("malformed diagnostic values are refused before they can become React children", async () => {
  const failed = {
    ...history("a".repeat(40)),
    status: "failed",
    result: { diagnostics: [{ severity: "error", message: { unexpected: "object" } }] },
  };
  const callOperation = vi
    .fn()
    .mockResolvedValue({ before: failed, after: history("b".repeat(40)), sourceChanged: true, semantic: null });
  render(<RevisionCompare viewId="shop" callOperation={callOperation} onClose={() => {}} />);
  await submit();
  expect(await screen.findByRole("alert")).toHaveTextContent("unreadable comparison");
});
test("optional historical metadata must remain textual even for unavailable results", async () => {
  const callOperation = vi.fn().mockResolvedValue({
    before: { status: "unavailable", reason: "git_unavailable", commit: { unexpected: "object" } },
    after: history("b".repeat(40)),
    sourceChanged: null,
    semantic: null,
  });
  render(<RevisionCompare viewId="shop" callOperation={callOperation} onClose={() => {}} />);
  await submit();
  expect(await screen.findByRole("alert")).toHaveTextContent("unreadable comparison");
});
