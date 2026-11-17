// Package review P10: plain HTTP on an address other machines reach is served, with a warning.
import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { plainHttpWarning } from "../../src/service/cli.ts";
import { startService } from "../../src/service/service.ts";
import { cleanUp, openPage, ownerFetch, serviceBase, tempDir } from "./support.ts";

afterEach(cleanUp);

test.each([
  ["http://192.168.1.20:4000/projects/p/?token=x", true],
  ["http://archerbox.local:4000/", true],
  ["http://127.0.0.1:4000/", false],
  ["http://localhost:4000/", false],
  ["http://[::1]:4000/", false],
  ["https://192.168.1.20:4000/", false],
])("%s warns: %s", (url, warns) => {
  expect(plainHttpWarning(url) !== undefined).toBe(warns);
});

test("a wildcard plain-HTTP service starts and logs the warning", async () => {
  const dir = tempDir(),
    lines: string[] = [];
  const svc = await startService({
    host: "0.0.0.0",
    forceHttp: true,
    stateDir: join(dir, "state"),
    env: { HOME: dir, ARCHER_OPEN_BROWSER: "never" },
    log: (line) => lines.push(line),
  });
  try {
    expect(lines.join("\n")).toMatch(/warning: plain HTTP on every interface/);
  } finally {
    await svc.close();
  }
}, 30_000);

// Open to the network is visible: the log says so, and the page's connection answer carries the
// address and since when, for its quiet notice. A loopback service says nothing.
test("a network-bound service logs and announces its network access; a loopback one does not", async () => {
  const dir = tempDir(),
    lines: string[] = [];
  const open = await startService({
    host: "0.0.0.0",
    forceHttp: true,
    stateDir: join(dir, "state"),
    env: { HOME: dir, ARCHER_OPEN_BROWSER: "never" },
    log: (line) => lines.push(line),
  });
  const connection = async (homeUrl: string) =>
    (await ownerFetch(`${serviceBase(homeUrl)}api/connection`)).json() as Promise<Record<string, unknown>>;
  try {
    expect(lines.join("\n")).toMatch(
      /open to the network at http:\/\/\S+ \(bound to 0\.0\.0\.0\) since \S+; turn off with setup_network_access enabled: false/,
    );
    expect(await connection(open.homeUrl)).toMatchObject({
      networkAccess: { address: expect.stringMatching(/^http:\/\//), since: expect.any(String) },
    });
  } finally {
    await open.close();
  }
  const local = await startService({
    stateDir: join(dir, "state2"),
    env: { HOME: dir, ARCHER_OPEN_BROWSER: "never" },
    log: () => {},
  });
  try {
    expect(await connection(local.homeUrl)).not.toHaveProperty("networkAccess");
  } finally {
    await local.close();
  }
}, 30_000);

// Codex review (2026-10-22): a restart kept automatic HTTP as forced HTTP, skipping the bound-address check.
test("automatic HTTP is handed to a restart as automatic, forced HTTP as forced", async () => {
  const { connectService } = await import("../../src/service/service-client.ts");
  const { parseRestartConfiguration } = await import("../../src/service/restart.ts");
  const dir = tempDir();
  for (const [forceHttp, expected] of [
    [undefined, false],
    [true, true],
  ] as const) {
    const svc = await startService({
      ...(forceHttp === undefined ? {} : { forceHttp }),
      stateDir: join(dir, `state-${String(forceHttp)}`),
      env: { HOME: dir, ARCHER_OPEN_BROWSER: "never" },
      log: () => {},
    });
    const client = await connectService(svc.socketPath);
    try {
      const configuration = await client.call("restartConfiguration", {});
      expect(configuration.transport).toEqual({ scheme: "http", forceHttp: expected });
      expect(parseRestartConfiguration(configuration).transport).toEqual({ scheme: "http", forceHttp: expected });
    } finally {
      client.close();
      await svc.close();
    }
  }
}, 30_000);

// O42: on a network bind the home link names the LAN address, and this computer dials it from that
// address, not loopback. The home page refused it (404), so `archer doctor` failed and the owner's own
// browser got "Open the link Archer gave you" from the link Archer gave. The home link now signs the browser
// in and lands on Projects, which must open there too.
test("a network-bound service serves its home page to this computer at the network address", async () => {
  const dir = tempDir();
  const svc = await startService({
    host: "0.0.0.0",
    forceHttp: true,
    stateDir: join(dir, "state"),
    env: { HOME: dir, ARCHER_OPEN_BROWSER: "never" },
    log: () => {},
  });
  try {
    const host = new URL(svc.homeUrl).hostname;
    expect(host).not.toMatch(/^(127\.|localhost$|\[?::1)/);
    const reply = await openPage(svc.homeUrl);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("<html");
  } finally {
    await svc.close();
  }
}, 30_000);
