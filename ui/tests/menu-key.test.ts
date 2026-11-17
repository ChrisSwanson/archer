// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMenuKeyFallback } from "../src/app/menu-key";

describe("Shift+F10 where the browser sends no contextmenu (macOS)", () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function setup(): { box: HTMLButtonElement; seen: MouseEvent[] } {
    vi.useFakeTimers();
    uninstall = installMenuKeyFallback(window);
    const box = document.createElement("button");
    document.body.append(box);
    const seen: MouseEvent[] = [];
    document.addEventListener("contextmenu", (event) => seen.push(event));
    return { box, seen };
  }
  const press = (at: Element, init: KeyboardEventInit = {}): boolean =>
    at.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true, ...init }),
    );

  it("sends one contextmenu at the focused element, with no pointer position", () => {
    const { box, seen } = setup();
    press(box);
    expect(seen).toHaveLength(0);
    vi.runAllTimers();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.target).toBe(box);
    expect([seen[0]!.button, seen[0]!.clientX, seen[0]!.clientY]).toEqual([0, 0, 0]);
  });

  it("sends none when the browser sent its own (Windows, Linux)", () => {
    const { box, seen } = setup();
    press(box);
    box.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    vi.runAllTimers();
    expect(seen).toHaveLength(1);
  });

  it("leaves a key a handler took, and other keys and modifiers, alone", () => {
    const { box, seen } = setup();
    box.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "F10") event.preventDefault();
      },
      { once: true },
    );
    press(box);
    press(box, { shiftKey: false });
    press(box, { ctrlKey: true });
    press(box, { metaKey: true });
    press(box, { key: "F9" });
    vi.runAllTimers();
    expect(seen).toHaveLength(0);
  });
});
