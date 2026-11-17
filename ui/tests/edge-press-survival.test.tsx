// @vitest-environment jsdom
//
// An edge's element must SURVIVE the press that clicks it.
//
// The bug this pins: clicking an edge with a real mouse selected nothing.
// A browser turns a press into a `click` only if the element that took the
// `mousedown` is still in the document at `mouseup`. Here it was not:
//
//   mousedown on the edge -> the browser focuses the edge's `<g>` (it carries
//   a tabindex) -> the surface's `onFocus` moves the keyboard stop and ring
//   -> `Flow` builds a new `nodes` array -> React Flow re-adopts every node as
//   UNMEASURED (the flow is controlled with no `onNodesChange`, so the sizes it
//   measured were never in our node objects) -> it drops their handle bounds ->
//   every `EdgeWrapper` returns null until the nodes are measured again ->
//   every edge `<svg>` is unmounted and a new one mounted.
//
// The `mouseup` then landed on a different element and Chromium dispatched no
// `click` at all, so `onEdgeClick` never ran.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. Every other edge test uses
// `fireEvent.click`, which hands React a `click` directly: no press, no focus
// change in between, and therefore no chance for the element to be replaced.
// That is how the suite stayed green over a canvas no mouse could select an
// edge on. jsdom still cannot do what the browser does -- it does not move
// focus on `mousedown`, does not hit-test, and does not synthesise `click`
// from a down/up pair -- so these tests perform the browser's focus step by
// hand and assert the STRUCTURAL property the click depends on: the same
// element is still connected afterwards. They fail against the unfixed code
// for the real reason (the element is replaced). They do not prove a real
// click lands; `tests/browser/graph-pointer.e2e.ts` (in the Rust implementation, not in this tree) does that against the Rust binary.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState, type JSX } from "react";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";

const view: ProjectedView = {
  viewId: "press-view",
  kind: "c4-context",
  title: "Press",
  revision: "1",
  modelType: "architecture-graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: "g" },
    { id: "c", label: "C", shape: undefined, classes: [], groupId: "g" },
  ],
  edges: [
    { id: "e1", source: "a", target: "b", label: "calls" },
    { id: "e2", source: "b", target: "c", label: "reads" },
  ],
  groups: [{ id: "g", label: "Group", parentId: undefined }],
};

let layout: LayoutResult;

beforeAll(async () => {
  layout = await computeLayout(view);
});

afterEach(cleanup);

type Picked = { nodeIds: string[]; edgeIds: string[] };
const EMPTY: Picked = { nodeIds: [], edgeIds: [] };

/**
 * STATEFUL, like `App`: a click changes the `selection` prop, and it is the
 * resulting change to `nodes`/`edges` that this file is about.
 */
function Harness(props: { onEdgeClick: (id: string) => void }): JSX.Element {
  const [selection, setSelection] = useState<Picked>(EMPTY);
  return (
    <DiagramCanvas
      state={{ status: "ready", layout }}
      selection={selection}
      hasSelection={selection.nodeIds.length + selection.edgeIds.length > 0}
      onNodeClick={(id) => setSelection({ nodeIds: [id], edgeIds: [] })}
      onEdgeClick={(id) => {
        props.onEdgeClick(id);
        setSelection({ nodeIds: [], edgeIds: [id] });
      }}
    />
  );
}

function edgeElement(container: HTMLElement, id: string): SVGElement | null {
  return container.querySelector<SVGElement>(`.react-flow__edge[data-id="${id}"]`);
}

/** React Flow renders edges only once its nodes have been measured. */
async function mountedEdge(container: HTMLElement, id: string): Promise<SVGElement> {
  fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
  await waitFor(() => expect(edgeElement(container, id)).not.toBeNull());
  return edgeElement(container, id)!;
}

/** Long enough for React Flow's store sync and the stubbed ResizeObserver. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/**
 * The first half of a real press: `mousedown`, then the focus move a browser
 * makes to the nearest focusable ancestor -- the edge's own `<g>`.
 */
async function pressDown(edge: SVGElement): Promise<Element> {
  const band = edge.querySelector(".react-flow__edge-interaction")!;
  fireEvent.mouseDown(band);
  edge.focus();
  await settle();
  return band;
}

describe("an edge element across the press that clicks it", () => {
  it("keeps its pointer corridor and draws the focus mark on a separate element", async () => {
    const { container } = render(<Harness onEdgeClick={() => {}} />);
    const edge = await mountedEdge(container, "e1");

    const band = await pressDown(edge);
    const mark = edge.querySelector(".archer-edge-focus-mark");

    // The corridor is stated on the element and is the same path as the mark;
    // the mark is not the corridor (`hit-corridor-guard.test.ts` has the CSS half).
    expect(band.getAttribute("stroke-width")).toBe("24");
    expect(mark).not.toBeNull();
    expect(mark).not.toBe(band);
    expect(mark!.getAttribute("d")).toBe(band.getAttribute("d"));
  });

  it("is the same connected element at mouseup as at mousedown", async () => {
    const { container } = render(<Harness onEdgeClick={() => {}} />);
    const edge = await mountedEdge(container, "e1");

    const band = await pressDown(edge);

    expect(edge.isConnected).toBe(true);
    expect(band.isConnected).toBe(true);
    expect(edgeElement(container, "e1")).toBe(edge);
  });

  it("survives a press that takes the keyboard ring off a node", async () => {
    // The ring leaving a node is a REAL change to the `nodes` prop, so this
    // case cannot be fixed by keeping the array's identity stable.
    const { container } = render(<Harness onEdgeClick={() => {}} />);
    await mountedEdge(container, "e2");
    const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]')!;
    node.focus();
    await settle();
    expect(node.className).toContain("archer-kbd-focus");
    // Taken AFTER the ring went on, so this case measures the press alone.
    const edge = await mountedEdge(container, "e2");

    await pressDown(edge);

    expect(node.className).not.toContain("archer-kbd-focus");
    expect(edge.isConnected).toBe(true);
  });

  it("delivers the click of that press to onEdgeClick", async () => {
    const onEdgeClick = vi.fn();
    const { container } = render(<Harness onEdgeClick={onEdgeClick} />);
    const edge = await mountedEdge(container, "e1");

    const band = await pressDown(edge);
    // A browser dispatches `click` only when the pressed element is still in
    // the document; this is that rule, applied by hand.
    fireEvent.mouseUp(band);
    if (band.isConnected) {
      fireEvent.click(band);
    }

    expect(onEdgeClick).toHaveBeenCalledWith("e1");
    await waitFor(() => expect(edgeElement(container, "e1")?.getAttribute("class")).toContain("selected"));
  });

  it("keeps every edge mounted when a selection changes the nodes", async () => {
    // The general form: no change to the `nodes` prop may cost the edges
    // their elements, whatever caused it.
    const { container } = render(<Harness onEdgeClick={() => {}} />);
    const first = await mountedEdge(container, "e1");
    const second = await mountedEdge(container, "e2");

    fireEvent.click(container.querySelector('.react-flow__node[data-id="a"]')!);
    await settle();

    expect(container.querySelector('.react-flow__node[data-id="a"]')?.className).toContain("selected");
    expect(first.isConnected).toBe(true);
    expect(second.isConnected).toBe(true);
  });
});
