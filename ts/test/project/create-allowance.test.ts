// ADR 0028: the service creates files only under diagrams/ or notes/ in the Archer folder, and
// creates the folders on the way there itself: one at a time, never through a link, bounded.
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { findProject } from "../../src/project/project.ts";
import { createConfined, MAX_CREATE_DEPTH } from "../../src/project/source-writer.ts";
import { FLOW, removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);

const setup = (files: Record<string, string> = {}) =>
  findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW, ...files }));

test("creates a new diagram under diagrams/ or notes/, making the missing folders", () => {
  const project = setup();
  createConfined(project, "diagrams/payments/flows/checkout.mmd", FLOW);
  expect(readFileSync(join(project.folder, "diagrams/payments/flows/checkout.mmd"), "utf8")).toBe(FLOW);
  expect(lstatSync(join(project.folder, "diagrams/payments")).isDirectory()).toBe(true);
  createConfined(project, "notes/decisions/flow.mmd", FLOW);
  expect(existsSync(join(project.folder, "notes/decisions/flow.mmd"))).toBe(true);
});

test.each([
  ["the Archer folder's top level", "x.mmd"],
  ["another folder", "drafts/x.mmd"],
  ["a look-alike prefix", "diagrams-old/x.mmd"],
  ["a case-folded root", "Diagrams/x.mmd"],
])("refuses creation in %s with create_not_allowed and makes no folder", (_where, path) => {
  const project = setup();
  expect(() => createConfined(project, path, FLOW)).toThrowError(
    expect.objectContaining({ code: "create_not_allowed" }),
  );
  expect(existsSync(join(project.folder, path))).toBe(false);
  const first = path.split("/")[0]!;
  if (path.includes("/")) expect(existsSync(join(project.folder, first))).toBe(false);
});

test.each(["diagrams/../x.mmd", "diagrams/.hidden/x.mmd", "diagrams//x.mmd", "/abs/diagrams/x.mmd", "diagrams\\x.mmd"])(
  "refuses a malformed path %s and makes no folder",
  (path) => {
    const project = setup();
    expect(() => createConfined(project, path, FLOW)).toThrow();
    expect(existsSync(join(project.folder, "diagrams"))).toBe(false);
  },
);

test("the folder depth is bounded by name: exactly the limit works, one more is refused", () => {
  const project = setup();
  const at = ["diagrams", ...Array.from({ length: MAX_CREATE_DEPTH }, (_, i) => `d${i}`)];
  createConfined(project, `${at.join("/")}/deep.mmd`, FLOW);
  expect(existsSync(join(project.folder, ...at, "deep.mmd"))).toBe(true);
  expect(() => createConfined(project, `${[...at, "more"].join("/")}/deeper.mmd`, FLOW)).toThrowError(
    expect.objectContaining({ code: "create_not_allowed" }),
  );
  expect(existsSync(join(project.folder, ...at, "more"))).toBe(false);
});

test("never creates through a link: a linked diagrams/ or a linked folder on the way is refused", () => {
  const outside = tempDir();
  const project = setup();
  symlinkSync(outside, join(project.folder, "diagrams"), "dir");
  expect(() => createConfined(project, "diagrams/x/y.mmd", FLOW)).toThrow();
  expect(existsSync(join(outside, "x"))).toBe(false);
  const second = setup();
  mkdirSync(join(second.folder, "notes"));
  symlinkSync(outside, join(second.folder, "notes", "linked"), "dir");
  expect(() => createConfined(second, "notes/linked/inner/z.mmd", FLOW)).toThrow();
  expect(existsSync(join(outside, "inner"))).toBe(false);
});

test("a refused create (an existing file) still leaves its new folders, and only those", () => {
  const project = setup({ ".archer/diagrams/a/x.mmd": FLOW });
  expect(() => createConfined(project, "diagrams/a/x.mmd", FLOW)).toThrowError(
    expect.objectContaining({ code: "EEXIST" }),
  );
  expect(readFileSync(join(project.folder, "diagrams/a/x.mmd"), "utf8")).toBe(FLOW);
});

test("register_diagram no longer creates archer.toml: it refuses with no_manifest", async () => {
  const root = tempDir({ ".git/HEAD": "ref: refs/heads/main\n", ".archer/loose.mmd": FLOW });
  const app = createApplication({ cwd: root });
  try {
    await expect(app.call("register_diagram", { sourcePath: "loose.mmd" })).rejects.toMatchObject({
      data: { code: "no_manifest" },
    });
  } finally {
    app.close();
  }
  expect(existsSync(join(root, "archer.toml"))).toBe(false);
});
