import { describe, expect, it } from "vitest";
import { activeProjectForNavigation, projectNavigationPlace } from "../src/app/sidebar-project-activity";
import type { RecentItem } from "../src/app/recents";

const recents: RecentItem[] = [
  { slug: "recent", projectName: "Recent", kind: "note", id: "notes/start.md", title: "Start", at: 3 },
  { slug: "older", projectName: "Older", kind: "view", id: "system", title: "System", at: 2 },
];

describe("active sidebar project", () => {
  it("prefers the displayed project's slug to recent history", () => {
    expect(activeProjectForNavigation({ slug: "displayed", kind: "view", id: "system" }, recents)).toBe("displayed");
  });

  it("falls back to the most recently visited project's slug", () => {
    expect(activeProjectForNavigation(null, recents)).toBe("recent");
    expect(activeProjectForNavigation(null, [])).toBeNull();
  });

  it("uses the served route for files and an explicit focus for project overviews", () => {
    expect(projectNavigationPlace({ kind: "view", viewId: "system" }, "served", "focused")).toEqual({
      slug: "served",
      kind: "view",
      id: "system",
    });
    expect(projectNavigationPlace({ kind: "note", path: "notes/start.md" }, "served")).toEqual({
      slug: "served",
      kind: "note",
      id: "notes/start.md",
    });
    expect(projectNavigationPlace({ kind: "overview" }, "served", "focused")).toEqual({
      slug: "focused",
      kind: "project",
      id: "",
    });
    expect(projectNavigationPlace({ kind: "overview" }, "served")).toBeNull();
    expect(projectNavigationPlace({ kind: "folder", path: null }, "served", "focused")).toEqual({
      slug: "served",
      kind: "project",
      id: "",
    });
    expect(projectNavigationPlace(null, "served", "focused")).toBeNull();
  });
});
