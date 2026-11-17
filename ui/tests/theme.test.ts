// @vitest-environment jsdom
//
// Theme resolution is a genuine three-state system, not a boolean:
//
//   "system"  -- follow the OS, and keep following it as it changes
//   "light"   -- an explicit user choice that STOPS tracking the OS
//   "dark"    -- likewise
//
// The distinction matters because "currently dark" and "chose dark" are not
// the same state: only the second should survive the OS flipping at sunset.
// Collapsing them into a stored resolved value is the usual bug, so the tests
// below check the OS moving underneath each preference.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  initTheme,
  readPreference,
  resolveTheme,
  useResolvedTheme,
  useTheme,
  writePreference,
} from "../src/theme/theme";
import { installMatchMedia } from "./match-media";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("theme preference", () => {
  it("defaults to following the OS", () => {
    expect(readPreference()).toBe("system");
  });

  it("persists an explicit choice and reads it back", () => {
    writePreference("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readPreference()).toBe("light");
  });

  it("returns to following the OS when the override is cleared", () => {
    writePreference("dark");
    writePreference("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readPreference()).toBe("system");
  });

  it("ignores a stored value that is not a preference", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "solarized");
    expect(readPreference()).toBe("system");
  });
});

describe("theme resolution", () => {
  it("follows the OS under the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the OS under an explicit preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("applying a theme", () => {
  it("stamps the resolved theme on the root element", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("resolves and stamps in one call, before anything renders", () => {
    installMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    expect(initTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("useTheme", () => {
  it("tracks the OS while the preference is system", () => {
    const setPrefersDark = installMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    expect(result.current.preference).toBe("system");
    expect(result.current.resolved).toBe("dark");

    act(() => setPrefersDark(false));

    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("stops tracking the OS once the user chooses explicitly", () => {
    const setPrefersDark = installMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setPreference("light"));
    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // The OS goes dark. An explicit choice must not be overridden by it.
    act(() => setPrefersDark(true));
    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // ...and going back to "system" resumes tracking, now landing on dark.
    act(() => result.current.setPreference("system"));
    expect(result.current.resolved).toBe("dark");
  });

  it("keeps a separate consumer in step with the applied theme", async () => {
    installMatchMedia(true);
    const owner = renderHook(() => useTheme());
    const follower = renderHook(() => useResolvedTheme());

    expect(follower.result.current).toBe("dark");

    // The follower holds no copy of the state: it observes the published
    // attribute, so it cannot drift from whoever changed the preference.
    act(() => owner.result.current.setPreference("light"));

    await vi.waitFor(() => {
      expect(follower.result.current).toBe("light");
    });
  });

  it("reports the OS-following theme before anything has been stamped", () => {
    installMatchMedia(false);
    document.documentElement.removeAttribute("data-theme");

    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("light");
  });

  it("persists the explicit choice for the next visit", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setPreference("light"));

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readPreference()).toBe("light");
  });
});
