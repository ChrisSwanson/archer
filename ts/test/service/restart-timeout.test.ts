import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { isolatedProcessEnv, cleanUp, tempDir } from "./support.ts";

afterEach(cleanUp);

test("restart CLI exits at its deadline and closes a silent management handshake", { timeout: 25_000 }, async () => {
  const state = tempDir(),
    socketPath = join(state, "silent.sock");
  const connections = new Set<Socket>();
  const silent = createServer((socket) => {
    connections.add(socket);
    socket.on("data", () => {}); // Accept hello and deliberately never answer.
    socket.on("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve) => silent.listen(socketPath, resolve));
  const loader = join(createRequire(import.meta.url).resolve("tsx/package.json"), "..", "dist", "loader.mjs");
  const entry = new URL("../../src/bin/archer.ts", import.meta.url).pathname;
  const child = spawn(process.execPath, ["--import", loader, entry, "restart"], {
    env: isolatedProcessEnv(state, { ARCHER_STATE_DIR: state, ARCHER_SOCKET: socketPath }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const forced = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    expect(result, stderr).toEqual({ code: 1, signal: null });
    expect(stderr).toMatch(/restart timed out/u);
    await expect.poll(() => connections.size).toBe(0);
  } finally {
    clearTimeout(forced);
    child.kill("SIGKILL");
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test("ensureService cancels its initial silent handshake without spawning a replacement", async () => {
  const { ensureService } = await import("../../src/service/client.ts");
  const { existsSync } = await import("node:fs");
  const state = tempDir(),
    socketPath = join(state, "silent.sock"),
    marker = join(state, "spawned");
  const connections = new Set<Socket>();
  const silent = createServer((socket) => {
    connections.add(socket);
    socket.on("data", () => {});
    socket.on("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve) => silent.listen(socketPath, resolve));
  try {
    await expect(
      ensureService({
        stateDir: state,
        socketPath,
        timeoutMs: 100,
        command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned')`],
      }),
    ).rejects.toMatchObject({ name: "ServiceUnavailableError" });
    await expect.poll(() => connections.size).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(state, "service.log"))).toBe(false);
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test("ensureService cancels a silent readiness handshake and kills its unready child", async () => {
  const { ensureService } = await import("../../src/service/client.ts");
  const { readFileSync, existsSync } = await import("node:fs");
  const state = tempDir(),
    socketPath = join(state, "child.sock"),
    marker = join(state, "child-pid");
  const script = `const fs=require('node:fs');require('node:net').createServer(s=>s.on('data',()=>fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)))).listen(${JSON.stringify(socketPath)});`;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const controller = new AbortController();
  const starting = ensureService({
    stateDir: state,
    socketPath,
    timeoutMs: 10_000,
    signal: controller.signal,
    command: [process.execPath, "-e", script],
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await expect.poll(() => existsSync(marker)).toBe(true); // A real readiness hello reached the child.
    controller.abort();
    expect(await starting).toMatchObject({ error: { name: "ServiceUnavailableError" } });
    const pid = Number(readFileSync(marker, "utf8"));
    await expect.poll(() => alive(pid)).toBe(false);
  } finally {
    controller.abort();
    await starting;
    if (existsSync(marker)) {
      const pid = Number(readFileSync(marker, "utf8"));
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }
});
