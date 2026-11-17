import { request } from "node:http";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/index.ts";
import {
  apiBase,
  asOwner,
  cleanUp,
  commentOperation,
  exactly,
  http,
  project,
  service,
  serviceBase,
} from "./support.ts";

afterEach(cleanUp);

test("shutdown drains an admitted comment body and rejects new requests before closing project state", async () => {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  const { url } = await client.call("attach", { root: project() });
  client.close();
  // As the page sends it: a create as its operation (ADR 0016).
  const body = JSON.stringify(
    commentOperation.create({
      target: "view:flow",
      anchor: { kind: "view" },
      body: "Retain this comment through restart",
    }),
  );
  let continueRequest!: () => void;
  const admitted = new Promise<void>((resolve) => {
    continueRequest = resolve;
  });
  // The owner's browser, signed in before the drain begins.
  const headers = await asOwner(`${apiBase(url)}api/comments`, "POST", {
    expect: "100-continue",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    connection: "close",
  });
  const req = request(`${apiBase(url)}api/comments`, { method: "POST", headers });
  req.once("continue", continueRequest);
  const response = new Promise<{ status: number; body: string }>((resolve) => {
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += String(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", (error) => resolve({ status: -1, body: error.message }));
  });
  req.flushHeaders();
  await admitted; // Production HTTP server has admitted these headers, before the body arrives.
  const closing = svc.close();
  try {
    const rejected = await http(`${apiBase(url)}api/comments`, {
      method: "POST",
      headers: { connection: "close" },
      body: body,
    });
    expect(rejected.status).toBe(503);
    expect(rejected.headers["retry-after"]).toBe("1");
    const unauthorized = await exactly(`${apiBase(url)}api/comments`, {
      method: "POST",
      headers: { origin: new URL(url).origin, "content-type": "application/json", connection: "close" },
      body,
    });
    expect([unauthorized.status, unauthorized.body]).toEqual([404, ""]);
    const retryingStream = await http(`${apiBase(url)}api/events`, { headers: { connection: "close" } });
    expect(retryingStream.status).toBe(200);
    expect(retryingStream.headers["content-type"]).toBe("text/event-stream");
    expect(retryingStream.body).toBe(": restarting\n\n");
    const deniedStream = await exactly(`${apiBase(url)}api/events`, {
      headers: { connection: "close" },
    });
    expect([deniedStream.status, deniedStream.body]).toEqual([404, ""]);
    const unknownProject = await http(`${serviceBase(svc.homeUrl)}p/missing-project/api/events`, {
      headers: { connection: "close" },
    });
    expect([unknownProject.status, unknownProject.body]).toEqual([404, ""]);
    req.end(body);
    const saved = await response;
    expect(saved.status, saved.body).toBe(200);
    const thread = (JSON.parse(saved.body) as { thread: { id: string } }).thread;
    await closing;
    await service({ stateDir: state });
    expect(
      JSON.parse(
        (await http(`${apiBase(url)}api/comments?target=view:flow`, { headers: { connection: "close" } })).body,
      ),
    ).toMatchObject({ threads: [{ id: thread.id }] });
  } finally {
    req.destroy();
    await closing;
  }
});

test("shutdown retains writer ownership until an admitted management attachment finishes", async () => {
  const { vi } = await import("vitest");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ProjectState } = await import("../../src/service/project-state.ts");
  const lines: string[] = [];
  const { svc, state } = await service({ log: (line) => lines.push(line) });
  const interval = vi.spyOn(globalThis, "setTimeout");
  const client = await connectService(svc.socketPath);
  let admitted!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const open = ProjectState.open;
  const spy = vi.spyOn(ProjectState, "open").mockImplementationOnce(async (...args) => {
    admitted();
    await gate;
    return open(...args);
  });
  const attach = client.call("attach", { root: project() }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await started;
  const closed = svc.close();
  try {
    await expect(client.call("listProjects", {})).rejects.toMatchObject({ error: { code: "service_stopping" } });
    const deadline = interval.mock.calls.find(([, delay]) => delay === 5000);
    expect(deadline).toBeDefined();
    (deadline![0] as () => void)();
    expect(lines.some((line) => line.includes("retaining writer ownership"))).toBe(true);
    expect(existsSync(join(state, "archer.lock"))).toBe(true);
    finish();
    const answer = await attach;
    expect(answer).toHaveProperty("value");
    await closed;
    expect(existsSync(join(state, "archer.lock"))).toBe(false);
    const { svc: replacement } = await service({ stateDir: state });
    const reader = await connectService(replacement.socketPath);
    try {
      expect((await reader.call("listProjects", {})).projects).toHaveLength(1);
    } finally {
      reader.close();
    }
  } finally {
    finish();
    spy.mockRestore();
    interval.mockRestore();
    client.close();
    await closed;
  }
});

test("HTTP drain deadline closes an incomplete request with explicit uncertainty", async () => {
  const { vi } = await import("vitest");
  const lines: string[] = [];
  const { svc } = await service({ log: (line) => lines.push(line) });
  const client = await connectService(svc.socketPath);
  const { url } = await client.call("attach", { root: project() });
  client.close();
  const timer = vi.spyOn(globalThis, "setTimeout");
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const req = request(`${apiBase(url)}api/comments`, {
    method: "POST",
    headers: await asOwner(`${apiBase(url)}api/comments`, "POST", { expect: "100-continue", "content-length": "100" }),
  });
  req.once("continue", admit);
  req.on("error", () => {});
  req.flushHeaders();
  try {
    await admitted;
    const closing = svc.close();
    const deadline = timer.mock.calls.find(([, delay]) => delay === 5000);
    expect(deadline).toBeDefined();
    (deadline![0] as () => void)();
    await closing;
    expect(lines.some((line) => line.includes("interrupted write outcomes may be unknown"))).toBe(true);
  } finally {
    req.destroy();
    timer.mockRestore();
  }
});
