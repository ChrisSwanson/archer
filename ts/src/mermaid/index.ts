export { compile, type CompileOptions, type CompileResult } from "./compile.ts";
export {
  formatDiagnostic,
  MAX_REPORTED_DIAGNOSTICS,
  type Diagnostic,
  type DiagnosticFix,
  type Position,
  type Severity,
  type Span,
} from "./diagnostics.ts";
export { addMissingEdgeIds, type AddedEdgeId, type EdgeIdsAdded } from "./flowchart/edge-ids.ts";
