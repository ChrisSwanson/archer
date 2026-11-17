// read_diagram, validate_diagram and write_diagram on a temporary project.
import { chmodSync, existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { revisionOf } from "../../src/project/index.ts";
import { BROKEN, call, connect, FLOW, refusal, removeTempDirs, SEQ, structured, tempDir, text } from "./support.ts";

afterEach(removeTempDirs);

const rev = (text: string) => revisionOf(Buffer.from(text, "utf8"));
const FLOW2 = "flowchart LR\n  a[Client] e1@--> b[API]\n  b e2@--> c[DB]\n";

test("read_diagram returns the model, the source and both revisions of a view that compiles", async () => {
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir });
  const result = await call(client, "read_diagram", { viewId: "arch" });
  const payload = structured(result) as Record<string, any>;
  expect(payload.view).toMatchObject({ id: "arch", kind: "freeform", registration: "ephemeral", source: "arch.mmd" });
  expect(payload.modelRevision).toBe(rev(FLOW));
  expect(payload.sourceRevision).toBe(rev(FLOW));
  expect(payload.envelope.model.edges.map((e: { id: string }) => e.id)).toEqual(["e1"]);
  expect(payload.source).toMatchObject({ status: "text", text: FLOW, resource: "archer://diagram/arch/source" });
  expect(payload.compile).toMatchObject({ status: "compiled", sourceRevision: rev(FLOW) });
  expect(text(result)).toContain(`pass sourceRevision ${rev(FLOW)}`);
  await close();
});

test("read_diagram of a source that never compiled has no model, and says why", async () => {
  const dir = tempDir({ ".archer/arch.mmd": BROKEN });
  const { client, close } = await connect({ cwd: dir });
  const payload = structured(await call(client, "read_diagram", { viewId: "arch" })) as Record<string, any>;
  expect(payload.envelope).toBeNull();
  expect(payload.modelRevision).toBeNull();
  expect(payload.sourceRevision).toBe(rev(BROKEN));
  expect(payload.compile.status).toBe("failed");
  expect(payload.compile.diagnostics.length).toBeGreaterThan(0);
  await close();
});

test("after a broken write, read_diagram keeps the last model beside the new source", async () => {
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir });
  await call(client, "read_diagram", { viewId: "arch" });
  await call(client, "write_diagram", { viewId: "arch", source: BROKEN, expectedRevision: rev(FLOW) });
  const payload = structured(await call(client, "read_diagram", { viewId: "arch" })) as Record<string, any>;
  expect(payload.modelRevision).toBe(rev(FLOW));
  expect(payload.sourceRevision).toBe(rev(BROKEN));
  expect(payload.compile).toMatchObject({ status: "failed", lastValidRevision: rev(FLOW) });
  await close();
});

test("read_diagram serves the source as a resource too", async () => {
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir });
  const read = await client.readResource({ uri: "archer://diagram/arch/source" });
  expect((read.contents[0] as { text: string }).text).toBe(FLOW);
  await expect(client.readResource({ uri: "archer://diagram/nope/source" })).rejects.toThrow(/nope/);
  await close();
});

test("an unknown view is diagram_not_found for every authoring tool", async () => {
  const { client, close } = await connect({ cwd: tempDir({ ".archer/arch.mmd": FLOW }) });
  for (const [name, args] of [
    ["read_diagram", { viewId: "archh" }],
    ["validate_diagram", { viewId: "archh", source: FLOW }],
    ["write_diagram", { viewId: "archh", source: FLOW, expectedRevision: rev(FLOW) }],
  ] as const) {
    const error = await refusal(client, name, args);
    expect(error.data.code, name).toBe("diagram_not_found");
    expect(error.code).toBe(-32002);
  }
  await close();
});

test("validate_diagram reports located diagnostics and writes nothing", async () => {
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir });
  const bad = await call(client, "validate_diagram", { viewId: "arch", source: BROKEN });
  const payload = structured(bad) as Record<string, any>;
  expect(payload.valid).toBe(false);
  expect(payload.diagnostics[0]).toMatchObject({ severity: "error", span: { start: { line: 2 } } });
  expect(text(bad)).toMatch(/^Invalid:\n\[\w+\] line 2:/);
  const good = await call(client, "validate_diagram", { viewId: "arch", source: FLOW2 });
  expect(structured(good)).toMatchObject({ valid: true, revision: rev(FLOW2) });
  expect(readFileSync(join(dir, ".archer/arch.mmd"), "utf8")).toBe(FLOW);
  await close();
});

test("validate_diagram holds a listed view to its declared kind", async () => {
  const dir = tempDir({
    "archer.toml":
      'version = 1\n[[views]]\nid = "login"\nkind = "sequence"\ntitle = "Login"\nsource = ".archer/login.mmd"\n',
    ".archer/login.mmd": SEQ,
  });
  const { client, close } = await connect({ cwd: dir });
  const payload = structured(await call(client, "validate_diagram", { viewId: "login", source: FLOW })) as Record<
    string,
    any
  >;
  expect(payload.valid).toBe(false);
  expect(payload.diagnostics.map((d: { code: string }) => d.code)).toContain("kind_model_mismatch");
  await close();
});

test("write_diagram replaces the source at the expected revision and recompiles", async () => {
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir });
  const result = await call(client, "write_diagram", { viewId: "arch", source: FLOW2, expectedRevision: rev(FLOW) });
  const { layoutReview, ...priorFields } = structured(result);
  expect(layoutReview).toMatchObject({
    version: 1,
    profile: "desktop-1025x896-gutter24",
    sourceRevision: rev(FLOW2),
    inspect: { tool: "measure_diagram", arguments: { viewId: "arch" } },
  });
  expect(priorFields).toEqual({
    sourceRevision: rev(FLOW2),
    revision: rev(FLOW2),
    modelRevision: rev(FLOW2),
    status: "compiled",
    diagnostics: [],
  });
  expect(readFileSync(join(dir, ".archer/arch.mmd"), "utf8")).toBe(FLOW2);
  const again = await call(client, "write_diagram", { viewId: "arch", source: FLOW2, expectedRevision: rev(FLOW2) });
  expect(structured(again)).toMatchObject({ status: "unchanged" });
  await close();
});

test("write_diagram writes source that does not compile, as Rust 0.3 does, and says it failed", async () => {
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir });
  const result = await call(client, "write_diagram", { viewId: "arch", source: BROKEN, expectedRevision: rev(FLOW) });
  const payload = structured(result) as Record<string, any>;
  expect(payload.status).toBe("failed");
  expect(payload.sourceRevision).toBe(rev(BROKEN));
  expect(payload.diagnostics.length).toBeGreaterThan(0);
  expect(text(result)).toContain(`pass that as expectedRevision`);
  expect(readFileSync(join(dir, ".archer/arch.mmd"), "utf8")).toBe(BROKEN);
  await close();
});

test("a stale revision is a revision_conflict carrying the current one, and nothing is written", async () => {
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir });
  await call(client, "read_diagram", { viewId: "arch" });
  writeFileSync(join(dir, ".archer/arch.mmd"), BROKEN); // the person edits the file meanwhile
  const error = await refusal(client, "write_diagram", { viewId: "arch", source: FLOW2, expectedRevision: rev(FLOW) });
  expect(error.data).toMatchObject({
    code: "revision_conflict",
    expectedRevision: rev(FLOW),
    actualRevision: rev(BROKEN),
    sourceRevision: rev(BROKEN),
  });
  // The revision passed was the model's: the ordinary mistake, named.
  expect(error.data.modelRevision).toBe(rev(FLOW));
  expect(error.message).toContain("modelRevision");
  expect(readFileSync(join(dir, ".archer/arch.mmd"), "utf8")).toBe(BROKEN);
  await close();
});

test("write_diagram never writes through a link out of the Archer folder", async () => {
  const dir = tempDir({ "outside.mmd": FLOW, ".archer/keep.txt": "" });
  symlinkSync(join(dir, "outside.mmd"), join(dir, ".archer/arch.mmd"));
  const { client, close } = await connect({ cwd: dir });
  // A link out of the folder is not a diagram of it.
  expect(
    (await refusal(client, "write_diagram", { viewId: "arch", source: FLOW2, expectedRevision: rev(FLOW) })).data.code,
  ).toBe("diagram_not_found");
  expect(readFileSync(join(dir, "outside.mmd"), "utf8")).toBe(FLOW);
  await close();
});

test("a write that fails leaves the old file whole and no partial file behind", async () => {
  if (process.getuid?.() === 0) return; // root writes through any mode
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const folder = join(dir, ".archer");
  const { client, close } = await connect({ cwd: dir });
  chmodSync(folder, 0o555);
  try {
    const error = await refusal(client, "write_diagram", {
      viewId: "arch",
      source: FLOW2,
      expectedRevision: rev(FLOW),
    });
    expect(error.data.code).toBe("io_failure");
  } finally {
    chmodSync(folder, 0o755);
  }
  expect(readFileSync(join(folder, "arch.mmd"), "utf8")).toBe(FLOW);
  expect(readdirSync(folder)).toEqual(["arch.mmd"]);
  await close();
});

test("a view whose file is missing cannot be written", async () => {
  const dir = tempDir({
    "archer.toml":
      'version = 1\n[[views]]\nid = "gone"\nkind = "freeform"\ntitle = "Gone"\nsource = ".archer/gone.mmd"\n',
    ".archer/x.txt": "",
  });
  const { client, close } = await connect({ cwd: dir });
  const read = structured(await call(client, "read_diagram", { viewId: "gone" })) as Record<string, any>;
  expect(read.source.status).toBe("missing");
  const error = await refusal(client, "write_diagram", { viewId: "gone", source: FLOW, expectedRevision: rev(FLOW) });
  expect(error.data.code).toBe("invalid_request");
  expect(existsSync(join(dir, ".archer/gone.mmd"))).toBe(false);
  await close();
});
