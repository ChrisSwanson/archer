import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { listStaleDiagrams } from "../../src/accuracy/stale.ts";
import { cleanup, commit, git, FLOW, manifest, project, repo, write } from "./support.ts";
afterEach(cleanup);
test("covered working edits become stale against the last diagram commit; unrelated edits do not", async () => {
  const root = repo({
    "archer.toml": manifest(),
    ".archer/flow.mmd": FLOW,
    "src/api.ts": "before",
    "other.ts": "unrelated",
  });
  const baseline = commit(root);
  write(root, "other.ts", "different");
  write(root, "src/api.ts", "after");
  expect((await listStaleDiagrams(project(root))).views[0]).toMatchObject({
    status: "stale",
    baselineCommit: baseline,
    changedPaths: [{ path: "src/api.ts", status: "modified" }],
  });
  write(root, "src/api.ts", "before");
  expect((await listStaleDiagrams(project(root))).views[0]).toMatchObject({
    status: "current",
    baselineCommit: baseline,
    changedPaths: [],
  });
});
test("code-only commits do not refresh the diagram baseline; staged, deleted and untracked covered paths are included", async () => {
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW, "src/a.ts": "old", "src/delete.ts": "old" });
  const baseline = commit(root);
  write(root, "src/a.ts", "new");
  commit(root);
  write(root, "src/added.ts", "new");
  git(root, "add", "src/added.ts");
  write(root, "src/untracked.ts", "new");
  rmSync(join(root, "src/delete.ts"));
  const got = (await listStaleDiagrams(project(root))).views[0];
  expect(got?.baselineCommit).toBe(baseline);
  expect(got?.changedPaths).toEqual([
    { path: "src/a.ts", status: "modified" },
    { path: "src/added.ts", status: "added" },
    { path: "src/delete.ts", status: "deleted" },
    { path: "src/untracked.ts", status: "added" },
  ]);
  write(root, ".archer/flow.mmd", FLOW.replace("Client", "Customer"));
  const refreshed = commit(root);
  expect((await listStaleDiagrams(project(root))).views[0]).toMatchObject({
    status: "current",
    baselineCommit: refreshed,
  });
});
test("uncommitted diagrams have a named never-reviewed state", async () => {
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW, "src/a.ts": "a" });
  expect((await listStaleDiagrams(project(root))).views[0]).toMatchObject({
    status: "never-reviewed",
    baselineCommit: null,
  });
});
test("a committed rename refreshes the last diagram-change baseline", async () => {
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW, "src/a.ts": "a" });
  commit(root);
  git(root, "mv", ".archer/flow.mmd", ".archer/renamed.mmd");
  write(root, "archer.toml", manifest(undefined, ".archer/renamed.mmd"));
  const rename = commit(root);
  expect((await listStaleDiagrams(project(root))).views[0]).toMatchObject({
    status: "current",
    baselineCommit: rename,
  });
});
test("no Git repository returns unavailable without inventing a review baseline", async () => {
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW });
  rmSync(join(root, ".git"), { recursive: true });
  expect(await listStaleDiagrams(project(root))).toMatchObject({
    status: "unavailable",
    reason: "git_unavailable",
    views: [{ status: "unavailable", baselineCommit: null }],
  });
});
test("registered views without coverage are explicitly not-covered", async () => {
  const root = repo({ "archer.toml": manifest(""), ".archer/flow.mmd": FLOW });
  commit(root);
  expect((await listStaleDiagrams(project(root))).views[0]).toMatchObject({
    status: "not-covered",
    baselineCommit: null,
    covers: [],
  });
});
