// Under an agent client's sandbox (Codex workspace-write), the CLI could not start or reach the
// service: `listen EPERM`. Agents reported "Archer couldn't start" and stopped. A refused listen or
// connect now says it is most likely the client's sandbox, what to check, and to prefer the MCP tools.
import { chmodSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService, ensureService, ServiceUnavailableError } from "../../src/service/index.ts";
import { explainSandbox, SANDBOX_HINT } from "../../src/service/sandbox.ts";
import { tempDir } from "./support.ts";

const locked: string[] = [];
afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o700);
});

const expectHint = (message: string): void => {
  expect(message).toContain("most likely the agent client's sandbox");
  expect(message).toMatch(/sandbox_mode/);
  expect(message).toMatch(/Claude Code/);
  expect(message).toMatch(/MCP tools/);
  expect(message).toMatch(/tell the person/);
};

test("a refused listen says it is most likely the sandbox; other errors are left alone", () => {
  const refused = Object.assign(new Error("listen EPERM: operation not permitted 127.0.0.1:41000"), { code: "EPERM" });
  expectHint(explainSandbox(refused).message);
  expect(explainSandbox(explainSandbox(refused)).message.split(SANDBOX_HINT)).toHaveLength(2);
  expectHint(
    explainSandbox(Object.assign(new Error("listen EACCES: permission denied 0.0.0.0:80"), { code: "EACCES" })).message,
  );
  expect(explainSandbox(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" })).message).toBe(
    "listen EADDRINUSE",
  );
});

test("the real service's refused listen reaches the agent through the front door", async () => {
  const state = tempDir("archer-sandbox-");
  // The service's own refusal, as it lands in service.log, surfaced by the front door that started it.
  const command = [
    process.execPath,
    "-e",
    `process.stderr.write("archer: listen EPERM: operation not permitted 127.0.0.1:41000\\n"); process.exit(1)`,
  ];
  const error = await ensureService({
    stateDir: state,
    socketPath: join(state, "a.sock"),
    command,
    timeoutMs: 10_000,
  }).then(
    () => new Error("started"),
    (failure: unknown) => failure as Error,
  );
  expect(error).toBeInstanceOf(ServiceUnavailableError);
  expect(error.message).toContain("listen EPERM");
  expectHint(error.message);
});

test("a refused connect to the service's socket says so too, rather than starting another", async () => {
  const dir = tempDir("archer-sandbox-");
  const socket = join(dir, "s", "a.sock");
  mkdirSync(join(dir, "s"), { mode: 0o700 });
  const server = createServer(() => {});
  await new Promise<void>((ok) => server.listen(socket, ok));
  try {
    chmodSync(join(dir, "s"), 0o000);
    locked.push(join(dir, "s"));
    const error = await connectService(socket).then(
      () => new Error("connected"),
      (failure: unknown) => failure as Error,
    );
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error.message).toMatch(/EACCES|EPERM/);
    expectHint(error.message);
  } finally {
    chmodSync(join(dir, "s"), 0o700);
    await new Promise((ok) => server.close(ok));
  }
});
