import { useEffect, useState, type ComponentType, type JSX } from "react";

/**
 * A component whose module is evaluated on first use, not when the page starts (perf #3).
 *
 * The page is one file (an MCP host embeds it as one resource), so a dynamic `import()` stays inline
 * and saves no bytes; what it saves is evaluating that module graph before the first paint.
 *
 * Not `React.lazy`: a boundary that showed its fallback holds the content back for up to 300 ms
 * after the module arrives (React's fallback throttle), which would delay every first paint that
 * needs it. Here the component renders nothing until loaded, then itself; `preload()` early (an
 * editing route, an idle moment) means it is already there when it is first shown.
 */
export function deferredComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
): {
  readonly Component: (props: P) => JSX.Element | null;
  readonly preload: () => Promise<ComponentType<P>>;
} {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = (): Promise<ComponentType<P>> => {
    pending ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  // biome-ignore lint/correctness/noComponentHookFactories: a deliberate factory, called once per module at load time (App.tsx), never during a render, so the component's identity is stable.
  function Component(props: P): JSX.Element | null {
    const [ready, setReady] = useState<ComponentType<P> | null>(() => loaded);
    useEffect(() => {
      if (ready !== null) return;
      let live = true;
      preload().then(
        (component) => {
          if (live) setReady(() => component);
        },
        (error: unknown) => console.error("[archer] loading a page part failed", error),
      );
      return () => {
        live = false;
      };
    }, [ready]);
    const Loaded = ready ?? loaded;
    return Loaded === null ? null : <Loaded {...props} />;
  }
  return { Component, preload };
}

/** Runs `work` when the page is idle (or soon, where there is no idle callback). */
export function whenIdle(work: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(work, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(work, 200);
  return () => window.clearTimeout(handle);
}
