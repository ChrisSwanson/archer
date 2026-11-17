// `archer mcp`: Archer's MCP server over stdio, rooted at the project found
// from its working directory.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createArcherServer, type ArcherServerOptions } from "./server.ts";

export { createArcherServer, type ArcherServerOptions } from "./server.ts";
export {
  connectService,
  ServiceCallError,
  ServiceUnavailableError,
  type EnsureService,
  type ServiceClient,
} from "./service-client.ts";
export { TOOLS, PROFILE_URI } from "./tools.ts";
export { createHostMcp, hostMcp, RelayTransport } from "./host.ts";
export type { HostMcp, RelayEndpoint, RelayLaunch } from "./host-contract.ts";

/** Serves MCP on stdin/stdout until the client closes the connection. */
export async function runStdio(options: ArcherServerOptions): Promise<void> {
  const server = createArcherServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
  });
  await server.connect(transport);
  await closed;
  await server.close();
}
