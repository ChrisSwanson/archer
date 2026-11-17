// @vitest-environment jsdom
//
// The controls React Flow has no notion of: graph tools and help.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { HelpProvider, type HelpController } from "../src/app/HelpOverlay";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";

const view: ProjectedView = {
  viewId: "controls-view",
  kind: "c4-context",
  title: "Controls",
  revision: "1",
  modelType: "architecture-graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [{ id: "e1", source: "a", target: "b", label: "calls" }],
  groups: [],
};

let layout: LayoutResult;

beforeEach(async () => {
  layout = await computeLayout(view);
});

afterEach(cleanup);

const controller = (toggle: () => void): HelpController => ({ open: false, toggle, hide: () => {} });

describe("the graph-tools control", () => {
  it("is absent when the page offers no graph tools", () => {
    render(<DiagramCanvas state={{ status: "ready", layout }} />);

    expect(screen.queryByRole("button", { name: "Export, compare and more" })).toBeNull();
  });

  it("replaces the retired clear-selection button", () => {
    render(<DiagramCanvas state={{ status: "ready", layout }} tools={<button type="button">Export</button>} />);
    expect(screen.getByRole("button", { name: "Export, compare and more" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
  });
});

describe("the help control", () => {
  it("toggles the cheat sheet", () => {
    const toggle = vi.fn();
    render(
      <HelpProvider value={controller(toggle)}>
        <DiagramCanvas state={{ status: "ready", layout }} />
      </HelpProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));

    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("is absent outside a help provider, rather than dead", () => {
    // A button that looks live and does nothing is worse than no button.
    render(<DiagramCanvas state={{ status: "ready", layout }} />);

    expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
  });
});
