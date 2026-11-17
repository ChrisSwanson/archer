/**
 * The MCP-App view: the diagram the agent presents, edge to edge, with no chrome. The host window is
 * the frame, so anything added here would be a frame inside a frame. The theme toggle is a floating
 * button positioned by its own class, because it is the only control the embedded view has.
 *
 * It shares the diagram stage with the browser-served page (`diagram-stage.ts`) and none of that
 * page's project around it: no inventory, notes, comments or walkthroughs reach a host, so the page's
 * entry (`main.tsx`) mounts this shell there and the MCP build carries nothing else.
 *
 * The shell element IS the `main` landmark: with no chrome, everything this view draws is its main
 * content, and a landmark costs no box.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type JSX } from "react";
import { DiagramCanvas, type CanvasState } from "../diagrams/DiagramCanvas";
import { keyOfDrawing } from "../diagrams/DiagramKey";
import { DiagramSidePanel } from "./diagram-panel";
import { useDiagramModes } from "./diagram-mode";
import { CompileNoticeContext } from "../diagrams/notice-context";
import type { EmphasisSnapshot } from "../emphasis/contract";
import { activeEmphasis, emphasisReducer, initialEmphasisState } from "../emphasis/state";
import { DEFAULT_TYPEFACE } from "../layout/text-measure";
import { drawnIds, nestEmphasis, type NestMode } from "../nesting/nest-page";
import { NestModeButton } from "../nesting/NestModeButton";
import { buildSelectionContext } from "../selection/bridge";
import { CAPTION_ID, Caption, captionText } from "./Caption";
import { CompileNotice } from "./CompileNotice";
import { applyCompileStatus, failureFor, type CompileFailure } from "./compile-status";
import {
  hasDrawing as stageHasDrawing,
  selectEverything,
  selectionDetails,
  useDrawnSelection,
  useStage,
  useStageGestures,
  useStageLayout,
  type PresentMessage,
} from "./diagram-stage";
import { HelpOverlay, HelpProvider, type HelpView } from "./HelpOverlay";
import { connectBridge, type Bridge } from "./host-bridge";
import { PageNotice, StaleConnectionNotice } from "./PageNotice";
import { pageNotice, type ConnectionStatus } from "./page-state";
import { useShellHelp, useShellShortcuts } from "./shell-help";
import { isTypingTarget, useWindowKeydown } from "./shortcuts";
import { StageDockContext, StageDockStrip } from "./stage-dock";
import { ThemeToggle } from "./ThemeToggle";

const NO_VIEWS: readonly never[] = [];

export function McpApp(): JSX.Element {
  const stage = useStage();
  const { presentation, selection, canvasState, drawnKeyModel, drawnNest, projectedRef, nestRef, present, reset } =
    stage;
  // What the agent has pointed at, and which of those the canvas is drawing (`emphasis/state.ts`).
  const [emphasis, dispatchEmphasis] = useReducer(emphasisReducer, undefined, initialEmphasisState);
  // The stage's dock strip, where a phone's legend and key go (`stage-dock.tsx`).
  const [dockHost, setDockHost] = useState<HTMLElement | null>(null);
  const stageDock = useMemo(() => ({ host: dockHost }), [dockHost]);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  // Whether the host has said anything at all yet: before its first answer the page is loading, not empty.
  const [heardFromHost, setHeardFromHost] = useState(false);
  // Which views do not compile right now (ADR 0010); here it rides the `compile` key of a tool result.
  const [compileFailures, setCompileFailures] = useState<readonly CompileFailure[]>([]);
  const help = useShellHelp();
  const { open: helpOpen, hide: hideHelp } = help;
  const typeface = DEFAULT_TYPEFACE;
  // A host names no project settings, so the nested view is on (ADR 0029).
  const nestedViewAllowed = true;
  const bridgeRef = useRef<Bridge | null>(null);

  // Every presentation is the agent's: there are no tabs of the reader's own in a host.
  // This page draws the base view only: an exploration the agent presented is said as a line (ADR 0036 A11).
  const [explored, setExplored] = useState<{ readonly parts: number; readonly url?: string } | null>(null);
  const handlePresent = useCallback(
    (msg: PresentMessage) => {
      setHeardFromHost(true);
      const stamp = (msg.presentation as { exploration?: { parts?: unknown } } | null)?.exploration;
      setExplored(
        typeof stamp === "object" && stamp !== null && Number.isSafeInteger(stamp.parts) && Number(stamp.parts) > 0
          ? { parts: Number(stamp.parts), ...(msg.pageUrl === undefined ? {} : { url: msg.pageUrl }) }
          : null,
      );
      present(msg);
    },
    [present],
  );
  const handleClear = useCallback(() => {
    setHeardFromHost(true);
    setExplored(null);
    reset();
  }, [reset]);
  // The last snapshot a tool result carried. present_diagram's emphasis arrives with the page turn,
  // before the store has turned to that view, so the turn publishes it.
  const lastEmphasisRef = useRef<EmphasisSnapshot | null>(null);
  const handleEmphasis = useCallback((snapshot: EmphasisSnapshot) => {
    lastEmphasisRef.current = snapshot;
    dispatchEmphasis({ type: "publish", snapshot });
  }, []);
  const handleCompileStatus = useCallback((failures: CompileFailure[]) => {
    setCompileFailures((held) => applyCompileStatus(held, failures));
  }, []);

  useEffect(() => {
    const bridge = connectBridge({
      onPresent: handlePresent,
      onClear: handleClear,
      onConnection: setConnection,
      onEmphasis: handleEmphasis,
      onCompileStatus: handleCompileStatus,
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.disconnect();
      bridgeRef.current = null;
    };
  }, [handlePresent, handleClear, handleEmphasis, handleCompileStatus]);

  // Emphasis follows the view. A host has no route to read it from: it arrives in `set_emphasis`'s or
  // `present_diagram`'s own tool result, and nothing carries over from the previous view.
  const presentedViewId = presentation === null ? null : presentation.viewId;
  useEffect(() => {
    dispatchEmphasis({ type: "view_change", viewId: presentedViewId });
    const held = lastEmphasisRef.current;
    if (presentedViewId !== null && held?.viewId === presentedViewId)
      dispatchEmphasis({ type: "publish", snapshot: held });
  }, [presentedViewId]);

  useStageLayout(stage, typeface, nestedViewAllowed);

  // The reader's selection is published stamped with the view, its revision and the agent's
  // presentation. A page turn the agent caused publishes nothing: the server retired the selection.
  useEffect(() => {
    if (selection === null || selection.selectionRevision === 0) return;
    const projected = projectedRef.current;
    if (projected === null || projected.view.viewId !== selection.viewId) return;
    const { nodeDetails, edgeDetails } = selectionDetails(projected);
    bridgeRef.current?.setSelection(buildSelectionContext(selection, nodeDetails, edgeDetails));
  }, [selection, projectedRef]);

  const {
    handleMarqueeChange,
    handleNodeClick,
    handleEdgeClick,
    handleElementPress,
    handleMarqueeStart,
    handleMarqueeEnd,
    handleClearSelection,
    handleNestMode,
    canvasNesting,
  } = useStageGestures(stage, { typeface });

  const hasSelection =
    selection !== null && (selection.selectedNodeIds.length > 0 || selection.selectedEdgeIds.length > 0);
  const hasDrawing = stageHasDrawing(canvasState);
  // What the page can honestly say right now. A notice REPLACES the canvas (`page-state.ts`).
  const notice = pageNotice({
    mode: "mcp",
    connection,
    heardFromHost,
    bootstrapFailed: false,
    inventory: "unknown",
    views: NO_VIEWS,
    presentedViewId,
    hasDrawing,
    hasCanvasError: canvasState.status === "error",
    presentedWasRegistered: false,
    pickedViewNeverCompiled: false,
  });

  /*
   * ESC IS LAYERED. The shared Help owner consumes Escape while the cheat sheet is up. Below it, one
   * press dismisses the agent's emphasis and clears the selection, as the cheat sheet promises.
   */
  useShellShortcuts(help);
  useWindowKeydown((event) => {
    if (isTypingTarget(event.target)) return;
    if (event.key === "Escape") {
      if (helpOpen) return;
      // Esc with nothing to dismiss stays unhandled, so it keeps whatever meaning the host window gives it.
      let dismissed = false;
      const drawn = activeEmphasis(emphasis);
      if (drawn !== null) {
        dispatchEmphasis({ type: "select", id: drawn.id });
        dismissed = true;
      }
      // Only what is on screen can be cleared: under a notice the canvas is gone.
      if (hasSelection && notice === null) {
        handleClearSelection();
        dismissed = true;
      }
      if (dismissed) event.preventDefault();
      return;
    }
    if ((event.key === "a" || event.key === "A") && (event.metaKey || event.ctrlKey)) {
      // Not under the cheat sheet (it promises the selection is untouched), nor over a notice.
      if (helpOpen || notice !== null) return;
      if (selectEverything(stage)) event.preventDefault();
    }
  });

  const drawnSelection = useDrawnSelection(selection, drawnNest);
  const shownEmphasis = activeEmphasis(emphasis);
  const drawnEmphasis = useMemo(
    () => (drawnNest === null ? shownEmphasis : nestEmphasis(shownEmphasis, drawnNest.nested, drawnNest.full)),
    [drawnNest, shownEmphasis],
  );
  const drawnCanvasState = useMemo<CanvasState>(
    () =>
      drawnNest === null || canvasState.status !== "ready"
        ? canvasState
        : { ...canvasState, focus: drawnIds(drawnNest.nested, drawnNest.full, canvasState.focus ?? {}) },
    [drawnNest, canvasState],
  );
  const nestModeShown =
    nestedViewAllowed &&
    canvasState.status === "ready" &&
    drawnKeyModel?.type === "graph" &&
    drawnKeyModel.view.groups.length > 0;
  // The switch says what is DRAWN: until a press's new layout is on screen the old one is, so it says it is busy.
  const drawnNestMode: NestMode = drawnNest === null ? "full" : "nested";
  const nestToggle = nestModeShown ? (
    <NestModeButton mode={drawnNestMode} busy={drawnNestMode !== nestRef.current.mode} onChange={handleNestMode} />
  ) : null;

  const canvas =
    notice !== null ? (
      <PageNotice notice={notice} />
    ) : (
      <DiagramCanvas
        key={presentedViewId ?? "empty"}
        state={drawnCanvasState}
        selection={drawnSelection}
        emphasis={drawnEmphasis}
        {...(canvasNesting === undefined ? {} : { nesting: canvasNesting })}
        {...(nestToggle === null ? {} : { controls: nestToggle })}
        reserveLegendRoom={emphasis.emphases.length > 0}
        hasSelection={hasSelection}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onElementPress={handleElementPress}
        onPaneClick={handleClearSelection}
        onClearSelection={handleClearSelection}
        onMarqueeStart={handleMarqueeStart}
        onMarqueeEnd={handleMarqueeEnd}
        onMarqueeChange={handleMarqueeChange}
      />
    );

  // Which gestures the cheat sheet lists: the canvas actually mounted, or none under a notice.
  const helpView: HelpView =
    notice !== null || !hasDrawing
      ? "none"
      : canvasState.status === "sequence-ready"
        ? "sequence"
        : canvasState.status === "journey-ready"
          ? "journey"
          : "graph";

  // Shown next to a diagram that is still up but may no longer be current.
  const staleStrip =
    (connection === "lost" ||
      connection === "unsynced" ||
      connection === "incompatible" ||
      connection === "access-required") &&
    notice === null ? (
      <StaleConnectionNotice status={connection} />
    ) : null;
  // Over a drawing whose file no longer compiles (ADR 0010): the drawing is the last version that did.
  const failure =
    notice === null && hasDrawing && presentation !== null
      ? failureFor(compileFailures, presentation.viewId)
      : undefined;
  const compileNotice = failure === undefined ? null : <CompileNotice key={failure.viewId} failure={failure} />;
  // The agent's caption for the view it presents (`Caption.tsx`); not under a notice.
  const caption = notice === null && presentation !== null ? captionText(presentation.annotation) : null;
  const describedBy = caption === null ? undefined : CAPTION_ID;
  // The key of what is on screen: in the nested view a closed boundary's insides are not drawn.
  const keyModel =
    hasDrawing && notice === null && drawnKeyModel !== null
      ? keyOfDrawing(drawnKeyModel, drawnNest?.nested.view ?? null)
      : null;
  const legendUp = (activeEmphasis(emphasis)?.groups.length ?? 0) > 0;
  // The diagram mode (D1): a host has no walkthroughs, so Explore or Highlights; neither changes the view, so none is saved.
  const modes = useDiagramModes({
    walkthrough: null,
    highlights: {
      activeId: activeEmphasis(emphasis)?.id ?? null,
      // Only offered under a walkthrough, and a host has none.
      revision: null,
      show: () => {
        const newest = emphasis.emphases.at(-1);
        if (newest !== undefined) dispatchEmphasis({ type: "select", id: newest.id });
      },
      hide: () => {
        const active = activeEmphasis(emphasis);
        if (active !== null) dispatchEmphasis({ type: "select", id: active.id });
      },
    },
    edit: { on: false },
    view: { read: () => null, restore: () => undefined, framing: 0 },
    selection: null,
  });

  return (
    <HelpProvider value={help}>
      <main className="archer-mcp-shell" style={{ width: "100vw", height: "100vh" }}>
        {/* The page's one heading, for a screen reader: the host's frame shows no title of its own (R5-claude-02). */}
        <h1 className="archer-visually-hidden">
          {drawnKeyModel === null ? "Archer Diagram" : `${drawnKeyModel.view.title}, Archer Diagram`}
        </h1>
        {/* Owns theme resolution (see `useTheme`): exactly one mounted component may, and here it is this one. */}
        <ThemeToggle />
        {staleStrip}
        {compileNotice}
        {/* The canvas takes what the caption leaves: the shell is a column, and everything above floats over it. */}
        <div className="archer-mcp-stage" aria-describedby={describedBy}>
          <StageDockContext.Provider value={stageDock}>
            {/* The side panel both shells share (0.6.4, D5): Highlights and the Diagram key, right of the drawing. */}
            <DiagramSidePanel
              modes={modes}
              switcher={{
                highlights: () => {
                  if (modes.mode === "highlights") modes.exit("switch");
                  else modes.enter("highlights");
                },
                walkthroughs: () => undefined,
              }}
              walks={[]}
              highlightCount={notice === null ? emphasis.emphases.length : 0}
              walkthrough={null}
              keyModel={keyModel}
              omitLinePatterns={keyModel?.type === "graph" && legendUp}
            >
              <div className="archer-diagram-content">
                <CompileNoticeContext.Provider value={compileNotice !== null}>{canvas}</CompileNoticeContext.Provider>
              </div>
            </DiagramSidePanel>
          </StageDockContext.Provider>
          <StageDockStrip onHost={setDockHost} />
        </div>
        {explored === null || notice !== null ? null : (
          <p className="archer-mcp-explored" role="status">
            {explored.parts} {explored.parts === 1 ? "part" : "parts"} added:{" "}
            {explored.url === undefined ? (
              "open in Archer"
            ) : (
              <a href={explored.url} target="_blank" rel="noreferrer">
                open in Archer
              </a>
            )}
          </p>
        )}
        <Caption text={caption} />
        <HelpOverlay open={helpOpen} onClose={hideHelp} view={helpView} extra={[]} />
      </main>
    </HelpProvider>
  );
}
