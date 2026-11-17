// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FloatingDiscussion } from "../src/comments/FloatingDiscussion";

const frames = new Map<number, FrameRequestCallback>();
const resizes: {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}[] = [];
let nextFrame = 0;
let anchorX = 100;
let measures = 0;
beforeEach(() => {
  frames.clear();
  resizes.length = 0;
  anchorX = 100;
  measures = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(readonly callback: ResizeObserverCallback) {
        resizes.push(this);
      }
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches('[data-seq-id="A"]')) {
      measures++;
      return new DOMRect(anchorX, 100, 120, 40);
    }
    return new DOMRect();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function scene(caption = "Discussion", viewportKey = "original") {
  return (
    <>
      <svg key={viewportKey} className="archer-seq-viewport">
        <title>Participants</title>
        <g data-seq-channel="participants" data-seq-id="A" />
      </svg>
      <FloatingDiscussion anchor={{ kind: "node", id: "A", label: "Client" }} title={caption} onClose={() => {}}>
        Words
      </FloatingDiscussion>
    </>
  );
}
function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}
async function mutations() {
  await act(async () => {
    await Promise.resolve();
  });
}
const discussion = () => screen.getByRole("region", { name: "Contextual discussion" });

test.each(["graph", "sequence"] as const)(
  "%s camera transforms reposition the discussion before the next animation frame",
  async (kind) => {
    render(
      <>
        <div className={kind === "graph" ? "react-flow__viewport" : undefined}>
          <svg>
            <title>Participants</title>
            <g className={kind === "sequence" ? "archer-seq-viewport" : undefined}>
              <g data-seq-channel="participants" data-seq-id="A" />
            </g>
          </svg>
        </div>
        <FloatingDiscussion anchor={{ kind: "node", id: "A", label: "Client" }} title="Discussion" onClose={() => {}}>
          Words
        </FloatingDiscussion>
      </>,
    );
    await mutations();
    flushFrame();
    expect(discussion()).toHaveStyle({ left: "236px" });
    anchorX = 160;
    const viewport = document.querySelector(".react-flow__viewport, .archer-seq-viewport")!;
    viewport.setAttribute(
      kind === "graph" ? "style" : "transform",
      kind === "graph" ? "transform: translate(60px, 0px) scale(1)" : "translate(60 0) scale(1)",
    );
    // Deliver native MutationObservers, but never run another animation frame.
    await mutations();
    expect(discussion()).toHaveStyle({ left: "296px" });
  },
);

test("placement follows its anchor, survives a render, and keyboard movement detaches until Reattach", async () => {
  const { rerender } = render(scene());
  expect(discussion()).toHaveStyle({ left: "236px", top: "100px" });
  anchorX = 140;
  fireEvent.scroll(document);
  flushFrame();
  expect(discussion()).toHaveStyle({ left: "276px" });
  rerender(scene("Updated title"));
  expect(discussion()).toHaveStyle({ left: "276px" });
  fireEvent.keyDown(screen.getByRole("button", { name: "Move discussion" }), { key: "ArrowRight" });
  expect(discussion()).toHaveStyle({ left: "286px" });
  anchorX = 180;
  fireEvent.scroll(document);
  flushFrame();
  expect(discussion()).toHaveStyle({ left: "286px" });
  fireEvent.click(screen.getByRole("button", { name: "Reattach" }));
  expect(discussion()).toHaveStyle({ left: "316px" });
  await mutations();
});

test("scroll, resize, content and panel changes share one pending frame (camera moves are same-frame, tested above)", async () => {
  render(scene());
  await mutations();
  flushFrame();
  measures = 0;
  anchorX = 160;
  fireEvent.scroll(document);
  fireEvent.resize(window);
  resizes.forEach((resize) => resize.callback([], {} as ResizeObserver));
  const panel = document.createElement("aside");
  panel.className = "archer-diagram-panel";
  document.body.append(panel);
  await mutations();
  expect(measures).toBe(0);
  expect(frames.size).toBe(1);
  flushFrame();
  expect(discussion()).toHaveStyle({ left: "296px" });
  expect(measures).toBe(3); // lookup, visibility, pin-inclusive bounds: one placement
  panel.remove();
});

test("unrelated subtree edits neither measure layout nor re-observe elements", async () => {
  render(scene());
  await mutations();
  flushFrame();
  measures = 0;
  resizes.forEach((resize) => resize.observe.mockClear());
  const unrelated = document.createElement("div");
  document.body.append(unrelated);
  unrelated.append(document.createElement("span"));
  await mutations();
  expect(frames.size).toBe(0);
  expect(measures).toBe(0);
  expect(resizes.flatMap((resize) => resize.observe.mock.calls)).toHaveLength(0);
  unrelated.remove();
});

test("an added wrapper observes its panel descendant once and releases it when removed", async () => {
  render(scene());
  await mutations();
  flushFrame();
  resizes.forEach((resize) => resize.observe.mockClear());
  const wrapper = document.createElement("div");
  wrapper.innerHTML = '<aside class="archer-diagram-panel"></aside>';
  const panel = wrapper.firstElementChild!;
  document.body.append(wrapper);
  await mutations();
  expect(resizes.flatMap((resize) => resize.observe.mock.calls)).toEqual([[panel]]);
  wrapper.remove();
  await mutations();
  expect(resizes.flatMap((resize) => resize.unobserve.mock.calls)).toEqual([[panel]]);
});

test("an equivalent anchor object does not reinstall observers or reattach a moved discussion", () => {
  const { rerender } = render(scene());
  fireEvent.keyDown(screen.getByRole("button", { name: "Move discussion" }), { key: "ArrowRight" });
  expect(discussion()).toHaveAttribute("data-detached", "true");
  const count = resizes.length;
  rerender(scene());
  expect(discussion()).toHaveAttribute("data-detached", "true");
  expect(discussion()).toHaveStyle({ left: "246px" });
  expect(resizes).toHaveLength(count);
});

test("an unmounted discussion cancels pending layout work", async () => {
  const { unmount } = render(scene());
  fireEvent.scroll(document);
  unmount();
  await mutations();
  expect(frames.size).toBe(0);
});

test("following an anchor does not schedule another frame from its own position writes", async () => {
  render(scene());
  await mutations();
  flushFrame();
  await mutations();
  frames.clear();
  anchorX = 160;
  fireEvent.scroll(document);
  flushFrame();
  await mutations();
  expect(discussion()).toHaveStyle({ left: "296px" });
  expect(frames.size).toBe(0);
});

test("panel class membership changes add and release resize observations", async () => {
  render(scene());
  await mutations();
  flushFrame();
  const panel = document.createElement("aside");
  document.body.append(panel);
  await mutations();
  resizes.forEach((resize) => {
    resize.observe.mockClear();
    resize.unobserve.mockClear();
  });
  panel.className = "archer-diagram-panel";
  await mutations();
  expect(resizes.flatMap((resize) => resize.observe.mock.calls)).toEqual([[panel]]);
  flushFrame();
  panel.className = "unrelated";
  await mutations();
  expect(resizes.flatMap((resize) => resize.unobserve.mock.calls)).toEqual([[panel]]);
  expect(frames.size).toBe(1);
  panel.remove();
});

test("changing the anchor identity reattaches to the new scope", async () => {
  const { rerender } = render(scene());
  fireEvent.keyDown(screen.getByRole("button", { name: "Move discussion" }), { key: "ArrowRight" });
  const target = document.createElement("div");
  target.className = "react-flow__node";
  target.dataset.id = "B";
  Object.defineProperty(target, "getBoundingClientRect", { value: () => new DOMRect(300, 100, 120, 40) });
  document.body.append(target);
  rerender(
    <FloatingDiscussion anchor={{ kind: "node", id: "B", label: "Service" }} title="Service" onClose={() => {}}>
      Words
    </FloatingDiscussion>,
  );
  expect(discussion()).toHaveAttribute("data-detached", "false");
  expect(discussion()).toHaveStyle({ left: "436px" });
  target.remove();
  await mutations();
});

test("a replacement viewport keeps tracking the same anchor", async () => {
  const { rerender } = render(scene());
  await mutations();
  flushFrame();
  rerender(scene("Discussion", "replacement"));
  await mutations();
  flushFrame();
  anchorX = 160;
  document.querySelector(".archer-seq-viewport")!.setAttribute("transform", "translate(60 0)");
  await mutations();
  flushFrame();
  expect(discussion()).toHaveStyle({ left: "296px" });
});

test("note-reader content changes can move a passage without resizing its workspace", async () => {
  const reader = document.createElement("main");
  reader.className = "primary-note-reader";
  reader.innerHTML = '<p>Earlier paragraph</p><mark data-thread-id="t-passage">Selected words</mark>';
  document.body.append(reader);
  let top = 100;
  Object.defineProperty(reader.querySelector("mark")!, "getBoundingClientRect", {
    value: () => new DOMRect(100, top, 120, 40),
  });
  render(
    <FloatingDiscussion
      anchor={{ kind: "passage", quote: "Selected words", prefix: "", suffix: "" }}
      threadId="t-passage"
      title="Passage"
      onClose={() => {}}
    >
      Words
    </FloatingDiscussion>,
  );
  expect(discussion()).toHaveStyle({ top: "100px" });
  await mutations();
  flushFrame();
  top = 200;
  reader.querySelector("p")!.append(document.createElement("br"));
  await mutations();
  flushFrame();
  expect(discussion()).toHaveStyle({ top: "200px" });
  reader.remove();
});

test("walkthrough content changes move a step anchor inside an unchanged panel", async () => {
  const panel = document.createElement("aside");
  panel.className = "archer-diagram-panel";
  panel.innerHTML =
    '<ol class="archer-walk-steps"><li>Earlier step</li><li class="archer-walk-step" data-step-id="selected">Selected step</li></ol>';
  document.body.append(panel);
  let top = 100;
  const anchor = panel.querySelector(".archer-walk-step")!;
  Object.defineProperty(anchor, "getBoundingClientRect", {
    value: () => new DOMRect(100, top, 120, 40),
  });
  render(
    <FloatingDiscussion
      anchor={{ kind: "step", walkthrough: "tour", step: "selected", label: "Selected step" }}
      title="Step"
      onClose={() => {}}
    >
      Words
    </FloatingDiscussion>,
  );
  expect(discussion()).toHaveStyle({ top: "100px" });
  await mutations();
  flushFrame();
  top = 200;
  anchor.before(document.createElement("li"));
  await mutations();
  flushFrame();
  expect(discussion()).toHaveStyle({ top: "200px" });
  panel.remove();
});
