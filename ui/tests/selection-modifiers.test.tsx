// @vitest-environment jsdom
//
// Shift adds to the selection.
//
// `canvas-interaction.test.tsx` has recorded the intent since the pointer
// slice landed -- "Shift is never used for navigation, so it stays free for
// additive selection" -- but the intent was not delivered, in two separate
// places:
//
//   - React Flow binds additive CLICK to `multiSelectionKeyCode`, which
//     defaults to Meta/Ctrl. Shift was only `selectionKeyCode`.
//   - `App.onNodeClick` dispatched a select carrying the ONE clicked id, and
//     that controlled value is what the canvas is redrawn from, so React
//     Flow's own additive result was overwritten before it was painted.
//
// Additive MARQUEE is not a props question at all: React Flow's
// `commitUserSelectionRect` replaces the selection with exactly what the
// rectangle contains and never unions, so the union is the app's job.
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
import { HOTKEYS } from "../src/app/HelpOverlay";
import {
  MockEventSource,
  mountAgentPresented,
  publishedNodeIds,
  restoreLocation,
  selectedNodes,
  selectionPosts,
  settle,
  settleSelection,
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

describe("Shift+click adds to the selection", () => {
  it("keeps the first node selected when a second is Shift+clicked", async () => {
    const { container } = await mountAgentPresented(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    const nodes = container.querySelectorAll(".react-flow__node");
    expect(nodes).toHaveLength(2);

    fireEvent.click(nodes[0]);
    await waitFor(() => expect(selectedNodes(container)).toBe(1));

    // React Flow reads the modifier from a real keydown on the window, not
    // from the flag carried on the click.
    fireEvent.keyDown(window, { key: "Shift" });
    fireEvent.click(nodes[1], { shiftKey: true });

    await waitFor(() => expect(selectedNodes(container)).toBe(2));
    fireEvent.keyUp(window, { key: "Shift" });
  });

  it("removes a node from the selection when it is Shift+clicked again", async () => {
    const { container } = await mountAgentPresented(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    const nodes = container.querySelectorAll(".react-flow__node");

    fireEvent.click(nodes[0]);
    await waitFor(() => expect(selectedNodes(container)).toBe(1));
    fireEvent.keyDown(window, { key: "Shift" });
    fireEvent.click(nodes[1], { shiftKey: true });
    await waitFor(() => expect(selectedNodes(container)).toBe(2));

    fireEvent.click(nodes[1], { shiftKey: true });

    await waitFor(() => expect(selectedNodes(container)).toBe(1));
    fireEvent.keyUp(window, { key: "Shift" });
  });

  it("still replaces the selection on a plain click", async () => {
    const { container } = await mountAgentPresented(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    const nodes = container.querySelectorAll(".react-flow__node");

    fireEvent.keyDown(window, { key: "Shift" });
    fireEvent.click(nodes[0], { shiftKey: true });
    fireEvent.click(nodes[1], { shiftKey: true });
    await waitFor(() => expect(selectedNodes(container)).toBe(2));
    fireEvent.keyUp(window, { key: "Shift" });

    fireEvent.click(nodes[0]);

    await waitFor(() => expect(selectedNodes(container)).toBe(1));
  });

  it("publishes the whole additive selection, not just the last click", async () => {
    // The agent is told what the user selected. An additive gesture that
    // published one id would describe a selection the user can see is bigger.
    const { container } = await mountAgentPresented(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    const nodes = container.querySelectorAll(".react-flow__node");

    fireEvent.click(nodes[0]);
    await waitFor(() => expect(selectedNodes(container)).toBe(1));
    fireEvent.keyDown(window, { key: "Shift" });
    fireEvent.click(nodes[1], { shiftKey: true });
    await waitFor(() => expect(selectedNodes(container)).toBe(2));
    fireEvent.keyUp(window, { key: "Shift" });

    await settleSelection();
    const published = publishedNodeIds(selectionPosts());
    expect(published).toContain("web");
    expect(published).toContain("api");
  });
});

describe("the cheat sheet promises the gesture it now has", () => {
  // Against the GRAPH list. `help-sheet-view.test.tsx` holds the sequence
  // canvas's half: its own additive rows, and no marquee row.
  it("lists an additive row on the graph canvas", () => {
    const rows = HOTKEYS.flatMap((section) => section.keys);
    const additive = rows.filter(([, meaning]) => /add to|added to/i.test(meaning));

    expect(additive.length).toBeGreaterThan(0);
    // ...and names Shift, which is the key that does it.
    expect(additive.every(([key]) => key.includes("⇧"))).toBe(true);
  });
});
