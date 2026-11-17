import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { PROTOCOL_VERSION } from "../../src/service/protocol.ts";
import { connectIfRunning } from "../../src/service/client.ts";
import { connectService, ServiceUnavailableError } from "../../src/service/service-client.ts";
import { serviceDirs } from "../../src/service/paths.ts";
import { startService, ServiceRunningError } from "../../src/service/service.ts";
import { cleanUp, service, tempDir } from "./support.ts";

afterEach(cleanUp);

interface ControlledPeer {
  readonly socketPath: string;
  readonly methods: string[];
  readonly peerClosed: Promise<void>;
  close(): Promise<void>;
}

async function controlledPeer(hello: Readonly<Record<string, unknown>>): Promise<ControlledPeer> {
  const socketPath = join(tempDir("archer-identity-peer-"), "peer.sock");
  const methods: string[] = [];
  const sockets = new Set<Socket>();
  let observedClose = (): void => {};
  const peerClosed = new Promise<void>((resolve) => (observedClose = resolve));
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const request = JSON.parse(buffered.slice(0, newline)) as { id: number; method: string };
        buffered = buffered.slice(newline + 1);
        methods.push(request.method);
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result: hello })}\n`);
        newline = buffered.indexOf("\n");
      }
    });
    socket.once("close", () => {
      sockets.delete(socket);
      observedClose();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    socketPath,
    methods,
    peerClosed,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test("front doors with different runtime directories reach the same service identity", async () => {
  const home = tempDir("archer-identity-");
  const shell = { HOME: home, XDG_RUNTIME_DIR: tempDir("archer-runtime-") };
  const host = { HOME: home };
  const svc = await startService({ forceHttp: true, env: shell, log: () => {} });
  try {
    const client = await connectIfRunning({ env: host });
    expect(client, "MCP host must find the service started by the terminal").not.toBeNull();
    if (client !== null) {
      try {
        expect((await client.call("hello", { protocolVersion: PROTOCOL_VERSION })).homeUrl).toBe(svc.homeUrl);
      } finally {
        client.close();
      }
    }
    expect(serviceDirs(shell).socketPath).toBe(serviceDirs(host).socketPath);
  } finally {
    await svc.close();
  }
});

test("one saved identity cannot start a second service on a different socket", async () => {
  const stateDir = tempDir("archer-identity-");
  const first = await service({ stateDir, socketPath: join(tempDir("archer-runtime-first-"), "archer.sock") });
  const before = readFileSync(join(stateDir, "service.json"), "utf8");
  await expect(
    service({ stateDir, socketPath: join(tempDir("archer-runtime-second-"), "archer.sock") }),
  ).rejects.toBeInstanceOf(ServiceRunningError);
  expect(readFileSync(join(stateDir, "service.json"), "utf8")).toBe(before);
  const client = await connectIfRunning({ stateDir, socketPath: first.svc.socketPath });
  expect(client).not.toBeNull();
  client?.close();
});

test("a failed socket lock releases only its newly acquired identity lock", async () => {
  const first = await service();
  const stateDir = tempDir("archer-identity-");
  await expect(service({ stateDir, socketPath: first.svc.socketPath })).rejects.toBeInstanceOf(ServiceRunningError);
  const second = await service({ stateDir });
  expect(second.svc.stateDir).toBe(stateDir);
  const client = await connectIfRunning({ stateDir: first.state });
  expect(client).not.toBeNull();
  client?.close();
});

test("hello reports the configured service identity and an expected identity must match", async () => {
  const defaultService = await service();
  const namedService = await service({ serviceName: "review" });

  const direct = await connectService(namedService.svc.socketPath, "review");
  try {
    expect(await direct.call("hello", { protocolVersion: PROTOCOL_VERSION })).toMatchObject({ serviceName: "review" });
  } finally {
    direct.close();
  }

  await expect(connectService(namedService.svc.socketPath, "default")).rejects.toThrow(
    /expected service "default".*reports "review"/,
  );

  const defaultClient = await connectService(defaultService.svc.socketPath, "default");
  try {
    expect(await defaultClient.call("hello", { protocolVersion: PROTOCOL_VERSION })).toMatchObject({
      serviceName: "default",
    });
  } finally {
    defaultClient.close();
  }

  const audit = await connectService(namedService.svc.socketPath, "review");
  try {
    expect(await audit.call("listProjects", {})).toEqual({ projects: [] });
  } finally {
    audit.close();
  }
  await namedService.svc.close();
  await expect(namedService.svc.closed).resolves.toBeUndefined();
});

test("an explicit socket override refuses a different selected identity", async () => {
  const namedService = await service({ serviceName: "review" });
  await expect(
    connectIfRunning({
      env: { ARCHER_SOCKET: namedService.svc.socketPath },
      serviceName: "default",
    }),
  ).rejects.toThrow(/expected service "default".*reports "review"/);
});

test("malformed service identities are refused as invalid configuration", async () => {
  await expect(service({ serviceName: "Review Team" })).rejects.toMatchObject({
    code: "invalid_configuration",
    message: expect.stringMatching(/service name.*must match/),
  });
  await expect(connectService("/unused", "Review Team")).rejects.toEqual(
    expect.objectContaining({
      name: "ServiceUnavailableError",
      message: expect.stringMatching(/expected service name.*must match/),
    } satisfies Partial<ServiceUnavailableError>),
  );
});

for (const [label, identity] of [
  ["missing", undefined],
  ["different", "other"],
] as const) {
  test(`an expected identity refuses and closes a peer with ${label} identity before any other method`, async () => {
    const peer = await controlledPeer({
      protocolVersion: PROTOCOL_VERSION,
      version: "controlled",
      homeUrl: "http://127.0.0.1:4100/token/",
      ...(identity === undefined ? {} : { serviceName: identity }),
    });
    try {
      await expect(connectService(peer.socketPath, "review")).rejects.toBeInstanceOf(ServiceUnavailableError);
      await peer.peerClosed;
      expect(peer.methods).toEqual(["hello"]);
    } finally {
      await peer.close();
    }
  });
}

for (const [label, identity] of [
  ["missing", undefined],
  ["different", "other"],
] as const) {
  test(`protocol mismatch takes priority over ${label} identity and closes the peer`, async () => {
    const peer = await controlledPeer({
      protocolVersion: 99,
      version: "controlled",
      homeUrl: "http://127.0.0.1:4100/token/",
      ...(identity === undefined ? {} : { serviceName: identity }),
    });
    try {
      await expect(connectService(peer.socketPath, "review")).rejects.toThrow(
        /speaks protocol 99.*this server speaks 1/,
      );
      await peer.peerClosed;
      expect(peer.methods).toEqual(["hello"]);
    } finally {
      await peer.close();
    }
  });
}

test("a caller without an expected identity remains compatible with a legacy peer", async () => {
  const peer = await controlledPeer({
    protocolVersion: PROTOCOL_VERSION,
    version: "legacy",
    homeUrl: "http://127.0.0.1:4100/token/",
  });
  try {
    const client = await connectService(peer.socketPath);
    expect(peer.methods).toEqual(["hello"]);
    client.close();
    await peer.peerClosed;
  } finally {
    await peer.close();
  }
});
