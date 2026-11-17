// The MCP relay (ADR 0035 §6): `archer mcp` forwards lines to the service, which serves them with
// hostMcp; a hot swap is survived by replaying the client's handshake to the replacement and telling
// the client its tools changed when they did (REVIEW-0.7.0 decisions 7–10). The service side is a
// fake socket here, carrying the real hostMcp.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Socket } from "node:net";
import { createHostMcp } from "../../src/mcp/host.ts";
import type { HostMcp, RelayEndpoint } from "../../src/mcp/host-contract.ts";
import {
  MAX_RELAY_LINE_BYTES,
  openRelay,
  OUTCOME_UNKNOWN,
  relay,
  serviceDial,
  type RelayLaunchFacts,
} from "../../src/mcp/relay.ts";
import { closeFakes, fakeService, Refusal, type FakeService } from "../bin/fake-agent-service.ts";
import { FLOW, removeTempDirs, tempDir } from "./support.ts";

afterEach(async () => {
  await closeFakes();
  removeTempDirs();
});

const LAUNCH: RelayLaunchFacts = { cwd: "/p", host: "claude-code", relayVersion: "0.7.0-test" };

/** Serves every relay connection on `fake` with `host`, as the service does with mcpRelay. */
function serveRelays(fake: FakeService, host: HostMcp): void {
  const endpoints = new Map<Socket, { push: (line: string | null) => void }>();
  fake.handlers["mcpRelay"] = (params, socket) => {
    const lines: (string | null)[] = [];
    let wake: (() => void) | null = null;
    const push = (line: string | null): void => {
      lines.push(line);
      wake?.();
      wake = null;
    };
    endpoints.set(socket, { push });
    const incoming = (async function* () {
      for (;;) {
        while (lines.length > 0) {
          const line = lines.shift()!;
          if (line === null) return;
          yield line;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })();
    const endpoint: RelayEndpoint = {
      incoming,
      send: (line) => {
        if (!socket.destroyed) socket.write(`${line}\n`);
      },
    };
    void host(endpoint, params as unknown as RelayLaunchFacts);
    return { relaying: true };
  };
  fake.handlers["relayLine"] = ({ line }, socket) => endpoints.get(socket)?.push(String(line));
  fake.handlers["relayClose"] = (_params, socket) => endpoints.get(socket)?.push(null);
}

/** A scripted service end: answers each relayed request with `answer(method)`. */
function scripted(fake: FakeService, answer: (message: Record<string, unknown>) => unknown): void {
  fake.handlers["mcpRelay"] = () => ({ relaying: true });
  fake.handlers["relayLine"] = ({ line }, socket) => {
    const message = JSON.parse(String(line)) as Record<string, unknown>;
    if (message["id"] === undefined) return;
    const result = answer(message);
    if (result !== undefined) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message["id"], result })}\n`);
  };
}

const lines = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the relay says mcpRelay with its launch facts, then forwards lines both ways, requests under its own ids", async () => {
  const fake = await fakeService();
  scripted(fake, (message) => ({ echo: message["method"] }));
  const env = { ARCHER_SOCKET: fake.socketPath };
  const dial = serviceDial(env, LAUNCH);
  const opened = await openRelay(dial, env);
  if (!("relay" in opened)) throw new Error(JSON.stringify(opened));
  const input = new PassThrough();
  let out = "";
  const running = relay(opened.relay, {
    launch: LAUNCH,
    input,
    write: (text) => {
      out += text;
    },
    dial,
  });
  const request = '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{"x":"é"}}';
  input.write(`${request}\n`);
  await until(() => out.includes('"id":7'));
  expect(fake.requests.map((r) => r.method)).toEqual(["hello", "mcpRelay"]);
  expect(fake.requests[1]!.params).toEqual(LAUNCH);
  // The same request under a relay id (decision 20); the answer comes back under the client's.
  expect(fake.relayed[0]!.map((line) => JSON.parse(line) as unknown)).toEqual([{ ...JSON.parse(request), id: 1 }]);
  expect(lines(out)).toEqual([{ jsonrpc: "2.0", id: 7, result: { echo: "tools/list" } }]);
  input.end();
  await running;
});

const INITIALIZE =
  '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}';
const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
const fastSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 20)));

/** A relay on `env`'s socket with an in-memory client; `out` collects what the client is sent. */
async function started(env: { ARCHER_SOCKET: string }, extra: Partial<Parameters<typeof relay>[1]> = {}) {
  const dial = serviceDial(env, LAUNCH);
  const opened = await openRelay(dial, env);
  if (!("relay" in opened)) throw new Error(JSON.stringify(opened));
  const input = new PassThrough();
  const state = { out: "" };
  const running = relay(opened.relay, {
    launch: LAUNCH,
    input,
    write: (text) => {
      state.out += text;
    },
    dial,
    sleep: fastSleep,
    ...extra,
  });
  return { input, state, running, dial };
}

test.each([
  ["the same tools", ["a", "b"], 0],
  ["changed tools", ["a", "b", "c"], 1],
])(
  "after a hot swap with %s the relay replays initialize, swallows its answer, answers cut calls 'outcome unknown', and says the tools changed only when they did",
  async (_name, newTools, notified) => {
    const old = await fakeService();
    let hold = false;
    const tools = (names: string[]) => ({ tools: names.map((name) => ({ name, inputSchema: { type: "object" } })) });
    scripted(old, (message) =>
      hold && message["method"] === "tools/call"
        ? undefined
        : message["method"] === "tools/list"
          ? tools(["a", "b"])
          : { from: "old" },
    );
    const env = { ARCHER_SOCKET: old.socketPath };
    const { input, state, running } = await started(env);
    input.write(`${INITIALIZE}\n${INITIALIZED}\n`);
    await until(() => state.out.includes('"id":0'));
    input.write('{"jsonrpc":"2.0","id":9,"method":"tools/list"}\n');
    await until(() => state.out.includes('"id":9'));
    hold = true;
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_comment"}}\n');
    await until(() => old.relayed[0]!.length === 4);
    // The swap: the old copy goes away mid-call; the replacement listens on the same socket.
    await old.close();
    const replacement = await fakeService({}, { socketPath: env.ARCHER_SOCKET });
    scripted(replacement, (message) => (message["method"] === "tools/list" ? tools(newTools) : { from: "new" }));
    await until(() => replacement.relayed[0]?.length === 3);
    input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    await until(() => state.out.includes('"id":2'));
    const replayed = replacement.relayed[0]!.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(replayed[0]).toMatchObject({
      method: "initialize",
      id: expect.any(Number),
      params: JSON.parse(INITIALIZE).params,
    });
    expect(replayed[1]).toEqual(JSON.parse(INITIALIZED));
    // The relay's own check of the replacement's tools, then the client's traffic, each under a relay id.
    expect(replayed[2]).toMatchObject({ method: "tools/list", id: expect.any(Number) });
    expect(replayed[3]).toMatchObject({ id: expect.any(Number), method: "ping" });
    expect(new Set(replayed.filter((line) => line["id"] !== undefined).map((line) => line["id"])).size).toBe(3);
    const sent = lines(state.out);
    expect(sent.slice(0, 3)).toEqual([
      { jsonrpc: "2.0", id: 0, result: { from: "old" } },
      { jsonrpc: "2.0", id: 9, result: tools(["a", "b"]) },
      // A write may have been done: never "call it again".
      { jsonrpc: "2.0", id: 1, error: { code: -32603, message: OUTCOME_UNKNOWN } },
    ]);
    expect(OUTCOME_UNKNOWN).toMatch(/outcome is unknown: check before retrying/);
    expect(OUTCOME_UNKNOWN).not.toMatch(/call it again/);
    expect(sent.filter((line) => line["method"] === "notifications/tools/list_changed")).toHaveLength(notified);
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 2, result: { from: "new" } });
    input.end();
    await running;
  },
);

// C10: a swap before the first initialize was answered keeps the handshake the client's own.
test("a swap before initialize was answered sends it again as the client's own and passes the answer on", async () => {
  const old = await fakeService();
  scripted(old, () => undefined);
  const env = { ARCHER_SOCKET: old.socketPath };
  const { input, state, running } = await started(env);
  input.write(`${INITIALIZE}\n`);
  await until(() => old.relayed[0]!.length === 1);
  await old.close();
  const replacement = await fakeService({}, { socketPath: env.ARCHER_SOCKET });
  scripted(replacement, () => ({
    protocolVersion: "2025-06-18",
    capabilities: {},
    serverInfo: { name: "archer", version: "1" },
  }));
  await until(() => state.out.includes('"id":0'));
  // The client's own initialize, once, under a relay id; its answer under the client's id 0.
  expect(replacement.relayed[0]!.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
    { ...JSON.parse(INITIALIZE), id: expect.any(Number) },
  ]);
  expect(lines(state.out)).toEqual([
    {
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "archer", version: "1" } },
    },
  ]);
  input.end();
  await running;
});

// C1: SDK request ids restart at 0 on every server, so a late answer to the old copy's approval must not
// reach the replacement's request with the same id.
test("server-to-client request ids are remapped per connection; a stale answer is dropped and the old request cancelled", async () => {
  const old = await fakeService();
  scripted(old, () => ({}));
  const env = { ARCHER_SOCKET: old.socketPath };
  const { input, state, running } = await started(env);
  input.write(`${INITIALIZE}\n`);
  await until(() => state.out.includes('"id":0'));
  old.relays[0]!.write('{"jsonrpc":"2.0","id":0,"method":"elicitation/create","params":{"message":"A"}}\n');
  await until(() => state.out.includes('"message":"A"'));
  const askedA = lines(state.out).find((line) => line["method"] === "elicitation/create")!;
  expect(askedA["id"]).not.toBe(0);
  await old.close();
  const replacement = await fakeService({}, { socketPath: env.ARCHER_SOCKET });
  const answers: Record<string, unknown>[] = [];
  scripted(replacement, () => ({}));
  const answered = replacement.handlers["relayLine"]!;
  replacement.handlers["relayLine"] = (params, socket) => {
    const message = JSON.parse(String(params["line"])) as Record<string, unknown>;
    if (message["method"] === undefined) answers.push(message);
    return answered(params, socket);
  };
  await until(() => replacement.relayed[0]?.length === 1);
  replacement.relays[0]!.write('{"jsonrpc":"2.0","id":0,"method":"elicitation/create","params":{"message":"B"}}\n');
  await until(() => state.out.includes('"message":"B"'));
  const askedB = lines(state.out).find(
    (line) => line["method"] === "elicitation/create" && (line["params"] as { message?: string }).message === "B",
  )!;
  expect(askedB["id"]).not.toBe(askedA["id"]);
  expect(lines(state.out)).toContainEqual({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: askedA["id"], reason: expect.any(String) },
  });
  // The person's late yes to A never reaches the replacement; the answer to B does, under B's own id.
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: askedA["id"], result: { action: "accept", content: { open: true } } })}\n`,
  );
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: askedB["id"], result: { action: "decline" } })}\n`);
  await until(() => answers.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(answers).toEqual([{ jsonrpc: "2.0", id: 0, result: { action: "decline" } }]);
  input.end();
  await running;
});

// H1/C4: `archer stop` ends relays; an open session must not bring the service back by itself.
test("after the service goes away the relay dials only what runs; the client's next request may start it", async () => {
  const old = await fakeService();
  scripted(old, () => ({}));
  const env = { ARCHER_SOCKET: old.socketPath };
  const dial = serviceDial(env, LAUNCH);
  const opened = await openRelay(dial, env);
  if (!("relay" in opened)) throw new Error(JSON.stringify(opened));
  const input = new PassThrough();
  let out = "",
    clock = 0;
  const starts: boolean[] = [];
  const running = relay(opened.relay, {
    launch: LAUNCH,
    input,
    write: (text) => {
      out += text;
    },
    sleep: async () => undefined,
    now: () => (clock += 1000),
    dial: async (start) => {
      starts.push(start);
      if (!start) throw new Error("ENOENT");
      return dial(true);
    },
  });
  await old.close();
  await until(() => starts.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Passive only, and it gave up within its window without a request.
  expect(starts.length).toBeGreaterThan(1);
  expect(starts.every((start) => !start)).toBe(true);
  const back = await fakeService({}, { socketPath: env.ARCHER_SOCKET });
  scripted(back, () => ({ from: "back" }));
  // A ping is the relay's to answer and starts nothing (decision 20); a tool call may start Archer.
  input.write('{"jsonrpc":"2.0","id":"k","method":"ping"}\n');
  await until(() => out.includes('"id":"k"'));
  expect(starts.every((start) => !start)).toBe(true);
  out = "";
  input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_diagrams"}}\n');
  await until(() => out.includes('"id":3'));
  expect(starts.at(-1)).toBe(true);
  expect(lines(out)).toEqual([{ jsonrpc: "2.0", id: 3, result: { from: "back" } }]);
  input.end();
  await running;
});

test("serviceDial without start never starts a service; with start it does when nothing answers", async () => {
  const env = { ARCHER_SOCKET: join(tempDir(), "absent.sock") };
  let ensured = 0;
  const dial = serviceDial(env, LAUNCH, {
    ensure: async () => {
      ensured += 1;
    },
  });
  await expect(dial(false)).rejects.toMatchObject({ code: "ENOENT" });
  expect(ensured).toBe(0);
  await expect(dial(true)).rejects.toMatchObject({ code: "ENOENT" });
  expect(ensured).toBe(1);
});

// C5: the limit is per line, in bytes, for complete lines too.
test("a line over the limit in bytes is refused even when complete; under it in characters is not enough", async () => {
  const fake = await fakeService();
  scripted(fake, () => ({ ok: 1 }));
  const env = { ARCHER_SOCKET: fake.socketPath };
  const log: string[] = [];
  const { input, state, running } = await started(env, {
    maxLineBytes: 100,
    log: (line) => {
      log.push(line);
    },
  });
  // 60 characters, 120 bytes, in one complete line from the service: dropped with its connection.
  fake.relays[0]!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "x", params: { s: "é".repeat(60) } })}\n`);
  await until(() => log.some((line) => /from the service is too long/.test(line)));
  expect(state.out).toBe("");
  // From the client, the relay ends.
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { s: "é".repeat(60) } })}\n`);
  await running;
  expect(log.some((line) => /from the client is too long/.test(line))).toBe(true);
});

test("a complete relayed line just over 16 MB from the service is not passed on", async () => {
  const fake = await fakeService();
  scripted(fake, () => ({}));
  const env = { ARCHER_SOCKET: fake.socketPath };
  const log: string[] = [];
  const { input, state, running } = await started(env, {
    log: (line) => {
      log.push(line);
    },
  });
  const big = JSON.stringify({ jsonrpc: "2.0", method: "x", params: { s: "x".repeat(MAX_RELAY_LINE_BYTES) } });
  fake.relays[0]!.write(`${big}\n`);
  await until(() => log.some((line) => /too long/.test(line)), 15_000);
  expect(state.out).toBe("");
  input.end();
  await running;
}, 30_000);

test("lines waiting for a connection are bounded: a request over the bound is answered at once", async () => {
  const old = await fakeService();
  scripted(old, () => ({}));
  const env = { ARCHER_SOCKET: old.socketPath };
  const opened = await openRelay(serviceDial(env, LAUNCH), env);
  if (!("relay" in opened)) throw new Error(JSON.stringify(opened));
  const input = new PassThrough();
  let out = "",
    noticed = false;
  const running = relay(opened.relay, {
    launch: LAUNCH,
    input,
    write: (text) => {
      out += text;
    },
    maxQueuedLines: 2,
    dial: () => new Promise(() => undefined),
    sleep: async () => undefined,
    log: (line) => {
      noticed ||= /closed the connection/.test(line);
    },
  });
  await old.close();
  await until(() => noticed);
  for (let id = 1; id <= 3; id++) input.write(`{"jsonrpc":"2.0","id":${id},"method":"tools/call"}\n`);
  await until(() => out.includes('"id":3'));
  expect(lines(out)).toEqual([
    { jsonrpc: "2.0", id: 3, error: { code: -32603, message: expect.stringMatching(/Too many calls are waiting/) } },
  ]);
  input.end();
  await running;
});

// Decision 10: the relay registers its MCP session as an agent on every connection, under one id.
test("the relay registers its session as an agent before mcpRelay, keeps the id across reconnects, and relays without one on an older service", async () => {
  const fake = await fakeService();
  let next = 0;
  fake.handlers["registerAgent"] = (params) => {
    if (params["agentId"] === "held") throw new Refusal("agent_id_taken", "a live agent holds it");
    return { agentId: typeof params["agentId"] === "string" ? params["agentId"] : `agt_${++next}` };
  };
  scripted(fake, () => ({}));
  const remembered: string[] = [];
  const identity = {
    root: "/p",
    cwd: "/p",
    host: "claude-code" as const,
    label: "Claude Code · p",
    hostPid: 77,
    remember: (id: string) => {
      remembered.push(id);
    },
  };
  const env = { ARCHER_SOCKET: fake.socketPath };
  const dial = serviceDial(env, LAUNCH, { identity });
  const first = await dial(true);
  expect(first.agentId).toBe("agt_1");
  expect(fake.requests.map((r) => r.method)).toEqual(["hello", "registerAgent", "mcpRelay"]);
  expect(fake.requests[1]!.params).toEqual({
    root: "/p",
    cwd: "/p",
    host: "claude-code",
    label: "Claude Code · p",
    hostPid: 77,
  });
  expect(fake.requests[2]!.params).toEqual({ ...LAUNCH, agentId: "agt_1" });
  expect(remembered).toEqual(["agt_1"]);
  first.socket.destroy();
  fake.requests.length = 0;
  await dial(false).then((next) => next.socket.destroy());
  expect(fake.requests[1]!.params).toMatchObject({ agentId: "agt_1" });
  expect(remembered).toEqual(["agt_1"]);
  // An id a live agent elsewhere holds gives way to a new one.
  const taken = serviceDial(env, LAUNCH, { identity: { ...identity, agentId: "held" } });
  fake.requests.length = 0;
  expect((await taken(true)).agentId).toBe("agt_2");
  expect(fake.requests.map((r) => r.method)).toEqual(["hello", "registerAgent", "registerAgent", "mcpRelay"]);
  // An older service: no listeners, the relay still relays.
  const older = await fakeService();
  older.handlers["mcpRelay"] = () => ({ relaying: true });
  const plain = await serviceDial({ ARCHER_SOCKET: older.socketPath }, LAUNCH, { identity: { ...identity } })(true);
  expect(plain.agentId).toBeUndefined();
  expect(older.requests.map((r) => r.method)).toEqual(["hello", "registerAgent", "mcpRelay"]);
  expect(older.requests[2]!.params).toEqual(LAUNCH);
  plain.socket.destroy();
});

test("with no replacement in its window the relay answers what waited, once, and tries again on the next call", async () => {
  const old = await fakeService();
  scripted(old, () => ({ from: "old" }));
  const env = { ARCHER_SOCKET: old.socketPath };
  const dial = serviceDial(env, LAUNCH);
  const opened = await openRelay(dial, env);
  if (!("relay" in opened)) throw new Error(JSON.stringify(opened));
  const input = new PassThrough();
  let out = "",
    clock = 0,
    dials = 0;
  const running = relay(opened.relay, {
    launch: LAUNCH,
    input,
    write: (text) => {
      out += text;
    },
    dial: async () => {
      dials += 1;
      throw new Error("ENOENT");
    },
    now: () => (clock += 10_000),
    sleep: async () => undefined,
  });
  await old.close();
  // The relay has noticed and given up on a replacement before the call comes.
  await until(() => dials > 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write('{"jsonrpc":"2.0","id":5,"method":"tools/call"}\n');
  await until(() => out.includes('"id":5'));
  expect(lines(out)).toEqual([
    { jsonrpc: "2.0", id: 5, error: { code: -32603, message: "Archer's service is not reachable: ENOENT" } },
  ]);
  const before = dials;
  input.write('{"jsonrpc":"2.0","id":6,"method":"tools/call"}\n');
  await until(() => out.includes('"id":6'));
  expect(dials).toBeGreaterThan(before);
  expect(lines(out).filter((line) => line["id"] === 5)).toHaveLength(1);
  input.end();
  await running;
});

test.each([
  ["an older service refuses mcpRelay", async () => (await fakeService()).socketPath, {}],
  [
    "the service has no hostMcp (mcp_unavailable)",
    async () =>
      (
        await fakeService({
          mcpRelay: () => {
            throw new Refusal("mcp_unavailable", "no MCP host");
          },
        })
      ).socketPath,
    {},
  ],
  ["nothing answers and nothing may start", async () => join(tempDir(), "absent.sock"), { ARCHER_AUTO_START: "false" }],
  [
    "the person forces it",
    async () => (await fakeService({ mcpRelay: () => ({ relaying: true }) })).socketPath,
    { ARCHER_MCP_IN_PROCESS: "1" },
  ],
])("the relay falls back to the in-process server when %s", async (_name, socket, extra) => {
  const env = { ARCHER_SOCKET: await socket(), ARCHER_STATE_DIR: tempDir(), ...extra };
  const opened = await openRelay(serviceDial(env, LAUNCH), env);
  expect(opened).toEqual({ fallback: expect.any(String) });
});

const ARCHER = fileURLToPath(new URL("../../src/bin/archer.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));

test("archer mcp end to end: the host's client, the relay process, the service's hostMcp; a swap keeps the session", async () => {
  const dir = tempDir({ ".archer/arch.mmd": FLOW, ".git/HEAD": "" });
  const first = await fakeService();
  const host = createHostMcp({ env: { ARCHER_AUTO_START: "false" } });
  serveRelays(first, host);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", TSX, ARCHER, "mcp"],
    cwd: dir,
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: dir,
      ARCHER_SOCKET: first.socketPath,
      ARCHER_STATE_DIR: join(dir, "state"),
      ARCHER_AUTO_START: "false",
    },
  });
  const client = new Client({ name: "host", version: "0" });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed += 1;
  });
  await client.connect(transport);
  try {
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    // The session registers as an agent (an older service refuses; the relay goes on), then relays.
    expect(first.requests.map((r) => r.method)).toEqual(["hello", "registerAgent", "mcpRelay"]);
    expect(first.requests[1]!.params).toMatchObject({
      root: dir,
      cwd: dir,
      label: expect.not.stringContaining("/tmp"),
    });
    expect(first.requests[2]).toMatchObject({
      method: "mcpRelay",
      params: { cwd: dir, relayVersion: expect.any(String) },
    });
    const listed = await client.callTool({ name: "list_diagrams", arguments: {} });
    expect(listed.structuredContent).toMatchObject({ views: [{ id: "arch" }] });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("write_diagram");
    await first.close();
    const second = await fakeService({}, { socketPath: first.socketPath });
    serveRelays(second, host);
    // The relay dials the replacement by itself, replays the handshake and checks the tools.
    await until(() => (second.relayed[0]?.length ?? 0) >= 3, 10_000);
    const again = await client.callTool({ name: "list_diagrams", arguments: {} });
    expect(again.structuredContent).toMatchObject({ views: [{ id: "arch" }] });
    expect(JSON.parse(second.relayed[0]![0]!)).toMatchObject({ method: "initialize", id: expect.any(Number) });
    // The same build's tools: the client is not told to list them again.
    expect(changed).toBe(0);
  } finally {
    await client.close();
  }
}, 30_000);

test("the relay process loads neither the MCP SDK nor the compiler", async () => {
  const fake = await fakeService();
  scripted(fake, () => ({
    protocolVersion: "2025-06-18",
    capabilities: {},
    serverInfo: { name: "archer", version: "0" },
  }));
  const dir = tempDir({ "archer.toml": "version = 1\n" });
  const record = join(dir, "loaded.txt");
  const recorder = join(dir, "record.mjs");
  writeFileSync(
    recorder,
    `import { registerHooks } from "node:module"; import { appendFileSync } from "node:fs";
registerHooks({ load(url, context, next) { appendFileSync(${JSON.stringify(record)}, url + "\\n"); return next(url, context); } });\n`,
  );
  const child = spawn(process.execPath, ["--import", recorder, "--import", TSX, ARCHER, "mcp"], {
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "", HOME: dir, ARCHER_SOCKET: fake.socketPath, ARCHER_AUTO_START: "false" },
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
  });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  await until(() => out.includes('"id":1'), 15_000);
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  const loaded = readFileSync(record, "utf8").split("\n");
  const ours = loaded.filter((url) => url.includes("/ts/src/")).map((url) => url.slice(url.indexOf("/ts/src/") + 8));
  expect(ours).toContain("mcp/relay.ts");
  expect(
    ours.filter((path) =>
      /^(mermaid|model|application|project|export|terminal|comments|notes)\/|^mcp\/(server|index|host)\.ts$/.test(path),
    ),
  ).toEqual([]);
  expect(
    loaded.filter((url) =>
      /node_modules\/(mermaid|elkjs|markdown-it|dompurify|@modelcontextprotocol|@resvg)\//.test(url),
    ),
  ).toEqual([]);
}, 30_000);

// Decision 4 and 10, service side of the relay: a session's tool calls report its agent in, throttled.
test("hostMcp reports the relay's agent in on tool calls, at most every few seconds, and only with an agent", async () => {
  const fake = await fakeService({ heartbeat: () => ({ state: "next-turn" }) });
  const { connectService } = await import("../../src/service/service-client.ts");
  let clock = 0;
  const host = createHostMcp(
    { env: { ARCHER_AUTO_START: "false" }, findService: () => connectService(fake.socketPath) },
    () => clock,
  );
  const pushed: (string | null)[] = [];
  let wake: (() => void) | null = null;
  const incoming = (async function* () {
    for (;;) {
      while (pushed.length > 0) {
        const line = pushed.shift()!;
        if (line === null) return;
        yield line;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  const sent: string[] = [];
  const push = (line: string | null): void => {
    pushed.push(line);
    wake?.();
    wake = null;
  };
  const serving = host(
    {
      incoming,
      send: (line) => {
        sent.push(line);
      },
    },
    { ...LAUNCH, agentId: "agt_5" },
  );
  push(INITIALIZE);
  push(INITIALIZED);
  const call = (id: number) =>
    push(
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_projects", arguments: {} } }),
    );
  call(1);
  call(2);
  await until(() => fake.requests.some((r) => r.method === "heartbeat"));
  await until(() => sent.some((line) => line.includes('"id":2')));
  expect(fake.requests.filter((r) => r.method === "heartbeat")).toEqual([
    { method: "heartbeat", params: { agentId: "agt_5", via: "cli" } },
  ]);
  clock += 10_000;
  call(3);
  await until(() => fake.requests.filter((r) => r.method === "heartbeat").length === 2);
  push(null);
  await serving;
});
