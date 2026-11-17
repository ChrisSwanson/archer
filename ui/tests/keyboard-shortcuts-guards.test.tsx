// @vitest-environment jsdom
//
// What the keyboard bindings must NOT do.
//
// A window-level binding fires whatever is on screen, which makes "what is on
// screen" part of its contract. `pageNotice` can REPLACE the canvas -- an
// unregistered view is the one notice that overrides a drawing (see
// `page-state.ts`) -- and at that moment the page is deliberately refusing to
// vouch for the diagram. A shortcut that still selects its nodes, and then
// publishes that selection to the agent, tells the agent the user did
// something to a diagram nobody can see.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { act } from "react";
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
import {
  MockEventSource,
  mountAgentPresented,
  publishedNodeIds,
  restoreLocation,
  selectedNodes,
  selectionPosts,
  settle,
} from "./app-harness";

const mount = async () => {
  const mounted = await mountAgentPresented(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  return mounted;
};

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

describe("shortcuts respect what the page is willing to vouch for", () => {
  it("publishes a selection made with Cmd+A while the diagram is genuinely on screen", async () => {
    // The control. Without it the tests below could pass because the publish
    // path is broken rather than because a guard works.
    await mount();

    fireEvent.keyDown(window, { key: "a", metaKey: true });

    await waitFor(() => expect(selectionPosts().length).toBeGreaterThan(0));
  });

  it("does not select or publish once a notice has replaced the canvas", async () => {
    const { container, source } = await mount();

    // The agent unregisters the view that is on screen. `pageNotice` returns
    // `unregistered`, the one notice that takes a drawing down.
    act(() => source.emit("inventory", { schemaVersion: 1, views: [] }));
    await screen.findByText(/no longer registered/i);
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(0);
    // Taking the canvas down makes React Flow report an empty selection, which
    // the page publishes. That baseline is not this test's subject; what
    // follows the keystroke is.
    const before = selectionPosts().length;

    fireEvent.keyDown(window, { key: "a", metaKey: true });

    await settle();
    expect(selectionPosts()).toHaveLength(before);
    expect(publishedNodeIds(selectionPosts())).toEqual([]);
  });

  it("does not publish a cleared selection on Esc once the canvas is gone", async () => {
    const { container, source } = await mount();
    fireEvent.click(container.querySelector(".react-flow__node")!);
    await waitFor(() => expect(selectionPosts().length).toBeGreaterThan(0));
    const before = selectionPosts().length;

    act(() => source.emit("inventory", { schemaVersion: 1, views: [] }));
    await screen.findByText(/no longer registered/i);

    fireEvent.keyDown(window, { key: "Escape" });

    await settle();
    expect(selectionPosts()).toHaveLength(before);
  });

  it("leaves Cmd+A alone while the cheat sheet is up", async () => {
    // The overlay's own footer promises "Your selection is untouched", and `1`
    // is already disabled behind it for the same reason: a change the user
    // cannot see happening is one they did not get to watch.
    const { container } = await mount();

    fireEvent.keyDown(window, { key: "?" });
    await screen.findByRole("dialog");
    const before = selectionPosts().length;
    fireEvent.keyDown(window, { key: "a", metaKey: true });

    await settle();
    expect(selectionPosts()).toHaveLength(before);
    expect(selectedNodes(container)).toBe(0);
  });

  it("ignores Esc and Cmd+A typed into a field", async () => {
    const { container } = await mount();
    fireEvent.click(container.querySelector(".react-flow__node")!);
    await waitFor(() => expect(selectedNodes(container)).toBe(1));

    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "a", metaKey: true });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(selectedNodes(container)).toBe(1);
    input.remove();
  });
});
