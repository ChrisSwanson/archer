import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";
import { connectIfRunning, connectService } from "../../src/service/index.ts";
import { isolatedProcessEnv, cleanUp, openPage, project, service, tempDir } from "./support.ts";

afterEach(cleanUp);

test("restart uses the running service settings, preserves URL/projects, and does not attach the caller directory", {
  timeout: 30_000,
}, async () => {
  const home = tempDir();
  const { svc, state } = await service({ host: "0.0.0.0", env: { HOME: home, ARCHER_OPEN_BROWSER: "never" } });
  const client = await connectService(svc.socketPath);
  const { url } = await client.call("attach", { root: project() });
  client.close();
  const output: string[] = [];
  const errors: string[] = [];
  const env = isolatedProcessEnv(state, {
    ARCHER_STATE_DIR: state,
    ARCHER_SOCKET: svc.socketPath,
    ARCHER_HOST: "127.0.0.1",
    ARCHER_OPEN_BROWSER: "never",
  });
  const io: Io = {
    stdout: (t) => output.push(t),
    stderr: (t) => errors.push(t),
    env,
    cwd: tempDir(),
    isTTY: false,
    columns: undefined,
  };
  try {
    expect(await main(["restart"], io), errors.join("")).toBe(0);
    expect(output.join("")).toContain("Archer restarted");
    expect(JSON.parse(readFileSync(join(state, "service.json"), "utf8"))).toEqual({ token: svc.token, port: svc.port });
    const replacement = await connectService(svc.socketPath);
    try {
      const configuration = (await replacement.call("restartConfiguration", {})) as unknown as {
        host: string;
        launchEnv: { HOME: string };
      };
      expect(configuration.host).toBe("0.0.0.0");
      expect(configuration.launchEnv.HOME).toBe(home);
      expect((await replacement.call("listProjects", {})).projects).toEqual([
        { root: expect.any(String), name: expect.any(String), url },
      ]);
      // Saved projects open after the service answers (server review S2): the page says "opening" (503) until then.
      await expect
        .poll(async () => (await openPage(url.replace("0.0.0.0", "127.0.0.1"))).status, { timeout: 15_000 })
        .toBe(200);
    } finally {
      replacement.close();
    }
  } finally {
    const replacement = await connectIfRunning({ env });
    if (replacement !== null) {
      await replacement.call("stop", {});
      replacement.close();
    }
    await expect
      .poll(() => {
        try {
          return readFileSync(join(state, "archer.lock"), "utf8");
        } catch {
          return null;
        }
      })
      .toBeNull();
  }
});

test("restart refuses when no service runs and never starts or attaches a project", async () => {
  const state = tempDir();
  const errors: string[] = [];
  const result = await main(["restart"], {
    stdout: () => {},
    stderr: (t) => errors.push(t),
    env: { ARCHER_STATE_DIR: state },
    cwd: tempDir(),
    isTTY: false,
    columns: undefined,
  });
  expect(result).not.toBe(0);
  expect(errors.join("")).toContain("not running");
  expect(await connectIfRunning({ stateDir: state })).toBeNull();
});

test.each([
  { label: "disabled restoration", options: { restoreState: false }, env: {}, message: "restoration" },
  {
    label: "missing custom page",
    options: { pagePath: "/missing/archer-page.html" },
    env: {},
    message: "page cannot be read",
  },
  {
    label: "malformed snapshot",
    options: { env: { HOME: "x".repeat(5000) } },
    env: {},
    message: "invalid restart settings",
  },
  {
    label: "target preflight failure",
    options: {},
    env: { NODE_OPTIONS: "--require /missing/archer-preflight.js" },
    message: "version preflight",
  },
])("restart refuses $label before stopping", async ({ options, env: extra, message }) => {
  const { svc, state } = await service(options);
  const client = await connectService(svc.socketPath);
  try {
    await client.call("attach", { root: project() });
    const errors: string[] = [];
    const env = isolatedProcessEnv(state, { ARCHER_STATE_DIR: state, ARCHER_SOCKET: svc.socketPath, ...extra });
    expect(
      await main(["restart"], {
        stdout: () => {},
        stderr: (text) => errors.push(text),
        env,
        cwd: tempDir(),
        isTTY: false,
        columns: undefined,
      }),
    ).not.toBe(0);
    expect(errors.join("")).toContain(message);
    expect((await client.call("listProjects", {})).projects).toHaveLength(1);
    expect(readFileSync(join(state, "archer.lock"), "utf8").split(" ")[0]).toBe(String(process.pid));
  } finally {
    client.close();
  }
});

test("foreground replacement refuses an occupied fixed port without rotating saved identity", async () => {
  const { createServer } = await import("node:net");
  const { svc, state } = await service();
  const identity = readFileSync(join(state, "service.json"), "utf8");
  await svc.close();
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(svc.port, "127.0.0.1", resolve));
  try {
    const errors: string[] = [];
    const result = await main(["serve", "--foreground", "--port", String(svc.port)], {
      stdout: () => {},
      stderr: (text) => errors.push(text),
      env: { HOME: state, ARCHER_STATE_DIR: state, ARCHER_FORCE_HTTP: "true" },
      isTTY: false,
      columns: undefined,
    });
    expect(result).not.toBe(0);
    expect(errors.join("")).toMatch(/EADDRINUSE|address already in use/u);
    expect(readFileSync(join(state, "service.json"), "utf8")).toBe(identity);
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test("a management service that refuses restartConfiguration is left running", async () => {
  const { createServer } = await import("node:net");
  const { MethodError, serveConnection } = await import("../../src/service/socket.ts");
  const state = tempDir(),
    socketPath = join(state, "legacy.sock");
  let stops = 0;
  const legacy = createServer((socket) =>
    serveConnection(
      socket,
      async (request) => {
        if (request.method === "hello")
          return {
            protocolVersion: 1,
            version: "0.0.0",
            homeUrl: "http://127.0.0.1:40399/legacy/",
            serviceName: "default",
          };
        if (request.method === "stop") stops++;
        throw new MethodError("unknown_method", "legacy service has no such method");
      },
      () => {},
    ),
  );
  await new Promise<void>((resolve) => legacy.listen(socketPath, resolve));
  try {
    const errors: string[] = [];
    expect(
      await main(["restart"], {
        stdout: () => {},
        stderr: (text) => errors.push(text),
        env: { ARCHER_STATE_DIR: state, ARCHER_SOCKET: socketPath },
        isTTY: false,
        columns: undefined,
      }),
    ).not.toBe(0);
    expect(stops).toBe(0);
    expect(legacy.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => legacy.close(() => resolve()));
  }
});
