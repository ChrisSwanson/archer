// @vitest-environment jsdom
//
// The page lays its diagrams out for the face it draws them in: Fira Sans, the
// one design's embedded face. Layout sizes every box from the text inside it,
// and the estimate is calibrated per face (`text-metrics-unified.test.ts`);
// this file proves the app asks for Fira Sans's widths.
//
// jsdom lays nothing out, so nothing here is a measured width. What is
// asserted is the ROWS each label is drawn in, which are the layout's own.
import { cleanup } from "@testing-library/react";
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
import { nodeBox } from "../src/layout/graph-metrics";
import { MockEventSource, mountAgentPresented, restoreLocation } from "./app-harness";

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

// Over a node's line in DejaVu Sans Bold, which the estimate was calibrated to
// before a face was embedded (200px), and inside it in Fira Sans 600 at 14px
// with the page's tracking (174px, measured in Chromium).
const LABEL = "Web application (Next.js)";

const GRAPH = {
  schemaVersion: 2,
  view: { id: "alpha", kind: "data-flow", title: "Alpha" },
  revision: `sha256:${"a".repeat(64)}`,
  model: {
    type: "data-flow-graph",
    nodes: [
      { id: "db", label: LABEL },
      { id: "api", label: "API" },
    ],
    edges: [{ id: "reads", source: "api", target: "db", label: "reads" }],
    groups: [],
  },
};

/** The rows the node labelled `LABEL` is drawn in. */
function rows(container: HTMLElement): string[] {
  const node = [...container.querySelectorAll<HTMLElement>(".react-flow__node")].find(
    (candidate) => candidate.dataset.id === "db",
  );
  expect(node, "the db node").toBeDefined();
  return [...node!.querySelectorAll(".archer-node-label-row")].map((row) => row.textContent ?? "");
}

const mount = async (): Promise<HTMLElement> =>
  (
    await mountAgentPresented(<App />, {
      envelope: GRAPH,
      ready: (container) => {
        expect(container.querySelectorAll(".react-flow__node").length).toBe(2);
      },
    })
  ).container;

describe("a graph is laid out for Fira Sans", () => {
  it("keeps a label on the one line Fira Sans draws it on", async () => {
    expect(nodeBox(LABEL, undefined, [], "fira").lines).toEqual([LABEL]);
    const container = await mount();
    expect(rows(container)).toEqual(nodeBox(LABEL, undefined, [], "fira").lines);
  });
});
