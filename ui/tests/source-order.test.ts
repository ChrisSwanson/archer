// The order a flowchart's source writes things in (`sourceOrder`, ADR 0009 amended 2026-11-12) reaches the page
// from the envelope to the layout's input and result, for the layout's model order and the Key's rows. A model
// without it is in that order already: every node, then every group, each by id; edges by id.
import { describe, expect, it } from "vitest";
import { writtenOrder } from "../src/diagrams/source-order";
import { computeLayout } from "../src/layout/elk-adapter";
import { HOME_RIG, SHIP_LOOP, viewOf } from "./fixtures/palette/home-rig";

describe("the source's order on the page", () => {
  it("arrives on the projected view, the layout's input, as written", async () => {
    const view = await viewOf(SHIP_LOOP);
    expect(view.sourceOrder?.elements.slice(0, 3)).toEqual([
      { id: "ask", kind: "node" },
      { id: "plan", kind: "node" },
      { id: "poke", kind: "node" },
    ]);
    expect(view.sourceOrder?.edges.slice(0, 2)).toEqual(["ask_plan", "plan_poke"]);
  });

  it("is carried through to the layout result", async () => {
    const view = await viewOf(HOME_RIG);
    const layout = await computeLayout(view);
    expect(layout.sourceOrder).toEqual(view.sourceOrder);
    // A group is placed where its subgraph is written: the home server comes right after the front door.
    expect(view.sourceOrder?.elements.slice(3, 5)).toEqual([
      { id: "server", kind: "group" },
      { id: "farm", kind: "group" },
    ]);
  });

  it("reads as the lists' own order where the model leaves it out", async () => {
    const view = await viewOf(
      "flowchart LR\n  a[A] e1@--> b[B]\n  b e2@--> c[C]\n  d[D]\n  subgraph g[G]\n    c\n    d\n  end\n",
    );
    expect(view.sourceOrder).toBeUndefined();
    expect(writtenOrder(view)).toEqual({
      elements: [
        { id: "a", kind: "node" },
        { id: "b", kind: "node" },
        { id: "c", kind: "node" },
        { id: "d", kind: "node" },
        { id: "g", kind: "group" },
      ],
      edges: ["e1", "e2"],
    });
  });
});
