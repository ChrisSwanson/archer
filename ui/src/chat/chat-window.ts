/**
 * The open chat's geometry (ADR 0034 §10, "Window"): beside its launcher, resizable, remembered;
 * and the composer that grows upward. Pure, except the viewer's stored preferences.
 */
import { readJson, within, writeJson, type Rect, type Win } from "./chat-position";

export const CHAT_PREFS_KEY = "archer.chat.window";
export const MIN_CHAT = { w: 280, h: 300 };
export const MIN_DOCK = 280;
const MAX_DOCK = 560;
/** The drawing keeps at least this much beside the sidebar. */
const DRAWING_MIN = 380;
const LINE_PX = 36;
/** Three lines of conversation stay visible above the composer. */
const LOG_MIN = 72;

export type ChatPrefs = {
  readonly w: number;
  readonly h: number;
  readonly dw: number;
  readonly mode: "float" | "side";
};
const DEFAULT_PREFS: ChatPrefs = { w: 340, h: 460, dw: 360, mode: "float" };

export function clampSize(s: { w: number; h: number }, win: Win): { w: number; h: number } {
  return { w: within(s.w, MIN_CHAT.w, Math.min(640, win.w - 16)), h: within(s.h, MIN_CHAT.h, win.h - 16) };
}
/** `rowW` is the stage row's width, `otherW` what the walkthrough panel takes of it. */
export const clampDock = (w: number, rowW: number, otherW: number): number =>
  within(w, MIN_DOCK, Math.max(MIN_DOCK, Math.min(MAX_DOCK, rowW - otherW - DRAWING_MIN)));

/**
 * The window opens toward the larger free side of the launcher. `corner` is the window's corner
 * away from it, where the resize grip sits ("t" or "b", then "l" or "r").
 */
export function placeChat(
  launcher: Rect,
  size: { w: number; h: number },
  win: Win,
): { x: number; y: number; corner: string } {
  const right = (launcher.left + launcher.right) / 2 >= win.w / 2;
  const above = launcher.top > size.h + 20;
  const below = launcher.bottom + 10 + size.h <= win.h - 8;
  if (!above && !below) {
    // Neither fits: beside it, never over it, its bottom edge level with the launcher's where it can be.
    const x = right ? launcher.left - size.w - 10 : launcher.right + 10;
    return {
      x: within(x, 8, win.w - size.w - 8),
      y: within(launcher.bottom - size.h, 8, win.h - size.h - 8),
      corner: `t${right ? "l" : "r"}`,
    };
  }
  const x = right ? launcher.right - size.w : launcher.left;
  const y = above ? launcher.top - size.h - 10 : launcher.bottom + 10;
  return {
    x: within(x, 8, win.w - size.w - 8),
    y: within(y, 8, win.h - size.h - 8),
    corner: `${above ? "t" : "b"}${right ? "l" : "r"}`,
  };
}

/**
 * The composer grows upward (the chat's bottom edge stays put) to 40% of the chat's height, and
 * never into the last three lines of the conversation; past that it scrolls inside. `fixedH` is
 * the chat's height less the log and the text box (header, switch, the form's padding).
 */
export function composerHeight(m: { chatH: number; fixedH: number; scrollH: number }): {
  height: number;
  scrolls: boolean;
} {
  const max = Math.max(LINE_PX, Math.min(m.chatH * 0.4, m.chatH - m.fixedH - LOG_MIN));
  const need = m.scrollH + 2;
  return { height: Math.max(LINE_PX, Math.min(max, need)), scrolls: need > max };
}

export function readPrefs(storage: Storage | null): ChatPrefs {
  const v = readJson(storage, CHAT_PREFS_KEY) as Partial<ChatPrefs> | null;
  if (v === null || typeof v !== "object") return DEFAULT_PREFS;
  const n = (x: unknown, d: number): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
  return {
    w: n(v.w, DEFAULT_PREFS.w),
    h: n(v.h, DEFAULT_PREFS.h),
    dw: n(v.dw, DEFAULT_PREFS.dw),
    mode: v.mode === "side" ? "side" : "float",
  };
}
export const writePrefs = (storage: Storage | null, prefs: ChatPrefs): void =>
  writeJson(storage, CHAT_PREFS_KEY, prefs);
