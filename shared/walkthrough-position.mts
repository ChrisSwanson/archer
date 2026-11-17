import { LIMITS, WALKTHROUGH_ID } from "../ts/src/walkthroughs/contract.ts";

export type WalkthroughPosition =
  | { readonly viewId: string; readonly id: null }
  | { readonly viewId: string; readonly id: string; readonly step: number };
export type WalkthroughPositionResult =
  | { readonly ok: true; readonly position: WalkthroughPosition }
  | { readonly ok: false; readonly message: string };

/** The service and static runtime accept the same bounded reader-position report. */
export function parseWalkthroughPosition(
  raw: unknown,
  registered: (viewId: string) => boolean,
): WalkthroughPositionResult {
  const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const viewId = body?.viewId;
  if (typeof viewId !== "string" || !registered(viewId))
    return { ok: false, message: "name a registered view: {viewId, id, step}" };
  if (body?.id === null) return { ok: true, position: { viewId, id: null } };
  const { id, step } = body as { id?: unknown; step?: unknown };
  if (
    typeof id !== "string" ||
    !WALKTHROUGH_ID.test(id) ||
    !Number.isSafeInteger(step) ||
    (step as number) < 1 ||
    (step as number) > LIMITS.steps
  )
    return {
      ok: false,
      message: "a position is {viewId, id, step} with a walkthrough id and a step from 1, or {viewId, id: null}",
    };
  return { ok: true, position: { viewId, id, step: step as number } };
}
