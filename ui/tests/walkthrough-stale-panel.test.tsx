// @vitest-environment jsdom
//
// The panel's out-of-date, archived and old-version states (ADR 0034 §3, slice 7b), driven through its
// props as the page hook drives it. The wording is the approved prototype's.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Walk, WalkStep } from "../src/walkthroughs/contract";
import { WalkthroughPanel } from "../src/walkthroughs/WalkthroughPanel";
import { INITIAL_WALK, type WalkState } from "../src/walkthroughs/walk-player";
import type { OldVersion } from "../src/walkthroughs/use-old-version";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const step = (title: string, over: Partial<WalkStep> = {}): WalkStep => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  kind: "sends",
  what: `${title} what`,
  why: `${title} why`,
  code: [],
  nodes: [],
  edges: [],
  messages: [],
  status: "current",
  missing: [],
  ...over,
});
const base: Walk = {
  id: "w",
  title: "Order shipped",
  modelRevision: "sha256:then",
  open: [],
  status: "partly-out-of-date",
  outOfDate: [2],
  writtenAt: "2026-10-02T10:00:00Z",
  steps: [
    step("Ship it"),
    step("Hand to courier", {
      status: "out-of-date",
      missing: ["Courier"],
      edges: [{ id: "a--b", source: "a", target: "b" }],
    }),
    step("Pay on the page", { messages: [{ from: "a", to: "b", label: "pay" }] }),
  ],
};
const archived: Walk = {
  ...base,
  id: "arch",
  title: "Pay with card form",
  status: "archived",
  outOfDate: [1, 2, 3],
  writtenAt: "2026-08-12T10:00:00Z",
  steps: base.steps.map((s) => ({ ...s, status: "out-of-date" as const })),
};
const fine: Walk = { ...base, id: "fine", title: "Fine", status: "current", outOfDate: [], steps: [step("One")] };
const at = (id: string, count: number, n = 1): WalkState => ({ open: true, id, count, step: n, playing: false });

function mount(state: WalkState, walks: readonly Walk[], over: Partial<Parameters<typeof WalkthroughPanel>[0]> = {}) {
  const calls = { open: vi.fn(), back: vi.fn() };
  render(
    <WalkthroughPanel
      walks={walks}
      state={state}
      labelOf={(id) => id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onGo={vi.fn()}
      onTogglePlay={vi.fn()}
      onOpenOld={calls.open}
      onBackToCurrent={calls.back}
      {...over}
    />,
  );
  return calls;
}

describe("a partly out-of-date walkthrough", () => {
  it("says the agent was flagged, how many steps, when the diagram changed and how many still match", () => {
    mount(at("w", 3), [base, fine], { changedAt: "2026-10-18T09:00:00Z" });
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Archer flagged this to the agent: 1 step out of date.");
    expect(note).toHaveTextContent(/The diagram changed on 18 Oct( 2026)?; the other 2 steps still match\./);
  });

  it("leaves the date out when the diagram's change is not known", () => {
    mount(at("w", 3), [base]);
    expect(screen.getByRole("note")).toHaveTextContent("The diagram changed; the other 2 steps still match.");
  });

  it("greys the step, labels it Out of date, and says what it was", () => {
    mount(at("w", 3, 2), [base]);
    const item = screen.getByRole("button", { name: /Hand to courier/ }).closest("li")!;
    expect(item).toHaveClass("stale");
    expect(within(item).getByText("Out of date")).toBeInTheDocument();
    expect(item).toHaveTextContent("Was Courier, which is no longer in this diagram.");
  });

  it("marks a hop with no line as having no line, not as out of date", () => {
    mount(at("w", 3, 3), [base]);
    const item = screen.getByRole("button", { name: /Pay on the page/ }).closest("li")!;
    expect(item).toHaveTextContent("No line in this diagram");
    expect(item).not.toHaveClass("stale");
  });
});

describe("an archived walkthrough", () => {
  it("is listed under Archived with the date it was written for", () => {
    mount({ ...INITIAL_WALK, open: true }, [base, archived]);
    const list = screen.getByRole("group", { name: "Walkthroughs on this diagram" });
    expect(within(list).getByRole("button", { name: /Pay with card form/ })).toHaveClass("archived");
    expect(within(list).getByRole("button", { name: /Pay with card form/ })).toHaveTextContent(
      /written for the 12 Aug( 2026)? version/,
    );
  });

  it("says none of its steps match and offers the version it was written for", () => {
    const calls = mount(at("arch", 3), [archived]);
    expect(screen.getByRole("note")).toHaveTextContent("Archived. None of its 3 steps match this diagram any more.");
    fireEvent.click(screen.getByRole("button", { name: "Open on the version it was written for" }));
    expect(calls.open).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: "loading", id: "arch" }, /Opening/],
    [{ status: "refused", id: "arch" }, /no longer compiles/],
    [{ status: "not-in-history", id: "arch" }, /not in this project's Git history/],
    [{ status: "failed", id: "arch" }, /could not be read/],
  ] as const)("shows %j as honest text, with no canvas to swap", (old, text) => {
    mount(at("arch", 3), [archived], { old: old as OldVersion });
    expect(screen.getByRole("note")).toHaveTextContent(text);
    expect(screen.queryByRole("button", { name: "Back to the current diagram" })).toBeNull();
  });
});

describe("playing on the old version", () => {
  const playing: Walk = {
    ...archived,
    status: "current",
    outOfDate: [],
    old: true,
    steps: archived.steps.map((s) => ({ ...s, status: "current" as const, missing: [] })),
  };
  const found = {
    status: "found",
    id: "arch",
    commit: "a".repeat(40),
    committedAt: "2026-08-12T10:00:00Z",
    view: {},
  } as unknown as OldVersion;

  it("says it is the old version, steps like any walkthrough, and goes back", () => {
    const calls = mount(at("arch", 3), [base, playing], { old: found });
    expect(screen.getByRole("note")).toHaveTextContent(
      /Old version: 12 Aug( 2026)?\. The diagram this walkthrough was written for\./,
    );
    expect(screen.getByText("Scroll, or use ↑ ↓, over this panel to step.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to the current diagram" }));
    expect(calls.back).toHaveBeenCalledTimes(1);
  });

  it("stays listed under Archived while it plays", () => {
    mount({ ...INITIAL_WALK, open: true }, [base, playing], { old: found });
    const list = screen.getByRole("group", { name: "Walkthroughs on this diagram" });
    expect(
      within(list)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["On This Diagram", "Archived"]);
  });
});
