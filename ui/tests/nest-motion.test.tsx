// @vitest-environment jsdom
//
// The motion of a press (ADR 0029 §5): it runs about half a second from the press's first layout,
// and the routed layout arriving mid-motion neither restarts nor strands it.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";
import { nestView } from "../src/nesting/nest-view";
import { installReducedMotion } from "./match-media";

const full: ProjectedView = {
  viewId: "m",
  kind: "flowchart",
  title: "m",
  revision: "1",
  modelType: "freeform-graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: "g" },
    { id: "c", label: "C", shape: undefined, classes: [], groupId: "g" },
  ],
  edges: [{ id: "e", source: "a", target: "b", label: undefined }],
  groups: [{ id: "g", label: "G", parentId: undefined }],
};

afterEach(cleanup);

it("ends the motion even when the routed layout lands mid-motion", async () => {
  installReducedMotion(false);
  const closed = await computeLayout(nestView(full, []).view);
  const open = await computeLayout(nestView(full, ["g"]).view);
  const routed = { ...open, edges: open.edges.map((edge) => ({ ...edge })) };
  const nesting = (pressKey: number) => ({ onToggle: () => undefined, pressKey });
  const { container, rerender } = render(
    <DiagramCanvas state={{ status: "ready", layout: closed }} nesting={nesting(0)} />,
  );
  rerender(<DiagramCanvas state={{ status: "ready", layout: open }} nesting={nesting(1)} />);
  await waitFor(() => expect(container.querySelector(".archer-nest-moving")).not.toBeNull());
  expect(container.querySelectorAll(".archer-nest-entering").length).toBe(2);
  rerender(<DiagramCanvas state={{ status: "ready", layout: routed }} nesting={nesting(1)} />);
  // The motion runs on real timers (~500 ms); a loaded host can delay it well past 2 s.
  // Both are awaited together: the canvas drops `archer-nest-moving` in its own commit, and the
  // nodes lose `archer-nest-entering` a commit later, once React Flow's store takes the new nodes
  // in a passive effect. waitFor can wake between the two (known failure O46). The stale class is
  // inert meanwhile: `nesting.css` animates it only under `.archer-nest-moving`.
  await waitFor(
    () => {
      expect(container.querySelector(".archer-nest-moving")).toBeNull();
      expect(container.querySelector(".archer-nest-entering")).toBeNull();
    },
    { timeout: 5000 },
  );
});
