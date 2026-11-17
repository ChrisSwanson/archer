// Access and TLS refusals an agent can act on: each has a stable code and a fix naming the tool or
// command to run, and whether it needs the person's yes. Start-up refusals travel as text (the service's
// log tail), so the code is written into the message as "[code] Fix: …" and read back by `accessRefusalIn`.

export type AccessCode =
  | "tls_required"
  | "tls_invalid"
  | "openssl_missing"
  | "network_host_unknown"
  | "network_setup_blocked"
  | "person_confirmation_needed";

export interface AccessFix {
  /** What to do, in one sentence the agent can follow. */
  readonly text: string;
  /** The MCP tool and arguments that do it, when there is one. */
  readonly tool?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  /** The CLI form. */
  readonly command?: string;
  /** Whether the person must say yes first (exposing Archer to the network does). */
  readonly needsPersonYes: boolean;
}

const NETWORK_SETUP: AccessFix = {
  text: "ask the person once, in one sentence, whether Archer may serve their network over HTTPS; after their yes run setup_network_access with personConfirmed: true (it makes the certificate, updates the settings and restarts Archer)",
  tool: "setup_network_access",
  arguments: { personConfirmed: true },
  // The person runs the CLI form themselves: it asks them at their terminal.
  command: "archer network-access",
  needsPersonYes: true,
};

export const ACCESS_FIXES: Readonly<Record<"tls_required" | "tls_invalid", AccessFix>> = {
  tls_required: NETWORK_SETUP,
  tls_invalid: {
    ...NETWORK_SETUP,
    text: `the configured certificate cannot be used; ${NETWORK_SETUP.text} (new certificates: the person trusts the new CA once more)`,
  },
};

/** "<why> [code] Fix: <fix>": the form a refusal keeps through the service log. */
export function accessRefusalText(code: keyof typeof ACCESS_FIXES, why: string): string {
  return `${why} [${code}] Fix: ${ACCESS_FIXES[code].text}.`;
}

/** The code and fix a start-up failure's text carries, if it is an access refusal. */
export function accessRefusalIn(
  text: string,
): { readonly code: keyof typeof ACCESS_FIXES; readonly fix: AccessFix } | null {
  const match = /\[(tls_required|tls_invalid)\] Fix: /.exec(text);
  if (match === null) return null;
  const code = match[1] as keyof typeof ACCESS_FIXES;
  return { code, fix: ACCESS_FIXES[code] };
}
