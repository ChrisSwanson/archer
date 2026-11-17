// Finding a project and reading its archer.toml: the views (Rust 0.3's
// rules) and the Archer folder (ticket 09), which every path stays inside.
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findProject, historicalRegistry, ProjectError, resolveInFolder, confine } from "../../src/project/index.ts";
import { FLOW, removeTempDirs, tempDir, write } from "./support.ts";

afterEach(removeTempDirs);

const VIEW = (id: string, source: string, kind = "freeform", title = id) =>
  `[[views]]\nid = "${id}"\nkind = "${kind}"\ntitle = "${title}"\nsource = "${source}"\n`;

function failure(run: () => unknown): ProjectError {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectError) return error;
    throw error;
  }
  throw new Error("expected a ProjectError");
}

test("a directory without archer.toml is a project with the defaults", () => {
  const dir = tempDir();
  const project = findProject(dir);
  expect(project).toMatchObject({ root: dir, manifest: null, folderSetting: ".archer", views: [], problems: [] });
  expect(project.folder).toBe(join(dir, ".archer"));
});

test("the nearest archer.toml above the directory decides the project", () => {
  const dir = tempDir({ "archer.toml": 'version = 1\nfolder = "docs/archer"\n', "src/deep/x.txt": "" });
  const project = findProject(join(dir, "src", "deep"));
  expect(project.root).toBe(dir);
  expect(project.manifest).toBe(join(dir, "archer.toml"));
  expect(project.folder).toBe(join(dir, "docs", "archer"));
  expect(project.folderSetting).toBe("docs/archer");
});

test("views load with their source relative to the manifest, inside the folder", () => {
  const dir = tempDir({
    "archer.toml": "version = 1\n" + VIEW("auth", ".archer/flows/auth.mmd", "sequence", "Auth flow"),
    ".archer/flows/auth.mmd": FLOW,
  });
  expect(findProject(dir).views).toEqual([
    { id: "auth", kind: "sequence", title: "Auth flow", source: "flows/auth.mmd" },
  ]);
});

test("a view outside the Archer folder, or otherwise wrong, is left out and reported", () => {
  const dir = tempDir({
    "archer.toml":
      "version = 1\n" +
      VIEW("outside", "docs/diagrams/a.mmd") +
      VIEW("up", ".archer/../x.mmd") +
      VIEW("abs", "/etc/passwd.mmd") +
      VIEW("Bad Id", ".archer/b.mmd") +
      VIEW("kind", ".archer/c.mmd", "pie") +
      VIEW("ok", ".archer/d.mmd") +
      VIEW("ok", ".archer/e.mmd") +
      VIEW("dupe-source", ".archer/d.mmd") +
      VIEW("long", ".archer/f.mmd", "freeform", "t".repeat(201)) +
      '[[views]]\nid = "missing"\n',
  });
  const project = findProject(dir);
  expect(project.views.map((v) => v.id)).toEqual(["ok"]);
  expect(project.problems.map((p) => [p.position, p.id])).toEqual([
    [1, "outside"],
    [2, "up"],
    [3, "abs"],
    [4, "Bad Id"],
    [5, "kind"],
    [7, "ok"],
    [8, "dupe-source"],
    [9, "long"],
    [10, "missing"],
  ]);
  expect(project.problems[0]?.message).toMatch(/outside the Archer folder/);
  expect(project.problems[4]?.message).toMatch(/kind/);
  expect(project.problems[8]?.message).toMatch(/kind|title|source/);
});

test.each([
  ["not toml", "version = [", /archer\.toml/],
  ["no version", 'folder = "x"\n', /version/],
  ["wrong version", "version = 2\n", /version/],
  ["folder up", 'version = 1\nfolder = "../shared"\n', /folder/],
  ["folder absolute", 'version = 1\nfolder = "/tmp/x"\n', /folder/],
  ["folder root", 'version = 1\nfolder = "."\n', /folder/],
  ["folder not a string", "version = 1\nfolder = 3\n", /folder/],
  ["views not tables", 'version = 1\nviews = "x"\n', /views/],
])("an unusable manifest (%s) is a manifest_error", (_, text, message) => {
  const dir = tempDir({ "archer.toml": text });
  const error = failure(() => findProject(dir));
  expect(error.code).toBe("manifest_error");
  expect(error.message).toMatch(message);
});

test("an Archer folder that is a link leading out of the project is refused", () => {
  const outside = tempDir();
  const dir = tempDir();
  symlinkSync(outside, join(dir, ".archer"));
  expect(failure(() => findProject(dir)).code).toBe("path_outside_archer_folder");
});

test("paths given relative to the folder are confined to it", () => {
  const outside = tempDir({ "secret.mmd": FLOW });
  const dir = tempDir({ ".archer/a.mmd": FLOW });
  mkdirSync(join(dir, ".archer", "sub"));
  symlinkSync(outside, join(dir, ".archer", "escape"));
  symlinkSync(join(dir, ".archer", "a.mmd"), join(dir, ".archer", "inner.mmd"));
  const project = findProject(dir);
  expect(resolveInFolder(project, "sub/new.mmd")).toBe(join(dir, ".archer", "sub", "new.mmd"));
  expect(resolveInFolder(project, "inner.mmd")).toBe(join(dir, ".archer", "inner.mmd"));
  for (const bad of ["../x.mmd", "sub/../../x.mmd", "/etc/passwd", "escape/secret.mmd", "escape/new.mmd", ""]) {
    const error = failure(() => resolveInFolder(project, bad));
    expect(error.code, bad).toBe("path_outside_archer_folder");
    expect(error.message, bad).toMatch(/Archer folder/);
  }
});

test("confine turns an absolute path into a folder-relative one, or refuses it", () => {
  const dir = tempDir({ ".archer/a/b.mmd": FLOW, "elsewhere.mmd": FLOW });
  const project = findProject(dir);
  expect(confine(project, join(dir, ".archer", "a", "b.mmd"))).toBe("a/b.mmd");
  expect(failure(() => confine(project, join(dir, "elsewhere.mmd"))).code).toBe("path_outside_archer_folder");
});

test("a project found from inside its Archer folder is the same project", () => {
  const dir = tempDir();
  write(dir, "archer.toml", "version = 1\n");
  write(dir, ".archer/notes/n.md", "");
  expect(findProject(join(dir, ".archer", "notes")).root).toBe(dir);
});

// archer.toml may name the project; the page shows that name.
test("archer.toml may name the project; without a name the folder's name stands", () => {
  const named = tempDir({ "archer.toml": 'version = 1\nname = "Pageturner"\n' });
  expect(findProject(named).name).toBe("Pageturner");
  const plain = tempDir({ "archer.toml": "version = 1\n" });
  expect(findProject(plain).name).toBeUndefined();
  const bad = tempDir({ "archer.toml": "version = 1\nname = 7\n" });
  expect(() => findProject(bad)).toThrow(/name/);
});

test("a project manifest retains its service choice, including in historical metadata", () => {
  const manifest = 'version = 1\n[service]\nname = "courierdesk"\n';
  const dir = tempDir({ "archer.toml": manifest });
  expect(findProject(dir).serviceName).toBe("courierdesk");
  expect(historicalRegistry(manifest, dir).serviceName).toBe("courierdesk");
});

test.each([
  "host",
  "port",
  "admission",
  "public_url",
  "state",
  "socket",
  "auto_start",
  "restore",
  "open_browser",
  "__proto__",
])("a project manifest refuses the global service setting %s and names global configuration", (setting) => {
  const dir = tempDir({ "archer.toml": `version = 1\n[service]\nname = "courierdesk"\n${setting} = "forbidden"\n` });
  const error = failure(() => findProject(dir));
  expect(error.code).toBe("manifest_error");
  expect(error.message).toMatch(new RegExp(`\\[service\\].*${setting}`));
  expect(error.message).toMatch(/global.*archer\.toml/i);
  expect(failure(() => historicalRegistry(`version = 1\n[service]\n${setting} = "forbidden"\n`, dir)).code).toBe(
    "manifest_error",
  );
});

test.each([
  ["a value", 'service = "courierdesk"'],
  ["a list", '[[service]]\nname = "courierdesk"'],
  ["an unknown key", "[service]\nunknown = true"],
  ["an uppercase name", '[service]\nname = "Courierdesk"'],
  ["a leading hyphen", '[service]\nname = "-courierdesk"'],
  ["an empty name", '[service]\nname = ""'],
  ["an underscore", '[service]\nname = "courier_desk"'],
  ["more than 32 characters", `[service]\nname = "${"a".repeat(33)}"`],
  ["a non-string name", "[service]\nname = 7"],
])("a project manifest refuses service configured as %s", (_, service) => {
  const dir = tempDir({ "archer.toml": `version = 1\n${service}\n` });
  const error = failure(() => findProject(dir));
  expect(error.code).toBe("manifest_error");
  expect(error.message).toMatch(/service/);
});

test("an empty project service table makes no explicit service choice", () => {
  const dir = tempDir({ "archer.toml": "version = 1\n[service]\n" });
  expect(findProject(dir).serviceName).toBeUndefined();
});

test.each(["a", "default", "a".repeat(32)])("a project retains the service-name boundary %s", (name) => {
  const manifest = `version = 1\n[service]\nname = "${name}"\n`;
  const dir = tempDir({ "archer.toml": manifest });
  expect(findProject(dir).serviceName).toBe(name);
  expect(historicalRegistry(manifest, dir).serviceName).toBe(name);
});

test.each(["host", "port", "services", "projects", "socket", "state_dir", "unknown", "__proto__"])(
  "a project refuses the unknown top-level setting %s instead of ignoring it",
  (key) => {
    const dir = tempDir({ "archer.toml": `version = 1\n${key} = "forbidden"\n` });
    const error = failure(() => findProject(dir));
    expect(error.code).toBe("manifest_error");
    expect(error.message).toContain(key);
    expect(error.message).toMatch(/global.*archer\.toml/i);
  },
);

test("an unknown view setting produces a diagnostic and leaves other registered views available", () => {
  const dir = tempDir({
    "archer.toml": `version = 1\n${VIEW("bad", ".archer/bad.mmd")}host = "0.0.0.0"\n${VIEW("good", ".archer/good.mmd")}`,
  });
  const project = findProject(dir);
  expect(project.views.map((entry) => entry.id)).toEqual(["good"]);
  expect(project.problems).toEqual([expect.objectContaining({ id: "bad", message: expect.stringContaining("host") })]);
});
