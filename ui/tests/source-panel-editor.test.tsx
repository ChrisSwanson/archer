// @vitest-environment jsdom
// The reading page's source panel once the source editor has loaded: the same text, read-only,
// with the problems the read carried (a note's diagram brings its diagnostics; no extra request).
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
const fetched: string[] = [];
const bodies = new Map<string, unknown>();
vi.mock("../src/app/browser-resource", () => ({
  browserFetch: async (url: string) => {
    fetched.push(url);
    return { ok: true, json: async () => bodies.get(url) };
  },
}));
import { SourcePanel } from "../src/app/SourcePanel";
import { preloadSourceEditor } from "../src/source-editor/lazy";
// jsdom has no Range.getClientRects; CodeMirror measures text with it after a frame.
if (!Range.prototype.getClientRects)
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;

beforeAll(async () => {
  await preloadSourceEditor();
});
afterEach(() => {
  cleanup();
  fetched.length = 0;
});

const address = "notes/a.md#checkout";
const url = `api/notes/diagram?address=${encodeURIComponent(address)}`;

test("shows the source in the read-only editor, its problems marked and counted, from one read", async () => {
  bodies.set(url, {
    notePath: "notes/a.md",
    source: "flowchart LR\n  a --> b\n  a --> c",
    diagnostics: [
      {
        code: "missing_edge_id",
        severity: "error",
        message: "Edges need IDs",
        span: { start: { line: 2, column: 5 }, end: { line: 2, column: 8 } },
        fix: { operation: "add-edge-ids" },
      },
      {
        code: "dup",
        severity: "warning",
        message: "Duplicate",
        span: { start: { line: 3, column: 3 }, end: { line: 3, column: 4 } },
      },
    ],
  });
  const { container } = render(
    <SourcePanel target={{ kind: "embedded", address }} version={1} onEditSource={() => {}} onClose={() => {}} />,
  );
  await act(async () => {});
  const box = screen.getByRole("textbox", { name: "Mermaid source text" });
  expect(box.getAttribute("aria-readonly")).toBe("true");
  expect(box.textContent).toContain("a --> c");
  expect(container.querySelector(".cm-line:nth-child(2) .cm-lintRange-error")?.textContent).toBe("-->");
  expect(container.querySelector(".cm-lintRange-warning")?.textContent).toBe("a");
  expect(screen.getByText("1 error, 1 warning")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "Edit source" })).toBeTruthy();
  expect(fetched).toEqual([url]);
});

test("Escape in the editor's text closes the panel; Escape in its search field does not", async () => {
  bodies.set("api/diagram-source/v", { path: "v.mmd", source: "graph TD\nA-->B" });
  const onClose = vi.fn();
  const { container } = render(<SourcePanel target={{ kind: "view", viewId: "v" }} version={1} onClose={onClose} />);
  await act(async () => {});
  const box = screen.getByRole("textbox", { name: "Mermaid source text" });
  expect(container.querySelector(".archer-source-panel-problems")).toBeNull();
  act(() => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
  });
  const field = container.querySelector<HTMLInputElement>(".cm-search input[name=search]");
  expect(field).not.toBeNull();
  act(() => {
    field!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onClose).not.toHaveBeenCalled();
  act(() => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onClose).toHaveBeenCalled();
});
