// The nested view's projection (ADR 0029, docs/proposals/ws-b-boundary-zoom.md §3):
// closed containers become boxes with their own id, edges are re-pointed to the
// nearest drawn end, and re-pointed edges that land on one pair become a bundle.
// Every model here comes from the real compiler, never a hand-made shape.

import { describe, expect, test } from "vitest";
import { compile } from "../../ts/src/mermaid/index";
import { envelopeFor, loadModelEnvelope } from "./fixtures";
import { projectGraph } from "./support/draw-envelope";
import type { ProjectedView } from "../src/diagrams/projection";
import { elementNodes } from "../src/diagrams/projection";
import { canonicalOpen, defaultOpen, nestView } from "../src/nesting/nest-view";

async function viewOf(source: string): Promise<ProjectedView> {
  const result = await compile(source);
  if (result.model === undefined || result.model === null) {
    throw new Error(`did not compile: ${result.diagnostics.map((d) => d.message).join("; ")}`);
  }
  return projectGraph(envelopeFor(result.model as unknown as { type: string } & Record<string, unknown>, "test"));
}

const fixture = (type: string, name: string): ProjectedView => projectGraph(loadModelEnvelope(type, name));

const ids = (items: readonly { readonly id: string }[]): string[] => items.map((item) => item.id).sort();
const edge = (view: ProjectedView, id: string) => view.edges.find((e) => e.id === id);

describe("C4 model, one level at a time (c4/nested)", () => {
  const full = fixture("c4", "nested");

  test("nothing open: the system boundary is one box saying what is inside", () => {
    const nested = nestView(full, []);
    expect(ids(nested.view.nodes)).toEqual(["customer", "payments", "shop"]);
    expect(nested.view.groups).toEqual([]);
    const shop = nested.view.nodes.find((n) => n.id === "shop")!;
    expect(shop.label).toBe("Web shop");
    expect(shop.figure).toMatchObject({ type: "c4", kind: "system", description: "3 containers inside" });
    expect(nested.closed.get("shop")).toMatchObject({ drawnId: "shop", inside: "3 containers inside", count: 3 });
    // Two relationships cross the boundary, one each way: re-pointed, keeping id and label.
    expect(ids(nested.view.edges)).toEqual(["checkout--payments", "customer--web"]);
    expect(edge(nested.view, "customer--web")).toMatchObject({
      source: "customer",
      target: "shop",
      label: "Shops with",
    });
    expect(edge(nested.view, "checkout--payments")).toMatchObject({ source: "shop", target: "payments" });
    // The rest are inside the box, listed, never lost.
    expect(ids(nested.closed.get("shop")!.hidden)).toEqual([
      "checkout--catalog",
      "checkout--orders",
      "web--catalog",
      "web--checkout",
    ]);
  });

  test("shop open: its containers show, the API is a box, and two relationships into it are one bundle", () => {
    const nested = nestView(full, ["shop"]);
    expect(ids(nested.view.nodes)).toEqual(["api", "customer", "orders", "payments", "web"]);
    expect(ids(nested.view.groups)).toEqual(["shop"]);
    expect(nested.view.nodes.find((n) => n.id === "api")!.figure).toMatchObject({
      type: "c4",
      kind: "container",
      description: "2 components inside",
    });
    expect(nested.view.nodes.find((n) => n.id === "api")!.groupId).toBe("shop");
    expect(edge(nested.view, "customer--web")).toEqual(edge(full, "customer--web"));
    const bundle = nested.bundles.get("bundle:api~web")!;
    expect(bundle).toMatchObject({ source: "web", target: "api" });
    expect(ids(bundle.members)).toEqual(["web--catalog", "web--checkout"]);
    expect(edge(nested.view, "bundle:api~web")).toMatchObject({ source: "web", target: "api", label: "2 connections" });
    expect(edge(nested.view, "checkout--orders")).toMatchObject({
      source: "api",
      target: "orders",
      label: "Writes orders",
    });
    expect(ids(nested.closed.get("api")!.hidden)).toEqual(["checkout--catalog"]);
  });

  test("everything open is exactly the full view", () => {
    expect(nestView(full, ["shop", "api"]).view).toEqual(full);
  });

  test("maps run both ways, keyed by kind", () => {
    const nested = nestView(full, ["shop"]);
    expect(nested.drawnOf({ kind: "edge", id: "web--checkout" })).toEqual({ kind: "edge", id: "bundle:api~web" });
    expect(nested.drawnOf({ kind: "edge", id: "checkout--catalog" })).toEqual({ kind: "node", id: "api" });
    expect(nested.drawnOf({ kind: "node", id: "checkout" })).toEqual({ kind: "node", id: "api" });
    expect(nested.drawnOf({ kind: "group", id: "shop" })).toEqual({ kind: "node", id: "shop" });
    expect(nested.modelOf({ kind: "edge", id: "bundle:api~web" })).toEqual([
      { kind: "edge", id: "web--catalog" },
      { kind: "edge", id: "web--checkout" },
    ]);
    expect(nested.modelOf({ kind: "node", id: "api" })).toEqual([{ kind: "group", id: "api" }]);
    expect(nested.reveal({ kind: "node", id: "checkout" })).toEqual(["api", "shop"]);
    expect(nested.reveal({ kind: "edge", id: "customer--web" })).toEqual(["shop"]);
  });

  test("the open set is canonical: unknown and unreachable ids drop, order is sorted", () => {
    expect(canonicalOpen(full, ["api"])).toEqual([]);
    expect(canonicalOpen(full, ["api", "nope", "shop", "shop"])).toEqual(["api", "shop"]);
    expect(nestView(full, ["api"]).open).toEqual([]);
  });

  test("a closed element boundary is selectable as itself", () => {
    expect(ids(elementNodes(nestView(full, []).view))).toEqual(["customer", "payments", "shop"]);
  });
});

describe("edges", () => {
  test("a genuine self-loop and parallel edges stay as written when nothing is lifted", async () => {
    const view = await viewOf(
      "stateDiagram-v2\n  state Idle\n  state Busy\n  Idle --> Idle : tick\n  Idle --> Busy : go\n  Busy --> Idle : done\n",
    );
    expect(nestView(view, []).view).toEqual(view);
  });

  test("opposite directions share one bundle with an arrowhead at each end", async () => {
    const view = await viewOf(
      [
        "flowchart LR",
        "  subgraph left[Left]",
        "    a[A]",
        "    b[B]",
        "  end",
        "  c[C]",
        "  a ac@--> c",
        "  c cb@--> b",
        "",
      ].join("\n"),
    );
    const nested = nestView(view, []);
    const drawn = nested.view.edges;
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatchObject({ id: "bundle:c~group:left", label: "2 connections", bidirectional: true });
  });

  test("only re-pointed edges bundle: an untouched edge to another end stays as written", async () => {
    const view = await viewOf(
      [
        "flowchart LR",
        "  x[X]",
        "  subgraph g[G]",
        "    y[Y]",
        "    z[Z]",
        "  end",
        "  w[W]",
        "  x xy@--> y",
        "  x xz@--> z",
        "  x xw@--> w",
        "",
      ].join("\n"),
    );
    // Only re-pointed edges bundle; x→w is untouched and stays as it is.
    const nested = nestView(view, []);
    expect(ids(nested.view.edges)).toEqual(["bundle:group:g~x", "xw"]);
    expect(edge(nested.view, "xw")).toEqual(edge(view, "xw"));
  });

  test("a bundle is dotted only when every member is", async () => {
    const source = (second: string) =>
      [
        "flowchart LR",
        "  subgraph g[G]",
        "    a[A]",
        "    b[B]",
        "  end",
        "  c[C]",
        "  c ca@-.-> a",
        `  c cb@${second} b`,
        "",
      ].join("\n");
    expect(edge(nestView(await viewOf(source("-.->")), []).view, "bundle:c~group:g")?.line).toBe("dotted");
    expect(edge(nestView(await viewOf(source("-->")), []).view, "bundle:c~group:g")?.line ?? "solid").toBe("solid");
  });

  test("a transition to a composite keeps its end when the composite is closed; one from inside goes into the box", () => {
    const view = fixture("state", "widened");
    const nested = nestView(view, []);
    const working = nested.view.nodes.find((n) => n.id === "Working")!;
    expect(working.figure).toMatchObject({ type: "state", kind: "state" });
    expect(edge(nested.view, "Route--Working")).toEqual(edge(view, "Route--Working"));
    expect(edge(nested.view, "Working--Split")).toEqual(edge(view, "Working--Split"));
    // Fetch, Run and the composite's own start and end are inside; only the two real states are counted.
    expect(nested.closed.get("Working")).toMatchObject({ inside: "2 states inside", count: 2 });
    expect(nested.view.nodes.some((n) => n.id === "Fetch" || n.id === "Working_start")).toBe(false);
  });
});

test("a closed composite keeps its note", async () => {
  const view = await viewOf(
    [
      "stateDiagram-v2",
      "    Idle : Waiting",
      "    state Working {",
      "        state Fetch",
      "        [*] --> Fetch",
      "    }",
      "    Idle --> Working",
      "    note right of Working : one job at a time",
      "",
    ].join("\n"),
  );
  expect(nestView(view, []).view.nodes.find((n) => n.id === "Working")!.figure).toEqual({
    type: "state",
    kind: "state",
    note: { position: "right-of", text: "one job at a time" },
  });
});

describe("flowchart subgraphs", () => {
  test("a closed subgraph is drawn under its frame id, apart from a node of the same id, and is not selectable", () => {
    const view = fixture("flowchart", "groups");
    const nested = nestView(view, []);
    expect(ids(nested.view.nodes)).toEqual(["group:api", "group:backend"]);
    expect(nested.view.nodes.find((n) => n.id === "group:api")).toMatchObject({
      label: "Shares its ID with a node",
      groupId: undefined,
    });
    // The node `api` is placed in `backend`; the subgraph `api` is another thing.
    expect(nested.drawnOf({ kind: "node", id: "api" })).toEqual({ kind: "node", id: "group:backend" });
    expect(nested.drawnOf({ kind: "group", id: "api" })).toEqual({ kind: "node", id: "group:api" });
    expect(nested.drawnOf({ kind: "node", id: "click" })).toEqual({ kind: "node", id: "group:api" });
    expect(nested.modelOf({ kind: "node", id: "group:api" })).toEqual([{ kind: "group", id: "api" }]);
    expect(elementNodes(nested.view)).toEqual([]);
    expect(nestView(view, ["backend"]).view.nodes.find((n) => n.id === "api")).toMatchObject({ groupId: "backend" });
  });
});

describe("architecture groups", () => {
  test("nothing open: the cloud is one box; its junction is not counted", () => {
    const nested = nestView(fixture("architecture", "widened"), []);
    expect(ids(nested.view.nodes)).toEqual(["client", "cloud"]);
    expect(nested.closed.get("cloud")).toMatchObject({ inside: "3 elements inside", count: 3 });
    expect(nested.view.edges).toHaveLength(1);
    expect(nested.view.edges[0]).toMatchObject({ id: "client--gateway", source: "client", target: "cloud" });
    expect(nested.view.edges[0]!.figure).toMatchObject({
      type: "ports",
      sourceSide: "right",
      targetSide: "left",
      sourceArrow: false,
      targetArrow: true,
    });
  });

  test("a moved end loses its {group} flag; a bundle keeps every member's arrowheads", () => {
    const nested = nestView(fixture("architecture", "widened"), ["cloud"]);
    // data is closed: hub → files lands on the data box as itself.
    expect(edge(nested.view, "hub--files")).toMatchObject({ source: "hub", target: "data" });
    // app{group} <--> db{group} and the undirected app -[audit]- files both land on app/data.
    const bundle = nested.bundles.get("bundle:app~data")!;
    expect(ids(bundle.members)).toEqual(["app--db", "app--files"]);
    expect(edge(nested.view, "bundle:app~data")!.figure).toMatchObject({
      type: "ports",
      sourceArrow: true,
      targetArrow: true,
      sourceGroup: false,
      targetGroup: false,
    });
  });

  test("a single re-pointed edge clears the {group} flag on the end that moved and keeps the other", async () => {
    const view = await viewOf(
      [
        "architecture-beta",
        "    group outer(cloud)[Outer]",
        "    group inner(server)[Inner] in outer",
        "    service a(server)[A] in outer",
        "    service b(server)[B] in inner",
        "    service c(server)[C] in inner",
        "    a{group}:B --> T:b{group}",
        "    b:R --> L:c",
        "",
      ].join("\n"),
    );
    expect(edge(view, "a--b")!.figure).toMatchObject({ sourceGroup: true, targetGroup: true });
    const drawn = edge(nestView(view, ["outer"]).view, "a--b")!;
    expect(drawn).toMatchObject({ source: "a", target: "inner" });
    expect(drawn.figure).toEqual({ ...edge(view, "a--b")!.figure, targetGroup: false });
  });

  test("an undirected edge gains no arrowhead when it is re-pointed", async () => {
    const view = await viewOf(
      [
        "architecture-beta",
        "    group g(cloud)[G]",
        "    service a(server)[A] in g",
        "    service b(server)[B]",
        "    a:R -- L:b",
        "",
      ].join("\n"),
    );
    const drawn = nestView(view, []).view.edges[0]!;
    expect(drawn).toMatchObject({ source: "g", target: "b" });
    expect(drawn.figure).toMatchObject({ sourceArrow: false, targetArrow: false });
  });
});

describe("the default open set", () => {
  test("is empty, except that a lone top-level container opens", async () => {
    expect(defaultOpen(fixture("c4", "nested"))).toEqual([]);
    const lone = await viewOf(
      [
        "C4Component",
        '    Container_Boundary(worker, "Worker") {',
        '        Component(a, "A")',
        '        Component(b, "B")',
        "    }",
        '    Rel(a, b, "Calls")',
        "",
      ].join("\n"),
    );
    expect(defaultOpen(lone)).toEqual(["worker"]);
  });
});
