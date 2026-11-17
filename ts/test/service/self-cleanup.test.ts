// A service registers itself (ADR 0031) and stops itself when it is abandoned: any instance when
// its state directory disappears, an isolated one also after an idle period. 42 test daemons
// and 5 stragglers serving deleted temp dirs (about 4 GB) were found on the host.

import { existsSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startService } from "../../src/service/index.ts";
import { listInstances } from "../../src/service/instances.ts";
import { version } from "../../src/bin/main.ts";
import { cleanUp, service, tempDir } from "./support.ts";

afterEach(cleanUp);

const stopped = (closed: Promise<void>, ms: number): Promise<boolean> =>
  Promise.race([closed.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), ms))]);

test("a service registers while it serves and removes its entry on a clean stop", async () => {
  const { svc, state } = await service();
  const env = { HOME: state };
  const [entry] = listInstances(env);
  expect(entry).toMatchObject({
    pid: process.pid,
    version: version(),
    protocolVersion: 1,
    serviceName: "default",
    stateDir: state,
    socketPath: svc.socketPath,
    kind: "isolated",
  });
  expect(entry!.url).toBe(new URL(svc.homeUrl).origin + "/");
  expect(entry!.url).not.toContain(svc.token);
  await svc.close();
  expect(listInstances(env)).toEqual([]);
});

test("a service on the default state directory registers as the main one", async () => {
  const home = tempDir("archer-home-");
  const svc = await startService({
    forceHttp: true,
    log: () => {},
    warmStart: false,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  });
  try {
    expect(listInstances({ HOME: home })).toMatchObject([
      { kind: "main", stateDir: join(home, ".local", "state", "archer") },
    ]);
  } finally {
    await svc.close();
  }
});

test("any instance stops itself when its state directory is removed", async () => {
  const { svc, state } = await service({ housekeepingMs: 50 });
  rmSync(state, { recursive: true, force: true });
  expect(await stopped(svc.closed, 3_000)).toBe(true);
  expect(existsSync(state), "stopping does not recreate the removed directory").toBe(false);
});

test("an isolated instance stops after its idle period with no client, and records when it went idle", async () => {
  const { svc, state } = await service({ idleTimeoutMs: 600, housekeepingMs: 50 });
  await expect.poll(() => listInstances({ HOME: state })[0]?.idleSince ?? null, { timeout: 2_000 }).not.toBeNull();
  expect(await stopped(svc.closed, 3_000)).toBe(true);
  expect(listInstances({ HOME: state })).toEqual([]);
});

test("a connected client keeps an isolated instance from its idle stop", async () => {
  const { svc, state } = await service({ idleTimeoutMs: 300, housekeepingMs: 50 });
  const socket = connect(svc.socketPath);
  await new Promise((ok) => socket.once("connect", ok));
  try {
    expect(await stopped(svc.closed, 1_200)).toBe(false);
    expect(listInstances({ HOME: state })[0]?.idleSince).toBeNull();
  } finally {
    socket.destroy();
  }
  expect(await stopped(svc.closed, 3_000)).toBe(true);
});

test("the main instance never stops on idle", async () => {
  const home = tempDir("archer-home-");
  const svc = await startService({
    forceHttp: true,
    log: () => {},
    warmStart: false,
    idleTimeoutMs: 200,
    housekeepingMs: 50,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  });
  try {
    expect(await stopped(svc.closed, 1_000)).toBe(false);
  } finally {
    await svc.close();
  }
});

test("ARCHER_IDLE_TIMEOUT_MS sets the idle period and refuses a value that is not a whole number", async () => {
  const state = tempDir("archer-state-");
  await expect(service({ stateDir: state, env: { ARCHER_IDLE_TIMEOUT_MS: "soon" } })).rejects.toThrow(
    /ARCHER_IDLE_TIMEOUT_MS/,
  );
  const { svc } = await service({ housekeepingMs: 50, env: { ARCHER_IDLE_TIMEOUT_MS: "300" } });
  expect(await stopped(svc.closed, 3_000)).toBe(true);
});

test("ARCHER_IDLE_TIMEOUT_MS=0 never stops an isolated instance (the devkit sandbox's setting, O126)", async () => {
  const { svc } = await service({ housekeepingMs: 50, env: { ARCHER_IDLE_TIMEOUT_MS: "0" } });
  try {
    expect(await stopped(svc.closed, 1_000)).toBe(false);
  } finally {
    await svc.close();
  }
});

test("a stop after the state directory was replaced leaves the replacement's socket alone", async () => {
  const { mkdirSync } = await import("node:fs");
  const { svc: first, state } = await service({ housekeepingMs: 60_000 });
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { mode: 0o700 });
  const { svc: second } = await service({ stateDir: state });
  await first.close(); // as its housekeeping would, finding the directory replaced
  expect(existsSync(second.socketPath)).toBe(true);
});

test("a service with an attached project stops on removal without recreating its state directory", async () => {
  const { connectService } = await import("../../src/service/client.ts");
  const { project } = await import("./support.ts");
  const { svc, state } = await service({ housekeepingMs: 50 });
  const client = await connectService(svc.socketPath);
  await client.call("attach", { root: project() });
  client.close();
  rmSync(state, { recursive: true, force: true });
  expect(await stopped(svc.closed, 3_000)).toBe(true);
  expect(existsSync(state)).toBe(false);
});
