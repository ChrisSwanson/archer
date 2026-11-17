// The MCP relay's socket upgrade (ADR 0035 §6): after `{ok:true,result:{relaying:true}}` the connection
// carries raw MCP JSON-RPC lines both ways, served by the HostMcp the service was given.
import { connect, type Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { RELAY_HANDOVER_NOTICE, type HostMcp, type RelayLaunch } from "../../src/mcp/host-contract.ts";
import { MAX_RELAY_LINE_BYTES, MAX_REQUEST_LINE_BYTES } from "../../src/service/socket.ts";
import { cleanUp, project, service } from "./support.ts";

afterEach(cleanUp);

/** A raw connection: what it receives, line by line, and whether it closed. */
function raw(path: string): Promise<{ socket: Socket; lines: string[]; closed: Promise<void> }> {
  return new Promise((ok, fail) => {
    const socket = connect(path);
    const lines: string[] = [];
    let buffer = "";
    const closed = new Promise<void>((done) => socket.once("close", () => done()));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        lines.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    socket.once("connect", () => ok({ socket, lines, closed }));
    socket.once("error", fail);
  });
}

/** A fake HostMcp held to the contract: echoes each JSON-RPC line back, records the launch facts. */
function echo(): { host: HostMcp; launches: RelayLaunch[]; done: Promise<void> } {
  const launches: RelayLaunch[] = [];
  let finished = (): void => {};
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const host: HostMcp = async (endpoint, launch) => {
    launches.push(launch);
    for await (const line of endpoint.incoming) {
      const message = JSON.parse(line) as { id?: number; method?: string };
      endpoint.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: message.method } }));
    }
    finished();
  };
  return { host, launches, done };
}

const RELAY = JSON.stringify({
  id: 7,
  method: "mcpRelay",
  params: { cwd: "/code/app", host: "claude-code", relayVersion: "1" },
});

test("after the relaying answer, lines are MCP both ways; lines sent before the answer are the relay's too", async () => {
  const fake = echo();
  const { svc } = await service({ hostMcp: fake.host });
  const client = await raw(svc.socketPath);
  // The relay writes its first MCP line without waiting for the answer: it is held, not read as a request.
  client.socket.write(`${RELAY}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  await expect.poll(() => client.lines.length).toBe(2);
  expect(JSON.parse(client.lines[0]!)).toEqual({ id: 7, ok: true, result: { relaying: true } });
  expect(JSON.parse(client.lines[1]!)).toEqual({ jsonrpc: "2.0", id: 1, result: { echoed: "initialize" } });
  client.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await expect.poll(() => client.lines.length).toBe(3);
  expect(JSON.parse(client.lines[2]!)).toEqual({ jsonrpc: "2.0", id: 2, result: { echoed: "tools/list" } });
  expect(fake.launches).toEqual([{ cwd: "/code/app", host: "claude-code", relayVersion: "1" }]);
  client.socket.end();
  await fake.done;
});

test("a relayed line may exceed the management limit (a large diagram source) up to the relay's own", async () => {
  const fake = echo();
  const { svc } = await service({ hostMcp: fake.host });
  const client = await raw(svc.socketPath);
  client.socket.write(`${RELAY}\n`);
  await expect.poll(() => client.lines.length).toBe(1);
  const big = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { source: "x".repeat(MAX_REQUEST_LINE_BYTES + 10) },
  });
  client.socket.write(`${big}\n`);
  await expect.poll(() => client.lines.length).toBe(2);
  expect(JSON.parse(client.lines[1]!)).toEqual({ jsonrpc: "2.0", id: 3, result: { echoed: "tools/call" } });
  client.socket.end();
  await fake.done;
});

test("a relay line over MAX_RELAY_LINE_BYTES closes the connection without an Archer reply", async () => {
  const fake = echo();
  const { svc } = await service({ hostMcp: fake.host });
  const client = await raw(svc.socketPath);
  client.socket.write(`${RELAY}\n`);
  await expect.poll(() => client.lines.length).toBe(1);
  client.socket.write("x".repeat(MAX_RELAY_LINE_BYTES + 10));
  await client.closed;
  expect(client.lines).toHaveLength(1);
  await fake.done;
});

test("without a HostMcp the request is refused and the connection stays a management connection", async () => {
  const { svc } = await service();
  const client = await raw(svc.socketPath);
  client.socket.write(`${RELAY}\n${JSON.stringify({ id: 8, method: "hello", params: { protocolVersion: 1 } })}\n`);
  await expect.poll(() => client.lines.length).toBe(2);
  const answers = client.lines.map((line) => JSON.parse(line) as { id: number; ok: boolean; error?: { code: string } });
  expect(answers.find((a) => a.id === 7)).toMatchObject({ ok: false, error: { code: "mcp_unavailable" } });
  expect(answers.find((a) => a.id === 8)).toMatchObject({ ok: true });
  client.socket.destroy();
});

// Review 0.7.0 C5 (decision 9): every complete line is checked, in bytes, before it is used.
test("a complete management line over MAX_REQUEST_LINE_BYTES in bytes is refused, not answered", async () => {
  const { svc } = await service();
  const client = await raw(svc.socketPath);
  // Under the limit in characters, over it in bytes: "é" is two bytes.
  const pad = "é".repeat(Math.ceil(MAX_REQUEST_LINE_BYTES / 2) + 10);
  client.socket.write(`${JSON.stringify({ id: 4, method: "hello", params: { protocolVersion: 1, pad } })}\n`);
  await client.closed;
  expect(client.lines.map((line) => JSON.parse(line) as { ok: boolean; error?: { code: string } })).toEqual([
    expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "request_too_large" }) }),
  ]);
});

test("a complete relay line over MAX_RELAY_LINE_BYTES closes the connection and never reaches the host", async () => {
  const seen: number[] = [];
  const host: HostMcp = async (endpoint) => {
    for await (const line of endpoint.incoming) seen.push(Buffer.byteLength(line));
  };
  const { svc } = await service({ hostMcp: host });
  const client = await raw(svc.socketPath);
  client.socket.write(`${RELAY}\n`);
  await expect.poll(() => client.lines.length).toBe(1);
  client.socket.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { s: "x".repeat(MAX_RELAY_LINE_BYTES) } })}\n`,
  );
  await client.closed;
  expect(seen).toEqual([]);
});

test("lines held while mcpRelay is answered are bounded: too many close the connection", async () => {
  const { createServer } = await import("node:net");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { serveConnection, MAX_HELD_LINES } = await import("../../src/service/socket.ts");
  let release = (): void => {};
  const answered = new Promise<void>((done) => {
    release = done;
  });
  const server = createServer((socket) =>
    serveConnection(
      socket,
      async () => {
        await answered;
        return { relaying: true } as never;
      },
      () => {},
      {
        relay: async (endpoint) => {
          for await (const _ of endpoint.incoming) {
            /* drain */
          }
        },
      },
    ),
  );
  const path = join(mkdtempSync(join(tmpdir(), "archer-held-")), "s.sock");
  await new Promise<void>((ok) => server.listen(path, ok));
  try {
    const client = await raw(path);
    client.socket.write(`${RELAY}\n`);
    client.socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" })}\n`.repeat(MAX_HELD_LINES + 1),
    );
    await client.closed;
    release();
  } finally {
    server.close();
  }
});

test("pinListener is the page's alone: the management socket does not know it", async () => {
  const { svc } = await service();
  const client = await raw(svc.socketPath);
  client.socket.write(`${JSON.stringify({ id: 5, method: "pinListener", params: { root: "/x", agentId: null } })}\n`);
  await expect.poll(() => client.lines.length).toBe(1);
  expect(JSON.parse(client.lines[0]!)).toMatchObject({ id: 5, ok: false, error: { code: "unknown_method" } });
  client.socket.destroy();
});

// Review 0.7.0 decision 8 (L M5, C11): a hand-over lets a relayed call in flight finish before the relay
// socket ends; a call arriving during that drain is answered "not run", never silently dropped.
test("a hand-over waits for in-flight relayed calls, refuses new ones, then ends the relay", async () => {
  let release = (): void => {};
  const slow = new Promise<void>((done) => {
    release = done;
  });
  const host: HostMcp = async (endpoint) => {
    for await (const line of endpoint.incoming) {
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (message.method === "tools/call")
        void slow.then(() => endpoint.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { done: true } })));
      else if (message.id !== undefined) endpoint.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    }
  };
  const { svc } = await service({ hostMcp: host });
  const relayed = await raw(svc.socketPath);
  relayed.socket.write(`${RELAY}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })}\n`);
  await expect.poll(() => relayed.lines.length).toBe(1);
  const { connectService } = await import("../../src/service/service-client.ts");
  const manager = await connectService(svc.socketPath);
  expect(await manager.call("handover", {})).toEqual({ stopping: true });
  manager.close();
  await new Promise((done) => setTimeout(done, 100));
  relayed.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await expect.poll(() => relayed.lines.length).toBe(2);
  expect(JSON.parse(relayed.lines[1]!)).toMatchObject({
    jsonrpc: "2.0",
    id: 2,
    error: { data: { archer: "handover_not_run" } },
  });
  release();
  await relayed.closed;
  const messages = relayed.lines.map((line) => JSON.parse(line) as { id?: number; method?: string });
  expect(messages.find((message) => message.id === 1)).toMatchObject({ result: { done: true } });
  // O56: once every call it took is answered, it says so last, so the relay sends what is still open on.
  expect(messages.at(-1)).toEqual({ jsonrpc: "2.0", method: RELAY_HANDOVER_NOTICE });
  expect(messages.findIndex((message) => message.id === 1)).toBeLessThan(messages.length - 1);
  await svc.closed;
});

test("mcpRelay's agentId reaches the HostMcp's launch facts, and a malformed one is refused", async () => {
  const fake = echo();
  const { svc } = await service({ hostMcp: fake.host });
  const bad = await raw(svc.socketPath);
  bad.socket.write(
    `${JSON.stringify({ id: 1, method: "mcpRelay", params: { cwd: "/code/app", host: "codex", relayVersion: "1", agentId: "x" } })}\n`,
  );
  await expect.poll(() => bad.lines.length).toBe(1);
  expect(JSON.parse(bad.lines[0]!)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  bad.socket.destroy();
  // Round 2 (Claude 14): an id registered on another connection, or never, is ignored.
  const stranger = await raw(svc.socketPath);
  stranger.socket.write(
    `${JSON.stringify({ id: 2, method: "mcpRelay", params: { cwd: "/code/app", host: "codex", relayVersion: "1", agentId: "ag-0123456789ab" } })}\n`,
  );
  await expect.poll(() => fake.launches.length).toBe(1);
  expect(fake.launches[0]).toEqual({ cwd: "/code/app", host: "codex", relayVersion: "1" });
  stranger.socket.end();
  await fake.done;
});

test("mcpRelay's agentId reaches the HostMcp only when registerAgent on that connection returned it (Claude 14)", async () => {
  const fake = echo();
  const { svc } = await service({ hostMcp: fake.host });
  const root = project();
  const client = await raw(svc.socketPath);
  client.socket.write(
    `${JSON.stringify({ id: 1, method: "registerAgent", params: { root, cwd: root, host: "codex", label: "Codex" } })}\n`,
  );
  await expect.poll(() => client.lines.length).toBe(1);
  const { agentId } = (JSON.parse(client.lines[0]!) as { result: { agentId: string } }).result;
  client.socket.write(
    `${JSON.stringify({ id: 2, method: "mcpRelay", params: { cwd: root, host: "codex", relayVersion: "1", agentId } })}\n`,
  );
  await expect.poll(() => fake.launches.length).toBe(1);
  expect(fake.launches[0]).toEqual({ cwd: root, host: "codex", relayVersion: "1", agentId });
  client.socket.end();
  await fake.done;
});

// Round 2 (decision 20, Claude N7): the SDK never answers a cancelled request, so it counts as finished.
test("a relayed call the client cancelled does not hold the hand-over's drain", async () => {
  const host: HostMcp = async (endpoint) => {
    for await (const line of endpoint.incoming) {
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (message.method !== "tools/call" && message.id !== undefined)
        endpoint.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    }
  };
  const { svc } = await service({ hostMcp: host });
  const relayed = await raw(svc.socketPath);
  relayed.socket.write(
    `${RELAY}\n${JSON.stringify({ jsonrpc: "2.0", id: "call-1", method: "tools/call", params: {} })}\n`,
  );
  await expect.poll(() => relayed.lines.length).toBe(1);
  relayed.socket.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "call-1", reason: "Esc" } })}\n`,
  );
  await new Promise((done) => setTimeout(done, 50));
  const { connectService } = await import("../../src/service/service-client.ts");
  const manager = await connectService(svc.socketPath);
  const started = Date.now();
  expect(await manager.call("handover", {})).toEqual({ stopping: true });
  manager.close();
  await relayed.closed;
  expect(Date.now() - started).toBeLessThan(2_000);
  await svc.closed;
});

// PD-2 (security round 1): a relayed call that stops the service hosting it (setup_network_access restarts
// Archer onto another bind) must still be able to answer: on a stop, a relay with calls in flight is kept
// open, refusing new calls as not run, until they are answered (or a deadline), after the service has let go
// of its socket, port and locks so that a replacement can start meanwhile.
test("a stop asked by a relayed call releases the socket first, then lets that call answer before the relay ends", async () => {
  const { connectService } = await import("../../src/service/service-client.ts");
  let socketPath = "";
  let goneBeforeAnswer: boolean | undefined;
  const host: HostMcp = async (endpoint) => {
    for await (const line of endpoint.incoming) {
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (message.method !== "tools/call") {
        if (message.id !== undefined) endpoint.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        continue;
      }
      void (async () => {
        const self = await connectService(socketPath);
        await self.call("stop", {});
        self.close();
        // The service it stopped no longer answers on its socket: a replacement could bind it now.
        for (let tries = 0; tries < 200; tries++) {
          const reached = await connectService(socketPath).then(
            (c) => {
              c.close();
              return true;
            },
            () => false,
          );
          if (!reached) {
            goneBeforeAnswer = true;
            break;
          }
          await new Promise((done) => setTimeout(done, 25));
        }
        goneBeforeAnswer ??= false;
        endpoint.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { done: true } }));
      })();
    }
  };
  const { svc } = await service({ hostMcp: host });
  socketPath = svc.socketPath;
  const relayed = await raw(svc.socketPath);
  relayed.socket.write(`${RELAY}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })}\n`);
  await relayed.closed;
  const messages = relayed.lines.map((line) => JSON.parse(line) as { id?: number; method?: string });
  expect(goneBeforeAnswer).toBe(true);
  expect(messages.find((message) => message.id === 1)).toMatchObject({ result: { done: true } });
  await svc.closed;
});

test("a stop with no relayed call in flight ends the relay at once", async () => {
  const fake = echo();
  const { svc } = await service({ hostMcp: fake.host });
  const relayed = await raw(svc.socketPath);
  relayed.socket.write(`${RELAY}\n`);
  await expect.poll(() => relayed.lines.length).toBe(1);
  const { connectService } = await import("../../src/service/service-client.ts");
  const manager = await connectService(svc.socketPath);
  const started = Date.now();
  expect(await manager.call("stop", {})).toEqual({ stopping: true });
  manager.close();
  await relayed.closed;
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(relayed.lines.slice(1)).toEqual([]);
  await svc.closed;
});

// A long line arriving in small reads (macOS delivers Unix-socket data ~8 KiB at a time) is read in linear
// time: each byte is measured about once. Re-measuring the whole unfinished line on every read was quadratic
// (a 16 MiB relay line took ~15 s of event loop on macOS). Counted, not timed, so it holds on any host.
test("a long line arriving in small reads is measured once, not once per read", async () => {
  const { Duplex } = await import("node:stream");
  const { vi } = await import("vitest");
  const { serveConnection } = await import("../../src/service/socket.ts");
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  serveConnection(
    socket as never,
    async () => ({}) as never,
    () => {},
  );
  const piece = "x".repeat(1024),
    pieces = Math.floor(MAX_REQUEST_LINE_BYTES / piece.length);
  let measured = 0;
  const byteLength = Buffer.byteLength;
  const spy = vi.spyOn(Buffer, "byteLength").mockImplementation(((value: string, encoding?: BufferEncoding) => {
    const n = byteLength(value, encoding);
    measured += n;
    return n;
  }) as typeof Buffer.byteLength);
  try {
    for (let i = 0; i < pieces; i++) socket.emit("data", piece);
  } finally {
    spy.mockRestore();
  }
  const sent = pieces * piece.length;
  // Linear: each read measured once. The quadratic reader measured about sent * pieces / 2 (~512 MiB here).
  expect(measured).toBeLessThanOrEqual(2 * sent);
  socket.destroy();
});
