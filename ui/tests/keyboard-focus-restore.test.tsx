// @vitest-environment jsdom
//
// The focus restoration, and the line it must not cross.
//
// React Flow replaces an edge's element on commits of its own subtree, and
// removing a focused element fires NO blur -- focus lands on `<body>` silently.
// `DiagramCanvas` answers that with a MutationObserver that puts focus back.
//
// The risk is the mirror image: a restore that fires when focus is somewhere
// legitimate drags the user off whatever they just reached. The control cluster
// and the emphasis legend live INSIDE the observed surface, so "focus left the
// surface" does not separate the two cases -- only "focus fell to the body"
// does. These tests pin that boundary from both sides, because the mechanism
// had no coverage at all when it was written.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useMemo, useState, type JSX } from "react";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { HelpProvider, type HelpController } from "../src/app/HelpOverlay";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";

const view: ProjectedView = {
  viewId: "restore-view",
  kind: "c4-context",
  title: "Restore",
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

beforeAll(async () => {
  layout = await computeLayout(view);
});

afterEach(cleanup);

/**
 * STATEFUL on purpose.
 *
 * The restore runs on render, so a harness whose buttons change nothing never
 * re-renders and never exercises it -- the tests below pass against a broken
 * guard if the canvas is static. In the real page both of these controls do
 * cause a render: the help button flips `helpOpen` in `App`, and the clear
 * control dispatches into the selection reducer. This models that.
 */
function Harness(props: { onToggleHelp: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<{ nodeIds: string[]; edgeIds: string[] }>({
    nodeIds: ["a"],
    edgeIds: [],
  });
  const controller = useMemo<HelpController>(
    () => ({
      open,
      toggle: () => {
        props.onToggleHelp();
        setOpen((wasOpen) => !wasOpen);
      },
      hide: () => setOpen(false),
    }),
    [open, props],
  );
  const canvasSelection = useMemo(() => selection, [selection]);

  return (
    <HelpProvider value={controller}>
      <DiagramCanvas
        state={{ status: "ready", layout }}
        selection={canvasSelection}
        hasSelection={selection.nodeIds.length > 0}
        onNodeClick={() => {}}
        onEdgeClick={() => {}}
        onClearSelection={() => setSelection({ nodeIds: [], edgeIds: [] })}
      />
    </HelpProvider>
  );
}

function renderCanvas(onToggleHelp = (): void => {}): HTMLElement {
  const { container } = render(<Harness onToggleHelp={onToggleHelp} />);
  return container;
}

/** React Flow renders edges only once its nodes have been measured. */
async function focusedEdge(container: HTMLElement): Promise<SVGElement> {
  await waitFor(() => {
    expect(container.querySelector('.react-flow__edge[data-id="e1"]')).not.toBeNull();
  });
  const edge = container.querySelector<SVGElement>('.react-flow__edge[data-id="e1"]')!;
  edge.focus();
  await waitFor(() => expect(document.activeElement).toBe(edge));
  return edge;
}

describe("focus restoration after React Flow replaces an edge element", () => {
  it("puts focus back when the focused edge's element is replaced", async () => {
    const container = renderCanvas();
    const edge = await focusedEdge(container);

    // What React Flow does on a commit of its own subtree: the focused element
    // is removed and an equivalent one takes its place. No blur is fired.
    const parent = edge.parentElement!;
    const replacement = edge.cloneNode(true) as SVGElement;
    edge.remove();
    parent.append(replacement);

    // The end state is the contract. Asserting on the instant between removal
    // and restore would race the observer, which runs on the microtask queue.
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.isConnected).toBe(true);
      expect(active?.dataset?.id).toBe("e1");
    });
  });

  it("does NOT steal focus from the help button after an edge was focused", async () => {
    // The reachable failure: click an edge, then click the help control. Its
    // onClick re-renders the canvas, and a restore keyed on anything looser
    // than "focus is on the body" yanks focus off the button mid-press.
    const toggle = vi.fn();
    const container = renderCanvas(toggle);
    await focusedEdge(container);

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Keyboard shortcuts"]')!;
    button.focus();
    fireEvent.click(button);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button);
  });

  it("does NOT steal focus from a pointer-mode control", async () => {
    const container = renderCanvas();
    await focusedEdge(container);

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!;
    button.focus();
    fireEvent.click(button);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(button);
  });

  it("does NOT pull focus back from outside the canvas", async () => {
    const container = renderCanvas();
    await focusedEdge(container);

    // Something else entirely -- the tab strip, in the real page.
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("stops observing once the canvas unmounts", async () => {
    const disconnect = vi.fn();
    const real = globalThis.MutationObserver;
    class SpyObserver extends real {
      disconnect(): void {
        disconnect();
        super.disconnect();
      }
    }
    globalThis.MutationObserver = SpyObserver as unknown as typeof MutationObserver;

    const { unmount } = render(
      <DiagramCanvas state={{ status: "ready", layout }} onNodeClick={() => {}} onEdgeClick={() => {}} />,
    );
    unmount();

    expect(disconnect).toHaveBeenCalled();
    globalThis.MutationObserver = real;
  });
});
