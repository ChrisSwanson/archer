/**
 * What a canvas inside a stage with a diagram side panel (`diagram-panel.tsx`) needs from it: where the
 * Highlights legend goes (the panel's top section, or nowhere while that section is not on screen), how
 * to put the highlights away, and, in the phone's sheet, how to close the sheet before the legend takes
 * the reader to a member on the drawing. A canvas outside such a stage (the editor, the cheat sheet) gets
 * `null` and draws its legend in place. Its own module, so the emphasis surface does not load the panel.
 */
import { createContext } from "react";

export type PanelSlot = {
  /** The element the legend renders into; `null` while the panel is collapsed or not on Highlights. */
  readonly host: HTMLElement | null;
  /** Leaves Highlights for Explore (the agent's highlights stay listed). */
  readonly hide: () => void;
  /** Closes the phone's sheet; `null` beside the drawing. */
  readonly closeSheet: (() => void) | null;
};

export const DiagramPanelContext = createContext<PanelSlot | null>(null);

/**
 * Which part of a mode's surface the side panel is rendering: `"panel"`, the section on screen in the panel or the
 * phone's sheet, which comes and goes as the panel collapses or the sheet folds; `"mode"`, what lasts as long as the
 * mode does wherever the panel is (a walkthrough's step keys and its one spoken step). `null` outside a side panel:
 * a surface renders both, as one piece.
 */
export type PanelPart = "panel" | "mode";
export const DiagramPanelPart = createContext<PanelPart | null>(null);
