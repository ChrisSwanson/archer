import { initTheme } from "../theme/theme";
import { installMenuKeyFallback } from "../app/menu-key";
import { tabReady } from "../comments/draft-tabs";
import { bootPlayground, type PlaygroundBoot } from "./boot";
import { showStartupFailure } from "./startup-failure";
import { followDocsTheme, startDocsTheme } from "./docs-theme";
import { startLayoutWorker } from "./worker";
// React Flow's defaults before the page's stylesheet, as on the live page, whose App imports them before its entry
// imports `styles.css`: the page restyles React Flow's controls with selectors no more specific than React Flow's own,
// so whichever loads later wins. Here the App arrives in the view's chunk, after this entry's stylesheet, and the
// canvas column drew React Flow's filled, ruled, dark-inked buttons instead of the app's.
import "@xyflow/react/dist/style.css";
import "../styles.css";
import "../theme/current-font.css";
import "../app/stage-dock.css";

const root = document.getElementById("root");
if (!root) throw new Error("The playground root is missing.");

/**
 * Each view's import stays its own call: the bundler merged a conditional pair of imports into one preload that
 * carried only the shell's stylesheets, so the landing's scene drew without its own (no layout, a zero-height canvas).
 */
const VIEWS: Record<"scene" | "shell", () => Promise<{ mount(element: HTMLElement, boot: PlaygroundBoot): unknown }>> =
  {
    scene: () => import("./mount-scene"),
    shell: () => import("./mount-shell"),
  };

/**
 * The static entry: selects its runtime and address codec, loads only the routed project, and mounts only the
 * view this address asks for. The view's chunks load while the data does: App modules read the runtime and
 * codec at call time, never while they are evaluated.
 */
async function start(element: HTMLElement): Promise<void> {
  const hero = new URL(window.location.href).searchParams.get("scene") === "hero";
  const view = hero ? VIEWS.scene() : VIEWS.shell();
  // Both views lay out a drawing: the worker downloads beside the data and the view's chunks, not after them.
  startLayoutWorker();
  // A failed download is reported once, below; never also as an unhandled rejection.
  view.catch(() => undefined);
  // The landing's frame wears the docs page's theme, and follows it, from before its first paint (a startup
  // failure included); it reads no stored preference.
  const docsTheme = hero && startDocsTheme(window.location.href);
  if (docsTheme) followDocsTheme(window);
  const boot = await bootPlayground();
  // Before the first render, so an explicit theme override never shows a frame of the theme it overrides.
  if (!docsTheme) initTheme();
  installMenuKeyFallback();
  await tabReady().catch(() => undefined);
  await (await view).mount(element, boot);
}
// A failed data file or view chunk would otherwise leave a blank page. Retry loads the document again: a module
// import that failed stays failed in this document.
start(root).catch(() => {
  showStartupFailure(root, () => window.location.reload());
  // The landing's frame: its page stops saying "Loading" and offers its own way back (live-demo.mts).
  if (window.parent !== window) window.parent.postMessage({ type: "archer-playground-failed" }, window.location.origin);
});
