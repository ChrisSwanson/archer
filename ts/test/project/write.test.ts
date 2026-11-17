// Writing inside the Archer folder must not follow a link planted at the
// destination after the path was checked: the write replaces the entry, it
// never writes through it.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findProject, writeConfined } from "../../src/project/project.ts";
import { afterEach } from "vitest";
import { removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);
const tempProject = (): string => tempDir({ "archer.toml": "version = 1\n" });

test("a link at the destination is replaced, not written through", () => {
  const root = tempProject();
  const project = findProject(root);
  mkdirSync(project.folder, { recursive: true });
  const victim = join(root, "outside.txt");
  writeFileSync(victim, "untouched");
  symlinkSync(victim, join(project.folder, "d.mmd"));
  writeConfined(project, "d.mmd", "flowchart TB\n", "diagrams");
  expect(readFileSync(victim, "utf8")).toBe("untouched");
  expect(lstatSync(join(project.folder, "d.mmd")).isSymbolicLink()).toBe(false);
});

test("a directory link out of the folder is refused at write time", () => {
  const root = tempProject();
  const project = findProject(root);
  mkdirSync(project.folder, { recursive: true });
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(project.folder, "sub"));
  expect(() => writeConfined(project, "sub/x.mmd", "x", "diagrams")).toThrow(/outside the Archer folder/);
});
