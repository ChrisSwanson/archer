// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { computeSequenceLayout, type SequenceLayoutResult } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { DIMMED_OPACITY as DIMMED, FOCUSED_OPACITY as FOCUSED } from "../src/diagrams/focus-style";
import { loadValidFixture } from "./fixtures";

function sequenceLayout(): SequenceLayoutResult {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence") {
    throw new Error("minimal-sequence.json did not project to a sequence view");
  }
  return computeSequenceLayout(projection.view);
}

afterEach(cleanup);

describe("SequenceCanvas rendering", () => {
  it("renders every participant and every message from the layout", () => {
    const layout = sequenceLayout();
    const { container } = render(<SequenceCanvas layout={layout} />);

    for (const participant of layout.participants) {
      expect(screen.getByText(participant.label)).toBeInTheDocument();
    }
    expect(screen.getByText("Client")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();

    for (const message of layout.messages) {
      if (message.label) {
        expect(screen.getByText(message.label)).toBeInTheDocument();
      }
    }
    expect(screen.getByText("POST /login")).toBeInTheDocument();

    // One dashed lifeline per participant.
    expect(container.querySelectorAll("line[stroke-dasharray='6 4']")).toHaveLength(layout.participants.length);
  });

  it("renders fragments with their kind and label", () => {
    render(<SequenceCanvas layout={sequenceLayout()} />);

    expect(screen.getByText("alt")).toBeInTheDocument();
    expect(screen.getByText("[Credentials valid?]")).toBeInTheDocument();
    expect(screen.getByText("[Invalid]")).toBeInTheDocument();
  });

  it("paints a fragment's header and section labels above the lifelines that run through its frame", () => {
    // Seen in the browser: the frame, its chip and its labels were all drawn
    // first, as background, so a lifeline and its activation bar ran straight
    // through the header text -- "[Auth|rised]". The frame stays underneath;
    // the words go on top.
    const { container } = render(<SequenceCanvas layout={sequenceLayout()} />);
    const lifelines = [...container.querySelectorAll("line[stroke-dasharray='6 4']")];
    const activations = [...container.querySelectorAll("rect.archer-seq-activation")];
    const frame = container.querySelector(".archer-seq-fragment > rect")!;
    const paintsAfter = (later: Element, earlier: Element): boolean =>
      (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    for (const text of ["alt", "[Credentials valid?]", "[Invalid]"]) {
      const label = screen.getByText(text);
      for (const under of [...lifelines, ...activations]) {
        expect(paintsAfter(label, under), text).toBe(true);
      }
    }
    // The frame itself is still background: under every lifeline.
    for (const lifeline of lifelines) {
      expect(paintsAfter(lifeline, frame)).toBe(true);
    }
  });

  it("dims every focusable element outside the focus set", () => {
    const layout = sequenceLayout();
    const { container } = render(
      <SequenceCanvas layout={layout} focus={{ participantIds: ["server"], messageIds: ["msg-0"] }} />,
    );

    // Participant boxes.
    expect(screen.getByText("Server").closest("g")).toHaveAttribute("opacity", `${FOCUSED}`);
    expect(screen.getByText("Client").closest("g")).toHaveAttribute("opacity", `${DIMMED}`);
    expect(screen.getByText("Database").closest("g")).toHaveAttribute("opacity", `${DIMMED}`);

    // Message arrows. `msg-0` is "POST /login"; every other message is outside
    // the focus set, including one nested inside a fragment.
    expect(screen.getByText("POST /login").closest("g")).toHaveAttribute("opacity", `${FOCUSED}`);
    expect(screen.getByText("SELECT user").closest("g")).toHaveAttribute("opacity", `${DIMMED}`);
    expect(screen.getByText("user record").closest("g")).toHaveAttribute("opacity", `${DIMMED}`);
    expect(screen.getByText("401 Unauthorized").closest("g")).toHaveAttribute("opacity", `${DIMMED}`);

    // Lifelines follow their own participant, in layout order.
    const lifelines = [...container.querySelectorAll("line[stroke-dasharray='6 4']")];
    expect(lifelines).toHaveLength(layout.participants.length);
    const lifelineOpacity = new Map(layout.participants.map((p, i) => [p.id, lifelines[i]?.getAttribute("opacity")]));
    expect(lifelineOpacity.get("server")).toBe(`${FOCUSED}`);
    expect(lifelineOpacity.get("client")).toBe(`${DIMMED}`);
    expect(lifelineOpacity.get("db")).toBe(`${DIMMED}`);

    // Activation bars follow their participant too; the only activation in the
    // fixture belongs to the focused `server`.
    // Selected by class, not by colour: an activation bar's identity is what
    // it is, not what shade it happens to be painted in this theme.
    const activations = [...container.querySelectorAll("rect.archer-seq-activation")];
    expect(activations).toHaveLength(layout.activations.length);
    expect(activations[0]).toHaveAttribute("opacity", `${FOCUSED}`);
  });

  it("dims a participant whose only messages are outside the focus set", () => {
    // Guards the participant/message focus axes against being conflated: a
    // message-only focus must not leave every participant lit.
    render(<SequenceCanvas layout={sequenceLayout()} focus={{ messageIds: ["msg-0"] }} />);

    expect(screen.getByText("Client").closest("g")).toHaveAttribute("opacity", `${DIMMED}`);
    expect(screen.getByText("Server").closest("g")).toHaveAttribute("opacity", `${DIMMED}`);
    expect(screen.getByText("POST /login").closest("g")).toHaveAttribute("opacity", `${FOCUSED}`);
  });

  it("renders undimmed when no focus is supplied", () => {
    render(<SequenceCanvas layout={sequenceLayout()} />);
    expect(screen.getByText("Client").closest("g")).toHaveAttribute("opacity", `${FOCUSED}`);
    expect(screen.getByText("POST /login").closest("g")).toHaveAttribute("opacity", `${FOCUSED}`);
  });

  it("leaves fragment containers at full opacity while focus dims their contents", () => {
    // Deliberate omission, documented in src/diagrams/focus-style.ts: fragments
    // are structural containers and can never appear in a focus set, so they
    // carry no focus state and are never dimmed. Their contained messages are.
    render(<SequenceCanvas layout={sequenceLayout()} focus={{ messageIds: ["msg-0"] }} />);

    const fragment = screen.getByText("alt").closest("g");
    expect(fragment).not.toHaveAttribute("opacity");
    expect(screen.getByText("401 Unauthorized").closest("g")).toHaveAttribute("opacity", `${DIMMED}`);
  });
});

describe("two-way and multi-line messages (MC handoff)", () => {
  const heads = (container: HTMLElement, id: string) =>
    container.querySelectorAll(
      `.archer-seq-message[data-seq-id="${id}"] .archer-seq-message-stroke > :is(polygon, polyline)`,
    ).length;

  it("draws a second head at the sender of a two-way message", () => {
    const layout = sequenceLayout();
    const [first, second] = layout.messages;
    const twoWay = {
      ...layout,
      messages: layout.messages.map((m) => (m.id === first!.id ? { ...m, bidirectional: true } : m)),
    };
    const { container } = render(<SequenceCanvas layout={twoWay} />);
    expect(heads(container, first!.id)).toBe(2);
    expect(heads(container, second!.id)).toBe(1);
  });

  it("renders every line of a self-message label", () => {
    const layout = sequenceLayout();
    const [first] = layout.messages;
    const self = {
      ...layout,
      messages: layout.messages.map((m) =>
        m.id === first!.id ? { ...m, to: m.from, toX: m.fromX, label: "one\ntwo", lines: ["one", "two"] } : m,
      ),
    };
    const { container } = render(<SequenceCanvas layout={self} />);
    const text = container.querySelector(
      `.archer-seq-message[data-seq-id="${first!.id}"] text:not(.archer-seq-message-number text)`,
    );
    expect([...text!.querySelectorAll("tspan")].map((t) => t.textContent)).toEqual(["one", "two"]);
  });
});
