// The nested view's page helpers (ADR 0029 §3, §6): the address it reads, and the model ids the
// page keeps translated to what is drawn. Plan T5, T17, T20.
import { describe, expect, it } from "vitest";
import type { ProjectedView } from "../src/diagrams/projection";
import type { Emphasis } from "../src/emphasis/contract";
import { computeLayout } from "../src/layout/elk-adapter";
import {
  drawnIds,
  MAX_OPEN_IDS,
  modelIds,
  nestEmphasis,
  prefetchOrder,
  readNestAddress,
} from "../src/nesting/nest-page";
import { nestView } from "../src/nesting/nest-view";

const full: ProjectedView = {
  viewId: "shop",
  kind: "flowchart",
  title: "Shop",
  revision: "1",
  modelType: "freeform-graph",
  nodes: [
    { id: "web", label: "Web", shape: undefined, classes: [], groupId: undefined },
    { id: "orders", label: "Orders", shape: undefined, classes: [], groupId: "backend" },
    { id: "billing", label: "Billing", shape: undefined, classes: [], groupId: "backend" },
    { id: "mail", label: "Mail", shape: undefined, classes: [], groupId: "ops" },
  ],
  edges: [
    { id: "e1", source: "web", target: "orders", label: undefined },
    { id: "e2", source: "web", target: "billing", label: undefined },
    { id: "e3", source: "orders", target: "billing", label: undefined },
  ],
  groups: [
    { id: "backend", label: "Backend", parentId: undefined },
    { id: "ops", label: "Ops", parentId: undefined },
  ],
};

describe("readNestAddress", () => {
  it.each([
    ["", { open: [] }],
    ["?zoom=full", { zoom: "full", open: [] }],
    ["?zoom=nested&open=a,b", { zoom: "nested", open: ["a", "b"] }],
    ["?zoom=sideways&open=a,a,,b", { open: ["a", "b"] }],
    ["?open=ok,bad%20id,%3Cx%3E,also-ok_1", { open: ["ok", "also-ok_1"] }],
  ])("%s", (search, expected) => {
    expect(readNestAddress(search)).toEqual(expected);
  });

  it(`reads at most ${MAX_OPEN_IDS} ids`, () => {
    const ids = Array.from({ length: 100 }, (_, i) => `g${i}`);
    expect(readNestAddress(`?open=${ids.join(",")}`).open).toHaveLength(MAX_OPEN_IDS);
  });
});

describe("model ids ↔ drawn ids", () => {
  const nested = nestView(full, []);

  it("a hidden node is drawn as its box; a bundled edge as the bundle", () => {
    expect(drawnIds(nested, full, { nodeIds: ["orders", "web"], edgeIds: ["e1", "e2"] })).toEqual({
      nodeIds: ["group:backend", "web"],
      edgeIds: ["bundle:group:backend~web"],
    });
  });

  it("a bundle clicked selects its member edges", () => {
    expect(modelIds(nested, "edge", "bundle:group:backend~web")).toEqual({ nodeIds: [], edgeIds: ["e1", "e2"] });
  });

  it("emphasis moves to what stands for it, and an edge hidden inside a box colours the box", () => {
    const emphasis = {
      id: "x",
      viewId: "shop",
      title: "t",
      groups: [
        {
          id: "g1",
          style: "highlight",
          palette: "teal",
          state: "current",
          speed: null,
          label: "a",
          description: "",
          nodes: ["web"],
          edges: ["e1"],
        },
        {
          id: "g2",
          style: "highlight",
          palette: "violet",
          state: "current",
          speed: null,
          label: "b",
          description: "",
          nodes: [],
          edges: ["e3"],
        },
      ],
    } as unknown as Emphasis;
    const drawn = nestEmphasis(emphasis, nested, full)!;
    expect(drawn.groups.map((g) => [g.nodes, g.edges])).toEqual([
      [["web"], ["bundle:group:backend~web"]],
      [["group:backend"], []],
    ]);
  });
});

describe("prefetchOrder", () => {
  it("the hinted box first, then emphasised ones, then nearest the centre", async () => {
    const layout = await computeLayout(nestView(full, []).view);
    const backend = layout.nodes.find((n) => n.id === "group:backend")!;
    const ops = layout.nodes.find((n) => n.id === "group:ops")!;
    const nearOps = { x: ops.x + ops.width / 2, y: ops.y + ops.height / 2 };
    expect(prefetchOrder(layout, { centre: nearOps })).toEqual(["ops", "backend"]);
    expect(prefetchOrder(layout, { centre: nearOps, emphasised: new Set([backend.id]) })).toEqual(["backend", "ops"]);
    expect(prefetchOrder(layout, { centre: nearOps, emphasised: new Set([backend.id]), hinted: "ops" })).toEqual([
      "ops",
      "backend",
    ]);
  });
});
