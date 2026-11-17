// @vitest-environment jsdom
//
// An entity-relationship diagram on the graph canvas: entities as tables of
// attribute rows with their keys marked, relationships with crow's-foot
// cardinality at each end, identifying solid and non-identifying dashed.
//
// The envelope is the TypeScript compiler's output for the golden source
// `ts/test/fixtures/er/widened.mmd`.
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
import { projectEnvelope } from "../src/diagrams/projection";
import { parseEmphasis } from "../src/emphasis/contract";
import { MockEventSource, mountAgentPresented, restoreLocation, selectionPosts, settle } from "./app-harness";
import { loadModelEnvelope } from "./fixtures";
import { drawGraph, edgeElement, nodeElement, projectGraph } from "./support/draw-envelope";
import { installReducedMotion } from "./match-media";

const ER = loadModelEnvelope("er", "widened");

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

describe("an entity-relationship model projects onto the graph canvas", () => {
  it("makes each entity a node carrying its attributes, and each relationship an edge with its two ends", () => {
    const view = projectGraph(ER);
    expect(view.notation).toBe("er");
    expect(view.nodes.map((node) => node.id)).toEqual(["CUSTOMER", "LINE-ITEM", "ORDER", "PRODUCT"]);
    expect(view.nodes.find((node) => node.id === "LINE-ITEM")?.figure).toEqual({
      type: "entity",
      attributes: [{ name: "order_id", type: "int", keys: ["PK", "FK"], comment: undefined }],
    });
    const places = view.edges.find((edge) => edge.id === "CUSTOMER--ORDER")!;
    expect(places.figure).toEqual({ type: "cardinality", source: "exactly-one", target: "zero-or-more" });
    expect(places.line).toBeUndefined();
    expect(view.edges.find((edge) => edge.id === "LINE-ITEM--PRODUCT")?.line).toBe("dotted");
  });

  it("refuses a relationship to an entity the model does not have", () => {
    const broken = {
      ...ER,
      model: {
        ...ER.model,
        relationships: [
          {
            id: "A--B",
            source: "CUSTOMER",
            target: "GHOST",
            sourceCardinality: "exactly-one",
            targetCardinality: "exactly-one",
            identifying: true,
          },
        ],
      },
    };
    expect(projectEnvelope(broken).ok).toBe(false);
  });
});

describe("entities are tables, and relationships wear their cardinality", () => {
  it("draws a header and one row per attribute, keys marked in words", async () => {
    const { container } = await drawGraph(ER);
    const customer = nodeElement(container, "CUSTOMER");
    expect(customer.querySelector(".archer-er-title")?.textContent).toBe("Customer");
    const rows = [...customer.querySelectorAll(".archer-er-row")].map((row) =>
      [...row.querySelectorAll("[data-column]")]
        .map((cell) => `${cell.getAttribute("data-column")}=${cell.textContent}`)
        .join(" "),
    );
    expect(rows).toEqual([
      "type=string name=name keys=PK comment=full name",
      "type=string name=email keys=UK comment=",
      "type=int name=age keys= comment=",
    ]);
    const keys = [...nodeElement(container, "LINE-ITEM").querySelectorAll(".archer-er-key")].map(
      (key) => key.textContent,
    );
    expect(keys).toEqual(["PK", "FK"]);
    // An entity with no attributes is its name in a box.
    expect(nodeElement(container, "PRODUCT").querySelectorAll(".archer-er-row")).toHaveLength(0);
  });

  it("names an entity and its attributes for a screen reader", async () => {
    const { container } = await drawGraph(ER);
    expect(nodeElement(container, "LINE-ITEM").getAttribute("aria-label")).toBe(
      "Order line, entity: order_id int PK FK",
    );
    expect(nodeElement(container, "PRODUCT").getAttribute("aria-label")).toBe("PRODUCT, entity");
  });

  it("marks each end of a relationship with its own cardinality, and no arrowhead", async () => {
    const { container } = await drawGraph(ER);
    const places = edgeElement(container, "CUSTOMER--ORDER");
    const ends = [...places.querySelectorAll(".archer-er-mark")].map(
      (mark) => `${mark.getAttribute("data-end")}:${mark.getAttribute("data-cardinality")}`,
    );
    expect(ends).toEqual(["source:exactly-one", "target:zero-or-more"]);
    expect(places.querySelector(".react-flow__edge-path")?.getAttribute("marker-end")).toBeNull();
  });

  it("draws an identifying relationship solid and a non-identifying one dashed", async () => {
    const { container } = await drawGraph(ER);
    expect(edgeElement(container, "CUSTOMER--ORDER").classList.contains("archer-line-solid")).toBe(true);
    expect(edgeElement(container, "LINE-ITEM--PRODUCT").classList.contains("archer-line-dotted")).toBe(true);
  });

  it("takes selection, emphasis and comment marks on entities and relationships", async () => {
    const emphasis = parseEmphasis({
      id: "orders",
      viewId: ER.view.id,
      title: "Orders",
      groups: [{ id: "g", style: "flow", palette: "teal", nodes: ["ORDER"], edges: ["ORDER--LINE-ITEM"] }],
    });
    const { container } = await drawGraph(ER, {
      emphasis,
      selection: { nodeIds: ["CUSTOMER"], edgeIds: ["CUSTOMER--ORDER"] },
      commented: pinsOn({ nodes: ["PRODUCT"], edges: ["LINE-ITEM--PRODUCT"] }),
    });
    expect(nodeElement(container, "CUSTOMER").classList.contains("selected")).toBe(true);
    expect(edgeElement(container, "CUSTOMER--ORDER").classList.contains("selected")).toBe(true);
    expect(nodeElement(container, "ORDER").classList.contains("archer-emph")).toBe(true);
    expect(edgeElement(container, "ORDER--LINE-ITEM").classList.contains("archer-emph")).toBe(true);
    // A non-member of a shown highlight steps back (owner, 2026-11-12); its pins stay in it, at full strength.
    expect(nodeElement(container, "PRODUCT").querySelector(".archer-pin")?.textContent).toBe("1");
    expect(container.querySelector(`[data-edge-pins="LINE-ITEM--PRODUCT"] .archer-pin`)?.textContent).toBe("2");
    expect(edgeElement(container, "LINE-ITEM--PRODUCT").classList.contains("archer-commented")).toBe(true);
  });
});

describe("an ER selection reaches the agent", () => {
  it("publishes a clicked entity and a Shift-clicked relationship by their model ids", async () => {
    const { container } = await mountAgentPresented(<App />, {
      envelope: ER,
      views: [{ id: ER.view.id, kind: "entity-relationship", title: "Shop", registration: "durable" }],
      ready: (mounted) => expect(mounted.querySelectorAll(".react-flow__edge").length).toBe(4),
    });
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    fireEvent.click(screen.getByText("Customer"));
    fireEvent.click(edgeElement(container, "CUSTOMER--ORDER"), { shiftKey: true });
    await waitFor(() => expect(container.querySelectorAll(".selected")).toHaveLength(2));
    await settle();
    const posts = selectionPosts();
    const [, init] = posts[posts.length - 1] as [string, { body: string }];
    const published = JSON.parse(init.body) as { nodes: unknown[]; edges: unknown[] };
    expect(published.nodes).toEqual([{ id: "CUSTOMER", label: "Customer" }]);
    expect(published.edges).toEqual([{ id: "CUSTOMER--ORDER", source: "CUSTOMER", target: "ORDER", label: "places" }]);
  });
});
