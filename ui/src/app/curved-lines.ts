/**
 * "Curved lines": whether the canvas draws its connections with large curves (`diagrams/curved-route.ts`) or with
 * the square view's corners. A viewer's own preference, kept in this browser and shared by every project and the
 * embedded shell, like the character shortcuts (`shortcuts.ts`). No service setting or write. Off by default: the
 * owner decides the default later.
 */
import { useSyncExternalStore } from "react";
import { browserStateKey } from "../runtime/address.ts";

export const CURVED_LINES_SETTING = "archer.canvas.curvedLines";
const CURVED_LINES_CHANGED = "archer-curved-lines-changed";
let memoryCurved: boolean | undefined;

export function curvedLinesEnabled(): boolean {
  if (memoryCurved !== undefined) return memoryCurved;
  try {
    return localStorage.getItem(browserStateKey(CURVED_LINES_SETTING)) === "on";
  } catch {
    return false;
  }
}

export function setCurvedLinesEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(browserStateKey(CURVED_LINES_SETTING), enabled ? "on" : "off");
    memoryCurved = undefined;
  } catch {
    // Storage blocked: the choice holds for this page.
    memoryCurved = enabled;
  }
  window.dispatchEvent(new Event(CURVED_LINES_CHANGED));
}

function subscribeCurvedLines(changed: () => void): () => void {
  const storage = (event: StorageEvent): void => {
    if (event.key === browserStateKey(CURVED_LINES_SETTING) || event.key === null) {
      memoryCurved = undefined;
      changed();
    }
  };
  window.addEventListener(CURVED_LINES_CHANGED, changed);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CURVED_LINES_CHANGED, changed);
    window.removeEventListener("storage", storage);
  };
}

export function useCurvedLines(): boolean {
  return useSyncExternalStore(subscribeCurvedLines, curvedLinesEnabled, () => false);
}
