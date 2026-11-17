// @vitest-environment jsdom
//
// The diagram page's mode (0.6.4, D1): one at a time, by precedence; entering a walkthrough saves the view,
// every way out puts it back; a click off the path leaves with where the person was; the agent's highlights
// arriving under a walkthrough are offered, not switched to.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  idsKey,
  modeOf,
  modeReducer,
  INITIAL_MODE,
  useDiagramModes,
  type DiagramModeOptions,
  type ModeWalkthrough,
  type PressPlace,
  type SavedView,
} from "../src/app/diagram-mode";

const SAVED: SavedView = {
  viewId: "shop",
  nest: "nested",
  open: ["shop"],
  camera: { x: 1, y: 2, zoom: 1 },
  follow: true,
  framing: 3,
};

describe("modeOf", () => {
  it("one mode, by precedence: edit, walkthrough, highlights, explore", () => {
    const all = [false, true];
    for (const edit of all)
      for (const walkthrough of all)
        for (const highlights of all) {
          const want = edit ? "edit" : walkthrough ? "walkthrough" : highlights ? "highlights" : "explore";
          expect(modeOf({ edit, walkthrough, highlights })).toBe(want);
        }
  });
});

describe("modeReducer", () => {
  it("an exit keeps where a click off the path left; entering or a new selection forgets it", () => {
    const left = { context: { walkthrough: "w", step: "s3" }, ids: "a|" };
    const out = modeReducer(INITIAL_MODE, { type: "exited", left });
    expect(out.left).toEqual(left);
    expect(modeReducer(out, { type: "forget" }).left).toBeNull();
    expect(modeReducer(out, { type: "entered" }).left).toBeNull();
    expect(modeReducer(INITIAL_MODE, { type: "entered" })).toBe(INITIAL_MODE);
  });

  it("idsKey ignores order", () => {
    expect(idsKey({ nodeIds: ["b", "a"], edgeIds: [] })).toBe(idsKey({ nodeIds: ["a", "b"], edgeIds: [] }));
  });
});

function setup(place: PressPlace = "off") {
  let open = false;
  let framing = 3;
  const view = { read: vi.fn(() => ({ ...SAVED, framing })), restore: vi.fn() };
  const walk = (o: boolean): ModeWalkthrough => ({
    open: o,
    at: o ? { walkthrough: "w", step: 3 } : null,
    context: o ? { walkthrough: "w", step: "s3" } : null,
    show: vi.fn(),
    select: vi.fn(),
    close: vi.fn(() => {
      open = false;
    }),
    press: vi.fn(() => place),
  });
  const options = (over: Partial<DiagramModeOptions> = {}): DiagramModeOptions => ({
    walkthrough: walk(open),
    highlights: { activeId: null, revision: null, show: vi.fn(), hide: vi.fn() },
    edit: { on: false },
    view: { read: view.read, restore: view.restore, framing },
    selection: null,
    ...over,
  });
  const hook = renderHook((props: DiagramModeOptions) => useDiagramModes(props), { initialProps: options() });
  return {
    hook,
    view,
    rerender: (over: Partial<DiagramModeOptions> = {}) => hook.rerender(options(over)),
    setOpen: (o: boolean) => {
      open = o;
    },
    setFraming: (f: number) => {
      framing = f;
    },
    get open() {
      return open;
    },
  };
}

describe("useDiagramModes", () => {
  it("saves the view when a walkthrough opens and restores it, camera too, when it closes", () => {
    const t = setup();
    expect(t.hook.result.current.mode).toBe("explore");
    t.setOpen(true);
    t.rerender();
    expect(t.hook.result.current.mode).toBe("walkthrough");
    expect(t.view.read).toHaveBeenCalledTimes(1);
    expect(t.hook.result.current.saved()).toEqual(SAVED);
    act(() => t.hook.result.current.exit("escape"));
    t.rerender();
    expect(t.view.restore).toHaveBeenCalledWith(SAVED, { alsoOpen: null, camera: true });
    expect(t.hook.result.current.mode).toBe("explore");
    expect(t.hook.result.current.saved()).toBeNull();
  });

  it("a newer presentation (the agent presenting without one) restores the open set, not the camera", () => {
    const t = setup();
    t.setOpen(true);
    t.rerender();
    t.setOpen(false);
    t.setFraming(4);
    t.rerender();
    expect(t.view.restore).toHaveBeenCalledWith(SAVED, { alsoOpen: null, camera: false });
  });

  it("a click off the path leaves, keeps what it selected drawn and the camera where it is (D4b), and remembers where the person was while that selection stands", () => {
    const t = setup("off");
    t.setOpen(true);
    t.rerender();
    const ids = { nodeIds: ["worker"], edgeIds: [] };
    act(() => t.hook.result.current.press(ids, true));
    expect(t.open).toBe(false);
    t.rerender({ selection: ids });
    expect(t.view.restore).toHaveBeenCalledWith(SAVED, { alsoOpen: ids, camera: false });
    expect(t.hook.result.current.leftFrom).toEqual({ context: { walkthrough: "w", step: "s3" }, ids: idsKey(ids) });
    t.rerender({ selection: { nodeIds: ["other"], edgeIds: [] } });
    expect(t.hook.result.current.leftFrom).toBeNull();
  });

  it("an additive click off the path: the context goes with the whole selection it leaves, named by the step's id", () => {
    const t = setup("off");
    t.setOpen(true);
    t.rerender({ selection: { nodeIds: ["web"], edgeIds: [] } });
    act(() => t.hook.result.current.press({ nodeIds: ["worker"], edgeIds: [] }, true));
    const both = { nodeIds: ["web", "worker"], edgeIds: [] };
    t.rerender({ selection: both });
    expect(t.hook.result.current.leftFrom).toEqual({ context: { walkthrough: "w", step: "s3" }, ids: idsKey(both) });
  });

  it("Edit leaves the walkthrough (reason edit, the camera put back) and starts editing; entering a walkthrough calls onEnterWalkthrough", () => {
    const t = setup();
    const start = vi.fn();
    const entered = vi.fn();
    t.setOpen(true);
    t.rerender({ onEnterWalkthrough: entered, edit: { on: false, start } });
    expect(entered).toHaveBeenCalledTimes(1);
    act(() => t.hook.result.current.enter("edit"));
    expect(t.open).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    t.rerender({ edit: { on: true, start } });
    expect(t.view.restore).toHaveBeenCalledWith(SAVED, { alsoOpen: null, camera: true });
  });

  it("the hand's press, a press on the path, and a jump never leave", () => {
    for (const place of ["jump", "path"] as const) {
      const t = setup(place);
      t.setOpen(true);
      t.rerender();
      act(() => t.hook.result.current.press({ nodeIds: ["a"], edgeIds: [] }, true));
      expect(t.open, place).toBe(true);
    }
    const t = setup("off");
    t.setOpen(true);
    t.rerender();
    act(() => t.hook.result.current.press({ nodeIds: ["a"], edgeIds: [] }, false));
    expect(t.open).toBe(true);
  });

  it("the agent's highlights arriving under a walkthrough are offered; leaving clears the offer", () => {
    const t = setup();
    const lit = (activeId: string | null) => ({
      highlights: { activeId, revision: activeId, show: vi.fn(), hide: vi.fn() },
    });
    t.rerender(lit("old"));
    t.setOpen(true);
    t.rerender(lit("old"));
    expect(t.hook.result.current.highlightsOffered).toBe(false); // standing before the walkthrough: not news
    t.rerender(lit("new"));
    expect(t.hook.result.current.highlightsOffered).toBe(true);
    t.setOpen(false);
    t.rerender(lit("new"));
    expect(t.hook.result.current.highlightsOffered).toBe(false);
    expect(t.hook.result.current.mode).toBe("highlights");
  });

  it("the agent replacing the highlights already up (same id, new groups) under a walkthrough is offered; the same snapshot again is not", () => {
    const t = setup();
    const lit = (activeId: string | null, revision: string | null) => ({
      highlights: { activeId, revision, show: vi.fn(), hide: vi.fn() },
    });
    t.rerender(lit("focus", "groups-1"));
    t.setOpen(true);
    t.rerender(lit("focus", "groups-1"));
    t.rerender(lit("focus", "groups-1"));
    expect(t.hook.result.current.highlightsOffered).toBe(false);
    t.rerender(lit("focus", "groups-2"));
    expect(t.hook.result.current.highlightsOffered).toBe(true);
  });

  it("enter('highlights') leaves the walkthrough; without walkthroughs (the MCP shell) only Explore and Highlights exist", () => {
    const t = setup();
    t.setOpen(true);
    t.rerender();
    act(() => t.hook.result.current.enter("highlights"));
    expect(t.open).toBe(false);
    const show = vi.fn();
    const mcp = renderHook(() =>
      useDiagramModes({
        walkthrough: null,
        highlights: { activeId: null, revision: null, show, hide: vi.fn() },
        edit: { on: false },
        view: { read: () => null, restore: vi.fn(), framing: 0 },
        selection: null,
      }),
    );
    act(() => mcp.result.current.enter("walkthrough"));
    expect(mcp.result.current.mode).toBe("explore");
    act(() => mcp.result.current.enter("highlights"));
    expect(show).toHaveBeenCalled();
  });
});
