import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { createHostMcp } from "../../src/mcp/host.ts";
import { openRelay, relay, serviceDial } from "../../src/mcp/relay.ts";
import { cleanUp, project, service } from "../service/support.ts";

afterEach(cleanUp);

// Run the real service-side host and the real relay. Geometry remains the Application's,
// while transport framing, initialization and result shaping run end to end.
test("service MCP relay returns the same exact measurement as offline Application", async () => {
  const root = project();
  const { svc } = await service({ hostMcp: createHostMcp({}) });
  const launch = { cwd: root, host: "codex" as const, relayVersion: "measure-test" };
  const env = { ARCHER_SOCKET: svc.socketPath };
  const dial = serviceDial(env, launch);
  const opened = await openRelay(dial, env);
  expect("relay" in opened).toBe(true);
  if (!("relay" in opened)) throw new Error(JSON.stringify(opened));
  const input = new PassThrough();
  const messages: Record<string, unknown>[] = [];
  // A reply is awaited, not polled: the first measurement on a fresh layout pool starts its worker thread and
  // loads the compiler and layout engine (~0.7 s idle, several seconds on a loaded host), within the product's
  // own explicit budget (LAYOUT_LIMITS.explicitMs) but past expect.poll's 1 s default. The test timeout bounds it.
  const waiting = new Map<unknown, (message: Record<string, unknown>) => void>();
  const reply = (id: number) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const found = messages.find((message) => message["id"] === id);
      if (found === undefined) waiting.set(id, resolve);
      else resolve(found);
    });
  let buffer = "";
  const running = relay(opened.relay, {
    launch,
    input,
    dial,
    write(text) {
      buffer += text;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const message = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        messages.push(message);
        waiting.get(message["id"])?.(message);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
      }
    },
  });
  const app = createApplication({ cwd: root });
  const send = (message: object) => input.write(`${JSON.stringify(message)}\n`);
  try {
    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "measurement-test", version: "0" },
      },
    });
    await reply(0);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const args = { viewId: "flow", states: [{ mode: "full" }] };
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "measure_diagram", arguments: args } });
    const answer = await reply(1);
    expect(answer["error"]).toBeUndefined();
    const result = answer["result"] as { structuredContent: unknown };
    expect(result.structuredContent).toEqual((await app.call("measure_diagram", args)).structured);
    expect(result.structuredContent).toMatchObject({ status: "ready", complete: true });
  } finally {
    input.end();
    await running;
    app.close();
  }
});
