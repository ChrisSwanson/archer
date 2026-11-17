// @vitest-environment jsdom
//
// `1` refits the diagram. The binding lives apart from the App-level ones
// because fitting needs React Flow's imperative handle, which only exists
// inside the provider -- so the key handling is a hook the canvas mounts, and
// this is where its guards are pinned.
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCanvasShortcuts } from "../src/diagrams/canvas-shortcuts";

afterEach(() => {
  document.body.innerHTML = "";
});

function press(init: KeyboardEventInit, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

describe("the canvas fit binding", () => {
  it("refits on 1", () => {
    const onFitView = vi.fn();
    renderHook(() => useCanvasShortcuts({ onFitView, enabled: true }));

    press({ key: "1" });

    expect(onFitView).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while the help overlay is up", () => {
    // Fitting the diagram BEHIND a cheat sheet is a change the user cannot see
    // happening, and they get the result without having watched it.
    const onFitView = vi.fn();
    renderHook(() => useCanvasShortcuts({ onFitView, enabled: false }));

    press({ key: "1" });

    expect(onFitView).not.toHaveBeenCalled();
  });

  it("leaves 1 alone when it is being typed", () => {
    const onFitView = vi.fn();
    renderHook(() => useCanvasShortcuts({ onFitView, enabled: true }));
    const input = document.createElement("input");
    document.body.append(input);

    press({ key: "1" }, input);

    expect(onFitView).not.toHaveBeenCalled();
  });

  it("ignores a modified 1, which belongs to the browser", () => {
    // Cmd+1 switches tab in every browser; claiming it would break that.
    const onFitView = vi.fn();
    renderHook(() => useCanvasShortcuts({ onFitView, enabled: true }));

    press({ key: "1", metaKey: true });
    press({ key: "1", ctrlKey: true });
    press({ key: "1", altKey: true });

    expect(onFitView).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    const onFitView = vi.fn();
    const { unmount } = renderHook(() => useCanvasShortcuts({ onFitView, enabled: true }));

    unmount();
    press({ key: "1" });

    expect(onFitView).not.toHaveBeenCalled();
  });
});
