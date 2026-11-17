// The management boundary, single-account parts (security rubric R4, probe P10): the socket and state
// directories are the owner's alone, unsafe override locations are refused, and HTTP reaches no
// management-only method. (Another OS account connecting is P10's other part: a real other uid is run
// in Docker by tools/devkit/security/other-account-socket.mjs.)
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { socketMethods } from "../../../tools/devkit/security/inventory-model.mjs";
import { AGENT_METHODS } from "../../src/agents/contract.ts";
import { relay, serviceDial, type RelayLaunchFacts } from "../../src/mcp/relay.ts";
import { connectService } from "../../src/service/service-client.ts";
import { startService, type RunningService } from "../../src/service/service.ts";
import { closeFakes, fakeService } from "../bin/fake-agent-service.ts";
import { cleanUp, http, project, service, slugOf } from "../service/support.ts";

const dirs: string[] = [];
const started: RunningService[] = [];
const servers: Server[] = [];
const realLstat = fs.lstatSync;
afterEach(async () => {
  for (const svc of started.splice(0)) await svc.close();
  for (const server of servers.splice(0)) await new Promise((ok) => server.close(ok));
  await cleanUp();
  await closeFakes();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** A short private base (socket paths are limited to 103 bytes). */
const base = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "arch-r4-")));
  dirs.push(dir);
  return dir;
};
const envFor = (home: string, extra: Record<string, string>) => ({
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  ARCHER_HOME: join(home, ".archer"),
  ARCHER_OPEN_BROWSER: "never",
  ...extra,
});
const start = async (home: string, extra: Record<string, string>): Promise<RunningService> => {
  const svc = await startService({
    forceHttp: true,
    warmStart: false,
    prefetchThumbnails: false,
    log: () => {},
    env: envFor(home, extra),
  });
  started.push(svc);
  return svc;
};
const owner = process.getuid?.();

test("the state and socket directories, and the secrets in them, are the owner's alone", async () => {
  const home = base();
  const stateDir = join(home, "state"),
    socketDir = join(home, "sock");
  const svc = await start(home, { ARCHER_STATE_DIR: stateDir, ARCHER_SOCKET: join(socketDir, "a.sock") });
  expect(svc.socketPath).toBe(join(socketDir, "a.sock"));
  for (const dir of [stateDir, socketDir]) {
    const stat = lstatSync(dir);
    expect([dir, stat.isDirectory(), stat.mode & 0o777, stat.uid]).toEqual([dir, true, 0o700, owner]);
  }
  const client = await connectService(svc.socketPath);
  try {
    await client.call("issueAccess", { label: "r4" });
  } finally {
    client.close();
  }
  for (const file of ["service.json", "access-grants.json"])
    expect([file, statSync(join(stateDir, file)).mode & 0o077]).toEqual([file, 0]);
  // The 0700 directory is the protection (rubric §1, socket.ts); the socket is also 0600 once it listens,
  // whatever the process umask (C-36), and stays the owner's.
  const socket = lstatSync(svc.socketPath);
  expect([socket.isSocket(), socket.mode & 0o777, socket.uid]).toEqual([true, 0o600, owner]);
});

test("an ARCHER_STATE_DIR or ARCHER_SOCKET directory that is a symbolic link is refused", async () => {
  const home = base();
  const real = join(home, "real");
  mkdirSync(real, { mode: 0o700 });
  const link = join(home, "link");
  symlinkSync(real, link);
  await expect(start(home, { ARCHER_STATE_DIR: link })).rejects.toThrow(/not a directory \(a link or a file\)/);
  await expect(
    start(home, { ARCHER_STATE_DIR: join(home, "state"), ARCHER_SOCKET: join(link, "a.sock") }),
  ).rejects.toThrow(/not a directory \(a link or a file\)/);
  expect(existsSync(join(real, "service.json"))).toBe(false);
  expect(existsSync(join(real, "a.sock"))).toBe(false);
});

// R4 (re-score 1, C-26/X-12; EX-S1-04 withdrawn): a directory the person points ARCHER_STATE_DIR or
// ARCHER_SOCKET at is refused when it is loose, never tightened: another account may already have planted
// a socket or files in it. Only Archer's own default directory (which it creates 0700) is still repaired.
test("a group-readable or world-writable override directory is refused, left as it was, with the fix in the message", async () => {
  const home = base();
  const stateDir = join(home, "shared");
  mkdirSync(stateDir);
  chmodSync(stateDir, 0o750);
  await expect(start(home, { ARCHER_STATE_DIR: stateDir })).rejects.toThrow(
    `${stateDir} is readable by others; run: chmod 700 ${stateDir}`,
  );
  expect(statSync(stateDir).mode & 0o777).toBe(0o750);
  expect(existsSync(join(stateDir, "service.json"))).toBe(false);
  const socketDir = join(home, "sockets");
  mkdirSync(socketDir);
  chmodSync(socketDir, 0o777);
  await expect(
    start(home, { ARCHER_STATE_DIR: join(home, "state"), ARCHER_SOCKET: join(socketDir, "a.sock") }),
  ).rejects.toThrow(`${socketDir} is readable by others; run: chmod 700 ${socketDir}`);
  expect(statSync(socketDir).mode & 0o777).toBe(0o777);
  expect(existsSync(join(socketDir, "a.sock"))).toBe(false);
});

test("Archer's own default state directory is created 0700, and an older loose one of the owner's is still tightened", async () => {
  const home = base();
  const svc = await start(home, { XDG_STATE_HOME: join(home, "xdg") });
  expect(svc.stateDir).toBe(join(home, "xdg", "archer"));
  expect(statSync(svc.stateDir).mode & 0o777).toBe(0o700);
  await svc.close();
  started.splice(started.indexOf(svc), 1);
  const older = base();
  mkdirSync(join(older, ".local", "state", "archer"), { recursive: true });
  chmodSync(join(older, ".local", "state", "archer"), 0o755);
  const again = await start(older, {});
  expect(again.stateDir).toBe(join(older, ".local", "state", "archer"));
  expect(statSync(again.stateDir).mode & 0o777).toBe(0o700);
});

/** A listening Unix socket at `path` that answers nothing (a planted impostor). */
const impostor = async (path: string): Promise<Server> => {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((ok) => server.listen(path, ok));
  servers.push(server);
  return server;
};

test("the client refuses a socket in a loose directory, or one that is not a socket, before sending anything", async () => {
  const home = base();
  const dir = join(home, "loose");
  mkdirSync(dir, { mode: 0o700 });
  await impostor(join(dir, "a.sock"));
  chmodSync(dir, 0o777);
  await expect(connectService(join(dir, "a.sock"))).rejects.toThrow(`${dir} is readable by others`);
  const plain = join(home, "plain");
  mkdirSync(plain, { mode: 0o700 });
  writeFileSync(join(plain, "a.sock"), "");
  await expect(connectService(join(plain, "a.sock"))).rejects.toThrow(`${join(plain, "a.sock")} is not a socket`);
});

test("a socket owned by another account is refused by the client and not taken for a running service at start", async () => {
  const home = base();
  const dir = join(home, "sock");
  mkdirSync(dir, { mode: 0o700 });
  const path = join(dir, "a.sock");
  await impostor(path);
  const uid = process.getuid!();
  const planted = realLstat(path).ino;
  // Another account's socket in our directory, as lstat shows it: its uid is not ours.
  const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
    const stat = realLstat(p, o as never) as fs.Stats;
    if (String(p) !== path || stat.ino !== planted) return stat;
    return new Proxy(stat, {
      get: (target, key) => (key === "uid" ? uid + 1 : (Reflect.get(target, key, target) as unknown)),
    });
  }) as never);
  syncBuiltinESMExports();
  try {
    await expect(connectService(path)).rejects.toThrow(`${path} is owned by another user`);
    await expect(start(home, { ARCHER_STATE_DIR: join(home, "state"), ARCHER_SOCKET: path })).rejects.toThrow(
      `${path} is owned by another user`,
    );
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  // The planted socket is still there: the service neither deferred to it nor removed it.
  expect(realLstat(path).ino).toBe(planted);
});

/** Pretends lstat sees `path` (while it is still the inode planted now) as another account's. */
const foreignOwner = (path: string): (() => void) => {
  const uid = process.getuid!(),
    planted = realLstat(path).ino;
  const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
    const stat = realLstat(p, o as never) as fs.Stats;
    if (String(p) !== path || stat.ino !== planted) return stat;
    return new Proxy(stat, {
      get: (target, key) => (key === "uid" ? uid + 1 : (Reflect.get(target, key, target) as unknown)),
    });
  }) as never);
  syncBuiltinESMExports();
  return () => {
    spy.mockRestore();
    syncBuiltinESMExports();
  };
};

const LAUNCH: RelayLaunchFacts = { cwd: "/p", host: "claude-code", relayVersion: "0.0.0-r4" };

// X-12 (re-score 2): the MCP relay dials through the same admission as the regular client. The fake
// endpoints here answer hello and mcpRelay, so only the admission stands between them and the relay.
test("the MCP relay's dial refuses a loose directory, a linked socket or another account's socket, sends nothing and starts nothing", async () => {
  const fake = await fakeService({ mcpRelay: () => ({ relaying: true }) });
  let ensured = 0;
  const dial = (path: string) =>
    serviceDial({ ARCHER_SOCKET: path }, LAUNCH, {
      ensure: async () => {
        ensured += 1;
      },
    });
  chmodSync(fake.dir, 0o777);
  for (const start of [false, true])
    await expect(dial(fake.socketPath)(start)).rejects.toThrow(`${fake.dir} is readable by others`);
  chmodSync(fake.dir, 0o700);
  const home = base();
  const linkDir = join(home, "links");
  mkdirSync(linkDir, { mode: 0o700 });
  symlinkSync(fake.socketPath, join(linkDir, "a.sock"));
  for (const start of [false, true])
    await expect(dial(join(linkDir, "a.sock"))(start)).rejects.toThrow(`${join(linkDir, "a.sock")} is not a socket`);
  const restore = foreignOwner(fake.socketPath);
  try {
    for (const start of [false, true])
      await expect(dial(fake.socketPath)(start)).rejects.toThrow(`${fake.socketPath} is owned by another user`);
  } finally {
    restore();
  }
  expect(fake.requests).toEqual([]);
  expect(ensured).toBe(0);
  // The control: the same endpoint, admitted, is dialled.
  const ok = await dial(fake.socketPath)(false);
  ok.socket.destroy();
  expect(fake.requests.map((r) => r.method)).toEqual(["hello", "mcpRelay"]);
});

test("the MCP relay's reconnect goes through the same admission: a socket that became unsafe is never dialled", async () => {
  const fake = await fakeService({ mcpRelay: () => ({ relaying: true }) });
  let ensured = 0;
  const dial = serviceDial({ ARCHER_SOCKET: fake.socketPath }, LAUNCH, {
    ensure: async () => {
      ensured += 1;
    },
  });
  const input = new PassThrough();
  let out = "",
    clock = 0,
    dropped = false;
  const running = relay(await dial(true), {
    launch: LAUNCH,
    input,
    write: (text) => {
      out += text;
    },
    dial,
    sleep: async () => {
      clock += 5_000;
    },
    now: () => clock,
    log: (line) => {
      dropped ||= /closed the connection/.test(line);
    },
  });
  const before = fake.requests.length;
  chmodSync(fake.dir, 0o777);
  fake.dropAll();
  const end = Date.now() + 5000;
  while (!dropped && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  input.write('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_projects"}}\n');
  while (!out.includes('"id":7') && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(out).toMatch(/readable by others/);
  expect(fake.requests.slice(before)).toEqual([]);
  expect(ensured).toBe(0);
  input.end();
  await running;
  chmodSync(fake.dir, 0o700);
});

const ARCHER = fileURLToPath(new URL("../../src/bin/archer.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));

test("archer mcp refuses an unsafe socket outright: no relay, no in-process fallback, a non-zero exit", async () => {
  const fake = await fakeService({ mcpRelay: () => ({ relaying: true }) });
  chmodSync(fake.dir, 0o777);
  const home = base();
  const child = spawn(process.execPath, ["--import", TSX, ARCHER, "mcp"], {
    cwd: home,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      ARCHER_SOCKET: fake.socketPath,
      ARCHER_STATE_DIR: join(home, "state"),
    },
  });
  let out = "",
    err = "";
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    err += String(chunk);
  });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  const stuck = setTimeout(() => child.kill(), 20_000);
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  clearTimeout(stuck);
  chmodSync(fake.dir, 0o700);
  expect(err).toMatch(/readable by others/);
  expect(err).not.toMatch(/serving in this process/);
  expect(out).toBe("");
  expect(code).not.toBe(0);
  expect(fake.requests).toEqual([]);
  expect(existsSync(join(home, "state", "service.json"))).toBe(false);
}, 30_000);

test("HTTP reaches no management-only method, under any credential or spelling", async () => {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const attached = await client.call("attach", { root: project() });
    const grant = await client.call("issueAccess", { label: "r4 http" });
    const origin = new URL(svc.homeUrl).origin,
      slug = slugOf(attached.url);
    const cookie = ((await http(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    // The code's own METHODS set, as the inventory reads it.
    const methods = socketMethods(readFileSync(join(import.meta.dirname, "../../src/service/socket.ts"), "utf8"), [
      ...AGENT_METHODS,
    ]) as string[];
    expect(methods).toEqual(
      expect.arrayContaining([
        "issueAccess",
        "revokeAccess",
        "issuePairingCode",
        "stop",
        "handover",
        "restartConfiguration",
        "mcpRelay",
        "registerAgent",
      ]),
    );
    const grantsBefore = (await client.call("listAccess", {})).grants.length;
    const credentials: [string, Record<string, string>][] = [
      ["service token path", {}],
      ["grant cookie", { cookie }],
      ["grant bearer", { authorization: `Bearer ${grant.token}` }],
    ];
    const refused: string[] = [];
    for (const method of methods) {
      for (const [name, headers] of credentials) {
        const prefix = name === "service token path" ? `/${svc.token}` : "";
        for (const path of [`/${method}`, `/api/${method}`, `/p/${slug}/api/${method}`, `/p/${slug}/${method}`]) {
          for (const verb of ["GET", "POST"]) {
            const body = JSON.stringify({
              id: 1,
              method,
              params: { label: "via http", grantId: grant.id, protocolVersion: 1 },
            });
            const reply = await http(`${origin}${prefix}${path}`, {
              method: verb,
              headers: { ...headers, origin, "content-type": "application/json" },
              ...(verb === "POST" ? { body } : {}),
            });
            if (reply.status !== 404) refused.push(`${verb} ${name} ${path}: ${reply.status}`);
          }
        }
      }
    }
    // The management line itself, posted at the base and the token home.
    for (const path of ["/", `/${svc.token}/`]) {
      const reply = await http(`${origin}${path}`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: `{"id":1,"method":"issueAccess","params":{"label":"x"}}\n`,
      });
      if (reply.status !== 404) refused.push(`POST line ${path}: ${reply.status}`);
    }
    expect(refused).toEqual([]);
    expect((await client.call("listAccess", {})).grants.length).toBe(grantsBefore);
    expect(state).toBeTruthy();
  } finally {
    client.close();
  }
}, 60_000);
