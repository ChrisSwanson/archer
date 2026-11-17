import { expect, test } from "vitest";
import { editFlowchart, type FlowchartEdit } from "../../src/authoring/flowchart-edit.ts";
import { compile } from "../../src/mermaid/index.ts";
import { NODE_SHAPES } from "../../src/model/graph.ts";
const wrappers = {
  rectangle: ["[", "]"],
  rounded: ["(", ")"],
  stadium: ["([", "])"],
  circle: ["((", "))"],
  diamond: ["{", "}"],
  cylinder: ["[(", ")]"],
  hexagon: ["{{", "}}"],
  subroutine: ["[[", "]]"],
} as const;
for (const shape of NODE_SHAPES)
  for (const label of ["", "Choose 🧭"])
    test(`one add-node creates ${shape} with ${label ? "named" : "blank"} label and preserves exact source`, async () => {
      const source =
        "\ufeffflowchart LR\r\n%% keep comment\r\nsubgraph group [Existing]\r\n  a[API]\r\nend\r\n  b[Store]\r\n  a e1@-->|reads| b";
      const before = (await compile(source)).model;
      expect(before?.type).toBe("freeform-graph");
      const result = await editFlowchart(source, { kind: "add-node", id: "new_node", label, shape } as FlowchartEdit);
      const [open, close] = wrappers[shape],
        expected = source + `\r\n  new_node${open}"${label || " "}"${close}`;
      expect(result).toEqual({ ok: true, source: expected });
      if (!result.ok) throw new Error(result.code);
      const after = (await compile(result.source)).model;
      const order = before && "sourceOrder" in before ? before.sourceOrder : undefined;
      expect(after).toEqual({
        ...before,
        nodes: [...(before && "nodes" in before ? before.nodes : []), { id: "new_node", label, shape }],
        // The source writes the group first, then its node, then b: an appended node comes last.
        sourceOrder: { ...order, elements: [...(order?.elements ?? []), { id: "new_node", kind: "node" }] },
      });
    });
test("omitting add-node shape retains rectangle and malformed shapes refuse without mutation", async () => {
  const source = "flowchart LR\n";
  expect(await editFlowchart(source, { kind: "add-node", id: "a", label: "" })).toEqual({
    ok: true,
    source: source + '  a[" "]\n',
  });
  expect(
    await editFlowchart(source, {
      kind: "add-node",
      id: "a",
      label: "A",
      shape: "__proto__",
    } as unknown as FlowchartEdit),
  ).toEqual({ ok: false, source, code: "edit_invalid_shape" });
});
