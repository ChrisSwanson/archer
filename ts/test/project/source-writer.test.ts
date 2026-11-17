import { afterEach, expect, test } from "vitest";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findProject, writeConfined } from "../../src/project/project.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import { readEmbedded } from "../../src/notes/embedded.ts";
import { applySource, createConfined, withSourceWriterLock } from "../../src/project/source-writer.ts";
import { blockWriters, tempDir, removeTempDirs, FLOW } from "./support.ts";
afterEach(removeTempDirs);
function setup(files: Record<string, string> = {}) {
  return findProject(tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW, ...files }));
}
test("standalone apply performs byte CAS and returns exact BOM/CRLF effect, unchanged is explicit", async () => {
  const project = setup();
  const next = "\uFEFF" + FLOW.replace(/\n/g, "\r\n");
  const result = await applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), next, {
    syncDirectory: true,
  });
  expect(result).toEqual({
    before: Buffer.from(FLOW),
    after: Buffer.from(next),
    sourceRevision: revisionOf(Buffer.from(next)),
    path: "a.mmd",
    blockId: null,
    outcome: "updated",
  });
  expect(readFileSync(join(project.folder, "a.mmd"))).toEqual(Buffer.from(next));
  expect((await applySource(project, { kind: "view", viewId: "a" }, result.sourceRevision, next)).outcome).toBe(
    "unchanged",
  );
  await expect(
    applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), FLOW),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(readFileSync(join(project.folder, "a.mmd"))).toEqual(Buffer.from(next));
});
test("embedded apply checks current body and preserves current unrelated prose, BOM and CRLF", async () => {
  const note = "\uFEFF# Title\r\nProse\r\n```mermaid\r\n%% archer-id: graph\r\nflowchart LR\r\na[A]\r\n```\r\nTail\r\n";
  const project = setup({ ".archer/notes/n.md": note });
  const read = readEmbedded(project, "notes/n.md#graph")!;
  const current = note.replace("Prose", "Fresh prose\r\nExtra");
  writeFileSync(join(project.folder, "notes/n.md"), current);
  const result = await applySource(
    project,
    { kind: "embedded", address: read.address },
    read.sourceRevision,
    "%% archer-id: graph\nflowchart LR\na[New]\n",
  );
  const expected = current.replace("a[A]", "a[New]");
  expect(readFileSync(join(project.folder, "notes/n.md"), "utf8")).toBe(expected);
  expect(result).toEqual({
    before: Buffer.from(read.source),
    after: Buffer.from(readEmbedded(project, read.address)!.source),
    path: "notes/n.md",
    blockId: "graph",
    sourceRevision: readEmbedded(project, read.address)!.sourceRevision,
    outcome: "updated",
  });
});
test("browser refuses invalid source and embedded identity rename without writes", async () => {
  const project = setup({ ".archer/n.md": "```mermaid\n%% archer-id: x\nflowchart LR\na[A]\n```\n" });
  await expect(
    applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), "not a diagram"),
  ).rejects.toMatchObject({ code: "invalid_source" });
  const read = readEmbedded(project, "n.md#x")!;
  await expect(
    applySource(
      project,
      { kind: "embedded", address: "n.md#x" },
      read.sourceRevision,
      "%% archer-id: renamed\nflowchart LR\na[A]\n",
    ),
  ).rejects.toMatchObject({ code: "invalid_target" });
  expect(readFileSync(join(project.folder, "a.mmd"), "utf8")).toBe(FLOW);
  expect(readEmbedded(project, "n.md#x")!.sourceRevision).toBe(read.sourceRevision);
});
test("create is no-clobber, refuses missing parents and escaping links", () => {
  const project = setup();
  expect(createConfined(project, "diagrams/new.mmd", FLOW, { syncDirectory: true })).toBe(
    join(project.folder, "diagrams/new.mmd"),
  );
  expect(() => createConfined(project, "diagrams/new.mmd", "overwrite")).toThrowError(
    expect.objectContaining({ code: "EEXIST" }),
  );
  expect(readFileSync(join(project.folder, "diagrams/new.mmd"), "utf8")).toBe(FLOW);
  expect(() => createConfined(project, "missing/new.mmd", FLOW)).toThrowError(
    expect.objectContaining({ code: "create_not_allowed" }),
  );
  const outside = join(project.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(project.folder, "diagrams/escape"));
  expect(() => createConfined(project, "diagrams/escape/new.mmd", FLOW)).toThrow();
  symlinkSync(join(project.folder, "diagrams/new.mmd"), join(project.folder, "diagrams/alias.mmd"));
  expect(() => createConfined(project, "diagrams/alias.mmd", FLOW)).toThrowError(
    expect.objectContaining({ code: "EEXIST" }),
  );
});
test("source lock refuses live contention by name and releases on throw", () => {
  const project = setup();
  blockWriters(project, "a.mmd");
  expect(() =>
    withSourceWriterLock(project, "a.mmd", () => writeConfined(project, "a.mmd", "bad", "diagrams"), 10),
  ).toThrowError(expect.objectContaining({ code: "source_busy" }));
  expect(readFileSync(join(project.folder, "a.mmd"), "utf8")).toBe(FLOW);
});
for (const note of [
  "> ```mermaid\n> %% archer-id: x\n> flowchart LR\n> a[A]\n> ```\n",
  "```mermaid\n%% archer-id: x\nflowchart LR\na[A]\n",
])
  test("browser refuses nested/unclosed blocks unchanged", async () => {
    const project = setup({ ".archer/n.md": note });
    const read = readEmbedded(project, "n.md#x")!;
    expect(read).not.toBeNull();
    await expect(
      applySource(project, { kind: "embedded", address: "n.md#x" }, read.sourceRevision, FLOW),
    ).rejects.toMatchObject({ code: "invalid_target" });
    expect(readFileSync(join(project.folder, "n.md"), "utf8")).toBe(note);
  });
test("source lock releases after callback throws and forbids async callbacks", () => {
  const project = setup();
  expect(() =>
    withSourceWriterLock(project, "a.mmd", () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(withSourceWriterLock(project, "a.mmd", () => 42)).toBe(42);
  expect(() => withSourceWriterLock(project, "a.mmd", async () => 42)).toThrowError(
    expect.objectContaining({ code: "invalid_callback" }),
  );
});
test("browser refuses a manifest remap while compile is awaited, even with identical bytes", async () => {
  const project = setup({ ".archer/b.mmd": FLOW });
  const pending = applySource(
    project,
    { kind: "view", viewId: "a" },
    revisionOf(Buffer.from(FLOW)),
    FLOW.replace("Client", "Changed"),
  );
  writeFileSync(
    join(project.root, "archer.toml"),
    'version = 1\n[[views]]\nid = "a"\nkind = "freeform"\ntitle = "A"\nsource = ".archer/b.mmd"\n',
  );
  await expect(pending).rejects.toMatchObject({ code: "revision_conflict" });
  expect(readFileSync(join(project.folder, "a.mmd"), "utf8")).toBe(FLOW);
  expect(readFileSync(join(project.folder, "b.mmd"), "utf8")).toBe(FLOW);
});
test("editing implicit block pins same identity; receipt contains exact actual body bytes", async () => {
  const project = setup({ ".archer/n.md": "# A\n```mermaid\nflowchart LR\na[A]\n```\nTail" });
  const read = readEmbedded(project, "n.md#a")!;
  expect(read).not.toBeNull();
  const next = FLOW;
  const result = await applySource(project, { kind: "embedded", address: read.address }, read.sourceRevision, next);
  const written = readEmbedded(project, read.address)!;
  expect(result.before).toEqual(Buffer.from(read.source));
  expect(result.after).toEqual(Buffer.from(written.source));
  expect(result.after.toString()).toContain(`%% archer-id: ${read.name}\n`);
  expect(result.sourceRevision).toBe(written.sourceRevision);
  expect(result.blockId).toBe(read.name);
  expect(readFileSync(join(project.folder, "n.md"), "utf8").endsWith("```\nTail")).toBe(true);
});
test("journal callback aborts standalone and new-file publication under source lock", async () => {
  const project = setup();
  await expect(
    applySource(
      project,
      { kind: "view", viewId: "a" },
      revisionOf(Buffer.from(FLOW)),
      FLOW.replace("Client", "Changed"),
      {
        beforeWrite() {
          throw new Error("journal unavailable");
        },
      },
    ),
  ).rejects.toThrow("journal unavailable");
  expect(readFileSync(join(project.folder, "a.mmd"), "utf8")).toBe(FLOW);
  expect(() =>
    createConfined(project, "diagrams/new.mmd", FLOW, {
      beforeWrite() {
        throw new Error("journal unavailable");
      },
    }),
  ).toThrow("journal unavailable");
  expect(() => readFileSync(join(project.folder, "diagrams/new.mmd"))).toThrowError(
    expect.objectContaining({ code: "ENOENT" }),
  );
});
test("journal sees normalized embedded bytes before effect and its receipt matches exactly", async () => {
  const note = "# Flow\r\n```mermaid\r\nflowchart LR\r\na[A]\r\n```\r\nTail";
  const project = setup({ ".archer/n.md": note });
  const read = readEmbedded(project, "n.md#flow")!;
  let planned:
    | { before: Buffer | null; after: Buffer; sourceRevision: unknown; path: string; blockId: string | null }
    | undefined;
  const result = await applySource(project, { kind: "embedded", address: read.address }, read.sourceRevision, FLOW, {
    beforeWrite(plan) {
      expect(readFileSync(join(project.folder, "n.md"), "utf8")).toBe(note);
      planned = plan;
    },
  });
  expect(planned).toEqual({
    before: result.before,
    after: result.after,
    sourceRevision: read.sourceRevision,
    path: "n.md",
    blockId: "flow",
  });
  expect(planned!.after.toString()).toContain("%% archer-id: flow\r\n");
  expect(result.sourceRevision).toBe(readEmbedded(project, read.address)!.sourceRevision);
});
test("unchanged source still journals exact no-effect intent and creates no source effect", async () => {
  const project = setup();
  let calls = 0;
  const result = await applySource(project, { kind: "view", viewId: "a" }, revisionOf(Buffer.from(FLOW)), FLOW, {
    beforeWrite(plan) {
      calls++;
      expect(plan.before).toEqual(plan.after);
      expect(plan.sourceRevision).toBe(revisionOf(Buffer.from(FLOW)));
    },
  });
  expect(result.outcome).toBe("unchanged");
  expect(calls).toBe(1);
});

test("production note parser exposes lone-CR fences as nonwritable/unclosed; browser refuses unchanged", async () => {
  const note = "# Flow\r```mermaid\r%% archer-id: x\rflowchart LR\ra[A]\r```\rTail";
  const project = setup({ ".archer/n.md": note });
  const read = readEmbedded(project, "n.md#x")!;
  expect(read).not.toBeNull();
  expect(read.writable).toBe(false);
  expect(read.diagram.closed).toBe(false);
  let planned = false;
  await expect(
    applySource(project, { kind: "embedded", address: read.address }, read.sourceRevision, FLOW, {
      beforeWrite() {
        planned = true;
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_target" });
  expect(planned).toBe(false);
  expect(readFileSync(join(project.folder, "n.md"), "utf8")).toBe(note);
});
