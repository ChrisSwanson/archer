// @vitest-environment jsdom
// The source editor in a page: controlled text, read-only mode, its accessible name, and the
// compiler's problems underlined on their line with the fix offered.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import { MermaidSourceEditor } from "../src/source-editor/MermaidSourceEditor";

afterEach(cleanup);

function mount(props: Partial<Parameters<typeof MermaidSourceEditor>[0]> = {}) {
  let view: EditorView | null = null;
  const result = render(
    <MermaidSourceEditor
      value={"flowchart LR\n  a --> b"}
      ariaLabel="Mermaid source"
      onView={(v) => {
        view = v;
      }}
      {...props}
    />,
  );
  return { ...result, view: () => view! };
}

const span = (line: number, column: number, endColumn: number) => ({
  start: { line, column },
  end: { line, column: endColumn },
});

it("is a text box named as asked, showing the value with line numbers", () => {
  const { container } = mount({ id: "authoring-source", ariaDescribedBy: "help" });
  const box = screen.getByRole("textbox", { name: "Mermaid source" });
  expect(box.id).toBe("authoring-source");
  expect(box.getAttribute("aria-describedby")).toBe("help");
  expect(box.textContent).toBe("flowchart LR  a --> b");
  expect([...container.querySelectorAll(".cm-lineNumbers .cm-gutterElement")].map((e) => e.textContent)).toContain("2");
  expect(container.querySelector(".cm-mmd-header")?.textContent).toBe("flowchart");
  expect(container.querySelector(".cm-mmd-arrow")?.textContent).toBe("-->");
});

it("reports typing through onChange, and takes a new value without echoing it back", () => {
  const onChange = vi.fn();
  const { view, rerender } = mount({ onChange });
  act(() => {
    view().dispatch({ changes: { from: view().state.doc.length, insert: "\n  b --> c" } });
  });
  expect(onChange).toHaveBeenLastCalledWith("flowchart LR\n  a --> b\n  b --> c");
  onChange.mockClear();
  rerender(
    <MermaidSourceEditor
      value={"flowchart TD\n  a --> b"}
      ariaLabel="Mermaid source"
      onChange={onChange}
      onView={() => {}}
    />,
  );
  expect(view().state.doc.toString()).toBe("flowchart TD\n  a --> b");
  expect(onChange).not.toHaveBeenCalled();
});

it("read-only shows the text but refuses typing", () => {
  const { view } = mount({ readOnly: true });
  expect(view().state.readOnly).toBe(true);
  expect(screen.getByRole("textbox", { name: "Mermaid source" }).getAttribute("aria-readonly")).toBe("true");
});

it("underlines an error and a warning on their own lines, styled apart, with a gutter mark", () => {
  const { container } = mount({
    value: "flowchart LR\n  a --> b\n  c --> d",
    diagnostics: [
      { code: "undeclared", severity: "error", message: "Unknown node", span: span(2, 3, 4) },
      { code: "dup", severity: "warning", message: "Duplicate", span: span(3, 3, 4) },
    ],
  });
  const lines = [...container.querySelectorAll(".cm-line")];
  expect(lines[1].querySelector(".cm-lintRange-error")?.textContent).toBe("a");
  expect(lines[2].querySelector(".cm-lintRange-warning")?.textContent).toBe("c");
  expect(container.querySelectorAll(".cm-lint-marker-error")).toHaveLength(1);
  expect(container.querySelectorAll(".cm-lint-marker-warning")).toHaveLength(1);
});

it("offers a diagnostic's machine fix as an action that calls onFix", () => {
  const onFix = vi.fn();
  const { view, rerender } = mount({
    value: "graph TD\nA-->B",
    diagnostics: [{ severity: "error", message: "needs ids", span: span(2, 2, 5), fix: { operation: "add-edge-ids" } }],
    onFix,
  });
  const found: { name: string; apply: () => void }[] = [];
  forEachDiagnostic(view().state, (d) => {
    for (const a of d.actions ?? []) found.push({ name: a.name, apply: () => a.apply(view(), d.from, d.to) });
  });
  expect(found.map((a) => a.name)).toEqual(["Add edge IDs"]);
  found[0].apply();
  expect(onFix).toHaveBeenCalledWith({ operation: "add-edge-ids" });
  // Fixed: the next preview has no problems, and the marks go.
  rerender(
    <MermaidSourceEditor
      value={"graph TD\nA A_B@-->B"}
      ariaLabel="Mermaid source"
      diagnostics={[]}
      onFix={onFix}
      onView={() => {}}
    />,
  );
  let left = 0;
  forEachDiagnostic(view().state, () => {
    left += 1;
  });
  expect(left).toBe(0);
});

it("without onFix, no fix is offered", () => {
  const { view } = mount({
    value: "graph TD\nA-->B",
    diagnostics: [{ severity: "error", message: "needs ids", span: span(2, 2, 5), fix: { operation: "add-edge-ids" } }],
  });
  let actions = 0;
  forEachDiagnostic(view().state, (d) => {
    actions += d.actions?.length ?? 0;
  });
  expect(actions).toBe(0);
});
