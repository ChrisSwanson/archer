import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { legacyEditAddress } from "./app/browser-routes";
import { hostMode } from "./app/host-bridge";
import { PageShell } from "./app/page-shell";
import { startBackgroundLayout, startsLayoutAtBoot } from "./layout/elk-worker-transport";
import { initTheme } from "./theme/theme";
import { installMenuKeyFallback } from "./app/menu-key";
import { tabReady } from "./comments/draft-tabs";
import "./styles.css";
import "./theme/current-font.css";
// The stage dock is also imported by the exporter, which runs where CSS is not a module.
import "./app/stage-dock.css";

// Before the first render, so an explicit override never shows a frame of the
// theme it overrides. The OS-following default needs no help here: the
// stylesheet resolves it without JavaScript.
initTheme();
// Shift+F10 opens the focused element's menu on a Mac too, where the browser sends no `contextmenu` for it.
installMenuKeyFallback();

// The old standalone editor address for an existing diagram takes its in-place address first, in this page load:
// loading the page again there read the diagrams, compile, bootstrap and authoring twice and started ELK twice.
const inPlace = hostMode() === "web" ? legacyEditAddress(window.location.href) : null;
if (inPlace !== null) window.history.replaceState(window.history.state, "", inPlace);

// The web page starts ELK's worker on its first graph layout, so a page that draws none never fetches it (PF-5);
// an MCP host, whose worker is inline, starts it while the page renders (perf #1).
if (startsLayoutAtBoot(hostMode())) startBackgroundLayout();

const root = document.getElementById("root");
if (!root) throw new Error("Archer root element is missing");

// Debug builds only (`__ARCHER_DEBUG__`, docs/devkit/browser-telemetry.md): telemetry is installed
// before the first render so it sees every request, and reports React's errors through the root.
// A production build drops this branch and never bundles the module.
async function start(element: HTMLElement): Promise<void> {
  // This tab's owner id is settled before anything is restored from this browser (draft-tabs.ts, O117): a duplicated
  // tab must not read its opener's drafts as its own.
  await tabReady().catch(() => undefined);
  const options = __ARCHER_DEBUG__ ? (await import("./telemetry/runtime")).startTelemetry().rootOptions : undefined;
  createRoot(element, options).render(
    <StrictMode>
      <PageShell />
    </StrictMode>,
  );
}
void start(root);
