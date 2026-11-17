// @vitest-environment jsdom
//
// A state diagram on the graph canvas: states drawn as UML draws them, a
// composite state as a frame that is itself a state, and every state and
// transition selectable, emphasisable and commentable by its model id.
//
// The envelope is the TypeScript compiler's own output for the golden source
// `ts/test/fixtures/state/widened.mmd`, which reads every construct the state
// profile has.
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
import { elementNodes, projectEnvelope } from "../src/diagrams/projection";
import { STATE_KINDS } from "../src/diagrams/figures";
import { parseEmphasis } from "../src/emphasis/contract";
import {
  MockEventSource,
  mountAgentPresented,
  restoreLocation,
  selectionPosts,
  settle,
  settleSelection,
} from "./app-harness";
import { loadModelEnvelope } from "./fixtures";
import { drawGraph, edgeElement, nodeElement, projectGraph } from "./support/draw-envelope";
import { anchorAt, diagramChoices } from "../src/comments/canvas-anchors";
import { installReducedMotion } from "./match-media";

const STATE = loadModelEnvelope("state", "widened");

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

describe("a state machine projects onto the graph canvas", () => {
  it("draws leaf states as nodes and a composite as a frame that is itself an element", () => {
    const view = projectGraph(STATE);
    expect(view.notation).toBe("state");
    expect(view.direction).toBe("lr");
    expect(view.nodes.map((node) => node.id)).not.toContain("Working");
    expect(view.groups).toEqual([
      { id: "Working", label: "Working", parentId: undefined, element: true, figure: { type: "composite" } },
    ]);
    expect(view.nodes.find((node) => node.id === "Fetch")?.groupId).toBe("Working");
    // Every state is selectable, composite or not, under its own id.
    const states = (STATE.model.states as { id: string }[]).map((state) => state.id).sort();
    expect(
      elementNodes(view)
        .map((node) => node.id)
        .sort(),
    ).toEqual(states);
  });

  it("carries each state's kind and its note", () => {
    const view = projectGraph(STATE);
    const figure = (id: string) => view.nodes.find((node) => node.id === id)?.figure;
    expect(figure("Idle")).toEqual({
      type: "state",
      kind: "state",
      note: { position: "right-of", text: "polls every 5 s" },
    });
    expect(figure("Route")).toEqual({ type: "state", kind: "choice" });
    expect(figure("root_start")).toEqual({ type: "state", kind: "initial" });
    expect(figure("Working_end")).toEqual({ type: "state", kind: "final" });
  });

  it("refuses a transition to a state the model does not have, by name", () => {
    const broken = {
      ...STATE,
      model: { ...STATE.model, transitions: [{ id: "a--ghost", source: "Idle", target: "ghost" }] },
    };
    const projection = projectEnvelope(broken);
    expect(projection.ok).toBe(false);
  });
});

describe("each state kind is drawn as UML draws it", () => {
  it("gives every kind its own class, and no two kinds one outline and one class", async () => {
    const { container } = await drawGraph(STATE);
    const drawn = new Map<string, string>();
    for (const [id, kind] of [
      ["Idle", "state"],
      ["root_start", "initial"],
      ["root_end", "final"],
      ["Route", "choice"],
      ["Split", "fork"],
      ["Merge", "join"],
    ] as const) {
      const element = nodeElement(container, id);
      expect(element.classList.contains(`archer-state-${kind}`), `${id} is drawn as ${kind}`).toBe(true);
      drawn.set(
        kind,
        [...element.classList]
          .filter((name) => name.startsWith("archer-shape-") || name.startsWith("archer-state-"))
          .join(" "),
      );
    }
    expect(new Set(drawn.values()).size).toBe(STATE_KINDS.length);
  });

  it("writes a state's name, and leaves the pseudo-states to their shape", async () => {
    const { container } = await drawGraph(STATE);
    expect(nodeElement(container, "Idle").textContent).toContain("Waiting for work");
    for (const id of ["root_start", "root_end", "Route", "Split", "Merge"]) {
      expect(nodeElement(container, id).querySelector(".archer-node-label-row")).toBeNull();
    }
  });

  it("says start and end in words beside the pseudo-states, and on hover", async () => {
    // A bare dot and a ringed dot read as rendering glitches to someone who
    // does not know UML: each says what it is, beside it and as a tooltip.
    const { container } = await drawGraph(STATE);
    const start = nodeElement(container, "root_start");
    const end = nodeElement(container, "root_end");
    expect(start.querySelector(".archer-state-mark-label")?.textContent).toBe("start");
    expect(end.querySelector(".archer-state-mark-label")?.textContent).toBe("end");
    // Seen, not read twice: the node's own name already says it.
    expect(start.querySelector(".archer-state-mark-label")?.getAttribute("aria-hidden")).toBe("true");
    expect(start.querySelector("[title]")?.getAttribute("title")).toMatch(/^Start/);
    expect(end.querySelector("[title]")?.getAttribute("title")).toMatch(/^End/);
    // An ordinary state has neither.
    expect(nodeElement(container, "Idle").querySelector(".archer-state-mark-label")).toBeNull();
  });

  it("draws the start and end marks a little larger than a bare dot", async () => {
    const { layout } = await drawGraph(STATE);
    const size = (id: string) => layout.nodes.find((node) => node.id === id)!;
    expect(size("root_start").width).toBeGreaterThanOrEqual(26);
    expect(size("root_end").width).toBeGreaterThanOrEqual(30);
  });

  it("names every state for a screen reader, with its kind", async () => {
    const { container } = await drawGraph(STATE);
    expect(nodeElement(container, "root_start").getAttribute("aria-label")).toBe("start, initial state");
    expect(nodeElement(container, "Route").getAttribute("aria-label")).toBe("Route, choice");
    expect(nodeElement(container, "Idle").getAttribute("aria-label")).toBe("Waiting for work, note: polls every 5 s");
    expect(nodeElement(container, "Working").getAttribute("aria-label")).toBe("Working, composite state");
  });

  it("draws a note beside its state, on the side the source says", async () => {
    const { container, layout } = await drawGraph(STATE);
    const note = nodeElement(container, "Idle").querySelector(".archer-state-note");
    expect(note?.textContent).toBe("polls every 5 s");
    expect(note?.classList.contains("archer-state-note-right-of")).toBe(true);
    // The layout kept room for it: nothing else is placed where it is drawn.
    const idle = layout.nodes.find((node) => node.id === "Idle")!;
    const noteBox = idle.note!;
    expect(noteBox.x).toBeGreaterThanOrEqual(idle.x + idle.width);
    for (const other of layout.nodes) {
      if (other.id === "Idle") continue;
      const overlaps =
        other.x < noteBox.x + noteBox.width &&
        other.x + other.width > noteBox.x &&
        other.y < noteBox.y + noteBox.height &&
        other.y + other.height > noteBox.y;
      expect(overlaps, `${other.id} sits on Idle's note`).toBe(false);
    }
  });

  it("draws the composite as a frame round its children, which transitions start and end on", async () => {
    const { container, layout } = await drawGraph(STATE);
    const frame = nodeElement(container, "Working");
    expect(frame.classList.contains("archer-element-group")).toBe(true);
    const working = layout.groups.find((group) => group.id === "Working")!;
    const fetch = layout.nodes.find((node) => node.id === "Fetch")!;
    expect(fetch.x).toBeGreaterThanOrEqual(working.x);
    expect(fetch.x + fetch.width).toBeLessThanOrEqual(working.x + working.width);
    expect(edgeElement(container, "Route--Working")).toBeDefined();
    expect(edgeElement(container, "Working--Split")).toBeDefined();
  });
});

describe("states take selection, emphasis and comments like any node", () => {
  it("marks a selected state and a selected composite as selected", async () => {
    const { container } = await drawGraph(STATE, { selection: { nodeIds: ["Idle", "Working"] } });
    expect(nodeElement(container, "Idle").classList.contains("selected")).toBe(true);
    expect(nodeElement(container, "Working").classList.contains("selected")).toBe(true);
    expect(nodeElement(container, "Working").getAttribute("aria-pressed")).toBe("true");
  });

  it("emphasises a state, a composite and a transition", async () => {
    const emphasis = parseEmphasis({
      id: "loop",
      viewId: STATE.view.id,
      title: "The loop",
      groups: [
        { id: "g", style: "highlight", palette: "coral", nodes: ["Idle", "Working"], edges: ["Idle--Checking"] },
      ],
    });
    const { container } = await drawGraph(STATE, { emphasis });
    expect(nodeElement(container, "Idle").classList.contains("archer-emph")).toBe(true);
    expect(nodeElement(container, "Working").classList.contains("archer-emph")).toBe(true);
    expect(edgeElement(container, "Idle--Checking").classList.contains("archer-emph")).toBe(true);
  });

  it("marks what a comment is about, on a composite as on a state", async () => {
    const { container } = await drawGraph(STATE, {
      commented: { nodeIds: new Set(["Idle", "Working"]), edgeIds: new Set(), groupIds: new Set() },
    });
    expect(nodeElement(container, "Idle").classList.contains("archer-commented")).toBe(true);
    expect(nodeElement(container, "Working").classList.contains("archer-commented")).toBe(true);
    expect(nodeElement(container, "Working").getAttribute("aria-label")).toBe("Working, composite state, has comments");
  });

  it("anchors a comment on a composite as a node, the way the server reads it", async () => {
    const { container } = await drawGraph(STATE);
    const drawnModel = { type: "graph" as const, view: projectGraph(STATE) };
    expect(anchorAt(nodeElement(container, "Working"), drawnModel)).toEqual({
      kind: "node",
      id: "Working",
      label: "Working",
    });
    expect(anchorAt(nodeElement(container, "Idle"), drawnModel)).toEqual({
      kind: "node",
      id: "Idle",
      label: "Waiting for work",
    });
    // Not offered as a flowchart subgraph is: the server has no group of that id.
    expect(diagramChoices(drawnModel, [], []).map((choice) => choice.anchor.kind)).toEqual(["view"]);
    expect(diagramChoices(drawnModel, ["Working"], [])[0].anchor).toEqual({
      kind: "node",
      id: "Working",
      label: "Working",
    });
  });

  it("selects a composite from the keyboard, as a node", async () => {
    const clicks: string[] = [];
    const { container } = await drawGraph(STATE, { onNodeClick: (id) => clicks.push(id) });
    const frame = nodeElement(container, "Working");
    expect(frame.getAttribute("role")).toBe("button");
    frame.focus();
    fireEvent.keyDown(frame, { key: "Enter" });
    expect(clicks).toEqual(["Working"]);
  });
});

describe("a state selection reaches the agent as nodes and edges", () => {
  type Published = { nodes: { id: string; label: string }[]; edges: { id: string; source: string; target: string }[] };
  const lastPublished = (): Published => {
    const posts = selectionPosts();
    const [, init] = posts[posts.length - 1] as [string, { body: string }];
    return JSON.parse(init.body) as Published;
  };

  it("publishes a clicked state, a Shift-clicked composite, and Cmd+A everything", async () => {
    const { container } = await mountAgentPresented(<App />, {
      envelope: STATE,
      views: [{ id: STATE.view.id, kind: "state", title: "States", registration: "durable" }],
      ready: (mounted) => expect(mounted.querySelectorAll(".react-flow__edge").length).toBe(15),
    });
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    fireEvent.click(screen.getByText("Waiting for work"));
    fireEvent.click(nodeElement(container, "Working"), { shiftKey: true });
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node.selected")).toHaveLength(2));
    await settleSelection();
    expect(lastPublished().nodes).toEqual([
      { id: "Idle", label: "Waiting for work" },
      { id: "Working", label: "Working" },
    ]);

    act(() => {
      fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    });
    await settleSelection();
    const all = lastPublished();
    expect(all.nodes.map((node) => node.id).sort()).toEqual(
      (STATE.model.states as { id: string }[]).map((s) => s.id).sort(),
    );
    expect(all.edges).toHaveLength(15);
  });
});
