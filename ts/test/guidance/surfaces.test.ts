// ADR 0035 §1: one rule on which surface an agent uses, in one guidance file (`archer docs
// surfaces`), included byte for byte in the skill, the MCP instructions and the sandbox hint. A copy
// that drifts, or an "MCP first" text that comes back, fails here.
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";
import { SURFACES_RULE } from "../../src/guidance/surfaces.ts";
import { SANDBOX_HINT } from "../../src/service/sandbox.ts";
import { NO_TERMINAL_FOR_NETWORK } from "../../src/bin/operations.ts";
import { GUIDANCE } from "../../src/guidance/index.ts";
import { connect, removeTempDirs, tempDir } from "../mcp/support.ts";

afterEach(removeTempDirs);

const skillFile = (path: string): string =>
  readFileSync(new URL(`../../plugin/skills/archer/${path}`, import.meta.url), "utf8");

async function instructions(): Promise<string> {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    return client.getInstructions() ?? "";
  } finally {
    await close();
  }
}

test("archer docs surfaces prints the one rule", async () => {
  let out = "",
    err = "";
  const io: Io = {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    isTTY: false,
    columns: undefined,
    env: {},
    cwd: "/does-not-exist",
  };
  expect(await main(["docs", "surfaces"], io), err).toBe(0);
  expect(out).toBe(`${SURFACES_RULE}\n`);
  expect(SURFACES_RULE).toMatch(/`archer` CLI/);
  expect(SURFACES_RULE).toMatch(/MCP is an opt-in adapter over the same operations/);
  expect(SURFACES_RULE).toMatch(/follow the fix (the|it) (error )?names/);
  expect(SURFACES_RULE).not.toMatch(/\n/);
});

test.each([
  ["the skill", async () => skillFile("SKILL.md")],
  ["the MCP instructions", instructions],
  ["the sandbox hint", async () => SANDBOX_HINT],
])("%s carries the rule byte for byte", async (_place, read) => {
  expect(await read()).toContain(SURFACES_RULE);
});

const MCP_FIRST =
  /use\s+the\s+(attached\s+)?Archer\s+MCP\s+tools|CLI[^.]*only\s+when\s+they\s+are\s+not\s+attached|attached\s+MCP\s+tool\s+already\s+supplies|MCP\s+tools\s+if\s+they\s+are\s+attached\s+\(they\s+run\s+outside/i;

test.each([
  ["SKILL.md", async () => skillFile("SKILL.md")],
  ["references/cli.md", async () => skillFile("references/cli.md")],
  ["the guidance index", async () => JSON.stringify(GUIDANCE)],
  ["the sandbox hint", async () => SANDBOX_HINT],
  ["the CLI's network refusal", async () => NO_TERMINAL_FOR_NETWORK],
  ["the MCP instructions", instructions],
])("%s no longer says MCP first", async (_place, read) => {
  expect(await read()).not.toMatch(MCP_FIRST);
});
