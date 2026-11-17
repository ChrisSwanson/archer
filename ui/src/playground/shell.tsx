import { IN_APP_NAVIGATION } from "../app/in-app-navigation";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PlaygroundSnapshot } from "../../../shared/playground-snapshot.mts";
import type { PlaygroundIndex } from "../../../shared/playground-delivery.mts";
import { readBrowserRoute } from "../../../shared/browser-routes.mts";
import { App } from "../app/App";
import { decodeAddress, encodeAddress } from "./address";
import type { createStaticRuntime } from "./runtime.ts";
import { registerPlaygroundTools } from "./webmcp";
import { FAILURE_DETAIL, FAILURE_HEADLINE } from "./startup-failure";
import "./playground.css";

const subscribeAddress = (listener: () => void): (() => void) => {
  window.addEventListener(IN_APP_NAVIGATION, listener);
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener(IN_APP_NAVIGATION, listener);
    window.removeEventListener("popstate", listener);
  };
};

/** The width at which About opens over the app rather than beside it (playground.css). */
const OVERLAY_WIDTH = "(max-width: 720px)";
const overlayQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === "function" ? window.matchMedia(OVERLAY_WIDTH) : null;
function subscribeOverlayWidth(changed: () => void): () => void {
  const query = overlayQuery();
  query?.addEventListener("change", changed);
  return () => query?.removeEventListener("change", changed);
}
const overlayWidth = (): boolean => overlayQuery()?.matches ?? false;

export function PlaygroundShell({
  index,
  snapshot,
  runtime,
}: {
  /** Every example's name and notice; only the routed project's data is in `snapshot`. */
  index?: Pick<PlaygroundIndex, "projects">;
  snapshot: PlaygroundSnapshot;
  runtime: ReturnType<typeof createStaticRuntime>;
}) {
  const catalog = index?.projects ?? snapshot.projects;
  const controls = useSyncExternalStore(runtime.subscribeControls, () => runtime.controls);
  // Controls bind as soon as the page names a project; its tools register once its data has downloaded.
  const controlsReady = useSyncExternalStore(
    runtime.subscribe,
    () => controls !== undefined && runtime.project(controls.context().projectSlug) !== undefined,
  );
  const [toolsAvailable, setToolsAvailable] = useState(false);
  // On a phone About opens over the app (playground.css): while it is open the covered app is inert, so the keyboard
  // stays in the bar and About, and Escape closes it back on its toggle.
  const [aboutOpen, setAboutOpen] = useState(false);
  const overlaid = useSyncExternalStore(subscribeOverlayWidth, overlayWidth, () => false);
  const aboutPanel = useRef<HTMLDetailsElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const covered = aboutOpen && overlaid;
  // After every render (the workspace can mount later than the bar). Set here rather than as a prop so that focus
  // leaves first: inerting the focused control (About opened on a wide
  // screen, then narrowed to a phone) would otherwise drop the keyboard outside About.
  useLayoutEffect(() => {
    const app = workspace.current;
    if (app === null) return;
    if (covered && app.contains(document.activeElement)) aboutPanel.current?.querySelector("summary")?.focus();
    if (app.inert !== covered) app.inert = covered;
  });
  useEffect(() => {
    if (!controls || !controlsReady) {
      setToolsAvailable(false);
      return;
    }
    const register = () =>
      registerPlaygroundTools({
        snapshot,
        catalog,
        runtime,
        controls: () => runtime.controls,
        onAvailability: setToolsAvailable,
      });
    let tools = register();
    const dispose = () => tools.dispose();
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      tools.dispose();
      tools = register();
    };
    window.addEventListener("pagehide", dispose);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pagehide", dispose);
      window.removeEventListener("pageshow", restore);
      tools.dispose();
    };
  }, [controls, controlsReady, runtime, snapshot, catalog]);
  const memoryOnly = useSyncExternalStore(
    runtime.subscribe,
    () => runtime.memoryOnly,
    () => false,
  );
  const href = useSyncExternalStore(subscribeAddress, () => window.location.href);
  const url = new URL(decodeAddress(href));
  const route = readBrowserRoute(url.pathname, url.search, url.hash);
  const slug = route && route.kind !== "projects" ? route.projectSlug : catalog[0]!.slug;
  const failed = useSyncExternalStore(runtime.subscribe, () => runtime.loadFailed(slug));
  // Retry forgets the failed download and mounts the App again, so it connects (and downloads) afresh.
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    runtime.retry();
    setAttempt((value) => value + 1);
  };
  const reset = () => {
    runtime.reset();
    try {
      for (const key of Object.keys(localStorage))
        if (key.startsWith("archer:playground:")) localStorage.removeItem(key);
    } catch {
      /* The overlay already keeps a usable in-memory copy. */
    }
    window.location.reload();
  };
  return (
    <div className="playground">
      {/* One row on a phone: "Example", the project and About; the docs link, Reset and the rest of the provenance
          wait inside About there (playground.css, `.playground-narrow` and `.playground-wide`). */}
      {/* Escape anywhere in the bar (About, or the Project selector still reachable beside it) closes About, back on
          its toggle; the app's shortcuts, which listen beyond the bar, do not see it. An open Help is above both and
          takes Escape first (its window capture listener consumes it). */}
      <section
        className="playground-bar"
        aria-label="Example playground"
        onKeyDown={(event) => {
          const panel = aboutPanel.current;
          if (event.key !== "Escape" || panel === null || !panel.open) return;
          event.preventDefault();
          event.stopPropagation();
          panel.open = false;
          panel.querySelector("summary")?.focus();
        }}
      >
        <p className="playground-provenance playground-wide">
          Example · Changes stay in this browser · No agent connected.
        </p>
        <p className="playground-provenance playground-narrow">Example</p>
        {/* The way back to the docs: the document is always playground/app/index.html, whatever route it shows. */}
        <a className="playground-docs playground-wide" href="../../using-the-playground">
          Archer docs
        </a>
        {toolsAvailable ? (
          <p className="playground-agent-tools playground-wide" role="status">
            Agent tools available (WebMCP)
          </p>
        ) : null}
        <label className="playground-project">
          <span className="playground-project-label">Project</span>{" "}
          <select
            value={slug}
            onChange={(event) => window.location.assign(encodeAddress(`/projects/${event.target.value}/`))}
          >
            {catalog.map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="archer-review-button playground-wide" onClick={reset}>
          Reset demo
        </button>
        <details
          ref={aboutPanel}
          className="playground-about"
          onToggle={(event) => setAboutOpen(event.currentTarget.open)}
        >
          <summary>
            About<span className="playground-wide"> this demo</span>
          </summary>
          <div>
            <div className="playground-about-actions playground-narrow">
              <p>This is an example. Changes you make stay in this browser, and no agent is connected.</p>
              {memoryOnly ? <p>Your changes last until this tab closes.</p> : null}
              <div>
                <a className="playground-docs" href="../../using-the-playground">
                  Archer docs
                </a>
                <button type="button" className="archer-review-button" onClick={reset}>
                  Reset demo
                </button>
              </div>
            </div>
            <p>
              Explore real example diagrams and notes, play saved walkthroughs, and save local comments. Walkthroughs
              are prerecorded examples. Search filters names and descriptions.
            </p>
            <p>
              Agent chat and delivery, source editing, history, cross-diagram expansion and service exports are
              unavailable. Settings and the chat bubble open with example content so you can see them; they send
              nothing.
            </p>
            {catalog
              .filter((project) => project.notice)
              .map((project) => (
                <section key={project.slug}>
                  <h2>{project.name}</h2>
                  <pre>{project.notice}</pre>
                </section>
              ))}
            <details>
              <summary>Font licence</summary>
              <pre>{snapshot.fontLicense}</pre>
            </details>
          </div>
        </details>
        {memoryOnly ? (
          <p className="playground-wide" role="status">
            Kept until this tab closes.
          </p>
        ) : null}
      </section>
      <div className="playground-workspace" ref={workspace}>
        {route?.kind === "edit" || url.searchParams.has("edit") ? (
          <main className="playground-unavailable">
            <h1>Unavailable in This Demo</h1>
            <p>Source editing is unavailable in this example.</p>
            <a href={encodeAddress(`/projects/${slug}/`)}>Browse the example</a>
          </main>
        ) : failed ? (
          <div className="archer-notice playground-startup-failure" role="alert">
            <p className="archer-notice-headline">{FAILURE_HEADLINE}</p>
            <p className="archer-notice-detail">{FAILURE_DETAIL}</p>
            <button type="button" className="archer-review-button" onClick={retry}>
              Retry
            </button>
          </div>
        ) : (
          <App key={attempt} />
        )}
      </div>
    </div>
  );
}
