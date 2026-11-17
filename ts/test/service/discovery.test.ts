// Which running copy a front door uses (ADR 0031). The clear case is today's: the main instance
// answers, compatible and current, and is used. An isolated caller (explicit ARCHER_STATE_DIR)
// always gets its own. Anything ambiguous is the person's choice: instance_choice_needed, until
// ~/.archer/preferences.md records it.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectIfRunning, ensureService, InstanceChoiceError, ServiceStartError } from "../../src/service/client.ts";
import { serviceDirs } from "../../src/service/paths.ts";
import { startService, type RunningService } from "../../src/service/index.ts";
import { cleanUp, tempDir } from "./support.ts";

afterEach(cleanUp);
const servers: Server[] = [];
const services: RunningService[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((ok) => server.close(ok));
  for (const svc of services.splice(0)) await svc.close();
});

/** An older or other build on `socketPath`: it answers hello as protocol.ts specifies, and nothing else. */
async function olderBuild(
  socketPath: string,
  hello: { version: string; protocolVersion?: number; refuses?: boolean },
): Promise<Server> {
  mkdirSync(join(socketPath, ".."), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const { id, method } = JSON.parse(buffered.slice(0, at)) as { id: number; method: string };
        buffered = buffered.slice(at + 1);
        socket.write(
          `${JSON.stringify(
            method === "hello" && hello.refuses === true
              ? // A newer build refuses our hello as service.ts does: protocol_version_mismatch.
                {
                  id,
                  ok: false,
                  error: {
                    code: "protocol_version_mismatch",
                    message: `this service speaks protocol ${hello.protocolVersion}, and the client 1; run \`archer stop\` and try again`,
                  },
                }
              : method === "hello"
                ? {
                    id,
                    ok: true,
                    result: {
                      protocolVersion: hello.protocolVersion ?? 1,
                      version: hello.version,
                      homeUrl: "https://127.0.0.1:40399/t/",
                      serviceName: "default",
                    },
                  }
                : { id, ok: false, error: { code: "unknown_method", message: method } },
          )}\n`,
        );
      }
    });
  });
  await new Promise<void>((ok) => server.listen(socketPath, ok));
  servers.push(server);
  return server;
}

/** A real service on `home`'s default state directory (the main one there), registered in `archerHome`. */
async function mainOf(home: string, archerHome: string): Promise<RunningService> {
  const svc = await startService({
    forceHttp: true,
    log: () => {},
    warmStart: false,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ARCHER_HOME: archerHome },
  });
  services.push(svc);
  return svc;
}

const prefer = (archerHome: string, mode: string): void => {
  mkdirSync(archerHome, { recursive: true });
  writeFileSync(join(archerHome, "preferences.md"), `---\ninstances: ${mode}\n---\n`);
};

/** A command that cannot start a service: a front door that tries to start one fails with ServiceStartError. */
const noStart = { command: [process.execPath, "-e", "process.exit(3)"], timeoutMs: 5_000 } as const;

test("clear case: the main instance answers, compatible and current, and is used without a question", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  const svc = await mainOf(home, env.ARCHER_HOME);
  const client = await ensureService({ env, ...noStart });
  try {
    expect((await client.call("hello", { protocolVersion: 1 })).homeUrl).toBe(svc.homeUrl);
  } finally {
    client.close();
  }
});

test("an isolated caller never reuses the main instance; it starts its own", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  await mainOf(home, env.ARCHER_HOME);
  const isolated = tempDir("archer-iso-");
  await expect(ensureService({ env: { ...env, ARCHER_STATE_DIR: isolated }, ...noStart })).rejects.toBeInstanceOf(
    ServiceStartError,
  );
  await expect(ensureService({ env, stateDir: isolated, ...noStart })).rejects.toBeInstanceOf(ServiceStartError);
});

test("an isolated instance is never reused by others, nor offered as a choice", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  const isolated = tempDir("archer-iso-");
  const svc = await startService({ forceHttp: true, log: () => {}, warmStart: false, stateDir: isolated, env });
  services.push(svc);
  prefer(env.ARCHER_HOME, "reuse-any");
  await expect(ensureService({ env, ...noStart })).rejects.toBeInstanceOf(ServiceStartError);
});

test("an older build holding the main socket, unregistered, is found and offered as a choice", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  await olderBuild(serviceDirs(env).socketPath, { version: "0.3.0" });
  const refused = await ensureService({ env, version: "0.4.0", ...noStart }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(InstanceChoiceError);
  const choice = refused as InstanceChoiceError;
  expect(choice.code).toBe("instance_choice_needed");
  expect(choice.details).toMatchObject({
    reason: "main_older",
    mode: "ask",
    running: [{ kind: "main", version: "0.3.0", registered: false }],
  });
  expect(choice.details.options.map((o) => o.id)).toEqual(["reuse-main", "restart-main"]);
  expect(choice.message).toMatch(/archer preferences set instances reuse-main/);
  expect(choice.message).toMatch(/archer restart/);
});

test.each(["reuse-main", "reuse-any"])(
  "with instances: %s an older main build is reused without asking",
  async (mode) => {
    const home = tempDir("archer-home-");
    const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
    await olderBuild(serviceDirs(env).socketPath, { version: "0.3.0" });
    prefer(env.ARCHER_HOME, mode);
    const client = await ensureService({ env, version: "0.4.0", ...noStart });
    try {
      expect((await client.call("hello", { protocolVersion: 1 })).version).toBe("0.3.0");
    } finally {
      client.close();
    }
  },
);

test("a newer main build is the clear case", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  await olderBuild(serviceDirs(env).socketPath, { version: "0.5.0" });
  const client = await ensureService({ env, version: "0.4.0", ...noStart });
  client.close();
});

test("a main build speaking another protocol is a choice whatever the preference", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  await olderBuild(serviceDirs(env).socketPath, { version: "9.0.0", protocolVersion: 2 });
  prefer(env.ARCHER_HOME, "reuse-main");
  const refused = (await ensureService({ env, version: "0.4.0", ...noStart }).catch(
    (error: unknown) => error,
  )) as InstanceChoiceError;
  expect(refused).toBeInstanceOf(InstanceChoiceError);
  expect(refused.details.reason).toBe("main_incompatible");
  expect(refused.details.options.map((o) => o.id)).toEqual(["stop-main"]);
});

test("a compatible copy on another default state directory is a choice: reuse it or start this one", async () => {
  const shared = join(tempDir("archer-shared-"), ".archer");
  const elsewhere = tempDir("archer-elsewhere-");
  const other = await mainOf(elsewhere, shared);
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: shared };
  const refused = (await ensureService({ env, ...noStart }).catch((error: unknown) => error)) as InstanceChoiceError;
  expect(refused).toBeInstanceOf(InstanceChoiceError);
  expect(refused.details).toMatchObject({
    reason: "other_copies",
    running: [{ kind: "main", stateDir: other.stateDir, registered: true }],
  });
  expect(refused.details.options.map((o) => o.id)).toEqual(["reuse-any", "start-new"]);

  prefer(shared, "reuse-any");
  const reused = await ensureService({ env, ...noStart });
  try {
    expect((await reused.call("hello", { protocolVersion: 1 })).homeUrl).toBe(other.homeUrl);
  } finally {
    reused.close();
  }
  const found = await connectIfRunning({ env });
  expect(found).not.toBeNull();
  found?.close();

  prefer(shared, "reuse-main");
  await expect(ensureService({ env, ...noStart })).rejects.toBeInstanceOf(ServiceStartError);
  expect(await connectIfRunning({ env })).toBeNull();
});

test("looking without starting finds an older main build as today, and never asks", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  await olderBuild(serviceDirs(env).socketPath, { version: "0.3.0" });
  const client = await connectIfRunning({ env, version: "0.4.0" });
  expect(client).not.toBeNull();
  client?.close();
});

test("a bad preference warns in the choice and is treated as ask", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  await olderBuild(serviceDirs(env).socketPath, { version: "0.3.0" });
  prefer(env.ARCHER_HOME, "sometimes");
  const refused = (await ensureService({ env, version: "0.4.0", ...noStart }).catch(
    (error: unknown) => error,
  )) as InstanceChoiceError;
  expect(refused.details.mode).toBe("ask");
  expect(refused.details.warnings[0]).toMatch(/sometimes/);
});

test("an operation that needs the service carries the choice as instance_choice_needed, with the options", async () => {
  const { createApplication } = await import("../../src/application/index.ts");
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  await olderBuild(serviceDirs(env).socketPath, { version: "0.3.0" });
  const app = createApplication({
    cwd: home,
    ensureService: () => ensureService({ env, version: "0.4.0", ...noStart }),
    startService: () => ensureService({ env, version: "0.4.0", autoStart: true, ...noStart }),
  });
  try {
    const refused = (await app.call("start_service").catch((error: unknown) => error)) as {
      message: string;
      data: Record<string, unknown>;
    };
    expect(refused.data).toMatchObject({ code: "instance_choice_needed", reason: "main_older" });
    expect(refused.message).toMatch(/^instance_choice_needed: .*Ask the person/);
  } finally {
    app.close();
  }
});

test("start_service names the person's preferences in one line, only once they have written some", async () => {
  const { createApplication } = await import("../../src/application/index.ts");
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  await mainOf(home, env.ARCHER_HOME);
  const app = createApplication({
    cwd: home,
    env,
    startService: () => ensureService({ env, autoStart: true, ...noStart }),
  });
  try {
    const before = await app.call("start_service");
    expect(before.text).toMatch(/^Archer is running; give this link exactly \(copy it, never retype it\):\n\S+$/);
    expect(before.structured["preferences"]).toMatchObject({ instances: "ask", warnings: [] });
    prefer(env.ARCHER_HOME, "reuse-main");
    const after = await app.call("start_service");
    expect(after.text.split("\n")).toEqual([
      expect.stringMatching(/^Archer is running/),
      expect.stringMatching(/^\S+$/),
      `Follow the person's preferences in ${join(env.ARCHER_HOME, "preferences.md")} (instances: reuse-main).`,
    ]);
  } finally {
    app.close();
  }
});

test("a main build that refuses this protocol's hello is the same choice", async () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: join(home, ".archer") };
  await olderBuild(serviceDirs(env).socketPath, { version: "9.0.0", protocolVersion: 2, refuses: true });
  const refused = (await ensureService({ env, version: "0.4.0", ...noStart }).catch(
    (error: unknown) => error,
  )) as InstanceChoiceError;
  expect(refused).toBeInstanceOf(InstanceChoiceError);
  expect(refused.details).toMatchObject({
    reason: "main_incompatible",
    running: [{ protocolVersion: 2, version: "unknown" }],
  });
});

test("an explicit ARCHER_SOCKET is an isolated caller: it never reuses another copy", async () => {
  const shared = join(tempDir("archer-shared-"), ".archer");
  await mainOf(tempDir("archer-elsewhere-"), shared);
  prefer(shared, "reuse-any");
  const home = tempDir("archer-home-");
  const env = { HOME: home, ARCHER_HOME: shared, ARCHER_SOCKET: join(home, "chosen.sock") };
  await expect(ensureService({ env, ...noStart })).rejects.toBeInstanceOf(ServiceStartError);
  expect(await connectIfRunning({ env })).toBeNull();
});
