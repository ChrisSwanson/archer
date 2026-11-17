// @vitest-environment jsdom
//
// Round 1 (UI/UX) fixes, pass 7, batch F27. V7-1/2: a Fit (`1`) pressed while a drawing is opening, or while Edit
// hands over to the editor's drawing, is kept and applied once, by the drawing that is ready. V3: the glyphs the
// census found hand-sized take the icon scale from styles.css, not numbers of their own (the browser measurements
// are round1-f27-icons.e2e.ts).
import { act, cleanup, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { holdFit, resetFitQueue, useCanvasShortcuts, useFitQueue } from "../src/diagrams/canvas-shortcuts";

const press = (key = "1"): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};
const canvas = (fit: () => void, ready: boolean) =>
  renderHook(({ ready }) => useCanvasShortcuts({ onFitView: fit, enabled: true, ready }), { initialProps: { ready } });

afterEach(() => {
  cleanup();
  resetFitQueue();
  vi.useRealTimers();
});

describe("V7: a Fit pressed during a transition", () => {
  it("V7-1: pressed before any drawing is there, it fits the drawing once it is framed", () => {
    renderHook(() => useFitQueue(true));
    press();
    const fit = vi.fn();
    const drawing = canvas(fit, false);
    expect(fit).not.toHaveBeenCalled();
    drawing.rerender({ ready: true });
    expect(fit).toHaveBeenCalledTimes(1);
    // Once: a later drawing does not fit again.
    const later = vi.fn();
    canvas(later, true);
    expect(later).not.toHaveBeenCalled();
  });

  it("V7-1: pressed on a drawing still opening, it waits for that drawing's framing", () => {
    const fit = vi.fn();
    const drawing = canvas(fit, false);
    press();
    expect(fit).not.toHaveBeenCalled();
    drawing.rerender({ ready: true });
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("V7-2: while Edit hands over, the reading drawing does not take it; the editor's does when it takes the stage", () => {
    const reader = vi.fn();
    const editor = vi.fn();
    const reading = canvas(reader, true);
    act(() => holdFit(true));
    press();
    const editing = canvas(editor, true);
    expect(reader).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
    reading.unmount();
    act(() => holdFit(false));
    expect(editor).toHaveBeenCalledTimes(1);
    expect(reader).not.toHaveBeenCalled();
    editing.unmount();
  });

  it("a ready drawing fits at once, and leaves nothing queued", () => {
    renderHook(() => useFitQueue(true));
    const fit = vi.fn();
    canvas(fit, true);
    press();
    expect(fit).toHaveBeenCalledTimes(1);
    const next = vi.fn();
    canvas(next, false).rerender({ ready: true });
    expect(next).not.toHaveBeenCalled();
  });

  it("a slow open keeps the press: the drawing framed long after still fits, once", () => {
    vi.useFakeTimers();
    renderHook(() => useFitQueue(true));
    press();
    vi.advanceTimersByTime(30_000);
    const fit = vi.fn();
    canvas(fit, true);
    expect(fit).toHaveBeenCalledTimes(1);
    const later = vi.fn();
    canvas(later, true);
    expect(later).not.toHaveBeenCalled();
  });

  it("a modified 1, or one typed into a field, is not a Fit", () => {
    renderHook(() => useFitQueue(true));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }));
    });
    const input = document.body.appendChild(document.createElement("input"));
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    input.remove();
    const fit = vi.fn();
    canvas(fit, true);
    expect(fit).not.toHaveBeenCalled();
  });
});

describe("V3: hand-sized glyphs take the icon scale", () => {
  const sheet = (path: string): string =>
    readFileSync(resolve(process.cwd(), "src", path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** The declarations of every rule whose selector list includes `selector`. */
  const bodyOf = (css: string, selector: string): string =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) =>
        m[1]!
          .split(",")
          .map((s) => s.trim())
          .includes(selector),
      )
      .map((m) => m[2])
      .join(";");
  it.each([
    ["walkthroughs/walkthroughs.css", ".archer-walk-pick svg"],
    ["walkthroughs/walkthroughs.css", ".archer-walk-icon svg"],
    ["walkthroughs/walkthroughs.css", ".archer-walk-close svg"],
    ["app/ProjectSettings.css", ".archer-project-settings-close svg"],
    ["chat/chat.css", ".archer-chat-acts svg"],
    ["chat/chat.css", ".archer-chat-send svg"],
    ["chat/chat.css", ".archer-chat-grip svg"],
    ["chat/chat.css", ".archer-chat-to-pick svg"],
    ["styles.css", ".archer-emph-swatch-check"],
    ["styles.css", ".archer-emph-swatch-check path"],
    ["nesting/nesting.css", ".archer-nest-toggle-mark"],
    ["nesting/nesting.css", ".archer-nest-toggle-mark path"],
  ])("%s %s has no size or stroke of its own", (path, selector) => {
    const body = bodyOf(sheet(path), selector);
    expect(body).not.toMatch(/(?:^|;)\s*(?:width|height)\s*:\s*\d/);
    expect(body).not.toMatch(/stroke-width\s*:\s*\d/);
  });
  it.each([
    ["comments/primary-comments.css", ".primary-inbox-chevron"],
    ["authoring/authoring.css", ".authoring-pencil svg"],
    ["app/FolderTree.css", ".archer-folder-tree-file .archer-files-glyph"],
  ])("%s %s is sized by --icon-indicator, in the scale's stroke", (path, selector) => {
    const body = bodyOf(sheet(path), selector);
    expect(body).toMatch(/width\s*:\s*var\(--icon-indicator\)/);
    expect(body).not.toMatch(/stroke-width\s*:\s*\d/);
  });
  it("a file pictogram keeps its inline size, in the scale's stroke", () => {
    expect(bodyOf(sheet("app/ProjectPages.css"), ".archer-files-glyph")).not.toMatch(/stroke-width\s*:\s*\d/);
  });
  it("Clear folder filter draws the shared close glyph, not a typed ×", () => {
    const page = readFileSync(resolve(process.cwd(), "src/app/SearchPage.tsx"), "utf8");
    expect(page).not.toMatch(/ ×<\/span>/);
    expect(page.match(/<CloseGlyph \/>/g)?.length).toBe(2);
  });
});
