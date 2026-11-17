import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openArcher } from "../../src/api.ts";
import { connectService } from "../../src/service/service-client.ts";
import { connectIfRunning, ensureService } from "../../src/service/client.ts";
import { isolatedProcessEnv, cleanUp, project, service, tempDir } from "./support.ts";

afterEach(cleanUp);

test("disabled on-demand startup refuses before spawning or writing logs", async () => {
  const stateDir = tempDir("archer-start-policy-");
  await expect(
    ensureService({
      stateDir,
      env: { HOME: stateDir, ARCHER_AUTO_START: "false" },
      command: [process.execPath, "-e", "process.exit(19)"],
      timeoutMs: 250,
    }),
  ).rejects.toThrow(/automatic startup is disabled.*start_service/);
  expect(existsSync(join(stateDir, "service.log"))).toBe(false);
});

// Found installing the package into a long temporary HOME (v1 install walkthrough, 2026-10-21):
// the service logged the socket error and lingered, so startup waited out its whole deadline.
test("a socket path too long for the system is refused before spawning, naming the fix", async () => {
  const stateDir = tempDir("archer-start-policy-");
  const socketPath = join(stateDir, "x".repeat(120), "archer.sock");
  const started = Date.now();
  await expect(
    ensureService({
      stateDir,
      socketPath,
      env: { HOME: stateDir },
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 5_000,
    }),
  ).rejects.toThrow(/socket path .* bytes.*ARCHER_SOCKET/);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(existsSync(join(stateDir, "service.log"))).toBe(false);
});

// v1 small-agent evals (2026-10-21): with its configured port taken, the service logged
// EADDRINUSE but its thumbnail workers kept it alive, so present_diagram waited 15 s and said
// only that the service did not answer.
test("a service whose configured port is taken exits at once, and the front door says why", async () => {
  const { createServer } = await import("node:net");
  const blocker = createServer();
  await new Promise<void>((ok) => blocker.listen(0, "127.0.0.1", ok));
  const port = (blocker.address() as { port: number }).port;
  const stateDir = tempDir("archer-start-policy-");
  const started = Date.now();
  try {
    await expect(
      ensureService({
        stateDir,
        env: isolatedProcessEnv(stateDir, {
          ARCHER_PORT: String(port),
          ARCHER_FORCE_HTTP: "true",
          ARCHER_HOST: "127.0.0.1",
          ARCHER_OPEN_BROWSER: "never",
        }),
        timeoutMs: 14_000,
      }),
    ).rejects.toThrow(/exited \(\d+\) before answering[\s\S]*EADDRINUSE/);
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    blocker.close();
  }
}, 30_000);

test("explicit API start bypasses the override and later operations reuse that service", async () => {
  const root = tempDir("archer-policy-project-");
  mkdirSync(join(root, ".archer"));
  writeFileSync(join(root, ".archer/a.mmd"), "flowchart LR\n a[Client] e@--> b[Server]\n");
  const stateDir = tempDir("archer-policy-state-");
  const options = {
    stateDir,
    env: isolatedProcessEnv(stateDir, {
      ARCHER_FORCE_HTTP: "true",
      ARCHER_AUTO_START: "false",
      ARCHER_HOST: "127.0.0.1",
      ARCHER_OPEN_BROWSER: "never",
    }),
  };
  const app = openArcher({ cwd: root, service: options });
  try {
    await expect(app.call("get_ui_url")).rejects.toThrow(/automatic startup is disabled/);
    expect(existsSync(join(stateDir, "service.log"))).toBe(false);
    expect((await app.call("start_service")).structured.running).toBe(true);
    expect((await app.call("get_ui_url")).structured.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const client = await ensureService(options);
    client.close();
  } finally {
    try {
      await app.call("stop_service");
    } finally {
      app.close();
    }
    await expect
      .poll(async () => {
        const client = await connectIfRunning(options);
        client?.close();
        return client === null;
      })
      .toBe(true);
  }
}, 30_000);

test.each([
  [{ DISPLAY: ":99" }, 1],
  [{ DISPLAY: ":99", SSH_CONNECTION: "remote" }, 0],
  [{ DISPLAY: ":99", CI: "true" }, 0],
  [{ ARCHER_OPEN_BROWSER: "never", DISPLAY: ":99" }, 0],
  [{ ARCHER_OPEN_BROWSER: "always" }, 1],
  [{}, 0],
] as const)(
  "browser auto-opening respects graphical detection and overrides: %j",
  async (env, expected) => {
    const opened: string[] = [];
    const root = project();
    const { svc } = await service({
      env,
      browserOpener: async (url) => {
        opened.push(url);
      },
    });
    const client = await connectService(svc.socketPath);
    try {
      const attached = await client.call("attach", { root });
      await client.call("present", { root, viewId: "flow" });
      await client.call("present", { root, viewId: "flow", annotation: "second" });
      expect(opened).toEqual(expected ? [attached.url] : []);
    } finally {
      client.close();
    }
  },
  15_000,
); // starts a real service per case: 0.5 s idle, 1.8 s beside the UI and browser jobs; timed out at 5 s on CI

test("the native launcher preserves a secret URL as one literal argv value", async () => {
  const { launchBrowser } = await import("../../src/service/browser.ts");
  const marker = join(tempDir(), "opener-argv.json");
  const url = "http://127.0.0.1:1234/secret/p/project/?q=$(ignored)&value=`literal`";
  await launchBrowser(url, [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))",
    marker,
  ]);
  await expect.poll(() => existsSync(marker)).toBe(true);
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual([url]);
  await expect(launchBrowser("file:///tmp/should-not-open")).rejects.toThrow(/HTTP or HTTPS/);
});

test("browser detection stays conservative across platforms and rejects malformed overrides", async () => {
  const { shouldOpenBrowser } = await import("../../src/service/browser.ts");
  for (const [platform, env, expected] of [
    ["linux", { WAYLAND_DISPLAY: "wayland-0" }, true],
    ["linux", { DISPLAY: ":1", SSH_TTY: "/dev/pts/1" }, false],
    ["darwin", { TERM_PROGRAM: "Apple_Terminal" }, true],
    ["darwin", {}, false],
    ["win32", { SESSIONNAME: "Console" }, true],
    ["win32", { SESSIONNAME: "Services" }, false],
    ["freebsd", {}, false],
  ] as const)
    expect(shouldOpenBrowser(env, platform)).toBe(expected);
  expect(() => shouldOpenBrowser({ ARCHER_OPEN_BROWSER: "sometimes" })).toThrow(/auto, always or never/);
});

// Package review P5: a failed start showed the tail of the append-only log (old runs' errors too),
// and start_service spawned a second service after the first failed, so each error came twice.
test("a failed start reports only this start's lines, once, and is not retried", async () => {
  const stateDir = tempDir("archer-start-policy-");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, "service.log"), "archer: an error from yesterday\n", { mode: 0o600 });
  const counter = join(stateDir, "spawns");
  const command = [
    process.execPath,
    "-e",
    `require("fs").appendFileSync(${JSON.stringify(counter)}, "x"); console.error("archer: today's error"); process.exit(1)`,
  ];
  await expect(ensureService({ stateDir, env: { HOME: stateDir }, command, timeoutMs: 5_000 })).rejects.toThrow(
    /today's error/,
  );
  await expect(ensureService({ stateDir, env: { HOME: stateDir }, command, timeoutMs: 5_000 })).rejects.not.toThrow(
    /yesterday/,
  );
  const { createApplication } = await import("../../src/application/index.ts");
  const app = createApplication({
    cwd: stateDir,
    startService: () =>
      ensureService({ stateDir, env: { HOME: stateDir }, command, timeoutMs: 5_000, autoStart: true }),
  });
  writeFileSync(counter, "");
  try {
    const failure = await app.call("start_service").then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/today's error/);
    expect(failure?.message.match(/today's error/g)).toHaveLength(1);
    expect(readFileSync(counter, "utf8")).toBe("x");
  } finally {
    app.close();
  }
}, 30_000);

// Codex review of the fix: a start that timed out is a failed start too, and is not retried.
test("a start that timed out or was cancelled is not retried", async () => {
  const { runEnvironmentOperation } = await import("../../src/application/environment.ts");
  const stateDir = tempDir("archer-start-policy-");
  let attempts = 0;
  const access = {
    cwd: stateDir,
    disconnect: () => {},
    acquire: async () => {
      attempts++;
      return ensureService({
        stateDir,
        env: { HOME: stateDir },
        command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
        timeoutMs: 300,
        autoStart: true,
      });
    },
  };
  await expect(runEnvironmentOperation("start_service", {}, access)).rejects.toThrow(/did not answer within 300 ms/);
  expect(attempts).toBe(1);
}, 30_000);

// O30: the deadline's abort and the wait loop's own deadline raced, and the abort's generic
// "cancelled or timed out" (no log, no output) won about one run in three.
test("a start that times out says how long it waited, the log, and what the child wrote", async () => {
  const stateDir = tempDir("archer-start-policy-");
  const command = [process.execPath, "-e", "process.stderr.write('still warming\\n'); setTimeout(() => {}, 60000)"];
  const failure = await ensureService({
    stateDir,
    env: { HOME: stateDir },
    command,
    timeoutMs: 3_000,
    autoStart: true,
  }).then(
    () => undefined,
    (error: Error) => error,
  );
  expect(failure?.message).toMatch(
    /^the Archer service did not answer within 3000 ms:\nstill warming\n\(full log: .*service\.log\)$/,
  );
}, 30_000);
