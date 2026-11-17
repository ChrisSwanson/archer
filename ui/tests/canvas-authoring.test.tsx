// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import type { LayoutResult } from "../src/layout/elk-adapter";

afterEach(cleanup);
const layout: LayoutResult = {
  width: 420,
  height: 200,
  direction: "lr",
  notation: "flowchart",
  groups: [],
  nodes: ["a", "b"].map((id, i) => ({
    id,
    label: id,
    x: i * 220,
    y: 40,
    width: 140,
    height: 80,
    shape: "rectangle",
    classes: [],
    groupId: undefined,
  })),
  edges: [
    {
      id: "e1",
      source: "a",
      target: "b",
      label: "uses",
      points: [
        { x: 140, y: 80 },
        { x: 220, y: 80 },
      ],
      labelAnchor: undefined,
    },
  ],
};

test("authoring overlays node positions and exposes drag/connect without changing frozen layout", () => {
  const before = JSON.stringify(layout);
  const { container } = render(
    <DiagramCanvas
      state={{ status: "ready", layout }}
      authoring={{ positions: { a: { x: 60, y: 90 } }, onNodeMove: vi.fn(), onConnect: vi.fn() }}
    />,
  );
  const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]')!;
  expect(node).toHaveClass("draggable");
  expect(node.style.transform).toBe("translate(60px,90px)");
  expect(node.querySelector(".react-flow__handle.source")).toHaveClass("connectable");
  expect(JSON.stringify(layout)).toBe(before);
});

test("direct node/edge label activation is authoring-only, including Enter", () => {
  const onNodeLabelEdit = vi.fn(),
    onEdgeLabelEdit = vi.fn();
  const { container, rerender } = render(
    <DiagramCanvas state={{ status: "ready", layout }} authoring={{ onNodeLabelEdit, onEdgeLabelEdit }} />,
  );
  const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]')!;
  fireEvent.doubleClick(node);
  expect(onNodeLabelEdit).toHaveBeenCalledWith("a");
  fireEvent.keyDown(node, { key: "Enter" });
  expect(onNodeLabelEdit).toHaveBeenCalledTimes(2);
  rerender(
    <DiagramCanvas
      state={{ status: "ready", layout }}
      authoring={{ disabled: true, onNodeLabelEdit, onEdgeLabelEdit }}
    />,
  );
  fireEvent.doubleClick(node);
  fireEvent.keyDown(node, { key: "Enter" });
  expect(onNodeLabelEdit).toHaveBeenCalledTimes(2);
  expect(node).not.toHaveClass("draggable");
});

test("reader canvas has no draggable nodes or connectable handles by default", () => {
  const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} />);
  const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]')!;
  expect(node).not.toHaveClass("draggable");
  expect(node.querySelector(".react-flow__handle.source")).not.toHaveClass("connectable");
});

test("grouped overlays are refused in their parent frame and report an attempted grouped drag", () => {
  const onNodeMove = vi.fn(),
    onRefused = vi.fn();
  const grouped: LayoutResult = {
    ...layout,
    groups: [{ id: "g", label: "Group", parentId: undefined, x: 20, y: 10, width: 400, height: 200 }],
    nodes: layout.nodes.map((node) => ({ ...node, groupId: "g" })),
  };
  const { container, rerender } = render(<DiagramCanvas state={{ status: "ready", layout: grouped }} />);
  const originalPosition = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]')!.style.transform;
  rerender(
    <DiagramCanvas
      state={{ status: "ready", layout: grouped }}
      authoring={{ positions: { a: { x: 900, y: 900 } }, onNodeMove, onRefused }}
    />,
  );
  const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]')!;
  expect(node).not.toHaveClass("draggable");
  expect(node.style.transform).toBe(originalPosition);
  fireEvent.mouseMove(node, { buttons: 1 });
  expect(onRefused).toHaveBeenCalledWith("Grouped node positions are fixed; move a top-level node instead.");
  expect(onNodeMove).not.toHaveBeenCalled();
});

test("explicit placement leaves Hand mode while ordinary authoring refresh preserves navigation mode", () => {
  const view = render(<DiagramCanvas state={{ status: "ready", layout }} authoring={{ positions: {} }} />);
  const hand = view.getByRole("button", { name: "Hand mode" });
  fireEvent.click(hand);
  expect(hand).toHaveAttribute("aria-pressed", "true");
  view.rerender(<DiagramCanvas state={{ status: "ready", layout: { ...layout } }} authoring={{ positions: {} }} />);
  expect(hand).toHaveAttribute("aria-pressed", "true");
  view.rerender(
    <DiagramCanvas state={{ status: "ready", layout }} authoring={{ positions: {}, onPanePlace: vi.fn() }} />,
  );
  expect(view.getByRole("button", { name: "Select mode" })).toHaveAttribute("aria-pressed", "true");
});

test("double-click or Enter on a state marker, fork, join or choice says why there is nothing to rename (smoke-b#13:c)", () => {
  const states: LayoutResult = {
    ...layout,
    notation: "state",
    nodes: [
      { ...layout.nodes[0]!, id: "start", label: "", figure: { type: "state", kind: "initial" } },
      { ...layout.nodes[1]!, id: "split", label: "", figure: { type: "state", kind: "fork" } },
    ],
    edges: [{ ...layout.edges[0]!, source: "start", target: "split" }],
  } as LayoutResult;
  const onNodeLabelEdit = vi.fn(),
    onRefused = vi.fn();
  const { container } = render(
    <DiagramCanvas state={{ status: "ready", layout: states }} authoring={{ onNodeLabelEdit, onRefused }} />,
  );
  fireEvent.doubleClick(container.querySelector<HTMLElement>('.react-flow__node[data-id="start"]')!);
  expect(onRefused).toHaveBeenLastCalledWith(expect.stringMatching(/start marker has no name/i));
  fireEvent.keyDown(container.querySelector<HTMLElement>('.react-flow__node[data-id="split"]')!, { key: "Enter" });
  expect(onRefused).toHaveBeenLastCalledWith(expect.stringMatching(/fork has no name/i));
  expect(onNodeLabelEdit).not.toHaveBeenCalled();
});
