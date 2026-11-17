/**
 * Expand's menu and "Added to This View", loaded on the first menu (ADR 0036 P31).
 *
 * The page is one file under a CSP of script hashes, so the dynamic import stays inline, as the source
 * editor's does (`source-editor/lazy.ts`): what it saves is evaluating the menu's code on every page that
 * never opens it. Unlike the editor, nothing loads it on mount: `loadExpandUi` is called by the first
 * menu (or the first frame), and `useExpandUi` only listens.
 */
import { useEffect, useState } from "react";

export type ExpandUi = typeof import("./ExpandUi");
let loaded: ExpandUi | null = null;
let pending: Promise<ExpandUi> | null = null;
const listeners = new Set<(ui: ExpandUi) => void>();

/** Starts loading the menu's code (idempotent). */
export function loadExpandUi(): Promise<ExpandUi> {
  pending ??= import("./ExpandUi").then(
    (module) => {
      loaded = module;
      for (const listen of listeners) listen(module);
      return module;
    },
    (error: unknown) => {
      pending = null;
      console.error("[archer] loading the Expand menu failed", error);
      throw error;
    },
  );
  return pending;
}

/** The menu's code once something has loaded it, else null. */
export function useExpandUi(): ExpandUi | null {
  const [ui, setUi] = useState<ExpandUi | null>(() => loaded);
  useEffect(() => {
    if (ui !== null) return;
    if (loaded !== null) {
      setUi(loaded);
      return;
    }
    const listen = (module: ExpandUi) => setUi(module);
    listeners.add(listen);
    return () => {
      listeners.delete(listen);
    };
  }, [ui]);
  return ui ?? loaded;
}
