// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout } from "../src/layout/elk-adapter";
import { toXFlowNodes, toXFlowEdges } from "../src/diagrams/xflow-adapter";

afterEach(cleanup);
it("Select preserves the real adapter's decorative, semantic and default selection policies; Hand disables every item", async () => {
  const layout = await computeLayout({
    viewId: "policies",
    kind: "freeform",
    title: "Policies",
    revision: "1",
    modelType: "freeform-graph",
    nodes: [
      { id: "a", label: "A", shape: undefined, classes: [], groupId: "decoration" },
      { id: "b", label: "B", shape: undefined, classes: [], groupId: "boundary" },
    ],
    edges: [{ id: "e1", source: "a", target: "b", label: "Calls" }],
    groups: [
      { id: "decoration", label: "Decorative subgraph", parentId: undefined },
      { id: "boundary", label: "Semantic boundary", parentId: undefined, element: true },
    ],
  });
  const adapted = toXFlowNodes(layout);
  expect(adapted.find((node) => node.id === "group:decoration")?.selectable).toBe(false);
  expect(adapted.find((node) => node.id === "boundary")?.selectable).toBe(true);
  expect(adapted.find((node) => node.id === "a")?.selectable).toBeUndefined();
  expect(toXFlowEdges(layout)[0]?.selectable).toBe(true);
  const { container } = render(
    <DiagramCanvas state={{ status: "ready", layout }} onNodeClick={vi.fn()} onEdgeClick={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  const node = (id: string) => container.querySelector(`.react-flow__node[data-id="${id}"]`);
  expect(node("group:decoration")).not.toHaveClass("selectable");
  expect(node("boundary")).toHaveClass("selectable");
  expect(node("a")).toHaveClass("selectable");
  await waitFor(() => expect(container.querySelector(".react-flow__edge")).toHaveClass("selectable"));
  fireEvent.click(screen.getByRole("button", { name: "Hand mode" }));
  await waitFor(() =>
    expect(container.querySelectorAll(".react-flow__node.selectable,.react-flow__edge.selectable")).toHaveLength(0),
  );
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  expect(node("group:decoration")).not.toHaveClass("selectable");
  expect(node("boundary")).toHaveClass("selectable");
  expect(node("a")).toHaveClass("selectable");
  await waitFor(() => expect(container.querySelector(".react-flow__edge")).toHaveClass("selectable"));
});
