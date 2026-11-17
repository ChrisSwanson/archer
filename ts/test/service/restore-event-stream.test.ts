// A native EventSource fails for good on any answer but 200 text/event-stream. After a start,
// saved projects open in the background (server review S2), and a page that was following one
// reconnects meanwhile: its event stream must stay retryable until the project is open.

import { afterEach, expect, test } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { connectService } from "../../src/service/service-client.ts";
import { apiBase, cleanUp, events, http, project, service } from "./support.ts";

const originalOpen = ProjectState.open;
afterEach(async () => {
  ProjectState.open = originalOpen;
  await cleanUp();
});

test("an event stream for a project still opening is a retryable stream, then the project's own", async () => {
  const root = project();
  const first = await service();
  const setup = await connectService(first.svc.socketPath);
  const base = apiBase((await setup.call("attach", { root })).url);
  setup.close();
  await first.svc.close();

  let release = (): void => {};
  let entered = (): void => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const opening = new Promise<void>((done) => {
    entered = done;
  });
  ProjectState.open = (async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === root) {
      entered();
      await gate;
    }
    return originalOpen.apply(ProjectState, args);
  }) as typeof originalOpen;
  const second = await service({ stateDir: first.state });
  const restarted = base.replace(new URL(base).origin, new URL(second.svc.homeUrl).origin);
  try {
    await opening;
    const early = await http(`${restarted}api/events`);
    expect(early.status).toBe(200);
    expect(early.headers["content-type"]).toBe("text/event-stream");
    // A retry hint, and no standing state: the stream ends, and the browser reconnects soon.
    expect(early.body).toMatch(/^retry: \d+$/mu);
    expect(early.body).not.toContain("standing");
  } finally {
    release();
  }
  const client = await connectService(second.svc.socketPath);
  try {
    await client.call("getModel", { root, viewId: "flow" });
  } finally {
    client.close();
  }
  const stream = await events(`${restarted}api/events`);
  try {
    expect(stream.status).toBe(200);
    expect(await stream.next("standing")).toMatchObject({ seq: expect.any(Number) });
  } finally {
    stream.close();
  }
});

test("an event stream for an unknown project is still refused once every project is open", async () => {
  const { svc } = await service();
  const reply = await http(`${svc.homeUrl}p/nowhere/api/events`);
  expect(reply.status).toBe(404);
});
