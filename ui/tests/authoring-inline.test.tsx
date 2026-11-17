// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { InlineValue } from "../src/authoring/InlineValue";
test("pencil opens the same value inline, Enter commits and Escape cancels without per-field Save", () => {
  const commit = vi.fn();
  render(<InlineValue label="Web label" value="Web App" onCommit={commit} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Web label" }));
  const input = screen.getByRole("textbox", { name: "Web label" });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "Browser App" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(commit).toHaveBeenCalledWith("Browser App");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit Web label" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "cancel" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
});

test("a disabled transition cancels an inline edit without committing it", () => {
  const commit = vi.fn();
  const view = render(<InlineValue label="node label" value="Node" onCommit={commit} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit node label" }));
  expect(screen.getByRole("textbox", { name: "node label" })).toHaveFocus();
  fireEvent.change(screen.getByRole("textbox", { name: "node label" }), { target: { value: "Cancelled on phone" } });
  view.rerender(<InlineValue label="node label" value="Node" onCommit={commit} disabled />);
  expect(screen.queryByRole("textbox", { name: "node label" })).toBeNull();
  expect(commit).not.toHaveBeenCalled();
});
