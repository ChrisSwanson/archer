// @vitest-environment jsdom
//
// A plain flowchart keeps its side panel and its Diagram Key (lead's decision, 2026-11-12): the panel holds the
// canvas to one width from diagram to diagram, carries the reader-blue / agent-amber note and is where the review
// docks. A plain group no longer has a "Group" row (it said what the frame says), but the Key is still there.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { ENVELOPE, MockEventSource, mountAgentPresented, restoreLocation } from "./app-harness";

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreLocation();
  window.history.replaceState(null, "", "/");
});

const GROUPED = {
  ...ENVELOPE,
  model: {
    ...ENVELOPE.model,
    nodes: [
      { id: "web", label: "Web" },
      { id: "api", label: "API", groupId: "box" },
    ],
    groups: [{ id: "box", label: "Box" }],
  },
};

describe("a plain flowchart's side panel", () => {
  it("is there, with the Diagram Key and the voices note, but no row for a plain group", async () => {
    await mountAgentPresented(<App />, {
      envelope: GROUPED,
      ready: (mounted) => expect(mounted.querySelectorAll(".react-flow__node.archer-node").length).toBe(2),
    });
    await waitFor(() => expect(document.querySelector(".archer-diagram-panel")).not.toBeNull());
    const key = await screen.findByRole("region", { name: "Diagram Key" });
    expect(key.closest(".archer-diagram-panel")).not.toBeNull();
    expect(within(key).queryByText("Group", { exact: true })).toBeNull();
  });
});
