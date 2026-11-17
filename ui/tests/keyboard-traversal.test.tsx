// @vitest-environment jsdom
//
// A user with no pointer can reach a node and select it.
//
// Wave 3A asks for "accessible keyboard selection" and, until this slice, the
// canvas had none: nodes carried React Flow's own `tabindex="0"` (every node
// in the page tab sequence), announced as "group", and its Enter binding wrote
// into a store this app deliberately ignores -- the flow is controlled, so
// `triggerNodeChanges` drops every selection change React Flow makes.
//
// So the mechanism here is the app's own: a roving tab stop, arrow keys
// resolved from layout geometry (`keyboard-nav.ts`), and Enter/Space dispatched
// through the SAME handler a click uses, which is what puts a keyboard
// selection on the same publish path as a pointer one.
//
// What this file must NOT do is assert geometry. jsdom lays nothing out, so
// "which node is below which" is settled in `keyboard-nav.test.ts` against real
// coordinates. Here the fixture is a two-node graph with one edge, laid out
// DOWN, so the source is drawn above the target -- enough to prove the wiring
// without leaning on the stubs in `setup.ts`.
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
  publishedNodeIds,
  restoreLocation,
  selectedNodes,
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

/** The rendered node elements, keyed by the model id they carry. */
function nodesById(container: HTMLElement): Map<string, HTMLElement> {
  const found = new Map<string, HTMLElement>();
  for (const element of container.querySelectorAll<HTMLElement>(".react-flow__node")) {
    const id = element.dataset.id;
    if (id !== undefined) found.set(id, element);
  }
  return found;
}

describe("Tab reaches the canvas", () => {
  it("puts exactly one node in the page tab order", async () => {
    // The point of a roving tabindex: one Tab press lands in the diagram, and
    // one more leaves it -- not one press per node.
    const { container } = await mountAgentPresented(<App />);
    const nodes = [...nodesById(container).values()];
    expect(nodes).toHaveLength(2);

    const stops = nodes.filter((node) => node.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(nodes.filter((node) => node.getAttribute("tabindex") === "-1")).toHaveLength(1);
  });

  it("lands on the first node in reading order, not the first in the array", async () => {
    // `toXFlowNodes` sorts by id, which would put "api" first. The graph is
    // laid out DOWN from "web" to "api", so "web" is the one drawn at the top.
    const { container } = await mountAgentPresented(<App />);
    const nodes = nodesById(container);

    expect(nodes.get("web")!.getAttribute("tabindex")).toBe("0");
    expect(nodes.get("api")!.getAttribute("tabindex")).toBe("-1");
  });

  it("announces the node's label rather than 'group'", async () => {
    const { container } = await mountAgentPresented(<App />);
    const web = nodesById(container).get("web")!;

    expect(web.getAttribute("aria-label")).toBe("Web");
    expect(web.getAttribute("role")).not.toBe("group");
  });
});

describe("arrow keys move focus", () => {
  it("moves the tab stop and the DOM focus to the node in that direction", async () => {
    const { container } = await mountAgentPresented(<App />);
    const nodes = nodesById(container);
    nodes.get("web")!.focus();

    fireEvent.keyDown(nodes.get("web")!, { key: "ArrowDown" });

    await waitFor(() => {
      expect(document.activeElement).toBe(nodesById(container).get("api"));
    });
    // The stop follows focus, or Tabbing out and back would drop the user
    // somewhere other than where they left off.
    expect(nodesById(container).get("api")!.getAttribute("tabindex")).toBe("0");
    expect(nodesById(container).get("web")!.getAttribute("tabindex")).toBe("-1");
  });

  it("does not change the selection", async () => {
    // Focus and selection are separate states. Selecting on every arrow press
    // would also publish a selection to the agent on every press.
    const { container } = await mountAgentPresented(<App />);
    const nodes = nodesById(container);
    nodes.get("web")!.focus();

    fireEvent.keyDown(nodes.get("web")!, { key: "ArrowDown" });
    fireEvent.keyDown(nodesById(container).get("api")!, { key: "ArrowUp" });

    await settle();
    expect(selectedNodes(container)).toBe(0);
    expect(publishedNodeIds(selectionPosts())).toEqual([]);
  });
});

describe("Enter and Space select the focused node", () => {
  it("selects it, and publishes it exactly as a click does", async () => {
    const { container } = await mountAgentPresented(<App />);
    const nodes = nodesById(container);
    nodes.get("web")!.focus();

    fireEvent.keyDown(nodes.get("web")!, { key: "Enter" });

    await waitFor(() => expect(selectedNodes(container)).toBe(1));
    await settle();
    expect(publishedNodeIds(selectionPosts())).toContain("web");
  });

  it("replaces the selection on a plain Space", async () => {
    const { container } = await mountAgentPresented(<App />);
    const nodes = nodesById(container);
    nodes.get("web")!.focus();
    fireEvent.keyDown(nodes.get("web")!, { key: "Enter" });
    await waitFor(() => expect(selectedNodes(container)).toBe(1));

    nodesById(container).get("api")!.focus();
    fireEvent.keyDown(nodesById(container).get("api")!, { key: " " });

    await waitFor(() => {
      expect(nodesById(container).get("api")!.classList.contains("selected")).toBe(true);
    });
    expect(selectedNodes(container)).toBe(1);
  });

  it("adds to the selection with Shift, matching Shift+click", async () => {
    const { container } = await mountAgentPresented(<App />);
    const nodes = nodesById(container);
    nodes.get("web")!.focus();
    fireEvent.keyDown(nodes.get("web")!, { key: "Enter" });
    await waitFor(() => expect(selectedNodes(container)).toBe(1));

    nodesById(container).get("api")!.focus();
    fireEvent.keyDown(nodesById(container).get("api")!, { key: "Enter", shiftKey: true });

    await waitFor(() => expect(selectedNodes(container)).toBe(2));
  });

  it("removes an already-selected node with Shift, as Shift+click does", async () => {
    const { container } = await mountAgentPresented(<App />);
    const nodes = nodesById(container);
    nodes.get("web")!.focus();
    fireEvent.keyDown(nodes.get("web")!, { key: "Enter" });
    await waitFor(() => expect(selectedNodes(container)).toBe(1));

    fireEvent.keyDown(nodesById(container).get("web")!, { key: " ", shiftKey: true });

    await waitFor(() => expect(selectedNodes(container)).toBe(0));
  });
});

describe("focused and selected are different states, and look it", () => {
  it("marks the focused node with its own class while focus is in the canvas", async () => {
    const { container } = await mountAgentPresented(<App />);
    const nodes = nodesById(container);
    nodes.get("web")!.focus();

    await waitFor(() => {
      expect(nodesById(container).get("web")!.classList.contains(KEYBOARD_FOCUS_CLASS)).toBe(true);
    });
  });

  it("leaves the ring on the focused node when a different node is selected", async () => {
    const { container } = await mountAgentPresented(<App />);
    const nodes = nodesById(container);
    nodes.get("web")!.focus();
    fireEvent.keyDown(nodes.get("web")!, { key: "Enter" });
    await waitFor(() => expect(selectedNodes(container)).toBe(1));

    fireEvent.keyDown(nodesById(container).get("web")!, { key: "ArrowDown" });

    await waitFor(() => {
      const api = nodesById(container).get("api")!;
      expect(api.classList.contains(KEYBOARD_FOCUS_CLASS)).toBe(true);
      expect(api.classList.contains("selected")).toBe(false);
    });
    const web = nodesById(container).get("web")!;
    expect(web.classList.contains("selected")).toBe(true);
    expect(web.classList.contains(KEYBOARD_FOCUS_CLASS)).toBe(false);
  });

  it("takes the ring off when focus leaves the canvas", async () => {
    // The ring says "the keyboard is here". Leaving it painted after focus has
    // gone would point at a node no key can act on.
    const { container } = await mountAgentPresented(<App />);
    const outside = document.createElement("button");
    document.body.append(outside);
    nodesById(container).get("web")!.focus();
    await waitFor(() => {
      expect(nodesById(container).get("web")!.classList.contains(KEYBOARD_FOCUS_CLASS)).toBe(true);
    });

    outside.focus();

    await waitFor(() => {
      expect(nodesById(container).get("web")!.classList.contains(KEYBOARD_FOCUS_CLASS)).toBe(false);
    });
    // ...but the stop stays where the user left it.
    expect(nodesById(container).get("web")!.getAttribute("tabindex")).toBe("0");
    outside.remove();
  });

  it("draws the ring from a token, and not the same way selection is drawn", () => {
    // jsdom resolves no `var()`, so the rule is asserted against the
    // stylesheet on disk -- the same lever `canvas-theme.test.tsx` uses.
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const rule = new RegExp(`\\.archer-node\\.${KEYBOARD_FOCUS_CLASS}\\s*\\{([^}]*)\\}`).exec(css);

    expect(rule, `a .archer-node.${KEYBOARD_FOCUS_CLASS} rule`).not.toBeNull();
    expect(rule![1]).toMatch(/var\(--kbd-focus\)/);
    // Selection fills the body and glows outside it; focus must not do either,
    // or the two states are indistinguishable when they sit on one node.
    expect(rule![1]).not.toMatch(/--accent/);
  });
});

describe("the cheat sheet promises the keys this canvas now has", () => {
  // The graph canvas. The sequence canvas has its own traversal and its own
  // rows for it -- asserted in `help-sheet-view.test.tsx`.
  it("lists the traversal and activation rows on the graph canvas", () => {
    const rows = HOTKEYS.flatMap((section) => section.keys);
    const meaningOf = (pattern: RegExp): string | undefined => rows.find(([key]) => pattern.test(key))?.[1];

    expect(meaningOf(/^Tab$/)).toBeDefined();
    expect(meaningOf(/Arrow/)).toMatch(/focus/i);
    expect(meaningOf(/^Enter/)).toMatch(/select/i);
    expect(rows.some(([key]) => /⇧ Enter/.test(key))).toBe(true);
  });
});
