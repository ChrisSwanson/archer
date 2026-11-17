// Tool arguments are untrusted input. Whatever arrives, every tool answers or
// refuses under a code the caller can act on: never `internal`, never a crash.
// Arguments are drawn from the tools' own vocabulary (their argument names,
// enum values, ids and revisions of the project) and from arbitrary JSON.
import { afterAll, beforeAll, expect, test } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { connectService, type EnsureService } from "../../src/mcp/index.ts";
import { TOOLS } from "../../src/mcp/tools.ts";
import { revisionOf } from "../../src/project/index.ts";
import {
  connect,
  FLOW,
  removeSocketDirs,
  removeTempDirs,
  SEQ,
  startFakeService,
  tempDir,
  type Connected,
  type FakeService,
} from "./support.ts";

let connected: Connected;
let service: FakeService;

beforeAll(async () => {
  service = await startFakeService();
  const ensureService: EnsureService = () => connectService(service.socketPath);
  connected = await connect({
    cwd: tempDir({ ".archer/arch.mmd": FLOW, ".archer/login.mmd": SEQ, "outside.mmd": FLOW }),
    ensureService,
  });
});

afterAll(async () => {
  await connected.close();
  await service.close();
  removeSocketDirs();
  removeTempDirs();
});

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCABULARY: unknown[] = [
  "arch",
  "login",
  "a",
  "b",
  "e1",
  "msg-0",
  "frag-0",
  "../outside.mmd",
  "arch.mmd",
  ".archer/arch.mmd",
  "/etc/passwd",
  "",
  "flow",
  "highlight",
  "teal",
  "proposed",
  "fast",
  "freeform",
  "sequence",
  FLOW,
  SEQ,
  "flowchart LR\n  a --> b\n",
  revisionOf(Buffer.from(FLOW)),
  `sha256:${"f".repeat(64)}`,
  "sha256:",
  "x".repeat(600),
  "\u0000‮",
  0,
  -1,
  1.5,
  true,
  null,
  [],
  {},
];

function value(next: () => number, depth = 0): unknown {
  const r = next();
  if (r < 0.6 || depth > 2) return VOCABULARY[Math.floor(next() * VOCABULARY.length)];
  if (r < 0.8) return Array.from({ length: Math.floor(next() * 4) }, () => value(next, depth + 1));
  const object: Record<string, unknown> = {};
  for (let i = Math.floor(next() * 4); i > 0; i--)
    object[pick(next, ["id", "style", "palette", "nodes", "edges", "speed", "label", "zz"])] = value(next, depth + 1);
  return object;
}

const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

test("no arguments make a tool fail inside Archer", async () => {
  const next = rng(20261003);
  for (const tool of TOOLS) {
    const names = [...Object.keys(tool.inputSchema.properties ?? {}), "extra"];
    for (let round = 0; round < 40; round++) {
      const args: Record<string, unknown> = {};
      for (const name of names) if (next() < 0.7) args[name] = value(next);
      try {
        await connected.client.callTool({ name: tool.name, arguments: args });
      } catch (error) {
        expect(error, `${tool.name} ${JSON.stringify(args).slice(0, 300)}`).toBeInstanceOf(McpError);
        const code = (error as McpError & { data?: { code?: string } }).data?.code;
        expect(code, `${tool.name} ${JSON.stringify(args).slice(0, 300)}: ${(error as Error).message}`).not.toBe(
          "internal",
        );
        expect(code).toBeTypeOf("string");
      }
    }
  }
}, 120_000);
