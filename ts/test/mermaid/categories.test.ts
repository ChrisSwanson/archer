// An authored classDef category reaches the model with what it declares to draw (ADR 0009, amended
// 2026-11-11): its fill and stroke as opaque hex, a dash, and the groups that wear it. The page picks
// the palette family; the compiler only says what was written, and says so when it cannot read it.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { checkAgainst } from "./support/schema.ts";

const F = (body: string): string => `flowchart TB\n${body}\n`;

describe("classDef categories", () => {
  test("a used category carries its fill, stroke and dash, in declaration order", async () => {
    const result = await compile(
      F(
        [
          "  a[A]:::sandbox",
          "  b[B]:::gpu",
          "  a e1@--> b",
          "  classDef gpu fill:#ECFDF5,stroke:#0f766e",
          "  classDef sandbox fill:#fdf1e7,stroke:#c2410c,stroke-dasharray: 5 3",
        ].join("\n"),
      ),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({
      categories: [
        { name: "gpu", fill: "#ecfdf5", stroke: "#0f766e" },
        { name: "sandbox", fill: "#fdf1e7", stroke: "#c2410c", dashed: true },
      ],
    });
    expect(checkAgainst("DiagramModel", result.model)).toEqual([]);
  });

  test("short and alpha hex read as opaque #rrggbb; a transparent one declares no colour", async () => {
    const result = await compile(F("  a[A]:::warm\n  classDef warm fill:#F96,stroke:#00000000"));
    expect(result.model).toMatchObject({ categories: [{ name: "warm", fill: "#ff9966" }] });
    expect((result.model as { categories: object[] }).categories[0]).not.toHaveProperty("stroke");
  });

  test("a colour Archer cannot read is said, and the category is still named", async () => {
    const result = await compile(F("  a[A]:::warm\n  classDef warm fill:orange"));
    expect(result.diagnostics.map((d) => d.code)).toEqual(["category_colour_unread"]);
    expect(result.diagnostics[0]?.severity).toBe("info");
    expect(result.model).toMatchObject({ categories: [{ name: "warm" }] });
  });

  test("a zero dash is no dash; kinds and unused classDefs are not categories", async () => {
    const result = await compile(
      F(
        "  a[A]:::flat\n  b[B]:::person\n  a e1@--> b\n  classDef flat stroke-dasharray: 0\n  classDef spare fill:#fff",
      ),
    );
    expect(result.model).toMatchObject({ categories: [{ name: "flat" }] });
  });

  test("a diagram with no category has no categories field, as before", async () => {
    const result = await compile(F("  a[A]:::person\n  b[B]\n  a e1@--> b"));
    expect(result.model).not.toHaveProperty("categories");
    expect(result.model?.type === "freeform-graph" && result.model.groups).toEqual([]);
  });

  test("a subgraph takes a class with `class id name`, as a node does", async () => {
    const result = await compile(
      F(
        [
          '  subgraph gpu1["GPU 1"]',
          "    m[Model]",
          "    n[Other]",
          "  end",
          "  m e1@--> n",
          "  class gpu1 gpu",
          "  classDef gpu fill:#ecfdf5,stroke:#0f766e",
        ].join("\n"),
      ),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({
      groups: [{ id: "gpu1", label: "GPU 1", classes: ["gpu"] }],
      categories: [{ name: "gpu", fill: "#ecfdf5", stroke: "#0f766e" }],
    });
    expect(checkAgainst("DiagramModel", result.model)).toEqual([]);
  });

  test("a subgraph takes one class, and an unknown one is the usual warning", async () => {
    const two = await compile(
      F('  subgraph g["G"]\n    a[A]\n    b[B]\n  end\n  a e1@--> b\n  class g person\n  class g system'),
    );
    expect(two.model).toBeNull();
    expect(two.diagnostics.map((d) => d.code)).toContain("unsupported_construct");
    const unknown = await compile(F('  subgraph g["G"]\n    a[A]\n    b[B]\n  end\n  a e1@--> b\n  class g mystery'));
    expect(unknown.diagnostics.map((d) => d.code)).toEqual(["unknown_class"]);
  });
});
