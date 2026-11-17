export type AccuracyErrorCode =
  | "invalid_coverage"
  | "invalid_git_ref"
  | "git_unavailable"
  | "accuracy_limit"
  | "accuracy_path_refused"
  | "historical_view_unavailable"
  | "historical_source_unavailable";
export class AccuracyError extends Error {
  override name = "AccuracyError";
  constructor(
    readonly code: AccuracyErrorCode,
    message: string,
  ) {
    super(message);
  }
}
