type AnalysisModule = typeof import("@archer/layout-analysis");
let analysis: Promise<AnalysisModule> | undefined;
/** The Node bundle and the browser build resolve one owned geometry implementation. */
export function loadAnalysis(): Promise<AnalysisModule> {
  analysis ??= (async () => {
    try {
      return await import("@archer/layout-analysis");
    } catch (failure) {
      const missing = failure as { code?: string; message?: string };
      if (
        !import.meta.url.endsWith("/ts/src/measurement/load.ts") ||
        missing.code !== "ERR_MODULE_NOT_FOUND" ||
        !missing.message?.includes("@archer/layout-analysis")
      )
        throw failure;
      return (await import(new URL("../../../ui/src/layout/analysis.ts", import.meta.url).href)) as AnalysisModule;
    }
  })().catch((error) => {
    analysis = undefined;
    throw error;
  });
  return analysis;
}
