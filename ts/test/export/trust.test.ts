import { test, expect } from "vitest";
import { exportDiagram, ExportRefusal } from "../../src/export/index.ts";
import type { ExportOptions } from "../../src/export/index.ts";
import { testResources } from "./resources.ts";
test("invalid caller options are a named refusal", async () => {
  await expect(exportDiagram({}, null as unknown as ExportOptions)).rejects.toBeInstanceOf(ExportRefusal);
});
test("bounded input rejects cyclic and deep values before layout", async () => {
  const resources = await testResources();
  const cyclic: {
    self?: unknown;
  } = {};
  cyclic.self = cyclic;
  await expect(exportDiagram(cyclic, { resources })).rejects.toMatchObject({ code: "export_invalid_input" });
  let deep: unknown = {};
  for (let i = 0; i < 50; i++) deep = { nested: deep };
  await expect(exportDiagram(deep, { resources })).rejects.toMatchObject({ code: "export_input_limit" });
});
test("oversized semantic board is refused before PNG allocation", async () => {
  const { compile } = await import("../../src/mermaid/index.ts");
  const source =
    "journey\n" + Array.from({ length: 60 }, (_, i) => `section Stage ${i}\n Task ${i}: 3: Reader\n`).join("");
  const model = (await compile(source)).model;
  expect(model).not.toBeNull();
  const resources = await testResources(),
    envelope = {
      schemaVersion: 2,
      revision: `sha256:${"a".repeat(64)}`,
      view: { id: "test", kind: "journey", title: "Huge board" },
      model,
    };
  for (const format of ["svg", "png"] as const)
    await expect(
      exportDiagram(envelope, { resources: { ...resources, wasmBytes: new Uint8Array([1]) }, format }),
    ).rejects.toMatchObject({ code: "export_extent_limit" });
});
