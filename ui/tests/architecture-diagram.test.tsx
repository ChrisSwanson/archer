// @vitest-environment jsdom
//
// An `architecture-beta` diagram on the graph canvas: services with their
// icons, groups as frames that are elements, junctions as points, and every
// edge leaving and entering by the side the source declares, with an
// arrowhead at whichever ends it names.
//
// The envelope is the TypeScript compiler's output for the golden source
// `ts/test/fixtures/architecture/widened.mmd`.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinsOn } from "./support/pins";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { App } from "../src/app/App";
import { elementNodes } from "../src/diagrams/projection";
import { parseEmphasis } from "../src/emphasis/contract";
import type { LayoutResult } from "../src/layout/elk-adapter";
import { MockEventSource, mountAgentPresented, restoreLocation, selectionPosts, settle } from "./app-harness";
import { loadModelEnvelope } from "./fixtures";
import { drawGraph, edgeElement, nodeElement, projectGraph } from "./support/draw-envelope";
import { installReducedMotion } from "./match-media";

const ARCH = loadModelEnvelope("architecture", "widened");

beforeEach(() => {
  installReducedMotion(false);
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

/** Which side of `box` the point is on, or "inside". */
function sideOf(box: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }): string {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
  if (near(point.x, box.x)) return "left";
  if (near(point.x, box.x + box.width)) return "right";
  if (near(point.y, box.y)) return "top";
  if (near(point.y, box.y + box.height)) return "bottom";
  return "inside";
}

function boxOf(layout: LayoutResult, id: string) {
  return layout.nodes.find((node) => node.id === id) ?? layout.groups.find((group) => group.id === id)!;
}

describe("an architecture model projects onto the graph canvas", () => {
  it("makes services and junctions nodes and groups frames, all of them selectable elements", () => {
    const view = projectGraph(ARCH);
    expect(view.notation).toBe("architecture");
    expect(view.heading).toBe("Shop platform");
    expect(view.groups.map((group) => [group.id, group.parentId, group.figure])).toEqual([
      ["cloud", undefined, { type: "zone", icon: "cloud" }],
      ["data", "cloud", { type: "zone", icon: "database" }],
    ]);
    expect(view.nodes.find((node) => node.id === "hub")?.figure).toEqual({ type: "junction" });
    expect(view.nodes.find((node) => node.id === "client")?.figure).toEqual({ type: "service" });
    const ids = ["cloud", "data", "gateway", "app", "db", "files", "client", "hub"].sort();
    expect(
      elementNodes(view)
        .map((node) => node.id)
        .sort(),
    ).toEqual(ids);
  });
});

describe("services, groups and edges are drawn as declared", () => {
  it("draws each service's icon, and a group's icon in its caption", async () => {
    const { container } = await drawGraph(ARCH);
    expect(nodeElement(container, "gateway").querySelector(".archer-arch-icon-internet")).not.toBeNull();
    expect(nodeElement(container, "db").querySelector(".archer-arch-icon-database")).not.toBeNull();
    expect(nodeElement(container, "client").querySelector(".archer-arch-icon")).toBeNull();
    expect(
      nodeElement(container, "data").querySelector(".archer-frame-caption .archer-arch-icon-database"),
    ).not.toBeNull();
    expect(nodeElement(container, "hub").classList.contains("archer-figure-junction")).toBe(true);
    expect(nodeElement(container, "gateway").getAttribute("aria-label")).toBe("Gateway, internet service, in Cloud");
    expect(nodeElement(container, "hub").getAttribute("aria-label")).toBe("hub, junction, in Cloud");
  });

  it("leaves and enters every edge by the sides the source declares", async () => {
    const { layout } = await drawGraph(ARCH);
    const edges = ARCH.model.edges as {
      id: string;
      source: string;
      target: string;
      sourceSide: string;
      targetSide: string;
      sourceGroup?: boolean;
      targetGroup?: boolean;
    }[];
    for (const edge of edges.filter((e) => e.sourceGroup !== true && e.targetGroup !== true)) {
      const routed = layout.edges.find((e) => e.id === edge.id)!;
      expect(sideOf(boxOf(layout, edge.source), routed.points[0]), `${edge.id} leaves ${edge.source}`).toBe(
        edge.sourceSide,
      );
      expect(
        sideOf(boxOf(layout, edge.target), routed.points[routed.points.length - 1]),
        `${edge.id} enters ${edge.target}`,
      ).toBe(edge.targetSide);
    }
  });

  it("ends an edge that names a group on that group's frame", async () => {
    const { layout } = await drawGraph(ARCH);
    const routed = layout.edges.find((e) => e.id === "app--db")!;
    expect(sideOf(boxOf(layout, "data"), routed.points[routed.points.length - 1])).toBe("top");
  });

  it("draws arrowheads only at the ends the source names", async () => {
    const { container } = await drawGraph(ARCH);
    const path = (id: string) => edgeElement(container, id).querySelector(".react-flow__edge-path")!;
    expect([
      path("app--db").getAttribute("marker-start") !== null,
      path("app--db").getAttribute("marker-end") !== null,
    ]).toEqual([true, true]);
    expect([
      path("client--gateway").getAttribute("marker-start") !== null,
      path("client--gateway").getAttribute("marker-end") !== null,
    ]).toEqual([false, true]);
    expect([
      path("gateway--hub").getAttribute("marker-start") !== null,
      path("gateway--hub").getAttribute("marker-end") !== null,
    ]).toEqual([false, false]);
  });

  it("takes selection, emphasis and comments on services, groups, junctions and edges", async () => {
    const emphasis = parseEmphasis({
      id: "e",
      viewId: ARCH.view.id,
      title: "Writes",
      groups: [{ id: "g", style: "flow", palette: "coral", nodes: ["data", "hub"], edges: ["hub--files"] }],
    });
    const { container } = await drawGraph(ARCH, {
      emphasis,
      selection: { nodeIds: ["cloud", "client"], edgeIds: [] },
      commented: pinsOn({ nodes: ["gateway"], edges: ["app--files"] }),
    });
    expect(nodeElement(container, "data").classList.contains("archer-emph")).toBe(true);
    expect(nodeElement(container, "hub").classList.contains("archer-emph")).toBe(true);
    expect(edgeElement(container, "hub--files").classList.contains("archer-emph")).toBe(true);
    expect(nodeElement(container, "cloud").classList.contains("selected")).toBe(true);
    expect(nodeElement(container, "client").classList.contains("selected")).toBe(true);
    // A non-member of a shown highlight steps back (owner, 2026-11-12); its pins stay in it, at full strength.
    expect(nodeElement(container, "gateway").querySelector(".archer-pin")?.textContent).toBe("1");
  });
});

describe("an architecture selection reaches the agent", () => {
  it("publishes a junction and a group by their ids", async () => {
    const { container } = await mountAgentPresented(<App />, {
      envelope: ARCH,
      views: [{ id: ARCH.view.id, kind: "architecture", title: "Platform", registration: "durable" }],
      ready: (mounted) => expect(mounted.querySelectorAll(".react-flow__edge").length).toBe(6),
    });
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    fireEvent.click(nodeElement(container, "hub"));
    fireEvent.click(nodeElement(container, "data"), { shiftKey: true });
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node.selected")).toHaveLength(2));
    await settle();
    const posts = selectionPosts();
    const [, init] = posts[posts.length - 1] as [string, { body: string }];
    expect((JSON.parse(init.body) as { nodes: unknown[] }).nodes).toEqual([
      { id: "hub", label: "hub" },
      { id: "data", label: "Data tier" },
    ]);
  });
});
