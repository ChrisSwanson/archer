// A listen or connect the operating system refused (EPERM, EACCES). Under an agent client that is
// almost always the client's own sandbox (Codex workspace-write, Claude Code's sandbox), not Archer.
// Said where the refusal surfaces, so the agent fixes the right thing instead of giving up. It
// carries the surfaces rule (ADR 0035 §1) verbatim, then the exception: MCP when attached.
import { SURFACES_RULE } from "../guidance/surfaces.ts";

const REFUSED = /\b(?:EPERM|EACCES)\b/;

export const SANDBOX_HINT =
  "This is most likely the agent client's sandbox refusing local network access, not Archer. " +
  `${SURFACES_RULE} ` +
  "Here the fix is outside Archer: if Archer's MCP tools are attached to this session, they reach the service from outside the sandbox. Otherwise tell the person what to change, " +
  "for example: in Codex, `network_access = true` under `[sandbox_workspace_write]` in config.toml (or a less strict sandbox_mode); " +
  "in Claude Code, allow local network access in its sandbox settings. Then try again.";

/** Whether an error code or message is the operating system refusing a socket operation. */
export const isSandboxRefusal = (text: string | undefined): boolean => text !== undefined && REFUSED.test(text);

/** `error` with the hint added when it is such a refusal (once); otherwise `error` itself. */
export function explainSandbox<E extends Error>(error: E): E {
  const code = (error as NodeJS.ErrnoException).code;
  if (!isSandboxRefusal(code ?? error.message) || error.message.includes(SANDBOX_HINT)) return error;
  error.message = `${error.message}. ${SANDBOX_HINT}`;
  return error;
}

/** `text` with the hint added when it reports such a refusal (once). */
export function withSandboxHint(text: string): string {
  return isSandboxRefusal(text) && !text.includes(SANDBOX_HINT) ? `${text}\n${SANDBOX_HINT}` : text;
}
