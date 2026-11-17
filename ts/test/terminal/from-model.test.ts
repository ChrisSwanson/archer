// State and ER diagrams draw in the terminal through the graph painter: the
// compiled model is mapped to graph input, which must be input the painter
// accepts (readGraphInput), and the drawing names every state, entity and
// cardinality.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import type { EntityRelationship, StateMachine } from "../../src/model/index.ts";
import { drawGraph } from "../../src/terminal/draw.ts";
import { graphInputOf } from "../../src/terminal/from-model.ts";
import { readGraphInput } from "../../src/terminal/input.ts";

const fixture = async (path: string) => {
  const { model } = await compile(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8"));
  if (model === null) throw new Error(`${path} does not compile`);
  return model;
};

describe("a state machine", () => {
  test("maps to graph input the painter accepts, composites as frames", async () => {
    const model = (await fixture("state/widened.mmd")) as StateMachine;
    const graph = graphInputOf(model);
    expect(readGraphInput(JSON.parse(JSON.stringify(graph)))).toEqual(graph);
    expect(graph.direction).toBe("lr");
    expect(graph.groups).toEqual([{ id: "Working-composite", label: "Working" }]);
    // The composite is a node too, inside its own frame, because transitions name it.
    expect(graph.nodes.find((n) => n.id === "Working")).toMatchObject({ groupId: "Working-composite" });
    expect(graph.nodes.find((n) => n.id === "Fetch")).toMatchObject({ groupId: "Working-composite" });
    expect(graph.nodes.find((n) => n.id === "root_start")).toMatchObject({ shape: "circle" });
    expect(graph.nodes.find((n) => n.id === "Route")).toMatchObject({ shape: "diamond" });
    expect(graph.edges).toHaveLength(model.transitions.length);
  });

  test("a composite no transition names is a frame only", async () => {
    const model = (await compile("stateDiagram-v2\n  state C {\n    a : A\n  }\n")).model as StateMachine;
    const graph = graphInputOf(model);
    expect(graph.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  test("draws every state", async () => {
    const text = await drawGraph(graphInputOf((await fixture("state/minimal.mmd")) as StateMachine), { width: 80 });
    for (const word of ["Idle", "Busy", "start", "end"]) expect(text).toContain(word);
  });
});

describe("an ER diagram", () => {
  test("maps entities to nodes and relationships to edges labelled with their cardinalities", async () => {
    const model = (await fixture("er/widened.mmd")) as EntityRelationship;
    const graph = graphInputOf(model);
    expect(readGraphInput(JSON.parse(JSON.stringify(graph)))).toEqual(graph);
    expect(graph.nodes.map((n) => n.label)).toEqual(["Customer", "ORDER", "Order line", "PRODUCT"]);
    expect(graph.edges[0]).toEqual({
      id: "CUSTOMER--ORDER",
      source: "CUSTOMER",
      target: "ORDER",
      label: "1 places 0..*",
    });
    expect(graph.edges[2]).toMatchObject({ label: "0..* refers 1", line: "dotted" });
    expect(graph.edges[3]).toMatchObject({ label: "0..1 0..*", line: "dotted" });
  });

  test("draws every entity", async () => {
    const text = await drawGraph(graphInputOf((await fixture("er/minimal.mmd")) as EntityRelationship), { width: 80 });
    for (const word of ["CUSTOMER", "ORDER", "places"]) expect(text).toContain(word);
  });
});
