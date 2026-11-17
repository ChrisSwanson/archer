// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doubleCommitDetector, setTelemetrySink, type TelemetryReport } from "../src/telemetry/dev";
import {
  chromeOverlaps,
  measureChromeBoxes,
  renderStormDetector,
  useChromeOverlapCheck,
  usePointerHandCheck,
  useStaleSelectionCheck,
  type ChromeBox,
} from "../src/telemetry/dev-hooks";

let reports: TelemetryReport[] = [];
const codes = () => reports.map((r) => r.code);
beforeEach(() => {
  reports = [];
  setTelemetrySink((r) => reports.push(r));
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  setTelemetrySink(null);
  vi.useRealTimers();
});

describe("ui.edit.pointer-hand", () => {
  type Props = { editable: boolean; mode: "select" | "hand" };
  const mount = (initial: Props) =>
    renderHook((p: Props) => usePointerHandCheck("canvas", p.editable, p.mode), { initialProps: initial });

  it("is quiet when editing starts and the canvas switches to select on its own", () => {
    const hook = mount({ editable: false, mode: "hand" });
    hook.rerender({ editable: true, mode: "hand" });
    hook.rerender({ editable: true, mode: "select" });
    act(() => vi.advanceTimersByTime(2000));
    expect(codes()).toEqual([]);
  });

  it("reports an editable canvas left in hand mode", () => {
    const hook = mount({ editable: false, mode: "hand" });
    hook.rerender({ editable: true, mode: "hand" });
    act(() => vi.advanceTimersByTime(600));
    expect(codes()).toEqual(["ui.edit.pointer-hand"]);
  });

  it("is quiet when the reader picks hand while editing", () => {
    const hook = mount({ editable: true, mode: "select" });
    hook.rerender({ editable: true, mode: "hand" });
    act(() => vi.advanceTimersByTime(2000));
    expect(codes()).toEqual([]);
  });
});

describe("ui.edit.stale-selection", () => {
  type Props = { ids: ReadonlySet<string> | null; selected: string | null };
  const mount = (initial: Props) =>
    renderHook((p: Props) => useStaleSelectionCheck("editor", p.ids, { selected: p.selected }), {
      initialProps: initial,
    });

  it("waits for the layout to settle: a selection the next layout draws is not reported", () => {
    const hook = mount({ ids: new Set(["a"]), selected: "b" });
    act(() => vi.advanceTimersByTime(300));
    hook.rerender({ ids: new Set(["a", "b"]), selected: "b" });
    act(() => vi.advanceTimersByTime(2000));
    expect(codes()).toEqual([]);
  });

  it("reports a selected id the settled layout does not draw, once", () => {
    const ids = new Set(["a"]);
    const hook = mount({ ids, selected: "gone" });
    act(() => vi.advanceTimersByTime(1100));
    hook.rerender({ ids, selected: "gone" });
    act(() => vi.advanceTimersByTime(1100));
    expect(codes()).toEqual(["ui.edit.stale-selection"]);
    expect(reports[0]!.data).toMatchObject({ role: "selected", id: "gone" });
  });

  it("is quiet with no layout shown", () => {
    mount({ ids: null, selected: "x" });
    act(() => vi.advanceTimersByTime(2000));
    expect(codes()).toEqual([]);
  });
});

describe("ui.edit.chrome-overlap", () => {
  const box = (name: string, left: number, top: number, right: number, bottom: number): ChromeBox => ({
    name,
    rect: { left, top, right, bottom },
  });
  it("finds intersecting pairs, not touching ones", () => {
    const pairs = chromeOverlaps([
      box("tools", 0, 0, 100, 40),
      box("panel", 90, 30, 300, 400),
      box("controls", 100, 0, 140, 40),
    ]);
    expect(pairs.map(([a, b]) => `${a.name}|${b.name}`)).toEqual(["tools|panel", "panel|controls"]);
  });

  it("measures visible chrome, leaving out what sits inside other chrome, and reports once per pair", () => {
    const rects: Record<string, [number, number, number, number]> = {
      cluster: [0, 0, 200, 40],
      parts: [150, 0, 400, 40],
      message: [500, 0, 600, 100],
    };
    function Editor() {
      const ref = useRef<HTMLElement>(null);
      useChromeOverlapCheck(ref, "k");
      return (
        <section ref={ref}>
          <div className="authoring-tools-row">
            <div className="archer-canvas-controls authoring-edit-cluster" data-r="cluster">
              <span className="archer-canvas-controls" data-r="cluster" />
            </div>
            <div className="authoring-parts" data-r="parts" />
          </div>
          <section className="authoring-message-panel" data-r="message" />
        </section>
      );
    }
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const r = rects[this.getAttribute("data-r") ?? ""];
      return (
        r
          ? { left: r[0], top: r[1], right: r[2], bottom: r[3], width: r[2] - r[0], height: r[3] - r[1] }
          : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
      ) as DOMRect;
    };
    try {
      const view = render(<Editor />);
      expect(measureChromeBoxes(view.container)).toHaveLength(3);
      act(() => vi.advanceTimersByTime(1000));
      expect(codes()).toEqual(["ui.edit.chrome-overlap"]);
      expect(reports[0]!.msg).toContain("authoring-edit-cluster");
      expect(reports[0]!.msg).toContain("authoring-parts");
      act(() => {
        window.dispatchEvent(new Event("resize"));
        vi.advanceTimersByTime(1000);
      });
      expect(codes()).toHaveLength(1);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });
});

describe("ui.render-storm", () => {
  it("reports a component committing more than 30 times within 1 s, then stays quiet for a while", () => {
    const onRender = renderStormDetector();
    for (let i = 0; i < 30; i++) onRender("canvas", "update", 1, 1, i * 30, i * 30);
    expect(codes()).toEqual([]);
    for (let i = 0; i < 30; i++) onRender("canvas", "update", 1, 1, 500 + i * 10, 500 + i * 10);
    expect(codes()).toEqual(["ui.render-storm"]);
    expect(reports[0]!.data).toMatchObject({ component: "canvas" });
    for (let i = 0; i < 40; i++) onRender("canvas", "update", 1, 1, 900 + i * 10, 900 + i * 10);
    expect(codes()).toEqual(["ui.render-storm"]);
    for (let i = 0; i < 31; i++) onRender("other", "update", 1, 1, i * 30, i * 30);
    expect(reports.map((r) => r.data?.component)).toEqual(["canvas", "other"]);
  });
});

describe("ui.render-storm on cheap commits", () => {
  it("ignores many sub-millisecond commits (a drag, a live preview)", () => {
    const onRender = renderStormDetector();
    for (let i = 0; i < 60; i++) onRender("drag", "update", 0.3, 0.3, i * 10, i * 10);
    expect(codes()).toEqual([]);
  });
  it("counts only commits that cost 1 ms or more: a burst of cheap commits around a few dearer ones is no storm", () => {
    const onRender = renderStormDetector();
    // Two quick edits: ~10 commits each, most under a millisecond, a few of 3-4 ms (flowchart-create at harness speed).
    for (let i = 0; i < 40; i++) onRender("editor", "update", i % 4 === 0 ? 3.5 : 0.4, 1, i * 20, i * 20);
    expect(codes()).toEqual([]);
  });
  it("still reports a real storm: more than 30 commits of 1 ms or more within 1 s", () => {
    const onRender = renderStormDetector();
    for (let i = 0; i < 31; i++) onRender("editor", "update", i % 2 ? 0.2 : 0.3, 1, i * 5, i * 5);
    for (let i = 0; i < 31; i++) onRender("editor", "update", 1.5, 1.5, 200 + i * 20, 200 + i * 20);
    expect(codes()).toEqual(["ui.render-storm"]);
    expect(reports[0]!.data).toMatchObject({ component: "editor", commits: 31 });
  });
});

describe("ui.edit.double-commit", () => {
  it("reports the same request twice within 300 ms, not two different ones or a later repeat", () => {
    let now = 0;
    const issued = doubleCommitDetector(300, () => now);
    issued("edit", '{"kind":"add-node","id":"n1"}');
    now = 100;
    issued("edit", '{"kind":"add-node","id":"n2"}');
    expect(codes()).toEqual([]);
    now = 200;
    issued("edit", '{"kind":"add-node","id":"n1"}');
    expect(codes()).toEqual(["ui.edit.double-commit"]);
    now = 900;
    issued("edit", '{"kind":"add-node","id":"n1"}');
    expect(codes()).toEqual(["ui.edit.double-commit"]);
  });

  it("compares requests by hash and reports only op, ids and sizes, never the content", () => {
    let now = 0;
    const issued = doubleCommitDetector(300, () => now);
    const source = "flowchart LR\n  secret_node[Quarterly numbers]\n";
    const write = {
      op: "draft.save",
      draftId: "drf_0123456789abcdef",
      expectedDraftRevision: 3,
      source,
      intent: "keep the label",
      origin: { kind: "document", target: { kind: "view", viewId: "flow" } },
    };
    issued("write", JSON.stringify(write), write);
    now = 50;
    issued("write", JSON.stringify(write), write);
    const edit = { kind: "relabel-node", id: "a", label: "Quarterly numbers" };
    issued("edit", JSON.stringify(edit), edit);
    now = 60;
    issued("edit", JSON.stringify(edit), edit);
    expect(reports.map((r) => r.data)).toEqual([
      {
        kind: "write",
        op: "draft.save",
        draftId: "drf_0123456789abcdef",
        expectedDraftRevision: 3,
        sourceBytes: source.length,
        intentBytes: 14,
        originKind: "document",
        requestBytes: JSON.stringify(write).length,
        gapMs: 50,
      },
      {
        kind: "edit",
        op: "relabel-node",
        id: "a",
        labelBytes: 17,
        requestBytes: JSON.stringify(edit).length,
        gapMs: 10,
      },
    ]);
    expect(JSON.stringify(reports)).not.toMatch(/Quarterly|secret_node|keep the label/);
  });

  it("holds at most maxKeys recent requests", () => {
    let now = 0;
    const issued = doubleCommitDetector(300, () => now, 8);
    for (let i = 0; i < 9; i++) issued("edit", `{"id":"n${i}"}`);
    now = 10;
    issued("edit", '{"id":"n0"}'); // evicted by the ninth: not remembered
    expect(codes()).toEqual([]);
    issued("edit", '{"id":"n8"}');
    expect(codes()).toEqual(["ui.edit.double-commit"]);
  });
});
