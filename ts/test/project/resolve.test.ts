// Naming a diagram the way the prototype's /draw did: a path, a view id from
// archer.toml, or a file name without `.mmd`.
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findProject, ProjectError, resolveDiagram } from "../../src/project/index.ts";
import { BROKEN, FLOW, removeTempDirs, SEQ, tempDir } from "./support.ts";

afterEach(removeTempDirs);

function project() {
  const dir = tempDir({
    "archer.toml":
      'version = 1\n[[views]]\nid = "login-view"\nkind = "freeform"\ntitle = "Login"\nsource = ".archer/auth/login.mmd"\n',
    ".archer/auth/login.mmd": FLOW,
    ".archer/auth/flow.mmd": FLOW,
    ".archer/billing/flow.mmd": FLOW,
    ".archer/one/twin.mmd": BROKEN,
    ".archer/two/twin.mmd": SEQ,
    ".archer/a/both.mmd": BROKEN,
    ".archer/b/both.mmd": BROKEN,
    "outside.mmd": FLOW,
  });
  return { dir, project: findProject(dir) };
}

async function refusal(run: () => Promise<unknown>): Promise<ProjectError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProjectError) return error;
    throw error;
  }
  throw new Error("expected a ProjectError");
}

test("a path, relative to the working directory or to the folder, or absolute", async () => {
  const { dir, project: p } = project();
  expect((await resolveDiagram(p, ".archer/auth/login.mmd", { cwd: dir })).path).toBe("auth/login.mmd");
  expect((await resolveDiagram(p, "auth/login.mmd", { cwd: dir })).path).toBe("auth/login.mmd");
  expect((await resolveDiagram(p, "flow.mmd", { cwd: join(dir, ".archer", "billing") })).path).toBe("billing/flow.mmd");
  expect((await resolveDiagram(p, join(dir, ".archer", "auth", "flow.mmd"), { cwd: "/" })).path).toBe("auth/flow.mmd");
});

test("a view id, carrying its view", async () => {
  const { dir, project: p } = project();
  expect(await resolveDiagram(p, "login-view", { cwd: dir })).toEqual({
    path: "auth/login.mmd",
    view: { id: "login-view", kind: "freeform", title: "Login", source: "auth/login.mmd" },
  });
});

test("a file name without .mmd, or a folder path without it", async () => {
  const { dir, project: p } = project();
  expect((await resolveDiagram(p, "login", { cwd: dir })).path).toBe("auth/login.mmd");
  expect((await resolveDiagram(p, "billing/flow", { cwd: dir })).path).toBe("billing/flow.mmd");
});

test("of two files with one name, the one that compiles is chosen", async () => {
  const { dir, project: p } = project();
  expect((await resolveDiagram(p, "twin", { cwd: dir })).path).toBe("two/twin.mmd");
});

test("a name that matches several is refused with the choices", async () => {
  const { dir, project: p } = project();
  const error = await refusal(() => resolveDiagram(p, "flow", { cwd: dir }));
  expect(error.code).toBe("ambiguous_diagram");
  expect(error.message).toContain("auth/flow.mmd");
  expect(error.message).toContain("billing/flow.mmd");
  const neither = await refusal(() => resolveDiagram(p, "both", { cwd: dir }));
  expect(neither.code).toBe("ambiguous_diagram");
});

test("a name that matches nothing lists what there is", async () => {
  const { dir, project: p } = project();
  const error = await refusal(() => resolveDiagram(p, "nothing", { cwd: dir }));
  expect(error.code).toBe("diagram_not_found");
  expect(error.message).toContain("auth/login.mmd");
});

test("a file outside the Archer folder is refused, however it is named", async () => {
  const { dir, project: p } = project();
  for (const name of ["outside.mmd", join(dir, "outside.mmd"), "../outside.mmd", ".archer/../outside.mmd"]) {
    const error = await refusal(() => resolveDiagram(p, name, { cwd: dir }));
    expect(error.code, name).toBe("path_outside_archer_folder");
  }
});
