// @vitest-environment jsdom
import { render } from "@testing-library/react";
import type { ReactFlowProps } from "@xyflow/react";
import { expect, it, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout } from "../src/layout/elk-adapter";

const captured = vi.hoisted(() => ({ end: null as ReactFlowProps["onMoveEnd"] | null }));
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlow: (props: ReactFlowProps) => {
      captured.end = props.onMoveEnd;
      return <actual.ReactFlow {...props} />;
    },
  };
});

it("ignores the real delayed move-end callback after its canvas unmounts", async () => {
  const layout = await computeLayout({
    viewId: "unmount",
    kind: "freeform",
    title: "Unmount",
    revision: "1",
    modelType: "freeform-graph",
    nodes: [{ id: "a", label: "A", shape: undefined, classes: [], groupId: undefined }],
    edges: [],
    groups: [],
  });
  const { unmount } = render(<DiagramCanvas state={{ status: "ready", layout }} />);
  const end = captured.end;
  expect(end).toBeTypeOf("function");
  unmount();
  // Mirrors jsdom teardown after the vendor's delayed wheel-end timer.
  vi.stubGlobal("window", undefined);
  try {
    expect(() => end?.(null, { x: 0, y: 0, zoom: 1 })).not.toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});
