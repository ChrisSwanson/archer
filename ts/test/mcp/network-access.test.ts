// setup_network_access over MCP: the client asks the person itself where it can (elicitation), so an
// agent cannot fake the yes; the tool is annotated so a client asks before running it.
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test } from "vitest";
import { connect, refusal, removeTempDirs, tempDir } from "./support.ts";
import { detectLanHost } from "../../src/application/network-access.ts";

// The bind must be one of this machine's own addresses; without one there is nothing to open.
const HOST = detectLanHost() ?? "";
const lan = HOST === "" ? test.skip : test;

afterEach(removeTempDirs);

test("the tool is marked destructive and open-world, so clients ask before running it", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === "setup_network_access");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  } finally {
    await close();
  }
});

lan.each([
  ["decline", undefined, 0],
  ["accept", { open: false }, 0],
  ["cancel", undefined, 0],
] as const)("an elicited %s %j is the person's no, whatever the agent passed", async (action, content, after) => {
  const { client, close } = await connect({ cwd: tempDir(), env: { HOME: tempDir() } }, { elicitation: { form: {} } });
  const asked: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    asked.push(String(request.params.message));
    await new Promise((done) => setTimeout(done, after));
    return content === undefined ? { action } : { action, content };
  });
  try {
    const error = await refusal(client, "setup_network_access", { personConfirmed: true, host: HOST });
    expect(error.data["code"]).toBe("person_declined");
    expect(asked).toEqual([expect.stringContaining(`Open Archer to other devices on your network at https://${HOST}`)]);
  } finally {
    await close();
  }
});

lan("without elicitation, personConfirmed is still required", async () => {
  const { client, close } = await connect({ cwd: tempDir(), env: { HOME: tempDir() } });
  try {
    expect((await refusal(client, "setup_network_access", { host: HOST })).data["code"]).toBe(
      "person_confirmation_needed",
    );
  } finally {
    await close();
  }
});

// Security review (2026-10-22): no timing rule. Every cancel or decline is a no; "cannot ask" comes only from
// the capability missing at initialize (above) or the request failing with MethodNotFound.
lan.each([
  ["a quick cancel", { action: "cancel" }],
  ["a decline", { action: "decline" }],
] as const)("%s is refused, never a fallback to personConfirmed", async (_, answer) => {
  const { client, close } = await connect({ cwd: tempDir(), env: { HOME: tempDir() } }, { elicitation: { form: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => answer);
  try {
    expect((await refusal(client, "setup_network_access", { personConfirmed: true, host: HOST })).data["code"]).toBe(
      "person_declined",
    );
  } finally {
    await close();
  }
});

lan("a client that advertises elicitation but answers MethodNotFound is the approval-prompt path", async () => {
  const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
  const { client, close } = await connect({ cwd: tempDir(), env: { HOME: tempDir() } }, { elicitation: { form: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => {
    throw new McpError(ErrorCode.MethodNotFound, "no elicitation here");
  });
  try {
    expect((await refusal(client, "setup_network_access", { host: HOST })).data["code"]).toBe(
      "person_confirmation_needed",
    );
  } finally {
    await close();
  }
});
