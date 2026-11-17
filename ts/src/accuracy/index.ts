/** Neutral Git-backed accuracy APIs. No transport, browser, cache, or service startup. */
export { AccuracyError, type AccuracyErrorCode } from "./errors.ts";
export {
  coveragePatterns,
  coveredBy,
  coverageRoots,
  MAX_COVERAGE_PATTERNS,
  MAX_COVERAGE_PATH_CHARS,
} from "./coverage.ts";
export {
  listStaleDiagrams,
  type DiagramStaleness,
  type StaleStatus,
  type StaleDiagramsResult,
  type CoveredChange,
} from "./stale.ts";
export { readDiagramAtCommit, MAX_HISTORICAL_SOURCE_BYTES, type HistoricalDiagram } from "./history.ts";
export {
  compareDiagramCommits,
  compareModels,
  diffElements,
  type DiagramCommitComparison,
  type ModelComparison,
  type SemanticChange,
  type ElementChange,
} from "./compare.ts";
