// @vitest-environment jsdom
//
// The Sequence tab (ADR 0034 §6): the walkthrough's messages as a sequence diagram, the current one
// lit, a card under it, a press on a message steps. Driven through its props, as the slot drives it.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Walk, WalkStep } from "../src/walkthroughs/contract";
import { SequenceTab } from "../src/walkthroughs/SequenceTab";
import { WalkthroughPanel } from "../src/walkthroughs/WalkthroughPanel";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const LABELS: Record<string, string> = { customer: "Customer", web: "Storefront", api: "Shop API", pay: "Payments" };
const labelOf = (id: string) => LABELS[id] ?? id;
const step = (title: string, messages: WalkStep["messages"], over: Partial<WalkStep> = {}): WalkStep => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  kind: "sends",
  what: `${title} what`,
  why: `${title} why`,
  code: [],
  nodes: [],
  edges: [],
  messages,
  status: "current",
  ...over,
});
const walk: Walk = {
  id: "declined",
  title: "Declined card",
  modelRevision: "r",
  open: [],
  status: "partly-out-of-date",
  outOfDate: [3],
  steps: [
    step("Pay", [
      { from: "customer", to: "web", label: "pay" },
      { from: "web", to: "api", label: "POST /pay" },
    ]),
    step("Reserve", [], { kind: "does" }),
    step("Charge", [{ from: "api", to: "pay", label: "charge" }], { status: "out-of-date" }),
    step("Declined", [{ from: "pay", to: "api", label: "declined" }]),
  ],
};

const messages = () => [...document.querySelectorAll<SVGGElement>(".archer-seq-message")];

describe("SequenceTab", () => {
  it("draws one message per hop, labelled, with the participants as headers", () => {
    render(<SequenceTab walk={walk} step={1} labelOf={labelOf} badges={new Map()} onGo={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Sequence of Declined card" })).toBeInTheDocument();
    expect(messages()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Step 1: Customer to Storefront: pay" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Step 4: Payments to Shop API: declined" })).toBeInTheDocument();
    expect([...document.querySelectorAll(".archer-seq-participant")].map((p) => p.textContent)).toEqual([
      "Customer",
      "Storefront",
      "Shop API",
      "Payments",
    ]);
  });

  it("numbers each step once, at the left of its first message", () => {
    render(<SequenceTab walk={walk} step={1} labelOf={labelOf} badges={new Map()} onGo={vi.fn()} />);
    expect([...document.querySelectorAll(".archer-walk-seq-num")].map((n) => n.textContent)).toEqual(["1", "3", "4"]);
  });

  it("lights the current message, quiets the walked ones and fades the rest", () => {
    render(<SequenceTab walk={walk} step={4} labelOf={labelOf} badges={new Map()} onGo={vi.fn()} />);
    const [m1, m2, m3, m4] = messages();
    expect([m1, m2, m3, m4].map((m) => m!.getAttribute("data-state"))).toEqual(["done", "done", "stale", "active"]);
    expect(m4).toHaveClass("archer-emph", "archer-emph-style-flow");
    expect(m1).toHaveClass("archer-emph--walked");
    expect(m3).not.toHaveClass("archer-emph");
    expect(m4).toHaveAttribute("aria-current", "step");
    expect(m1).not.toHaveAttribute("aria-current");
    // The moving arrows ride the lit message only.
    expect(m4!.querySelector(".archer-emph-chevron")).not.toBeNull();
    expect(m1!.querySelector(".archer-emph-chevron")).toBeNull();
  });

  it("fades what is still to come", () => {
    render(<SequenceTab walk={walk} step={1} labelOf={labelOf} badges={new Map()} onGo={vi.fn()} />);
    expect(messages().map((m) => m.getAttribute("data-state"))).toEqual(["active", "active", "stale", "future"]);
  });

  it("says an out-of-date message is out of date", () => {
    render(<SequenceTab walk={walk} step={1} labelOf={labelOf} badges={new Map()} onGo={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Step 3: Shop API to Payments: charge. Out of date." }),
    ).toBeInTheDocument();
  });

  it("steps to a message's step on a press or Enter; Space is left to the panel's Play", () => {
    const onGo = vi.fn();
    render(<SequenceTab walk={walk} step={1} labelOf={labelOf} badges={new Map()} onGo={onGo} />);
    fireEvent.click(screen.getByRole("button", { name: "Step 4: Payments to Shop API: declined" }));
    expect(onGo).toHaveBeenLastCalledWith(4);
    const first = screen.getByRole("button", { name: "Step 1: Storefront to Shop API: POST /pay" });
    const enter = fireEvent.keyDown(first, { key: "Enter" });
    expect(onGo).toHaveBeenLastCalledWith(1);
    expect(enter).toBe(false);
    onGo.mockClear();
    const space = fireEvent.keyDown(first, { key: " " });
    expect(space).toBe(true);
    expect(onGo).not.toHaveBeenCalled();
  });

  it("shows the current step's card under the drawing, even when the step has no message", () => {
    const { rerender } = render(
      <SequenceTab walk={walk} step={4} labelOf={labelOf} badges={new Map()} onGo={vi.fn()} />,
    );
    const card = document.querySelector<HTMLElement>(".archer-walk-seq-card")!;
    expect(within(card).getByText("Declined")).toBeInTheDocument();
    expect(within(card).getByText("Declined what")).toBeInTheDocument();
    rerender(<SequenceTab walk={walk} step={2} labelOf={labelOf} badges={new Map()} onGo={vi.fn()} />);
    expect(
      within(document.querySelector<HTMLElement>(".archer-walk-seq-card")!).getByText("Reserve"),
    ).toBeInTheDocument();
    expect(messages().map((m) => m.getAttribute("data-state"))).toEqual(["done", "done", "stale", "future"]);
  });
});

describe("the tab in the panel", () => {
  const props = {
    walks: [walk],
    state: { open: true, id: "declined", step: 1, count: 4, playing: false },
    labelOf,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onGo: vi.fn(),
    onTogglePlay: vi.fn(),
  };
  const tab = <SequenceTab walk={walk} step={1} labelOf={labelOf} badges={new Map()} onGo={vi.fn()} />;

  it("is offered only when there is a body for it, and swaps it for the steps", () => {
    const { unmount } = render(<WalkthroughPanel {...props} />);
    expect(screen.queryByRole("tab", { name: "Sequence" })).toBeNull();
    unmount();
    render(<WalkthroughPanel {...props} sequence={() => tab} />);
    expect(screen.getByRole("tab", { name: "Steps" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Sequence" }));
    expect(screen.getByRole("tab", { name: "Sequence" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("group", { name: "Sequence of Declined card" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /Steps of/ })).toBeNull();
  });

  it("remembers the tab for the viewer", () => {
    const first = render(<WalkthroughPanel {...props} sequence={() => tab} />);
    fireEvent.click(screen.getByRole("tab", { name: "Sequence" }));
    first.unmount();
    render(<WalkthroughPanel {...props} sequence={() => tab} />);
    expect(screen.getByRole("tab", { name: "Sequence" })).toHaveAttribute("aria-selected", "true");
  });

  it("steps by the wheel over the tab, and lets a sideways scroll through", () => {
    const onGo = vi.fn();
    render(<WalkthroughPanel {...props} onGo={onGo} sequence={() => tab} />);
    fireEvent.click(screen.getByRole("tab", { name: "Sequence" }));
    const svg = document.querySelector("svg")!;
    const sideways = new WheelEvent("wheel", { deltaX: 80, deltaY: 4, bubbles: true, cancelable: true });
    svg.dispatchEvent(sideways);
    expect(sideways.defaultPrevented).toBe(false);
    const down = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    svg.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(onGo).toHaveBeenCalledWith("next");
  });
});

describe("a step that is gone", () => {
  it("draws without its card instead of throwing", () => {
    render(<SequenceTab walk={walk} step={9} labelOf={labelOf} badges={new Map()} onGo={vi.fn()} />);
    expect(messages()).toHaveLength(4);
    expect(document.querySelector(".archer-walk-seq-card")).toBeNull();
  });
});
