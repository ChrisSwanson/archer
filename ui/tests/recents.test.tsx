// @vitest-environment jsdom
// The reader's recent files and projects (src/app/recents.ts): newest first,
// one entry per place, per viewer in localStorage, and nothing breaks when
// storage is refused or holds junk.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecents, RECENTS_KEY, useRecents, withRecent, type RecentItem } from "../src/app/recents";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const item = (id: string, at: number, slug = "p"): RecentItem => ({
  slug,
  projectName: "P",
  kind: "view",
  id,
  title: id,
  at,
});

describe("withRecent", () => {
  it("puts the newest first, and a place opened again moves up rather than repeating", () => {
    const list = withRecent(withRecent(withRecent([], item("a", 1)), item("b", 2)), item("a", 3));
    expect(list.map((r) => r.id)).toEqual(["a", "b"]);
    expect(withRecent(list, item("a", 4, "other")).map((r) => `${r.slug}:${r.id}`)).toEqual(["other:a", "p:a", "p:b"]);
  });

  it("keeps a bounded list", () => {
    let list: RecentItem[] = [];
    for (let i = 0; i < 100; i++) list = withRecent(list, item(`v${i}`, i));
    expect(list.length).toBeLessThanOrEqual(24);
    expect(list[0]?.id).toBe("v99");
  });
});

describe("readRecents", () => {
  it.each([
    ["embedded diagram above the metadata limit", "view", `notes/${"a".repeat(510)}.md#flow`, true],
    ["embedded diagram at ADR 0012's limit", "view", `${"a".repeat(1192)}.md#flow`, true],
    ["diagram beyond ADR 0012's limit", "view", `${"a".repeat(1193)}.md#flow`, false],
    ["note above the metadata limit", "note", `${"a".repeat(510)}.md`, true],
    ["note at the existing path limit", "note", `${"a".repeat(4093)}.md`, true],
    ["note beyond the existing path limit", "note", `${"a".repeat(4094)}.md`, false],
  ] as const)("round trips %s through storage", (_, kind, id, accepted) => {
    const recent = { ...item(id, 1), kind, title: "Readable title" };
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(withRecent([], recent)));
    expect(readRecents()).toEqual(accepted ? [recent] : []);
  });

  it.each(["slug", "projectName", "title"] as const)("keeps the metadata bound on %s", (field) => {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify([{ ...item("ok", 1), [field]: "a".repeat(513) }]));
    expect(readRecents()).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["not a list", "{}"],
    ["entries it cannot read", JSON.stringify([{ slug: 1 }, { ...item("ok", 1), kind: "folder" }, null])],
  ])("reads %s as nothing", (_, raw) => {
    window.localStorage.setItem(RECENTS_KEY, raw);
    expect(readRecents()).toEqual([]);
  });

  it("reads nothing, without throwing, where storage refuses to be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(readRecents()).toEqual([]);
  });
});

describe("useRecents", () => {
  it("keeps every recent held in memory across consecutive refused writes", () => {
    const { result } = renderHook(() => useRecents());
    const remember = (id: string) =>
      act(() => result.current.remember({ slug: "p", projectName: "P", kind: "view", id, title: id }));
    remember("a");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    remember("b");
    remember("c");
    expect(result.current.items.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("remembers in storage, and in the page alone when storage refuses the write", () => {
    const { result } = renderHook(() => useRecents());
    act(() => result.current.remember({ slug: "p", projectName: "P", kind: "note", id: "a.md", title: "A" }));
    expect(JSON.parse(window.localStorage.getItem(RECENTS_KEY)!)[0]).toMatchObject({ id: "a.md", kind: "note" });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    act(() => result.current.remember({ slug: "p", projectName: "P", kind: "project", id: "", title: "P" }));
    expect(result.current.items.map((r) => r.kind)).toEqual(["project", "note"]);
  });
});
