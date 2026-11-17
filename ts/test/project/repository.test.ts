// A project's default name is its git repository's: a linked worktree is named after the
// main repository, read from the worktree's git files without running git.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { projectDisplayName, repositoryOf } from "../../src/project/repository.ts";
import { slugBase } from "../../src/state/project-names.ts";
import { cleanUp, tempDir } from "../service/support.ts";

afterEach(cleanUp);

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

function repository(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "# r\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  return root;
}

test("a repository's own checkout is named after its folder, with no worktree", () => {
  const root = repository(tempDir(), "pageturner");
  expect(repositoryOf(root)).toEqual({ name: "pageturner", commonDir: join(root, ".git") });
  expect(projectDisplayName({ root })).toBe("pageturner");
  expect(slugBase(root)).toBe("pageturner");
});

test("a linked worktree is named after the main repository and carries its folder and branch", () => {
  const parent = tempDir();
  const main = repository(parent, "pageturner");
  const scratch = join(tempDir(), "scratchpad", "order-notes");
  git(main, "worktree", "add", "-q", "-b", "demo/order-notes", scratch);
  expect(repositoryOf(scratch)).toEqual({
    name: "pageturner",
    commonDir: join(main, ".git"),
    worktree: { folder: "order-notes", branch: "demo/order-notes" },
  });
  expect(projectDisplayName({ root: scratch })).toBe("pageturner");
  // archer.toml's name still wins.
  expect(projectDisplayName({ root: scratch, name: "Pageturner" })).toBe("Pageturner");
  // The page address keeps worktrees apart under the repository's name.
  expect(slugBase(scratch)).toBe("pageturner-order-notes");
  const named = join(parent, "pageturner-reports");
  git(main, "worktree", "add", "-q", "--detach", named);
  expect(repositoryOf(named)).toEqual({
    name: "pageturner",
    commonDir: join(main, ".git"),
    worktree: { folder: "pageturner-reports" },
  });
  expect(slugBase(named)).toBe("pageturner-reports");
});

test("a worktree of a bare repository is named after the bare repository without .git", () => {
  const parent = tempDir();
  const main = repository(parent, "seed");
  const bare = join(parent, "pageturner.git");
  git(parent, "clone", "-q", "--bare", main, bare);
  const tree = join(parent, "wt");
  git(bare, "worktree", "add", "-q", tree, "main");
  expect(repositoryOf(tree)).toMatchObject({ name: "pageturner", worktree: { folder: "wt", branch: "main" } });
});

test("no repository, an unreadable .git file or a submodule-like gitdir falls back to the folder", () => {
  const plain = join(tempDir(), "notes");
  mkdirSync(plain);
  expect(repositoryOf(plain)).toBeNull();
  expect(projectDisplayName({ root: plain })).toBe("notes");
  const broken = join(tempDir(), "broken");
  mkdirSync(broken);
  writeFileSync(join(broken, ".git"), "not a gitdir line\n");
  expect(repositoryOf(broken)).toBeNull();
  writeFileSync(join(broken, ".git"), "gitdir: /nowhere/at/all\n");
  expect(repositoryOf(broken)).toBeNull();
  // A gitdir without commondir (a submodule, --separate-git-dir) is the folder's own repository.
  const own = join(tempDir(), "module");
  const store = join(tempDir(), "store");
  mkdirSync(own);
  mkdirSync(store);
  writeFileSync(join(store, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(own, ".git"), `gitdir: ${store}\n`);
  expect(repositoryOf(own)).toEqual({ name: "module", commonDir: store });
  // An oversized .git file is not read.
  writeFileSync(join(broken, ".git"), `gitdir: ${"x".repeat(10_000)}\n`);
  expect(repositoryOf(broken)).toBeNull();
});

test("a branch over 255 characters or with control characters is dropped; such a folder is bounded", () => {
  const parent = tempDir();
  const main = repository(parent, "pageturner");
  const tree = join(parent, "wt");
  git(main, "worktree", "add", "-q", "-b", "short", tree);
  const gitDir = join(main, ".git", "worktrees", "wt");
  writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${"b".repeat(256)}\n`);
  expect(repositoryOf(tree)?.worktree).toEqual({ folder: "wt" });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/a\u0007b\n");
  expect(repositoryOf(tree)?.worktree).toEqual({ folder: "wt" });
  const long = join(parent, "w\u0001".repeat(100));
  git(main, "worktree", "add", "-q", "--detach", long);
  const folder = repositoryOf(long)?.worktree?.folder ?? "";
  expect(folder.length).toBeLessThanOrEqual(255);
  expect(folder).not.toMatch(/[\u0000-\u001f\u007f]/u);
});
