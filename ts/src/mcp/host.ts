// The service side of the MCP relay (ADR 0035 §6; host-contract.ts): one Archer MCP server per relay
// connection, over the relayed lines, for the project of the relay's working directory. It declares
// `tools.listChanged`; after a hot swap the relay replays the client's handshake to the replacement and
// sends `notifications/tools/list_changed` itself, so the client lists the new build's tools.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { agentIdentity, type HostMcp, type RelayEndpoint } from "./host-contract.ts";
import { createArcherServer, type ArcherServerOptions } from "./server.ts";
import { version } from "../version.ts";

/** An MCP transport over a relay endpoint: one JSON-RPC message per line, both ways. */
export class RelayTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private closed = false;

  /** `onRequest` sees each request before the server does (the host reports its agent in). */
  constructor(
    private readonly endpoint: RelayEndpoint,
    private readonly onRequest?: (method: string) => void,
  ) {}

  async start(): Promise<void> {
    void (async () => {
      try {
        for await (const line of this.endpoint.incoming) {
          if (this.closed) break;
          if (line.trim() === "") continue;
          let message: JSONRPCMessage;
          try {
            message = JSONRPCMessageSchema.parse(JSON.parse(line));
          } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            continue;
          }
          if ("method" in message && "id" in message) this.onRequest?.(message.method);
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      } finally {
        void this.close();
      }
    })();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.closed) this.endpoint.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

/** A session's tool calls report its agent in at most this often (decision 4: busy is not away). */
export const REPORT_IN_EVERY_MS = 10_000;

/** The service's `hostMcp`, given how its MCP servers reach Archer (the service passes its own options). */
export function createHostMcp(
  base: Omit<ArcherServerOptions, "cwd" | "listChanged">,
  now: () => number = Date.now,
): HostMcp {
  return async (endpoint, launch) => {
    // The relay registered this session as an agent: its get_comments say who asks (decision 10).
    const server = createArcherServer({
      version: version(),
      ...base,
      cwd: launch.cwd,
      listChanged: true,
      ...agentIdentity(launch.agentId),
    });
    let reported = -Infinity;
    const reportIn = (method: string): void => {
      if (
        launch.agentId === undefined ||
        method !== "tools/call" ||
        base.findService === undefined ||
        now() - reported < REPORT_IN_EVERY_MS
      )
        return;
      reported = now();
      void (async () => {
        const client = await base.findService!().catch(() => null);
        try {
          await client?.call("heartbeat", { agentId: launch.agentId!, via: "cli" });
        } catch {
          /* a forgotten id, a refusal: the call goes ahead */
        } finally {
          client?.close();
        }
      })();
    };
    const transport = new RelayTransport(endpoint, reportIn);
    const ended = new Promise<void>((resolve) => {
      server.onclose = () => resolve();
    });
    await server.connect(transport);
    await ended;
    await server.close();
  };
}

/**
 * The default `hostMcp`: its servers reach the service the way the CLI does, through the account's
 * socket (in the service, that is the service itself). The service may build its own with createHostMcp.
 */
export const hostMcp: HostMcp = async (endpoint, launch) => {
  const { connectIfRunning, ensureService } = await import("../service/client.ts");
  const env = process.env;
  return createHostMcp({
    env,
    findService: () => connectIfRunning({ env }),
    ensureService: () => ensureService({ env }),
    startService: () => ensureService({ env, autoStart: true }),
  })(endpoint, launch);
};
