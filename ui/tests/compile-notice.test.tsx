// @vitest-environment jsdom
//
// The notice drawn over the last valid drawing when its file no longer
// compiles. jsdom can say what it contains and how it behaves; whether it
// covers the canvas controls or scrolls is the browser suite's to say
// (`tests/browser/compile-notice.e2e.ts` (in the Rust implementation, not in this tree)).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CompileNotice } from "../src/app/CompileNotice";
import type { CompileFailure, CompileProblem } from "../src/app/compile-status";

const REVISION_A = `sha256:${"a".repeat(64)}`;
const REVISION_B = `sha256:${"b".repeat(64)}`;

function failure(problems: readonly CompileProblem[]): CompileFailure {
  return { viewId: "graph", sourceRevision: REVISION_B, lastValidRevision: REVISION_A, problems };
}

const TWO: readonly CompileProblem[] = [
  { code: "unsupported_construct", message: "An edge needs an explicit stable ID.", line: 2, column: 3 },
  { code: "expected_label", message: "expected a label inside delimiters", line: 3, column: 9 },
];

afterEach(cleanup);

describe("CompileNotice", () => {
  it("says the file no longer compiles and that the drawing is the last version that did", () => {
    render(<CompileNotice failure={failure(TWO)} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/no longer compiles/i);
    expect(alert).toHaveTextContent(/last version that did/i);
  });

  it("lists every problem with its line, its column and its message", () => {
    render(<CompileNotice failure={failure(TWO)} />);

    const items = within(screen.getByRole("list", { name: "Problems" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Line 2, column 3");
    expect(items[0]).toHaveTextContent("An edge needs an explicit stable ID.");
    expect(items[0]).toHaveTextContent("unsupported_construct");
    expect(items[1]).toHaveTextContent("Line 3, column 9");
    expect(items[1]).toHaveTextContent("expected a label inside delimiters");
  });

  it("keeps the problems out of the live region, so only the sentence is announced", () => {
    // A live region re-announces when its content changes. The sentence does
    // not change while the failure stands; the list changes on every save.
    render(<CompileNotice failure={failure(TWO)} />);

    expect(screen.getByRole("alert")).not.toHaveTextContent("expected a label");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/problem/i);
  });

  it("shows a message as text, never as markup", () => {
    const hostile = '<img src=x onerror="window.pwned = true"> and `a[<b>bold</b>]`';
    const { container } = render(
      <CompileNotice failure={failure([{ code: "c", message: hostile, line: 1, column: 1 }])} />,
    );

    expect(screen.getByRole("listitem")).toHaveTextContent(hostile);
    expect(container.querySelector("img, b")).toBeNull();
  });

  it("lists a problem that has no position without inventing one", () => {
    render(<CompileNotice failure={failure([{ code: "kind_mismatch", message: "wrong kind of diagram" }])} />);

    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("wrong kind of diagram");
    expect(item).not.toHaveTextContent(/line/i);
  });

  it("collapses to its sentence and opens again, without ever being dismissed", () => {
    render(<CompileNotice failure={failure(TWO)} />);
    const alert = screen.getByRole("alert");
    const toggle = screen.getByRole("button", { name: "Hide problems" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);

    expect(screen.queryByRole("list")).toBeNull();
    const collapsed = screen.getByRole("button", { name: "Show 2 problems" });
    expect(collapsed).toHaveAttribute("aria-expanded", "false");
    // The same node, not a new one: a remounted alert is announced again.
    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert).toHaveTextContent(/no longer compiles/i);

    fireEvent.click(collapsed);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("alert")).toBe(alert);

    // There is exactly one control, and it does not make the notice go away.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("points its toggle at the list it controls", () => {
    render(<CompileNotice failure={failure(TWO)} />);

    const controlled = screen.getByRole("button").getAttribute("aria-controls");
    expect(controlled).toBeTruthy();
    expect(screen.getByRole("list", { name: "Problems" })).toHaveAttribute("id", controlled);
  });

  it("stays collapsed when the next save fails differently", () => {
    const { rerender } = render(<CompileNotice failure={failure(TWO)} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide problems" }));

    rerender(<CompileNotice failure={failure(TWO.slice(0, 1))} />);

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("button", { name: "Show 1 problem" })).toBeInTheDocument();
  });

  it("lists twenty problems in a region a keyboard can scroll", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      code: "undeclared_node",
      message: `node n${index} is not declared`,
      line: index + 2,
      column: 3,
    }));
    render(<CompileNotice failure={failure(many)} />);

    const list = screen.getByRole("list", { name: "Problems" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    // A scroll container nothing can focus cannot be scrolled without a mouse.
    expect(list).toHaveAttribute("tabindex", "0");
  });

  it("is a named region, so it can be found and skipped", () => {
    render(<CompileNotice failure={failure(TWO)} />);

    expect(screen.getByRole("region", { name: "Compile problems" })).toContainElement(screen.getByRole("alert"));
  });

  it("does not call a drawing the last valid version when there has never been one", () => {
    render(<CompileNotice failure={{ ...failure(TWO), lastValidRevision: null }} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/does not compile/i);
    expect(alert).toHaveTextContent(/no earlier version to show/i);
    expect(alert).not.toHaveTextContent(/drawing shown/i);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("says the file is no longer at this address, without claiming it was deleted", () => {
    render(
      <CompileNotice
        failure={failure([{ code: "source_missing", message: "diagram source was removed: /w/graph.mmd" }])}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/no longer at this address/i);
    expect(alert).not.toHaveTextContent(/deleted/i);
    expect(alert).toHaveTextContent(/last version that compiled/i);
    expect(alert).not.toHaveTextContent(/no longer compiles/i);
    // What is still possible (claude-204): it can be read; editing needs the file back.
    expect(alert).toHaveTextContent(/restore the file or ask the agent to write it again/i);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says where the file moved and links its new place, when that is known (flows-r1 S4)", () => {
    render(
      <CompileNotice
        failure={failure([{ code: "source_missing", message: "gone" }])}
        moved={{ sourcePath: "diagrams/graph-v2.mmd", href: "/projects/demo/diagrams/graph-v2.mmd" }}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/moved to diagrams\/graph-v2\.mmd/i);
    expect(alert).not.toHaveTextContent(/deleted/i);
    expect(alert).not.toHaveTextContent(/restore the file/i);
    expect(screen.getByRole("link", { name: /open it there/i })).toHaveAttribute(
      "href",
      "/projects/demo/diagrams/graph-v2.mmd",
    );
  });

  it("ignores a moved place for a file that is there but does not compile", () => {
    render(<CompileNotice failure={failure(TWO)} moved={{ sourcePath: "x.mmd", href: "/x" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer compiles/i);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
