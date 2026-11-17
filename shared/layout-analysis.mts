/** Transport-neutral layout analysis contract. Geometry never enters schema-v2 models. */
export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type Size = { readonly width: number; readonly height: number };
export type Padding = { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
export type Overflow = { readonly side: "left" | "right" | "top" | "bottom"; readonly count: number };
export type ZoomRange = { readonly min: number; readonly max: number };
export type TypefaceId = "fira";
export const LAYOUT_ENGINE_VERSION = "archer-layout-1";
export const DESKTOP_PROFILE = "desktop-1025x896-gutter24";
export type AnalysisState = { readonly mode: "full" } | { readonly mode: "nested"; readonly open: readonly string[] };
export type AnalysisViewport = {
  readonly canvas: Size;
  readonly padding?: Padding;
  readonly basis?: "explicit" | "desktop-profile";
  readonly reserveLegend?: boolean;
  readonly reserveHeading?: boolean;
};
export type ResolvedAnalysisViewport = {
  readonly canvas: Size;
  readonly padding: Padding;
  readonly basis: "explicit" | "desktop-profile";
  readonly reserveLegend: boolean;
  readonly reserveHeading: boolean;
};
export type AnalysisOptions = {
  readonly states?: readonly AnalysisState[];
  readonly typeface?: TypefaceId;
  readonly includeGroups?: boolean;
  readonly viewport?: AnalysisViewport;
};
export type GeometryState = {
  readonly stateIndex: number;
  readonly mode: "full" | "nested";
  readonly open: readonly string[] | null;
  readonly route?: "canonical-fresh";
  readonly bounds: Box;
  readonly entry: Box | null;
  readonly across: readonly Box[];
  readonly down: readonly Box[];
  readonly groups: readonly ({ readonly id: string } & Box)[];
};
export type DiagramGeometry = {
  readonly engineVersion: string;
  readonly typeface: TypefaceId;
  readonly basis: "source-layout" | "static-export-board";
  readonly readingZoom: ZoomRange | null;
  readonly smallestTextPx: number | null;
  readonly states: readonly GeometryState[];
  readonly limitations: readonly string[];
};
export type MeasuredState = {
  readonly stateIndex: number;
  readonly mode: "full" | "nested";
  readonly open: readonly string[] | null;
  readonly route?: "canonical-fresh";
  readonly bounds: Box;
  readonly aspectRatio: number;
  readonly spanScreens: { readonly x: number; readonly y: number } | null;
  readonly panScreensBeyondFirst: { readonly x: number; readonly y: number } | null;
  readonly fitZoom: number | null;
  readonly minimumTextPxAtFit: number | null;
  readonly overflowAtAutomaticFrame: readonly Overflow[] | null;
  readonly groups: readonly ({ readonly id: string } & Box)[];
};
export type LayoutSuggestion = {
  readonly code: "layout_wide_at_reading_zoom" | "layout_two_axis_navigation";
  readonly level: "suggestion";
  readonly stateIndex: number;
  readonly message: string;
};
export type AnalysisResult = {
  readonly engineVersion: string;
  readonly typeface: TypefaceId;
  readonly basis: "source-layout" | "static-export-board";
  readonly readingZoom: ZoomRange | null;
  readonly viewport: ResolvedAnalysisViewport;
  readonly states: readonly MeasuredState[];
  readonly suggestions: readonly LayoutSuggestion[];
  /** Information about fit text; does not recommend recomposition or affect suggestions. */
  readonly notes?: readonly LayoutNote[];
  readonly limitations: readonly string[];
};
export type LayoutNote = {
  readonly code: "text_below_reading_floor_at_fit";
  readonly level: "info";
  readonly stateIndex: number;
  readonly message: string;
};
