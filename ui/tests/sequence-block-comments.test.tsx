// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SvgPinRow } from "../src/diagrams/CommentPins";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { projectEnvelope } from "../src/diagrams/projection";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { loadModelEnvelope } from "./fixtures";

afterEach(cleanup);

function layout() {
  const envelope = loadModelEnvelope("sequence", "full");
  const projected = projectEnvelope({ ...envelope, view: { ...envelope.view, kind: "sequence" } });
  if (!projected.ok || projected.type !== "sequence") throw new Error("sequence fixture did not project");
  return computeSequenceLayout(projected.view);
}

function mount(extra = {}) {
  const handlers = { onNodeClick: vi.fn(), onEdgeClick: vi.fn(), onPaneClick: vi.fn() };
  const mounted = render(<SequenceCanvas layout={layout()} {...handlers} {...{ blockComments: true }} {...extra} />);
  return { ...mounted, ...handlers };
}

test("every whole block has a named keyboard target while message selection stays separate", () => {
  const { container, onNodeClick, onEdgeClick } = mount();
  for (const [kind, label] of [
    ["alt", "Valid credentials"],
    ["opt", "Fetch profile"],
    ["par", "Notify services"],
    ["loop", "Heartbeat"],
  ]) {
    const block = screen.getByRole("button", { name: `${kind} block: ${label}` });
    expect(block).toHaveAttribute("data-seq-channel", "fragments");
    expect(block).toHaveAttribute("tabindex", "0");
    expect(block).not.toHaveAttribute("aria-pressed");
    fireEvent.click(block);
  }
  expect(onNodeClick).not.toHaveBeenCalled();
  expect(onEdgeClick).not.toHaveBeenCalled();
  fireEvent.click(container.querySelector('[data-seq-channel="messages"][data-seq-id="msg-3"]')!);
  // Hand mode does not publish a selection; switch to Select to check the child path.
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  fireEvent.click(container.querySelector('[data-seq-channel="messages"][data-seq-id="msg-3"]')!);
  expect(onEdgeClick).toHaveBeenCalledExactlyOnceWith("msg-3", false);
});

test("click, Enter and Space call the same block comment action exactly once each", () => {
  const onBlockComment = vi.fn();
  const { onNodeClick, onEdgeClick, onPaneClick } = mount({ onBlockComment });
  const block = screen.getByRole("button", { name: "alt block: Valid credentials" });
  fireEvent.click(block);
  expect(onBlockComment).toHaveBeenCalledExactlyOnceWith("frag-0");
  fireEvent.keyDown(block, { key: "Enter" });
  expect(onBlockComment).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(block, { key: " " });
  expect(onBlockComment).toHaveBeenCalledTimes(3);
  expect(onBlockComment.mock.calls).toEqual([["frag-0"], ["frag-0"], ["frag-0"]]);
  expect(onNodeClick).not.toHaveBeenCalled();
  expect(onEdgeClick).not.toHaveBeenCalled();
  expect(onPaneClick).not.toHaveBeenCalled();
});

test("block hit areas are header and border only, and pins sit on the header", () => {
  const drawn = layout();
  const fragment = drawn.fragments[0]!;
  const { container } = mount({
    commented: {
      nodeIds: new Set(),
      edgeIds: new Set(),
      groupIds: new Set([fragment.id]),
      groupPins: new Map([[fragment.id, [{ threadId: "t-block", number: 1, state: "sent" }]]]),
    },
  });
  const header = screen.getByRole("button", { name: "alt block: Valid credentials, has comments" });
  const hit = header.querySelector(".archer-seq-fragment-header-hit");
  expect(hit).toHaveAttribute("y", String(fragment.y));
  expect(Number(hit?.getAttribute("height"))).toBeLessThan(fragment.height);
  const border = container.querySelector(`.archer-seq-fragment-border-hit[data-seq-id="${fragment.id}"]`);
  expect(border).toHaveAttribute("pointer-events", "stroke");
  expect(border).toHaveAttribute("fill", "none");
  expect(border).not.toHaveAttribute("tabindex");
  const pin = container.querySelector('[data-pin-thread="t-block"]')!;
  expect(pin).toHaveAccessibleName("Comment 1: sent. Open it.");
  expect(Number(pin.querySelector("text")?.getAttribute("y"))).toBe(fragment.y);
});

test("authoring keeps its fragment picking while offering the same block comment identity", () => {
  const onPartClick = vi.fn();
  const onBlockComment = vi.fn();
  mount({ onPartClick, onParticipantMove: vi.fn(), onBlockComment });
  const block = screen.getByRole("button", { name: "alt block: Valid credentials" });
  fireEvent.click(block);
  expect(onPartClick).toHaveBeenCalledExactlyOnceWith("fragment", "frag-0", false);
  expect(block).toHaveAttribute("data-seq-id", "frag-0");
  expect(onBlockComment).not.toHaveBeenCalled();
});

test("a block pin keeps its screen hit floor after zooming out", () => {
  const { container } = mount({
    commented: {
      nodeIds: new Set(),
      edgeIds: new Set(),
      groupIds: new Set(["frag-0"]),
      groupPins: new Map([["frag-0", [{ threadId: "t-block", number: 1, state: "sent" }]]]),
    },
  });
  for (let step = 0; step < 12; step++)
    fireEvent.wheel(container.querySelector(".archer-seq-canvas")!, { ctrlKey: true, deltaY: 100 });
  const transform = container.querySelector(".archer-seq-viewport")!.getAttribute("transform")!;
  const scale = Number(/scale\(([^)]+)\)/.exec(transform)![1]);
  const hit = container.querySelector('[data-owner="group:frag-0"] .archer-svg-pin-hit')!;
  expect(Number(hit.getAttribute("height")) * scale).toBeGreaterThanOrEqual(24);
  expect(Number(hit.getAttribute("width")) * scale).toBeGreaterThanOrEqual(24);
});

test("an explicit pin hit floor is centered and reserves separate cells for adjacent pins", () => {
  const { container } = render(
    <svg>
      <title>Block pins</title>
      <SvgPinRow
        {...{ hitSize: 88 }}
        pins={[
          { threadId: "t-first", number: 1, state: "sent" },
          { threadId: "t-next", number: 2, state: "sent" },
        ]}
        x={200}
        y={80}
      />
    </svg>,
  );
  const pins = [...container.querySelectorAll(".archer-svg-pin")];
  const hits = pins.map((pin) => {
    const rect = pin.querySelector(".archer-svg-pin-hit")!;
    const text = pin.querySelector("text")!;
    const x = Number(rect.getAttribute("x")),
      y = Number(rect.getAttribute("y")),
      width = Number(rect.getAttribute("width")),
      height = Number(rect.getAttribute("height"));
    expect(width).toBe(88);
    expect(height).toBe(88);
    expect(x + width / 2).toBe(Number(text.getAttribute("x")));
    expect(y + height / 2).toBe(Number(text.getAttribute("y")));
    return { x, width };
  });
  expect(hits[1]!.x + hits[1]!.width).toBeLessThan(hits[0]!.x);
});

test("a block pin stays on its visible header and clear of an expanded panel without moving the camera", () => {
  const resizes: (() => void)[] = [];
  let panelLeft = 1300;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizes.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches(".archer-seq-canvas")) return new DOMRect(64, 100, 1200, 700);
    if (this.matches(".archer-diagram-panel")) return new DOMRect(panelLeft, 100, 1500 - panelLeft, 700);
    return new DOMRect();
  });
  const panel = document.createElement("aside");
  panel.className = "archer-diagram-panel";
  document.body.append(panel);
  try {
    const drawn = layout();
    const fragment = drawn.fragments[0]!;
    const { container } = mount({
      commented: {
        nodeIds: new Set(),
        edgeIds: new Set(),
        groupIds: new Set([fragment.id]),
        groupPins: new Map([[fragment.id, [{ threadId: "t-visible", number: 1, state: "sent" }]]]),
      },
    });
    const canvas = container.querySelector(".archer-seq-canvas")!;
    fireEvent.wheel(canvas, { deltaX: 10, deltaY: 0 });
    const camera = container.querySelector(".archer-seq-viewport")!.getAttribute("transform")!;
    const match = /translate\(([^)]+)\).*scale\(([^)]+)\)/.exec(camera)!;
    const [x] = match[1]!.split(/[, ]+/).map(Number);
    const scale = Number(match[2]);
    const hit = () => container.querySelector('[data-pin-thread="t-visible"] .archer-svg-pin-hit')!;
    const screenRight = () => 64 + x! + (Number(hit().getAttribute("x")) + Number(hit().getAttribute("width"))) * scale;
    panelLeft = screenRight() - 20;
    act(() => resizes.forEach((resize) => resize()));
    expect(screenRight()).toBeLessThanOrEqual(panelLeft - 8);
    expect(Number(hit().getAttribute("x"))).toBeGreaterThanOrEqual(fragment.x);
    expect(Number(hit().getAttribute("y")) + Number(hit().getAttribute("height")) / 2).toBe(fragment.y);
    expect(container.querySelector(".archer-seq-viewport")).toHaveAttribute("transform", camera);
  } finally {
    panel.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
