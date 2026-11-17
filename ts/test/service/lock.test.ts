// The service lock (server review S4, S9): written complete, and stale when its pid was reused.

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ownerToken } from "../../src/comments/lock.ts";
import { held, lockLine, parseLock, readLock, releaseLock, takeLock } from "../../src/service/lock.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const lockIn = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "archer-lock-"));
  dirs.push(dir);
  return join(dir, "archer.lock");
};
const take = (path: string) =>
  takeLock(
    path,
    (pid) => new Error(`held by ${pid}`),
    () => new Error("raced"),
  );

test("a lock names this process and its incarnation, and leaves no temporary behind", () => {
  const path = lockIn();
  take(path);
  expect(readFileSync(path, "utf8")).toBe(`${process.pid} ${ownerToken(process.pid)}\n`);
  expect(readdirSync(join(path, ".."))).toEqual(["archer.lock"]);
  expect(() => take(path)).toThrow(`held by ${process.pid}`);
  releaseLock(path);
  expect(readLock(path)).toBeNull();
});

test("a lock whose pid now belongs to another process is stale (pid 1 with another owner)", () => {
  const path = lockIn();
  writeFileSync(path, "1 0123456789ab\n");
  take(path);
  expect(readLock(path)?.pid).toBe(process.pid);
});

test("a live holder with its own owner keeps the lock", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    await new Promise((done) => child.once("spawn", done));
    const path = lockIn();
    writeFileSync(path, lockLine(child.pid!));
    expect(held(path, readLock(path))).toBe(true);
    expect(() => take(path)).toThrow(`held by ${child.pid}`);
  } finally {
    child.kill();
  }
});

test("a lock from before owners were recorded is held only by a process older than the lock", async () => {
  const path = lockIn();
  writeFileSync(path, `${process.pid}\n`);
  expect(held(path, readLock(path))).toBe(true);
  // Written long before this process started: its pid was reused.
  utimesSync(path, new Date(0), new Date(0));
  expect(held(path, readLock(path))).toBe(false);
});

test("an empty, garbled or dead lock is stale", () => {
  for (const text of ["", "garbage\n", "999999999 0123456789ab\n"]) {
    const path = lockIn();
    writeFileSync(path, text);
    take(path);
    expect(readLock(path)?.pid).toBe(process.pid);
  }
  expect(parseLock("12 abc")).toBeNull();
});

test("a starter that judged a lock stale does not remove a fresh lock another starter put in its place", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    await new Promise((done) => child.once("spawn", done));
    const path = lockIn();
    writeFileSync(path, "999999999 0123456789ab\n"); // stale
    const fresh = lockLine(child.pid!);
    // Between our judgement and our reclaim, another starter reclaims and takes the lock.
    const other = () => {
      rmSync(path);
      writeFileSync(path, fresh);
    };
    expect(() =>
      takeLock(
        path,
        (pid) => new Error(`held by ${pid}`),
        () => new Error("raced"),
        other,
      ),
    ).toThrow(`held by ${child.pid}`);
    expect(readFileSync(path, "utf8")).toBe(fresh);
    expect(readdirSync(join(path, "..")).sort()).toEqual(["archer.lock"]);
  } finally {
    child.kill();
  }
});

test("a reclaim guard left by a dead starter does not block the next start", () => {
  const path = lockIn();
  writeFileSync(path, "999999999 0123456789ab\n");
  writeFileSync(`${path}.reclaim`, "999999998 0123456789ab\n");
  take(path);
  expect(readLock(path)?.pid).toBe(process.pid);
});
