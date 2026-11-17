// ADR 0029: `nested_view = false` in archer.toml draws every diagram as written. Presentation only:
// the page learns it from the bootstrap's `project.nestedView`, which is sent only when false.
import { realpathSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { findProject } from "../../src/project/index.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { cleanUp, FLOW, tempDir, write } from "./support.ts";

afterEach(cleanUp);

const manifest = (setting: string) =>
  `version = 1\n${setting}\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "The flow"\nsource = ".archer/flow.mmd"\n`;

function root(setting: string): string {
  const dir = realpathSync(tempDir("archer-nested-"));
  write(dir, ".archer/flow.mmd", FLOW);
  write(dir, "archer.toml", manifest(setting));
  return dir;
}

const projectOf = (bootstrap: unknown) => (bootstrap as { project: Record<string, unknown> }).project;

test.each([
  ["", undefined],
  ["nested_view = true", undefined],
  ["nested_view = false", false],
])("archer.toml %j sends bootstrap project.nestedView %j", async (setting, expected) => {
  const state = await ProjectState.open(root(setting), () => "http://localhost/project");
  try {
    const project = projectOf(state.bootstrap());
    expect(project.nestedView).toBe(expected);
    expect("nestedView" in project).toBe(expected !== undefined);
  } finally {
    state.close();
  }
});

test("a non-boolean nested_view is a manifest error naming the fix", () => {
  expect(() => findProject(root('nested_view = "no"'))).toThrow(
    "`nested_view` must be true or false (false draws every diagram as written; no nested view)",
  );
});

test("a reloaded archer.toml changes later bootstraps", async () => {
  const dir = root("");
  const state = await ProjectState.open(dir, () => "http://localhost/project");
  try {
    expect("nestedView" in projectOf(state.bootstrap())).toBe(false);
    write(dir, "archer.toml", manifest("nested_view = false"));
    await state.reload();
    expect(projectOf(state.bootstrap()).nestedView).toBe(false);
  } finally {
    state.close();
  }
});
