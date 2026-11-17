// @vitest-environment jsdom
//
// The sequence canvas is interactive, in the graph canvas's own terms.
//
// Participants are the nodes and messages are the edges, so the handlers a
// graph click reaches are the handlers these reach. Everything here drives the
// real `SequenceCanvas`; which element comes next is decided in
// `sequence-nav.ts` and pinned against coordinates in `sequence-nav.test.ts`.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { MESSAGE_FONT, computeSequenceLayout, type SequenceLayoutResult } from "../src/layout/sequence-layout";
import { estimateTextWidth } from "../src/layout/text-measure";
import { projectEnvelope } from "../src/diagrams/projection";
import { DIMMED_OPACITY, FOCUSED_OPACITY } from "../src/diagrams/focus-style";
import { loadValidFixture } from "./fixtures";

function sequenceLayout(): SequenceLayoutResult {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence") {
    throw new Error("minimal-sequence.json did not project to a sequence view");
  }
  return computeSequenceLayout(projection.view);
}

afterEach(cleanup);

function handlerSet() {
  return {
    onNodeClick: vi.fn<(id: string, additive: boolean) => void>(),
    onEdgeClick: vi.fn<(id: string, additive: boolean) => void>(),
    onPaneClick: vi.fn<() => void>(),
  };
}
type Handlers = ReturnType<typeof handlerSet>;

function mount(
  selection?: { nodeIds: string[]; edgeIds: string[] },
  focus?: { participantIds?: string[]; messageIds?: string[] },
): Handlers & { container: HTMLElement; canvas: HTMLElement } {
  const handlers = handlerSet();
  const { container } = render(
    <SequenceCanvas layout={sequenceLayout()} selection={selection} focus={focus} {...handlers} />,
  );
  fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
  return { ...handlers, container, canvas: container.querySelector<HTMLElement>(".archer-seq-canvas")! };
}

const participant = (name: string): HTMLElement => screen.getByRole("button", { name });
const LOGIN = "Client to Server: POST /login";
const transformOf = (container: HTMLElement): string | null =>
  container.querySelector(".archer-seq-viewport")!.getAttribute("transform");

describe("clicking selects through the graph canvas's handlers", () => {
  it("a click on a participant selects it as a node, replacing", () => {
    const { onNodeClick, onEdgeClick, onPaneClick } = mount();
    fireEvent.click(screen.getByText("Server"));
    expect(onNodeClick).toHaveBeenCalledExactlyOnceWith("server", false);
    expect(onEdgeClick).not.toHaveBeenCalled();
    expect(onPaneClick).not.toHaveBeenCalled();
  });

  it("a click on a message selects it as an edge", () => {
    const { onNodeClick, onEdgeClick } = mount();
    fireEvent.click(screen.getByText("POST /login"));
    expect(onEdgeClick).toHaveBeenCalledExactlyOnceWith("msg-0", false);
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it("Shift+click is additive", () => {
    const { onNodeClick, onEdgeClick } = mount();
    fireEvent.click(screen.getByText("Server"), { shiftKey: true });
    fireEvent.click(screen.getByText("SELECT user"), { shiftKey: true });
    expect(onNodeClick).toHaveBeenCalledExactlyOnceWith("server", true);
    expect(onEdgeClick).toHaveBeenCalledExactlyOnceWith("msg-1", true);
  });

  it("a click on empty canvas clears", () => {
    const { canvas, onPaneClick, onNodeClick, onEdgeClick } = mount();
    fireEvent.click(canvas.querySelector("svg")!);
    expect(onPaneClick).toHaveBeenCalledOnce();
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(onEdgeClick).not.toHaveBeenCalled();
  });

  it("a fragment frame is not selectable: clicking one is a click on the canvas", () => {
    const { onPaneClick, onNodeClick, onEdgeClick } = mount();
    fireEvent.click(screen.getByText("[Credentials valid?]"));
    expect(onPaneClick).toHaveBeenCalledOnce();
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(onEdgeClick).not.toHaveBeenCalled();
  });

  it("a participant's lifeline selects that participant", () => {
    const { container, onNodeClick } = mount();
    const hit = container.querySelector("[data-seq-channel='participants'][data-seq-id='db'].archer-seq-lifeline-hit");
    expect(hit).not.toBeNull();
    fireEvent.click(hit!);
    expect(onNodeClick).toHaveBeenCalledExactlyOnceWith("db", false);
  });

  it("gives a message a hit target far wider than its 1.5px line", () => {
    const { container, onEdgeClick } = mount();
    const hit = container.querySelector("[data-seq-id='msg-1'] .archer-seq-hit")!;
    expect(Number(hit.getAttribute("height"))).toBeGreaterThanOrEqual(16);
    fireEvent.click(hit);
    expect(onEdgeClick).toHaveBeenCalledExactlyOnceWith("msg-1", false);
  });
});

describe("a drag still pans, and is never a click", () => {
  it("pans when the pointer travels, and swallows the click that ends the drag", () => {
    const { container, canvas, onNodeClick, onPaneClick } = mount();
    const before = transformOf(container);
    const server = screen.getByText("Server");

    fireEvent.pointerDown(server, { button: 0, clientX: 300, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 360, clientY: 70, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 360, clientY: 70, pointerId: 1 });
    fireEvent.click(server, { clientX: 360, clientY: 70 });

    expect(transformOf(container)).not.toBe(before);
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(onPaneClick).not.toHaveBeenCalled();
  });

  it("does not treat a press with a pixel of jitter as a drag", () => {
    const { container, canvas, onNodeClick } = mount();
    const before = transformOf(container);
    const server = screen.getByText("Server");

    fireEvent.pointerDown(server, { button: 0, clientX: 300, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 301, clientY: 31, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 301, clientY: 31, pointerId: 1 });
    fireEvent.click(server);

    expect(transformOf(container)).toBe(before);
    expect(onNodeClick).toHaveBeenCalledExactlyOnceWith("server", false);
  });

  it("selects again on the click after a drag", () => {
    const { canvas, onNodeClick } = mount();
    const server = screen.getByText("Server");
    fireEvent.pointerDown(server, { button: 0, clientX: 300, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 360, clientY: 70, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 360, clientY: 70, pointerId: 1 });
    fireEvent.click(canvas);

    fireEvent.pointerDown(server, { button: 0, clientX: 300, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(server, { clientX: 300, clientY: 30, pointerId: 1 });
    fireEvent.click(server);
    expect(onNodeClick).toHaveBeenCalledExactlyOnceWith("server", false);
  });
});

describe("hover and selection are drawn", () => {
  it("hovering a participant marks its box and its lifeline", () => {
    const { container } = mount();
    fireEvent.pointerOver(screen.getByText("Server"));
    const marked = [...container.querySelectorAll(".archer-seq-hover")];
    expect(marked.map((el) => el.getAttribute("class"))).toEqual([
      expect.stringContaining("archer-seq-lifeline"),
      expect.stringContaining("archer-seq-participant"),
    ]);
    fireEvent.pointerOver(container.querySelector("svg")!);
    expect(container.querySelectorAll(".archer-seq-hover")).toHaveLength(0);
  });

  it("hovering a message marks that message alone", () => {
    const { container } = mount();
    fireEvent.pointerOver(screen.getByText("POST /login"));
    const marked = container.querySelectorAll(".archer-seq-hover");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveAttribute("data-seq-id", "msg-0");
  });

  it("marks the selected participant, its lifeline and the selected messages, and says so", () => {
    const { container } = mount({ nodeIds: ["server"], edgeIds: ["msg-0", "msg-2"] });
    const selected = [...container.querySelectorAll(".archer-seq-selected")].map(
      (el) => `${el.getAttribute("data-seq-channel") ?? "lifeline"}:${el.getAttribute("data-seq-id") ?? ""}`,
    );
    expect(selected.sort()).toEqual(["lifeline:", "messages:msg-0", "messages:msg-2", "participants:server"]);

    expect(participant("Server")).toHaveAttribute("aria-pressed", "true");
    expect(participant("Client")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: LOGIN })).toHaveAttribute("aria-pressed", "true");
  });

  it("plates a selected message's label at the width it is drawn, which is bold", () => {
    // Found in the browser: the plate was cut to the regular-weight width the
    // layout reserved, and the bold label ran over both of its ends.
    const { container } = mount({ nodeIds: [], edgeIds: ["msg-2"] });
    const plate = container.querySelector("[data-seq-id='msg-2'] .archer-seq-message-plate")!;
    const bold = estimateTextWidth("user record", MESSAGE_FONT, true);
    expect(Number(plate.getAttribute("width"))).toBeGreaterThanOrEqual(bold + 8);
    // ...and it is centred on the label, which is centred on the arrow.
    const message = sequenceLayout().messages.find((entry) => entry.id === "msg-2")!;
    const centre = Number(plate.getAttribute("x")) + Number(plate.getAttribute("width")) / 2;
    expect(centre).toBeCloseTo((message.fromX + message.toX) / 2, 5);
    // An unselected message has no plate at all.
    expect(container.querySelector("[data-seq-id='msg-1'] .archer-seq-message-plate")).toBeNull();
  });

  it("does not dim a selected element that lies outside the presentation focus", () => {
    mount({ nodeIds: ["db"], edgeIds: ["msg-1"] }, { participantIds: ["server"], messageIds: ["msg-0"] });
    expect(participant("Database")).toHaveAttribute("opacity", `${FOCUSED_OPACITY}`);
    expect(participant("Client")).toHaveAttribute("opacity", `${DIMMED_OPACITY}`);
    expect(screen.getByText("SELECT user").closest("[data-seq-id]")).toHaveAttribute("opacity", `${FOCUSED_OPACITY}`);
    expect(screen.getByText("user record").closest("[data-seq-id]")).toHaveAttribute("opacity", `${DIMMED_OPACITY}`);
  });
});

describe("keyboard: two tab stops, roving within each", () => {
  it("puts exactly two elements in the tab order, participants before messages", () => {
    const { container } = mount();
    const stops = [...container.querySelectorAll("[tabindex='0']")];
    expect(stops.map((el) => el.getAttribute("data-seq-id"))).toEqual(["client", "msg-0"]);
    // Everything else is focusable by script only.
    expect(container.querySelectorAll(".archer-seq-canvas [tabindex='-1']")).toHaveLength(3 + 5 - 2);
  });

  it("announces a participant by its label and a message by its ends and text, never by id", () => {
    mount();
    expect(participant("Database")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: LOGIN })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Database to Server: user record" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /msg-\d/ })).toBeNull();
  });

  it("Right moves focus and the tab stop to the next participant", () => {
    const { container } = mount();
    participant("Client").focus();
    fireEvent.keyDown(participant("Client"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(participant("Server"));
    expect(participant("Server")).toHaveAttribute("tabindex", "0");
    expect(participant("Client")).toHaveAttribute("tabindex", "-1");
    expect(container.querySelectorAll("[tabindex='0']")).toHaveLength(2);
  });

  it("Down moves focus to the next message in source order", () => {
    mount();
    const login = screen.getByRole("button", { name: LOGIN });
    login.focus();
    fireEvent.keyDown(login, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Server to Database: SELECT user" }));
  });

  it("Left on a message crosses to the participant at that end, and Down comes back", () => {
    mount();
    const record = screen.getByRole("button", { name: "Database to Server: user record" });
    record.focus();
    fireEvent.keyDown(record, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(participant("Server"));
    fireEvent.keyDown(participant("Server"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(record);
  });

  it("rings only the element the keyboard is on, and only while focus is inside", () => {
    const { container } = mount();
    expect(container.querySelectorAll(".archer-seq-kbd-focus")).toHaveLength(0);
    // `act`, because a bare `.focus()` is not a Testing Library event and the
    // state it sets would otherwise not be flushed before the assertion.
    act(() => participant("Client").focus());
    expect([...container.querySelectorAll(".archer-seq-kbd-focus")]).toEqual([participant("Client")]);
    const login = screen.getByRole("button", { name: LOGIN });
    act(() => login.focus());
    expect([...container.querySelectorAll(".archer-seq-kbd-focus")]).toEqual([login]);
    // A focused message wears a band of its own under the arrow.
    expect(container.querySelectorAll(".archer-seq-message-ring")).toHaveLength(1);
    expect(login.querySelector(".archer-seq-message-ring")).not.toBeNull();
    act(() => login.blur());
    expect(container.querySelectorAll(".archer-seq-kbd-focus")).toHaveLength(0);
  });

  it("Enter and Space select through the handler a click uses, and Shift toggles", () => {
    const { onNodeClick, onEdgeClick } = mount();
    participant("Server").focus();
    fireEvent.keyDown(participant("Server"), { key: "Enter" });
    expect(onNodeClick).toHaveBeenLastCalledWith("server", false);
    fireEvent.keyDown(participant("Server"), { key: " ", shiftKey: true });
    expect(onNodeClick).toHaveBeenLastCalledWith("server", true);

    const login = screen.getByRole("button", { name: LOGIN });
    login.focus();
    fireEvent.keyDown(login, { key: " " });
    expect(onEdgeClick).toHaveBeenLastCalledWith("msg-0", false);
    fireEvent.keyDown(login, { key: "Enter", shiftKey: true });
    expect(onEdgeClick).toHaveBeenLastCalledWith("msg-0", true);
  });

  it("leaves a modified arrow to the browser", () => {
    mount();
    participant("Client").focus();
    const event = fireEvent.keyDown(participant("Client"), { key: "ArrowRight", altKey: true });
    expect(event).toBe(true);
    expect(document.activeElement).toBe(participant("Client"));
  });

  it("pans a keyboard-focused element back into view when the camera has left it", () => {
    const { container, canvas } = mount();
    fireEvent.wheel(canvas, { deltaX: 0, deltaY: 4000 });
    const away = transformOf(container);
    participant("Client").focus();
    fireEvent.keyDown(participant("Client"), { key: "ArrowRight" });
    expect(transformOf(container)).not.toBe(away);
    const y = Number(/translate\(([-\d.]+) ([-\d.]+)\)/.exec(transformOf(container)!)![2]);
    expect(y).toBeGreaterThanOrEqual(0);
  });

  it("claims no button and no tab stop when nothing listens", () => {
    const { container } = render(<SequenceCanvas layout={sequenceLayout()} />);
    expect(container.querySelectorAll(".archer-seq-canvas [tabindex]")).toHaveLength(0);
    expect(container.querySelectorAll(".archer-seq-canvas [role='button']")).toHaveLength(0);
  });
});
