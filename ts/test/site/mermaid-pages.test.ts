import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mermaidPages } from "../../../site/scripts/mermaid-pages.mts";
import { compile } from "../../src/mermaid/index.ts";

const source = readFileSync(resolve(import.meta.dirname, "../../docs/supported-mermaid.md"), "utf8");
const families = ["flowchart", "sequence", "state", "er", "c4", "architecture", "journey"];

describe("Mermaid reference pages", () => {
  it("provides an overview, all seven families, and shared rules", () => {
    const pages = mermaidPages(source);
    expect(Object.keys(pages).sort()).toEqual(
      [
        "supported-mermaid/index.md",
        ...[...families, "rules"].map((family) => `supported-mermaid/${family}.md`),
      ].sort(),
    );
    for (const family of families) {
      expect(pages["supported-mermaid/index.md"]).toContain(`](/supported-mermaid/${family})`);
      expect(pages[`supported-mermaid/${family}.md`]).toContain("```mermaid");
    }
  });

  it("keeps every contract paragraph and example in the published pages", () => {
    const published = Object.values(mermaidPages(source)).join("\n\n");
    for (const paragraph of source.split(/\n\s*\n/)) {
      if (!paragraph.trim() || /^#{1,6} /m.test(paragraph)) continue;
      expect(published, paragraph).toContain(paragraph);
    }
    for (const page of Object.values(mermaidPages(source))) {
      expect(page.match(/^# /gm)).toHaveLength(1);
    }
  });

  it("fails loudly when a new contract section has no destination", () => {
    expect(() => mermaidPages(`${source}\n# Supported Mermaid new family profile\n\nNew syntax.\n`)).toThrow(
      /Unknown Mermaid profile section/,
    );
  });

  it("publishes examples that compile through Archer", async () => {
    const examples = Object.values(mermaidPages(source)).flatMap((page) =>
      [...page.matchAll(/^```mermaid\r?\n([\s\S]*?)^```/gm)].map((match) => match[1]!),
    );
    expect(examples.length).toBeGreaterThan(20);
    for (const example of examples) {
      const result = await compile(example);
      expect(
        result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
        example,
      ).toEqual([]);
      expect(result.model, example).not.toBeNull();
    }
  });
});
