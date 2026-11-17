// A warm hand-over (ADR 0032): `archer restart` starts the replacement first, warm and waiting;
// only then does the running service hand over, and the replacement binds the same port, socket
// and token at once. A replacement that cannot warm leaves the running service as it was.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { main, type Io } from "../../src/bin/main.ts";
import { connectIfRunning, connectService, ensureService } from "../../src/service/client.ts";
import { listInstances } from "../../src/service/instances.ts";
import { apiBase, cleanUp, isolatedProcessEnv, ownerCookie, project, service, tempDir } from "./support.ts";

afterEach(cleanUp);

async function restart(env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  let out = "",
    err = "";
  const io: Io = {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    env,
    cwd: tempDir(),
    isTTY: false,
    columns: undefined,
  };
  const code = await main(["restart"], io);
  return { code, out, err };
}

/** The raw event stream of a project's page, opened with the owner's session cookie: everything the service writes, as text. */
async function rawEvents(url: string): Promise<{ text: () => string; ended: Promise<void>; close: () => void }> {
  const base = apiBase(url);
  const cookie = (await ownerCookie(base))!;
  let text = "";
  let close = (): void => {};
  const ended = new Promise<void>((done) => {
    const req = request(`${base}api/events`, { headers: { cookie } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => done());
      res.on("close", () => done());
    });
    req.on("error", () => done());
    req.end();
    close = () => req.destroy();
  });
  return { text: () => text, ended, close };
}

async function stopAll(env: Record<string, string>): Promise<void> {
  const replacement = await connectIfRunning({ env });
  if (replacement !== null) {
    await replacement.call("stop", {}).catch(() => undefined);
    replacement.close();
  }
}

test("restart hands over warm: the stream is told to reconnect, and the gap is well under a second", {
  timeout: 60_000,
}, async () => {
  const { svc, state } = await service({ env: { ARCHER_OPEN_BROWSER: "never" } });
  const client = await connectService(svc.socketPath);
  const { url } = await client.call("attach", { root: project() });
  client.close();
  const stream = await rawEvents(url);
  await expect.poll(() => stream.text()).toContain("event: standing");
  const env = isolatedProcessEnv(state, {
    ARCHER_STATE_DIR: state,
    ARCHER_SOCKET: svc.socketPath,
    ARCHER_HOST: "127.0.0.1",
    ARCHER_OPEN_BROWSER: "never",
  });
  try {
    const result = await restart(env);
    expect(result.code, result.err).toBe(0);
    const gap = Number(/in (\d+) ms/.exec(result.out)?.[1]);
    expect(gap).toBeLessThan(1_000);
    await stream.ended;
    expect(stream.text()).toMatch(/retry: \d+\nevent: reconnect\ndata: \{"reason":"handover"\}\n\n$/);
    expect(JSON.parse(readFileSync(join(state, "service.json"), "utf8"))).toEqual({ token: svc.token, port: svc.port });
    // The replacement warmed before the hand-over: its log says so before it serves.
    const log = readFileSync(join(state, "service.log"), "utf8");
    expect(log.indexOf("warm; waiting for the running service to hand over")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("warm; waiting")).toBeLessThan(log.lastIndexOf("service: serving"));
    expect(readdirSync(state).filter((name) => /handover|restarting/.test(name))).toEqual([]);
  } finally {
    stream.close();
    await stopAll(env);
  }
});

test("a hand-over with a wait and an MCP relay open completes within its deadline: the wait answers reconnect, the relay is closed", {
  timeout: 60_000,
}, async () => {
  let relayEnded = false;
  const { svc, state } = await service({
    env: { ARCHER_OPEN_BROWSER: "never" },
    hostMcp: async (endpoint) => {
      for await (const _ of endpoint.incoming) {
        /* held open */
      }
      relayEnded = true;
    },
  });
  const root = project();
  const client = await connectService(svc.socketPath);
  await client.call("attach", { root });
  const { agentId } = await client.call("registerAgent", {
    root,
    cwd: root,
    host: "claude-code",
    label: "Claude Code",
  });
  await client.call("claimListener", { root, agentId });
  const waiting = client.call("waitMessage", { root, agentId, timeoutMs: 600_000 });
  await expect.poll(async () => (await client.call("listListeners", { root })).current.state).toBe("listening");
  const relay = connect(svc.socketPath);
  const relayClosed = new Promise<void>((done) => relay.once("close", () => done()));
  let relayed = "";
  relay.setEncoding("utf8");
  relay.on("data", (chunk: string) => {
    relayed += chunk;
  });
  relay.write(
    `${JSON.stringify({ id: 1, method: "mcpRelay", params: { cwd: root, host: "claude-code", relayVersion: "1" } })}\n`,
  );
  await expect.poll(() => relayed).toContain('"relaying":true');
  const env = isolatedProcessEnv(state, {
    ARCHER_STATE_DIR: state,
    ARCHER_SOCKET: svc.socketPath,
    ARCHER_HOST: "127.0.0.1",
    ARCHER_OPEN_BROWSER: "never",
  });
  try {
    const started = Date.now();
    const result = await restart(env);
    expect(result.code, result.err).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await waiting).toEqual({ reconnect: true });
    await relayClosed;
    await expect.poll(() => relayEnded).toBe(true);
  } finally {
    client.close();
    relay.destroy();
    await stopAll(env);
  }
});

test("restart answers from the replacement, not from the old service still draining a relayed call (O181)", {
  timeout: 60_000,
}, async () => {
  // A relayed call under way holds the old service's drain; until it lets go it still answers a new hello.
  let release = (): void => {},
    received = (): void => {};
  const slow = new Promise<void>((done) => {
    release = done;
  });
  const underWay = new Promise<void>((done) => {
    received = done;
  });
  // It answers half a second into the hand-over: the old service drains it all that time.
  const log = (line: string): void => {
    if (/handing over/.test(line)) setTimeout(release, 500);
  };
  const { svc, state } = await service({
    env: { ARCHER_OPEN_BROWSER: "never" },
    log,
    hostMcp: async (endpoint) => {
      for await (const line of endpoint.incoming) {
        const message = JSON.parse(line) as { id?: number };
        received();
        void slow.then(() => endpoint.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })));
      }
    },
  });
  let oldStopped = false;
  void svc.closed.then(() => {
    oldStopped = true;
  });
  const root = project();
  const setup = await connectService(svc.socketPath);
  await setup.call("attach", { root });
  setup.close();
  const relay = connect(svc.socketPath);
  let relayed = "";
  relay.setEncoding("utf8");
  relay.on("data", (chunk: string) => {
    relayed += chunk;
  });
  relay.write(
    `${JSON.stringify({ id: 1, method: "mcpRelay", params: { cwd: root, host: "claude-code", relayVersion: "1" } })}\n`,
  );
  await expect.poll(() => relayed).toContain('"relaying":true');
  relay.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })}\n`);
  await underWay;
  const env = isolatedProcessEnv(state, {
    ARCHER_STATE_DIR: state,
    ARCHER_SOCKET: svc.socketPath,
    ARCHER_HOST: "127.0.0.1",
    ARCHER_OPEN_BROWSER: "never",
  });
  try {
    const result = await restart(env);
    expect(result.code, result.err).toBe(0);
    // Its answer came from the replacement: the old service had already let go.
    expect(oldStopped).toBe(true);
    expect(readFileSync(join(state, "archer.lock"), "utf8").split(" ")[0]).not.toBe(String(process.pid));
  } finally {
    release();
    relay.destroy();
    await stopAll(env);
  }
});

test("a replacement that cannot start leaves the running service serving, untouched", { timeout: 60_000 }, async () => {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  await client.call("attach", { root: project() });
  try {
    const env = isolatedProcessEnv(state, {
      ARCHER_STATE_DIR: state,
      ARCHER_SOCKET: svc.socketPath,
      ARCHER_THUMBNAIL_FORMAT: "bmp",
    });
    const result = await restart(env);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/replacement .*could not start.*left as it was/);
    expect((await client.call("listProjects", {})).projects).toHaveLength(1);
    expect(readFileSync(join(state, "archer.lock"), "utf8").split(" ")[0]).toBe(String(process.pid));
    expect(readdirSync(state).filter((name) => /handover|restarting/.test(name))).toEqual([]);
  } finally {
    client.close();
  }
});

test("calls made during the hand-over wait for it and succeed, and no stray service is started", {
  timeout: 60_000,
}, async () => {
  const { svc, state } = await service();
  const root = project();
  const setup = await connectService(svc.socketPath);
  await setup.call("attach", { root });
  setup.close();
  const env = isolatedProcessEnv(state, {
    ARCHER_STATE_DIR: state,
    ARCHER_SOCKET: svc.socketPath,
    ARCHER_HOST: "127.0.0.1",
    ARCHER_OPEN_BROWSER: "never",
  });
  const app = createApplication({
    cwd: root,
    env,
    ensureService: () => ensureService({ env }),
    findService: () => connectIfRunning({ env }),
  });
  const failures: string[] = [];
  let calls = 0;
  let swapping = true;
  const caller = (async () => {
    while (swapping) {
      try {
        await app.call("list_projects");
        calls++;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      await new Promise((done) => setTimeout(done, 20));
    }
  })();
  try {
    const result = await restart(env);
    expect(result.code, result.err).toBe(0);
    await new Promise((done) => setTimeout(done, 300));
    swapping = false;
    await caller;
    expect(failures).toEqual([]);
    expect(calls).toBeGreaterThan(3);
    expect(listInstances(env).filter((entry) => entry.stateDir === state)).toHaveLength(1);
    expect(existsSync(join(state, "archer.sock"))).toBe(true);
  } finally {
    swapping = false;
    await caller;
    app.close();
    await stopAll(env);
  }
});

test("while a restart is marked, a front door waits for the replacement instead of starting its own", {
  timeout: 30_000,
}, async () => {
  const { writeRestartMarker, clearRestartMarker } = await import("../../src/service/restart-marker.ts");
  const state = tempDir("archer-state-");
  writeRestartMarker(state, Date.now() + 10_000);
  const started = Date.now();
  // A command that would fail at once if it were started.
  const waiting = ensureService({
    stateDir: state,
    env: { HOME: state },
    command: [process.execPath, "-e", "process.exit(3)"],
    timeoutMs: 15_000,
  });
  await new Promise((done) => setTimeout(done, 400));
  const { svc } = await service({ stateDir: state });
  const client = await waiting;
  try {
    expect((await client.call("hello", { protocolVersion: 1 })).homeUrl).toBe(svc.homeUrl);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  } finally {
    client.close();
    clearRestartMarker(state);
  }
});

test("a restart marker whose process is gone is ignored", async () => {
  const { restartInProgress, restartMarkerPath } = await import("../../src/service/restart-marker.ts");
  const { writeFileSync } = await import("node:fs");
  const state = tempDir("archer-state-");
  writeFileSync(
    restartMarkerPath(state),
    JSON.stringify({ pid: 2 ** 22 + 17, owner: "0123456789ab", until: Date.now() + 60_000 }),
  );
  expect(restartInProgress(state)).toBe(false);
  writeFileSync(
    restartMarkerPath(state),
    JSON.stringify({ pid: process.pid, owner: "0123456789ab", until: Date.now() + 60_000 }),
  );
  expect(restartInProgress(state)).toBe(false);
});

test("a session older than the running service is told once, without failing the call", async () => {
  const { svc } = await service();
  const app = createApplication({
    cwd: tempDir(),
    version: "0.0.0-alpha",
    ensureService: () => connectService(svc.socketPath),
    startService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  });
  try {
    const first = await app.call("start_service");
    expect(first.text).toMatch(
      /\nNote: a newer Archer \(0\.0\.0-dev\) is running than this session's \(0\.0\.0-alpha\); restart this session for the new tools\.$/,
    );
    expect((await app.call("list_projects")).text).not.toMatch(/newer Archer/);
  } finally {
    app.close();
  }
  const current = createApplication({
    cwd: tempDir(),
    version: "0.0.0-dev",
    startService: () => connectService(svc.socketPath),
  });
  try {
    expect((await current.call("start_service")).text).not.toMatch(/newer Archer/);
  } finally {
    current.close();
  }
});

test("a restart while another holds the claim is refused, leaving the claim and the service alone", async () => {
  const { writeRestartMarker, restartInProgress } = await import("../../src/service/restart-marker.ts");
  const { svc, state } = await service();
  writeRestartMarker(state, Date.now() + 30_000); // this process: a live restart
  const env = isolatedProcessEnv(state, { ARCHER_STATE_DIR: state, ARCHER_SOCKET: svc.socketPath });
  const result = await restart(env);
  expect(result.code).not.toBe(0);
  expect(result.err).toMatch(/another restart is under way/);
  expect(restartInProgress(state)).toBe(true);
  const client = await connectService(svc.socketPath);
  try {
    expect((await client.call("hello", { protocolVersion: 1 })).homeUrl).toBe(svc.homeUrl);
  } finally {
    client.close();
  }
});

test("the page a service serves names its application version, so a page loaded before a swap still sees it", async () => {
  const { openPage } = await import("./support.ts");
  const { version } = await import("../../src/version.ts");
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const { url } = await client.call("attach", { root: project() });
  client.close();
  const page = await openPage(url);
  expect(page.body).toContain(`<meta name="archer-application-version" content="${version()}">`);
});
