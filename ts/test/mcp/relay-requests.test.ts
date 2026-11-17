// The relay's request bookkeeping (REVIEW-0.7.0 decision 20): client request ids are remapped into a
// relay-private id space, so no client id collides with the relay's own; a call answered "outcome
// unknown" is never sent later; a queued call that was never sent is; an initialize reaches each
// replacement once; a cancelled call is forgotten; after a stop only a request that needs Archer
// starts it. The service end is a raw socket server that records every line per connection.
import { connect, createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { OUTCOME_UNKNOWN, relay, type RelaySocket } from "../../src/mcp/relay.ts";
import { RELAY_HANDOVER_NOTICE } from "../../src/mcp/host-contract.ts";

const LAUNCH = { cwd: "/p", host: "claude-code" as const, relayVersion: "t" };
const INIT =
  '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}';
const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick();
  }
}

type Line = Record<string, unknown>;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

/** A service end: each connection is already relaying; every line it gets is recorded; `answer` scripts replies. */
async function service() {
  const dir = mkdtempSync(join(tmpdir(), "archer-relay-requests-"));
  const path = join(dir, "s.sock");
  const conns: { socket: Socket; lines: Line[] }[] = [];
  const state = {
    answer: (_m: Line, _c: { socket: Socket; lines: Line[] }, _index: number): void => undefined,
    refuse: false,
  };
  const starts: boolean[] = [];
  const server: Server = createServer((socket) => {
    const conn = { socket, lines: [] as Line[] };
    const index = conns.push(conn) - 1;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, end)) as Line;
        buffer = buffer.slice(end + 1);
        conn.lines.push(message);
        state.answer(message, conn, index);
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    for (const conn of conns) conn.socket.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const dial = async (start: boolean): Promise<RelaySocket> => {
    starts.push(start);
    if (state.refuse) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(path);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    return { socket, leftover: "" };
  };
  return { conns, dial, state, starts };
}

const reply = (socket: Socket, id: unknown, result: unknown): void => {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

async function running(s: Awaited<ReturnType<typeof service>>) {
  const input = new PassThrough();
  const out = { text: "" };
  const done = relay(await s.dial(true), {
    launch: LAUNCH,
    input,
    write: (text) => {
      out.text += text;
    },
    dial: s.dial,
    sleep: (ms) => tick(Math.min(ms, 20)),
  });
  const sent = (): Line[] =>
    out.text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Line);
  return {
    input,
    out,
    sent,
    end: async () => {
      input.end();
      await done;
    },
  };
}

// Codex N1, Claude 8: the queued call was failed "outcome unknown" and then sent to the next copy.
test("a call queued behind the replay is never failed 'outcome unknown': it is sent once, to the copy that answers it", async () => {
  const s = await service();
  s.state.answer = (m, conn, index) => {
    if (index === 0 && m["method"] === "initialize") reply(conn.socket, m["id"], {});
    if (index >= 2 && m["id"] !== undefined) reply(conn.socket, m["id"], { ran: m["method"] });
  };
  const r = await running(s);
  r.input.write(`${INIT}\n`);
  await until(() => r.sent().some((line) => line["id"] === 0));
  s.conns[0]!.socket.destroy();
  await until(() => s.conns.length === 2 && s.conns[1]!.lines.length >= 1);
  r.input.write('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"create_comment"}}\n');
  await tick(50);
  s.conns[1]!.socket.destroy();
  await until(() => r.sent().some((line) => line["id"] === 5));
  await tick(50);
  const fives = r.sent().filter((line) => line["id"] === 5);
  expect(fives).toEqual([{ jsonrpc: "2.0", id: 5, result: { ran: "tools/call" } }]);
  expect(s.conns[1]!.lines.some((line) => line["method"] === "tools/call")).toBe(false);
  expect(s.conns[2]!.lines.filter((line) => line["method"] === "tools/call")).toHaveLength(1);
  await r.end();
});

test("a call sent to a copy that went away is answered 'outcome unknown' once and never sent again", async () => {
  const s = await service();
  s.state.answer = (m, conn, index) => {
    if (m["method"] === "initialize") reply(conn.socket, m["id"], {});
    if (index >= 1 && m["id"] !== undefined) reply(conn.socket, m["id"], { ran: m["method"] });
  };
  const r = await running(s);
  r.input.write(`${INIT}\n${INITIALIZED}\n`);
  await until(() => r.sent().some((line) => line["id"] === 0));
  r.input.write('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"create_comment"}}\n');
  await until(() => s.conns[0]!.lines.some((line) => line["method"] === "tools/call"));
  s.conns[0]!.socket.destroy();
  await until(() => r.sent().some((line) => line["id"] === 5));
  r.input.write('{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read_note"}}\n');
  await until(() => r.sent().some((line) => line["id"] === 6));
  expect(r.sent().filter((line) => line["id"] === 5)).toEqual([
    { jsonrpc: "2.0", id: 5, error: { code: -32603, message: OUTCOME_UNKNOWN } },
  ]);
  expect(s.conns[1]!.lines.filter((line) => line["method"] === "tools/call")).toHaveLength(1);
  await r.end();
});

// O56: a planned hand-over (ADR 0032) cut a call the old copy never ran, and the agent saw "outcome unknown".
// The old copy says so: a call it refused as not run, and any it had not answered when it announced the
// hand-over, go to the replacement once; nothing more is written to the old copy after the notice.
test("a hand-over's notice and a 'not run' refusal send the calls the old copy never ran to the replacement", async () => {
  const s = await service();
  s.state.answer = (m, conn, index) => {
    if (index === 0 && m["method"] === "initialize") reply(conn.socket, m["id"], {});
    // The first call is still open at the notice; the second arrived during the drain and is refused.
    if (index === 0 && m["method"] === "tools/call" && (m["params"] as { name: string }).name === "refused") {
      conn.socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: m["id"], error: { code: -32000, message: "handing over; not run", data: { archer: "handover_not_run" } } })}\n`,
      );
      conn.socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: RELAY_HANDOVER_NOTICE })}\n`);
      setTimeout(() => conn.socket.end(), 50);
    }
    if (index >= 1 && m["id"] !== undefined)
      reply(conn.socket, m["id"], {
        ran: m["method"],
        name: (m["params"] as { name?: string } | undefined)?.name ?? null,
      });
  };
  const r = await running(s);
  r.input.write(`${INIT}\n${INITIALIZED}\n`);
  await until(() => r.sent().some((line) => line["id"] === 0));
  r.input.write('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"unread"}}\n');
  await until(() => s.conns[0]!.lines.some((line) => line["method"] === "tools/call"));
  r.input.write('{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"refused"}}\n');
  await until(() => s.conns[0]!.lines.filter((line) => line["method"] === "tools/call").length === 2);
  await tick(10);
  r.input.write('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"after"}}\n');
  await until(() => [5, 6, 7].every((id) => r.sent().some((line) => line["id"] === id)));
  await tick(50);
  expect(r.sent().filter((line) => [5, 6, 7].includes(line["id"] as number))).toEqual([
    { jsonrpc: "2.0", id: 5, result: { ran: "tools/call", name: "unread" } },
    { jsonrpc: "2.0", id: 6, result: { ran: "tools/call", name: "refused" } },
    { jsonrpc: "2.0", id: 7, result: { ran: "tools/call", name: "after" } },
  ]);
  expect(r.sent().some((line) => line["method"] === RELAY_HANDOVER_NOTICE)).toBe(false);
  expect(s.conns[0]!.lines.filter((line) => line["method"] === "tools/call")).toHaveLength(2);
  expect(
    s.conns[1]!.lines.filter((line) => line["method"] === "tools/call").map(
      (line) => (line["params"] as { name: string }).name,
    ),
  ).toEqual(["unread", "refused", "after"]);
  await r.end();
});

// O56: a refusal alone (no notice: its drain hit the deadline, or an older service) says nothing of a call
// the copy took, which may still be running: that one stays "outcome unknown", never sent twice.
test("without the notice a call the old copy took is still 'outcome unknown'; only the refused one goes on", async () => {
  const s = await service();
  s.state.answer = (m, conn, index) => {
    if (index === 0 && m["method"] === "initialize") reply(conn.socket, m["id"], {});
    if (index === 0 && m["method"] === "tools/call" && (m["params"] as { name: string }).name === "refused") {
      conn.socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: m["id"], error: { code: -32000, message: "handing over; not run", data: { archer: "handover_not_run" } } })}\n`,
      );
      setTimeout(() => conn.socket.end(), 50);
    }
    if (index >= 1 && m["id"] !== undefined)
      reply(conn.socket, m["id"], { ran: (m["params"] as { name?: string } | undefined)?.name ?? null });
  };
  const r = await running(s);
  r.input.write(`${INIT}\n${INITIALIZED}\n`);
  await until(() => r.sent().some((line) => line["id"] === 0));
  r.input.write('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"running"}}\n');
  await until(() => s.conns[0]!.lines.some((line) => line["method"] === "tools/call"));
  r.input.write('{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"refused"}}\n');
  await until(() => [5, 6].every((id) => r.sent().some((line) => line["id"] === id)));
  await tick(50);
  expect(r.sent().filter((line) => [5, 6].includes(line["id"] as number))).toEqual([
    { jsonrpc: "2.0", id: 5, error: { code: -32603, message: OUTCOME_UNKNOWN } },
    { jsonrpc: "2.0", id: 6, result: { ran: "refused" } },
  ]);
  expect(
    s.conns[1]!.lines.filter((line) => line["method"] === "tools/call").map(
      (line) => (line["params"] as { name: string }).name,
    ),
  ).toEqual(["refused"]);
  await r.end();
});

// Claude 9: handshake() wrote the stored initialize and flush() wrote the queued copy again.
test("an initialize sent while no copy is up reaches the replacement once and is answered once", async () => {
  const s = await service();
  s.state.answer = (m, conn) => {
    if (m["id"] !== undefined) reply(conn.socket, m["id"], {});
  };
  const r = await running(s);
  s.state.refuse = true;
  s.conns[0]!.socket.destroy();
  await tick(60);
  r.input.write(`${INIT}\n`);
  await tick(30);
  s.state.refuse = false;
  await until(() => r.sent().some((line) => line["id"] === 0));
  await tick(60);
  expect(s.conns[1]!.lines.filter((line) => line["method"] === "initialize")).toHaveLength(1);
  expect(r.sent().filter((line) => line["id"] === 0)).toHaveLength(1);
  await r.end();
});

// Codex N7: a client id shaped like the relay's own was swallowed as the relay's tool-list answer.
test("client ids never reach the service: any id, the relay's own shapes included, gets its own answer", async () => {
  const s = await service();
  s.state.answer = (m, conn) => {
    if (m["id"] !== undefined)
      reply(conn.socket, m["id"], { method: m["method"], tag: (m["params"] as { tag?: unknown } | undefined)?.tag });
  };
  const r = await running(s);
  const ids: unknown[] = ["archer-relay-tools-1", "archer-relay-replay-1", 1, "1", 0];
  for (const [index, id] of ids.entries())
    r.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { tag: index } })}\n`);
  await until(() => r.sent().length === ids.length);
  for (const [index, id] of ids.entries())
    expect(r.sent().filter((line) => line["id"] === id)).toEqual([
      { jsonrpc: "2.0", id, result: { method: "tools/list", tag: index } },
    ]);
  expect(r.sent().some((line) => line["method"] === "notifications/tools/list_changed")).toBe(false);
  // The service saw only ids of the relay's own, each once.
  const seen = s.conns[0]!.lines.map((line) => line["id"]);
  expect(new Set(seen.map((id) => `${typeof id}:${String(id)}`)).size).toBe(ids.length);
  expect(seen.some((id) => ids.includes(id) && typeof id === "string")).toBe(false);
  await r.end();
});

// Claude 7 (relay side): a call the client cancelled is not answered "outcome unknown" after a swap.
test("a cancelled call is forgotten: the service is told under its own id, and a swap does not answer it", async () => {
  const s = await service();
  s.state.answer = (m, conn) => {
    if (m["method"] === "initialize") reply(conn.socket, m["id"], {});
  };
  const r = await running(s);
  r.input.write(`${INIT}\n${INITIALIZED}\n`);
  await until(() => r.sent().some((line) => line["id"] === 0));
  r.input.write('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"x"}}\n');
  await until(() => s.conns[0]!.lines.some((line) => line["method"] === "tools/call"));
  const asked = s.conns[0]!.lines.find((line) => line["method"] === "tools/call")!["id"];
  r.input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7,"reason":"Esc"}}\n');
  await until(() => s.conns[0]!.lines.some((line) => line["method"] === "notifications/cancelled"));
  expect(s.conns[0]!.lines.find((line) => line["method"] === "notifications/cancelled")).toEqual({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: asked, reason: "Esc" },
  });
  // A late answer is dropped, and losing the copy answers nothing for 7.
  reply(s.conns[0]!.socket, asked, { late: true });
  await tick(30);
  s.conns[0]!.socket.destroy();
  await until(() => s.conns.length === 2);
  await tick(50);
  expect(r.sent().filter((line) => line["id"] === 7)).toEqual([]);
  // A call still waiting for a connection is taken out of the queue instead.
  s.state.refuse = true;
  s.conns[1]!.socket.destroy();
  await tick(30);
  r.input.write(
    '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"y"}}\n{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":8}}\n',
  );
  await tick(30);
  s.state.refuse = false;
  await until(() => s.conns.length === 3 && s.conns[2]!.lines.length >= 1);
  await tick(50);
  expect(
    s.conns[2]!.lines.some((line) => line["method"] === "tools/call" || line["method"] === "notifications/cancelled"),
  ).toBe(false);
  await r.end();
});

// Claude 13: after `archer stop` a host's keepalive ping or a notification must not bring Archer back.
test("after a stop a ping is answered by the relay and starts nothing; notifications and listings start nothing; a tool call does", async () => {
  const s = await service();
  s.state.answer = (m, conn) => {
    if (m["id"] !== undefined) reply(conn.socket, m["id"], { from: "service", method: m["method"] });
  };
  const input = new PassThrough();
  let out = "",
    clock = 0;
  const done = relay(await s.dial(true), {
    launch: LAUNCH,
    input,
    write: (text) => {
      out += text;
    },
    dial: s.dial,
    sleep: async () => undefined,
    now: () => (clock += 1000),
  });
  const sent = (): Line[] =>
    out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Line);
  s.starts.length = 0;
  s.state.refuse = true;
  s.conns[0]!.socket.destroy();
  await until(() => s.starts.length > 0);
  await tick(50);
  input.write(
    '{"jsonrpc":"2.0","id":"k","method":"ping"}\n{"jsonrpc":"2.0","method":"notifications/roots/list_changed"}\n',
  );
  await until(() => sent().some((line) => line["id"] === "k"));
  expect(sent().find((line) => line["id"] === "k")).toEqual({ jsonrpc: "2.0", id: "k", result: {} });
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await until(() => sent().some((line) => line["id"] === 2));
  expect(sent().find((line) => line["id"] === 2)).toMatchObject({
    error: { message: expect.stringMatching(/not running.*next tool call starts it/) },
  });
  expect(s.starts.every((start) => !start)).toBe(true);
  s.state.refuse = false;
  input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_diagrams"}}\n');
  await until(() => sent().some((line) => line["id"] === 3));
  expect(s.starts.at(-1)).toBe(true);
  expect(sent().find((line) => line["id"] === 3)).toEqual({
    jsonrpc: "2.0",
    id: 3,
    result: { from: "service", method: "tools/call" },
  });
  input.end();
  await done;
});

test.each(["initialize", "resources/read", "prompts/get"])("after a stop %s starts Archer", async (method) => {
  const s = await service();
  s.state.answer = (m, conn) => {
    if (m["id"] !== undefined) reply(conn.socket, m["id"], {});
  };
  const input = new PassThrough();
  let out = "",
    clock = 0;
  const done = relay(await s.dial(true), {
    launch: LAUNCH,
    input,
    write: (text) => {
      out += text;
    },
    dial: s.dial,
    sleep: async () => undefined,
    now: () => (clock += 1000),
  });
  s.starts.length = 0;
  s.state.refuse = true;
  s.conns[0]!.socket.destroy();
  await until(() => s.starts.length > 0);
  await tick(50);
  s.state.refuse = false;
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method, params: {} })}\n`);
  await until(() => out.includes('"id":4'));
  expect(s.starts.at(-1)).toBe(true);
  input.end();
  await done;
});
