// @vitest-environment jsdom
// Source, in the canvas toolbar (decided 2026-10-25): the button the page offers through context, and the
// toolbar a page without a canvas gets so Source stays reachable.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceToolContext, SourceToolButton, SourceToolbar } from "../src/diagrams/SourceTool";

afterEach(cleanup);

describe("Source in the toolbar", () => {
  it("is absent where the page offers none (the editor, a note, the embedded view)", () => {
    render(
      <>
        <SourceToolButton />
        <SourceToolbar />
      </>,
    );
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Canvas controls" })).toBeNull();
  });

  it("is a toggle named Source that says whether the panel is open", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <SourceToolContext.Provider value={{ open: false, onToggle }}>
        <SourceToolButton />
      </SourceToolContext.Provider>,
    );
    const button = screen.getByRole("button", { name: "Source" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("title", "Show the Mermaid source");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      <SourceToolContext.Provider value={{ open: true, onToggle }}>
        <SourceToolButton />
      </SourceToolContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("title", "Hide the Mermaid source");
  });

  it("has a toolbar of its own for a page whose canvas draws none", () => {
    render(
      <SourceToolContext.Provider value={{ open: false, onToggle: () => {} }}>
        <SourceToolbar />
      </SourceToolContext.Provider>,
    );
    const bar = screen.getByRole("group", { name: "Canvas controls" });
    expect(bar).toHaveClass("archer-canvas-controls");
    expect(bar).toContainElement(screen.getByRole("button", { name: "Source" }));
  });

  // O186: while a diagram is drawn this toolbar stands in for the canvas' cluster, where the tools launcher sits under
  // Source. Without it here, the drawing's arrival moved Source up a slot and put the launcher where it had been, under
  // a pointer already on its way to Source.
  it("keeps the tools launcher under Source, where the canvas' cluster has it", () => {
    render(
      <SourceToolContext.Provider value={{ open: false, onToggle: () => {} }}>
        <SourceToolbar tools={<button type="button">Export</button>} />
      </SourceToolContext.Provider>,
    );
    const buttons = screen.getByRole("group", { name: "Canvas controls" }).querySelectorAll("button");
    expect([...buttons].map((b) => b.getAttribute("aria-label"))).toEqual(["Source", "Export, compare and more"]);
  });
});
