// A walkthrough step as the page draws it (ADR 0034 §4): two emphasis groups built on the page
// (the current step, flowing; the steps walked, quiet) plus a focus over both. Pure.
import { describe, expect, it } from "vitest";
import { assignEmphasis, emphasisMembership } from "../src/emphasis/contract";
import type { Walk, WalkStep } from "../src/walkthroughs/contract";
import { routeOf, stepFor, walkRender } from "../src/walkthroughs/walk-render";

const step = (title: string, over: Partial<WalkStep> = {}): WalkStep => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  kind: "sends",
  what: "w",
  code: [],
  nodes: [],
  edges: [],
  messages: [],
  status: "current",
  ...over,
});
const edge = (id: string): WalkStep["edges"][number] => ({
  id,
  source: id.split("--")[0]!,
  target: id.split("--")[1]!,
});
const node = (id: string, kind: "node" | "group" = "node"): WalkStep["nodes"][number] => ({ kind, id, label: id });
const walk = (steps: WalkStep[]): Walk => ({
  id: "w",
  title: "W",
  modelRevision: "r",
  open: [],
  steps,
  status: "current",
  outOfDate: [],
});
const model = (nodes: string[], edges: string[]) => ({ nodes: new Set(nodes), edges: new Set(edges) });

const THREE = walk([
  step("one", { edges: [edge("a--b")] }),
  step("two", { edges: [edge("b--c")], nodes: [node("c")] }),
  step("three", { edges: [edge("c--d")] }),
]);
const ALL = model(["a", "b", "c", "d"], ["a--b", "b--c", "c--d"]);
const groups = (w: Walk, at: number, m = ALL) =>
  Object.fromEntries((walkRender(w, at, m).emphasis?.groups ?? []).map((g) => [g.id, g]));

describe("walkRender", () => {
  it("draws the current step as a teal flow and every earlier step as a quiet highlight", () => {
    const g = groups(THREE, 3);
    expect(g["walk-active"]).toMatchObject({ style: "flow", palette: "teal", edges: ["c--d"], nodes: ["c", "d"] });
    expect(g["walk-walked"]).toMatchObject({ style: "highlight", edges: ["a--b", "b--c"], nodes: ["a", "b", "c"] });
  });

  it("step 1 has nothing walked, so only one group", () => {
    expect(Object.keys(groups(THREE, 1))).toEqual(["walk-active"]);
  });

  it("walked and active together are the focus, so everything else fades", () => {
    expect(walkRender(THREE, 2, ALL).focus).toEqual({ nodeIds: ["c", "b", "a"], edgeIds: ["b--c", "a--b"] });
    expect(walkRender(THREE, 3, ALL).focus.edgeIds.sort()).toEqual(["a--b", "b--c", "c--d"]);
    expect(walkRender(THREE, 3, ALL).focus.nodeIds.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("draws a line with the boxes at its ends, when the model has them", () => {
    const only = walk([step("one", { edges: [edge("a--b")] })]);
    expect(groups(only, 1)["walk-active"]!.nodes).toEqual(["a", "b"]);
    expect(groups(only, 1, model(["a"], ["a--b"]))["walk-active"]!.nodes).toEqual(["a"]);
  });

  it("an element in both is drawn as the current step's", () => {
    const again = walk([step("one", { edges: [edge("a--b")] }), step("two", { edges: [edge("a--b")] })]);
    const assignments = assignEmphasis(walkRender(again, 2, ALL).emphasis);
    expect(assignments.edges.get("a--b")?.style).toBe("flow");
  });

  it("out-of-date steps contribute nothing, walked or current", () => {
    const stale = walk([
      step("one", { edges: [edge("a--b")], status: "out-of-date" }),
      step("two", { edges: [edge("b--c")] }),
      step("three", { edges: [edge("c--d")], status: "out-of-date" }),
    ]);
    expect(walkRender(stale, 2, ALL).emphasis?.groups.map((g) => g.id)).toEqual(["walk-active"]);
    expect(walkRender(stale, 3, ALL).emphasis?.groups.flatMap((g) => g.edges)).toEqual(["b--c"]);
    expect(walkRender(stale, 3, ALL).focus.edgeIds).toEqual(["b--c"]);
    expect(walkRender(walk([stale.steps[0]!]), 1, ALL)).toMatchObject({
      emphasis: null,
      focus: { nodeIds: [], edgeIds: [] },
    });
  });

  it("never names an id the model no longer has", () => {
    const gone = walk([step("one", { edges: [edge("a--b"), edge("x--y")], nodes: [node("ghost")] })]);
    const r = walkRender(gone, 1, ALL);
    expect(r.emphasis?.groups.flatMap((g) => [...g.nodes, ...g.edges])).toEqual(["a", "b", "a--b"]);
    expect(r.focus).toEqual({ nodeIds: ["a", "b"], edgeIds: ["a--b"] });
  });

  it("an archived walkthrough draws nothing", () => {
    expect(walkRender({ ...THREE, status: "archived" }, 2, ALL)).toMatchObject({
      emphasis: null,
      focus: { nodeIds: [], edgeIds: [] },
    });
  });

  it("names a group as a node id, like any element", () => {
    const g = walk([step("one", { nodes: [node("box", "group")] })]);
    expect(groups(g, 1, model(["box"], []))["walk-active"]!.nodes).toEqual(["box"]);
  });

  it("has no legend of its own (the panel is the key), and one stable id so a step does not reset the reader's view", () => {
    const a = walkRender(THREE, 1, ALL).emphasis!;
    const b = walkRender(THREE, 2, ALL).emphasis!;
    expect([a.legend, a.id === b.id]).toEqual([false, true]);
  });
});

describe("what a screen reader and the stylesheet get", () => {
  const assignments = assignEmphasis(walkRender(THREE, 3, ALL).emphasis);
  it("the current step's elements end their names with 'step N, current'", () => {
    expect(emphasisMembership(assignments.edges.get("c--d"))).toBe(", step 3, current");
  });
  it("walked elements end theirs with 'walked' and carry the walked class", () => {
    expect(emphasisMembership(assignments.edges.get("a--b"))).toBe(", walked");
    expect(assignments.edges.get("a--b")!.classes).toContain("archer-emph--walked");
    expect(assignments.edges.get("c--d")!.classes).not.toContain("archer-emph--walked");
  });
  it("an agent's emphasis is still named 'in highlight N'", () => {
    expect(emphasisMembership({ slot: 2, label: "Money" })).toBe(", in highlight 2: Money");
  });
});

describe("stepFor: a clicked element jumps to its step", () => {
  it("stays on the current step when it names the element, else the first step that does", () => {
    expect(stepFor(THREE, "node", "c", 3)).toBe(3);
    expect(stepFor(THREE, "node", "c", 1)).toBe(2);
    expect(stepFor(THREE, "node", "a", 3)).toBe(1);
    expect(stepFor(THREE, "edge", "b--c", 2)).toBe(2);
    expect(
      stepFor(walk([step("a", { edges: [edge("a--b")] }), step("b", { edges: [edge("a--b")] })]), "edge", "a--b", 2),
    ).toBe(2);
    expect(stepFor(THREE, "edge", "nothing", 2)).toBeNull();
  });
  it("skips out-of-date steps", () => {
    const w = walk([step("a", { edges: [edge("a--b")], status: "out-of-date" }), step("b", { edges: [edge("a--b")] })]);
    expect(stepFor(w, "edge", "a--b", 2)).toBe(2);
    expect(stepFor(w, "edge", "a--b", 1)).toBe(2);
  });
});

describe("routeOf: from → to in the reader's words", () => {
  const labels = (id: string) => ({ a: "Customer", b: "Storefront", c: "Shop API" })[id] ?? id;
  it("names the ends of the messages, and a chain once", () => {
    expect(routeOf(step("s", { messages: [{ from: "a", to: "b", label: "x" }] }), labels)).toBe(
      "Customer → Storefront",
    );
    expect(
      routeOf(
        step("s", {
          messages: [
            { from: "a", to: "b", label: "x" },
            { from: "b", to: "c", label: "y" },
          ],
        }),
        labels,
      ),
    ).toBe("Customer → Storefront → Shop API");
  });
  it("falls back to the lines' ends, then to the boxes", () => {
    expect(routeOf(step("s", { edges: [{ id: "a--b", source: "a", target: "b" }] }), labels)).toBe(
      "Customer → Storefront",
    );
    expect(routeOf(step("s", { nodes: [node("a"), node("c")] }), labels)).toBe("Customer, Shop API");
  });
});
