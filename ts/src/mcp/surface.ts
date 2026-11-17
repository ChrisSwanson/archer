// What an agent session loads from Archer when it starts (ADR 0032): the MCP tools as listed and
// the server's instructions. A change means sessions must restart to see it; nothing else does.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createArcherServer } from "./server.ts";

export interface AgentSurface {
  readonly tools: readonly { readonly name: string }[];
  readonly instructions: string;
  readonly digest: string;
}

export async function agentSurface(): Promise<AgentSurface> {
  const server = createArcherServer({ cwd: tmpdir() });
  const client = new Client({ name: "archer-surface", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    const instructions = client.getInstructions() ?? "";
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const digest = `sha256:${createHash("sha256")
      .update(JSON.stringify({ tools: sorted, instructions }))
      .digest("hex")}`;
    return { tools: sorted, instructions, digest };
  } finally {
    await client.close();
    await server.close();
  }
}
