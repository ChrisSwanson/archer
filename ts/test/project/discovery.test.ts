// Where the search for archer.toml stops, and which archer.toml files are
// trusted: it sets the folder Archer reads and writes, so one planted above
// the project, or writable by others, must not be picked up.
import { chmodSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findProject, initProject, ProjectError } from "../../src/project/index.ts";
import { removeTempDirs, tempDir, write } from "./support.ts";

let home: string | undefined;
beforeEach(() => {
  home = process.env["HOME"];
});
afterEach(() => {
  if (home === undefined) delete process.env["HOME"];
  else process.env["HOME"] = home;
  removeTempDirs();
});

const PLANTED = 'version = 1\nfolder = "planted"\n';

test("the search stops at the repository root: an archer.toml above it is not used", () => {
  const dir = tempDir({ "archer.toml": PLANTED, "repo/src/x": "" });
  mkdirSync(join(dir, "repo", ".git"));
  const project = findProject(join(dir, "repo", "src"));
  expect(project.manifest).toBeNull();
  // Without archer.toml the repository is the project.
  expect(project.root).toBe(join(dir, "repo"));
  expect(project.folder).toBe(join(dir, "repo", ".archer"));
});

test("an archer.toml at the repository root is used", () => {
  const dir = tempDir({ "repo/archer.toml": 'version = 1\nfolder = "plans"\n', "repo/src/x": "" });
  mkdirSync(join(dir, "repo", ".git"));
  expect(findProject(join(dir, "repo", "src")).folder).toBe(join(dir, "repo", "plans"));
});

test("the search stops at the home directory", () => {
  const dir = tempDir({ "archer.toml": PLANTED, "home/proj/x": "" });
  process.env["HOME"] = join(dir, "home");
  const project = findProject(join(dir, "home", "proj"));
  expect(project.manifest).toBeNull();
  expect(project.root).toBe(join(dir, "home", "proj"));
});

test("a directory others can write to is not searched", () => {
  const dir = tempDir({ "shared/archer.toml": PLANTED, "shared/proj/x": "" });
  chmodSync(join(dir, "shared"), 0o777);
  const project = findProject(join(dir, "shared", "proj"));
  expect(project.manifest).toBeNull();
  expect(project.root).toBe(join(dir, "shared", "proj"));
});

test("an archer.toml anyone can write to is refused, with what to do", () => {
  const dir = tempDir({ "archer.toml": "version = 1\n" });
  chmodSync(join(dir, "archer.toml"), 0o666);
  let caught: unknown;
  try {
    findProject(dir);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProjectError);
  expect((caught as ProjectError).code).toBe("untrusted_manifest");
  expect((caught as ProjectError).message).toMatch(/chmod/);
});

test("an archer.toml that is a link is refused", () => {
  const elsewhere = tempDir({ "archer.toml": "version = 1\n" });
  const dir = tempDir();
  symlinkSync(join(elsewhere, "archer.toml"), join(dir, "archer.toml"));
  expect(() => findProject(dir)).toThrow(/is a link/);
});

test("init writes an archer.toml only its owner can change", () => {
  const dir = tempDir();
  initProject(dir);
  expect(statSync(join(dir, "archer.toml")).mode & 0o022).toBe(0);
  expect(findProject(dir).manifest).toBe(join(dir, "archer.toml"));
});

test("started inside the Archer folder of a project without archer.toml, the project is its parent", () => {
  const dir = tempDir();
  write(dir, ".archer/notes/n.md", "");
  expect(findProject(join(dir, ".archer", "notes")).root).toBe(dir);
});

// A group-writable manifest is trusted only when that group is private to the
// user: no other account has it as its primary group or lists it as a member.
describe("group membership", () => {
  test("a group shared with another account is not private", async () => {
    const { groupIsPrivate } = await import("../../src/project/ownership.ts");
    const passwd = "me:x:1000:1000::/home/me:/bin/sh\nother:x:1001:1000::/home/other:/bin/sh\n";
    const group = "me:x:1000:\n";
    expect(groupIsPrivate(1000, 1000, passwd, group)).toBe(false);
  });
  test("a group listing another member is not private", async () => {
    const { groupIsPrivate } = await import("../../src/project/ownership.ts");
    const passwd = "me:x:1000:1000::/home/me:/bin/sh\n";
    const group = "me:x:1000:other\n";
    expect(groupIsPrivate(1000, 1000, passwd, group)).toBe(false);
  });
  test("a user-private group is private", async () => {
    const { groupIsPrivate } = await import("../../src/project/ownership.ts");
    const passwd = "me:x:1000:1000::/home/me:/bin/sh\nother:x:1001:1001::/home/other:/bin/sh\n";
    const group = "me:x:1000:\nother:x:1001:\n";
    expect(groupIsPrivate(1000, 1000, passwd, group)).toBe(true);
  });
});
