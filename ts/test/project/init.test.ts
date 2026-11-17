// `archer init`: the Archer folder, archer.toml, and a pointer for agents in
// AGENTS.md (and CLAUDE.md when there is one). Running it again changes nothing.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findProject, initProject, POINTER_BEGIN, POINTER_END } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);

const read = (path: string) => readFileSync(path, "utf8");

test("creates the folder, archer.toml and AGENTS.md's pointer in an empty directory", () => {
  const dir = tempDir();
  const report = initProject(dir);
  expect(report.created.sort()).toEqual([".archer", "AGENTS.md", "archer.toml"]);
  expect(report.updated).toEqual([]);
  expect(existsSync(join(dir, ".archer"))).toBe(true);
  expect(findProject(dir)).toMatchObject({ manifest: join(dir, "archer.toml"), folderSetting: ".archer", views: [] });
  const agents = read(join(dir, "AGENTS.md"));
  expect(agents).toContain(POINTER_BEGIN);
  expect(agents).toContain(POINTER_END);
  expect(agents).toContain("`.archer/`");
  expect(agents).toMatch(/reference/);
  expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
});

test("appends to existing AGENTS.md and CLAUDE.md without touching what is there", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "AGENTS.md"), "# Rules\n\nBe kind.");
  writeFileSync(join(dir, "CLAUDE.md"), "Use British spelling.\n");
  const report = initProject(dir);
  expect(report.updated.sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
  expect(read(join(dir, "AGENTS.md")).startsWith("# Rules\n\nBe kind.\n\n" + POINTER_BEGIN)).toBe(true);
  expect(read(join(dir, "CLAUDE.md")).startsWith("Use British spelling.\n\n" + POINTER_BEGIN)).toBe(true);
});

test("is idempotent: a second run creates and changes nothing", () => {
  const dir = tempDir();
  initProject(dir);
  const before = read(join(dir, "AGENTS.md")) + read(join(dir, "archer.toml"));
  const again = initProject(dir);
  expect(again).toMatchObject({ created: [], updated: [] });
  expect(read(join(dir, "AGENTS.md")) + read(join(dir, "archer.toml"))).toBe(before);
});

test("honours the folder an existing archer.toml names, from a subdirectory too", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "archer.toml"), 'version = 1\nfolder = "docs/plans"\n');
  mkdirSync(join(dir, "src"));
  const report = initProject(join(dir, "src"));
  expect(report.created.sort()).toEqual(["AGENTS.md", "docs/plans"]);
  expect(existsSync(join(dir, "docs", "plans"))).toBe(true);
  expect(read(join(dir, "AGENTS.md"))).toContain("`docs/plans/`");
  expect(existsSync(join(dir, "src", "AGENTS.md"))).toBe(false);
});

test("a CLAUDE.md that links to AGENTS.md gets the pointer once", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "AGENTS.md"), "# Rules\n");
  symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
  const report = initProject(dir);
  expect(report.updated).toEqual(["AGENTS.md"]);
  expect(read(join(dir, "AGENTS.md")).split(POINTER_BEGIN).length).toBe(2);
});

test("an instructions file that links out of the project is refused", () => {
  const outside = tempDir();
  const dir = tempDir();
  writeFileSync(join(outside, "AGENTS.md"), "elsewhere\n");
  symlinkSync(join(outside, "AGENTS.md"), join(dir, "AGENTS.md"));
  expect(() => initProject(dir)).toThrow(/outside the project/);
  expect(read(join(outside, "AGENTS.md"))).toBe("elsewhere\n");
});

// Many projects keep their instructions in AGENTS.md and a short CLAUDE.md
// that sends Claude there; that CLAUDE.md needs no second copy of the pointer.
test("a CLAUDE.md that refers to AGENTS.md is left alone", () => {
  const dir = tempDir({ "AGENTS.md": "# Agents\n", "CLAUDE.md": "Follow [`AGENTS.md`](AGENTS.md).\n" });
  initProject(dir);
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(POINTER_BEGIN);
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("Follow [`AGENTS.md`](AGENTS.md).\n");
});

test("archer.toml is named after the repository, a worktree after its main repository, else the folder", async () => {
  const { spawnSync } = await import("node:child_process");
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", ...args], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const plain = join(tempDir(), 'Tide "pool"');
  mkdirSync(plain);
  initProject(plain);
  expect(read(join(plain, "archer.toml"))).toContain('name = "Tide \\"pool\\""\n');
  expect(findProject(plain).name).toBe('Tide "pool"');
  const main = join(tempDir(), "tidepool");
  mkdirSync(main);
  writeFileSync(join(main, "README.md"), "# T\n");
  git(main, "init", "-q", "-b", "main");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "one");
  const tree = join(tempDir(), "setup-archer");
  git(main, "worktree", "add", "-q", "-b", "setup", tree);
  initProject(tree);
  expect(findProject(tree).name).toBe("tidepool");
});
