// Every fenced mermaid example in the supported-Mermaid reference parses in
// the pinned `mermaid` and compiles in Archer.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { parseDb } from "../support/mermaid.ts";

const DOC = resolve(import.meta.dirname, "../../docs/supported-mermaid.md");

function examples(markdown: string): { line: number; source: string }[] {
  const found: { line: number; source: string }[] = [];
  const fence = /^```mermaid\n([\s\S]*?)^```$/gm;
  for (let m = fence.exec(markdown); m !== null; m = fence.exec(markdown)) {
    found.push({ line: markdown.slice(0, m.index).split("\n").length, source: m[1] ?? "" });
  }
  return found;
}

const blocks = examples(readFileSync(DOC, "utf8"));

test("the reference has examples for both diagram types", () => {
  expect(blocks.length).toBeGreaterThanOrEqual(10);
  expect(blocks.some((b) => b.source.startsWith("flowchart"))).toBe(true);
  expect(blocks.some((b) => b.source.startsWith("sequenceDiagram"))).toBe(true);
});

test("the reference has examples for every diagram type", () => {
  for (const header of [
    "stateDiagram-v2",
    "erDiagram",
    "C4Context",
    "C4Container",
    "C4Component",
    "architecture-beta",
    "journey",
  ])
    expect(
      blocks.some((b) => b.source.startsWith(header)),
      header,
    ).toBe(true);
});

describe.each(blocks)("the example at line $line", ({ source }) => {
  test("parses in Mermaid", async () => {
    await expect(parseDb(source)).resolves.toBeDefined();
  });

  test("compiles in Archer with no error", async () => {
    const { model, diagnostics } = await compile(source);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(model).not.toBeNull();
  });
});

describe("the Entity codes section", () => {
  const markdown = readFileSync(DOC, "utf8");
  const section = markdown.slice(
    markdown.indexOf("\n# Entity codes\n"),
    markdown.indexOf("\n# Migrating from Archer 0.3\n"),
  );
  const rows = [...section.matchAll(/^\| `(#\w+;)` \| .* \| U\+([0-9A-F]{4,6}) \|$/gm)];

  test("has its table of codes", () => {
    expect(section.length).toBeGreaterThan(0);
    expect(rows.map((row) => row[1])).toEqual(
      expect.arrayContaining(["#quot;", "#amp;", "#lt;", "#gt;", "#nbsp;", "#35;", "#59;"]),
    );
  });

  test.each(rows.map((row) => [row[1] ?? "", row[2] ?? ""]))("%s is U+%s in a compiled label", async (code, point) => {
    const { model, diagnostics } = await compile(`flowchart LR\n  a["x ${code} y"]\n`);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(model).toMatchObject({ nodes: [{ label: `x ${String.fromCodePoint(Number.parseInt(point, 16))} y` }] });
  });

  test("its example compiles to the labels it names", async () => {
    const example = blocks.find((block) => block.source.includes("say #quot;hi#quot; to R#amp;D"));
    const { model } = await compile(example?.source ?? "");
    expect(model).toMatchObject({ nodes: [{ label: 'say "hi" to R&D #1' }, { label: "5 < 6; café" }] });
    expect(section).toContain('`say "hi" to R&D #1` and `5 < 6; café`');
  });
});
