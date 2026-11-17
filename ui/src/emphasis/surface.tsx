/**
 * The emphasis channel, as any canvas wears it.
 *
 * Emphasis has two pieces of state a drawing must not own: which groups the
 * reader has on (One / All, local to the reader), and whether motion is
 * allowed (the viewer's, and it can change mid-session). The graph, sequence
 * and journey canvases draw emphasis differently and must agree about both, so
 * all take them from here -- with the legend and the surface classes the
 * stylesheet keys off -- rather than each keeping a copy that can drift.
 *
 * What a canvas adds is only its own drawing: `render` says what each id
 * should look like, and `className` goes on whatever element wraps it. A group
 * the reader has turned off is simply not drawn; nothing is dimmed (ADR 0030).
 */
import { useContext, useEffect, useMemo, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import {
  EMPHASIS_STATIC_CLASS,
  assignEmphasis,
  sharedParts,
  type Emphasis,
  type EmphasisAssignments,
  type EmphasisNotation,
} from "./contract";
import { EmphasisLegend, type LegendKeyRow, type MemberChannel } from "./EmphasisLegend";
import { EMPHASIS_NUMBERED_CLASS, useGroupNumbers } from "./group-numbers";
import { DockSheetClose } from "../app/stage-dock";
import { DiagramPanelContext } from "../app/panel-context";
import { reconcile, setMode, toggleRow, type LegendMode, type LegendState } from "./legend-state";
import { useReducedMotion } from "./reduced-motion";

/** The class every emphasis surface carries; reduced motion adds to it. */
export const EMPHASIS_SURFACE_CLASS = "archer-emph-surface";

/** Kept for the canvases' render contract: the reader no longer isolates by dimming. */
export type EmphasisIsolation = {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
};

export type EmphasisSurface = {
  /** What to draw: per-id assignments for the groups the reader has on. */
  readonly render: {
    readonly assignments: EmphasisAssignments;
    readonly isolated: EmphasisIsolation | null;
    /** Whether each emphasised element carries its group's number (the reader's Group numbers). */
    readonly numbered: boolean;
  };
  /** Whether a legend is up. */
  readonly hasLegend: boolean;
  /** Whether the legend sits in the stage's side panel (or the phone's sheet), not over the canvas: a fit need not dodge it. */
  readonly docked: boolean;
  /** For the element that wraps the drawing and the legend. */
  readonly className: string;
  /** The legend, to render inside that element: portalled into the side panel when the stage has one; `null` when nothing is up. */
  readonly legend: JSX.Element | null;
};

export type EmphasisSurfaceOptions = {
  /** What the reader calls an element, for the note naming shared parts. Defaults to its id. */
  readonly nameOf?: (id: string, channel: "nodes" | "edges") => string;
  /**
   * The element an id is drawn as: the identity on a full view; at a zoom
   * level, the closed boundary or bundle that stands for a hidden id, so two
   * groups meeting on it count as sharing it.
   */
  readonly representativeOf?: (id: string, channel: "nodes" | "edges") => string;
  /** The line patterns visible in this view and what their author says they mean (the legend's Key). */
  readonly keyRows?: readonly LegendKeyRow[];
  /** Take the reader to a member the legend lists: focus it, and bring it on screen. */
  readonly onReveal?: (id: string, channel: MemberChannel) => void;
  /** The drawing is in family colours (`palette.ts`): Auto numbers the groups (ADR 0030, amended 2026-11-11). */
  readonly familyColours?: boolean;
};

export function useEmphasisSurface(
  value: Emphasis | null | undefined,
  notation: EmphasisNotation,
  options: EmphasisSurfaceOptions = {},
): EmphasisSurface {
  const emphasis = value ?? null;
  const reducedMotion = useReducedMotion();
  const { nameOf, representativeOf, keyRows, onReveal, familyColours = false } = options;
  const { numbered } = useGroupNumbers(familyColours);

  const shared = useMemo(() => sharedParts(emphasis, representativeOf), [emphasis, representativeOf]);
  const overlapping = shared.nodes.length + shared.edges.length > 0;
  const [stored, setStored] = useState<LegendState | null>(null);
  // Derived every render, so a republish or a new emphasis is reconciled in
  // the same paint it arrives in, with no effect to lag behind it.
  const state = useMemo(() => reconcile(stored, emphasis, overlapping), [stored, emphasis, overlapping]);
  // ...and kept, so the next republish is reconciled against what the reader
  // actually saw, not against a choice an earlier republish already overrode.
  useEffect(() => {
    if (
      stored === null ||
      stored.key !== state.key ||
      stored.mode !== state.mode ||
      stored.on.join("\0") !== state.on.join("\0")
    )
      setStored(state);
  }, [state, stored]);

  const shown = useMemo(() => {
    if (emphasis === null) return null;
    // A walkthrough's own emphasis has no legend to turn groups off in: every group is drawn, and a part in
    // two of them (a line a later step uses again) keeps the first group's treatment, the current step's.
    if (emphasis.legend === false) return emphasis;
    // Filtering keeps each group's own slot colour: it was fixed by position when parsed.
    return { ...emphasis, groups: emphasis.groups.filter((group) => state.on.includes(group.id)) };
  }, [emphasis, state.on]);
  const assignments = useMemo(() => assignEmphasis(shown), [shown]);
  // A walkthrough's own emphasis (`legend: false`) is keyed by the walkthrough panel.
  const hasLegend = emphasis !== null && emphasis.legend !== false && emphasis.groups.length > 0;
  // Numbers on elements are the legend rows' numbers: with no legend nothing says what they mean.
  const render = useMemo(
    () => ({ assignments, isolated: null, numbered: numbered && hasLegend }),
    [assignments, numbered, hasLegend],
  );
  const panel = useContext(DiagramPanelContext);
  const className = [
    EMPHASIS_SURFACE_CLASS,
    ...(reducedMotion ? [EMPHASIS_STATIC_CLASS] : []),
    ...(numbered && hasLegend ? [EMPHASIS_NUMBERED_CLASS] : []),
  ].join(" ");

  const sharedNames = useMemo(() => {
    const name = nameOf ?? ((id: string) => id);
    return [...shared.nodes.map((id) => name(id, "nodes")), ...shared.edges.map((id) => name(id, "edges"))];
  }, [shared, nameOf]);

  const legend = hasLegend ? (
    <EmphasisLegend
      emphasis={emphasis}
      notation={notation}
      mode={state.mode}
      on={state.on}
      allowAll={!overlapping}
      shared={sharedNames}
      keyRows={keyRows ?? []}
      {...(nameOf === undefined ? {} : { nameOf })}
      {...(onReveal === undefined ? {} : { onReveal })}
      onToggle={(id) => setStored(toggleRow(state, emphasis, id))}
      onMode={(mode: LegendMode) => setStored(setMode(state, emphasis, mode, overlapping))}
      {...(panel === null ? {} : { onHide: panel.hide })}
    />
  ) : null;

  return {
    render,
    hasLegend,
    docked: panel !== null,
    className,
    // In a stage with a side panel the legend is that panel's Highlights section (0.6.4, D5); nothing floats over the drawing.
    legend:
      legend === null || panel === null
        ? legend
        : panel.host === null
          ? null
          : createPortal(
              <DockSheetClose.Provider value={panel.closeSheet}>{legend}</DockSheetClose.Provider>,
              panel.host,
            ),
  };
}
