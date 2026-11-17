// A category's meaning in the author's words (`%% archer-key <classDef name>: <meaning>`), the same
// directive that says what a line pattern means. The Key and the drawing's legend call the category by it;
// without one they keep the class name as written. Archer never supplies a meaning.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { checkAgainst } from "./support/schema.ts";

const RIG = (...keys: string[]): string =>
  [
    "flowchart TB",
    ...keys.map((key) => `  ${key}`),
    "  farm[Farm model server]:::gpu",
    "  vm[Staging VM]:::sandbox",
    "  vm e1@--> farm",
    "  classDef gpu fill:#ecfdf5,stroke:#0f766e",
    "  classDef sandbox fill:#fdf1e7,stroke:#c2410c,stroke-dasharray: 5 3",
    "",
  ].join("\n");

const codes = async (source: string) =>
  (await compile(source)).diagnostics.map((d) => [d.code, d.severity, d.span.start.line]);

describe("a category's meaning", () => {
  test("`%% archer-key gpu: …` gives the gpu category its meaning, and the model stays valid", async () => {
    const result = await compile(RIG("%% archer-key gpu: Model server on a GPU"));
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({
      categories: [{ name: "gpu", meaning: "Model server on a GPU" }, { name: "sandbox" }],
    });
    expect((result.model as { categories: object[] }).categories[1]).not.toHaveProperty("meaning");
    expect(checkAgainst("DiagramModel", result.model)).toEqual([]);
  });

  test("a category key sits beside a line key, and neither takes the other's place", async () => {
    const source = RIG("%% archer-key sandbox: Walled-off sandbox", "%% archer-key dashed: Model calls")
      .replace("vm e1@--> farm", "vm e1@--> farm\n  class e1 dashed")
      .replace("classDef gpu", "classDef dashed stroke-dasharray: 6 4\n  classDef gpu");
    const result = await compile(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({
      lineKey: [{ pattern: "dashed", meaning: "Model calls" }],
      categories: [{ name: "gpu" }, { name: "sandbox", meaning: "Walled-off sandbox" }],
    });
  });

  test("the meaning is kept exactly as written: never re-cased or reworded", async () => {
    const result = await compile(RIG("%% archer-key gpu:   the AI's work  "));
    expect(result.model).toMatchObject({
      categories: [{ name: "gpu", meaning: "the AI's work" }, { name: "sandbox" }],
    });
  });

  test("a category's meaning may take five words (a line's takes four): the owner's legend says so", async () => {
    const result = await compile(RIG("%% archer-key gpu: Model server on a GPU"));
    expect(result.diagnostics).toEqual([]);
  });

  test.each([
    ["a meaning of six words", "%% archer-key gpu: one two three four five six", "category_meaning_text"],
    ["a meaning over 32 characters", `%% archer-key gpu: ${"x".repeat(33)}`, "category_meaning_text"],
    ["an empty meaning", "%% archer-key gpu:", "category_meaning_text"],
  ])("refuses %s, as a line's meaning is refused", async (_name, key, code) => {
    expect(await codes(RIG(key))).toEqual([[code, "error", 2]]);
  });

  test("a second key for the same category is refused, naming the first", async () => {
    const result = await compile(RIG("%% archer-key gpu: Model server", "%% archer-key gpu: GPU box"));
    expect(result.diagnostics.map((d) => [d.code, d.severity, d.span.start.line])).toEqual([
      ["category_key_repeated", "error", 3],
    ]);
    expect(result.diagnostics[0]?.message).toContain("line 2");
  });

  test("a key for a class the diagram does not declare is refused, with the nearest name", async () => {
    const result = await compile(RIG("%% archer-key gpus: Model server"));
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([["key_target_unknown", "error"]]);
    expect(result.diagnostics[0]?.message).toContain("did you mean 'gpu'");
    expect(result.model).toBeNull();
  });

  test("a category is named exactly as written: `GPU` is not `gpu`", async () => {
    const result = await compile(RIG("%% archer-key GPU: Model server"));
    expect(result.diagnostics.map((d) => d.code)).toEqual(["key_target_unknown"]);
    expect(result.diagnostics[0]?.message).toContain("did you mean 'gpu'");
  });

  test("a built-in kind keeps its own word: a key for it is refused", async () => {
    const source = RIG("%% archer-key person: You").replace("farm[Farm model server]:::gpu", "farm[Farm]:::person");
    const result = await compile(source);
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([["category_key_kind", "error"]]);
    expect(result.diagnostics[0]?.message).toContain("person");
  });

  test("a key for a declared class nothing wears is a warning, and the diagram still compiles", async () => {
    const source = RIG("%% archer-key spare: Not drawn").replace(
      "classDef gpu",
      "classDef spare fill:#ffffff\n  classDef gpu",
    );
    const result = await compile(source);
    expect(result.diagnostics.map((d) => [d.code, d.severity, d.span.start.line])).toEqual([
      ["category_key_unused", "warning", 2],
    ]);
    expect(result.model).not.toBeNull();
    expect((result.model as { categories: { name: string }[] }).categories.map((c) => c.name)).toEqual([
      "gpu",
      "sandbox",
    ]);
  });

  test("a group's category takes its meaning too", async () => {
    const source = [
      "flowchart TB",
      "  %% archer-key gpu: Model server on a GPU",
      "  subgraph g1[GPU 1]",
      "    farm[Farm model server]",
      "    chat[Chat model server]",
      "  end",
      "  you[You] e1@--> farm",
      "  you e2@--> chat",
      "  classDef gpu fill:#ecfdf5,stroke:#0f766e",
      "  class g1 gpu",
      "",
    ].join("\n");
    const result = await compile(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({ categories: [{ name: "gpu", meaning: "Model server on a GPU" }] });
  });

  test("outside a flowchart a name that is not a line pattern is still an unknown pattern", async () => {
    const { diagnostics } = await compile(
      'C4Context\n  %% archer-key gpu: Model server\n  Person(a, "A")\n  System(b, "B")\n  Rel(a, b, "Uses")\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["line_pattern_unknown"]);
  });
});
