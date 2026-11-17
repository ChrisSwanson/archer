// Performance plan slice 3: CPU work that file counts cannot see. The walkthrough map is built once
// per inventory or search call, and notes at scale resolve to their diagrams through the indexes.
import { rmSync } from "node:fs";
import { afterAll, expect, test, vi } from "vitest";
import { findProject, listNotes } from "../../src/project/index.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import * as store from "../../src/walkthroughs/store.ts";
import { scaleProject } from "../support/scale-project.ts";

vi.mock("../../src/walkthroughs/store.ts", { spy: true });

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("notes resolve to their diagrams by name and by folder", () => {
  const root = scaleProject({ diagrams: 40, notes: 40 });
  roots.push(root);
  const notes = listNotes(findProject(root));
  expect(notes.find((n) => n.path === "notes/n7.md")?.diagrams).toEqual(["diagrams/d7.mmd"]);
  expect(notes.find((n) => n.path === "diagrams/beside.md")?.diagrams).toHaveLength(40);
});

test.each([20, 200])("inventory and search build the walkthrough map once, at %i views", async (n) => {
  const root = scaleProject({ diagrams: n, notes: n });
  roots.push(root);
  const state = await ProjectState.open(
    root,
    () => "http://localhost/p/",
    () => {},
    { restoreState: false },
  );
  try {
    const built = vi.mocked(store.walkthroughsPlaces);
    state.forgetReads();
    built.mockClear();
    state.inventory();
    expect(built.mock.calls.length).toBeLessThanOrEqual(1);
    built.mockClear();
    const found = state.search("Gamma");
    expect(found.results.length).toBeGreaterThan(0);
    expect(built.mock.calls.length).toBeLessThanOrEqual(1);
    const about = state.search("Note 3 ");
    expect(about.results.some((r) => r.target === "view:d3")).toBe(true);
  } finally {
    state.close();
  }
});
