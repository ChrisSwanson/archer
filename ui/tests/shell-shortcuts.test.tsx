// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useShellHelp, useShellShortcuts } from "../src/app/shell-help";

function Harness({ search = () => {} }: { search?: () => void }) {
  const help = useShellHelp();
  useShellShortcuts(help, search);
  return (
    <>
      <output>{help.open ? "help open" : "help closed"}</output>
      <button type="button">Page control</button>
      <input aria-label="Editor" />
      <div role="dialog" aria-modal="true">
        <button type="button">Modal control</button>
      </div>
      <div data-archer-local-keys>
        <button type="button">Local control</button>
      </div>
    </>
  );
}
afterEach(cleanup);
it("consumes Help Escape before page selection handlers", () => {
  const pageHandler = vi.fn();
  render(<Harness />);
  window.addEventListener("keydown", pageHandler);
  try {
    fireEvent.keyDown(screen.getByText("Page control"), { key: "?" });
    expect(screen.getByText("help open")).toBeVisible();
    expect(pageHandler).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByText("Page control"), { key: "Escape" });
    expect(screen.getByText("help closed")).toBeVisible();
    expect(pageHandler).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByText("Page control"), { key: "Escape" });
    expect(pageHandler).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("keydown", pageHandler);
  }
});
it("leaves typing, other modals, local tools and modified/composing keys to their owners", () => {
  const search = vi.fn();
  render(<Harness search={search} />);
  for (const element of [
    screen.getByLabelText("Editor"),
    screen.getByText("Modal control"),
    screen.getByText("Local control"),
  ]) {
    fireEvent.keyDown(element, { key: "?" });
    fireEvent.keyDown(element, { key: "g" });
  }
  const page = screen.getByText("Page control");
  for (const modifier of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    fireEvent.keyDown(page, { key: "?", ...modifier });
    fireEvent.keyDown(page, { key: "/", ...modifier });
  }
  expect(screen.getByText("help closed")).toBeVisible();
  expect(search).not.toHaveBeenCalled();
  fireEvent.keyDown(page, { key: "/" });
  expect(search).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(page, { key: "?" });
  fireEvent.keyDown(page, { key: "g" });
  expect(search).toHaveBeenCalledTimes(1);
});
