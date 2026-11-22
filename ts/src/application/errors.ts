// Stable Archer refusal codes and messages, shared by all operation adapters.
import { accessRefusalIn } from "../service/access-fix.ts";
// Numeric classifications preserve the existing external error contract.
/** A domain refusal independent of the transport carrying it. */
export class OperationError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OperationError";
  }
}

const CALLER = -32602; // invalid params
const NOT_FOUND = -32002; // resource not found
const SERVER = -32603; // internal error

export const ERROR_CODES = {
  invalid_coverage: CALLER,
  invalid_git_ref: CALLER,
  git_unavailable: CALLER,
  accuracy_limit: CALLER,
  accuracy_path_refused: CALLER,
  historical_view_unavailable: NOT_FOUND,
  historical_source_unavailable: NOT_FOUND,
  export_input_limit: CALLER,
  export_invalid_input: CALLER,
  export_options_invalid: CALLER,
  export_notice_invalid: CALLER,
  export_notice_caption_limit: CALLER,
  export_theme_invalid: SERVER,
  export_resources_missing: SERVER,
  export_presentation_invalid: CALLER,
  export_invalid_envelope: CALLER,
  export_last_good_requires_opt_in: CALLER,
  export_extent_limit: CALLER,
  export_failed: SERVER,
  invalid_configuration: CALLER,
  invalid_saved_state: CALLER,
  saved_state_io: SERVER,
  saved_state_capacity: CALLER,
  invalid_arguments: CALLER,
  unknown_tool: CALLER,
  invalid_request: CALLER,
  diagram_not_found: NOT_FOUND,
  // The view exists, but its source has never compiled (read_diagram says why). Like a missing view it has
  // no drawing to give, so MCP clients see the same not-found number; the code string tells them apart.
  diagram_not_compiled: NOT_FOUND,
  resource_not_found: NOT_FOUND,
  revision_conflict: CALLER,
  invalid_source: CALLER,
  source_too_large: CALLER,
  // A docs-mode write past the cap of the pack file it lands in (docs/proposals/doc-pack.md, ADR 0033).
  doc_over_cap: CALLER,
  duplicate_view_id: CALLER,
  duplicate_source_path: CALLER,
  // Rust's `path_outside_workspace`, for the Archer folder (ticket 09).
  path_outside_archer_folder: CALLER,
  too_many_views: CALLER,
  presentation_not_found: CALLER,
  invalid_selection: CALLER,
  invalid_emphasis: CALLER,
  /** present_diagram's expand (ADR 0036 A11): every bad entry, the call refused whole. */
  invalid_expand: CALLER,
  // Walkthroughs (ts/src/walkthroughs/store.ts, ADR 0034): `data.issues`, or `data.walkthrough` as it is now.
  invalid_walkthrough: CALLER,
  walkthrough_changed: CALLER,
  malformed_walkthroughs_file: CALLER,
  walkthroughs_file_conflict: CALLER,
  // archer.toml cannot be read, or is not to be trusted: the project's own problem.
  manifest_error: CALLER,
  untrusted_manifest: CALLER,
  // Comments (ts/src/comments/store.ts).
  thread_not_found: NOT_FOUND,
  thread_not_awaiting: CALLER,
  // The person changed the thread since the agent read it; `data` carries it as it is now.
  thread_changed: CALLER,
  malformed_comments_file: CALLER,
  comments_file_too_large: CALLER,
  write_conflict: CALLER,
  too_many_projects: CALLER,
  // The account's admission (ADR 0013) does not admit this project: `admit = false`, or `listed` without an entry.
  project_not_admitted: CALLER,
  project_not_attached: NOT_FOUND,
  service_stopping: SERVER,
  io_failure: SERVER,
  // ADR 0031: which running copy to use is the person's choice; `data` lists the copies and options.
  instance_choice_needed: CALLER,
  // The account's [[projects]] write rules refuse this write (ADR 0028).
  write_rule_denied: CALLER,
  // A write under a folder another account can change, where no descriptor filesystem is verified (known-limits §1).
  shared_folder: CALLER,
  // The project has no archer.toml to write; `archer init` makes one (ADR 0028).
  no_manifest: CALLER,
  // Access and TLS (ts/src/service/access-fix.ts): `data.fix` names the tool or command, and whether the person's yes is needed.
  tls_required: CALLER,
  tls_invalid: CALLER,
  openssl_missing: CALLER,
  network_host_unknown: CALLER,
  network_setup_blocked: CALLER,
  person_confirmation_needed: CALLER,
  person_declined: CALLER,
  internal: SERVER,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Keep domain messages intact; transport adapters choose their wire error representation. */
function plain(code: number, message: string, data: Record<string, unknown>): OperationError {
  return new OperationError(code, message, data);
}

export function toolError(code: ErrorCode, message: string, data: Record<string, unknown> = {}): OperationError {
  return plain(ERROR_CODES[code], message, { ...data, code });
}

/** An error code the service sent, kept when it is one of ours and classed as ours. */
export function serviceError(code: string, message: string, details: Record<string, unknown> = {}): OperationError {
  const known = Object.hasOwn(ERROR_CODES, code);
  if (known) return plain(ERROR_CODES[code as ErrorCode], message, { ...details, code });
  return plain(SERVER, message, { ...details, code: "internal", serviceCode: code });
}

/** At most this many characters of a caller's value are quoted back. */
export const MAX_ECHO = 32;

export function quoted(text: string): string {
  const chars = [...text];
  return JSON.stringify(chars.length > MAX_ECHO ? `${chars.slice(0, MAX_ECHO).join("")}…` : text);
}

/**
 * A service that would not start for an access or TLS reason (its log carries "[code] Fix: …"): the
 * refusal with its stable code and the fix the agent can act on. Null for any other failure.
 */
export function accessStartFailure(tool: string, error: unknown): OperationError | null {
  if (!(error instanceof Error)) return null;
  const found = accessRefusalIn(error.message);
  if (found === null) return null;
  const line =
    error.message
      .split("\n")
      .find((l) => l.includes(`[${found.code}]`))
      ?.replace(/^archer:\s*/, "") ?? error.message;
  return toolError(found.code, `${tool} could not start Archer: ${line}`, { fix: found.fix });
}
