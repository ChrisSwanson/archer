// Docs mode (docs/proposals/archer-modes.md, doc-pack.md): one project setting, `mode = "docs"`,
// and `archer init --docs`, which sets it and points agents at the router. No stub files.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findProject, initProject, POINTER_END } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);

const read = (path: string) => readFileSync(path, "utf8");

test.each([
  ["", undefined],
  ['mode = "docs"\n', "docs"],
])("archer.toml %j loads with mode %j", (line, mode) => {
  const project = findProject(tempDir({ "archer.toml": `version = 1\n${line}` }));
  expect(project.mode).toBe(mode);
});

test.each(['mode = "scratch"', "mode = true", 'mode = "Docs"'])(
  "%s is a manifest error naming the one value",
  (line) => {
    expect(() => findProject(tempDir({ "archer.toml": `version = 1\n${line}\n` }))).toThrow('`mode` must be "docs"');
  },
);

test("init --docs in an empty directory writes the mode line and the router pointer, and no files in the folder", () => {
  const dir = tempDir();
  const report = initProject(dir, { docs: true });
  expect(report.project.mode).toBe("docs");
  expect(read(join(dir, "archer.toml"))).toMatch(/^mode = "docs"$/m);
  expect(readdirSync(join(dir, ".archer"))).toEqual([]);
  const agents = read(join(dir, "AGENTS.md"));
  expect(agents).toContain("read `.archer/index.md`");
  expect(agents).toContain("`archer docs docs-mode`");
  expect(agents.indexOf("read `.archer/index.md`")).toBeLessThan(agents.indexOf(POINTER_END));
});

test("init --docs on an existing project adds the mode before the first table and the pointer inside the section", () => {
  const dir = tempDir();
  initProject(dir);
  const toml = join(dir, "archer.toml");
  writeFileSync(toml, `${read(toml)}\n[[views]]\nid = "a"\nkind = "freeform"\ntitle = "A"\nsource = ".archer/a.mmd"\n`);
  writeFileSync(join(dir, ".archer", "a.mmd"), "flowchart LR\n  a[A] e1@--> b[B]\n");
  const report = initProject(dir, { docs: true });
  expect(report.updated.sort()).toEqual(["AGENTS.md", "archer.toml"]);
  const text = read(toml);
  expect(text.indexOf('mode = "docs"')).toBeLessThan(text.indexOf("[[views]]"));
  expect(findProject(dir)).toMatchObject({ mode: "docs", views: [{ id: "a" }] });
  expect(read(join(dir, "AGENTS.md")).match(/index\.md/g)).toHaveLength(1);
});

test("init --docs twice changes nothing the second time", () => {
  const dir = tempDir();
  initProject(dir, { docs: true });
  const before = [read(join(dir, "archer.toml")), read(join(dir, "AGENTS.md"))];
  const report = initProject(dir, { docs: true });
  expect(report).toMatchObject({ created: [], updated: [] });
  expect([read(join(dir, "archer.toml")), read(join(dir, "AGENTS.md"))]).toEqual(before);
});

test("plain init leaves a project's mode alone", () => {
  const dir = tempDir();
  initProject(dir, { docs: true });
  initProject(dir);
  expect(findProject(dir).mode).toBe("docs");
});
