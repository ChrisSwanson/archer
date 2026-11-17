import { useEffect, useRef } from "react";
import type { StaticControls } from "../playground/webmcp-controls";
import type { Walkthroughs } from "../walkthroughs/use-walkthroughs";
import type { PageRuntime } from "./runtime";

/** Bind semantic actions to the mounted controllers; completion follows React accepting the state. */
export function useRuntimeControls(input: {
  runtime: PageRuntime;
  projectSlug: string | null;
  viewId: string | null;
  ready: boolean;
  openView: (viewId: string) => void;
  enterWalk: () => void;
  walkthroughs: Walkthroughs;
}): void {
  const latest = useRef(input);
  latest.current = input;
  const checks = useRef(new Set<() => void>());
  useEffect(() => {
    for (const check of [...checks.current]) check();
  });
  useEffect(() => {
    if (!input.runtime.bindControls || input.projectSlug === null) return;
    const lifetime = new AbortController();
    let presentation: AbortController | undefined;
    const project = input.projectSlug;
    const context = () => ({
      projectSlug: project,
      ...(latest.current.viewId === null ? {} : { viewId: latest.current.viewId }),
    });
    const wait = (predicate: () => boolean, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const clean = () => {
          checks.current.delete(check);
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          clean();
          reject(signal.reason);
        };
        const check = () => {
          if (predicate()) {
            clean();
            resolve();
          }
        };
        checks.current.add(check);
        signal.addEventListener("abort", abort, { once: true });
      });
    };
    const signalFor = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
    const controls: StaticControls = {
      context,
      async present(request, execution) {
        execution.throwIfAborted();
        lifetime.signal.throwIfAborted();
        presentation?.abort(new DOMException("A newer presentation replaced this request", "AbortError"));
        presentation = new AbortController();
        const signal = AbortSignal.any([signalFor(execution), presentation.signal]);
        signal.throwIfAborted();
        if (latest.current.projectSlug !== project) throw new Error("Example project changed.");
        if (latest.current.viewId !== request.viewId) latest.current.openView(request.viewId);
        await wait(() => latest.current.viewId === request.viewId && latest.current.ready, signal);
        signal.throwIfAborted();
        if (request.walkthrough) {
          const walk = latest.current.walkthroughs.walks.find((walk) => walk.id === request.walkthrough!.id);
          const step = request.walkthrough.step ?? 1;
          if (walk?.status !== "current" || !Number.isInteger(step) || step < 1 || step > walk.steps.length)
            throw new Error("Saved walkthrough or step is unavailable.");
          latest.current.enterWalk();
          latest.current.walkthroughs.select(walk.id, step);
          await wait(
            () => latest.current.walkthroughs.state.id === walk.id && latest.current.walkthroughs.state.step === step,
            signal,
          );
        } else if (latest.current.walkthroughs.state.open) {
          // As a live presentation that names no walkthrough does (use-walk-steering): the walkthrough leaves, so
          // the presentation's own emphasis is what the page shows rather than an offer beneath the step's.
          latest.current.walkthroughs.dispatch({ type: "close" });
          await wait(() => !latest.current.walkthroughs.state.open, signal);
        }
        signal.throwIfAborted();
        return context();
      },
      async controlWalk(request, execution) {
        const signal = signalFor(execution);
        signal.throwIfAborted();
        if (latest.current.projectSlug !== project || latest.current.walkthroughs.walk === null)
          throw new Error("Open a saved walkthrough first.");
        latest.current.walkthroughs.dispatch({ type: request.action });
        await wait(() => latest.current.walkthroughs.state.playing === (request.action === "play"), signal);
        return context();
      },
    };
    const unbind = input.runtime.bindControls(controls);
    return () => {
      lifetime.abort(new DOMException("Example controls disposed", "AbortError"));
      unbind();
    };
  }, [input.runtime, input.projectSlug]);
}
