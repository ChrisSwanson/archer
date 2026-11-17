import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, service, tempDir, write } from "./support.ts";

afterEach(cleanUp);

async function reservePort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no reserved port");
  return { server, port: address.port };
}

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

function configuration(text = "version = 1\n"): { HOME: string; ARCHER_CONFIG: string; ARCHER_OPEN_BROWSER: string } {
  const home = tempDir("archer-port-");
  return { HOME: home, ARCHER_CONFIG: write(home, "archer.toml", text), ARCHER_OPEN_BROWSER: "never" };
}

test("an occupied environment-configured port refuses startup rather than selecting another port", async () => {
  const reserved = await reservePort();
  try {
    await expect(service({ env: { ...configuration(), ARCHER_PORT: String(reserved.port) } })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  } finally {
    await close(reserved.server);
  }
});

test.each(["default", "review"])(
  "a %s service binds its global configured port and snapshots the actual listener",
  async (serviceName) => {
    const reserved = await reservePort();
    await close(reserved.server);
    const table = serviceName === "default" ? "[service]" : '[[services]]\nname = "review"';
    const env = configuration(`version = 1\n${table}\nport = ${reserved.port}\n`);
    const { svc, state } = await service({ serviceName, env });
    expect(svc.port).toBe(reserved.port);
    expect(new URL(svc.homeUrl).port).toBe(String(reserved.port));
    expect(JSON.parse(readFileSync(join(state, "service.json"), "utf8"))).toEqual({
      port: reserved.port,
      token: svc.token,
    });
    const client = await connectService(svc.socketPath, serviceName);
    try {
      expect(await client.call("restartConfiguration", {})).toMatchObject({ port: reserved.port, host: "127.0.0.1" });
    } finally {
      client.close();
    }
  },
);

test("environment port overrides an occupied global configured port", async () => {
  const globalPort = await reservePort(),
    environmentPort = await reservePort();
  await close(environmentPort.server);
  try {
    const env = {
      ...configuration(`version = 1\n[service]\nport = ${globalPort.port}\n`),
      ARCHER_PORT: String(environmentPort.port),
    };
    const { svc } = await service({ env });
    expect(svc.port).toBe(environmentPort.port);
  } finally {
    await close(globalPort.server);
  }
});

test("an occupied global configured port refuses startup and preserves the saved identity", async () => {
  const { svc, state } = await service({ env: configuration() });
  const identity = readFileSync(join(state, "service.json"), "utf8");
  await svc.close();
  const reserved = await reservePort();
  try {
    const env = configuration(`version = 1\n[service]\nport = ${reserved.port}\n`);
    await expect(service({ stateDir: state, env })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(readFileSync(join(state, "service.json"), "utf8")).toBe(identity);
    // Refusal releases the fixture's startup lock, allowing a deliberate override.
    const replacement = await service({ stateDir: state, env, port: 0 });
    expect(replacement.svc.port).not.toBe(reserved.port);
  } finally {
    await close(reserved.server);
  }
});

test("an explicit ephemeral option overrides an occupied environment port", async () => {
  const reserved = await reservePort();
  try {
    const { svc } = await service({ port: 0, env: { ...configuration(), ARCHER_PORT: String(reserved.port) } });
    expect(svc.port).toBeGreaterThan(0);
    expect(svc.port).not.toBe(reserved.port);
  } finally {
    await close(reserved.server);
  }
});

test("an occupied explicit option refuses startup even when the environment port is free", async () => {
  const explicitPort = await reservePort(),
    environmentPort = await reservePort();
  await close(environmentPort.server);
  try {
    await expect(
      service({ port: explicitPort.port, env: { ...configuration(), ARCHER_PORT: String(environmentPort.port) } }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  } finally {
    await close(explicitPort.server);
  }
});

test("an unconfigured service reuses its remembered port and token", async () => {
  const env = configuration();
  const { svc, state } = await service({ env });
  await svc.close();
  const replacement = await service({ stateDir: state, env });
  expect(replacement.svc.port).toBe(svc.port);
  expect(replacement.svc.token).toBe(svc.token);
});

test("only an unconfigured remembered port can fall back and rotate identity when occupied", async () => {
  const env = configuration();
  const { svc, state } = await service({ env });
  await svc.close();
  const squatter = createServer();
  await new Promise<void>((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(svc.port, "127.0.0.1", resolve);
  });
  try {
    const replacement = await service({ stateDir: state, env });
    expect(replacement.svc.port).not.toBe(svc.port);
    expect(replacement.svc.token).not.toBe(svc.token);
  } finally {
    await close(squatter);
  }
});
