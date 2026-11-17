// Compiling a diagram of the folder into the envelope the page reads: its view
// from archer.toml, or one made from the file's name as register_diagram did.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compileDiagram, findProject } from "../../src/project/index.ts";
import { BROKEN, FLOW, removeTempDirs, SEQ, tempDir } from "./support.ts";

afterEach(removeTempDirs);

const sha = (text: string | Buffer) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const VIEWS =
  'version = 1\n[[views]]\nid = "ctx"\nkind = "c4-context"\ntitle = "Context"\nsource = ".archer/ctx.mmd"\n' +
  '[[views]]\nid = "wrong"\nkind = "sequence"\ntitle = "Wrong"\nsource = ".archer/wrong.mmd"\n';

test("a listed view keeps its id, kind and title, and its graph takes the kind's model type", async () => {
  const dir = tempDir({ "archer.toml": VIEWS, ".archer/ctx.mmd": FLOW });
  const result = await compileDiagram(findProject(dir), { path: "ctx.mmd", view: findProject(dir).views[0]! });
  expect(result.diagnostics).toEqual([]);
  expect(result.envelope).toMatchObject({
    schemaVersion: 2,
    view: { id: "ctx", kind: "c4-context", title: "Context" },
    revision: sha(FLOW),
    model: { type: "architecture-graph" },
  });
});

test("an unlisted file is named by its file name, and its kind follows its diagram", async () => {
  const dir = tempDir({ ".archer/flows/auth.mmd": SEQ, ".archer/sys.mmd": FLOW });
  const project = findProject(dir);
  const seq = await compileDiagram(project, { path: "flows/auth.mmd" });
  expect(seq.envelope?.view).toEqual({ id: "auth", kind: "sequence", title: "auth" });
  expect(seq.envelope?.model.type).toBe("sequence-trace");
  const flow = await compileDiagram(project, { path: "sys.mmd" });
  expect(flow.envelope?.view).toEqual({ id: "sys", kind: "freeform", title: "sys" });
  expect(flow.envelope?.model.type).toBe("freeform-graph");
});

test("a source that does not compile has diagnostics and no envelope", async () => {
  const dir = tempDir({ ".archer/bad.mmd": BROKEN });
  const result = await compileDiagram(findProject(dir), { path: "bad.mmd" });
  expect(result.envelope).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({ code: "unsupported_construct", severity: "error" });
});

test("a graph under a sequence view is a kind_model_mismatch", async () => {
  const dir = tempDir({ "archer.toml": VIEWS, ".archer/wrong.mmd": FLOW });
  const project = findProject(dir);
  const result = await compileDiagram(project, { path: "wrong.mmd", view: project.views[1]! });
  expect(result.envelope).toBeNull();
  expect(result.diagnostics.map((d) => d.code)).toEqual(["kind_model_mismatch"]);
});

test("a file that is not UTF-8, or whose name is no view id, is a diagnostic", async () => {
  const dir = tempDir({ ".archer/my diagram.mmd": FLOW });
  writeFileSync(join(dir, ".archer", "latin1.mmd"), Buffer.from([0x66, 0xe9, 0x0a]));
  const project = findProject(dir);
  const latin = await compileDiagram(project, { path: "latin1.mmd" });
  expect(latin.diagnostics.map((d) => d.code)).toEqual(["source_not_utf8"]);
  const spaced = await compileDiagram(project, { path: "my diagram.mmd" });
  expect(spaced.envelope).toBeNull();
  expect(spaced.diagnostics.map((d) => d.code)).toEqual(["invalid_view_id"]);
});

test.each([
  ["life", "stateDiagram-v2\n  A : Alpha\n  [*] --> A\n", "state", "state-machine"],
  ["data", "erDiagram\n  A\n", "entity-relationship", "entity-relationship"],
  ["context", 'C4Context\n  Person(p, "P")\n', "c4", "c4-model"],
  ["platform", "architecture-beta\n  service a(server)[A]\n", "architecture", "service-architecture"],
  ["day", "journey\n  section S\n    Go: 3\n", "journey", "user-journey"],
])("an unlisted %s diagram takes its own kind and model", async (name, source, kind, type) => {
  const dir = tempDir({ [`.archer/${name}.mmd`]: source });
  const result = await compileDiagram(findProject(dir), { path: `${name}.mmd` });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(result.envelope?.view).toEqual({ id: name, kind, title: name });
  expect(result.envelope?.model.type).toBe(type);
});

test("a state diagram under a graph view is a kind_model_mismatch, named as what it is", async () => {
  const dir = tempDir({
    "archer.toml":
      'version = 1\n[[views]]\nid = "life"\nkind = "freeform"\ntitle = "Life"\nsource = ".archer/life.mmd"\n',
    ".archer/life.mmd": "stateDiagram-v2\n  A : Alpha\n",
  });
  const project = findProject(dir);
  const result = await compileDiagram(project, { path: "life.mmd", view: project.views[0]! });
  expect(result.envelope).toBeNull();
  expect(result.diagnostics[0]).toMatchObject({ code: "kind_model_mismatch" });
  expect(result.diagnostics[0]?.message).toContain("a state diagram");
});
