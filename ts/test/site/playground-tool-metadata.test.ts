import { expect, it } from "vitest";
import { PLAYGROUND_TOOLS } from "../../../ui/src/playground/tool-metadata.ts";
import { OPERATIONS } from "../../src/application/tools.ts";
import { createHash } from "node:crypto";
import { generatePlaygroundSnapshot } from "../../../site/scripts/playground-snapshot.mts";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { buildOptions } from "../../scripts/bundle.ts";

it("preserves every live tool name, description and schema byte for byte during extraction", () => {
  expect(createHash("sha256").update(JSON.stringify(OPERATIONS)).digest("hex")).toBe(
    "a9b163768bb5c922586dc5aedab789b4389627cc2b7b37a88d48eb219c6b9aea",
  );
});

it("keeps browser-only tool descriptors out of the actual production CLI/MCP bundle graph", async () => {
  const bundle = await build({ ...buildOptions(join(tmpdir(), "archer-tool-boundary")), write: false });
  for (const file of bundle.outputFiles) {
    if (!file.path.endsWith(".js")) continue;
    expect(file.text.includes("Public examples only; changes stay in this browser."), file.path).toBe(false);
    expect(file.text.includes('name: "play_walkthrough"'), file.path).toBe(false);
    expect(file.text.includes("playgroundDescription"), file.path).toBe(false);
  }
}, 30000);

it("records exact note sources including front matter through the production source reader", async () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const snapshot = await generatePlaygroundSnapshot({ repoRoot, examplesRoot: join(repoRoot, "examples") });
  for (const project of snapshot.projects) {
    const notes = project.responses["api/notes/all"] as { notes: { path: string }[] };
    for (const note of notes.notes) {
      const source = project.toolSources?.[`note:${note.path}`];
      expect(source, `${project.slug}/${note.path}`).toBeDefined();
      const bytes = await readFile(join(repoRoot, "examples", project.slug, ".archer", note.path));
      expect(source!.source.text).toBe(bytes.toString("utf8"));
      expect(source!.sourceRevision).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    }
  }
}, 30000);

it("shares the canonical action names and schemas with the live MCP registry", () => {
  const names = [
    "list_projects",
    "list_diagrams",
    "read_diagram",
    "read_note",
    "present_diagram",
    "set_emphasis",
    "list_walkthroughs",
    "create_comment",
  ];
  expect(PLAYGROUND_TOOLS.map((tool) => tool.name)).toEqual(names);
  for (const tool of PLAYGROUND_TOOLS) {
    const canonical = OPERATIONS.find((operation) => operation.name === tool.name)!;
    const expected =
      tool.name === "present_diagram"
        ? {
            ...canonical.inputSchema,
            properties: Object.fromEntries(
              Object.entries(canonical.inputSchema.properties!).filter(
                ([name]) => name !== "expand" && name !== "annotation",
              ),
            ),
          }
        : canonical.inputSchema;
    expect(tool.inputSchema).toEqual(expected);
    expect(tool.description).not.toMatch(/starts the service|attached.*roots|local service/i);
    if (tool.name === "present_diagram") expect(tool.description).not.toMatch(/caption|expand|followUrl/);
  }
});
