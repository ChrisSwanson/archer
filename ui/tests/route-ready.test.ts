// @vitest-environment jsdom
// The route-ready mark (performance rubric S7): once per document, a frame after it is asked for, and a note's
// figures in view count as settled only once none is still waiting or drawing.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markRouteReady,
  noteFiguresSettled,
  resetRouteReadyForTests,
  ROUTE_READY_MARK,
} from "../src/diagrams/route-ready";

afterEach(() => {
  resetRouteReadyForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("markRouteReady", () => {
  it("marks once per document, with its kind, a frame later", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const mark = vi.spyOn(performance, "mark");
    markRouteReady("list");
    markRouteReady("note");
    expect(mark).not.toHaveBeenCalled();
    frames.forEach((cb) => cb(0));
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith(ROUTE_READY_MARK, { detail: { kind: "list" } });
    vi.unstubAllGlobals();
  });
});

describe("noteFiguresSettled", () => {
  const figure = (state: string, top: number): HTMLElement => {
    const el = document.createElement("figure");
    el.className = "archer-note-figure";
    el.dataset.state = state;
    el.getBoundingClientRect = () => ({
      top,
      bottom: top + 100,
      left: 0,
      right: 100,
      width: 100,
      height: 100,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    document.body.append(el);
    return el;
  };

  it("waits for a figure in view that is still drawing, and not for one below the fold", () => {
    const near = figure("drawing", 100);
    figure("waiting", 2000);
    expect(noteFiguresSettled(document.body, 900)).toBe(false);
    near.dataset.state = "drawn";
    expect(noteFiguresSettled(document.body, 900)).toBe(true);
  });

  it("takes a figure that failed to draw as settled: it says why", () => {
    figure("failing", 100);
    figure("error", 300);
    expect(noteFiguresSettled(document.body, 900)).toBe(true);
  });

  it("waits for a figure host whose figure is not yet mounted: the note's text is laid down a render before its figures", () => {
    const host = document.createElement("div");
    host.setAttribute("data-note-figure", "");
    document.body.append(host);
    expect(noteFiguresSettled(document.body, 900)).toBe(false);
    host.append(figure("drawn", 100));
    expect(noteFiguresSettled(document.body, 900)).toBe(true);
  });
});
