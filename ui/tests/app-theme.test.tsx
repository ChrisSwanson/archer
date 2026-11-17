// @vitest-environment jsdom
//
// The theme must be reachable and must stay reachable from the assembled app,
// not just from the toggle rendered on its own.
//
// The hazard this pins: `useTheme` holds the preference in React state, so
// exactly one mounted component may own it. When `App` also called it, the
// toggle's change left App's copy stale, and App would re-publish its own
// (older) answer on the next OS change -- silently undoing the user. A test
// that only clicks would not see that; this one moves the OS afterwards.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { THEME_STORAGE_KEY } from "../src/theme/theme";
import { installMatchMedia } from "./match-media";

// `App` connects the real host bridge on mount and jsdom implements neither
// `fetch` nor `EventSource`. No presentation is needed here -- the theme is
// independent of what is on the canvas -- so these only have to exist.
// `app.render.test.tsx` is what exercises the bridge itself.
class SilentEventSource {
  readonly close = vi.fn();
  addEventListener(): void {}
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.stubGlobal("EventSource", SilentEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("theme wiring in the assembled app", () => {
  it("puts a working theme control on screen", () => {
    installMatchMedia(true);
    render(<App />);

    const button = screen.getByRole("button", { name: /switch to light mode/i });
    fireEvent.click(button);

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("does not let a second owner undo the user's choice", () => {
    const setPrefersDark = installMatchMedia(true);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /switch to light mode/i }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // An OS change is what wakes a stale second copy of the preference. The
    // explicit choice must survive it.
    act(() => setPrefersDark(false));
    act(() => setPrefersDark(true));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("follows the OS from the assembled app until a choice is made", () => {
    const setPrefersDark = installMatchMedia(true);
    render(<App />);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    act(() => setPrefersDark(false));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
