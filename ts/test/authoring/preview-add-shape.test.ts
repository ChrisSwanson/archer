import { expect, test } from "vitest";
import { parseAuthoringPreview, previewAuthoring } from "../../src/authoring/preview.ts";
import { AuthoringInputError } from "../../../shared/authoring-contract.mts";
import { NODE_SHAPES } from "../../src/model/graph.ts";
const source = "\ufeffflowchart LR\r\n  a[API]\r\n";
test("preview accepts optional add-node shapes and one request compiles a blank diamond", async () => {
  for (const shape of NODE_SHAPES) {
    const edit = { kind: "add-node", id: "new_node", label: "", shape };
    expect(parseAuthoringPreview({ source, edit }, true).edit).toEqual(edit);
  }
  const result = (await previewAuthoring(
    { source, edit: { kind: "add-node", id: "new_node", label: "", shape: "diamond" } },
    true,
  )) as any;
  expect(result).toMatchObject({
    ok: true,
    source: source + '  new_node{" "}\r\n',
    diagnostics: [],
    envelope: {
      model: {
        nodes: [
          { id: "a", label: "API" },
          { id: "new_node", label: "", shape: "diamond" },
        ],
      },
    },
  });
});
test("add-node shape remains a strict enum and is not accepted on relabel operations", () => {
  for (const shape of [null, 1, {}, "square", "__proto__"])
    expect(() =>
      parseAuthoringPreview({ source, edit: { kind: "add-node", id: "a", label: "", shape } }, true),
    ).toThrow(AuthoringInputError);
  expect(() =>
    parseAuthoringPreview({ source, edit: { kind: "relabel-node", id: "a", label: "A", shape: "diamond" } }, true),
  ).toThrow(AuthoringInputError);
});
test("all label-bearing edits reject every C0 control but the line break with a clear refusal; blank, emoji and a line break remain valid", () => {
  const edits = [
    { kind: "add-node", id: "new_node", shape: "diamond" },
    { kind: "relabel-node", id: "a" },
    { kind: "connect", id: "e1", source: "a", target: "a" },
    { kind: "relabel-edge", id: "e1" },
  ];
  for (const edit of edits) {
    for (let code = 0; code < 32; code++)
      if (code !== 10)
        expect(() =>
          parseAuthoringPreview(
            { source, edit: { ...edit, label: "before" + String.fromCharCode(code) + "after" } },
            true,
          ),
        ).toThrow(/label.*control characters/iu);
    for (const label of ["", "API 🧭", "one\ntwo"])
      expect(parseAuthoringPreview({ source, edit: { ...edit, label } }, true).edit).toEqual({ ...edit, label });
  }
});
