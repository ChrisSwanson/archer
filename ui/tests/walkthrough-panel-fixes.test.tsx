// @vitest-environment jsdom
//
// Review fixes to the walkthrough panel (ADR 0034 §6): the current step is kept in view, focus is not
// taken from someone typing or on the agent's say-so, the tabs are a working tablist, the transport
// keeps focus at either end, the picker's popup semantics, and the meta line's prototype wording.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Walk, WalkStep } from "../src/walkthroughs/contract";
import type { OldVersion } from "../src/walkthroughs/use-old-version";
import { WalkTransport, WalkthroughPanel } from "../src/walkthroughs/WalkthroughPanel";
import { INITIAL_WALK, type WalkState } from "../src/walkthroughs/walk-player";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

const LABELS: Record<string, string> = { api: "Shop API", db: "Shop database" };
const labelOf = (id: string) => LABELS[id] ?? id;
const step = (title: string): WalkStep => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  kind: "sends",
  what: `${title} what`,
  code: [],
  nodes: [],
  edges: [],
  messages: [],
  status: "current",
});
const checkout: Walk = {
  id: "checkout",
  title: "Checkout",
  modelRevision: "sha256:now",
  open: [],
  status: "current",
  outOfDate: [],
  writtenAt: "2026-08-12T10:00:00Z",
  steps: ["One", "Two", "Three", "Four"].map(step),
};
const other: Walk = { ...checkout, id: "other", title: "Other" };
const at = (n: number, id = "checkout"): WalkState => ({ open: true, id, count: 4, step: n, playing: false });

type Props = ComponentProps<typeof WalkthroughPanel>;
function mount(state: WalkState, over: Partial<Props> = {}, walks: readonly Walk[] = [checkout, other]) {
  const calls = { go: vi.fn(), select: vi.fn() };
  const props: Props = {
    walks,
    state,
    revision: "sha256:now",
    labelOf,
    onSelect: calls.select,
    onClose: vi.fn(),
    onGo: calls.go,
    onTogglePlay: vi.fn(),
    ...over,
  };
  const view = render(<WalkthroughPanel {...props} />);
  return { calls, props, again: (next: Partial<Props>) => view.rerender(<WalkthroughPanel {...props} {...next} />) };
}

describe("keeping the current step in view", () => {
  it("scrolls the panel to the active row once its details have opened", () => {
    vi.useFakeTimers();
    const { again } = mount(at(1));
    const scroll = document.querySelector<HTMLElement>(".archer-walk-scroll")!;
    const scrollTo = vi.fn();
    scroll.scrollTo = scrollTo as never;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = this.classList.contains("archer-walk-scroll")
        ? { top: 0, bottom: 100 }
        : this.getAttribute("data-state") === "active"
          ? { top: 300, bottom: 340 }
          : { top: 0, bottom: 10 };
      return { ...box, left: 0, right: 0, width: 0, height: 0, x: 0, y: box.top, toJSON: () => ({}) };
    });
    again({ state: at(3) });
    expect(scrollTo).not.toHaveBeenCalled(); // not before the 0.2 s open
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 248, behavior: "smooth" });
  });
});

describe("focus on a change of walkthrough", () => {
  it("is not taken from someone typing", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const { again } = mount(INITIAL_WALK_OPEN);
    again({ state: at(1) });
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("is not taken when the agent made the change", () => {
    const { again } = mount(INITIAL_WALK_OPEN, { presented: { at: null } as never });
    again({ state: at(1) });
    expect(document.body).toHaveFocus();
  });

  it("goes to the current step's row, not the first", () => {
    const { again } = mount(INITIAL_WALK_OPEN);
    again({ state: at(3) });
    expect(screen.getByRole("button", { name: /Three/ })).toHaveFocus();
  });
});

const INITIAL_WALK_OPEN: WalkState = { ...INITIAL_WALK, open: true };

describe("the tabs", () => {
  const sequence = () => <div>seq</div>;
  it("are a tablist: aria-controls to a tabpanel, a roving tabindex, arrows between them", () => {
    const { calls } = mount(at(2), { sequence });
    const [steps, seq] = screen.getAllByRole("tab");
    const panel = screen.getByRole("tabpanel");
    expect(steps).toHaveAttribute("aria-controls", panel.id);
    expect(seq).toHaveAttribute("aria-controls", panel.id);
    expect(steps).toHaveAttribute("tabindex", "0");
    expect(seq).toHaveAttribute("tabindex", "-1");
    steps!.focus();
    fireEvent.keyDown(steps!, { key: "ArrowRight" });
    expect(seq).toHaveAttribute("aria-selected", "true");
    expect(seq).toHaveFocus();
    expect(seq).toHaveAttribute("tabindex", "0");
    expect(calls.go).not.toHaveBeenCalled(); // the arrows were the tabs', not the step keys
    fireEvent.keyDown(seq!, { key: "ArrowLeft" });
    expect(steps).toHaveAttribute("aria-selected", "true");
    expect(panel).toHaveAttribute("aria-labelledby", steps!.id);
  });
});

describe("the transport", () => {
  it("keeps focus when Previous reaches the start: aria-disabled, not disabled", () => {
    const go = vi.fn();
    const state = at(2);
    render(<WalkTransport walks={[checkout]} state={state} onGo={go} onTogglePlay={vi.fn()} />);
    const prev = screen.getByRole("button", { name: "Previous step" });
    prev.focus();
    fireEvent.click(prev);
    expect(go).toHaveBeenCalledWith("prev");
    cleanup();
    const again = vi.fn();
    render(<WalkTransport walks={[checkout]} state={at(1)} onGo={again} onTogglePlay={vi.fn()} />);
    const first = screen.getByRole("button", { name: "Previous step" });
    expect(first).not.toBeDisabled();
    expect(first).toHaveAttribute("aria-disabled", "true");
    first.focus();
    fireEvent.click(first);
    expect(again).not.toHaveBeenCalled();
    expect(first).toHaveFocus();
  });
});

describe("the picker", () => {
  it("does not claim a menu popup, and Tab closes it", () => {
    mount(INITIAL_WALK_OPEN, {}, [checkout, other]);
    const pick = screen.getByRole("button", { name: /Walkthrough/ });
    expect(pick).not.toHaveAttribute("aria-haspopup", "true");
    fireEvent.click(pick);
    const menu = document.querySelector<HTMLElement>(".archer-walk-menu")!;
    expect(menu).not.toBeNull();
    fireEvent.keyDown(within(menu).getAllByRole("button")[0]!, { key: "Tab" });
    expect(document.querySelector(".archer-walk-menu")).toBeNull();
  });

  it("Home and End move to the first and last walkthrough", () => {
    mount(INITIAL_WALK_OPEN, {}, [checkout, other]);
    fireEvent.click(screen.getByRole("button", { name: /Walkthrough/ }));
    const items = [...document.querySelectorAll<HTMLElement>(".archer-walk-menu button")];
    fireEvent.keyDown(items[0]!, { key: "End" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(items[items.length - 1]!, { key: "Home" });
    expect(items[0]).toHaveFocus();
  });
});

describe("the meta line", () => {
  it("says what the walkthrough starts with open", () => {
    mount(at(1), {}, [{ ...checkout, open: ["api", "db"] }]);
    expect(document.querySelector(".archer-walk-meta")).toHaveTextContent(
      "4 steps · written for this version · starts with Shop API, Shop database open",
    );
  });

  it("names the day a walkthrough written for another version was written", () => {
    mount(at(1), { revision: "sha256:later" });
    expect(document.querySelector(".archer-walk-meta")).toHaveTextContent(
      /4 steps · written for the 12 Aug( 2026)? version$/,
    );
  });

  it("says which version the old one is", () => {
    const playing: Walk = { ...checkout, status: "current", old: true };
    const found = {
      status: "found",
      id: "checkout",
      commit: "a".repeat(40),
      committedAt: "2026-08-12T10:00:00Z",
      view: {},
    } as unknown as OldVersion;
    mount(at(1), { old: found }, [playing]);
    expect(document.querySelector(".archer-walk-meta")).toHaveTextContent(
      /4 steps · shown on the 12 Aug( 2026)? version/,
    );
  });
});

describe("on a phone", () => {
  it("a walkthrough opening opens the panel's sheet: no second tap on the chip", async () => {
    const { installViewport } = await import("./match-media");
    const { DiagramSidePanel } = await import("../src/app/diagram-panel");
    const { StageDockContext } = await import("../src/app/stage-dock");
    installViewport({ width: 400, coarse: true });
    const host = document.createElement("div");
    document.body.append(host);
    const modes = {
      mode: "walkthrough",
      enter: vi.fn(),
      exit: vi.fn(),
      press: vi.fn(),
      saved: () => null,
      highlightsOffered: false,
      leftFrom: null,
    } as const;
    render(
      <StageDockContext.Provider value={{ host }}>
        <DiagramSidePanel
          modes={modes}
          switcher={{ highlights: vi.fn(), walkthroughs: vi.fn() }}
          walks={[checkout]}
          highlightCount={0}
          walkthrough={<p>steps</p>}
          walkLabel="Walkthrough · Step 1 of 4"
          keyModel={null}
        >
          <div />
        </DiagramSidePanel>
      </StageDockContext.Provider>,
    );
    expect(await screen.findByRole("dialog", { name: "Walkthrough · Step 1 of 4" })).toHaveTextContent("steps");
    // One exit: the sheet's ✕ leaves the walkthrough.
    fireEvent.click(screen.getByRole("button", { name: "Close Walkthrough · Step 1 of 4" }));
    expect(modes.exit).toHaveBeenCalledWith("close");
    delete (window as { matchMedia?: unknown }).matchMedia;
    host.remove();
  });
});
