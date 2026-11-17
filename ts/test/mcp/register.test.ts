// register_diagram: a view added to, or updated in, archer.toml for a file
// inside the Archer folder; everything else in archer.toml kept.
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findProject } from "../../src/project/index.ts";
import { BROKEN, call, connect, FLOW, refusal, removeTempDirs, SEQ, structured, tempDir, text } from "./support.ts";

afterEach(removeTempDirs);

test("registering a file without archer.toml is refused with no_manifest and creates nothing (ADR 0028)", async () => {
  const bare = tempDir({ ".archer/flows/login.mmd": SEQ });
  const refused = await connect({ cwd: bare });
  const error = await refusal(refused.client, "register_diagram", { sourcePath: "flows/login.mmd" });
  expect(error.message).toContain("archer init");
  expect(existsSync(join(bare, "archer.toml"))).toBe(false);
  await refused.close();
});

test("registering a file in a project with archer.toml writes its entry, and the view loads from it", async () => {
  const dir = tempDir({ "archer.toml": "version = 1\n", ".archer/flows/login.mmd": SEQ });
  const { client, close } = await connect({ cwd: dir });
  const result = await call(client, "register_diagram", { sourcePath: "flows/login.mmd", title: 'Login "v2"' });
  expect(structured(result)).toMatchObject({
    view: { id: "login", kind: "sequence", title: 'Login "v2"', registration: "durable", source: "flows/login.mmd" },
    changed: true,
  });
  expect(text(result)).toContain("Registered");
  expect(findProject(dir).views).toEqual([
    { id: "login", kind: "sequence", title: 'Login "v2"', source: "flows/login.mmd" },
  ]);
  await close();
});

test("a path relative to the project root, through the folder, names the same file", async () => {
  const dir = tempDir({ "archer.toml": "version = 1\n", ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir });
  await call(client, "register_diagram", { sourcePath: ".archer/arch.mmd", viewId: "overview", kind: "c4-context" });
  expect(findProject(dir).views).toEqual([
    { id: "overview", kind: "c4-context", title: "overview", source: "arch.mmd" },
  ]);
  await close();
});

test("registering a listed source again updates its entry in place and keeps the rest of archer.toml", async () => {
  const manifest =
    '# Our diagrams\nversion = 1\n\n[[views]]\n# the big picture\nid = "overview"\nkind = "freeform"\ntitle = "Overview"\nsource = ".archer/arch.mmd"\n\n' +
    '[[views]]\nid = "login"\nkind = "sequence"\ntitle = "Login"\nsource = ".archer/login.mmd"\n';
  const dir = tempDir({ "archer.toml": manifest, ".archer/arch.mmd": FLOW, ".archer/login.mmd": SEQ });
  const { client, close } = await connect({ cwd: dir });
  const result = await call(client, "register_diagram", {
    sourcePath: "arch.mmd",
    title: "System",
    kind: "c4-container",
  });
  expect(structured(result)).toMatchObject({
    view: { id: "overview", title: "System", kind: "c4-container" },
    changed: true,
  });
  const after = readFileSync(join(dir, "archer.toml"), "utf8");
  expect(after).toContain("# Our diagrams\n");
  expect(after).toContain('title = "Login"');
  expect(findProject(dir).views.map((v) => [v.id, v.title, v.kind])).toEqual([
    ["overview", "System", "c4-container"],
    ["login", "Login", "sequence"],
  ]);
  // The same registration again changes nothing.
  const again = await call(client, "register_diagram", { sourcePath: "arch.mmd" });
  expect(structured(again)).toMatchObject({ changed: false, view: { title: "System" } });
  await close();
});

test("a source that does not compile is refused with every problem, and nothing is registered", async () => {
  const dir = tempDir({ ".archer/arch.mmd": BROKEN });
  const { client, close } = await connect({ cwd: dir });
  const error = await refusal(client, "register_diagram", { sourcePath: "arch.mmd" });
  expect(error.data.code).toBe("invalid_source");
  expect(error.message).toContain("archer://docs/supported-mermaid");
  expect((error.data.diagnostics as unknown[]).length).toBeGreaterThan(0);
  expect(findProject(dir).manifest).toBeNull();
  await close();
});

test("a kind that does not fit the diagram is refused", async () => {
  const dir = tempDir({ ".archer/login.mmd": SEQ });
  const { client, close } = await connect({ cwd: dir });
  const error = await refusal(client, "register_diagram", { sourcePath: "login.mmd", kind: "freeform" });
  expect(error.data.code).toBe("invalid_source");
  expect(error.message).toContain("kind_model_mismatch");
  await close();
});

test("paths outside the Archer folder are refused, however they are named", async () => {
  const dir = tempDir({ "docs/outside.mmd": FLOW, ".archer/keep.mmd": FLOW });
  symlinkSync(join(dir, "docs/outside.mmd"), join(dir, ".archer/link.mmd"));
  const { client, close } = await connect({ cwd: dir });
  for (const sourcePath of [
    "docs/outside.mmd",
    "../docs/outside.mmd",
    join(dir, "docs/outside.mmd"),
    "link.mmd",
    "../../etc/x.mmd",
  ]) {
    const error = await refusal(client, "register_diagram", { sourcePath });
    expect(error.data.code, sourcePath).toBe("path_outside_archer_folder");
  }
  expect(findProject(dir).manifest).toBeNull();
  await close();
});

test("a missing file and a file that is not .mmd are invalid requests", async () => {
  const dir = tempDir({ ".archer/notes.md": "# x\n" });
  const { client, close } = await connect({ cwd: dir });
  expect((await refusal(client, "register_diagram", { sourcePath: "new.mmd" })).data.code).toBe("invalid_request");
  expect((await refusal(client, "register_diagram", { sourcePath: "notes.md" })).data.code).toBe("invalid_request");
  await close();
});

test("a 257th view is too_many_views, and archer.toml is left as it was", async () => {
  const files: Record<string, string> = { ".archer/extra.mmd": FLOW };
  let manifest = "version = 1\n";
  for (let i = 0; i < 256; i++) {
    manifest += `[[views]]\nid = "v${i}"\nkind = "freeform"\ntitle = "V"\nsource = ".archer/v${i}.mmd"\n`;
    files[`.archer/v${i}.mmd`] = FLOW;
  }
  const dir = tempDir({ ...files, "archer.toml": manifest });
  const { client, close } = await connect({ cwd: dir });
  expect((await refusal(client, "register_diagram", { sourcePath: "extra.mmd" })).data.code).toBe("too_many_views");
  expect(readFileSync(join(dir, "archer.toml"), "utf8")).toBe(manifest);
  await close();
});

test("a view id another file already has is a duplicate_view_id", async () => {
  const dir = tempDir({ ".archer/a.mmd": FLOW, ".archer/b.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir });
  const error = await refusal(client, "register_diagram", { sourcePath: "b.mmd", viewId: "a" });
  expect(error.data.code).toBe("duplicate_view_id");
  expect((await refusal(client, "register_diagram", { sourcePath: "b.mmd", viewId: "not ok" })).data.code).toBe(
    "invalid_arguments",
  );
  await close();
});

test("a state diagram registers with the state kind, and a graph kind does not fit it", async () => {
  const dir = tempDir({
    "archer.toml": "version = 1\n",
    ".archer/life.mmd": "stateDiagram-v2\n  A : Alpha\n  [*] --> A\n",
  });
  const { client, close } = await connect({ cwd: dir });
  const error = await refusal(client, "register_diagram", { sourcePath: "life.mmd", kind: "freeform" });
  expect(error.message).toContain("kind_model_mismatch");
  expect(error.message).toContain("pass state");
  const result = await call(client, "register_diagram", { sourcePath: "life.mmd" });
  expect(structured(result)).toMatchObject({ view: { id: "life", kind: "state" } });
  await close();
});
