// The per-user registry of running services (ADR 0031): one list across every state directory,
// so a front door can see the copies running and `archer status` / `stop --stale` can find them.

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ownerToken } from "../../src/comments/lock.ts";
import {
  archerHome,
  compareVersions,
  instanceKind,
  listInstances,
  registerInstance,
  registryDir,
} from "../../src/service/instances.ts";
import { cleanUp, tempDir } from "./support.ts";

afterEach(cleanUp);

const entry = (home: string, over: Record<string, unknown> = {}) => ({
  pid: process.pid,
  owner: ownerToken(process.pid) as string,
  version: "0.4.0",
  protocolVersion: 1,
  serviceName: "default",
  stateDir: join(home, "state"),
  socketPath: join(home, "state", "archer.sock"),
  url: "https://127.0.0.1:40399/",
  kind: "isolated" as const,
  startedAt: new Date(0).toISOString(),
  idleSince: null,
  ...over,
});

test("the registry lives in the person's Archer home, ARCHER_HOME overriding ~/.archer", () => {
  expect(archerHome({ HOME: "/h" })).toBe("/h/.archer");
  expect(archerHome({ HOME: "/h", ARCHER_HOME: "/elsewhere" })).toBe("/elsewhere");
  expect(archerHome({ HOME: "/h", ARCHER_HOME: "relative" })).toBe("/h/.archer");
  expect(registryDir({ HOME: "/h" })).toBe("/h/.archer/instances");
});

test("an instance on the default state directory is the main one; an explicit other one is isolated", () => {
  const env = { HOME: "/h" };
  expect(instanceKind("/h/.local/state/archer", env)).toBe("main");
  expect(instanceKind("/h/.local/state/archer", { ...env, ARCHER_STATE_DIR: "/h/.local/state/archer" })).toBe("main");
  expect(instanceKind("/tmp/archer-eval-1", { ...env, ARCHER_STATE_DIR: "/tmp/archer-eval-1" })).toBe("isolated");
  expect(instanceKind("/x/state/archer", { HOME: "/h", XDG_STATE_HOME: "/x/state" })).toBe("main");
});

test("a registered instance is listed until it is removed, in a private folder", () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  const registration = registerInstance(env, entry(home));
  expect(listInstances(env)).toEqual([entry(home)]);
  expect(statSync(registryDir(env)).mode & 0o777).toBe(0o700);
  expect(statSync(registration.path).mode & 0o777).toBe(0o600);
  registration.update({ idleSince: new Date(5).toISOString() });
  expect(listInstances(env)[0]?.idleSince).toBe(new Date(5).toISOString());
  registration.remove();
  expect(listInstances(env)).toEqual([]);
  expect(readdirSync(registryDir(env))).toEqual([]);
});

test("an entry whose process is gone, or whose pid now belongs to another process, is pruned on read", () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  registerInstance(env, entry(home, { pid: 1, owner: "0123456789ab" })); // pid 1 runs, but is not that incarnation
  registerInstance(env, entry(home, { pid: 2 ** 22 + 17, owner: "0123456789ab" })); // above Linux's pid_max
  const live = registerInstance(env, entry(home));
  expect(listInstances(env).map((e) => e.pid)).toEqual([process.pid]);
  expect(readdirSync(registryDir(env))).toEqual([live.path.split("/").pop()]);
});

test("an unreadable entry of ours is pruned; a file that is not ours is left alone", () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  registerInstance(env, entry(home));
  writeFileSync(join(registryDir(env), "12345-0123456789ab.json"), "{not json");
  writeFileSync(join(registryDir(env), "notes.txt"), "mine");
  writeFileSync(
    join(registryDir(env), `${process.pid}-aaaaaaaaaaaa.json`),
    JSON.stringify({ ...entry(home), kind: "bogus" }),
  );
  expect(listInstances(env)).toHaveLength(1);
  expect(readdirSync(registryDir(env)).sort()).toEqual(
    [`${process.pid}-${ownerToken(process.pid)}.json`, "notes.txt"].sort(),
  );
});

test("no registry folder means no instances", () => {
  expect(listInstances({ HOME: tempDir("archer-home-") })).toEqual([]);
});

test("versions compare numerically, a pre-release below its release", () => {
  expect(compareVersions("0.4.0", "0.4.0")).toBe(0);
  expect(compareVersions("0.3.9", "0.4.0")).toBeLessThan(0);
  expect(compareVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
  expect(compareVersions("0.4.0-rc.1", "0.4.0")).toBeLessThan(0);
  expect(compareVersions("0.0.0-dev", "0.0.0-dev")).toBe(0);
  expect(compareVersions("garbage", "0.4.0")).toBeLessThan(0);
});

test("a registry folder that is a link, or open to others, is not read", async () => {
  const { chmodSync, mkdirSync, symlinkSync } = await import("node:fs");
  const home = tempDir("archer-home-");
  const real = join(tempDir("archer-elsewhere-"), "instances");
  mkdirSync(join(home, ".archer"), { mode: 0o700 });
  registerInstance(
    { HOME: real.replace(/\/instances$/, ""), ARCHER_HOME: real.replace(/\/instances$/, "") },
    entry(home),
  );
  symlinkSync(real, join(home, ".archer", "instances"));
  expect(listInstances({ HOME: home })).toEqual([]);
  const open = tempDir("archer-home-");
  registerInstance({ HOME: open }, entry(open));
  chmodSync(registryDir({ HOME: open }), 0o777);
  try {
    expect(listInstances({ HOME: open })).toEqual([]);
  } finally {
    chmodSync(registryDir({ HOME: open }), 0o700);
  }
});

test("an entry another user could have written (group or other access) is not trusted", async () => {
  const { chmodSync } = await import("node:fs");
  const home = tempDir("archer-home-");
  const registration = registerInstance({ HOME: home }, entry(home));
  chmodSync(registration.path, 0o622);
  expect(listInstances({ HOME: home })).toEqual([]);
});

test("a FIFO in place of an entry does not block the reader", async () => {
  const { execFileSync } = await import("node:child_process");
  const home = tempDir("archer-home-");
  registerInstance({ HOME: home }, entry(home));
  execFileSync("mkfifo", ["-m", "600", join(registryDir({ HOME: home }), "4242-0123456789ab.json")]);
  expect(listInstances({ HOME: home })).toHaveLength(1);
}, 5_000);
