import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

test("the skill's complete note works at its advertised addresses without a manifest", async () => {
  const reference = readFileSync(
    new URL("../../plugin/skills/archer/references/authoring.md", import.meta.url),
    "utf8",
  );
  const note = /````markdown\n([\s\S]*?)\n````/.exec(reference)?.[1];
  expect(note, "a complete copyable note, not a schema sketch").toBeDefined();
  const cwd = tempDir({ ".archer/notes/worker.md": note! });
  const app = createApplication({ cwd });
  try {
    const components = await app.call("read_diagram", { viewId: "notes/worker.md#components" });
    expect(components.structured).toMatchObject({
      compile: { status: "compiled", diagnostics: [] },
      envelope: {
        model: {
          type: "c4-model",
          level: "component",
          elements: [
            { id: "reader", label: "Reader", boundaryId: "worker" },
            { id: "indexer", label: "Indexer", boundaryId: "worker" },
          ],
          boundaries: [{ id: "worker", kind: "container" }],
        },
      },
    });
    const flow = await app.call("read_diagram", { viewId: "notes/worker.md#data-flow" });
    expect(flow.structured).toMatchObject({ compile: { status: "compiled", diagnostics: [] } });
    expect(existsSync(join(cwd, "archer.toml"))).toBe(false);
  } finally {
    app.close();
  }
});
