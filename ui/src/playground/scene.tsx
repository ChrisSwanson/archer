import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect, type MouseEvent } from "react";
import type { PlaygroundSnapshot } from "../../../shared/playground-snapshot.mts";
import { DiagramCanvas, type CanvasState } from "../diagrams/DiagramCanvas";
import { useDrawnSelection, useStage, useStageGestures, useStageLayout } from "../app/diagram-stage";
import { DEFAULT_TYPEFACE } from "../layout/text-measure";
import { createReviewEvents } from "../comments/events";
import { httpCommentsTransport } from "../comments/transport";
import { newOperation } from "../comments/operations";
import { commentPins } from "../comments/state";
import { ThreadCard } from "../comments/ThreadCard";
import type { Thread } from "../comments/contract";
import { useWalkthroughs } from "../walkthroughs/use-walkthroughs";
import { useWalkFollow, type WalkNest } from "../walkthroughs/use-walk-camera";
import { WalkthroughTransport } from "../walkthroughs/WalkthroughSlot";
import { WalkLive, WalkModeKeys } from "../walkthroughs/WalkthroughPanel";
import { readWalkAddress, type WalkAddress } from "../walkthroughs/walk-address";
import { decodeAddress } from "./address";
import type { createStaticRuntime } from "./runtime";
import "./scene.css";

/**
 * The Tour diagrams the scene can open, each with the node its seeded comment sits on (the landing's poster
 * shows the heartbeat's on Design Together, Live). Anything else opens the containers.
 */
const SCENES: Record<string, { readonly id: string; readonly label: string }> = {
  containers: { id: "coding_agent", label: "Coding Agent" },
  heartbeat: { id: "revise", label: "Design Together, Live" },
};
const DEFAULT_VIEW = "containers";

/** The diagram and walkthrough step the frame's address names (`route`, `walkthrough`, `step`). */
export function sceneAddress(href: string): { viewId: string; walk: WalkAddress | null } {
  const logical = new URL(decodeAddress(href));
  const named = /^\/projects\/archer-tour\/diagrams\/([a-z0-9-]+)\.mmd$/u.exec(logical.pathname)?.[1];
  return {
    viewId: named && named in SCENES ? named : DEFAULT_VIEW,
    walk: readWalkAddress(logical.search),
  };
}

/** The landing lends its frame to the same stage, player and review components used by the full page. */
export function PlaygroundScene({
  snapshot,
  runtime,
}: {
  snapshot: PlaygroundSnapshot;
  runtime: ReturnType<typeof createStaticRuntime>;
}) {
  const [{ viewId, walk: wanted }] = useState(() => sceneAddress(window.location.href));
  const target = `view:${viewId}` as const;
  const [title, setTitle] = useState("");
  const stage = useStage();
  const { present } = stage;
  const events = useMemo(createReviewEvents, []);
  const tour = snapshot.projects.find((project) => project.slug === "archer-tour");
  const transport = useMemo(
    () => httpCommentsTransport((url, init) => runtime.request(`/p/archer-tour/${url}`, init)),
    [runtime],
  );
  const [threads, setThreads] = useState<readonly Thread[]>([]);
  const [threadOpen, setThreadOpen] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const seedOperation = useMemo(() => newOperation("comment.create", target), [target]);
  const refresh = useCallback(
    async () => setThreads((await transport.listThreads(target)).threads),
    [transport, target],
  );
  const returnPin = useRef<HTMLElement | null>(null);
  const closeControl = useRef<HTMLButtonElement | null>(null);
  const closeThread = useCallback(() => {
    setThreadOpen(null);
    if (returnPin.current?.isConnected) returnPin.current.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (threadOpen !== null) closeControl.current?.focus({ preventScroll: true });
  }, [threadOpen]);
  useEffect(() => {
    if (threadOpen === null) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeThread();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [threadOpen, closeThread]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      if (!tour) throw new Error("The Tour example is unavailable. Open the full Playground to try another example.");
      const response = await runtime.request(`/p/archer-tour/api/diagrams/${viewId}`);
      if (!response.ok) throw new Error("The Tour diagram could not load. Open the full Playground to try again.");
      const envelope: unknown = await response.json();
      if (disposed) return;
      present({
        type: "present",
        envelope,
        diagnostics: [],
        presentation: { presentationId: `hero-${viewId}`, viewId: viewId },
      });
      const inventory = (await (await runtime.request("/p/archer-tour/api/diagrams")).json()) as {
        views?: { id: string; title?: string }[];
      };
      if (!disposed) setTitle(inventory.views?.find((view) => view.id === viewId)?.title ?? viewId);
      const existing = await transport.listThreads(target);
      if (disposed) return;
      if (existing.threads.length === 0) {
        await transport.createThreadOnce(seedOperation, {
          target: target,
          anchor: { kind: "node", ...SCENES[viewId]! },
          body:
            viewId === "heartbeat"
              ? "Demo comment: Can the agent show me the change before it writes code?"
              : "Demo comment: How does the agent’s diagram reach the person?",
        });
      }
      if (!disposed) await refresh();
    };
    void load().catch((error: unknown) => {
      if (!disposed)
        setFailure(error instanceof Error ? error.message : "The demo could not load. Open Playground to try again.");
    });
    return () => {
      disposed = true;
    };
  }, [tour, runtime, transport, present, seedOperation, refresh, viewId, target]);

  useStageLayout(stage, DEFAULT_TYPEFACE, true);
  const gestures = useStageGestures(stage, { typeface: DEFAULT_TYPEFACE });
  const walkthroughs = useWalkthroughs({
    viewId: stage.presentation?.viewId ?? null,
    enabled: true,
    events,
    view: stage.drawnKeyModel?.type === "graph" ? stage.drawnKeyModel.view : null,
  });
  const { ready, walks, select } = walkthroughs;
  const chosen = useRef(false);
  useEffect(() => {
    const named = wanted ? walks.find((walk) => walk.id === wanted.id && walk.status === "current") : undefined;
    const walk = named ?? walks.find((walk) => walk.status === "current");
    if (ready && !chosen.current && walk) {
      chosen.current = true;
      const step = named && wanted?.step !== undefined ? Math.min(wanted.step, walk.steps.length) : 1;
      select(walk.id, step);
    }
  }, [ready, walks, select, wanted]);
  const nest = useMemo<WalkNest>(
    () => ({
      drawn: stage.drawnNest,
      current: () => stage.nestRef.current.open,
      set: gestures.openContainers,
      saved: () => null,
    }),
    [stage.drawnNest, stage.nestRef, gestures.openContainers],
  );
  const follow = useWalkFollow({
    walkthroughs,
    full: stage.drawnKeyModel?.type === "graph" ? stage.drawnKeyModel.view : null,
    nest,
  });
  const pins = useMemo(() => commentPins(threads), [threads]);
  const selection = useDrawnSelection(stage.selection, stage.drawnNest);
  const canvasState = useMemo<CanvasState>(
    () =>
      stage.canvasState.status === "ready"
        ? { ...stage.canvasState, focus: walkthroughs.render?.focus ?? {} }
        : stage.canvasState,
    [stage.canvasState, walkthroughs.render],
  );
  const announced = useRef(false);
  useEffect(() => {
    if (stage.canvasState.status !== "ready" || !walkthroughs.walk || threads.length === 0 || announced.current) return;
    // The docs page reveals the frame on "ready": wait until the follow camera has framed the step and held still
    // for a few frames, so the first thing a reader sees is the step, not the opening framing panning to it.
    let cancelled = false;
    let still = 0;
    let frames = 0;
    const tick = () => {
      if (cancelled) return;
      const flow = document.querySelector(".react-flow[data-camera]");
      const settled =
        flow?.getAttribute("data-framed") === "true" &&
        flow.getAttribute("data-camera") === "idle" &&
        document.querySelector(".react-flow__node.archer-emph") !== null;
      still = settled ? still + 1 : 0;
      frames += 1;
      if (still < 8 && frames < 120) {
        requestAnimationFrame(tick);
        return;
      }
      announced.current = true;
      window.parent.postMessage({ type: "archer-playground-ready" }, window.location.origin);
    };
    requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [stage.canvasState.status, walkthroughs.walk, threads.length]);

  // The docs page's "Open full screen" follows the step shown here, so the full Playground opens on it.
  const shownWalk = walkthroughs.walk?.id;
  const shownStep = walkthroughs.state.step;
  useEffect(() => {
    if (!shownWalk) return;
    window.parent.postMessage(
      { type: "archer-playground-step", walkthrough: shownWalk, step: shownStep },
      window.location.origin,
    );
  }, [shownWalk, shownStep]);

  const openPin = (event: MouseEvent<HTMLElement>) => {
    const pin = (event.target as Element).closest<HTMLElement>("[data-pin-thread]");
    if (!pin) return;
    event.stopPropagation();
    returnPin.current = pin;
    setThreadOpen(pin.dataset.pinThread ?? null);
  };
  const change = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await refresh();
      return true;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The comment could not be saved. Try again.");
      return false;
    }
  };
  const thread = threads.find((thread) => thread.id === threadOpen);
  return (
    <main className="playground-scene">
      <header className="playground-scene-head">
        <h1>{title}</h1>
      </header>
      <p className="playground-scene-provenance">Example · Changes stay in this browser · No agent connected.</p>
      <div className="playground-scene-drawing" onClickCapture={openPin}>
        {failure ? (
          <p className="playground-scene-error" role="alert">
            {failure}
          </p>
        ) : null}
        <DiagramCanvas
          state={canvasState}
          selection={selection}
          emphasis={walkthroughs.render?.emphasis ?? null}
          commented={pins}
          cameraHandle={stage.cameraRef}
          walkCamera={follow.camera}
          nesting={gestures.canvasNesting}
          onNodeClick={gestures.handleNodeClick}
          onEdgeClick={gestures.handleEdgeClick}
          onElementPress={(channel, id) => {
            const ids = channel === "node" ? { nodeIds: [id], edgeIds: [] } : { nodeIds: [], edgeIds: [id] };
            if (!walkthroughs.jump(ids)) gestures.handleElementPress(channel, id);
          }}
          onPaneClick={gestures.handleClearSelection}
          onClearSelection={gestures.handleClearSelection}
          onMarqueeStart={gestures.handleMarqueeStart}
          onMarqueeEnd={gestures.handleMarqueeEnd}
          onMarqueeChange={gestures.handleMarqueeChange}
        />
        {thread ? (
          <section className="playground-scene-discussion" aria-label="Demo comment">
            <header>
              <h2>Demo Comment</h2>
              <button ref={closeControl} type="button" onClick={closeThread}>
                Close
              </button>
            </header>
            <ThreadCard
              thread={thread}
              scope="view"
              onReply={(body) =>
                change(() => transport.replyOnce(newOperation("comment.reply", target), thread.id, body))
              }
              onEdit={(id, body) => change(() => transport.edit(thread.id, id, body, thread.revision))}
              onDelete={(id) => change(() => transport.remove(thread.id, id))}
              onResolve={() => change(() => transport.resolve(thread.id))}
              onDismiss={() => change(() => transport.dismiss(thread.id))}
            />
          </section>
        ) : null}
      </div>
      <footer className="playground-scene-controls">
        <WalkthroughTransport walkthroughs={walkthroughs} />
        {walkthroughs.walk ? (
          <p className="playground-scene-explanation">{walkthroughs.walk.steps[walkthroughs.state.step - 1]?.what}</p>
        ) : null}
        <WalkLive walks={walkthroughs.walks} state={walkthroughs.state} labelOf={walkthroughs.labelOf} />
        <WalkModeKeys
          stepping={walkthroughs.walk !== null}
          onGo={(to) => walkthroughs.dispatch({ type: "go", to })}
          onTogglePlay={walkthroughs.togglePlay}
        />
      </footer>
    </main>
  );
}
