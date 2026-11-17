/**
 * The walkthrough in the address (ADR 0034 §6): `?walkthrough=<id>&step=<n>`, beside ADR 0029's
 * `?zoom=` and `?open=`. Read when a diagram is opened; kept current with `replaceState` (the person
 * stepping is not navigating, so no history entry); removed when the panel closes. Anything else is
 * ignored quietly, as `readNestAddress` ignores it.
 */
/** `step` is left out for an archived walkthrough or its old version: there is no step to come back to. */
export type WalkAddress = { readonly id: string; readonly step?: number };

/** `WALKTHROUGH_ID` of the server's contract. */
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const STEP = /^\d{1,4}$/;

export function readWalkAddress(search: string): WalkAddress | null {
  const query = new URLSearchParams(search);
  const id = query.get("walkthrough");
  if (id === null || !ID.test(id)) return null;
  const step = query.get("step");
  return { id, step: step !== null && STEP.test(step) && Number(step) >= 1 ? Number(step) : 1 };
}

/** `href` with the walkthrough and step set, or both removed; everything else in it stays, byte for byte. */
export function withWalkAddress(href: string, at: WalkAddress | null): string {
  const url = new URL(href);
  const kept = url.search
    .slice(1)
    .split("&")
    .filter((part) => part !== "" && !/^(?:walkthrough|step)(?:=|$)/.test(part));
  if (at !== null) kept.push(`walkthrough=${at.id}`, ...(at.step === undefined ? [] : [`step=${at.step}`]));
  url.search = kept.length === 0 ? "" : `?${kept.join("&")}`;
  return url.href;
}

/** Updates the address in place; the entry is replaced, never added. */
export function writeWalkAddress(at: WalkAddress | null): void {
  const next = withWalkAddress(window.location.href, at);
  if (next !== window.location.href) window.history.replaceState(window.history.state, "", next);
}
