// Browser recovery discovers compatibility separately from legacy bootstrap.
// These tests read a real service through its authenticated HTTP and SSE paths.
import { afterEach, expect, test, vi } from "vitest";
import { version } from "../../src/bin/main.ts";
import { KEEP_ALIVE_MS } from "../../src/service/http.ts";
import { connectService } from "../../src/service/index.ts";
import { cleanUp, events, exactly, http, json, project, service, apiBase } from "./support.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanUp();
});

async function attached() {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  const { url } = await client.call("attach", { root: project() });
  client.close();
  return { svc, state, url };
}

test("connection advertises an independent browser contract without changing the bootstrap", async () => {
  const { url } = await attached();
  const reply = await http(`${apiBase(url)}api/connection`);
  expect(reply.status).toBe(200);
  expect(reply.headers["cache-control"]).toBe("no-store");
  expect(JSON.parse(reply.body)).toEqual({
    browserProtocolMajor: 1,
    supportedBrowserProtocolMajors: [1],
    serverEpoch: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
    capabilities: ["heartbeat", "instance-settings", "explorations"],
    applicationVersion: version(),
    semanticSchemaVersion: 2,
    heartbeatIntervalMs: KEEP_ALIVE_MS,
  });
  expect(await json(`${apiBase(url)}api/bootstrap`)).toEqual({
    capabilities: {
      comments: true,
      notes: true,
      instanceSettings: true,
      noteEmphasis: true,
      listeners: true,
      commentOperations: 1,
    },
    project: { name: expect.any(String) },
  });
  const unauthorized = await exactly(`${apiBase(url)}api/connection`);
  expect([unauthorized.status, unauthorized.body]).toEqual([404, ""]);
  expect(
    (
      await http(`${apiBase(url)}api/connection`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(404);
  expect((await http(`${apiBase(url)}api/connection/extra`)).status).toBe(404);
});

test("process epoch remains stable within a service and changes across restart with the same browser URL", async () => {
  const { svc, state, url } = await attached();
  const before = JSON.parse(
    (await http(`${apiBase(url)}api/connection`, { headers: { connection: "close" } })).body,
  ) as { serverEpoch: string };
  expect(JSON.parse((await http(`${apiBase(url)}api/connection`, { headers: { connection: "close" } })).body)).toEqual(
    before,
  );
  await svc.close();
  const { svc: replacement } = await service({ stateDir: state });
  expect(replacement.homeUrl).toBe(svc.homeUrl);
  const after = JSON.parse(
    (await http(`${apiBase(url)}api/connection`, { headers: { connection: "close" } })).body,
  ) as { serverEpoch: string };
  expect(after.serverEpoch).not.toBe(before.serverEpoch);
  expect({ ...after, serverEpoch: before.serverEpoch }).toEqual(before);
});

test("heartbeat is a named periodic SSE event carrying the connection epoch and retains legacy keep-alive", async () => {
  const { url } = await attached();
  const interval = vi.spyOn(globalThis, "setInterval");
  const stream = await events(`${apiBase(url)}api/events`);
  try {
    expect(stream.status).toBe(200);
    const schedule = interval.mock.calls.find(([, delay]) => delay === KEEP_ALIVE_MS);
    expect(schedule).toBeDefined();
    const heartbeat = stream.next("heartbeat", 1000);
    // Drive the real production interval callback; real network I/O remains live.
    (schedule![0] as () => void)();
    const { serverEpoch } = (await json(`${apiBase(url)}api/connection`)) as { serverEpoch: string };
    expect(await heartbeat).toEqual({ serverEpoch });
    expect(stream.comments).toContain("keep-alive");
  } finally {
    stream.close();
  }
});
