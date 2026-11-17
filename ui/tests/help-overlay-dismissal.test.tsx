// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type JSX } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { HelpOverlay } from "../src/app/HelpOverlay";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("owns Escape dismissal without leaking it to the page and restores focus", () => {
  const onClose = vi.fn();
  const pageKeyDown = vi.fn();
  window.addEventListener("keydown", pageKeyDown);

  function Harness(): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Help
        </button>
        <HelpOverlay
          open={open}
          view="none"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      </>
    );
  }

  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Help" });
  opener.focus();
  fireEvent.click(opener);

  const close = screen.getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.keyDown(close, { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(pageKeyDown).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opener).toHaveFocus();

  window.removeEventListener("keydown", pageKeyDown);
});

it("lets the shell restore a visible control when the original opener is in a closed drawer", () => {
  const restore = vi.fn<(previous: HTMLElement | SVGElement | null) => void>();
  function Harness(): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Drawer Help
        </button>
        <button type="button">Visible Menu</button>
        <HelpOverlay open={open} view="none" onClose={() => setOpen(false)} onRestoreFocus={restore} />
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Drawer Help" });
  restore.mockImplementation(() => screen.getByRole("button", { name: "Visible Menu" }).focus());
  opener.focus();
  fireEvent.click(opener);
  fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
  expect(restore).toHaveBeenCalledWith(opener);
  expect(screen.getByRole("button", { name: "Visible Menu" })).toHaveFocus();
});
