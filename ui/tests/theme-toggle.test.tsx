// @vitest-environment jsdom
//
// The toggle is the only way a user can reach the theme system, so it has to
// expose all three states through one button. The design (settled, and matched
// to docs/prototypes/emphasis/theme.js):
//
//   click        -> flip to the opposite of what is showing
//   shift-click  -> stop overriding, go back to following the OS
//
// A three-way cycle is rejected: "system" is not discoverable as a cycle stop,
// and a user who wants light does not want to pass through it. Shift-click is
// not discoverable either, so the accessible name has to SAY so -- and has to
// say when the OS is already being followed, since shift-click does nothing
// then.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "../src/app/ThemeToggle";
import { THEME_STORAGE_KEY } from "../src/theme/theme";
import { breakLocalStorage, installMatchMedia } from "./match-media";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(cleanup);

function appliedTheme(): string | null {
  return document.documentElement.getAttribute("data-theme");
}

describe("ThemeToggle", () => {
  it("offers the opposite of the theme currently showing", () => {
    installMatchMedia(true);
    render(<ThemeToggle />);

    const button = screen.getByRole("button");
    expect(appliedTheme()).toBe("dark");
    // Dark is showing, so the button offers light -- and shows a sun, the
    // thing you get, not the thing you have.
    expect(button).toHaveAccessibleName(/switch to light mode/i);
    expect(button.querySelector("[data-icon='sun']")).not.toBeNull();
    expect(button.querySelector("[data-icon='moon']")).toBeNull();
  });

  it("flips the applied theme on click, and offers the way back", () => {
    installMatchMedia(true);
    render(<ThemeToggle />);
    const button = screen.getByRole("button");

    fireEvent.click(button);

    expect(appliedTheme()).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(button).toHaveAccessibleName(/switch to dark mode/i);
    expect(button.querySelector("[data-icon='moon']")).not.toBeNull();
  });

  it("says that shift-click returns to the OS, but only once overriding", () => {
    const setPrefersDark = installMatchMedia(true);
    render(<ThemeToggle />);
    const button = screen.getByRole("button");

    // Following the OS: shift-click is a no-op, so it is not advertised.
    expect(button).toHaveAccessibleName(/following your system/i);
    expect(button).not.toHaveAccessibleName(/shift-click/i);

    fireEvent.click(button);
    expect(button).toHaveAccessibleName(/shift-click/i);

    fireEvent.click(button, { shiftKey: true });

    // Back to following the OS, which is still dark...
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(appliedTheme()).toBe("dark");
    expect(button).toHaveAccessibleName(/following your system/i);

    // ...and it tracks the OS again, which is the point of resetting.
    act(() => setPrefersDark(false));
    expect(appliedTheme()).toBe("light");
  });

  it("follows a live OS change while no override is set", () => {
    const setPrefersDark = installMatchMedia(true);
    render(<ThemeToggle />);
    const button = screen.getByRole("button");

    expect(appliedTheme()).toBe("dark");
    act(() => setPrefersDark(false));

    expect(appliedTheme()).toBe("light");
    expect(button.querySelector("[data-icon='moon']")).not.toBeNull();
  });

  it("ignores a live OS change once the user has chosen", () => {
    const setPrefersDark = installMatchMedia(true);
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole("button"));
    expect(appliedTheme()).toBe("light");

    act(() => setPrefersDark(true));
    expect(appliedTheme()).toBe("light");
  });

  it("still works for this page load when storage is unavailable", () => {
    installMatchMedia(true);
    const restore = breakLocalStorage();
    try {
      // Private mode must not take the page down...
      render(<ThemeToggle />);
      const button = screen.getByRole("button");
      expect(appliedTheme()).toBe("dark");

      // ...and the choice must still apply, even though it cannot be
      // remembered for next time.
      fireEvent.click(button);
      expect(appliedTheme()).toBe("light");
    } finally {
      restore();
    }
  });

  it("names the button, not the icon", () => {
    installMatchMedia(true);
    render(<ThemeToggle />);

    const svg = screen.getByRole("button").querySelector("svg");
    expect(svg).not.toBeNull();
    // The glyph is decoration; the button carries the accessible name, so a
    // screen reader announces the action once rather than describing a shape.
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });
});
