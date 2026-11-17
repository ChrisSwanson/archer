// A link an agent hands the person carries a credential: one wrong character and it is dead.
// Tool results put each link alone on its line, after the instruction to copy it exactly
// (ADR 0014, amended 2026-10-22: small agents retyped long tokens).

export const COPY_EXACTLY = "give this link exactly (copy it, never retype it)";

/** `lead; give this link exactly (…):` then the URL on its own line. */
export function linkText(lead: string, url: string): string {
  return `${lead}; ${COPY_EXACTLY}:\n${url}`;
}

/**
 * A pairing code's instructions: the base address (no secret) and the code, each alone on its line
 * so an agent copies them as they are.
 */
export function pairingText(issued: { readonly url: string; readonly code: string; readonly minutes: number }): string {
  return `Pairing code: tell the person to open the address and type the code, within ${issued.minutes} minutes (single use); give both exactly (copy them, never retype them):\n${issued.url}\n${issued.code}`;
}
