/** Browser-only authoring admission; semantic operations remain service-owned. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { browserAccess, type BrowserAuthority } from "./browser-access.ts";
import { activeTelemetry, currentRequest, phaseEnd, phaseStart } from "../telemetry/index.ts";
import { closeAfterRefusal, readCapped, TOO_LARGE } from "./http.ts";
export type AuthoringAction =
  | "status"
  | "mutate"
  | "open"
  | "snapshot"
  | "preview"
  | "edit"
  | "operation"
  | "presentation";
export interface AuthoringAdmission {
  readonly root: string;
  /** Revalidates the base grant and exact project entitlement at each effect boundary. */
  readonly authority: () => { grantId: string; entitlementId: string };
}
export interface AuthoringHttpBackend {
  readonly entitlement: (grantId: string, root: string) => { entitlementId: string } | null;
  readonly request: (admission: AuthoringAdmission, action: AuthoringAction, input: unknown) => Promise<unknown>;
}
export const MAX_AUTHORING_HTTP_BYTES = 1024 * 1024;
/** The journal's attribution for the owner's own browser: no grant, so no grant id (grant ids are UUIDs). */
export const OWNER_AUTHORITY: { readonly grantId: string; readonly entitlementId: string } = Object.freeze({
  grantId: "owner",
  entitlementId: "owner",
});
export async function handleAuthoringHttp(
  authority: BrowserAuthority | undefined,
  backend: AuthoringHttpBackend,
  root: string,
  action: AuthoringAction,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const telemetry = activeTelemetry(),
    started = telemetry === null ? 0 : performance.now();
  /** Development telemetry: why the entitlement check failed (never a credential). */
  let forbidden = "";
  const send = (status: number, body: unknown): void => {
    if (telemetry !== null) {
      const code =
        status === 200
          ? forbidden === ""
            ? null
            : "authoring_forbidden"
          : ((body as { error?: { code?: string } }).error?.code ?? "unknown");
      telemetry.authoring(
        action,
        code,
        status,
        performance.now() - started,
        forbidden === "" ? undefined : { reason: forbidden },
        currentRequest()?.id,
      );
    }
    const encoding = phaseStart();
    const serialized = JSON.stringify(body);
    phaseEnd("encode", encoding);
    res
      .writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      })
      .end(serialized);
  };
  const deny = (): never => {
    throw Object.assign(new Error("browser authoring permission is unavailable"), { code: "authoring_forbidden" });
  };
  const admission: AuthoringAdmission = {
    root,
    authority: () => {
      if (!authority) {
        forbidden = "no_browser_authority";
        return deny();
      }
      const access = browserAccess(
        authority,
        req.method ?? "GET",
        new URL(req.url ?? "/", "http://archer.invalid"),
        req.headers,
        () => false,
        (reason) => {
          forbidden = reason;
        },
      );
      if (access === null) return deny();
      // A cookie only: a Bearer is explicit, non-browser authority and never authors.
      if (access.credential !== "cookie") {
        forbidden = `credential_${access.credential}`;
        return deny();
      }
      // The owner's browser (an owner session)
      // authors as the owner, like a grant cookie (security rubric §1, G3: the service token's Edit is "as cookie").
      if (!access.grantId) return OWNER_AUTHORITY;
      const entitlement = backend.entitlement(access.grantId, root);
      if (!entitlement) {
        forbidden = "no_entitlement";
        return deny();
      }
      return { grantId: access.grantId, entitlementId: entitlement.entitlementId };
    },
  };
  // Server-Timing (S9): the grant and entitlement checks are `admit`; the backend names its own phases.
  const admitting = phaseStart();
  try {
    admission.authority();
    phaseEnd("admit", admitting);
  } catch {
    phaseEnd("admit", admitting);
    req.resume();
    if (action === "status" && req.method === "GET") send(200, { authorized: false });
    else send(404, { error: { code: "authoring_forbidden", message: "browser authoring permission is unavailable" } });
    return;
  }
  if (action === "status" || action === "operation" ? req.method !== "GET" : req.method !== "POST") {
    req.resume();
    send(405, { error: { code: "method_not_allowed", message: "unsupported authoring method" } });
    return;
  }
  let input: unknown;
  try {
    if (req.method === "POST") {
      const declared = req.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_AUTHORING_HTTP_BYTES)) {
        closeAfterRefusal(req, res);
        send(413, { error: { code: "authoring_body_too_large", message: "authoring body exceeds its limit" } });
        return;
      }
      // Read with the shared capped reader: leaving a `for await` early destroyed the request, and with it
      // the connection, before the 413 could reach a client still writing its body.
      const body = await readCapped(req, MAX_AUTHORING_HTTP_BYTES);
      if (body === TOO_LARGE) {
        closeAfterRefusal(req, res);
        send(413, { error: { code: "authoring_body_too_large", message: "authoring body exceeds its limit" } });
        return;
      }
      if (body === null) return;
      try {
        input = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body));
      } catch {
        send(400, { error: { code: "authoring_invalid_request", message: "authoring body must be valid UTF-8 JSON" } });
        return;
      }
    } else {
      const query = new URL(req.url ?? "/", "http://archer.invalid");
      input =
        action === "operation"
          ? { operationId: query.pathname.split("/").at(-1) }
          : { offset: query.searchParams.get("offset") ?? undefined };
    }
    const readmitting = phaseStart();
    admission.authority();
    phaseEnd("admit", readmitting);
    const result = await backend.request(admission, action, input);
    send(200, action === "status" ? { authorized: true, ...(result as object) } : result);
  } catch (failure) {
    const code =
      failure instanceof Error && "code" in failure && typeof failure.code === "string"
        ? failure.code
        : "authoring_unavailable";
    const status = authoringHttpStatus(code);
    // Do not reflect unexpected I/O paths or private journal authority to browser clients:
    // service-unavailable and OS (errno) refusals carry fixed text.
    const message =
      status === 503
        ? "Authoring is unavailable; check operation status before retrying."
        : !/^[a-z][a-z_]*$/u.test(code)
          ? (ERRNO_MESSAGE[code] ?? "authoring request refused")
          : failure instanceof Error
            ? failure.message
            : "authoring request refused";
    // A rules refusal names the rule (ADR 0028); nothing else is reflected.
    const rule =
      code === "write_rule_denied" && failure instanceof Error && "rule" in failure && typeof failure.rule === "string"
        ? failure.rule
        : undefined;
    send(status, { error: { code, message, ...(rule === undefined ? {} : { details: { rule } }) } });
  }
}

/**
 * Every refusal code a browser authoring request can end with, and its HTTP
 * status. Deliberate, not inferred from the code's spelling: a corrupt or
 * oversized private store is unavailable (503), not the request's fault.
 * Unlisted codes are 503 with fixed text.
 */
const AUTHORING_HTTP_STATUS: Readonly<Record<string, number>> = {
  authoring_forbidden: 403,
  // The request itself cannot be performed as sent.
  authoring_invalid_request: 422,
  authoring_generation_required: 422,
  authoring_target_invalid: 422,
  authoring_presentation_invalid: 422,
  invalid_source: 422,
  invalid_target: 422,
  invalid_arguments: 422,
  change_invalid_input: 422,
  change_cursor_invalid: 422,
  change_review_invalid: 422,
  path_outside_archer_folder: 422,
  edit_requires_valid_flowchart: 422,
  // The account's or the project's rules refuse this write (ADR 0028).
  write_rule_denied: 403,
  // A folder on the path is not this account's alone; the person can fix its permissions (known-limits §1).
  shared_folder: 403,
  editing_disabled: 403,
  create_not_allowed: 403,
  edit_invalid_shape: 422,
  edit_invalid_result: 422,
  edit_delete_styling_dependency: 422,
  edit_delete_referenced_node: 422,
  edit_delete_nonisolated_declaration: 422,
  edit_delete_inline_declaration: 422,
  edit_target_missing: 422,
  edit_source_mapping_ambiguous: 422,
  edit_invalid_line: 422,
  edit_requires_valid_c4: 422,
  edit_requires_valid_er: 422,
  edit_invalid_cardinality: 422,
  edit_relationship_id_ambiguous: 422,
  edit_delete_multiple_declarations: 422,
  edit_unsupported_family: 422,
  edit_unsupported_for_family: 422,
  edit_id_required: 422,
  edit_element_required: 422,
  edit_invalid_element: 422,
  edit_invalid_id: 422,
  edit_id_reserved: 422,
  edit_label_required: 422,
  edit_invalid_label: 422,
  edit_delete_last_element: 422,
  edit_relationship_id_derived: 422,
  edit_invalid_relation: 422,
  edit_endpoint_boundary: 422,
  edit_delete_boundary_unsupported: 422,
  edit_delete_last_in_boundary: 422,
  edit_requires_valid_state: 422,
  edit_invalid_state_kind: 422,
  edit_label_unsupported: 422,
  edit_invalid_endpoint: 422,
  edit_start_end_scope: 422,
  edit_scope_mismatch: 422,
  edit_relabel_unsupported: 422,
  edit_delete_leaves_undrawn_state: 422,
  edit_delete_composite_unsupported: 422,
  edit_delete_note_dependency: 422,
  edit_relabel_styled_declaration: 422,
  edit_requires_valid_sequence: 422,
  edit_move_same_participant: 422,
  edit_move_in_fragment: 422,
  edit_invalid_participant_kind: 422,
  edit_invalid_message_kind: 422,
  edit_invalid_note: 422,
  edit_activation_dependency: 422,
  edit_move_same_message: 422,
  edit_move_cross_block: 422,
  edit_invalid_fragment: 422,
  edit_wrap_not_consecutive: 422,
  edit_wrap_cross_block: 422,
  edit_wrap_spans_declaration: 422,
  edit_unwrap_sections: 422,
  edit_endpoint_required: 422,
  edit_retarget_inline_declaration: 422,
  edit_retarget_styling_dependency: 422,
  edit_retarget_leaves_undrawn_state: 422,
  authoring_source_limit: 413,
  // Missing subjects: a record, a project or the source file itself.
  authoring_not_found: 404,
  change_not_found: 404,
  diagram_not_found: 404,
  ENOENT: 404,
  // The state moved on; reload and decide again.
  revision_conflict: 409,
  authoring_draft_conflict: 409,
  authoring_target_conflict: 409,
  authoring_operation_mismatch: 409,
  authoring_draft_mismatch: 409,
  authoring_generation_retired: 409,
  authoring_probe_unavailable: 409,
  authoring_reconcile_required: 409,
  authoring_authority_changed: 409,
  authoring_resolution_conflict: 409,
  authoring_presentation_conflict: 409,
  change_review_conflict: 409,
  change_review_terminal: 409,
  change_operation_mismatch: 409,
  edit_id_exists: 409,
  edit_relationship_exists: 409,
  ambiguous_diagram: 409,
  EEXIST: 409,
  // Busy now, or a named capacity is full: the message says how to recover.
  authoring_busy: 429,
  source_busy: 429,
  authoring_store_capacity: 429,
  change_store_capacity: 429,
  authoring_grant_capacity: 429,
  authoring_presentation_limit: 429,
  // Corrupt, oversized, closed or unreadable private state; uncertain effects.
  authoring_store_invalid: 503,
  invalid_authoring_store: 503,
  change_store_invalid: 503,
  authoring_project_unavailable: 503,
  authoring_store_limit: 503,
  change_store_limit: 503,
  authoring_store_unavailable: 503,
  authoring_store_io: 503,
  authoring_store_closed: 503,
  authoring_operation_uncertain: 503,
  write_uncertain: 503,
  invalid_callback: 503,
  authoring_unavailable: 503,
};
const ERRNO_MESSAGE: Readonly<Record<string, string>> = {
  ENOENT: "the diagram source no longer exists; reload it",
  EEXIST: "a file already exists at that path",
};
export function authoringHttpStatus(code: string): number {
  return Object.hasOwn(AUTHORING_HTTP_STATUS, code) ? AUTHORING_HTTP_STATUS[code]! : 503;
}
