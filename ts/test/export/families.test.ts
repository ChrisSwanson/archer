import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compile } from "../../src/mermaid/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { addressable } from "../../src/service/emphasis.ts";
import { exportDiagram } from "../../src/export/index.ts";
import { testResources } from "./resources.ts";
// Cold Mermaid compilation + WASM rendering exceeded 5s under concurrent compilers
// (5214ms and 5243ms measured). Keep real assertions with a bounded 20s deadline.
const families = [
  ["flowchart", "freeform"],
  ["state", "state"],
  ["er", "entity-relationship"],
  ["c4", "c4"],
  ["architecture", "architecture"],
  ["sequence", "sequence"],
  ["journey", "journey"],
] as const;
for (const [family, kind] of families)
  for (const mode of ["diagram", "presentation"] as const)
    test(`${family} ${mode}: standalone SVG and actual PNG preserve compiled elements`, async () => {
      const source = await readFile(resolve(import.meta.dirname, `../fixtures/${family}/widened.mmd`), "utf8"),
        compiled = await compile(source);
      expect(compiled.model, JSON.stringify(compiled.diagnostics)).not.toBeNull();
      const envelope = {
          schemaVersion: 2,
          revision: revisionOf(new TextEncoder().encode(source)),
          view: { id: "export", title: "Export fixture", kind },
          model: compiled.model!,
        },
        resources = await testResources();
      const svg = await exportDiagram(envelope, { resources, mode }),
        text = new TextDecoder().decode(svg.bytes);
      for (const id of addressable(compiled.model!).nodes) expect(text).toContain(`data-element-id="${id}"`);
      expect(text).not.toMatch(/foreignObject|<script|onload=|(?:href|src)=["']https?:|url\(https?:/);
      expect(text).toContain("data:font/woff2;base64,");
      const png = await exportDiagram(envelope, { format: "png", resources, mode });
      expect([...png.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const header = Buffer.from(png.bytes);
      expect(header.readUInt32BE(16)).toBe(png.width);
      expect(header.readUInt32BE(20)).toBe(png.height);
      expect(png.bytes.length).toBeGreaterThan(500);
      expect(png.revision).toBe(svg.revision);
    }, 20_000);
