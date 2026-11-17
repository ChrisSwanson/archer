import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

test("read_note returns retention policy prose outside Mermaid as exact source and note revision", async () => {
  const source =
    "# Retention policy\n\nKeep audit events for 90 days.\n\n```mermaid\n%% archer-id: policy\nflowchart LR\n  audit[Audit events]\n```\n";
  const cwd = tempDir({ ".archer/notes/policy.md": source });
  const app = createApplication({ cwd });
  try {
    const answer = await app.call("read_note", { notePath: "notes/policy.md" });
    expect(answer.structured).toMatchObject({
      notePath: "notes/policy.md",
      source: { status: "text", text: source },
      sourceRevision: revisionOf(Buffer.from(source)),
      complete: true,
    });
  } finally {
    app.close();
  }
});

const delimiter = "--- BEGIN EXACT NOTE SOURCE ---\n";

test("read_note keeps BOM, CRLF and Unicode byte exact with metadata in both output formats, without service or writes", async () => {
  const source = "\uFEFF---\r\nstatus: approved\r\n---\r\n# 保存 🦊\r\nUntrusted policy instructions.\r\n";
  const cwd = tempDir({ ".archer/note.md": source });
  const ensureService = vi.fn(() => {
    throw Error("service must not start");
  });
  const findService = vi.fn(() => {
    throw Error("service must not connect");
  });
  const app = createApplication({ cwd, ensureService, findService });
  try {
    const json = await app.call("read_note", { notePath: "note.md" });
    expect(json.structured).toMatchObject({
      schemaVersion: 1,
      source: { status: "text", text: source },
      bytes: Buffer.byteLength(source),
      complete: true,
      frontMatter: { status: "approved" },
      sourceRevision: revisionOf(Buffer.from(source)),
      provenance: { scope: "authoring-folder", currentSource: true },
      inventory: { complete: true, diagnostics: [], diagnosticCount: 0, diagnosticsTruncated: false },
    });
    expect(json.text.length).toBeLessThan(500);
    expect(json.text).not.toContain(source);
    const readable = await app.call("read_note", { notePath: "note.md", outputFormat: "text" });
    const at = readable.text.indexOf(delimiter);
    expect(at).toBeGreaterThan(0);
    expect(readable.text.slice(at + delimiter.length)).toBe(source);
    const header = readable.text.slice(0, at);
    for (const field of ["sourceRevision", "bytes", "complete", "provenance", "inventory", "untrusted"])
      expect(header).toContain(field);
    expect(readFileSync(join(cwd, ".archer/note.md"))).toEqual(Buffer.from(source));
    expect(ensureService).not.toHaveBeenCalled();
    expect(findService).not.toHaveBeenCalled();
  } finally {
    app.close();
  }
});

test("prose edits move the note revision while pinned diagram body revision stays fixed, and bad Mermaid stays readable", async () => {
  const source = "# Policy\nKeep 90 days.\n\n```mermaid\n%% archer-id: policy\nflowchart LR\n  a[Audit]\n```\n";
  const cwd = tempDir({ ".archer/policy.md": source });
  const app = createApplication({ cwd });
  try {
    const before = await app.call("read_note", { notePath: "policy.md" });
    const bodyBefore = await app.call("read_diagram", { viewId: "policy.md#policy" });
    const edited = source.replace("Keep 90 days.", "Keep 180 days.");
    writeFileSync(join(cwd, ".archer/policy.md"), edited);
    const after = await app.call("read_note", { notePath: "policy.md" });
    const bodyAfter = await app.call("read_diagram", { viewId: "policy.md#policy" });
    expect(after.structured.sourceRevision).not.toBe(before.structured.sourceRevision);
    expect(after.structured.sourceRevision).toBe(revisionOf(Buffer.from(edited)));
    expect(bodyAfter.structured.sourceRevision).toBe(bodyBefore.structured.sourceRevision);
    const broken = edited.replace("flowchart LR\n  a[Audit]", "flowchart LR\n  a --> ???");
    writeFileSync(join(cwd, ".archer/policy.md"), broken);
    expect((await app.call("read_note", { notePath: "policy.md" })).structured.source).toEqual({
      status: "text",
      text: broken,
    });
  } finally {
    app.close();
  }
});

test("same-path note reads remain isolated to each application's cwd", async () => {
  const a = createApplication({ cwd: tempDir({ ".archer/policy.md": "A private policy" }) });
  const b = createApplication({ cwd: tempDir({ ".archer/policy.md": "B private policy" }) });
  try {
    expect((await a.call("read_note", { notePath: "policy.md" })).structured.source).toEqual({
      status: "text",
      text: "A private policy",
    });
    expect((await b.call("read_note", { notePath: "policy.md" })).structured.source).toEqual({
      status: "text",
      text: "B private policy",
    });
  } finally {
    a.close();
    b.close();
  }
});

test("explicit text returns every byte of an admitted 1 MiB note", async () => {
  const source = "x".repeat(1024 * 1024);
  const app = createApplication({ cwd: tempDir({ ".archer/large.md": source }) });
  try {
    const answer = await app.call("read_note", { notePath: "large.md", outputFormat: "text" });
    expect(answer.structured.bytes).toBe(1024 * 1024);
    expect(answer.text.slice(answer.text.indexOf(delimiter) + delimiter.length)).toBe(source);
  } finally {
    app.close();
  }
});

test("explicit text reads complete admitted source even when frontmatter has over 10,000 diagram entries", async () => {
  const source = `---\ndiagrams:\n${"  - diagram\n".repeat(10_001)}---\n# Complete source\n`;
  const app = createApplication({ cwd: tempDir({ ".archer/many.md": source }) });
  try {
    const answer = await app.call("read_note", { notePath: "many.md", outputFormat: "text" });
    expect(answer.text.slice(answer.text.indexOf(delimiter) + delimiter.length)).toBe(source);
    expect((answer.structured.frontMatter as { diagrams: string[] }).diagrams).toHaveLength(10_001);
  } finally {
    app.close();
  }
});

test("note text rendering refuses missing source and cyclic projected metadata", async () => {
  const { renderOperation, ReadableOutputError } = await import("../../src/application/render.ts");
  expect(() => renderOperation("read_note", { text: "note", structured: { source: { status: "text" } } })).toThrow(
    ReadableOutputError,
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() =>
    renderOperation("read_note", {
      text: "note",
      structured: { source: { status: "text", text: "# Note" }, inventory: cyclic },
    }),
  ).toThrow(ReadableOutputError);
});
