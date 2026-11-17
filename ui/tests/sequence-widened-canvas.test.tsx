// @vitest-environment jsdom
//
// What wire contract v2 added to a sequence, as drawn: notes, actors and
// message numbers. Driven through the real `SequenceCanvas` (and, for the
// published selection, the real `App`) from the shared `widened-sequence.json`
// fixture -- the envelope the Rust compiler actually emits for
// `fixtures/sequence/widened.mmd`.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { App } from "../src/app/App";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { computeSequenceLayout, type SequenceLayoutResult } from "../src/layout/sequence-layout";
import { projectEnvelope, type ProjectedSequence } from "../src/diagrams/projection";
import { sequenceSelectionModel } from "../src/selection/sequence-selection";
import { DIMMED_OPACITY, FOCUSED_OPACITY } from "../src/diagrams/focus-style";
import { MockEventSource, mountAgentPresented, restoreLocation, selectionPosts, settle } from "./app-harness";
import { loadValidFixture } from "./fixtures";

const ENVELOPE = loadValidFixture("widened-sequence.json") as { revision: string; view: { id: string } };

function widenedView(): ProjectedSequence {
  const projection = projectEnvelope(ENVELOPE);
  if (!projection.ok || projection.type !== "sequence") {
    throw new Error("widened-sequence.json did not project to a sequence view");
  }
  return projection.view;
}

const widened = (): SequenceLayoutResult => computeSequenceLayout(widenedView());

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

function handlerSet() {
  return {
    onNodeClick: vi.fn<(id: string, additive: boolean) => void>(),
    onEdgeClick: vi.fn<(id: string, additive: boolean) => void>(),
    onPaneClick: vi.fn<() => void>(),
  };
}

function mount(props: Partial<Parameters<typeof SequenceCanvas>[0]> = {}) {
  const handlers = handlerSet();
  const layout = props.layout ?? widened();
  const { container } = render(<SequenceCanvas layout={layout} {...handlers} {...props} />);
  fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
  return { ...handlers, layout, container, canvas: container.querySelector<HTMLElement>(".archer-seq-canvas")! };
}

const SIGNED_OUT = "Note left of End user: Signed out";
const TLS = "Note over Web app and API: TLS 1.3, mutual auth";

describe("a note is drawn", () => {
  it("draws every note with its text and an accessible name", () => {
    const { layout } = mount();
    expect(layout.notes).toHaveLength(4);
    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(4);
    expect(screen.getByRole("note", { name: SIGNED_OUT })).toHaveTextContent("Signed out");
    expect(screen.getByRole("note", { name: TLS })).toHaveTextContent("TLS 1.3, mutual auth");
  });

  it("draws the sheet where the layout put it", () => {
    const { layout } = mount();
    const note = layout.notes[1];
    const sheet = screen.getByRole("note", { name: TLS }).querySelector(".archer-seq-note-sheet")!;
    const box = (sheet as SVGGraphicsElement).getAttribute("d")!;
    expect(box.startsWith(`M ${note.x} ${note.y} `)).toBe(true);
    expect(box).toContain(`${note.y + note.height}`);
  });

  it("is its own kind of mark: not a participant box, not a fragment, not a message", () => {
    mount();
    const note = screen.getByRole("note", { name: SIGNED_OUT });
    expect(note).toHaveClass("archer-seq-note");
    for (const other of ["archer-seq-participant", "archer-seq-fragment", "archer-seq-message"]) {
      expect(note).not.toHaveClass(other);
      expect(note.closest(`.${other}`)).toBeNull();
    }
  });

  it("stacks a wrapped note as one line per tspan and keeps the whole text in its name", () => {
    const long = "Tokens are rotated on every refresh, and a reused refresh token revokes the whole family";
    const view = widenedView();
    const layout = computeSequenceLayout({
      ...view,
      events: [{ type: "note", id: "note-9", position: "right-of", participants: ["api"], text: long }],
    });
    mount({ layout });
    const note = screen.getByRole("note", { name: `Note right of API: ${long}` });
    const lines = [...note.querySelectorAll("tspan")].map((t) => t.textContent);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines).toEqual(layout.notes[0].lines);
  });

  it("dims with everything else outside the focus, and stays lit beside a focused participant", () => {
    mount({ focus: { participantIds: ["user"] } });
    expect(screen.getByRole("note", { name: SIGNED_OUT })).toHaveAttribute("opacity", `${FOCUSED_OPACITY}`);
    expect(screen.getByRole("note", { name: TLS })).toHaveAttribute("opacity", `${DIMMED_OPACITY}`);
  });
});

describe("a note is an annotation, never a target", () => {
  it("is not focusable, not a button and carries no selectable identity", () => {
    const { container } = mount();
    for (const note of screen.getAllByRole("note")) {
      for (const element of [note, ...note.querySelectorAll("*")]) {
        expect(element).not.toHaveAttribute("tabindex");
        expect(element).not.toHaveAttribute("data-seq-id");
        expect(element).not.toHaveAttribute("data-seq-channel");
        expect(element).not.toHaveAttribute("aria-pressed");
        expect(element).not.toHaveClass("archer-seq-selectable");
      }
    }
    expect(container.querySelector("[data-seq-id^='note-']")).toBeNull();
  });

  it("adds nothing to the tab order: still one stop per ring, and one target per participant and message", () => {
    const { container, layout } = mount();
    expect(container.querySelectorAll("[tabindex='0']")).toHaveLength(2);
    expect(container.querySelectorAll("[tabindex]")).toHaveLength(layout.participants.length + layout.messages.length);
  });

  it("a click on a note selects nothing: it is a click on the canvas", () => {
    const { onNodeClick, onEdgeClick, onPaneClick } = mount();
    fireEvent.click(screen.getByText("Signed out"));
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(onEdgeClick).not.toHaveBeenCalled();
    expect(onPaneClick).toHaveBeenCalledOnce();
  });

  it("does not light up under the pointer", () => {
    const { container } = mount();
    fireEvent.pointerOver(screen.getByText("Signed out"));
    expect(container.querySelector(".archer-seq-hover")).toBeNull();
    // The control: the same gesture on a participant does.
    fireEvent.pointerOver(screen.getByText("Web app"));
    expect(container.querySelector(".archer-seq-hover")).not.toBeNull();
  });

  it("is stepped over by the keyboard: Down goes from the message before it to the message after", () => {
    const { layout } = mount();
    // `note-1` is written between msg-1 and msg-2.
    const ids = layout.messages.map((m) => m.id);
    expect(ids.slice(1, 3)).toEqual(["msg-1", "msg-2"]);
    const before = screen.getByRole("button", { name: /^2\. Web app to API/ });
    act(() => before.focus());
    fireEvent.keyDown(before, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^3\. API to Web app/ }));
    expect(document.activeElement?.closest("[role='note']")).toBeNull();
  });

  it("is not in the selection model, so it cannot be selected by any route", () => {
    const view = widenedView();
    const model = sequenceSelectionModel(view);
    const ids = [...model.nodeDetails.keys(), ...model.edgeDetails.keys()];
    expect(ids.some((id) => id.startsWith("note-"))).toBe(false);
    expect(ids).toEqual(["user", "web", "api", "msg-0", "msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
  });
});

describe("a note never reaches the published selection", () => {
  type Published = { nodes: { id: string }[]; edges: { id: string }[] };
  const lastPublished = (): Published => {
    const posts = selectionPosts();
    expect(posts.length).toBeGreaterThan(0);
    const [, init] = posts[posts.length - 1] as [string, { body: string }];
    return JSON.parse(init.body) as Published;
  };
  const selected = (container: HTMLElement): string[] =>
    [...container.querySelectorAll(".archer-seq-selected[data-seq-id]")]
      .map((el) => el.getAttribute("data-seq-id")!)
      .sort();

  async function mountApp() {
    const mounted = await mountAgentPresented(<App />, {
      envelope: ENVELOPE,
      ready: (container) => {
        expect(container.querySelector("[aria-label='Sequence diagram canvas']")).not.toBeNull();
        expect(within(container).getAllByRole("note")).toHaveLength(4);
      },
    });
    fireEvent.click(within(mounted.container).getByRole("button", { name: "Select mode" }));
    return mounted;
  }

  it("select-all publishes every participant and message and no note", async () => {
    const { container } = await mountApp();
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    await waitFor(() => expect(selected(container)).toHaveLength(9));
    await settle();
    const published = lastPublished();
    expect(published.nodes.map((n) => n.id)).toEqual(["user", "web", "api"]);
    expect(published.edges.map((e) => e.id)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
    expect(JSON.stringify(published)).not.toContain("note-");
  });

  it("clicking a note, plain or with Shift, adds nothing to what is published", async () => {
    const { container } = await mountApp();
    fireEvent.click(screen.getByText("Web app"));
    await waitFor(() => expect(selected(container)).toEqual(["web"]));
    fireEvent.click(screen.getByText("Signed out"), { shiftKey: true });
    fireEvent.click(screen.getByText("Signed out"));
    await settle();
    expect(JSON.stringify(lastPublished())).not.toContain("note-");
    expect(selected(container).some((id) => id.startsWith("note-"))).toBe(false);
  });
});

describe("an actor reads as a person", () => {
  it("draws a figure in the actor's box and in no other", () => {
    mount();
    const actor = screen.getByRole("button", { name: "End user, actor" });
    expect(actor.querySelector(".archer-seq-actor-glyph")).not.toBeNull();
    for (const name of ["Web app", "API"]) {
      expect(screen.getByRole("button", { name }).querySelector(".archer-seq-actor-glyph")).toBeNull();
    }
  });

  it("draws the figure as inline SVG in one stroke weight, with no emoji or symbol glyph", () => {
    mount();
    const glyph = screen.getByRole("button", { name: "End user, actor" }).querySelector(".archer-seq-actor-glyph")!;
    const shapes = [...glyph.querySelectorAll("circle, path, line")];
    expect(shapes.length).toBeGreaterThan(1);
    expect(new Set(shapes.map((shape) => shape.getAttribute("stroke-width")))).toEqual(new Set(["1.5"]));
    expect(glyph.textContent).toBe("");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    // The only text in the box is the name itself.
    expect(screen.getByRole("button", { name: "End user, actor" }).textContent).toBe("End user");
  });

  it("keeps the figure and the name inside the box, side by side", () => {
    const { layout } = mount();
    const p = layout.participants[0];
    const group = screen.getByRole("button", { name: "End user, actor" });
    const glyph = group.querySelector(".archer-seq-actor-glyph")!;
    const [, tx] = /translate\(([-\d.]+) /.exec(glyph.getAttribute("transform")!)!;
    const textX = Number(group.querySelector("text")!.getAttribute("x"));
    expect(Number(tx)).toBeGreaterThanOrEqual(p.x + 8);
    expect(textX).toBeGreaterThan(Number(tx) + 14);
    expect(textX).toBeLessThan(p.x + p.width);
  });

  it("behaves as any participant does: same box, ring stop, hover, selection and keyboard ring", () => {
    const { container, onNodeClick } = mount({ selection: { nodeIds: ["user"], edgeIds: [] } });
    const actor = screen.getByRole("button", { name: "End user, actor" });
    const system = screen.getByRole("button", { name: "Web app" });

    // The first participant is the ring's stop, actor or not.
    expect(actor).toHaveAttribute("tabindex", "0");
    expect(actor).toHaveAttribute("aria-pressed", "true");
    expect(actor).toHaveClass("archer-seq-participant", "archer-seq-selected", "archer-seq-selectable");
    const box = (el: Element) => el.querySelector(".archer-seq-participant-box")!;
    for (const attribute of ["y", "height", "rx"]) {
      expect(box(actor).getAttribute(attribute)).toBe(box(system).getAttribute(attribute));
    }
    expect(actor.querySelector(".archer-seq-participant-halo")).not.toBeNull();

    fireEvent.click(screen.getByText("End user"));
    expect(onNodeClick).toHaveBeenCalledExactlyOnceWith("user", false);

    fireEvent.pointerOver(screen.getByText("End user"));
    expect(actor).toHaveClass("archer-seq-hover");

    act(() => actor.focus());
    expect(actor).toHaveClass("archer-seq-kbd-focus");
    expect(actor.querySelector(".archer-seq-participant-ring")).not.toBeNull();
    fireEvent.keyDown(actor, { key: "ArrowRight" });
    expect(document.activeElement).toBe(system);
    expect(container.querySelectorAll(".archer-seq-participant-ring")).toHaveLength(1);
  });
});

describe("autonumber", () => {
  it("shows each message's number in a badge at the start of its arrow", () => {
    const { container, layout } = mount();
    const badges = [...container.querySelectorAll(".archer-seq-message-number")];
    expect(badges.map((b) => b.textContent)).toEqual(["1", "2", "3", "4", "5", "6"]);
    layout.messages.forEach((message, i) => {
      const group = container.querySelector(`[data-seq-id='${message.id}']`)!;
      const badge = group.querySelector(".archer-seq-message-number")!;
      expect(badge).toBe(badges[i]);
      const plate = badge.querySelector("rect")!;
      const centre = Number(plate.getAttribute("x")) + Number(plate.getAttribute("width")) / 2;
      expect(centre).toBeCloseTo(message.fromX, 5);
      expect(Number(plate.getAttribute("y")) + Number(plate.getAttribute("height")) / 2).toBeCloseTo(message.y, 5);
    });
  });

  it("names each message with its number", () => {
    mount();
    expect(screen.getByRole("button", { name: "1. End user to Web app: Open dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2. Web app to API: GET /session" })).toBeInTheDocument();
  });

  it("does not let the badge double the number in what a screen reader hears", () => {
    const { container } = mount();
    for (const badge of container.querySelectorAll(".archer-seq-message-number")) {
      expect(badge).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("clicking the badge selects its message", () => {
    const { container, onEdgeClick } = mount();
    fireEvent.click(container.querySelectorAll(".archer-seq-message-number text")[1]);
    expect(onEdgeClick).toHaveBeenCalledExactlyOnceWith("msg-1", false);
  });

  it("draws no badge and no number in the name when the trace is not autonumbered", () => {
    const layout = computeSequenceLayout({ ...widenedView(), autonumber: undefined });
    const { container } = mount({ layout });
    expect(container.querySelector(".archer-seq-message-number")).toBeNull();
    expect(screen.getByRole("button", { name: "End user to Web app: Open dashboard" })).toBeInTheDocument();
  });
});
