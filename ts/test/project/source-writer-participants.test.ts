import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApplication } from "../../src/application/index.ts";
import { findProject } from "../../src/project/project.ts";
import { pinEmbedded, readEmbedded } from "../../src/notes/embedded.ts";
import { blockWriters, FLOW, removeTempDirs, tempDir } from "./support.ts";
afterEach(removeTempDirs);

for (const embedded of [false, true])
  test(`MCP ${embedded ? "embedded" : "standalone"} write participates in source lock`, async () => {
    const body = "```mermaid\n%% archer-id: x\n" + FLOW + "```\n";
    const root = tempDir({ "archer.toml": "version = 1\n", ".archer/a.mmd": FLOW, ".archer/n.md": body });
    const project = findProject(root);
    const app = createApplication({ cwd: root });
    try {
      const viewId = embedded ? "n.md#x" : "a";
      const before = await app.call("read_diagram", { viewId });
      blockWriters(project, embedded ? "n.md" : "a.mmd");
      await expect(
        app.call("write_diagram", {
          viewId,
          expectedRevision: before.structured.sourceRevision,
          source: FLOW.replace("Client", "Changed"),
        }),
      ).rejects.toMatchObject({ data: { code: "source_busy" } });
      expect(readFileSync(join(project.folder, embedded ? "n.md" : "a.mmd"), "utf8")).toBe(embedded ? body : FLOW);
    } finally {
      app.close();
    }
  });
test("implicit-name pinning participates without changing source when locked", async () => {
  const note = "# Flow\n```mermaid\n" + FLOW + "```\n";
  const root = tempDir({ "archer.toml": "version = 1\n", ".archer/n.md": note });
  const project = findProject(root);
  const seen = readEmbedded(project, "n.md#flow")!.sourceRevision;
  blockWriters(project, "n.md");
  expect(pinEmbedded(project, "n.md#flow", seen)).toBe("failed");
  expect(readFileSync(join(project.folder, "n.md"), "utf8")).toBe(note);
});
for (const embedded of [false, true])
  test(`MCP retains invalid-source writes for ${embedded ? "embedded" : "standalone"} diagrams`, async () => {
    const root = tempDir({
      "archer.toml": "version = 1\n",
      ".archer/a.mmd": FLOW,
      ".archer/n.md": "```mermaid\n%% archer-id: x\n" + FLOW + "```\n",
    });
    const app = createApplication({ cwd: root });
    try {
      const viewId = embedded ? "n.md#x" : "a";
      const before = await app.call("read_diagram", { viewId });
      const result = await app.call("write_diagram", {
        viewId,
        expectedRevision: before.structured.sourceRevision,
        source: "not a diagram\n",
      });
      expect(result.structured.status).toBe("failed");
      const content = readFileSync(join(root, ".archer", embedded ? "n.md" : "a.mmd"), "utf8");
      expect(content).toContain("not a diagram\n");
    } finally {
      app.close();
    }
  });
