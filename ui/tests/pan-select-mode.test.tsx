// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { HelpProvider } from "../src/app/HelpOverlay";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { projectEnvelope } from "../src/diagrams/projection";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { loadValidFixture } from "./fixtures";
let layout: LayoutResult;
beforeAll(async () => {
  layout = await computeLayout({
    viewId: "mode",
    kind: "freeform",
    title: "Mode",
    revision: "1",
    modelType: "freeform-graph",
    nodes: [
      { id: "a", label: "A", classes: [], shape: undefined, groupId: undefined },
      { id: "b", label: "B", classes: [], shape: undefined, groupId: undefined },
    ],
    edges: [{ id: "e1", source: "a", target: "b", label: "Calls" }],
    groups: [],
  });
});
afterEach(cleanup);
it("defaults to Hand and changes the actual React Flow gesture ownership in Select", async () => {
  const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} />);
  expect(screen.getByRole("button", { name: "Hand mode" })).toHaveAttribute("aria-pressed", "true");
  expect(container.querySelector(".react-flow__pane")).toHaveClass("draggable");
  expect(container.querySelector(".react-flow__pane")).not.toHaveClass("selection");
  await waitFor(() => expect(container.querySelector(".react-flow__edge")).not.toHaveClass("nopan"));
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  await waitFor(() => expect(container.querySelector(".react-flow__edge")).toHaveClass("nopan"));
});
it("opens a sequence diagram in Hand mode too", () => {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence") throw new Error("bad sequence fixture");
  render(
    <DiagramCanvas state={{ status: "sequence-ready", sequenceLayout: computeSequenceLayout(projection.view) }} />,
  );
  expect(screen.getByRole("button", { name: "Hand mode" })).toHaveAttribute("aria-pressed", "true");
});
it("Hand ignores sequence pointer selection while keyboard selection remains available", () => {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence") throw new Error("bad sequence fixture");
  const onNodeClick = vi.fn();
  render(
    <DiagramCanvas
      state={{ status: "sequence-ready", sequenceLayout: computeSequenceLayout(projection.view) }}
      onNodeClick={onNodeClick}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Hand mode" }));
  const client = screen.getByRole("button", { name: "Client" });
  fireEvent.click(client);
  expect(onNodeClick).not.toHaveBeenCalled();
  fireEvent.keyDown(client, { key: "Enter" });
  expect(onNodeClick).toHaveBeenCalledWith("client", false);
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  fireEvent.click(client);
  expect(onNodeClick).toHaveBeenCalledTimes(2);
});

it.each([false, true])("primaryShell=%s exposes exactly the intended canvas Help", (primaryShell) => {
  render(
    <HelpProvider value={{ open: false, toggle: vi.fn(), hide: vi.fn() }}>
      <DiagramCanvas state={{ status: "ready", layout }} primaryShell={primaryShell} />
    </HelpProvider>,
  );
  expect(screen.queryAllByRole("button", { name: "Keyboard shortcuts" })).toHaveLength(primaryShell ? 0 : 1);
});
