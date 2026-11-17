// `archer status`, `archer stop --stale` and `archer preferences` (ADR 0031), run in-process.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main } from "../../src/bin/main.ts";
import { ownerToken } from "../../src/comments/lock.ts";
import { registerInstance, type InstanceEntry } from "../../src/service/instances.ts";
import { serviceDirs } from "../../src/service/paths.ts";
import { cleanUp, service, tempDir } from "./support.ts";

afterEach(cleanUp);
const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) await new Promise((ok) => server.close(ok));
});

async function run(
  env: Record<string, string>,
  ...argv: string[]
): Promise<{ code: number; out: string; err: string }> {
  let out = "",
    err = "";
  const code = await main(argv, {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    env,
    isTTY: false,
    columns: 120,
  });
  return { code, out, err };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A process that is not this one, listed in the registry as an Archer copy. */
async function listed(env: Record<string, string>, over: Partial<InstanceEntry>): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  await new Promise((ok) => child.once("spawn", ok));
  const pid = child.pid!;
  await expect.poll(() => typeof ownerToken(pid)).toBe("string");
  registerInstance(env, {
    pid,
    owner: ownerToken(pid) as string,
    version: "0.0.0-dev",
    protocolVersion: 1,
    serviceName: "default",
    stateDir: env["HOME"]!,
    socketPath: join(env["HOME"]!, "archer.sock"),
    url: "https://127.0.0.1:1/",
    kind: "isolated",
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    idleSince: null,
    ...over,
  });
  return child;
}

test("status says when nothing is running", async () => {
  expect(await run({ HOME: tempDir("archer-home-") }, "status")).toMatchObject({
    code: 0,
    out: "No Archer is running.\n",
  });
});

test("status lists a registered copy: kind, version, pid, age, idle, url and state directory", async () => {
  const { svc, state } = await service();
  const { code, out } = await run({ HOME: state }, "status");
  expect(code).toBe(0);
  const [header, row] = out.trimEnd().split("\n");
  expect(header).toMatch(/^KIND\s+VERSION\s+PID\s+AGE\s+IDLE\s+URL\s+STATE DIR/);
  expect(row).toMatch(
    new RegExp(
      `^isolated\\s+0\\.0\\.0-dev\\s+${process.pid}\\s+\\d+s\\s+\\S+\\s+${new URL(svc.homeUrl).origin}/\\s+${state}`,
    ),
  );
  const json = JSON.parse((await run({ HOME: state }, "status", "--json")).out) as { instances: unknown[] };
  expect(json.instances).toMatchObject([{ kind: "isolated", pid: process.pid, stateDir: state }]);
});

test("status says when a copy is open to the network: where, since when and how to turn it off; a loopback copy says nothing", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  await listed(env, { url: "https://192.168.1.42:40399/", stateDir: home });
  writeFileSync(
    join(home, "network-access.json"),
    JSON.stringify({
      enabled: true,
      host: "192.168.1.42",
      bind: "0.0.0.0",
      since: "2026-10-22T10:00:00.000Z",
      tlsDirectory: "x",
      tlsCert: "x",
      tlsKey: "x",
      caCert: "x",
      caFingerprint256: "x",
      certificateExpiresAt: "2027-10-22T10:00:00.000Z",
    }),
  );
  const text = (await run(env, "status")).out;
  expect(text).toContain("open to your network at https://192.168.1.42:40399/ since 2026-10-22T10:00:00.000Z");
  expect(text).toContain("archer network-access off");
  const json = JSON.parse((await run(env, "status", "--json")).out) as { instances: Record<string, unknown>[] };
  expect(json.instances[0]).toMatchObject({
    networkAccess: { address: "https://192.168.1.42:40399/", since: "2026-10-22T10:00:00.000Z" },
  });

  const quiet = tempDir("archer-home-");
  await listed({ HOME: quiet }, { stateDir: quiet });
  const local = await run({ HOME: quiet }, "status");
  expect(local.out).not.toMatch(/network/i);
  expect(JSON.parse((await run({ HOME: quiet }, "status", "--json")).out).instances[0]).not.toHaveProperty(
    "networkAccess",
  );
});

test("stop --stale stops an older copy or one whose state directory is gone, verified by owner identity", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  const older = await listed(env, { version: "0.0.0-alpha" });
  const orphan = await listed(env, { stateDir: join(home, "deleted") });
  const current = await listed(env, {});
  const { code, out } = await run(env, "stop", "--stale");
  expect(code).toBe(0);
  expect(out).toMatch(new RegExp(`stopped isolated 0\\.0\\.0-alpha \\(pid ${older.pid}.*older version`));
  expect(out).toMatch(new RegExp(`stopped isolated 0\\.0\\.0-dev \\(pid ${orphan.pid}.*state directory is gone`));
  expect(alive(older.pid!)).toBe(false);
  expect(alive(orphan.pid!)).toBe(false);
  expect(alive(current.pid!)).toBe(true);
});

test("stop --stale stops an isolated copy idle for a minute, and keeps a busy one", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  const idle = await listed(env, { idleSince: new Date(Date.now() - 61_000).toISOString() });
  const recent = await listed(env, { idleSince: new Date(Date.now() - 5_000).toISOString() });
  const busy = await listed(env, { idleSince: null });
  await run(env, "stop", "--stale");
  expect(alive(idle.pid!)).toBe(false);
  expect(alive(recent.pid!)).toBe(true);
  expect(alive(busy.pid!)).toBe(true);
});

test("the main copy is stopped as stale only with --include-main", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  const mainCopy = await listed(env, { kind: "main", version: "0.0.0-alpha" });
  expect((await run(env, "stop", "--stale")).out).toMatch(/kept main .*--include-main/);
  expect(alive(mainCopy.pid!)).toBe(true);
  await run(env, "stop", "--stale", "--include-main");
  expect(alive(mainCopy.pid!)).toBe(false);
});

test("an entry whose pid now runs another process is never signalled", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  const child = await listed(env, { version: "0.0.0-alpha" });
  // The same pid, another incarnation: rewrite the entry with a different owner.
  registerInstance(env, {
    pid: child.pid!,
    owner: "0123456789ab",
    version: "0.0.0-alpha",
    protocolVersion: 1,
    serviceName: "default",
    stateDir: home,
    socketPath: join(home, "archer.sock"),
    url: "https://127.0.0.1:1/",
    kind: "isolated",
    startedAt: new Date(0).toISOString(),
    idleSince: null,
  });
  const { out } = await run(env, "stop", "--stale");
  expect(out.match(/stopped/g)).toHaveLength(1);
  expect(alive(child.pid!)).toBe(false);
});

test("stop refuses --include-main without --stale", async () => {
  expect(await run({ HOME: tempDir("archer-home-") }, "stop", "--include-main")).toMatchObject({ code: 2 });
});

test("preferences shows the flag, and set records it with a dated note", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  expect((await run(env, "preferences")).out).toBe(
    `${join(home, ".archer", "preferences.md")} (not written yet)\ninstances: ask\n`,
  );
  const set = await run(
    env,
    "preferences",
    "set",
    "instances",
    "reuse-main",
    "--note",
    "the person keeps the old one for now",
  );
  expect(set).toMatchObject({
    code: 0,
    out: `instances: reuse-main (recorded in ${join(home, ".archer", "preferences.md")})\n`,
  });
  expect(readFileSync(join(home, ".archer", "preferences.md"), "utf8")).toMatch(
    /instances: reuse-main — the person keeps the old one for now\n$/,
  );
  expect((await run(env, "preferences")).out).toMatch(/instances: reuse-main/);
  expect(await run(env, "preferences", "set", "instances", "never")).toMatchObject({ code: 2 });
  expect(await run(env, "preferences", "set", "colour", "blue")).toMatchObject({ code: 2 });
});

test("an older build on an ARCHER_SOCKET is never matched to the default main's lock", async () => {
  const home = tempDir("archer-home-");
  const { svc } = await service({ env: { HOME: home } }); // holds a lock of its own elsewhere
  void svc;
  const socketPath = join(tempDir("archer-sock-"), "other.sock");
  const server = createServer((socket) =>
    socket.on("data", (chunk) => {
      const { id } = JSON.parse(String(chunk)) as { id: number };
      socket.write(
        `${JSON.stringify({ id, ok: true, result: { protocolVersion: 1, version: "0.0.0-alpha", homeUrl: "https://127.0.0.1:1/t/", serviceName: "default" } })}\n`,
      );
    }),
  );
  await new Promise<void>((ok) => server.listen(socketPath, ok));
  servers.push(server);
  // A main lock in the default state dir naming a live process that is not that socket's.
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  await new Promise((ok) => child.once("spawn", ok));
  await expect.poll(() => typeof ownerToken(child.pid!)).toBe("string");
  const stateDir = serviceDirs({ HOME: home }).stateDir;
  mk(stateDir, { recursive: true, mode: 0o700 });
  wf(join(stateDir, "archer.lock"), `${child.pid} ${ownerToken(child.pid!)}\n`);
  await run({ HOME: home, ARCHER_SOCKET: socketPath }, "stop", "--stale", "--include-main");
  expect(alive(child.pid!)).toBe(true);
});
