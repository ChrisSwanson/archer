/**
 * What the walkthrough adds on the canvas (ADR 0034 §3, slice 7b; the look is the approved prototype's):
 *
 * - a note while the current step is out of date ("Step 2 is out of date. Its line is no longer in this diagram.");
 * - the old version: the model a walkthrough was written for, drawn read-only over the live canvas in the
 *   same stage, tinted and marked "Old version · 12 Aug". No tools, no editing, no comments, no emphasis
 *   choices; the live canvas underneath keeps its place and its state, and is inert while covered.
 *
 * One module, loaded with the panel (`deferredComponent`); nothing here runs for a diagram with no walkthrough open.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { DiagramCanvas, type CanvasState } from "../diagrams/DiagramCanvas";
import type { LayoutResult } from "../layout/elk-layout";
import { computeBackgroundLayout } from "../layout/elk-worker-transport";
import { DEFAULT_TYPEFACE } from "../layout/text-measure";
import type { Walkthroughs } from "./use-walkthroughs";
import { canvasNote, oldMark } from "./walk-stale";
import "./walkthroughs.css";

function OldCanvas({ walkthroughs }: { readonly walkthroughs: Walkthroughs }): JSX.Element | null {
  const { old, oldView, oldRender } = walkthroughs;
  const [layout, setLayout] = useState<{ readonly of: unknown; readonly layout: LayoutResult } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (oldView === null) return;
    let cancelled = false;
    void computeBackgroundLayout(oldView, DEFAULT_TYPEFACE).then(
      (done) => {
        if (!cancelled) setLayout({ of: oldView, layout: done });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [oldView]);
  // Covered, the live canvas is not reachable by Tab or a screen reader.
  useEffect(() => {
    const covered = [...(host.current?.parentElement?.children ?? [])].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== host.current && !el.hasAttribute("inert"),
    );
    for (const el of covered) el.setAttribute("inert", "");
    return () => {
      for (const el of covered) el.removeAttribute("inert");
    };
  }, []);
  const focus = oldRender?.focus;
  const state = useMemo<CanvasState>(
    () =>
      layout === null || layout.of !== oldView
        ? { status: "loading" }
        : {
            status: "ready",
            layout: layout.layout,
            ...(focus === undefined ? {} : { focus }),
            viewport: { mode: "fit-all", key: 1 },
          },
    [layout, oldView, focus],
  );
  if (old.status !== "found") return null;
  return (
    <div ref={host} className="archer-walk-old" role="group" aria-label={oldMark(old.committedAt)}>
      <DiagramCanvas state={state} emphasis={oldRender?.emphasis ?? null} />
      <div className="archer-walk-old-mark">{oldMark(old.committedAt)}</div>
    </div>
  );
}

/** The walkthrough's part of the stage: nothing unless it has a note or an old version to show. */
export function WalkthroughStage({ walkthroughs }: { readonly walkthroughs: Walkthroughs }): JSX.Element | null {
  const { walk, state, oldView } = walkthroughs;
  const note = state.open && walk !== null ? canvasNote(walk, state.step) : null;
  if (!state.open || walk === null) return null;
  return (
    <>
      {oldView === null ? null : <OldCanvas walkthroughs={walkthroughs} />}
      {note === null ? null : (
        <p className="archer-walk-canvas-note">
          <b>{note.lead}</b> {note.rest}
        </p>
      )}
    </>
  );
}
