// @vitest-environment jsdom
//
// On a phone the diagram side panel (0.6.4, D5: the Highlights legend and the diagram key) is one chip in a
// strip under the drawing, opening a sheet; nothing floats over the canvas (G1). On a larger screen the panel
// sits beside the drawing and the strip is empty. The dock keeps one sheet open at a time.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DockedPanel, StageDockContext, StageDockStrip } from "../src/app/stage-dock";
import { DiagramSidePanel } from "../src/app/diagram-panel";
import type { DiagramModes } from "../src/app/diagram-mode";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { parseEmphasis } from "../src/emphasis/contract";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { projectEnvelope } from "../src/diagrams/projection";
import { loadValidFixture } from "./fixtures";
import { installViewport } from "./match-media";

let layout: LayoutResult;
beforeAll(async () => {
  const projection = projectEnvelope(loadValidFixture("minimal-data-flow.json"));
  if (!projection.ok || projection.type !== "graph") throw new Error("fixture did not project");
  layout = await computeLayout(projection.view);
});
afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const emphasis = parseEmphasis({
  id: "path",
  viewId: "minimal-data-flow",
  title: "The write path",
  groups: [
    { id: "write", style: "highlight", label: "Write", nodes: ["web"] },
    { id: "read", style: "highlight", label: "Read", nodes: ["api"] },
  ],
})!;
const journey = {
  type: "journey",
  view: {
    viewId: "j",
    title: "J",
    revision: "r",
    kind: "journey",
    modelType: "journey",
    nodes: [],
    edges: [],
    groups: [],
    actors: ["Reader"],
    sections: [{ id: "s", label: "Stage", tasks: [{ id: "t", label: "Task", score: 4, actors: ["Reader"] }] }],
  },
} as const;

const modes = (): DiagramModes => ({
  mode: "highlights",
  enter: vi.fn(),
  exit: vi.fn(),
  press: vi.fn(),
  saved: () => null,
  highlightsOffered: false,
  leftFrom: null,
});
function Stage({ children, other = false, at = modes() }: { children: ReactNode; other?: boolean; at?: DiagramModes }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  return (
    <div className="archer-stage">
      <StageDockContext.Provider value={{ host }}>
        <DiagramSidePanel
          modes={at}
          switcher={{ highlights: vi.fn(), walkthroughs: vi.fn() }}
          walks={[]}
          highlightCount={1}
          walkthrough={null}
          keyModel={journey as never}
        >
          <div className="archer-diagram-content">{children}</div>
        </DiagramSidePanel>
        {other && host !== null ? (
          <DockedPanel host={host} order={3} name="Other" chip={<span>Other</span>}>
            <p>other</p>
          </DockedPanel>
        ) : null}
      </StageDockContext.Provider>
      <StageDockStrip onHost={setHost} />
    </div>
  );
}
const mount = (other = false, at = modes()) =>
  render(
    <Stage other={other} at={at}>
      <DiagramCanvas state={{ status: "ready", layout }} emphasis={emphasis} />
    </Stage>,
  );
const dock = () => document.querySelector<HTMLElement>(".archer-stage-dock")!;

it("on a phone, the panel is one chip under the drawing whose sheet holds the live legend and the key", () => {
  installViewport({ width: 390, coarse: true });
  mount();
  const content = document.querySelector(".archer-diagram-content")!;
  // Nothing floats over the drawing, and nothing sits beside it.
  expect(content.querySelector(".archer-emph-legend, .archer-diagram-key")).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Diagram panel" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Highlights" })).toBeNull();
  const shortcut = vi.fn();
  window.addEventListener("keydown", shortcut);
  try {
    const chip = within(dock()).getByRole("button", { name: "Highlights" });
    fireEvent.click(chip);
    const sheet = screen.getByRole("dialog", { name: "Highlights" });
    expect(within(sheet).getByRole("region", { name: "Highlights" })).toBeDefined();
    expect(within(sheet).getByText("Satisfaction score")).toBeDefined();
    // The sheet's legend is the live one: a row still toggles its group.
    const row = within(sheet).getByRole("button", { name: /^Read/ });
    const before = row.getAttribute("aria-pressed");
    fireEvent.click(row);
    expect(row.getAttribute("aria-pressed")).not.toBe(before);
    fireEvent.keyDown(row, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip);
    // Escape closed the sheet and went no further: it did not reach the page's own shortcuts.
    expect(shortcut).not.toHaveBeenCalled();
    fireEvent.click(chip);
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    window.removeEventListener("keydown", shortcut);
  }
});

it("on a larger screen, the panel holds the legend and the key beside the drawing, and the strip is empty", () => {
  installViewport({ width: 1440, coarse: false });
  mount();
  expect(dock().childElementCount).toBe(0);
  const panel = screen.getByRole("complementary", { name: "Diagram panel" });
  expect(within(panel).getByRole("region", { name: "Highlights" })).toBeDefined();
  expect(within(panel).getByRole("region", { name: "Diagram Key" })).toBeDefined();
  expect(document.querySelector(".archer-diagram-content .archer-emph-legend")).toBeNull();
});

it("keeps one sheet open at a time, whichever way the next chip is pressed", () => {
  installViewport({ width: 390, coarse: true });
  mount(true);
  fireEvent.click(within(dock()).getByRole("button", { name: "Highlights" }));
  // A keyboard press is a click with no pointerdown before it.
  fireEvent.click(within(dock()).getByRole("button", { name: "Other" }));
  expect(screen.getAllByRole("dialog").map((dialog) => dialog.getAttribute("aria-label"))).toEqual(["Other"]);
});

it("Escape closes an open sheet from outside it too, goes no further, and leaves the highlights on", () => {
  installViewport({ width: 390, coarse: true });
  const at = modes();
  mount(false, at);
  const chip = within(dock()).getByRole("button", { name: "Highlights" });
  fireEvent.click(chip);
  chip.focus();
  const shortcut = vi.fn();
  window.addEventListener("keydown", shortcut);
  try {
    fireEvent.keyDown(chip, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(shortcut).not.toHaveBeenCalled();
    expect(at.exit).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", shortcut);
  }
});

it("a caller can clear an explicit preview when its sheet folds outside or another sheet opens", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const onFold = vi.fn();
  render(
    <DockedPanel host={host} order={0} name="Details" chip="Details" defaultOpen onFold={onFold}>
      <button type="button">Preview</button>
    </DockedPanel>,
  );
  fireEvent.pointerDown(document.body);
  expect(onFold).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  fireEvent(host, new CustomEvent("archer-dock-opened", { detail: "other-sheet" }));
  expect(onFold).toHaveBeenCalledTimes(2);
  host.remove();
});
