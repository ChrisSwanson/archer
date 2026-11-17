// The service side of the MCP relay (ADR 0035 §6). The relay process forwards MCP JSON-RPC lines
// unchanged over a management-socket connection that answered `mcpRelay`; the service serves them
// here with the full Archer MCP server, so its hot swap upgrades every session's tools at once.
import type { AgentHost } from "../agents/contract.ts";

export interface RelayEndpoint {
  /** Lines from the relay (one JSON-RPC message each, newline stripped). Ends when the relay disconnects. */
  readonly incoming: AsyncIterable<string>;
  /** Sends one JSON-RPC message line back to the relay. */
  send(line: string): void;
}

export interface RelayLaunch {
  readonly cwd: string;
  readonly host: AgentHost;
  readonly relayVersion: string;
  /**
   * Additive (0.7.0 review, decision 10): the agent the relay registered for its MCP session (registerAgent
   * on the same connection, before mcpRelay), so the service recognises the listener on `get_comments`
   * and any tool call reports in. Absent when registration was refused.
   */
  readonly agentId?: string;
}

/**
 * The application option that says which agent a session speaks for: `ApplicationOptions.agentId`,
 * which `get_comments` reports as the caller (reportActivity) so a listener's fetch marks read, and
 * replies record conversation affinity. Every adapter (CLI, MCP over the relay) sets it through this helper.
 */
export const AGENT_IDENTITY_OPTION = "agentId" as const;
export function agentIdentity(agentId: string | undefined): { readonly [AGENT_IDENTITY_OPTION]?: string } {
  return agentId === undefined ? {} : { [AGENT_IDENTITY_OPTION]: agentId };
}

/**
 * Serves one relay connection until it ends. Declares `tools.listChanged` and sends
 * `notifications/tools/list_changed` when this build's tool list differs from the one the relay's
 * client last listed (the relay passes that through after a swap reconnect).
 */
export type HostMcp = (endpoint: RelayEndpoint, launch: RelayLaunch) => Promise<void>;

/**
 * What the service writes on a relay connection once a hand-over's drain has answered every call it took
 * (ADR 0032, ADR 0035 §6; O56): any call of the relay's still unanswered was never run, so the relay sends
 * it to the replacement instead of answering "outcome unknown", and writes nothing more to this connection.
 * A notification, so a relay that does not know it passes it to its client, which ignores a method it does not know.
 */
export const RELAY_HANDOVER_NOTICE = "notifications/archer/handover";
