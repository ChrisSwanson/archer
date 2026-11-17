// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DiagramSidePanel, PANEL_COLLAPSED_STORAGE } from "../src/app/diagram-panel";
import { useDiagramModes } from "../src/app/diagram-mode";
import { projectEnvelope } from "../src/diagrams/projection";
import { loadModelEnvelope } from "./fixtures";

const projected = projectEnvelope(loadModelEnvelope("c4", "minimal"));
if (!projected.ok || projected.type !== "graph") throw new Error("fixture");
const model = { type: "graph" as const, view: projected.view };
function Panel({
  details,
}: {
  details: { content: React.ReactNode; onClose: () => void; onDismiss: () => void } | null;
}) {
  const modes = useDiagramModes({
    walkthrough: null,
    highlights: null,
    edit: { on: false },
    selection: null,
    view: { framing: 0, read: () => null, restore: () => undefined },
  });
  return (
    <DiagramSidePanel
      modes={modes}
      walks={[]}
      highlightCount={0}
      walkthrough={null}
      keyModel={model}
      switcher={{ highlights: () => undefined, walkthroughs: () => undefined }}
      details={details}
    >
      <button type="button">Drawing context</button>
    </DiagramSidePanel>
  );
}
afterEach(() => {
  cleanup();
  localStorage.clear();
});
test("Details replace an empty mode slot, retain the Key, and restore the viewer's collapsed choice", () => {
  localStorage.setItem(PANEL_COLLAPSED_STORAGE, "true");
  const mounted = render(<Panel details={null} />);
  expect(screen.getByRole("button", { name: "Expand diagram panel" })).toBeVisible();
  const details = { content: <p>Full source description</p>, onClose: vi.fn(), onDismiss: vi.fn() };
  mounted.rerender(<Panel details={details} />);
  expect(screen.getByText("Full source description").closest(".archer-panel-top")).toHaveAttribute(
    "data-top",
    "details",
  );
  expect(screen.getByRole("region", { name: "Diagram Key" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Collapse diagram panel" }));
  expect(details.onClose).toHaveBeenCalledOnce();
  mounted.rerender(<Panel details={null} />);
  expect(screen.getByRole("button", { name: "Expand diagram panel" })).toBeVisible();
});
