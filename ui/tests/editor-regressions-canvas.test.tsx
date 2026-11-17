// @vitest-environment jsdom
// Editor fix-round regressions on the graph canvas (React Flow) alone.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import type { LayoutResult } from "../src/layout/elk-adapter";

afterEach(() => {
  cleanup();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});
/** jsdom has no `elementFromPoint` (no hit-testing): what is "under the pointer" is set by the test. */
function pointUnder(): { set: (element: Element | null) => void } {
  let under: Element | null = null;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, writable: true, value: () => under });
  return {
    set: (element) => {
      under = element;
    },
  };
}
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
  edges: [],
};

test("a connection dropped on a shape's body, not on a handle, connects to that shape (ux:F7)", async () => {
  const onConnect = vi.fn();
  const { container } = render(
    <DiagramCanvas state={{ status: "ready", layout }} authoring={{ onConnect, onNodeMove: vi.fn() }} />,
  );
  const node = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  await waitFor(() => expect(node("a")?.querySelector(".react-flow__handle.source.connectable")).not.toBeNull());
  const handle = node("a").querySelector<HTMLElement>(".react-flow__handle.source")!;
  // jsdom does no hit-testing: the point under the release is b's body (its label), never a handle.
  const body = (node("b").firstElementChild as HTMLElement) ?? node("b");
  pointUnder().set(body);
  // Far from every handle (jsdom measures them all at 0,0), so React Flow finds no handle to snap to.
  fireEvent.mouseDown(handle, { button: 0, clientX: 4000, clientY: 4000 });
  for (let x = 4005; x <= 4050; x += 5) fireEvent.mouseMove(document, { clientX: x, clientY: 4000, buttons: 1 });
  fireEvent.mouseUp(document, { clientX: 4050, clientY: 4000 });
  await waitFor(() => expect(onConnect).toHaveBeenCalledWith("a", "b"));
  expect(onConnect).toHaveBeenCalledTimes(1);
});

test("a connection dropped back on its own shape, or on empty canvas, connects nothing (ux:F7 control)", async () => {
  const onConnect = vi.fn();
  const { container } = render(
    <DiagramCanvas state={{ status: "ready", layout }} authoring={{ onConnect, onNodeMove: vi.fn() }} />,
  );
  const node = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  await waitFor(() => expect(node("a")?.querySelector(".react-flow__handle.source.connectable")).not.toBeNull());
  const handle = node("a").querySelector<HTMLElement>(".react-flow__handle.source")!;
  const under = pointUnder();
  for (const target of [node("a"), container.querySelector<HTMLElement>(".react-flow__pane")]) {
    under.set(target);
    fireEvent.mouseDown(handle, { button: 0, clientX: 4000, clientY: 4000 });
    for (let x = 4005; x <= 4050; x += 5) fireEvent.mouseMove(document, { clientX: x, clientY: 4000, buttons: 1 });
    fireEvent.mouseUp(document, { clientX: 4050, clientY: 4000 });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(onConnect).not.toHaveBeenCalled();
});

test("a connection dropped on a subgraph's frame is refused in plain words, never sent as an edit (speed-round 422)", async () => {
  const onConnect = vi.fn(),
    onRefused = vi.fn();
  const grouped: LayoutResult = {
    ...layout,
    width: 700,
    groups: [{ id: "inner", label: "Inner", parentId: undefined, x: 200, y: 0, width: 400, height: 200 }],
    nodes: layout.nodes.map((node) => (node.id === "b" ? { ...node, x: 40, groupId: "inner" } : node)),
  };
  const { container } = render(
    <DiagramCanvas
      state={{ status: "ready", layout: grouped }}
      authoring={{ onConnect, onRefused, onNodeMove: vi.fn() }}
    />,
  );
  const node = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  await waitFor(() => expect(node("a")?.querySelector(".react-flow__handle.source.connectable")).not.toBeNull());
  expect(node("group:inner")).not.toBeNull();
  const handle = node("a").querySelector<HTMLElement>(".react-flow__handle.source")!;
  pointUnder().set(node("group:inner"));
  fireEvent.mouseDown(handle, { button: 0, clientX: 4000, clientY: 4000 });
  for (let x = 4005; x <= 4050; x += 5) fireEvent.mouseMove(document, { clientX: x, clientY: 4000, buttons: 1 });
  fireEvent.mouseUp(document, { clientX: 4050, clientY: 4000 });
  await waitFor(() => expect(onRefused).toHaveBeenCalledWith(expect.stringMatching(/subgraph/i)));
  expect(onConnect).not.toHaveBeenCalled();
});

test("while editing, a press on a subgraph's frame selects nothing: no edit applies to it, so it never becomes a stale selection (speed-round group:backend)", async () => {
  const onNodeClick = vi.fn(),
    onPaneClick = vi.fn();
  const grouped: LayoutResult = {
    ...layout,
    width: 700,
    groups: [{ id: "inner", label: "Inner", parentId: undefined, x: 200, y: 0, width: 400, height: 200 }],
    nodes: layout.nodes.map((node) => (node.id === "b" ? { ...node, x: 40, groupId: "inner" } : node)),
  };
  const { container } = render(
    <DiagramCanvas
      state={{ status: "ready", layout: grouped }}
      authoring={{ onConnect: vi.fn(), onNodeMove: vi.fn() }}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
    />,
  );
  const node = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  await waitFor(() => expect(node("group:inner")).not.toBeNull());
  fireEvent.click(node("group:inner"));
  expect(onNodeClick).not.toHaveBeenCalled();
  expect(onPaneClick).toHaveBeenCalledTimes(1);
  fireEvent.click(node("b"));
  expect(onNodeClick).toHaveBeenCalledWith("b", false);
});
