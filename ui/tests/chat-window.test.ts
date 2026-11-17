// The open chat's geometry: beside its launcher, resizable, and a composer that grows upward.
import { describe, expect, it } from "vitest";
import {
  clampDock,
  clampSize,
  composerHeight,
  placeChat,
  readPrefs,
  writePrefs,
  CHAT_PREFS_KEY,
} from "../src/chat/chat-window";

const WIN = { w: 1280, h: 800 };

describe("placeChat", () => {
  it("opens toward the larger free side, clamped inside the window", () => {
    const bottomRight = { left: 1200, top: 740, right: 1252, bottom: 792 };
    const p = placeChat(bottomRight, { w: 340, h: 460 }, WIN);
    expect(p).toMatchObject({ x: 1252 - 340, y: 740 - 460 - 10, corner: "tl" });
    const topLeft = { left: 8, top: 8, right: 60, bottom: 60 };
    expect(placeChat(topLeft, { w: 340, h: 460 }, WIN)).toMatchObject({ x: 8, y: 70, corner: "br" });
  });
  it("never covers its launcher: with no room above or below it sits beside it", () => {
    const launcher = { left: 1372, top: 464, right: 1424, bottom: 516 };
    const p = placeChat(launcher, { w: 340, h: 460 }, { w: 1440, h: 900 });
    expect(p.x + 340).toBeLessThanOrEqual(launcher.left);
    expect(p.corner).toBe("tl");
    const left = placeChat({ left: 10, top: 464, right: 62, bottom: 516 }, { w: 340, h: 460 }, { w: 1440, h: 900 });
    expect(left.x).toBeGreaterThanOrEqual(62);
  });
});

describe("sizes", () => {
  it("clamps the window to its minimum and to the screen", () => {
    expect(clampSize({ w: 10, h: 10 }, WIN)).toEqual({ w: 280, h: 300 });
    expect(clampSize({ w: 5000, h: 5000 }, WIN)).toEqual({ w: 640, h: 784 });
  });
  it("clamps the sidebar so the drawing keeps room", () => {
    expect(clampDock(100, 1280, 0)).toBe(280);
    expect(clampDock(900, 1280, 0)).toBe(560);
    expect(clampDock(560, 1000, 360)).toBe(280);
  });
});

describe("composerHeight", () => {
  it("fits a short draft", () => {
    expect(composerHeight({ chatH: 460, fixedH: 120, scrollH: 20 })).toEqual({ height: 36, scrolls: false });
  });
  it("grows to 40% of the chat, then scrolls inside", () => {
    expect(composerHeight({ chatH: 500, fixedH: 120, scrollH: 150 })).toEqual({ height: 152, scrolls: false });
    expect(composerHeight({ chatH: 500, fixedH: 120, scrollH: 900 })).toEqual({ height: 200, scrolls: true });
  });
  it("keeps three lines of conversation visible in a short chat", () => {
    const { height } = composerHeight({ chatH: 300, fixedH: 150, scrollH: 900 });
    expect(300 - 150 - height).toBeGreaterThanOrEqual(72);
    expect(height).toBe(78);
  });
  it("never shrinks below one line", () => {
    expect(composerHeight({ chatH: 200, fixedH: 190, scrollH: 900 }).height).toBe(36);
  });
});

describe("prefs", () => {
  it("remembers size, sidebar width and mode, and survives bad storage", () => {
    const held = new Map<string, string>();
    const storage = {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
    } as unknown as Storage;
    expect(readPrefs(storage)).toEqual({ w: 340, h: 460, dw: 360, mode: "float" });
    writePrefs(storage, { w: 400, h: 500, dw: 420, mode: "side" });
    expect(held.has(CHAT_PREFS_KEY)).toBe(true);
    expect(readPrefs(storage)).toEqual({ w: 400, h: 500, dw: 420, mode: "side" });
    expect(readPrefs({ getItem: () => "{nonsense" } as unknown as Storage).mode).toBe("float");
    expect(
      readPrefs({
        getItem() {
          throw new Error("x");
        },
      } as unknown as Storage).w,
    ).toBe(340);
    expect(() => writePrefs(null, readPrefs(null))).not.toThrow();
  });
});
