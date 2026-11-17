// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.hoisted(() => vi.resetModules());
vi.mock("../src/runtime/address.ts", async () => await import("../src/playground/address"));
import { browserStateKey, configureStaticAddress } from "../src/playground/address";
import { readPreference, writePreference, THEME_STORAGE_KEY } from "../src/theme/theme";
import { readPanelWidth, savePanelWidth, PANEL_WIDTH_KEY, PANEL_WIDTH } from "../src/app/PanelDivider";
import { characterShortcutsEnabled, setCharacterShortcutsEnabled, useCharacterShortcuts } from "../src/app/shortcuts";
import {
  FOLDER_TREE_KEY,
  TREE_COLUMNS_KEY,
  readFolderChoices,
  readTreeColumns,
  TREE_COLUMNS,
  useTreeColumns,
} from "../src/app/project-tree";
import { setTabIdForTests } from "../src/comments/draft-tabs";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  configureStaticAddress({
    documentUrl: "http://localhost:3000/archer/playground/app/index.html",
    digest: "sha256:preferences",
  });
});
afterEach(() => {
  cleanup();
  setTabIdForTests(null);
});

it("reads defaults instead of the ordinary app's theme, panel and shortcut preferences", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "dark");
  localStorage.setItem(PANEL_WIDTH_KEY, "480");
  localStorage.setItem("archer.shortcuts.characters", "off");
  expect(readPreference()).toBe("system");
  expect(readPanelWidth()).toBe(PANEL_WIDTH.initial);
  expect(characterShortcutsEnabled()).toBe(true);
});

it("persists demo choices under the snapshot namespace and preserves ordinary preferences", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "dark");
  localStorage.setItem(PANEL_WIDTH_KEY, "480");
  localStorage.setItem("archer.shortcuts.characters", "off");
  writePreference("light");
  savePanelWidth(400);
  setCharacterShortcutsEnabled(true);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe("480");
  expect(localStorage.getItem("archer.shortcuts.characters")).toBe("off");
  expect(localStorage.getItem(browserStateKey(THEME_STORAGE_KEY))).toBe("light");
  expect(readPanelWidth()).toBe(400);
  expect(characterShortcutsEnabled()).toBe(true);
  writePreference("system");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(localStorage.getItem(browserStateKey(THEME_STORAGE_KEY))).toBeNull();
});

it("separates folder and table choices and responds only to namespaced shortcut storage events", () => {
  localStorage.setItem(FOLDER_TREE_KEY, JSON.stringify({ tour: { diagrams: false } }));
  localStorage.setItem(TREE_COLUMNS_KEY, JSON.stringify([...TREE_COLUMNS].reverse()));
  expect(readFolderChoices()).toEqual({});
  expect(readTreeColumns()).toEqual(TREE_COLUMNS);
  const columns = renderHook(useTreeColumns);
  act(() => columns.result.current.onColumnsChange([...TREE_COLUMNS].reverse()));
  expect(localStorage.getItem(browserStateKey(TREE_COLUMNS_KEY))).toBe(JSON.stringify([...TREE_COLUMNS].reverse()));
  const shortcuts = renderHook(useCharacterShortcuts);
  act(() => {
    localStorage.setItem(browserStateKey("archer.shortcuts.characters"), "off");
    window.dispatchEvent(new StorageEvent("storage", { key: "archer.shortcuts.characters" }));
  });
  expect(shortcuts.result.current).toBe(true);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: browserStateKey("archer.shortcuts.characters") })));
  expect(shortcuts.result.current).toBe(false);
});

it("keeps demo tab identity in its own session namespace", () => {
  sessionStorage.setItem("archer.tab-id.v1", "live-tab");
  setTabIdForTests("0123456789abcdef");
  expect(sessionStorage.getItem("archer.tab-id.v1")).toBe("live-tab");
  expect(sessionStorage.getItem(browserStateKey("archer.tab-id.v1"))).toBe("0123456789abcdef");
});
