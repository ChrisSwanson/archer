// The freshness marker of a note and its embedded diagrams: the last commit
// that touched the note, whether it has changed since, or why there is none.
import { afterEach, describe, expect, test } from "vitest";
import { FreshnessCache } from "../../src/notes/freshness.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";
import { cleanup, commit, git, repo, write } from "../accuracy/support.ts";

afterEach(cleanup);
afterEach(removeTempDirs);

const NOTE = "# Auth\n\n```mermaid\nflowchart LR\n  a[A]\n```\n";

describe("FreshnessCache", () => {
  test("a committed note: its short hash and commit date, and no uncommitted changes", async () => {
    const root = repo({ ".archer/auth.md": NOTE });
    commit(root);
    const cache = new FreshnessCache(findProject(root));
    expect(await cache.of("auth.md")).toEqual({
      status: "committed",
      commit: git(root, "log", "-1", "--format=%h"),
      committedAt: git(root, "log", "-1", "--format=%cI"),
      uncommitted: false,
    });
  });

  test("a note edited since its last commit says so, beside that commit", async () => {
    const root = repo({ ".archer/auth.md": NOTE });
    const head = commit(root);
    write(root, ".archer/auth.md", `${NOTE}\nMore.\n`);
    expect(await new FreshnessCache(findProject(root)).of("auth.md")).toMatchObject({
      status: "committed",
      commit: head.slice(0, 7),
      uncommitted: true,
    });
  });

  test("a note never committed, in a repository with commits and in one with none", async () => {
    const withCommits = repo({ "README.md": "x\n" });
    commit(withCommits);
    write(withCommits, ".archer/new.md", NOTE);
    expect(await new FreshnessCache(findProject(withCommits)).of("new.md")).toEqual({ status: "never-committed" });
    const empty = repo({ ".archer/new.md": NOTE });
    expect(await new FreshnessCache(findProject(empty)).of("new.md")).toEqual({ status: "never-committed" });
  });

  test("a project that is not in Git says so", async () => {
    const root = tempDir({ ".archer/auth.md": NOTE });
    expect(await new FreshnessCache(findProject(root)).of("auth.md")).toEqual({ status: "not-in-git" });
  });

  test("asks Git once per note revision and repository state, and again after a commit", async () => {
    const root = repo({ ".archer/auth.md": NOTE });
    commit(root);
    write(root, ".archer/auth.md", `${NOTE}\nMore.\n`);
    const cache = new FreshnessCache(findProject(root));
    const first = await cache.of("auth.md");
    await cache.of("auth.md");
    await Promise.all([cache.of("auth.md"), cache.of("auth.md")]);
    expect(cache.inspections).toBe(1);
    expect(first).toMatchObject({ uncommitted: true });
    // Committing changes nothing in the note's bytes, and still changes its answer.
    const head = commit(root);
    expect(await cache.of("auth.md")).toMatchObject({ commit: head.slice(0, 7), uncommitted: false });
    expect(cache.inspections).toBe(2);
  });

  test("a path that is not a note in the Archer folder has no freshness", async () => {
    const root = repo({ ".archer/auth.md": NOTE });
    commit(root);
    const cache = new FreshnessCache(findProject(root));
    for (const path of ["../x.md", "missing.md", "/etc/passwd"])
      expect(await cache.of(path), path).toEqual({ status: "unavailable", reason: "note_not_found" });
  });
});

// From a Codex review of the note tools.
describe("FreshnessCache, adversarially", () => {
  test("never runs a repository's clean filter to decide whether the note changed", async () => {
    const root = repo({ ".archer/auth.md": NOTE, ".gitattributes": "*.md filter=evil\n" });
    const marker = `${root}/filter-ran`;
    git(root, "config", "filter.evil.clean", `sh -c 'echo ran >> "${marker}"; cat'`);
    commit(root);
    const { rmSync, existsSync } = await import("node:fs");
    rmSync(marker, { force: true });
    // The same size and a new time: Git must read the file through the filter to tell.
    write(root, ".archer/auth.md", NOTE.replace("a[A]", "a[B]"));
    const { utimesSync } = await import("node:fs");
    utimesSync(`${root}/.archer/auth.md`, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    // A stat-dirty index is what makes `git status` reach for the filter.
    expect(await new FreshnessCache(findProject(root)).of("auth.md")).toMatchObject({
      status: "committed",
      uncommitted: true,
    });
    expect(existsSync(marker)).toBe(false);
  });

  test("notices HEAD moving with reflogs off, though the note, the index and HEAD's file do not change", async () => {
    const root = repo({ ".archer/auth.md": NOTE });
    git(root, "config", "core.logAllRefUpdates", "false");
    const first = commit(root);
    write(root, ".archer/auth.md", `${NOTE}\nMore.\n`);
    const second = commit(root);
    const cache = new FreshnessCache(findProject(root));
    expect(await cache.of("auth.md")).toMatchObject({ commit: second.slice(0, 7) });
    git(root, "reset", "--soft", first);
    expect(await cache.of("auth.md")).toMatchObject({ commit: first.slice(0, 7), uncommitted: true });
  });
});
