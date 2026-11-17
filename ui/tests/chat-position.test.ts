// Where the launcher is: anywhere, kept exactly, clamped inside the window (ADR 0034 §10).
import { describe, expect, it } from "vitest";
import {
  CHAT_POSITION_KEY,
  LAUNCHER_PX,
  EDGE_PX,
  clampPoint,
  defaultPoint,
  fromFraction,
  nudge,
  readPosition,
  toFraction,
  writePosition,
} from "../src/chat/chat-position";

const DESKTOP = { w: 1280, h: 800 };
const PHONE = { w: 390, h: 844 };
const MAX = (win: { w: number; h: number }) => ({ x: win.w - LAUNCHER_PX - EDGE_PX, y: win.h - LAUNCHER_PX - EDGE_PX });

describe("clampPoint", () => {
  it("keeps a drop exactly where it is, with no snapping", () => {
    expect(clampPoint({ x: 417, y: 233 }, DESKTOP)).toEqual({ x: 417, y: 233 });
  });
  for (const [name, win] of [
    ["desktop", DESKTOP],
    ["a 390px phone", PHONE],
  ] as const) {
    it(`holds it fully inside the window at each edge on ${name}`, () => {
      expect(clampPoint({ x: -50, y: -50 }, win)).toEqual({ x: EDGE_PX, y: EDGE_PX });
      expect(clampPoint({ x: 9999, y: 9999 }, win)).toEqual(MAX(win));
      expect(clampPoint({ x: 9999, y: -1 }, win)).toEqual({ x: MAX(win).x, y: EDGE_PX });
      expect(clampPoint({ x: -1, y: 9999 }, win)).toEqual({ x: EDGE_PX, y: MAX(win).y });
    });
  }
});

describe("fractions", () => {
  it("round-trip, and a resize keeps the fraction then re-clamps", () => {
    const f = toFraction({ x: 640, y: 400 }, DESKTOP);
    expect(f).toEqual({ x: 0.5, y: 0.5 });
    expect(fromFraction(f, PHONE)).toEqual({ x: 195, y: 422 });
    expect(clampPoint(fromFraction({ x: 0.99, y: 0.99 }, { w: 500, h: 500 }), { w: 500, h: 500 })).toEqual({
      x: 440,
      y: 440,
    });
  });
});

describe("nudge", () => {
  it("moves 10px, or 50px with Shift, clamped", () => {
    expect(nudge({ x: 100, y: 100 }, "ArrowRight", false, DESKTOP)).toEqual({ x: 110, y: 100 });
    expect(nudge({ x: 100, y: 100 }, "ArrowUp", false, DESKTOP)).toEqual({ x: 100, y: 90 });
    expect(nudge({ x: 100, y: 100 }, "ArrowLeft", true, DESKTOP)).toEqual({ x: 50, y: 100 });
    expect(nudge({ x: 100, y: 100 }, "ArrowDown", true, DESKTOP)).toEqual({ x: 100, y: 150 });
    expect(nudge({ x: 12, y: 100 }, "ArrowLeft", true, DESKTOP)).toEqual({ x: EDGE_PX, y: 100 });
  });
  it("ignores other keys", () => {
    expect(nudge({ x: 1, y: 1 }, "a", false, DESKTOP)).toBeNull();
  });
});

describe("defaultPoint (Move to corner)", () => {
  const area = { left: 0, top: 48, right: 1280, bottom: 800 };
  it("is the bottom right of the area", () => {
    expect(defaultPoint(area, [], DESKTOP)).toEqual({ x: 1280 - LAUNCHER_PX - 16, y: 800 - LAUNCHER_PX - 16 });
  });
  it("stays clear of chrome there, moving above it", () => {
    const key = { left: 1008, top: 750, right: 1268, bottom: 788 };
    const at = defaultPoint(area, [key], DESKTOP);
    expect(at.y + LAUNCHER_PX).toBeLessThanOrEqual(key.top);
  });
});

describe("storage", () => {
  it("stores window fractions under archer.chat.position", () => {
    const held = new Map<string, string>();
    const storage = {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
      removeItem: (k: string) => void held.delete(k),
    } as unknown as Storage;
    writePosition(storage, { x: 0.25, y: 0.5 });
    expect(CHAT_POSITION_KEY).toBe("archer.chat.position");
    expect(readPosition(storage)).toEqual({ x: 0.25, y: 0.5 });
    writePosition(storage, null);
    expect(readPosition(storage)).toBeNull();
  });
  it("rejects values that are not fractions", () => {
    const storage = { getItem: () => '{"x":7,"y":"a"}' } as unknown as Storage;
    expect(readPosition(storage)).toBeNull();
  });
  it("survives a throwing localStorage, and no storage", () => {
    const boom = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(readPosition(boom)).toBeNull();
    expect(() => writePosition(boom, { x: 0.1, y: 0.1 })).not.toThrow();
    expect(readPosition(null)).toBeNull();
    expect(() => writePosition(null, null)).not.toThrow();
  });
});

describe("a panel of its own size (the key and the legend reuse this)", () => {
  const key = { w: 260, h: 360 };
  it("clamps a panel by its own width and height, not the launcher's", () => {
    expect(clampPoint({ x: 9999, y: 9999 }, DESKTOP, key)).toEqual({
      x: DESKTOP.w - key.w - EDGE_PX,
      y: DESKTOP.h - key.h - EDGE_PX,
    });
    expect(clampPoint({ x: -5, y: -5 }, DESKTOP, key)).toEqual({ x: EDGE_PX, y: EDGE_PX });
  });
  it("a panel larger than the window sits at the edge instead of throwing", () => {
    expect(clampPoint({ x: 50, y: 50 }, { w: 200, h: 200 }, { w: 400, h: 400 })).toEqual({ x: EDGE_PX, y: EDGE_PX });
  });
  it("nudges by 10 or 50 px, clamped by the panel's size", () => {
    expect(nudge({ x: 100, y: 100 }, "ArrowRight", false, DESKTOP, key)).toEqual({ x: 110, y: 100 });
    expect(nudge({ x: DESKTOP.w - key.w - EDGE_PX, y: 100 }, "ArrowRight", true, DESKTOP, key)).toEqual({
      x: DESKTOP.w - key.w - EDGE_PX,
      y: 100,
    });
  });
});
