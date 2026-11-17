// The nested view's rules for a walkthrough (ADR 0034 §6, prototype round 3): a step opens the
// containers that hold its parts when following; a container the person closed stays closed for the
// step (the step draws on the box, with a note); a step is the start set plus what steps 1…N need; the full view has nothing to open.
import { describe, expect, it } from "vitest";
import type { ProjectedView } from "../src/diagrams/projection";
import { nestEmphasis } from "../src/nesting/nest-page";
import { nestView } from "../src/nesting/nest-view";
import { closedNote, neededOpen, startOpen, stepOpen } from "../src/walkthroughs/walk-nest";

const full: ProjectedView = {
  viewId: "shop",
  kind: "flowchart",
  title: "Shop",
  revision: "1",
  modelType: "freeform-graph",
  nodes: [
    { id: "cust", label: "Customer", shape: undefined, classes: [], groupId: undefined },
    { id: "web", label: "Web", shape: undefined, classes: [], groupId: "shop" },
    { id: "orders", label: "Orders", shape: undefined, classes: [], groupId: "api" },
    { id: "pay", label: "Payments", shape: undefined, classes: [], groupId: "api" },
  ],
  edges: [
    { id: "e1", source: "cust", target: "web", label: undefined },
    { id: "e2", source: "web", target: "orders", label: undefined },
    { id: "e3", source: "orders", target: "pay", label: undefined },
  ],
  groups: [
    { id: "shop", label: "Shop", parentId: undefined },
    { id: "api", label: "Shop API", parentId: "shop" },
  ],
};

describe("neededOpen", () => {
  it("a part inside a container needs the container and every one around it", () => {
    expect(neededOpen(full, { nodes: ["orders"], edges: [] })).toEqual(["api", "shop"]);
  });

  it("a line needs the containers of both its ends", () => {
    expect(neededOpen(full, { nodes: [], edges: ["e2"] })).toEqual(["api", "shop"]);
    expect(neededOpen(full, { nodes: [], edges: ["e1"] })).toEqual(["shop"]);
  });

  it("a container named by a step is not itself needed open, its parents are", () => {
    expect(neededOpen(full, { nodes: ["api"], edges: [] })).toEqual(["shop"]);
    expect(neededOpen(full, { nodes: ["cust", "shop"], edges: [] })).toEqual([]);
  });
});

describe("stepOpen: a step is a pure function of the step (D2)", () => {
  const needed = [["shop"], ["api", "shop"], [], ["shop"]];
  it("the start set plus what steps 1…N need", () => {
    expect(stepOpen(full, [], needed, 1)).toEqual(["shop"]);
    expect(stepOpen(full, [], needed, 2)).toEqual(["api", "shop"]);
    expect(stepOpen(full, [], needed, 4)).toEqual(["api", "shop"]);
  });

  it("going back gives the first visit's set: nothing a later step opened stays", () => {
    const first = stepOpen(full, [], needed, 1);
    for (const n of [2, 3, 4]) stepOpen(full, [], needed, n);
    expect(stepOpen(full, [], needed, 1)).toEqual(first);
  });

  it("starts from the start set, canonical", () => {
    expect(stepOpen(full, ["api", "shop"], [[]], 1)).toEqual(["api", "shop"]);
    expect(stepOpen(full, ["api"], [[]], 1)).toEqual([]);
  });
});

describe("startOpen", () => {
  it("the recorded open set starts the walkthrough, canonical", () => {
    expect(startOpen(full, ["api", "shop"], [])).toEqual(["api", "shop"]);
    expect(startOpen(full, ["api"], [])).toEqual([]); // not reachable one click at a time without shop
  });

  it("the recorded set wins over the view saved on entry (`?open=` is Explore's)", () => {
    expect(startOpen(full, ["api", "shop"], ["shop"])).toEqual(["api", "shop"]);
  });

  it("with no recorded set, the view saved on entry", () => {
    expect(startOpen(full, [], ["shop"])).toEqual(["shop"]);
    expect(startOpen(full, [], [])).toEqual([]);
  });
});

describe("closedNote", () => {
  it("names the outermost container the step needs that is closed", () => {
    expect(closedNote(full, ["api", "shop"], [])).toEqual({ id: "shop", label: "Shop" });
    expect(closedNote(full, ["api", "shop"], ["shop"])).toEqual({ id: "api", label: "Shop API" });
  });

  it("is null when everything the step needs is open", () => {
    expect(closedNote(full, ["api", "shop"], ["api", "shop"])).toBeNull();
    expect(closedNote(full, [], [])).toBeNull();
  });
});

describe("a step on a container the person closed", () => {
  it("is drawn on the closed box (the emphasis projection)", () => {
    const nested = nestView(full, ["shop"]); // the person closed Shop API
    const emphasis = {
      id: "walkthrough:w",
      viewId: "",
      title: "w",
      legend: false,
      groups: [
        {
          id: "walk-active",
          style: "flow",
          palette: "teal",
          state: "existing",
          speed: "normal",
          label: "Step 2",
          description: "",
          spoken: "step 2, current",
          nodes: ["web", "orders"],
          edges: ["e2"],
        },
      ],
    } as unknown as Parameters<typeof nestEmphasis>[0];
    const drawn = nestEmphasis(emphasis, nested, full)!;
    expect(drawn.groups[0]!.nodes).toEqual(expect.arrayContaining(["web", "group:api"]));
    expect(drawn.groups[0]!.nodes).not.toContain("orders");
  });
});
