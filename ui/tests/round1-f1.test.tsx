// @vitest-environment jsdom
// Round 1 (UI/UX) batch F1: canvas and authoring. Fake clients copied from authoring-workspace.test.tsx.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AuthoringWorkspace } from "../src/authoring/AuthoringWorkspace";
import type { AuthoringClient } from "../src/authoring/client";
import { loadModelEnvelope } from "./fixtures";
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
vi.mock("../src/source-editor/lazy", () => ({ useSourceEditor: () => null, preloadSourceEditor: async () => null }));

const status = {
  authorized: true as const,
  edit: { enabled: true },
  storeId: "store_" + "a".repeat(32),
  generation: "gen_" + "b".repeat(32),
  drafts: [],
  operations: [],
  nextOffset: null,
};
function client(): AuthoringClient {
  return {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    preview: vi.fn(async () => ({ envelope: loadModelEnvelope("flowchart", "minimal"), diagnostics: [] })),
    open: vi.fn(),
    snapshot: vi.fn(),
    edit: vi.fn(async (source) => ({ ok: false as const, source, code: "edit_source_mapping_ambiguous" })),
    mutate: vi.fn(),
    operation: vi.fn(),
  };
}
const editorReady = async () => {
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  await waitFor(() => expect(document.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 10000 });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Process/ })).toBeEnabled(), { timeout: 5000 });
};
const panel = () => screen.getByRole("complementary", { name: "Structure and properties" });
const nodeAt = (id: string) => {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec(el.style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]) };
};
async function openFlow() {
  window.history.replaceState(null, "", "/p/example/edit/");
  render(<AuthoringWorkspace projectSlug="example" api={client()} />);
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "Web App" }));
  (document.activeElement as HTMLElement | null)?.blur();
}

test("#1 keyboard: Alt+arrow nudges the selected shape, Shift takes a bigger step, and one Undo puts it back", async () => {
  await openFlow();
  const start = nodeAt("web");
  expect(fireEvent.keyDown(document.body, { key: "ArrowRight", altKey: true })).toBe(false);
  await waitFor(() => expect(nodeAt("web")).toEqual({ x: start.x + 10, y: start.y }));
  fireEvent.keyDown(document.body, { key: "ArrowDown", altKey: true, shiftKey: true });
  await waitFor(() => expect(nodeAt("web")).toEqual({ x: start.x + 10, y: start.y + 50 }));
  expect(document.querySelector(".authoring-statusline")).toHaveTextContent("Moved “Web App”");
  // A run of nudges is one step.
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  await waitFor(() => expect(nodeAt("web")).toEqual(start));
});

test("#1 keyboard: no nudge while a label field has focus", async () => {
  await openFlow();
  const start = nodeAt("web");
  fireEvent.click(within(panel()).getByRole("button", { name: "Edit Web App label" }));
  const input = within(panel()).getByRole("textbox", { name: "Web App label" });
  fireEvent.keyDown(input, { key: "ArrowRight", altKey: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(nodeAt("web")).toEqual(start);
});

test("#1 single pointer: Move, then a click on the canvas, puts the shape there", async () => {
  await openFlow();
  const start = nodeAt("web");
  const move = screen.getByRole("button", { name: "Move selected" });
  fireEvent.click(move);
  expect(move).toHaveAttribute("aria-pressed", "true");
  expect(document.querySelector(".authoring-statusline")).toHaveTextContent(/Click where “Web App” should go/);
  const pane = document.querySelector<HTMLElement>(".react-flow__pane")!,
    at = { button: 0, isPrimary: true, pointerId: 1, clientX: 400, clientY: 300 };
  fireEvent.pointerDown(pane, at);
  fireEvent.pointerUp(pane, at);
  fireEvent.click(pane, at);
  await waitFor(() => expect(document.querySelector(".authoring-statusline")).toHaveTextContent("Moved “Web App”"));
  expect(move).toHaveAttribute("aria-pressed", "false");
  expect(nodeAt("web")).not.toEqual(start);
});

test("#1 single pointer: Escape cancels a Move without moving", async () => {
  await openFlow();
  const start = nodeAt("web");
  fireEvent.click(screen.getByRole("button", { name: "Move selected" }));
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Move selected" })).toHaveAttribute("aria-pressed", "false");
  expect(nodeAt("web")).toEqual(start);
});

// #4 (V6): Fit stops zooming out where the reading text reaches `--type-floor`; what is left is the off-screen cue's.
import { act } from "@testing-library/react";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { computeLayout } from "../src/layout/elk-adapter";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { readingFaces } from "../src/diagrams/viewport-fit";
import { containersView } from "./graph-samples";
import { loadValidFixture } from "./fixtures";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TYPE_FLOOR_PX = (() => {
  const m = /--type-floor:\s*([\d.]+)rem/.exec(readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8"))!;
  return Number(m[1]) * 16;
})();
const smallestReading = (notation: Parameters<typeof readingFaces>[0]) =>
  Math.min(...readingFaces(notation).map((face) => face.px));

test("#4, as amended by AM-R1-02: Fit view on a graph too big for the canvas shows all of it, below the type floor if it must, and no cue says more is left", async () => {
  const layout = await computeLayout(containersView());
  const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const flow = container.querySelector<HTMLElement>(".react-flow__renderer")!;
  Object.defineProperty(flow, "offsetWidth", { configurable: true, value: 600 });
  Object.defineProperty(flow, "offsetHeight", { configurable: true, value: 400 });
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.click(screen.getByRole("button", { name: "Fit view" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const zoom = Number(
    /scale\(([-\d.e]+)\)/.exec(container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)![1],
  );
  expect(smallestReading(layout.notation ?? "flowchart") * zoom).toBeLessThan(TYPE_FLOOR_PX);
  expect(container.querySelectorAll(".archer-offscreen-cue")).toHaveLength(0);
});

test("#4, as amended by AM-R1-02: Fit view on a sequence too big for the canvas shows all of it, below the type floor if it must", () => {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence") throw new Error("not a sequence");
  const real = HTMLElement.prototype.getBoundingClientRect;
  const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("archer-seq-canvas")
      ? ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 200,
          bottom: 160,
          width: 200,
          height: 160,
          toJSON: () => ({}),
        } as DOMRect)
      : real.call(this);
  });
  try {
    const { container } = render(<SequenceCanvas layout={computeSequenceLayout(projection.view)} />);
    fireEvent.click(screen.getByRole("button", { name: "Fit view" }));
    const scale = Number(
      /scale\(([-\d.e]+)\)/.exec(container.querySelector("g.archer-seq-viewport")!.getAttribute("transform")!)![1],
    );
    expect(smallestReading("sequence") * scale).toBeLessThan(TYPE_FLOOR_PX);
    expect(container.querySelectorAll(".archer-offscreen-cue")).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

// #7 (G10 pre-check): a message says its kind, the fragment branch it is in, and the activation it starts or ends.
test("#7 sequence messages are described with their kind, fragment branch and activation", () => {
  const full = loadModelEnvelope("sequence", "full");
  const projection = projectEnvelope({ ...full, view: { ...full.view, kind: "sequence" } });
  if (!projection.ok || projection.type !== "sequence") throw new Error("not a sequence");
  render(
    <SequenceCanvas layout={computeSequenceLayout(projection.view)} onNodeClick={() => {}} onEdgeClick={() => {}} />,
  );
  const described = (name: string) =>
    screen.getByRole("button", { name }).getAttribute("aria-describedby")
      ? document.getElementById(screen.getByRole("button", { name }).getAttribute("aria-describedby")!)?.textContent
      : null;
  expect(described("Client to Server: POST /login")).toBe("Call. Activates Server.");
  expect(described("Server to Client: 200 OK")).toBe("Reply. In alt [Valid credentials], branch 1 of 2.");
  expect(described("Server to Client: 401 Unauthorized")).toBe(
    "Reply. In alt [Invalid credentials], branch 2 of 2. Ends Server’s activation.",
  );
  expect(described("Server to Client: push notification")).toBe(
    "Asynchronous message. In par [Notify services], branch 1 of 2.",
  );
  expect(described("Client to Server: ping")).toBe("Call. In loop [Heartbeat].");
});

// #11 (H3): an editor toolbar is one Tab stop, and the arrow keys, Home and End move along it (APG toolbar).
test("#11 the parts toolbar and the editing toolbar rove with the arrow keys and hold one Tab stop", async () => {
  // A shape selected, so the editing toolbar has several enabled tools.
  await openFlow();
  for (const name of [/ parts$/, /^Editing tools$/]) {
    const bar = screen.getByRole("toolbar", { name });
    const items = [...bar.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => !b.disabled && !b.closest("[role=menu]"),
    );
    expect(items.length).toBeGreaterThan(1);
    expect(items.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    items[0]!.focus();
    expect(fireEvent.keyDown(items[0]!, { key: "ArrowRight" })).toBe(false);
    expect(document.activeElement).toBe(items[1]);
    expect(items[1]!.tabIndex).toBe(0);
    expect(items[0]!.tabIndex).toBe(-1);
    fireEvent.keyDown(items[1]!, { key: "End" });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(items.at(-1)!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(items.at(-1)!, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  }
});
