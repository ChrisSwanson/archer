// `archer mcp` end to end: the real executable over stdio, rooted at the
// project its working directory is in.
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FLOW, removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);

const ARCHER = fileURLToPath(new URL("../../src/bin/archer.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

test("archer mcp serves the tools over stdio for the project of its working directory", async () => {
  const dir = tempDir({ ".archer/sub/arch.mmd": FLOW, ".git/HEAD": "" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", TSX, ARCHER, "mcp"],
    cwd: `${dir}/.archer/sub`,
    stderr: "pipe",
    // No service here and none may start: the relay falls back to the in-process server (relay.ts), and
    // never dials the person's own Archer.
    env: { PATH: process.env["PATH"] ?? "", HOME: dir, ARCHER_STATE_DIR: `${dir}/state`, ARCHER_AUTO_START: "false" },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("write_diagram");
  const listed = await client.callTool({ name: "list_diagrams", arguments: {} });
  expect(listed.structuredContent).toMatchObject({ views: [{ id: "arch", source: "sub/arch.mmd" }] });
  expect(client.getInstructions()).toContain("archer://docs/supported-mermaid");
  const profile = await client.readResource({ uri: "archer://docs/supported-mermaid" });
  expect((profile.contents[0] as { text: string }).text).toContain("# Supported Mermaid");
  await client.close();
}, 20_000);
