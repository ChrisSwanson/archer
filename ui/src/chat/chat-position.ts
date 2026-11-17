/**
 * Where the chat launcher sits (ADR 0034 §10): anywhere the person drops it, with no snapping,
 * kept fully inside the window. Pure, and stored per viewer as fractions of the window so a
 * resize keeps it in place.
 */
import { arrowDelta } from "../app/use-grip";

export const CHAT_POSITION_KEY = "archer.chat.position";
export const LAUNCHER_PX = 52;
export const EDGE_PX = 8;
const CORNER_INSET_PX = 16;
const GAP_PX = 12;

export type Point = { readonly x: number; readonly y: number };
export type Win = { readonly w: number; readonly h: number };
export type Rect = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

export const within = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The launcher's own size; a panel passes its own (the key and the legend are moved by this same rule). */
export const LAUNCHER_SIZE: Win = { w: LAUNCHER_PX, h: LAUNCHER_PX };

/** Held fully inside the window; a box larger than the window sits at its top left edge. */
export function clampPoint(p: Point, win: Win, size: Win = LAUNCHER_SIZE): Point {
  return {
    x: within(p.x, EDGE_PX, Math.max(EDGE_PX, win.w - size.w - EDGE_PX)),
    y: within(p.y, EDGE_PX, Math.max(EDGE_PX, win.h - size.h - EDGE_PX)),
  };
}
export const toFraction = (p: Point, win: Win): Point => ({ x: p.x / win.w, y: p.y / win.h });
export const fromFraction = (f: Point, win: Win): Point => ({ x: Math.round(f.x * win.w), y: Math.round(f.y * win.h) });

/** An arrow key moves it 10 px, or 50 px with Shift; `null` for any other key. */
export function nudge(p: Point, key: string, shift: boolean, win: Win, size: Win = LAUNCHER_SIZE): Point | null {
  const d = arrowDelta(key, shift ? 50 : 10);
  return d === undefined ? null : clampPoint({ x: p.x + d[0], y: p.y + d[1] }, win, size);
}

/** The corner: the area's bottom right, moved above any chrome (`zones`) it would lie on. */
export function defaultPoint(area: Rect, zones: readonly Rect[], win: Win): Point {
  const x = area.right - LAUNCHER_PX - CORNER_INSET_PX;
  let y = area.bottom - LAUNCHER_PX - CORNER_INSET_PX;
  for (let pass = 0; pass < 3; pass += 1) {
    for (const z of zones) {
      const hit = x - 6 < z.right && x + LAUNCHER_PX + 6 > z.left && y - 6 < z.bottom && y + LAUNCHER_PX + 6 > z.top;
      if (hit)
        y = z.top - LAUNCHER_PX - GAP_PX >= area.top + EDGE_PX ? z.top - LAUNCHER_PX - GAP_PX : z.bottom + GAP_PX;
    }
  }
  return clampPoint({ x, y }, win);
}

/** A viewer's stored convenience, read as JSON: `null` where it is absent, unreadable or storage is blocked. */
export function readJson(storage: Storage | null, key: string): unknown {
  try {
    return JSON.parse(storage?.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

/** `null` forgets it. Never throws: the page works without storage. */
export function writeJson(storage: Storage | null, key: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* A viewer's convenience. */
  }
}

/** A stored place, as fractions of the window; `null` where absent or not two numbers in 0..1. */
export function readFraction(storage: Storage | null, key: string): Point | null {
  const v = readJson(storage, key) as Partial<Point> | null;
  const ok = (n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 1;
  return v !== null && typeof v === "object" && ok(v.x) && ok(v.y) ? { x: v.x, y: v.y } : null;
}

export const readPosition = (storage: Storage | null): Point | null => readFraction(storage, CHAT_POSITION_KEY);

/** `null` forgets it (the corner). */
export const writePosition = (storage: Storage | null, f: Point | null): void =>
  writeJson(storage, CHAT_POSITION_KEY, f);
