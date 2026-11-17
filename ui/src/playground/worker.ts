import builtAddress from "../layout/elk-layout-worker?worker&url";

/**
 * The layout worker beside the public document at any deployment base. A relative-base build names it
 * relative to its importing chunk (already absolute at run time); anything relative resolves against the document.
 */
export function layoutWorkerUrl(built: string, documentHref: string): string {
  return new URL(built, documentHref).href;
}

/** Started by the entry before the App boots (`main.ts`), and not yet handed to a layout transport. */
let early: Worker | null = null;
let handed = false;

/**
 * Start the layout worker now. A browser cannot preload a classic worker (`<link rel="preload" as="worker">` is
 * an unsupported value in Chromium), and the App asks for one only once it draws: starting it from the entry lets
 * its download run beside the data and the view's chunks instead of after them.
 */
export function startLayoutWorker(): Worker {
  if (!early && !handed) early = new Worker(layoutWorkerUrl(builtAddress, window.location.href));
  return early ?? createLayoutWorker();
}

export function createLayoutWorker(): Worker {
  if (early) {
    const worker = early;
    early = null;
    handed = true;
    return worker;
  }
  handed = true;
  return new Worker(layoutWorkerUrl(builtAddress, window.location.href));
}
