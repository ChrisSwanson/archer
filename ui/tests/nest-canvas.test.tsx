// @vitest-environment jsdom
//
// The nested view's controls on the graph canvas (ADR 0029; plan T7). Where they land on screen
// and what a press under a real pointer does is the browser suite's (`nested-view.e2e.ts`); this
// pins what is drawn and what a press asks the page for.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";
import { nestView } from "../src/nesting/nest-view";
import { nestControls } from "../src/nesting/NestToggles";

const full: ProjectedView = {
  viewId: "shop",
  kind: "flowchart",
  title: "Shop",
  revision: "1",
  modelType: "freeform-graph",
  nodes: [
    { id: "web", label: "Web", shape: undefined, classes: [], groupId: undefined },
    { id: "orders", label: "Orders", shape: undefined, classes: [], groupId: "backend" },
    { id: "billing", label: "Billing", shape: undefined, classes: [], groupId: "backend" },
    { id: "ledger", label: "Ledger", shape: undefined, classes: [], groupId: "money" },
  ],
  edges: [
    { id: "e1", source: "web", target: "orders", label: "orders" },
    { id: "e2", source: "orders", target: "billing", label: undefined },
  ],
  groups: [
    { id: "backend", label: "Backend", parentId: undefined },
    { id: "money", label: "Money", parentId: "backend" },
  ],
};

afterEach(cleanup);

describe("nested view controls", () => {
  it("draws a + and the inside caption on a closed box, and a press asks to open it", async () => {
    const layout = await computeLayout(nestView(full, []).view);
    const onToggle = vi.fn();
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} nesting={{ onToggle }} />);
    const open = screen.getByRole("button", { name: "Open Backend" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    // The reference's mark (rule 8): a 20 px rounded square, the glyph stroked, never a font character;
    // its corner is the box's less the gap, so the two curves run side by side: a 6 px corner at zoom 1
    // leaves none, a square "+" (toggle-place.test.ts has the rule at other radii and zooms).
    expect(open.textContent).toBe("");
    expect(open.querySelector("svg.archer-nest-toggle-mark rect")?.getAttribute("rx")).toBe("0");
    expect(open.querySelector("svg.archer-nest-toggle-mark path")?.getAttribute("d")).toBe("M6 10h8M10 6v8");
    expect(container.querySelector(".archer-nest-closed .archer-nest-inside")?.textContent).toBe("3 elements inside");
    expect(container.querySelector(".react-flow")).toHaveClass("archer-nested");
    fireEvent.click(open);
    expect(onToggle).toHaveBeenCalledWith("backend", true);
  });

  it("draws a − on every open frame and a + on the closed box inside it", async () => {
    const layout = await computeLayout(nestView(full, ["backend"]).view);
    const onToggle = vi.fn();
    render(<DiagramCanvas state={{ status: "ready", layout }} nesting={{ onToggle }} />);
    const close = screen.getByRole("button", { name: "Close Backend" });
    expect(close).toHaveAttribute("aria-expanded", "true");
    expect(close).toHaveClass("archer-nest-toggle-open");
    expect(close.querySelector("svg.archer-nest-toggle-mark path")?.getAttribute("d")).toBe("M6 10h8");
    expect(screen.getByRole("button", { name: "Open Money" })).toBeInTheDocument();
    fireEvent.click(close);
    expect(onToggle).toHaveBeenCalledWith("backend", false);
  });

  it("draws no controls in the full view", async () => {
    const layout = await computeLayout(full);
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} />);
    expect(container.querySelector("[data-nest-toggle]")).toBeNull();
    expect(container.querySelector(".react-flow")).not.toHaveClass("archer-nested");
  });

  it("draws a bundle heavier by its member count", async () => {
    const two: ProjectedView = {
      ...full,
      edges: [...full.edges, { id: "e4", source: "web", target: "billing", label: undefined }],
    };
    const layout = await computeLayout(nestView(two, []).view);
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} nesting={{ onToggle: vi.fn() }} />);
    expect(layout.edges.some((edge) => edge.id.startsWith("bundle:"))).toBe(true);
    await waitFor(() => {
      const bundle = [...container.querySelectorAll<SVGElement>(".react-flow__edge")].find((edge) =>
        edge.dataset.id?.startsWith("bundle:"),
      );
      expect(bundle?.getAttribute("class") ?? "").toContain("archer-edge-bundle archer-bundle-two");
    });
  });

  it("lists controls in reading order, one per container drawn", async () => {
    const layout = await computeLayout(nestView(full, ["backend", "money"]).view);
    expect(nestControls(layout).map((c) => [c.groupId, c.open])).toEqual([
      ["backend", true],
      ["money", true],
    ]);
  });
});
