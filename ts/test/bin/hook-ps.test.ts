// Decision 45: without /proc (macOS) the turn-start hook asks ps, within HOOK_PS_BUDGET_MS and
// HOOK_PS_MAX_DEPTH ancestors, so it finds the PID-keyed session file `archer listen --claim` wrote.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { closeFakes, fakeService } from "./fake-agent-service.ts";

/** The ps double: process.ppid's parent is a shell, whose parent is Claude Code (pid 4242). */
const ps = { calls: 0, delayMs: 0 };
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: (file: string, args: readonly string[], options?: { timeout?: number }) => {
    if (file !== "ps") throw new Error("not here");
    ps.calls++;
    if (ps.delayMs > 0)
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(ps.delayMs, options?.timeout ?? ps.delayMs),
      );
    const pid = Number(args.at(-1));
    const rows: Record<number, [number, string, string]> = {
      [process.ppid]: [4241, "/bin/zsh", "/bin/zsh -c archer inbox --brief --hook claude-code"],
      4241: [4242, "/bin/zsh", "-zsh"],
      4242: [1, "claude", "claude --resume"],
    };
    const row = rows[pid] ?? (ps.delayMs > 0 ? ([pid + 1, "/bin/sh", "sh"] as [number, string, string]) : undefined);
    if (row === undefined) throw new Error("no such process");
    return args.includes("args=") ? `${row[2]}\n` : `  ${row[0]} ${row[1]}\n`;
  },
}));
// As on macOS: no /proc.
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const noProc = (path: unknown) => typeof path === "string" && path.startsWith("/proc/");
  return {
    ...fs,
    existsSync: (path: string) => (noProc(path) ? false : fs.existsSync(path)),
    readFileSync: ((path: string, ...rest: unknown[]) => {
      if (noProc(path)) throw new Error("ENOENT");
      return (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync,
  };
});

afterEach(async () => {
  ps.calls = 0;
  ps.delayMs = 0;
  await closeFakes();
});

test("without /proc the hook finds the session file the CLI wrote through ps, and asks for the inbox (Codex F3)", async () => {
  const { detectHost, rememberAgent } = await import("../../src/bin/agent-id.ts");
  const { runHook } = await import("../../src/bin/hook.ts");
  const fake = await fakeService({
    inbox: () => ({ count: 2, messages: [] }),
    heartbeat: () => ({ state: "next-turn" }),
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-hook-ps-")));
  const env = { ARCHER_SOCKET: fake.socketPath, ARCHER_STATE_DIR: join(fake.dir, "state") };
  // `archer listen --claim` under the same session: the CLI's own walk, then its session file.
  const detected = detectHost(env);
  expect(detected).toEqual({ host: "claude-code", hostPid: 4242 });
  rememberAgent(env, detected, { agentId: "agt_9", root, cwd: root });
  ps.calls = 0;
  let out = "";
  expect(
    await runHook(["--brief", "--hook", "claude-code"], {
      stdout: (t) => {
        out += t;
      },
      env,
      cwd: root,
    }),
  ).toBe(0);
  expect(fake.requests.find((request) => request.method === "inbox")?.params).toMatchObject({
    agentId: "agt_9",
    brief: true,
  });
  expect(out).toMatch(/2 messages/);
  // One ps run per process: only a runtime's argument line is read (decision 51).
  expect(ps.calls).toBe(3);
});

test("a slow ps holds the hook at most HOOK_PS_BUDGET_MS, over at most HOOK_PS_MAX_DEPTH ancestors (decision 45)", async () => {
  const { runHook, HOOK_PS_BUDGET_MS, HOOK_PS_MAX_DEPTH } = await import("../../src/bin/hook.ts");
  expect(HOOK_PS_BUDGET_MS).toBe(300);
  expect(HOOK_PS_MAX_DEPTH).toBe(4);
  ps.delayMs = 100;
  const started = Date.now();
  expect(
    await runHook(["--brief", "--hook", "claude-code"], {
      stdout: () => {},
      env: { ARCHER_STATE_DIR: "/nonexistent-archer-state" },
      cwd: "/",
    }),
  ).toBe(0);
  expect(Date.now() - started).toBeLessThan(HOOK_PS_BUDGET_MS + 150);
  expect(ps.calls).toBeLessThanOrEqual(4);
  // A fast ps reads at most four ancestors.
  ps.delayMs = 1;
  ps.calls = 0;
  await runHook(["--brief", "--hook", "claude-code"], {
    stdout: () => {},
    env: { ARCHER_STATE_DIR: "/nonexistent-archer-state" },
    cwd: "/",
  });
  expect(ps.calls).toBeLessThanOrEqual(2 * HOOK_PS_MAX_DEPTH);
});
