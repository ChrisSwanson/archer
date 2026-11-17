// cleanUp stops a detached service a test left running (server review S16: 45 test daemons were
// found on the host, serving deleted temp dirs).

import { expect, test } from "vitest";
import { defaultServeCommand, ensureService } from "../../src/service/client.ts";
import { readLock } from "../../src/service/lock.ts";
import { cleanUp, isolatedProcessEnv, stopServicesUnder, tempDir } from "./support.ts";
import { join } from "node:path";

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a daemon left running under a temp dir is stopped by cleanUp", async () => {
  const state = tempDir("archer-leak-");
  const client = await ensureService({
    stateDir: state,
    env: isolatedProcessEnv(state, { ARCHER_FORCE_HTTP: "true" }),
    timeoutMs: 20_000,
    command: defaultServeCommand(),
  });
  client.close();
  const pid = readLock(join(state, "archer.lock"))!.pid;
  expect(pid).not.toBe(process.pid);
  expect(running(pid)).toBe(true);
  await cleanUp(); // the test "forgot" to stop it
  expect(running(pid)).toBe(false);
}, 40_000);

test("a lock naming this process, or nothing, is left alone", async () => {
  expect(await stopServicesUnder(tempDir())).toEqual([]);
});
