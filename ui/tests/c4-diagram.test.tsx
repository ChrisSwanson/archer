// @vitest-environment jsdom
//
// A native C4 diagram (`C4Container` and friends) on the graph canvas: each
// element with its kind, its external flag, its database or queue shape, and
// its technology and description lines; boundaries as frames that are
// elements themselves; relationships with their technology on the wire and
// an arrowhead at both ends for `BiRel`.
//
// The envelope is the TypeScript compiler's output for the golden source
// `ts/test/fixtures/c4/widened.mmd`.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { MockEventSource, mountAgentPresented, restoreLocation, selectionPosts, settle } from "./app-harness";
import { loadModelEnvelope } from "./fixtures";
import { drawGraph, edgeElement, nodeElement, projectGraph } from "./support/draw-envelope";
import { installReducedMotion } from "./match-media";
import { captionParts, edgeLabelBox } from "../src/layout/graph-metrics";

const C4 = loadModelEnvelope("c4", "widened");

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

describe("a C4 model projects onto the graph canvas", () => {
  it("makes elements nodes and boundaries frames, all of them selectable elements", () => {
    const view = projectGraph(C4);
    expect(view.notation).toBe("c4");
    expect(view.heading).toBe("Web shop containers · C4 container diagram");
    expect(view.groups.map((group) => [group.id, group.parentId, group.element, group.figure])).toEqual([
      ["company", undefined, true, { type: "boundary", kind: "enterprise" }],
      ["ops", "company", true, { type: "boundary", kind: "generic" }],
      ["shop", "company", true, { type: "boundary", kind: "system" }],
    ]);
    expect(view.nodes.find((node) => node.id === "events")?.figure).toEqual({
      type: "c4",
      kind: "container",
      external: false,
      shape: "queue",
      technology: "Kafka",
      description: "Order events",
    });
    expect(view.nodes.find((node) => node.id === "orders")?.shape).toBe("cylinder");
    const ids = [...(C4.model.elements as { id: string }[]), ...(C4.model.boundaries as { id: string }[])]
      .map((e) => e.id)
      .sort();
    expect(
      elementNodes(view)
        .map((node) => node.id)
        .sort(),
    ).toEqual(ids);
  });

  it("writes a relationship's technology on its wire, and keeps its label the model's", () => {
    const view = projectGraph(C4);
    const orders = view.edges.find((edge) => edge.id === "customer--web")!;
    expect(orders.label).toBe("Orders from");
    // The technology is drawn inline under the label (ADR 0030, amended 2026-10-31).
    expect(captionParts(orders.caption!)).toEqual({ label: "Orders from", technology: "HTTPS" });
    expect(captionParts(view.edges.find((edge) => edge.id === "web--orders")!.caption!)).toEqual({
      label: "Reads and writes",
      technology: "SQL",
      description: "every request",
    });
    expect(view.edges.find((edge) => edge.id === "web--events")?.caption).toBe("Publishes");
    expect(view.edges.find((edge) => edge.id === "web--payments")?.figure).toEqual({ type: "c4", bidirectional: true });
  });
});

describe("C4 elements are drawn with their kind, shape and lines", () => {
  it("draws the type line and the description, and the person glyph on a person", async () => {
    const { container } = await drawGraph(C4);
    const web = nodeElement(container, "web");
    expect(web.querySelector(".archer-c4-label")?.textContent).toBe("Web app");
    expect(web.querySelector(".archer-c4-type")?.textContent).toBe("[Container: TypeScript]");
    expect(web.querySelector(".archer-c4-description")?.textContent).toBe("Serves the pages");
    expect(nodeElement(container, "customer").querySelector(".archer-c4-person-glyph")).not.toBeNull();
    expect(nodeElement(container, "crm").querySelector(".archer-c4-type")?.textContent).toBe("[External Container]");
    expect(nodeElement(container, "ledger").querySelector(".archer-c4-type")?.textContent).toBe(
      "[External System database]",
    );
  });

  it("gives each kind, shape and the external flag a class of its own", async () => {
    const { container } = await drawGraph(C4);
    expect(nodeElement(container, "orders").classList.contains("archer-shape-cylinder")).toBe(true);
    expect(nodeElement(container, "events").classList.contains("archer-c4-shape-queue")).toBe(true);
    expect(nodeElement(container, "payments").classList.contains("archer-c4-external")).toBe(true);
    expect(nodeElement(container, "web").classList.contains("archer-c4-external")).toBe(false);
    expect(nodeElement(container, "customer").classList.contains("archer-c4-person")).toBe(true);
  });

  it("draws database lids independently of the element kind", async () => {
    const { container } = await drawGraph(C4);
    for (const id of ["orders", "ledger"]) {
      const node = nodeElement(container, id);
      expect(node.querySelector(".archer-c4-database-cap ellipse")).not.toBeNull();
      expect(node.querySelector(".archer-c4-database-cap")?.getAttribute("aria-hidden")).toBe("true");
      expect(node.querySelector(".archer-c4-queue-cap")).toBeNull();
    }
  });

  it("draws a queue with a horizontal cylinder end cap", async () => {
    const { container } = await drawGraph(C4);
    const events = nodeElement(container, "events");
    const cap = events.querySelector(".archer-c4-queue-cap");
    expect(cap, "a full elliptical end closes the horizontal cylinder").not.toBeNull();
    expect(cap?.querySelector("ellipse")).not.toBeNull();
    expect(cap?.getAttribute("aria-hidden")).toBe("true");
    expect(events.querySelector(".archer-c4-queue-slots")).toBeNull();
    expect(events.querySelector(".archer-c4-type")?.textContent).toBe("[Container queue: Kafka]");
    expect(events.querySelector(".archer-c4-description")?.textContent).toBe("Order events");
    expect(nodeElement(container, "orders").querySelector(".archer-c4-queue-cap")).toBeNull();
  });

  it("names an element and a boundary for a screen reader", async () => {
    const { container } = await drawGraph(C4);
    expect(nodeElement(container, "web").getAttribute("aria-label")).toBe(
      "Web app, container, TypeScript, Serves the pages, in Web shop",
    );
    expect(nodeElement(container, "courier").getAttribute("aria-label")).toBe("Courier, external person");
    expect(nodeElement(container, "shop").getAttribute("aria-label")).toBe("Web shop, system boundary, in Shop Ltd");
    expect(nodeElement(container, "shop").querySelector(".archer-frame-kind")?.textContent).toBe("[System]");
  });

  it("draws BiRel with an arrowhead at each end, and Rel with one", async () => {
    const { container } = await drawGraph(C4);
    const both = edgeElement(container, "web--payments").querySelector(".react-flow__edge-path")!;
    expect(both.getAttribute("marker-start")).not.toBeNull();
    expect(both.getAttribute("marker-end")).not.toBeNull();
    const one = edgeElement(container, "web--events").querySelector(".react-flow__edge-path")!;
    expect(one.getAttribute("marker-start")).toBeNull();
    expect(one.getAttribute("marker-end")).not.toBeNull();
  });

  it("draws a relationship's technology and description inline under its label, and says them in its name", async () => {
    const { container } = await drawGraph(C4);
    // No ⓘ control and no popover: the detail is on the plate.
    expect(container.querySelector("[data-edge-more], .archer-edge-label-more, .archer-edge-label-detail")).toBeNull();
    expect(container.textContent).not.toContain("ⓘ");
    const plate = container.querySelector<HTMLElement>('.archer-edge-label[data-edge-id="web--orders"]')!;
    const rows = [...plate.children].map((row) => [row.className, row.textContent]);
    expect(rows).toEqual([
      // One row at the 24-character wrap (ADR 0030, amended 2026-11-12; two rows at 14).
      ["archer-edge-label-row", "Reads and writes"],
      ["archer-edge-label-technology", "[SQL]"],
      ["archer-edge-label-description", "every request"],
    ]);
    // A relationship with no technology or description keeps the plain caption.
    expect(
      container.querySelector('.archer-edge-label[data-edge-id="web--events"] .archer-edge-label-technology'),
    ).toBeNull();
    const name = edgeElement(container, "web--orders").getAttribute("aria-label")!;
    expect(name).toContain("Reads and writes");
    expect(name).toContain("SQL");
    expect(name).toContain("every request");
    expect(name).not.toContain("\u001f");
  });

  it("draws the diagram's title and level over the canvas", async () => {
    const { container } = await drawGraph(C4);
    expect(container.querySelector(".archer-canvas-heading")?.textContent).toBe(
      "Web shop containers · C4 container diagram",
    );
  });

  it("takes selection, emphasis and comments on elements, boundaries and relationships", async () => {
    const emphasis = parseEmphasis({
      id: "e",
      viewId: C4.view.id,
      title: "Ordering",
      groups: [{ id: "g", style: "highlight", palette: "violet", nodes: ["shop", "web"], edges: ["web--orders"] }],
    });
    const { container } = await drawGraph(C4, {
      emphasis,
      selection: { nodeIds: ["company"], edgeIds: [] },
      commented: { nodeIds: new Set(["ops"]), edgeIds: new Set(), groupIds: new Set() },
    });
    expect(nodeElement(container, "shop").classList.contains("archer-emph")).toBe(true);
    expect(nodeElement(container, "web").classList.contains("archer-emph")).toBe(true);
    expect(edgeElement(container, "web--orders").classList.contains("archer-emph")).toBe(true);
    expect(nodeElement(container, "company").classList.contains("selected")).toBe(true);
    expect(nodeElement(container, "ops").classList.contains("archer-commented")).toBe(true);
  });
});

describe("a C4 selection reaches the agent", () => {
  it("publishes a clicked element and a Shift-clicked boundary", async () => {
    const { container } = await mountAgentPresented(<App />, {
      envelope: C4,
      views: [{ id: C4.view.id, kind: "c4", title: "Shop", registration: "durable" }],
      ready: (mounted) => expect(mounted.querySelectorAll(".react-flow__edge").length).toBe(7),
    });
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    fireEvent.click(screen.getByText("Web app"));
    fireEvent.click(nodeElement(container, "shop"), { shiftKey: true });
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node.selected")).toHaveLength(2));
    await settle();
    const posts = selectionPosts();
    const [, init] = posts[posts.length - 1] as [string, { body: string }];
    expect((JSON.parse(init.body) as { nodes: unknown[] }).nodes).toEqual([
      { id: "web", label: "Web app" },
      { id: "shop", label: "Web shop" },
    ]);
  });
});

it("draws a relationship with only a description as that description alone", async () => {
  const { projectC4 } = await import("../src/diagrams/project-models");
  const drawn = projectC4({
    type: "c4-model",
    level: "context",
    boundaries: [],
    elements: [
      { id: "a", kind: "person", label: "A" },
      { id: "b", kind: "system", label: "B" },
    ],
    relationships: [{ id: "a--b", source: "a", target: "b", label: null, description: "Detail only" }],
  } as never);
  expect(captionParts(drawn.edges[0]!.caption!)).toEqual({ label: "", description: "Detail only" });
  const box = edgeLabelBox(drawn.edges[0]!.caption!);
  expect(box.lines).toEqual([]);
  expect(box.technology).toEqual([]);
  expect(box.description).toEqual(["Detail only"]);
});
