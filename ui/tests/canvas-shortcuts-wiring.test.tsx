// @vitest-environment jsdom
//
// `canvas-shortcuts.test.ts` drives the hook with `enabled` passed by hand.
// That proves the hook honours the flag; it proves nothing about the canvas
// passing the RIGHT flag, and a regression that dropped the wiring -- or
// inverted it -- would leave that suite green.
//
// This is the seam test: the real `DiagramCanvas`, under a real
// `HelpProvider`, and an assertion on what the hook is actually handed.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const received: { enabled: boolean }[] = [];

vi.mock("../src/diagrams/canvas-shortcuts", () => ({
  useCanvasShortcuts: (options: { onFitView: () => void; enabled: boolean }) => {
    received.push({ enabled: options.enabled });
  },
}));

import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { HelpProvider, type HelpController } from "../src/app/HelpOverlay";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";

const view: ProjectedView = {
  viewId: "wiring-view",
  kind: "c4-context",
  title: "Wiring",
  revision: "1",
  modelType: "architecture-graph",
  nodes: [{ id: "a", label: "A", shape: undefined, classes: [], groupId: undefined }],
  edges: [],
  groups: [],
};

let layout: LayoutResult;

beforeEach(async () => {
  received.length = 0;
  layout = await computeLayout(view);
});

afterEach(cleanup);

const help = (open: boolean): HelpController => ({ open, toggle: () => {}, hide: () => {} });

function renderWithHelp(open: boolean): void {
  render(
    <HelpProvider value={help(open)}>
      <DiagramCanvas state={{ status: "ready", layout }} />
    </HelpProvider>,
  );
}

describe("the canvas hands its fit binding the right enabled flag", () => {
  it("enables it while the cheat sheet is closed", () => {
    renderWithHelp(false);

    expect(received.at(-1)).toEqual({ enabled: true });
  });

  it("disables it while the cheat sheet is open", () => {
    renderWithHelp(true);

    expect(received.at(-1)).toEqual({ enabled: false });
  });

  it("enables it when there is no help controller at all", () => {
    // The render tests mount the canvas bare. It must still fit on `1`.
    render(<DiagramCanvas state={{ status: "ready", layout }} />);

    expect(received.at(-1)).toEqual({ enabled: true });
  });
});
