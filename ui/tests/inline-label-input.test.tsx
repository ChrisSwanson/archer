// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { InlineLabelInput } from "../src/diagrams/InlineLabelInput";
import { InlineValue } from "../src/authoring/InlineValue";
afterEach(cleanup);

test("a label with a line break opens with it; Shift+Enter keeps typing, Enter commits the text with its real \\n (MU)", () => {
  const commit = vi.fn(),
    close = vi.fn();
  render(<InlineLabelInput label="a label" value={"Order\nservice"} onCommit={commit} onClose={close} />);
  const field = screen.getByRole("textbox", { name: "a label" }) as HTMLTextAreaElement;
  expect(field.tagName).toBe("TEXTAREA");
  expect(field.value).toBe("Order\nservice");
  expect(field).toHaveFocus();
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  expect(commit).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  // A pasted Windows line break and a tab arrive as \n and a space: the only control character a label keeps is \n.
  fireEvent.change(field, { target: { value: "Order\r\nservice\tv2\nEU" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(commit).toHaveBeenCalledExactlyOnceWith("Order\nservice v2\nEU");
});

test("Escape keeps the old label; Enter while composing (an IME) does not commit (MU)", () => {
  const commit = vi.fn(),
    close = vi.fn();
  render(<InlineLabelInput label="a label" value="Before" onCommit={commit} onClose={close} />);
  const field = screen.getByRole("textbox", { name: "a label" });
  fireEvent.change(field, { target: { value: "Bef" } });
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(commit).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test("sent and waiting for the saved label, Escape still closes the field (A4)", () => {
  const commit = vi.fn(),
    close = vi.fn();
  render(<InlineLabelInput label="a label" value="Before" onCommit={commit} onClose={close} />);
  const field = screen.getByRole("textbox", { name: "a label" });
  fireEvent.change(field, { target: { value: "After" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(commit).toHaveBeenCalledExactlyOnceWith("After");
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(close).toHaveBeenCalledTimes(1);
});

test("the Structure panel’s label field keeps a line break too (MU)", () => {
  const commit = vi.fn();
  render(<InlineValue label="node label" value={"Two\nlines"} onCommit={commit} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit node label" }));
  const field = screen.getByRole("textbox", { name: "node label" }) as HTMLTextAreaElement;
  expect(field.value).toBe("Two\nlines");
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: "Two\nlines\nnow" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(commit).toHaveBeenCalledExactlyOnceWith("Two\nlines\nnow");
});
