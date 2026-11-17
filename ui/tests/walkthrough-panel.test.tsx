// @vitest-environment jsdom
//
// The walkthrough panel (ADR 0034 §6): picker, status line, the steps as a document, the transport
// bar, the divider. Driven through its props, as the page hook drives it.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Walk, WalkStep } from "../src/walkthroughs/contract";
import {
  PANEL_WIDTH as WALK_WIDTH,
  PANEL_WIDTH_KEY as WALK_WIDTH_KEY,
  PanelDivider as WalkDivider,
  readPanelWidth as readWalkWidth,
  savePanelWidth as saveWalkWidth,
} from "../src/app/PanelDivider";
import { WalkTransport, WalkthroughPanel } from "../src/walkthroughs/WalkthroughPanel";
import { INITIAL_WALK, type WalkState } from "../src/walkthroughs/walk-player";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const LABELS: Record<string, string> = {
  customer: "Customer",
  web: "Storefront",
  api: "Shop API",
  db: "Shop database",
};
const labelOf = (id: string) => LABELS[id] ?? id;
const step = (title: string, over: Partial<WalkStep> = {}): WalkStep => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  kind: "sends",
  what: `${title} what`,
  why: `${title} why`,
  code: [`src/${title}.ts`],
  nodes: [],
  edges: [],
  messages: [],
  status: "current",
  ...over,
});
const edge = (source: string, target: string): WalkStep["edges"][number] => ({
  id: `${source}--${target}`,
  source,
  target,
});
const checkout: Walk = {
  id: "checkout",
  title: "Checkout and payment",
  modelRevision: "sha256:now",
  open: [],
  status: "current",
  outOfDate: [],
  steps: [
    step("Check out", { edges: [edge("customer", "web")] }),
    step("Place the order", { edges: [edge("web", "api")] }),
    step("Reserve the stock", { kind: "does", edges: [edge("api", "db")] }),
  ],
};
const old: Walk = {
  ...checkout,
  id: "old",
  title: "Order shipped",
  modelRevision: "sha256:then",
  status: "archived",
  outOfDate: [1, 2, 3],
  steps: checkout.steps.map((s) => ({ ...s, status: "out-of-date" as const })),
};
const partly: Walk = {
  ...checkout,
  id: "partly",
  title: "Declined card",
  status: "partly-out-of-date",
  outOfDate: [2],
  steps: [checkout.steps[0]!, { ...checkout.steps[1]!, status: "out-of-date" }, checkout.steps[2]!],
};

const listing: WalkState = { ...INITIAL_WALK, open: true };
const at = (id: string, count: number, stepNo: number): WalkState => ({
  open: true,
  id,
  count,
  step: stepNo,
  playing: false,
});

function mount(
  state: WalkState,
  walks: readonly Walk[] = [old, checkout, partly],
  over: Partial<Parameters<typeof WalkthroughPanel>[0]> = {},
) {
  const calls = { select: vi.fn(), show: vi.fn(), close: vi.fn(), go: vi.fn(), play: vi.fn() };
  const props = {
    walks,
    state,
    revision: "sha256:now",
    labelOf,
    onSelect: calls.select,
    onShow: calls.show,
    onClose: calls.close,
    onGo: calls.go,
    onTogglePlay: calls.play,
    ...over,
  };
  const view = render(<WalkthroughPanel {...props} />);
  return {
    ...view,
    calls,
    props,
    again: (next: WalkState) => view.rerender(<WalkthroughPanel {...props} state={next} />),
  };
}

describe("the picker", () => {
  it("lists the current walkthroughs first, then Archived, greyed, and chooses on a press", () => {
    const { calls } = mount(listing);
    const list = screen.getByRole("group", { name: "Walkthroughs on this diagram" });
    const headings = within(list)
      .getAllByRole("heading")
      .map((h) => h.textContent);
    expect(headings).toEqual(["On This Diagram", "Archived"]);
    const names = within(list)
      .getAllByRole("button")
      .map((b) => b.querySelector(".archer-walk-item-title")?.textContent);
    expect(names).toEqual(["Checkout and payment", "Declined card", "Order shipped"]);
    expect(within(list).getByRole("button", { name: /Order shipped/ })).toHaveClass("archived");
    fireEvent.click(within(list).getByRole("button", { name: /Declined card/ }));
    expect(calls.select).toHaveBeenCalledWith("partly");
  });

  it("the status line counts them", () => {
    mount(listing);
    expect(screen.getByText("2 on this diagram · 1 archived")).toBeInTheDocument();
  });

  it("is a menu button over a chosen walkthrough, current marked, closing on choosing", () => {
    const { calls } = mount(at("checkout", 3, 1));
    const button = screen.getByRole("button", { name: /Walkthrough Checkout and payment/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("group", { name: "Walkthroughs on this diagram" });
    expect(within(menu).getByRole("button", { name: /Checkout and payment/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(within(menu).getByRole("button", { name: /Declined card/ }));
    expect(calls.select).toHaveBeenCalledWith("partly");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("Escape closes an open menu without closing the panel", () => {
    const { calls } = mount(at("checkout", 3, 1));
    const button = screen.getByRole("button", { name: /Walkthrough Checkout and payment/ });
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("group", { name: "Walkthroughs on this diagram" }), { key: "Escape" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    expect(calls.close).not.toHaveBeenCalled();
  });
});

describe("the status line and notices", () => {
  it("says when it was written for this version, and how many steps are out of date", () => {
    mount(at("checkout", 3, 1));
    expect(screen.getByText("3 steps · written for this version")).toBeInTheDocument();
    cleanup();
    mount(at("partly", 3, 1));
    expect(document.querySelector(".archer-walk-meta")).toHaveTextContent(
      "3 steps · written for this version · 1 out of date",
    );
    expect(screen.getByRole("note")).toHaveTextContent("1 step out of date");
  });

  it("says an archived walkthrough matches nothing", () => {
    mount(at("old", 3, 1));
    expect(screen.getByText(/3 steps · archived/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("None of its 3 steps match this diagram any more");
  });
});

describe("the steps", () => {
  it("lists every step with number, title and from → to, and opens only the current step's details", () => {
    mount(at("checkout", 3, 2));
    const steps = screen.getByRole("list", { name: "Steps of Checkout and payment" });
    const heads = within(steps).getAllByRole("button", { name: /^\d/ });
    expect(heads.map((h) => h.textContent)).toEqual([
      "1Check outCustomer → Storefront",
      "2Place the orderStorefront → Shop API",
      "3Reserve the stockShop API → Shop database",
    ]);
    expect(heads.map((h) => h.getAttribute("aria-expanded"))).toEqual(["false", "true", "false"]);
    const items = within(steps).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual(["done", "active", "future"]);
    expect(items.map((li) => li.querySelector(".archer-walk-more")?.hasAttribute("inert"))).toEqual([
      true,
      false,
      true,
    ]);
    expect(within(items[1]!).getByText("Place the order what")).toBeInTheDocument();
    expect(within(items[1]!).getByText("src/Place the order.ts")).toBeInTheDocument();
  });

  it("marks the current step aria-current and nothing else", () => {
    mount(at("checkout", 3, 3));
    const current = document.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Reserve the stock");
  });

  it("jumps on a press of a step", () => {
    const { calls } = mount(at("checkout", 3, 1));
    fireEvent.click(screen.getByRole("button", { name: /^3/ }));
    expect(calls.go).toHaveBeenCalledWith(3);
  });

  it("greys an out-of-date step and says so; a step with messages but no line says so", () => {
    mount(at("partly", 3, 1));
    const second = screen.getByRole("button", { name: /^2/ }).closest("li")!;
    expect(second).toHaveClass("stale");
    expect(within(second).getByText("Out of date")).toBeInTheDocument();
    cleanup();
    const noLine = {
      ...checkout,
      steps: [step("Pay on the hosted page", { messages: [{ from: "customer", to: "web", label: "x" }] })],
    };
    mount(at("checkout", 1, 1), [noLine]);
    expect(screen.getByText("No line in this diagram")).toBeInTheDocument();
  });
});

describe("the announcement", () => {
  it("says the step, its title and its route, politely, and says it again on a step", () => {
    const { again } = mount(at("checkout", 3, 1));
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live).toHaveTextContent("Checkout and payment. Step 1 of 3: Check out. Customer → Storefront.");
    again(at("checkout", 3, 3));
    expect(live).toHaveTextContent("Step 3 of 3: Reserve the stock. Shop API → Shop database.");
    expect(live).not.toHaveTextContent("Checkout and payment");
  });
});

describe("the announcement, again", () => {
  it("does not repeat itself when the walkthroughs are read again with nothing changed", () => {
    const { props } = mount(at("checkout", 3, 2));
    const live = document.querySelector(".archer-visually-hidden[aria-live]")!;
    const said = live.textContent;
    expect(said).toContain("Step 2 of 3");
    fireEvent.keyDown(document.body, { key: "x" });
    cleanup();
    const view = render(<WalkthroughPanel {...props} walks={[{ ...checkout }, old, partly]} />);
    expect(view.container.querySelector(".archer-visually-hidden[aria-live]")!.textContent).toContain(
      "Checkout and payment. Step 2 of 3",
    );
    view.rerender(<WalkthroughPanel {...props} walks={[{ ...checkout }, old, partly]} />);
    expect(view.container.querySelector(".archer-visually-hidden[aria-live]")!.textContent).toContain(
      "Checkout and payment. Step 2 of 3",
    );
  });
});

describe("keys", () => {
  const press = (key: string, target: Element | Document = document.body, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(target, { key, ...init });

  it("← → Home End step, wherever focus is but a text field", () => {
    const { calls } = mount(at("checkout", 3, 2));
    press("ArrowRight");
    press("ArrowLeft");
    press("Home");
    press("End");
    expect(calls.go.mock.calls.map((c) => c[0])).toEqual(["next", "prev", "first", "last"]);
  });

  it("a text field keeps ← → Home End", () => {
    const { calls } = mount(at("checkout", 3, 2));
    const field = document.createElement("input");
    document.body.append(field);
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) press(key, field);
    const area = document.createElement("textarea");
    document.body.append(area);
    press("ArrowRight", area);
    expect(calls.go).not.toHaveBeenCalled();
    field.remove();
    area.remove();
  });

  it("↑ ↓ step over the panel, and only over the panel", () => {
    const { calls } = mount(at("checkout", 3, 2));
    press("ArrowDown");
    press("ArrowUp");
    expect(calls.go).not.toHaveBeenCalled();
    const panel = screen.getByRole("region", { name: "Walkthrough" });
    press("ArrowDown", panel);
    press("ArrowUp", panel);
    expect(calls.go.mock.calls.map((c) => c[0])).toEqual(["next", "prev"]);
    fireEvent.pointerEnter(panel);
    press("ArrowDown");
    expect(calls.go).toHaveBeenCalledTimes(3);
    fireEvent.pointerLeave(panel);
    press("ArrowDown");
    expect(calls.go).toHaveBeenCalledTimes(3);
  });

  it("leaves a key alone that something else already took, or that carries a modifier", () => {
    const { calls } = mount(at("checkout", 3, 2));
    const taken = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    press("ArrowRight", document.body, { ctrlKey: true });
    press("ArrowRight", document.body, { metaKey: true });
    expect(calls.go).not.toHaveBeenCalled();
  });

  it("does nothing while the picker lists", () => {
    const listed = mount(listing);
    press("ArrowRight");
    press(" ");
    expect(listed.calls.go).not.toHaveBeenCalled();
    expect(listed.calls.play).not.toHaveBeenCalled();
  });

  // Space plays, pauses, or plays again from the start wherever the walkthrough is: the page, a step row
  // (where focus lands on opening one), a Sequence message, the step controls and the diagram itself.
  it("Space plays from the page, a step row, the step controls and the diagram", () => {
    const { calls } = mount(at("checkout", 3, 2));
    const canvas = document.createElement("div");
    canvas.className = "react-flow";
    canvas.innerHTML = '<div class="react-flow__node" tabindex="0"></div>';
    document.body.append(canvas);
    const transport = render(
      <WalkTransport walks={[checkout]} state={at("checkout", 3, 2)} onGo={calls.go} onTogglePlay={calls.play} />,
    );
    const targets: Element[] = [
      document.body,
      screen.getByRole("button", { name: /^1/ }),
      within(transport.container).getByRole("slider", { name: "Step" }),
      within(transport.container).getByRole("button", { name: "Next step" }),
      canvas.querySelector(".react-flow__node")!,
    ];
    for (const target of targets)
      expect(press(" ", target), `Space is taken on ${target.className || target.tagName}`).toBe(false);
    expect(calls.play).toHaveBeenCalledTimes(targets.length);
    expect(calls.go).not.toHaveBeenCalled();
    canvas.remove();
  });

  it("a released Space does not also press the focused button", () => {
    mount(at("checkout", 3, 2));
    const row = screen.getByRole("button", { name: /^1/ });
    press(" ", row);
    expect(fireEvent.keyUp(row, { key: " " }), "the release that would click the row").toBe(false);
    expect(fireEvent.keyUp(row, { key: " " }), "only the release that follows").toBe(true);
  });

  it("Space stays with the Play button itself, text fields, controls outside the walkthrough, and modifiers", () => {
    const { calls } = mount(at("checkout", 3, 2));
    const transport = render(
      <WalkTransport walks={[checkout]} state={at("checkout", 3, 2)} onGo={calls.go} onTogglePlay={calls.play} />,
    );
    const outside = document.createElement("button");
    const field = document.createElement("textarea");
    const pane = document.createElement("div");
    document.body.append(outside, field, pane);
    press(" ", within(transport.container).getByRole("button", { name: "Play" }));
    press(" ", outside);
    press(" ", field);
    press(" ", pane);
    press(" ", document.body, { shiftKey: true });
    press(" ", document.body, { ctrlKey: true });
    expect(calls.play).not.toHaveBeenCalled();
    // Held down, it toggles once.
    press(" ", document.body);
    press(" ", document.body, { repeat: true });
    expect(calls.play).toHaveBeenCalledTimes(1);
    outside.remove();
    field.remove();
    pane.remove();
  });

  it("Escape in the panel closes it", () => {
    const { calls } = mount(at("checkout", 3, 2));
    press("Escape", screen.getByRole("button", { name: /^1/ }));
    expect(calls.close).toHaveBeenCalledTimes(1);
    press("Escape", document.body);
    expect(calls.close).toHaveBeenCalledTimes(1);
  });
});

describe("wheel", () => {
  it("a notch over the panel is one step, and a fling is still one", () => {
    const { calls } = mount(at("checkout", 3, 2));
    const panel = screen.getByRole("region", { name: "Walkthrough" });
    vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1010).mockReturnValueOnce(1020);
    const wheel = () => {
      const e = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
      panel.dispatchEvent(e);
      return e;
    };
    const first = wheel();
    wheel();
    wheel();
    expect(first.defaultPrevented).toBe(true);
    expect(calls.go.mock.calls.map((c) => c[0])).toEqual(["next"]);
  });

  it("sideways scrolling passes through", () => {
    const { calls } = mount(at("checkout", 3, 2));
    const panel = screen.getByRole("region", { name: "Walkthrough" });
    const e = new WheelEvent("wheel", { deltaX: 80, deltaY: 2, bubbles: true, cancelable: true });
    panel.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(calls.go).not.toHaveBeenCalled();
  });
});

describe("the transport bar", () => {
  const transport = (state: WalkState) => {
    const calls = { go: vi.fn(), play: vi.fn() };
    render(<WalkTransport walks={[checkout]} state={state} onGo={calls.go} onTogglePlay={calls.play} />);
    return calls;
  };

  it("first, previous, play, next, last, and a scrubber, with the position said", () => {
    const calls = transport(at("checkout", 3, 2));
    expect(screen.getByText(/Step/)).toHaveTextContent("Step 2 of 3 · Place the order");
    for (const [name, to] of [
      ["First step", "first"],
      ["Previous step", "prev"],
      ["Next step", "next"],
      ["Last step", "last"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(calls.go).toHaveBeenLastCalledWith(to);
    }
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(calls.play).toHaveBeenCalledTimes(1);
    const scrub = screen.getByRole("slider", { name: "Step" });
    expect(scrub).toHaveValue("2");
    expect(scrub).toHaveAttribute("aria-valuetext", "Step 2 of 3: Place the order");
    fireEvent.change(scrub, { target: { value: "3" } });
    expect(calls.go).toHaveBeenLastCalledWith(3);
  });

  it("disables the ends, and says Pause while playing", () => {
    transport({ ...at("checkout", 3, 1), playing: true });
    expect(screen.getByRole("button", { name: "First step" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Previous step" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    cleanup();
    transport(at("checkout", 3, 3));
    expect(screen.getByRole("button", { name: "Next step" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Last step" })).toHaveAttribute("aria-disabled", "true");
  });

  it("is absent until a walkthrough is chosen", () => {
    const { container } = render(
      <WalkTransport walks={[checkout]} state={listing} onGo={vi.fn()} onTogglePlay={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the divider", () => {
  it("is a vertical separator that says its width, and ← → resize it (← widens: the panel is on the right)", () => {
    const onChange = vi.fn();
    render(<WalkDivider width={420} onChange={onChange} />);
    const bar = screen.getByRole("separator", { name: "Resize diagram panel" });
    expect(bar).toHaveAttribute("aria-orientation", "vertical");
    expect(bar).toHaveAttribute("aria-valuenow", "420");
    expect([bar.getAttribute("aria-valuemin"), bar.getAttribute("aria-valuemax")]).toEqual([
      String(WALK_WIDTH.min),
      String(WALK_WIDTH.max),
    ]);
    fireEvent.keyDown(bar, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(420 + WALK_WIDTH.key);
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(420 - WALK_WIDTH.key);
  });

  it("stops at its bounds", () => {
    const onChange = vi.fn();
    const { rerender } = render(<WalkDivider width={WALK_WIDTH.max} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(WALK_WIDTH.max);
    rerender(<WalkDivider width={WALK_WIDTH.min} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(WALK_WIDTH.min);
  });

  it("a drag resizes by the pointer's distance from the right edge", () => {
    const onChange = vi.fn();
    render(
      <div>
        <WalkDivider width={420} onChange={onChange} />
      </div>,
    );
    const bar = screen.getByRole("separator");
    Object.defineProperty(bar, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(bar, "releasePointerCapture", { value: vi.fn() });
    const right = bar.parentElement!.getBoundingClientRect().right;
    fireEvent.pointerDown(bar, { clientX: right - 420, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: right - 500, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(500);
    fireEvent.pointerMove(bar, { clientX: right - 5000, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(WALK_WIDTH.max);
  });
});

describe("the remembered width", () => {
  it("is kept per viewer, and clamped when read", () => {
    expect(readWalkWidth()).toBe(WALK_WIDTH.initial);
    saveWalkWidth(500);
    expect(readWalkWidth()).toBe(500);
    expect(localStorage.getItem(WALK_WIDTH_KEY)).toBe("500");
    localStorage.setItem(WALK_WIDTH_KEY, "99999");
    expect(readWalkWidth()).toBe(WALK_WIDTH.max);
    localStorage.setItem(WALK_WIDTH_KEY, "nonsense");
    expect(readWalkWidth()).toBe(WALK_WIDTH.initial);
  });

  it("survives a localStorage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readWalkWidth()).toBe(WALK_WIDTH.initial);
    expect(() => saveWalkWidth(480)).not.toThrow();
  });
});

describe("the close control", () => {
  it("closes, and is there on the list as well", () => {
    const { calls } = mount(listing);
    fireEvent.click(screen.getByRole("button", { name: "Close walkthrough" }));
    expect(calls.close).toHaveBeenCalledTimes(1);
  });
});

describe("the agent's notice", () => {
  it("says who, when this page saw it made, and the caption; without a time it says no time", () => {
    mount(at("checkout", 3, 2), [checkout], {
      presented: { id: "checkout", caption: "The order reaches the API here.", at: Date.now() },
    });
    expect(document.querySelector(".archer-walk-presented")).toHaveTextContent(
      "Presented by the agent · just now — The order reaches the API here.",
    );
    cleanup();
    mount(at("checkout", 3, 2), [checkout], { presented: { id: "checkout", at: null } });
    expect(document.querySelector(".archer-walk-presented")).toHaveTextContent(/^Presented by the agent$/);
    cleanup();
    mount(at("checkout", 3, 2), [checkout]);
    expect(document.querySelector(".archer-walk-presented")).toBeNull();
  });
});

describe("the related note (J10-F1)", () => {
  const withNote: Walk = { ...checkout, note: "notes/0001-hosted-payment-page.md" };
  it("links the walkthrough's note by its title, at its address, and opens it in the page on a press", () => {
    const open = vi.fn();
    mount(at("checkout", 1, 1), [withNote], {
      note: {
        title: "0001: Hosted payment page",
        href: "/p/pageturner/notes/0001-hosted-payment-page.md",
        onOpen: open,
      },
    });
    const link = screen.getByRole("link", { name: "0001: Hosted payment page" });
    expect(link).toHaveAttribute("href", "/p/pageturner/notes/0001-hosted-payment-page.md");
    expect(link.closest(".archer-walk-top")).not.toBeNull();
    fireEvent.click(link);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("a modified press is the browser's (a new tab), not the page's", () => {
    const open = vi.fn();
    mount(at("checkout", 1, 1), [withNote], { note: { title: "0001", href: "/n", onOpen: open } });
    fireEvent.click(screen.getByRole("link", { name: "0001" }), { ctrlKey: true });
    expect(open).not.toHaveBeenCalled();
  });
  it("shows no link on the picker, or for a walkthrough without a note", () => {
    mount(listing, [withNote], { note: { title: "0001", href: "/n", onOpen: vi.fn() } });
    expect(screen.queryByRole("link", { name: "0001" })).toBeNull();
    cleanup();
    mount(at("checkout", 1, 1), [checkout]);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
