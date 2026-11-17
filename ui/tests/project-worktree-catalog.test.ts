// A linked git worktree is listed under its repository's name, with its folder as a detail.
import { expect, test } from "vitest";
import { parseProjectCatalog, worktreeDetail } from "../src/app/project-directory";

const project = { slug: "pageturner-order-notes", name: "pageturner", views: [], notes: [] };
const catalog = (entry: Record<string, unknown>) => parseProjectCatalog({ schemaVersion: 1, projects: [entry] });

test("the catalog keeps a worktree's folder and branch, bounded, and the detail names them", () => {
  const parsed = catalog({ ...project, worktree: { folder: "order-notes", branch: "demo/order-notes" } })?.[0];
  expect(parsed).toMatchObject({ name: "pageturner", worktree: { folder: "order-notes", branch: "demo/order-notes" } });
  expect(worktreeDetail(parsed!)).toEqual({
    text: "worktree order-notes",
    title: "Git worktree order-notes, branch demo/order-notes",
  });
  expect(worktreeDetail(catalog({ ...project, worktree: { folder: "order-notes" } })![0]!)).toEqual({
    text: "worktree order-notes",
    title: "Git worktree order-notes",
  });
  expect(worktreeDetail(catalog(project)![0]!)).toBeNull();
});

test("a malformed worktree field is dropped from its entry; the catalog and the entry stay", () => {
  for (const worktree of [
    { folder: "" },
    { folder: "x".repeat(256) },
    "order-notes",
    { folder: "c", branch: "b".repeat(256) },
    { folder: "a\u0007b" },
  ]) {
    const parsed = parseProjectCatalog({
      schemaVersion: 1,
      projects: [
        { ...project, worktree },
        { slug: "pageturner", name: "pageturner", views: [], notes: [] },
      ],
    });
    expect(parsed?.map((p) => p.slug)).toEqual(["pageturner-order-notes", "pageturner"]);
    expect(parsed?.[0]?.worktree).toBeUndefined();
  }
});
