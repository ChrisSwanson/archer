// What Archer costs an agent's context in every session: the skill text and the MCP
// server's instructions, tool descriptions and input schemas.
//
//   tsx scripts/evals/context-size.ts [archer.js]   (default: dist/archer.js)
//
// Tokens are estimated at 4 characters each; compare runs, not absolute numbers.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tokens = (text: string) => Math.round(text.length / 4);

export async function contextSize(archerJs: string) {
  const skill = readFileSync(join(TS, "plugin/skills/archer/SKILL.md"), "utf8");
  const description = /^description:\s*(.*)$/m.exec(skill)?.[1] ?? "";
  const scratch = mkdtempSync(join(tmpdir(), "archer-context-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    ARCHER_STATE_DIR: join(scratch, "state"),
    ARCHER_SOCKET: join(scratch, "state", "s.sock"),
    ARCHER_AUTO_START: "false",
    ARCHER_MCP_IN_PROCESS: "1",
  }; // measures the tool list; never leaves a service running
  const client = new Client({ name: "context-size", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [archerJs, "mcp"],
      cwd: scratch,
      env,
      stderr: "ignore",
    }),
  );
  try {
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();
    const descriptions = tools.map((tool) => `${tool.name}: ${tool.description ?? ""}`).join("\n");
    const schemas = tools.map((tool) => JSON.stringify(tool.inputSchema)).join("\n");
    return {
      skillListing: tokens(description),
      skillBody: tokens(skill),
      mcpInstructions: tokens(instructions),
      toolCount: tools.length,
      toolDescriptions: tokens(descriptions),
      toolSchemas: tokens(schemas),
      perTool: Object.fromEntries(
        tools.map((tool) => [tool.name, tokens(`${tool.description ?? ""}${JSON.stringify(tool.inputSchema)}`)]),
      ),
    };
  } finally {
    await client.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await contextSize(resolve(process.argv[2] ?? join(TS, "dist/archer.js"))), null, 2));
}
