// `archer serve` and `archer stop`, run in-process against a temp state
// directory: serve starts the service detached (as the front doors do),
// attaches this directory's project and prints its page; stop ends it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Application } from "../../src/application/index.ts";
import { main, type Io } from "../../src/bin/main.ts";
import { isolatedProcessEnv, cleanUp, openPage, project, tempDir } from "./support.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanUp();
});

function io(state: string, cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    isTTY: false,
    columns: undefined,
    env: isolatedProcessEnv(state, { ARCHER_FORCE_HTTP: "true", XDG_STATE_HOME: state, XDG_RUNTIME_DIR: "" }),
    cwd,
  };
  return { io: value, out: () => out.join(""), err: () => err.join("") };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("stop with nothing running says so and succeeds", async () => {
  const run = io(tempDir("archer-state-"), tempDir());
  expect(await main(["stop"], run.io)).toBe(0);
  expect(run.out()).toBe("Archer is not running.\n");
});

test("serve starts the service and prints this project's page; stop ends it", { timeout: 30_000 }, async () => {
  const operations = vi.spyOn(Application.prototype, "call");
  const state = tempDir("archer-state-");
  const root = project();
  const serve = io(state, root);
  expect(await main(["serve"], serve.io)).toBe(0);
  const url = /http:\/\/127\.0\.0\.1:\d+\/projects\/[a-z0-9-]+\/\?follow&token=[0-9a-f]{32}$/m.exec(serve.out())?.[0];
  expect(url, serve.out() + serve.err()).toBeDefined();
  expect((await openPage(url as string)).status).toBe(200);
  const pid = Number(readFileSync(join(state, "archer", "archer.lock"), "utf8").split(" ")[0]);

  // A second serve finds it running and prints the same page.
  const again = io(state, root);
  expect(await main(["serve"], again.io)).toBe(0);
  expect(again.out()).toContain(url as string);

  const stop = io(state, root);
  expect(await main(["stop"], stop.io)).toBe(0);
  expect(stop.out()).toBe("Archer stopped.\n");
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  expect(existsSync(join(state, "archer", "archer.sock"))).toBe(false);
  expect(operations.mock.calls.map(([name]) => name)).toEqual([
    "start_service",
    "attach_project",
    "start_service",
    "attach_project",
    "stop_service",
  ]);
});

test("serve takes only --foreground", async () => {
  const run = io(tempDir("archer-state-"), tempDir());
  expect(await main(["serve", "--port", "1"], run.io)).toBe(2);
  expect(run.err()).toContain("archer: ");
});
