// @vitest-environment jsdom
//
// What a marquee selects is read from React Flow's RECTANGLE, never from the
// `selected` flags in React Flow's store.
//
// The defect this replaces (measured in a real browser, 11 of 200 Shift-drags):
// the flow is controlled, so those flags have two writers. React Flow's pane
// sets them in place as the rectangle moves -- and only when the SET of covered
// nodes changes -- while every `nodes` prop this page renders overwrites them
// with the page's own selection. A sync rendered from an older selection that
// landed after the pane's write erased it; the pane, whose set had not changed
// again, never rewrote it; and the selection report the page was listening to
// (`onSelectionChange`, which reads those flags) said the node was not covered.
// An additive drag doubled the syncs -- the store reported base + rectangle
// straight back -- which is why it showed there and not on a plain drag.
//
// The rectangle and the node boxes have ONE writer each, so what is asserted
// here is real: positions come from the layout, the camera from the viewport
// transform the canvas rendered, and jsdom's missing layout is not involved.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";
import { edgesAmong } from "../src/selection/marquee";

const view: ProjectedView = {
  viewId: "marquee-view",
  kind: "c4-context",
  title: "Marquee",
  revision: "1",
  modelType: "architecture-graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: undefined },
    { id: "c", label: "C", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [
    { id: "ab", source: "a", target: "b", label: "calls" },
    { id: "bc", source: "b", target: "c", label: "stores" },
  ],
  groups: [],
};

let layout: LayoutResult;

beforeAll(async () => {
  layout = await computeLayout(view);
});

afterEach(cleanup);

describe("the edges a marquee brings with its nodes", () => {
  const edges = [
    { id: "ab", source: "a", target: "b" },
    { id: "bc", source: "b", target: "c" },
    { id: "loop", source: "a", target: "a" },
  ];

  it("takes an edge when BOTH its ends are covered", () => {
    expect(edgesAmong(["a", "b"], edges)).toEqual(["ab", "loop"]);
  });

  it("leaves an edge that only leaves, or only enters, the rectangle", () => {
    expect(edgesAmong(["b"], edges)).toEqual([]);
    expect(edgesAmong(["a", "c"], edges)).toEqual(["loop"]);
  });

  it("is every edge when every node is covered, as Select all is", () => {
    expect(edgesAmong(["a", "b", "c"], edges)).toEqual(["ab", "bc", "loop"]);
  });

  it("is nothing for an empty rectangle", () => {
    expect(edgesAmong([], edges)).toEqual([]);
  });
});

type Box = { left: number; top: number; right: number; bottom: number };

/** Where a node is on screen: its laid-out box under the camera the canvas rendered. */
function screenBox(container: HTMLElement, id: string): Box {
  const transform = container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
  const match = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(transform);
  expect(match, `unreadable transform ${transform}`).not.toBeNull();
  const [x, y, zoom] = [Number(match![1]), Number(match![2]), Number(match![3])];
  const node = layout.nodes.find((entry) => entry.id === id)!;
  return {
    left: node.x * zoom + x,
    top: node.y * zoom + y,
    right: (node.x + node.width) * zoom + x,
    bottom: (node.y + node.height) * zoom + y,
  };
}

const tick = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

type Selection = { nodeIds: string[]; edgeIds: string[] };

const CANVAS = 1200;

async function mount(onMarqueeChange: (nodeIds: readonly string[], edgeIds: readonly string[]) => void): Promise<{
  container: HTMLElement;
  pane: HTMLElement;
  sync: (selection: Selection) => Promise<void>;
}> {
  const canvas = (selection?: Selection) => (
    <DiagramCanvas state={{ status: "ready", layout }} selection={selection} onMarqueeChange={onMarqueeChange} />
  );
  const { container, rerender } = render(canvas());
  fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
  // Framing waits for React Flow's pan/zoom instance, a tick after mount.
  await tick();
  // A canvas box, which jsdom does not supply (`canvas-fit.test.tsx` explains
  // the two properties). It has to be real enough for two things: the framing
  // puts the nodes well inside it, and the pane -- which auto-pans while a
  // marquee is within 40px of the canvas edge, measured from the flow's own
  // rectangle -- sees the pointer nowhere near one.
  const flow = container.querySelector<HTMLElement>(".react-flow__renderer")!;
  Object.defineProperty(flow, "offsetWidth", { configurable: true, value: CANVAS });
  Object.defineProperty(flow, "offsetHeight", { configurable: true, value: CANVAS });
  const root = container.querySelector<HTMLElement>(".react-flow")!;
  root.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: CANVAS,
      bottom: CANVAS,
      width: CANVAS,
      height: CANVAS,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await tick();
  // The framing starts a drawing at the top gutter, inside the pane's 40px
  // auto-pan margin; scroll it down, as a reader would, so a press just
  // above the first node is nowhere near the edge.
  const pane = container.querySelector<HTMLElement>(".react-flow__pane")!;
  await act(async () => {
    pane.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -200, clientX: 600, clientY: 600, bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await tick();
  return {
    container,
    pane: container.querySelector<HTMLElement>(".react-flow__pane")!,
    sync: async (selection) => {
      rerender(canvas(selection));
      await tick();
    },
  };
}

const pointer = { button: 0, isPrimary: true, pointerId: 1 };

/** Presses on empty canvas just outside `from`'s corner. */
function press(pane: HTMLElement, from: Box): { x: number; y: number } {
  const start = { x: from.left - 6, y: from.top - 6 };
  fireEvent.pointerDown(pane, { ...pointer, clientX: start.x, clientY: start.y });
  return start;
}

function moveTo(pane: HTMLElement, x: number, y: number): void {
  fireEvent.pointerMove(pane, { ...pointer, clientX: x, clientY: y });
}

describe("a marquee reports what its rectangle touches", () => {
  it("names a node the rectangle only touches, and no edge with one end outside", async () => {
    const onMarqueeChange = vi.fn();
    const { container, pane } = await mount(onMarqueeChange);
    const a = screenBox(container, "a");

    press(pane, a);
    moveTo(pane, a.left + 4, a.top + 4);

    expect(onMarqueeChange).toHaveBeenLastCalledWith(["a"], []);
  });

  it("adds the edge between two nodes once the rectangle reaches the second", async () => {
    const onMarqueeChange = vi.fn();
    const { container, pane } = await mount(onMarqueeChange);
    const a = screenBox(container, "a");
    const b = screenBox(container, "b");

    press(pane, a);
    moveTo(pane, a.left + 4, a.top + 4);
    moveTo(pane, b.left + 4, b.top + 4);

    // `bc` leaves the rectangle for a node it does not cover.
    expect(onMarqueeChange).toHaveBeenLastCalledWith(["a", "b"], ["ab"]);
  });

  it("lets go of a node, and its edge, when the rectangle is dragged back off it", async () => {
    const onMarqueeChange = vi.fn();
    const { container, pane } = await mount(onMarqueeChange);
    const a = screenBox(container, "a");
    const b = screenBox(container, "b");

    press(pane, a);
    moveTo(pane, b.left + 4, b.top + 4);
    moveTo(pane, a.left + 4, a.top + 4);

    expect(onMarqueeChange).toHaveBeenLastCalledWith(["a"], []);
  });

  it("reports once per change of contents, not once per pointer move", async () => {
    const onMarqueeChange = vi.fn();
    const { container, pane } = await mount(onMarqueeChange);
    const a = screenBox(container, "a");

    press(pane, a);
    moveTo(pane, a.left + 4, a.top + 4);
    moveTo(pane, a.left + 5, a.top + 5);
    moveTo(pane, a.left + 6, a.top + 6);

    expect(onMarqueeChange.mock.calls.filter(([nodes]) => (nodes as string[]).join() === "a")).toHaveLength(1);
  });

  it("is not changed by a stale `nodes` sync that lands mid-drag", async () => {
    // The race, made deterministic: the rectangle covers a and b, and then a
    // render computed from an OLDER selection (a alone) reaches React Flow.
    // Its store's flags now say b is not selected. The rectangle still covers
    // b, so nothing may report otherwise -- and the next report, when the
    // contents do change, must still be computed from the rectangle.
    const onMarqueeChange = vi.fn();
    const { container, pane, sync } = await mount(onMarqueeChange);
    const a = screenBox(container, "a");
    const b = screenBox(container, "b");
    const c = screenBox(container, "c");

    press(pane, a);
    moveTo(pane, a.left + 4, a.top + 4);
    moveTo(pane, b.left + 4, b.top + 4);
    expect(onMarqueeChange).toHaveBeenLastCalledWith(["a", "b"], ["ab"]);
    const reports = onMarqueeChange.mock.calls.length;

    await sync({ nodeIds: ["a"], edgeIds: [] });
    moveTo(pane, b.left + 5, b.top + 5);
    await tick();

    expect(onMarqueeChange.mock.calls.length, "the stale sync produced a report").toBe(reports);

    moveTo(pane, c.left + 4, c.top + 4);
    expect(onMarqueeChange).toHaveBeenLastCalledWith(["a", "b", "c"], ["ab", "bc"]);
  });

  it("reports a second, identical marquee afresh", async () => {
    // React Flow's pane remembers the last rectangle's contents across drags
    // and changes nothing when the next one covers the same nodes.
    const onMarqueeChange = vi.fn();
    const { container, pane } = await mount(onMarqueeChange);
    const a = screenBox(container, "a");

    press(pane, a);
    moveTo(pane, a.left + 4, a.top + 4);
    fireEvent.pointerUp(pane, pointer);
    await tick();
    onMarqueeChange.mockClear();

    press(pane, a);
    moveTo(pane, a.left + 4, a.top + 4);

    expect(onMarqueeChange).toHaveBeenLastCalledWith(["a"], []);
  });

  it("says nothing once the drag has ended", async () => {
    const onMarqueeChange = vi.fn();
    const { container, pane } = await mount(onMarqueeChange);
    const a = screenBox(container, "a");

    press(pane, a);
    moveTo(pane, a.left + 4, a.top + 4);
    fireEvent.pointerUp(pane, pointer);
    await tick();
    onMarqueeChange.mockClear();

    moveTo(pane, a.right + 40, a.bottom + 40);

    expect(onMarqueeChange).not.toHaveBeenCalled();
  });
});
