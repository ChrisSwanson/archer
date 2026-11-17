import { expect, test } from "vitest";
import { editFlowchart } from "../../src/authoring/flowchart-edit.ts";
import { compile } from "../../src/mermaid/index.ts";

test("relabel splices the declaration and preserves exact surrounding source", async () => {
  const before =
    '\uFEFF%% keep emoji 🐦\r\nflowchart LR\r\n  a["Original 🐦"]\r\n  b["Second"]\r\n  a e1@-->|calls| b\r\n';
  const result = await editFlowchart(before, { kind: "relabel-node", id: "a", label: 'New "label" #quot; 🦉' });
  expect(result.ok).toBe(true);
  expect(result.source).toBe(before.replace("Original 🐦", "New #quot;label#quot; #35;quot; 🦉"));
  const compiled = await compile(result.source);
  expect(compiled.model?.type).toBe("freeform-graph");
  if (compiled.model?.type === "freeform-graph") {
    expect(compiled.model.nodes.find((n) => n.id === "a")?.label).toBe('New "label" #quot; 🦉');
    expect(compiled.model.edges).toEqual([{ id: "e1", source: "a", target: "b", label: "calls" }]);
  }
});
