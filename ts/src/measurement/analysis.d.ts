declare module "@archer/layout-analysis" {
  export function analysisStates(
    envelope: unknown,
    states?: readonly import("../../../shared/layout-analysis.mts").AnalysisState[],
  ): readonly import("../../../shared/layout-analysis.mts").AnalysisState[];
  export function computeDiagramGeometry(
    envelope: unknown,
    options?: Omit<import("../../../shared/layout-analysis.mts").AnalysisOptions, "viewport">,
  ): Promise<import("../../../shared/layout-analysis.mts").DiagramGeometry>;
  export function frameDiagramGeometry(
    geometry: import("../../../shared/layout-analysis.mts").DiagramGeometry,
    viewport?: import("../../../shared/layout-analysis.mts").AnalysisViewport,
  ): import("../../../shared/layout-analysis.mts").AnalysisResult;
}
