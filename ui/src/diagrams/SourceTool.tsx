/**
 * Source, in the canvas toolbar (decided 2026-10-25): the button that opens the Mermaid source panel
 * used to float in the page header, away from the diagram it describes. The page provides what it
 * does through `SourceToolContext`; the canvases wear the button in their own control cluster, and
 * `SourceToolbar` is the cluster for a page with no canvas (a diagram that failed to draw), so
 * Source stays reachable there too.
 */
import { createContext, useContext, useLayoutEffect, useRef, type JSX, type ReactNode } from "react";
import { CanvasTools } from "./CanvasTools";

export type SourceTool = { readonly open: boolean; readonly onToggle: () => void };
export const SourceToolContext = createContext<SourceTool | null>(null);

/**
 * Whether the Source button just removed had keyboard focus. While a diagram loads, Source is in the loading page's
 * own toolbar; the drawing's arrival moves it into the canvas' cluster, a new button in the same commit, and focus on
 * the old one (put there by a press, or by Close source, F48) would otherwise drop to the page (O55).
 */
let focusLeaving = false;

/** One cluster button. Absent where the page offers no Source (the MCP view, the editor, a note). */
export function SourceToolButton(): JSX.Element | null {
  const tool = useContext(SourceToolContext);
  const button = useRef<HTMLButtonElement>(null);
  const present = tool !== null;
  useLayoutEffect(() => {
    const own = button.current;
    if (own === null) return;
    if (focusLeaving && (document.activeElement === null || document.activeElement === document.body))
      own.focus({ preventScroll: true });
    focusLeaving = false;
    return () => {
      // Read before the node leaves the document; kept only for a button mounted in this same commit.
      if (document.activeElement !== own) return;
      focusLeaving = true;
      queueMicrotask(() => {
        focusLeaving = false;
      });
    };
  }, [present]);
  if (tool === null) return null;
  return (
    <button
      ref={button}
      type="button"
      className="react-flow__controls-button archer-source-tool nopan"
      aria-label="Source"
      aria-pressed={tool.open}
      title={tool.open ? "Hide the Mermaid source" : "Show the Mermaid source"}
      onClick={tool.onToggle}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
      </svg>
    </button>
  );
}

/**
 * A toolbar of its own, at the same corner, for a page whose canvas draws none (yet). `tools` are the canvas' tools:
 * their launcher sits under Source as in the canvas' cluster, so Source keeps its place when the drawing comes (O186).
 */
export function SourceToolbar({ tools }: { readonly tools?: ReactNode } = {}): JSX.Element | null {
  if (useContext(SourceToolContext) === null) return null;
  return (
    <div className="archer-canvas-controls" role="group" aria-label="Canvas controls">
      <SourceToolButton />
      {tools === undefined ? null : <CanvasTools>{tools}</CanvasTools>}
    </div>
  );
}
