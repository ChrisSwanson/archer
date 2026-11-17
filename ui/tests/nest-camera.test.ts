// Where the camera goes after a press in the nested view (`toggle-place.ts`, `cameraAfterPress`):
// the pressed control stays under the finger, and every open frame around it keeps its "−" on
// screen where it can, so on a phone a second press does not push the outer "−" off the edge.
import { describe, expect, it } from "vitest";
import type { LayoutResult } from "../src/layout/elk-layout";
import { cameraAfterPress, showOpened, togglePosition, TOGGLE_DRAWN_PX } from "../src/nesting/toggle-place";

const group = (id: string, x: number, y: number, width: number, height: number, parentId?: string) =>
  ({ id, label: id, x, y, width, height, parentId }) as unknown as LayoutResult["groups"][number];
const layoutOf = (groups: LayoutResult["groups"], nodes: LayoutResult["nodes"] = []): LayoutResult =>
  ({ nodes, edges: [], groups, width: 2000, height: 2000 }) as unknown as LayoutResult;
const onScreen = (at: { left: number; top: number }, width: number, height: number) =>
  at.left >= 0 && at.left + TOGGLE_DRAWN_PX <= width && at.top >= 0 && at.top + TOGGLE_DRAWN_PX <= height;

describe("cameraAfterPress", () => {
  const phone = { width: 390, height: 844 };

  it("keeps the opened frame where the press was when it fits", () => {
    const layout = layoutOf([group("shop", 40, 100, 200, 300)]);
    const at = cameraAfterPress({ layout, groupId: "shop", screen: { x: 60, y: 120 }, zoom: 1, ...phone });
    expect(at).toEqual({ x: 20, y: 20 });
  });

  it("a second press inside an open frame keeps the outer frame's − on screen too", () => {
    // The outer frame grew past the right edge when api opened inside it.
    const shop = group("shop", 0, 0, 900, 600);
    const api = group("api", 120, 80, 400, 300, "shop");
    const layout = layoutOf([shop, api]);
    const zoom = 0.8;
    const at = cameraAfterPress({ layout, groupId: "api", screen: { x: 40, y: 200 }, zoom, ...phone });
    const transform = [at.x, at.y, zoom] as const;
    expect(onScreen(togglePosition(api, true, transform), phone.width, phone.height), "the pressed −").toBe(true);
    expect(onScreen(togglePosition(shop, true, transform), phone.width, phone.height), "the outer −").toBe(true);
  });

  it("the pressed control wins when both cannot show", () => {
    const shop = group("shop", 0, 0, 3000, 600);
    const api = group("api", 100, 80, 200, 300, "shop");
    const at = cameraAfterPress({
      layout: layoutOf([shop, api]),
      groupId: "api",
      screen: { x: 100, y: 200 },
      zoom: 1,
      ...phone,
    });
    expect(onScreen(togglePosition(api, true, [at.x, at.y, 1]), phone.width, phone.height)).toBe(true);
  });

  it("a frame's − above the top edge comes down while the pressed control stays on screen", () => {
    const shop = group("shop", 0, 0, 360, 900);
    const api = group("api", 20, 500, 300, 200, "shop");
    const at = cameraAfterPress({
      layout: layoutOf([shop, api]),
      groupId: "api",
      screen: { x: 20, y: 60 },
      zoom: 1,
      ...phone,
    });
    expect(onScreen(togglePosition(api, true, [at.x, at.y, 1]), phone.width, phone.height)).toBe(true);
    expect(onScreen(togglePosition(shop, true, [at.x, at.y, 1]), phone.width, phone.height)).toBe(true);
  });
});

// Second rendered review (2026-11-13, F): opening a frame left it clipped at the canvas's left edge and under the
// tool rail (Where Archer Runs, Archer Containers at 1440x900): the camera kept the pressed box in place whatever the
// frame grew to. Now the opened frame is brought into view with the least move, zooming out only when it does not fit.
describe("showOpened", () => {
  const desk = { width: 1025, height: 796 };
  const pad = { top: 12, right: 12, bottom: 12, left: 12 };
  const inside = (
    frame: { x: number; y: number; width: number; height: number },
    at: { x: number; y: number; zoom: number },
  ) => {
    const left = frame.x * at.zoom + at.x;
    const top = frame.y * at.zoom + at.y;
    return (
      left >= pad.left - 1e-6 &&
      top >= pad.top - 1e-6 &&
      left + frame.width * at.zoom <= desk.width - pad.right + 1e-6 &&
      top + frame.height * at.zoom <= desk.height - pad.bottom + 1e-6
    );
  };

  it("leaves the camera alone when the opened frame is already in view", () => {
    const shop = group("shop", 100, 100, 400, 300);
    const camera = { x: 20, y: 30, zoom: 1 };
    expect(
      showOpened({ layout: layoutOf([shop]), groupId: "shop", camera, ...desk, padding: pad, floor: 0.5 }),
    ).toEqual(camera);
  });

  it("pans the least that brings a frame cut at the left into view, keeping the zoom when it fits", () => {
    const shop = group("shop", 0, 0, 900, 300);
    const at = showOpened({
      layout: layoutOf([shop]),
      groupId: "shop",
      camera: { x: -40, y: 30, zoom: 1 },
      ...desk,
      padding: pad,
      floor: 0.5,
    });
    expect(at).toEqual({ x: 12, y: 30, zoom: 1 });
  });

  it("zooms out just enough when the frame is wider than the canvas at this zoom", () => {
    // Where Archer Runs: Agent's Computer opens 1039 wide at zoom 1 on a 1025px canvas.
    const agent = group("agent", 0, 0, 1039, 292);
    const at = showOpened({
      layout: layoutOf([agent]),
      groupId: "agent",
      camera: { x: -26, y: 45, zoom: 1 },
      ...desk,
      padding: pad,
      floor: 0.5,
    });
    expect(at.zoom).toBeCloseTo((desk.width - 24) / 1039, 6);
    expect(inside(agent, at)).toBe(true);
  });

  it("never zooms in, and leaves a frame that cannot fit above the floor as the press left it", () => {
    const wide = group("wide", 0, 0, 4000, 300);
    const camera = { x: -100, y: 30, zoom: 1 };
    expect(
      showOpened({ layout: layoutOf([wide]), groupId: "wide", camera, ...desk, padding: pad, floor: 0.5 }),
    ).toEqual(camera);
    const small = group("small", 0, 0, 100, 100);
    const far = { x: 0, y: 0, zoom: 0.3 };
    expect(
      showOpened({ layout: layoutOf([small]), groupId: "small", camera: far, ...desk, padding: pad, floor: 0.5 }).zoom,
    ).toBe(0.3);
  });

  it("does nothing for a press that closed the frame", () => {
    const camera = { x: -40, y: 30, zoom: 1 };
    expect(showOpened({ layout: layoutOf([]), groupId: "shop", camera, ...desk, padding: pad, floor: 0.5 })).toEqual(
      camera,
    );
  });
});
