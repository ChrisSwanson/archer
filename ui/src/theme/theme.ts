/**
 * Theme resolution.
 *
 * Three states, not two. "Follow the OS" is a preference in its own right and
 * is the default; an explicit light or dark choice overrides the OS and keeps
 * overriding it, which is the whole point of making it explicit. Storing a
 * resolved value instead would lose that distinction -- "currently dark" and
 * "chose dark" would be indistinguishable, and the user's choice would be
 * silently undone the next time the OS flipped.
 *
 * The resolved theme is published as `data-theme` on the root element, which
 * is what `src/styles.css` keys its token blocks off.
 *
 * Avoiding a flash of the wrong theme: the stylesheet carries the OS-following
 * case itself, in a `prefers-color-scheme` block scoped to a root with no
 * `data-theme` yet. That is correct before a single line of JavaScript has
 * run, so the default path never flashes. `initTheme` then stamps the
 * attribute before the first React render, which covers the one remaining case
 * -- an explicit override that disagrees with the OS.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { browserStateKey } from "../runtime/address.ts";

export const THEME_STORAGE_KEY = "archer.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Storage can be unavailable (private mode, a blocked origin) and can hold
 * anything a previous version or another tab wrote. Neither is a reason to
 * fail to render, so both degrade to "follow the OS".
 */
export function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(browserStateKey(THEME_STORAGE_KEY));
    return isPreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** "system" is stored as the absence of a key, so it is also the fallback. */
export function writePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      window.localStorage.removeItem(browserStateKey(THEME_STORAGE_KEY));
      return;
    }
    window.localStorage.setItem(browserStateKey(THEME_STORAGE_KEY), preference);
  } catch {
    // A theme that cannot be remembered is still a theme that can be applied.
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference !== "system") {
    return preference;
  }
  return prefersDark ? "dark" : "light";
}

export function prefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

/** Resolve and stamp the theme. Call before the first render. */
export function initTheme(): ResolvedTheme {
  const theme = resolveTheme(readPreference(), prefersDark());
  applyTheme(theme);
  return theme;
}

/** The theme currently published on the root element. */
export function readAppliedTheme(): ResolvedTheme {
  const stamped = document.documentElement.getAttribute("data-theme");
  if (stamped === "light" || stamped === "dark") {
    return stamped;
  }
  // Nothing stamped yet (first paint, or a test rendering a component on its
  // own). The stylesheet is showing the OS-following case, so report that.
  return resolveTheme(readPreference(), prefersDark());
}

/**
 * Follow the applied theme without owning it.
 *
 * `data-theme` on the root is the single published source of truth, so
 * observing the attribute keeps every consumer consistent with whoever stamped
 * it -- no context to thread through, and no second copy of the state that
 * could drift.
 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeToAppliedTheme, readAppliedTheme, readAppliedTheme);
}

function subscribeToAppliedTheme(onChange: () => void): () => void {
  if (typeof MutationObserver !== "function") {
    return () => {};
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

/**
 * Own the theme: resolve the preference and publish it.
 *
 * EXACTLY ONE mounted component may call this. It holds the preference in
 * React state, so a second caller would hold a second copy and the two would
 * disagree the moment either changed -- the stale one would then re-publish
 * its own answer on the next OS change and undo the other. `ThemeToggle` is
 * that owner. Everything else reads `useResolvedTheme()`, which observes the
 * published attribute and cannot drift.
 */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
} {
  const [preference, setStoredPreference] = useState<ThemePreference>(readPreference);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(prefersDark);

  // Kept subscribed regardless of the current preference: the OS can change
  // while an override is in force, and switching back to "system" must land on
  // what the OS says *now*, not on what it said at mount.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => setSystemPrefersDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference): void => {
    writePreference(next);
    setStoredPreference(next);
  }, []);

  return { preference, resolved, setPreference };
}
