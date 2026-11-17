// @vitest-environment jsdom
// ux:A11Y-5: edges named with their ends, handles by their node's label, zoom buttons in sentence case.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { toXFlowEdges } from "../src/diagrams/xflow-adapter";
import type { LayoutResult } from "../src/layout/elk-adapter";

afterEach(cleanup);

const layout: LayoutResult = {
  direction: "tb",
  nodes: [
    { id: "web", label: "Web app", shape: "rect", classes: [], x: 0, y: 0, width: 120, height: 48 },
    { id: "db", label: "Orders\ndatabase", shape: "rect", classes: [], x: 0, y: 160, width: 120, height: 64 },
  ],
  edges: [
    {
      id: "e1",
      source: "web",
      target: "db",
      label: "writes",
      points: [
        { x: 60, y: 48 },
        { x: 60, y: 160 },
      ],
    },
  ],
  groups: [],
} as unknown as LayoutResult;

it("names edges, handles and zoom controls for a screen reader", () => {
  const { container } = render(
    <DiagramCanvas
      state={{ status: "ready", layout }}
      onNodeClick={() => {}}
      authoring={{ enabled: true, positions: {} }}
    />,
  );
  expect(toXFlowEdges(layout)[0]?.ariaLabel).toBe("Web app → Orders database: writes");
  const handles = [...container.querySelectorAll(".react-flow__handle")].map((h) => h.getAttribute("aria-label"));
  expect(handles).toEqual(
    expect.arrayContaining([
      "Connect into Web app",
      "Connect from Web app",
      "Connect into Orders database",
      "Connect from Orders database",
    ]),
  );
  expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
});
