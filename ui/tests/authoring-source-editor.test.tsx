// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { AuthoringWorkspace } from "../src/authoring/AuthoringWorkspace";
import type { AuthoringClient } from "../src/authoring/client";
import { loadModelEnvelope } from "./fixtures";
// jsdom has no layout: CodeMirror measures text ranges.
if (!Range.prototype.getClientRects)
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
const status = {
  authorized: true as const,
  edit: { enabled: true },
  storeId: "store_" + "a".repeat(32),
  generation: "gen_" + "b".repeat(32),
  drafts: [],
  operations: [],
  nextOffset: null,
};
const FLOW = loadModelEnvelope("flowchart", "minimal");

test("the source drawer mounts the CodeMirror editor: pasted Mermaid without edge ids gets Add IDs, and the editor shows the fixed text (MU+CM)", async () => {
  const pasted = "flowchart LR\n a[One] --> b[Two]\n",
    fixed = "flowchart LR\n a[One] a_b@--> b[Two]\n";
  const missing = {
    code: "unsupported_construct",
    severity: "error",
    message: "every edge needs a stable ID",
    span: { start: { line: 2, column: 9 }, end: { line: 2, column: 12 } },
    fix: { operation: "add-edge-ids" },
  };
  const api: AuthoringClient = {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    open: vi.fn(),
    snapshot: vi.fn(),
    mutate: vi.fn(),
    operation: vi.fn(),
    preview: vi.fn(async (source: string) =>
      source === fixed || !source.includes("-->")
        ? { envelope: FLOW, diagnostics: [] }
        : { envelope: null, diagnostics: [missing] },
    ),
    edit: vi.fn(async (source: string, change: { kind: string }) =>
      change.kind === "add-edge-ids"
        ? { ok: true as const, source: fixed, envelope: FLOW, diagnostics: [] }
        : { ok: false as const, source, code: "edit_target_missing" },
    ),
  };
  window.history.replaceState(null, "", "/p/example/edit/?source");
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  const content = await waitFor(
    () => {
      const el = document.querySelector(".authoring-source-editor .cm-content");
      if (!el) throw new Error("no editor yet");
      return el as HTMLElement;
    },
    { timeout: 10000 },
  );
  expect(content).toHaveAccessibleName("Mermaid source");
  expect(document.querySelector("textarea#authoring-source")).toBeNull();
  // Paste through the editor's own view, as typing would.
  const view = EditorView.findFromDOM(content);
  expect(view).not.toBeNull();
  act(() => {
    view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: pasted } });
  });
  const add = await screen.findByRole("button", { name: "Add IDs" }, { timeout: 5000 });
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  await waitFor(() => expect(api.edit).toHaveBeenCalledWith(pasted, { kind: "add-edge-ids" }));
  await waitFor(() => expect(view!.state.doc.toString()).toBe(fixed));
  expect(
    within(document.querySelector(".authoring-statusline") as HTMLElement).getByText("Added IDs to 1 connection"),
  ).toBeVisible();
});
