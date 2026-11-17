import type { Emphasis } from "../service/emphasis.ts";
export type ExportMode = "diagram" | "presentation";
export type ExportTheme = "light" | "dark";
export interface ExportPresentation {
  readonly emphases?: readonly Emphasis[];
  readonly activeEmphasisId?: string | null;
  readonly annotation?: string;
  readonly diagramKey?: boolean;
  /** Draw each highlight group's number on its elements and a text key of its members (WCAG 1.4.1). */
  readonly accessible?: boolean;
}
export interface ExportPainterInput {
  readonly envelope: unknown;
  readonly mode: ExportMode;
  /** Complete project notice, when the caller requests a visible caption. */
  readonly noticeCaption?: string;
  readonly presentation?: ExportPresentation;
}
export interface ExportPainting {
  readonly content: string;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly title: string;
  /** The highlight groups in words, for the SVG's `<desc>`; absent without an emphasis. */
  readonly description?: string;
  readonly revision: string;
  readonly activeEmphasisId: string | null;
  /** The letter-spacing every label was measured with, in em per character: the drawing must be set with it. */
  readonly tracking: number;
}
