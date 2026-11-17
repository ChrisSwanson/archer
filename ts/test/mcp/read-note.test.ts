import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { revisionOf } from "../../src/project/index.ts";
import { call, connect, refusal, removeTempDirs, structured, tempDir, text } from "./support.ts";

afterEach(removeTempDirs);

test("SDK discovery and calls expose read_note with concise JSON text and complete explicit text", async () => {
  const source = "\uFEFF# Retention\r\nKeep audit events for 90 days. 🦊\r\n";
  const ensureService = vi.fn(() => {
    throw Error("must stay offline");
  });
  const { client, close } = await connect({ cwd: tempDir({ ".archer/notes/policy.md": source }), ensureService });
  try {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "read_note");
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["notePath"],
      properties: {
        notePath: { type: "string", minLength: 1, maxLength: 1198 },
        outputFormat: { type: "string", enum: ["text", "json"] },
      },
    });
    const json = await call(client, "read_note", { notePath: "notes/policy.md" });
    expect(structured(json)).toMatchObject({
      notePath: "notes/policy.md",
      sourceRevision: revisionOf(Buffer.from(source)),
      source: { status: "text", text: source },
      complete: true,
    });
    expect(text(json).length).toBeLessThan(500);
    expect(text(json)).not.toContain(source);
    const readable = await call(client, "read_note", { notePath: "notes/policy.md", outputFormat: "text" });
    expect(readable.structuredContent).toBeUndefined();
    const delimiter = "--- BEGIN EXACT NOTE SOURCE ---\n";
    const output = text(readable);
    expect(output.slice(output.indexOf(delimiter) + delimiter.length)).toBe(source);
    expect(output).toContain(revisionOf(Buffer.from(source)));
    expect(ensureService).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

test.each([
  {},
  { notePath: 1 },
  { notePath: null },
  { notePath: [] },
  { notePath: "" },
  { notePath: "a".repeat(1199) },
  { notePath: "policy.md", project: "/other" },
  { notePath: "../policy.md" },
  { notePath: "/policy.md" },
  { notePath: "policy.md#diagram" },
  { notePath: "policy.mmd" },
  { notePath: "policy.md", outputFormat: "yaml" },
])("SDK refuses malformed or scope-widening note arguments %j", async (args) => {
  const { client, close } = await connect({ cwd: tempDir({ ".archer/policy.md": "policy" }) });
  try {
    const error = await refusal(client, "read_note", args);
    expect(error.code).toBe(-32602);
    expect(error.data.code).toBe("invalid_arguments");
  } finally {
    await close();
  }
});

test("SDK missing note refusal preserves the domain code and relative-only detail", async () => {
  const cwd = tempDir({ ".archer/policy.md": "policy" });
  const { client, close } = await connect({ cwd });
  try {
    const error = await refusal(client, "read_note", { notePath: "missing.md" });
    expect(error.code).toBe(-32002);
    expect(error.data.code).toBe("resource_not_found");
    expect(JSON.stringify(error)).not.toContain(cwd);
  } finally {
    await close();
  }
});

test.each([
  { bytes: Buffer.alloc(1024 * 1024 + 1, 120), code: "source_too_large" },
  { bytes: Buffer.from([0xff, 0xfe, 0x61]), code: "invalid_source" },
])("SDK preserves $code refusals without source or absolute paths", async ({ bytes, code }) => {
  const cwd = tempDir({ ".archer/policy.md": "placeholder" });
  writeFileSync(join(cwd, ".archer/policy.md"), bytes);
  const { client, close } = await connect({ cwd });
  try {
    const error = await refusal(client, "read_note", { notePath: "policy.md" });
    expect(error.code).toBe(-32602);
    expect(error.data.code).toBe(code);
    expect(JSON.stringify(error)).not.toContain(cwd);
  } finally {
    await close();
  }
});
