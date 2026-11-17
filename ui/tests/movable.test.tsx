// @vitest-environment jsdom
// A panel the person can move like the chat bubble (ADR 0034 §10): window fractions per viewer, clamped inside
// the window, an arrow-key handle, a reset. The Diagram key and the Highlights legend wear it.
import type { JSX } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoveHandle, useMovable } from "../src/chat/movable";

const KEY = "archer.test.position";
const stored = (): unknown => JSON.parse(window.localStorage.getItem(KEY) ?? "null");

function Host(): JSX.Element {
  const movable = useMovable({ storageKey: KEY, label: "Test panel" });
  return (
    <section
      ref={movable.ref}
      aria-label="Test panel"
      style={movable.style}
      data-moved={movable.moved ? "" : undefined}
    >
      <MoveHandle movable={movable} />
    </section>
  );
}
const panel = () => screen.getByRole("region", { name: "Test panel" });
const handle = () => screen.getByRole("button", { name: "Move Test panel" });

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  // jsdom does no layout: the panel is 200 x 100 and rests at (100, 600).
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = this.style.position === "fixed" ? Number.parseFloat(this.style.left) : 100;
    const top = this.style.position === "fixed" ? Number.parseFloat(this.style.top) : 600;
    return {
      left,
      top,
      right: left + 200,
      bottom: top + 100,
      width: 200,
      height: 100,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useMovable", () => {
  it("rests where its stylesheet puts it until the person moves it", () => {
    render(<Host />);
    expect(panel().style.position).toBe("");
    expect(panel()).not.toHaveAttribute("data-moved");
    expect(screen.queryByRole("button", { name: "Reset Test panel position" })).toBeNull();
  });

  it("an arrow key moves it 10 px from where it rests, and keeps window fractions per viewer", () => {
    render(<Host />);
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(panel().style.position).toBe("fixed");
    expect(panel().style.left).toBe("110px");
    expect(panel().style.top).toBe("600px");
    expect(stored()).toEqual({ x: 0.11, y: 0.75 });
    fireEvent.keyDown(handle(), { key: "ArrowUp", shiftKey: true });
    expect(panel().style.top).toBe("550px");
  });

  it("reads the stored fractions back after a reload", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ x: 0.3, y: 0.2 }));
    render(<Host />);
    expect(panel().style.left).toBe("300px");
    expect(panel().style.top).toBe("160px");
  });

  it("holds it fully inside the window after a resize, without forgetting where it was put", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ x: 0.9, y: 0.9 }));
    render(<Host />);
    expect(panel().style.left).toBe("792px"); // 1000 - 200 - 8
    expect(panel().style.top).toBe("692px"); // 800 - 100 - 8
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(panel().style.left).toBe("292px");
    expect(stored()).toEqual({ x: 0.9, y: 0.9 });
  });

  it("Home and the reset button put it back where its stylesheet had it, and forget the place", () => {
    render(<Host />);
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(stored()).not.toBeNull();
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(panel().style.position).toBe("");
    expect(stored()).toBeNull();
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Reset Test panel position" }));
    expect(panel().style.position).toBe("");
    expect(stored()).toBeNull();
  });

  it("a drag moves it live by transform and drops it exactly where it is put", () => {
    render(<Host />);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 110, clientY: 610 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 210, clientY: 410 });
    expect(panel().style.transform).toBe("translate(100px, -200px)");
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 210, clientY: 410 });
    expect(panel().style.transform).toBe("");
    expect(panel().style.left).toBe("200px");
    expect(panel().style.top).toBe("400px");
    expect(stored()).toEqual({ x: 0.2, y: 0.5 });
  });

  it("a drop past the window's edge is held inside it", () => {
    render(<Host />);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 110, clientY: 610 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 5000, clientY: 5000 });
    expect(panel().style.left).toBe("792px");
    expect(panel().style.top).toBe("692px");
  });

  it("works with storage blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(<Host />);
    expect(() => fireEvent.keyDown(handle(), { key: "ArrowDown" })).not.toThrow();
    expect(panel().style.top).toBe("610px");
  });

  it("the arrow keys are the handle's: they do not reach the page behind", () => {
    const page = vi.fn();
    document.addEventListener("keydown", page);
    render(<Host />);
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(page).not.toHaveBeenCalled();
    document.removeEventListener("keydown", page);
  });
});

describe("a panel that goes away and comes back (finding 12)", () => {
  function Sometimes(props: { readonly shown: boolean; readonly wide: boolean }): JSX.Element {
    const movable = useMovable({ storageKey: KEY, label: "Test panel" });
    return props.shown ? (
      <section ref={movable.ref} aria-label="Test panel" style={movable.style} data-wide={props.wide ? "" : undefined}>
        <MoveHandle movable={movable} />
      </section>
    ) : (
      <p>hidden</p>
    );
  }

  it("is held inside the window by the size it has when it comes back", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.hasAttribute("data-wide") ? 600 : 200;
      const left = this.style.position === "fixed" ? Number.parseFloat(this.style.left) : 100;
      const top = this.style.position === "fixed" ? Number.parseFloat(this.style.top) : 600;
      return {
        left,
        top,
        right: left + width,
        bottom: top + 100,
        width,
        height: 100,
        x: left,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    });
    window.localStorage.setItem(KEY, JSON.stringify({ x: 0.7, y: 0.5 }));
    const { rerender } = render(<Sometimes shown wide={false} />);
    expect(panel().style.left).toBe("700px");
    rerender(<Sometimes shown={false} wide={false} />);
    rerender(<Sometimes shown wide />);
    // 600 px wide in a 1000 px window: no further right than 1000 - 600 - 8.
    expect(panel().style.left).toBe("392px");
  });
});
