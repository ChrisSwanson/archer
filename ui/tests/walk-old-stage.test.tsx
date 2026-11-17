// @vitest-environment jsdom
//
// The old version's stage lays its diagram out through the page's worker, like the live canvas, so a big
// diagram does not block the page (ADR 0034 §3).
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const background = vi.hoisted(() => vi.fn(() => new Promise<never>(() => undefined)));
const mainThread = vi.hoisted(() => vi.fn(() => new Promise<never>(() => undefined)));
vi.mock("../src/layout/elk-worker-transport", () => ({ computeBackgroundLayout: background }));
vi.mock("../src/layout/elk-adapter", () => ({ computeLayout: mainThread }));
vi.mock("../src/diagrams/DiagramCanvas", () => ({ DiagramCanvas: () => null }));

import { WalkthroughStage } from "../src/walkthroughs/OldVersionStage";

afterEach(cleanup);

it("asks the layout worker, not the main thread", () => {
  const oldView = {
    viewId: "v",
    kind: "flowchart",
    title: "V",
    revision: "r",
    modelType: "freeform-graph",
    nodes: [],
    edges: [],
    groups: [],
  };
  const walkthroughs = {
    walk: { id: "w", title: "W", steps: [], status: "current", old: true, outOfDate: [] },
    state: { open: true, id: "w", count: 0, step: 1, playing: false },
    old: { status: "found", id: "w", commit: "a", committedAt: "2026-08-12T10:00:00Z", view: oldView },
    oldView,
    oldRender: null,
  };
  render(<WalkthroughStage walkthroughs={walkthroughs as never} />);
  expect(background).toHaveBeenCalledTimes(1);
  expect(mainThread).not.toHaveBeenCalled();
});
