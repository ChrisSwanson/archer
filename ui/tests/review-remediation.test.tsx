// @vitest-environment jsdom
//
// The findings from the adversarial review of the keyboard slices, each pinned
// so it cannot come back.
//
// Every one of these was a promise the page made and could not keep: a Tab row
// naming the wrong channel, a `button` role on a canvas with no keyboard, a
// screen-reader name falling back to stable ids, and the full graph cheat sheet
// shown over a page with no canvas at all.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { edgeAccessibleName, toXFlowNodes } from "../src/diagrams/xflow-adapter";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";
import { MockEventSource, mountAgentPresented, restoreLocation } from "./app-harness";

const view: ProjectedView = {
  viewId: "remediation-view",
  kind: "c4-context",
  title: "Remediation",
  revision: "1",
  modelType: "architecture-graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [{ id: "e1", source: "a", target: "b", label: "calls" }],
  groups: [],
};

let layout: LayoutResult;

beforeAll(async () => {
  layout = await computeLayout(view);
});

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

describe("the Tab row names the channel Tab actually reaches first", () => {
  it("reaches the edges before the nodes, because React Flow renders them first", async () => {
    // The cheat sheet said "once for the nodes, again for the edges". It is the
    // other way round: `GraphViewComponent` renders `EdgeRenderer` before
    // `NodeRenderer`, nothing carries a positive tabindex, so sequential focus
    // navigation is plain DOM order. A row naming the wrong one sends a
    // keyboard user arrowing around a ring they were told they were not in.
    const { container } = await mountAgentPresented(<App />);
    await waitFor(() => {
      expect(container.querySelector(".react-flow__edge")).not.toBeNull();
    });

    const stops = [...container.querySelectorAll<HTMLElement>(".react-flow__node, .react-flow__edge")]
      .filter((element) => element.getAttribute("tabindex") === "0")
      .map((element) => (element.classList.contains("react-flow__edge") ? "edge" : "node"));

    expect(stops).toEqual(["edge", "node"]);
  });
});

describe("a canvas with no keyboard channel makes no keyboard claim", () => {
  it("does not call its nodes buttons on the last-valid drawing under an error banner", () => {
    // That canvas is rendered outside the surface that carries the keydown
    // handler, so nothing there can be activated. `role=button`, `aria-pressed`
    // and xyflow's "use the arrow keys" description would all be false.
    const { container } = render(<DiagramCanvas state={{ status: "error", message: "boom", lastValid: layout }} />);

    const nodes = [...container.querySelectorAll(".react-flow__node")];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.getAttribute("role")).not.toBe("button");
      expect(node.getAttribute("aria-pressed")).toBeNull();
      expect(node.getAttribute("aria-describedby")).toBeNull();
    }
  });

  it("still calls them buttons on a live canvas", () => {
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} onNodeClick={() => {}} />);

    const node = container.querySelector(".react-flow__node");
    expect(node?.getAttribute("role")).toBe("button");
  });
});

describe("accessible names never fall through to stable ids", () => {
  it("names an unlabelled edge by its endpoints, even when the label is empty", () => {
    // `??` let an empty string through, and xyflow then treats "" as falsy and
    // substitutes "Edge from <id> to <id>" -- the ids this function exists to
    // keep out of a screen reader.
    expect(edgeAccessibleName("", "Web", "API")).toBe("Web → API");
    expect(edgeAccessibleName(undefined, "Web", "API")).toBe("Web → API");
    // Named with its ends, too: "calls" alone does not say what calls what (ux:A11Y-5).
    expect(edgeAccessibleName("calls", "Web", "API")).toBe("Web → API: calls");
    expect(edgeAccessibleName("two\nlines", "Web", "API")).toBe("Web → API: two lines");
  });

  it("names an unlabelled node by its id rather than leaving it unnamed", () => {
    const nodes = toXFlowNodes(
      { ...layout, nodes: layout.nodes.map((n) => ({ ...n, label: "" })) },
      undefined,
      undefined,
      undefined,
      { stopId: layout.nodes[0].id, ringId: null },
    );

    for (const node of nodes) {
      expect(node.ariaLabel).toBeTruthy();
    }
  });
});

describe("the cheat sheet over a page with no canvas", () => {
  it("promises only the shell's own keys once a notice has replaced the diagram", async () => {
    const { source } = await mountAgentPresented(<App />);
    act(() => source.emit("inventory", { schemaVersion: 1, views: [] }));
    await screen.findByText(/no longer registered/i);

    fireEvent.keyDown(window, { key: "?" });
    const dialog = await screen.findByRole("dialog");

    // Help, search and Esc: the shell's own keys, which work on any page. Every canvas row would be false here.
    expect([...dialog.querySelectorAll("dt kbd")].map((kbd) => kbd.textContent)).toEqual(["?", "/", "G", "Esc"]);
    expect(screen.queryByText("Drag on canvas")).toBeNull();
    expect(screen.queryByText("Tab")).toBeNull();

    // Each row is true here: Esc closes the sheet, and / and G open the search page ready to type.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    for (const key of ["/", "G"]) {
      fireEvent.keyDown(window, { key });
      const box = await screen.findByRole("searchbox", { name: "Search projects and files" });
      await waitFor(() => expect(document.activeElement).toBe(box));
      box.blur();
    }
  });
});
