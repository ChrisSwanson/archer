// The painter's input is Archer's wire model as it is; a model it cannot draw
// is refused with a sentence, not a stack trace from the layout engine.
import { describe, expect, test } from "vitest";
import { readGraphInput } from "../../src/terminal/input.ts";
import { MODEL_FILES, loadModel } from "./models.ts";

const base = { type: "freeform-graph", nodes: [], edges: [], groups: [] };

describe("readGraphInput", () => {
  test.each(MODEL_FILES)("accepts the model %s", (_name, path) => {
    const model = loadModel(path);
    expect(model.nodes.length).toBeGreaterThan(0);
  });

  test("keeps the fields the schema defines and accepts its nulls", () => {
    const model = readGraphInput({
      type: "data-flow-graph",
      direction: null,
      nodes: [
        { id: "a", label: "A", shape: null, groupId: null },
        { id: "b", label: "B", shape: "diamond", classes: ["person"], groupId: "g" },
      ],
      edges: [{ id: "e", source: "a", target: "b", label: null, line: "dotted" }],
      groups: [{ id: "g", label: "G", parentId: null }],
    });
    expect(model.direction).toBeUndefined();
    expect(model.nodes[1]).toEqual({ id: "b", label: "B", shape: "diamond", classes: ["person"], groupId: "g" });
    expect(model.edges[0]).toEqual({ id: "e", source: "a", target: "b", line: "dotted" });
  });

  test.each([
    [{ ...base, type: "sequence-trace", participants: [], events: [] }, /sequence diagrams cannot be drawn/],
    [{ ...base, type: "pie" }, /not a graph/],
    [[], /JSON object/],
    [{ ...base, direction: "TB" }, /direction "TB"/],
    [{ ...base, nodes: [{ id: "a", label: "A", shape: "blob" }] }, /shape "blob"/],
    [{ ...base, nodes: [{ id: "a" }] }, /nodes\[0\]\.label must be a string/],
    [
      { ...base, nodes: [{ id: "a", label: "A" }], edges: [{ id: "e", source: "a", target: "z" }] },
      /edge "e" names unknown node "z"/,
    ],
    [{ ...base, nodes: [{ id: "a", label: "A", groupId: "g" }] }, /unknown group "g"/],
    [
      {
        ...base,
        nodes: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
        ],
      },
      /node "a" appears twice/,
    ],
    [
      {
        ...base,
        groups: [
          { id: "g", label: "G", parentId: "h" },
          { id: "h", label: "H", parentId: "g" },
        ],
      },
      /inside itself/,
    ],
    [{ ...base, edges: {} }, /"edges" must be an array/],
  ])("refuses %j", (json, message) => {
    expect(() => readGraphInput(json)).toThrow(message);
  });
});

// Ids are the schema's: letters, digits, `_` and `-`. Anything else is refused
// before it can reach a drawing or an error message.
test("an id outside the schema's pattern is refused", () => {
  const bad = { ...base, nodes: [{ id: "a\u001b]0;x\u0007", label: "A" }] };
  expect(() => readGraphInput(bad)).toThrow(/id/);
});
