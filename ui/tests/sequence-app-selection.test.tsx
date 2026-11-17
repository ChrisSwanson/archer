// @vitest-environment jsdom
//
// A selection made on a sequence diagram reaches the host, in the shape a
// graph selection has: participants as `nodes`, messages as `edges`.
//
// Mounted the AGENT-PRESENTED way (see `app-harness.tsx`), so the selection
// carries the agent's presentation id and not a reader's stamp.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
  restoreLocation,
  selectionPosts,
  settle,
  settleSelection,
  type Mounted,
} from "./app-harness";
import { loadValidFixture } from "./fixtures";

const SEQUENCE_ENVELOPE = loadValidFixture("minimal-sequence.json") as {
  revision: string;
  view: { id: string };
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

async function mountSequence(): Promise<Mounted> {
  const mounted = await mountAgentPresented(<App />, {
    envelope: SEQUENCE_ENVELOPE,
    ready: (container) => {
      expect(container.querySelector("[aria-label='Sequence diagram canvas']")).not.toBeNull();
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  return mounted;
}

type Published = {
  viewId: string;
  presentationId: string;
  nodes: { id: string; label: string }[];
  edges: { id: string; source: string; target: string; label?: string }[];
};

function lastPublished(): Published {
  const posts = selectionPosts();
  expect(posts.length).toBeGreaterThan(0);
  const [, init] = posts[posts.length - 1] as [string, { body: string }];
  return JSON.parse(init.body) as Published;
}

const selectedIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".archer-seq-selected[data-seq-id]")]
    .map((el) => el.getAttribute("data-seq-id")!)
    .sort();

describe("a sequence selection is published as nodes and edges", () => {
  it("publishes a clicked participant as a node and Shift-clicked messages as edges", async () => {
    const { container } = await mountSequence();

    fireEvent.click(screen.getByText("Server"));
    await waitFor(() => expect(selectedIds(container)).toEqual(["server"]));
    fireEvent.click(screen.getByText("POST /login"), { shiftKey: true });
    fireEvent.click(screen.getByText("user record"), { shiftKey: true });
    await waitFor(() => expect(selectedIds(container)).toEqual(["msg-0", "msg-2", "server"]));
    await settleSelection();

    const published = lastPublished();
    expect(published.viewId).toBe("auth-flow");
    expect(published.presentationId).toBe("agent-run");
    expect(published.nodes).toEqual([{ id: "server", label: "Server" }]);
    expect(published.edges).toEqual([
      { id: "msg-0", source: "client", target: "server", label: "POST /login" },
      { id: "msg-2", source: "db", target: "server", label: "user record" },
    ]);
  });

  it("a plain click replaces, and Shift+click on a selected element takes it out", async () => {
    const { container } = await mountSequence();

    fireEvent.click(screen.getByText("Server"));
    fireEvent.click(screen.getByText("Client"));
    await waitFor(() => expect(selectedIds(container)).toEqual(["client"]));
    fireEvent.click(screen.getByText("Client"), { shiftKey: true });
    await waitFor(() => expect(selectedIds(container)).toEqual([]));
  });

  it("a click on empty canvas clears the selection", async () => {
    const { container } = await mountSequence();
    fireEvent.click(screen.getByText("Server"));
    await waitFor(() => expect(selectedIds(container)).toEqual(["server"]));
    fireEvent.click(container.querySelector(".archer-seq-svg")!);
    await waitFor(() => expect(selectedIds(container)).toEqual([]));
  });

  it("selects by keyboard through the same path, so Enter publishes too", async () => {
    const { container } = await mountSequence();
    const message = screen.getByRole("button", { name: "Server to Database: SELECT user" });
    message.focus();
    fireEvent.keyDown(message, { key: "Enter" });
    await waitFor(() => expect(selectedIds(container)).toEqual(["msg-1"]));
    await settle();
    expect(lastPublished().edges).toEqual([{ id: "msg-1", source: "server", target: "db", label: "SELECT user" }]);
    // The element survives the redraw, so the keyboard is still on it.
    expect(document.activeElement).toBe(message);
  });
});

describe("the page-level keys now reach a sequence diagram", () => {
  it("Cmd/Ctrl+A selects every participant and every message, and Esc clears", async () => {
    const { container } = await mountSequence();

    const selectAll = fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    // Claimed, so the browser does not also select the page's text.
    expect(selectAll).toBe(false);
    await waitFor(() =>
      expect(selectedIds(container)).toEqual(["client", "db", "msg-0", "msg-1", "msg-2", "msg-3", "msg-4", "server"]),
    );
    await settle();
    const published = lastPublished();
    expect(published.nodes.map((node) => node.id)).toEqual(["client", "server", "db"]);
    expect(published.edges.map((edge) => edge.id)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(selectedIds(container)).toEqual([]));
  });

  it("keeps the selection across a recompile of the same view", async () => {
    const { container, source } = await mountSequence();
    fireEvent.click(screen.getByText("Server"));
    fireEvent.click(screen.getByText("POST /login"), { shiftKey: true });
    await waitFor(() => expect(selectedIds(container)).toEqual(["msg-0", "server"]));

    act(() => {
      source.emit("presentation", {
        envelope: { ...SEQUENCE_ENVELOPE, revision: `sha256:${"b".repeat(64)}` },
        presentation: { presentationId: "agent-run", viewId: SEQUENCE_ENVELOPE.view.id },
        diagnostics: [],
      });
    });
    await settle();
    expect(selectedIds(container)).toEqual(["msg-0", "server"]);
  });
});
