// @vitest-environment jsdom
//
// An edge must be reachable by keyboard on the same terms as a node -- or say
// nothing about a keyboard at all.
//
// Before this slice `toXFlowEdges` set `focusable: true`, and in
// @xyflow/react v12.11.2 that is a promise the canvas cannot keep. It gives
// every edge `tabIndex: 0`, `role="group"`, its own `onKeyDown`, and an
// `aria-describedby` pointing at "Press enter or space to select an edge".
// That handler calls `addSelectedEdges`, which lands in `triggerEdgeChanges`
// -- and this flow is CONTROLLED (an `edges` prop, no `onEdgesChange`), so
// every change is dropped. Nothing reached the selection reducer and nothing
// reached the host. It also put one tab stop on every edge, which is what the
// roving tabindex for nodes exists to avoid.
//
// The fix keeps edges reachable, because they are already click-selectable and
// `App` already routes `onEdgeClick` into the reducer. Traversal is the app's
// own, over the same `keyboard-nav.ts` the nodes use, and activation goes
// through `props.onEdgeClick` -- the same route a click takes.
//
// TWO tab stops on the canvas, not one and not M+N: one roving stop over the
// nodes, one over the edges. Merging them would mean an arrow key stepping
// from a node onto an edge drawn between it and the next node, which makes
// node-to-node travel longer to serve a rarer gesture; keeping them separate
// costs one extra Tab press and keeps each ring a homogeneous set the arrow
// keys move around coherently.
//
// No geometry is asserted here. jsdom lays nothing out, so which edge is above
// which is settled in `keyboard-nav.test.ts` against real coordinates; this
// file proves the wiring.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
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
import { HOTKEYS } from "../src/app/HelpOverlay";
import { KEYBOARD_FOCUS_CLASS } from "../src/diagrams/xflow-adapter";
import {
  MockEventSource,
  mountAgentPresented,
  publishedEdgeIds,
  restoreLocation,
  selectionPosts,
  settle,
} from "./app-harness";

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

/**
 * Three nodes and three edges.
 *
 * More than one edge on purpose: with a single edge, "exactly one edge is
 * tabbable" is true of the broken behaviour too.
 */
const THREE_EDGES = {
  schemaVersion: 2,
  view: { id: "alpha", kind: "data-flow", title: "Alpha" },
  revision: `sha256:${"a".repeat(64)}`,
  model: {
    type: "data-flow-graph",
    nodes: [
      { id: "web", label: "Web" },
      { id: "api", label: "API" },
      { id: "db", label: "Database" },
    ],
    edges: [
      { id: "calls", source: "web", target: "api", label: "calls" },
      { id: "reads", source: "api", target: "db", label: "reads" },
      { id: "bypass", source: "web", target: "db" },
    ],
    groups: [],
  },
};

const mount = async () =>
  await mountAgentPresented(<App />, {
    envelope: THREE_EDGES,
    ready: (container) => {
      expect(container.querySelectorAll(".react-flow__node").length).toBe(3);
      expect(container.querySelectorAll(".react-flow__edge").length).toBe(3);
    },
  });

/** The rendered edge elements, keyed by the model id they carry. */
function edgesById(container: HTMLElement): Map<string, Element> {
  const found = new Map<string, Element>();
  for (const element of container.querySelectorAll(".react-flow__edge")) {
    const id = (element as HTMLElement).dataset.id;
    if (id !== undefined) found.set(id, element);
  }
  return found;
}

/** The model ids of everything matching `selector` that is in the tab order. */
const tabStops = (container: HTMLElement, selector: string): string[] =>
  [...container.querySelectorAll<HTMLElement>(selector)]
    .filter((element) => element.getAttribute("tabindex") === "0")
    .map((element) => element.dataset.id ?? "?");

const selectedEdges = (container: HTMLElement): number =>
  container.querySelectorAll(".react-flow__edge.selected").length;

describe("Tab reaches the edges without walking every one of them", () => {
  it("puts exactly one edge in the page tab order", async () => {
    const { container } = await mount();
    const edges = [...edgesById(container).values()];
    expect(edges).toHaveLength(3);

    expect(tabStops(container, ".react-flow__edge")).toHaveLength(1);
    expect(edges.filter((edge) => edge.getAttribute("tabindex") === "-1")).toHaveLength(2);
  });

  it("gives the whole canvas two stops -- one for nodes, one for edges", async () => {
    // The number that must not grow with the diagram. Three nodes and three
    // edges is still two Tab presses to cross.
    const { container } = await mount();

    expect(tabStops(container, ".react-flow__node, .react-flow__edge")).toHaveLength(2);
  });

  it("says what the edge is, not 'group'", async () => {
    const { container } = await mount();
    const edges = edgesById(container);

    // React Flow's `role="group"` says nothing a reader can act on, and it is
    // what `focusable: true` forced. A label is the edge's own caption...
    expect(edges.get("calls")!.getAttribute("role")).not.toBe("group");
    expect(edges.get("calls")!.getAttribute("aria-label")).toBe("Web → API: calls");
    // ...and an unlabelled edge falls back to the two ends it joins.
    expect(edges.get("bypass")!.getAttribute("aria-label")).toBe("Web → Database");
  });

  it("promises no keyboard gesture React Flow would have to deliver", async () => {
    // `aria-describedby` on a focusable edge points at React Flow's own
    // "press enter or space to select an edge" text, and that binding writes
    // into a store this controlled flow drops changes from. The description
    // must not be advertised by a mechanism this app does not own.
    const { container } = await mount();

    for (const edge of edgesById(container).values()) {
      expect(edge.getAttribute("aria-describedby")).toBeNull();
    }
    // React Flow renders its edge description div unconditionally, referenced
    // or not, so the sentence itself has to be replaced rather than merely
    // left unpointed-at.
    expect(container.textContent).not.toMatch(/press enter or space to select an edge/i);
    expect(container.textContent).toMatch(/arrow keys to move between edges/i);
  });
});

describe("arrow keys move between edges", () => {
  it("moves the stop and the DOM focus to another edge", async () => {
    const { container } = await mount();
    const startId = tabStops(container, ".react-flow__edge")[0];
    const first = edgesById(container).get(startId) as HTMLElement;
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowDown" });

    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.classList.contains("react-flow__edge")).toBe(true);
      expect(active?.dataset.id).not.toBe(startId);
    });
    // The stop follows focus, as it does for nodes.
    expect(tabStops(container, ".react-flow__edge")).toEqual([(document.activeElement as HTMLElement).dataset.id]);
  });

  it("does not change the selection", async () => {
    const { container } = await mount();
    const first = edgesById(container).get(tabStops(container, ".react-flow__edge")[0]) as HTMLElement;
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowDown" });

    await settle();
    expect(selectedEdges(container)).toBe(0);
    expect(publishedEdgeIds(selectionPosts())).toEqual([]);
  });
});

describe("Enter and Space select the focused edge", () => {
  it("selects it and publishes it, exactly as a click does", async () => {
    const { container } = await mount();
    const calls = edgesById(container).get("calls") as HTMLElement;
    calls.focus();

    fireEvent.keyDown(calls, { key: "Enter" });

    await waitFor(() => expect(selectedEdges(container)).toBe(1));
    await settle();
    expect(publishedEdgeIds(selectionPosts())).toContain("calls");
  });

  it("replaces the selection on a plain Space", async () => {
    const { container } = await mount();
    const edges = edgesById(container);
    (edges.get("calls") as HTMLElement).focus();
    fireEvent.keyDown(edges.get("calls")!, { key: "Enter" });
    await waitFor(() => expect(selectedEdges(container)).toBe(1));

    (edgesById(container).get("reads") as HTMLElement).focus();
    fireEvent.keyDown(edgesById(container).get("reads")!, { key: " " });

    await waitFor(() => {
      expect(edgesById(container).get("reads")!.classList.contains("selected")).toBe(true);
    });
    expect(selectedEdges(container)).toBe(1);
  });

  it("adds with Shift, and takes back out with Shift", async () => {
    const { container } = await mount();
    const edges = edgesById(container);
    (edges.get("calls") as HTMLElement).focus();
    fireEvent.keyDown(edges.get("calls")!, { key: "Enter" });
    await waitFor(() => expect(selectedEdges(container)).toBe(1));

    (edgesById(container).get("reads") as HTMLElement).focus();
    fireEvent.keyDown(edgesById(container).get("reads")!, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(selectedEdges(container)).toBe(2));

    fireEvent.keyDown(edgesById(container).get("reads")!, { key: " ", shiftKey: true });
    await waitFor(() => expect(selectedEdges(container)).toBe(1));
  });
});

describe("a focused edge is visibly distinguishable", () => {
  it("wears the same keyboard-focus class the nodes wear", async () => {
    const { container } = await mount();
    const calls = edgesById(container).get("calls") as HTMLElement;

    calls.focus();

    await waitFor(() => {
      expect(edgesById(container).get("calls")!.classList.contains(KEYBOARD_FOCUS_CLASS)).toBe(true);
    });
  });

  it("takes the ring off when focus leaves the canvas", async () => {
    const { container } = await mount();
    const outside = document.createElement("button");
    document.body.append(outside);
    (edgesById(container).get("calls") as HTMLElement).focus();
    await waitFor(() => {
      expect(edgesById(container).get("calls")!.classList.contains(KEYBOARD_FOCUS_CLASS)).toBe(true);
    });

    outside.focus();

    await waitFor(() => {
      expect(edgesById(container).get("calls")!.classList.contains(KEYBOARD_FOCUS_CLASS)).toBe(false);
    });
    // ...but the stop stays where the user left it.
    expect(edgesById(container).get("calls")!.getAttribute("tabindex")).toBe("0");
    outside.remove();
  });

  it("does not leave a node ring painted while the keyboard is on an edge", async () => {
    // One ring at a time, or it points at two places the keys cannot both act
    // on. The node stop stays put; only the ring moves.
    const { container } = await mount();
    const node = container.querySelector(".react-flow__node") as HTMLElement;
    node.focus();
    await waitFor(() => expect(node.classList.contains(KEYBOARD_FOCUS_CLASS)).toBe(true));

    (edgesById(container).get("calls") as HTMLElement).focus();

    await waitFor(() => {
      expect(container.querySelectorAll(`.${KEYBOARD_FOCUS_CLASS}`)).toHaveLength(1);
    });
    expect(edgesById(container).get("calls")!.classList.contains(KEYBOARD_FOCUS_CLASS)).toBe(true);
  });

  it("draws the edge ring from the same token, and not the way selection is drawn", () => {
    // jsdom resolves no `var()`, so the rule is asserted against the
    // stylesheet on disk -- as `keyboard-traversal.test.tsx` does for nodes.
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const rule = new RegExp(`\\.archer-edge\\.${KEYBOARD_FOCUS_CLASS}[^{]*\\{([^}]*)\\}`).exec(css);

    expect(rule, `a .archer-edge.${KEYBOARD_FOCUS_CLASS} rule`).not.toBeNull();
    expect(rule![1]).toMatch(/var\(--kbd-focus\)/);
    // A selected edge is drawn by recolouring its stroke to `--accent`; focus
    // must not do the same thing, or the two are one state on screen.
    expect(rule![1]).not.toMatch(/--accent/);
  });
});

describe("the cheat sheet stays true once edges join", () => {
  it("does not promise selection of nodes only", async () => {
    const rows = HOTKEYS.flatMap((section) => section.keys);
    const meaningOf = (pattern: RegExp): string | undefined => rows.find(([key]) => pattern.test(key))?.[1];

    // Enter/Space now acts on whichever of the two the keyboard is standing on.
    expect(meaningOf(/^Enter/)).toMatch(/edge/i);
    // ...and the arrow keys move within the ring the focus is in.
    expect(meaningOf(/Arrow/)).toMatch(/edge/i);
    // Tab now has two stops to reach, and the reader has to be told.
    expect(meaningOf(/^Tab$/)).toMatch(/edge/i);
  });
});
