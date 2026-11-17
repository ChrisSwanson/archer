// The turn-start hook (agents/contract.ts HOOK_COMMAND) runs before every prompt the person types:
// always exit 0, the brief line or nothing, never a service start, and a small module graph.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { briefLine, HOOK_COMMAND } from "../../src/agents/contract.ts";
import { hookProjectRoot } from "../../src/bin/hook.ts";
import { main, type Io } from "../../src/bin/main.ts";
import { findProject } from "../../src/project/index.ts";
import { closeFakes, fakeService } from "./fake-agent-service.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(async () => {
  await closeFakes();
  removeTempDirs();
});

const hookArgs = (host: "claude-code" | "codex") => HOOK_COMMAND[host].split(" ").slice(1);

async function run(args: string[], env: Record<string, string>, cwd: string) {
  let out = "",
    err = "";
  const io: Io = {
    cwd,
    env,
    isTTY: false,
    columns: undefined,
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
  };
  return { code: await main(args, io), out, err };
}

test.each(["claude-code", "codex"] as const)(
  "the %s hook prints the brief line when messages wait for this agent",
  async (host) => {
    const fake = await fakeService({ inbox: () => ({ count: 2, messages: [] }) });
    const root = tempDir({ "archer.toml": "version = 1\n" });
    const result = await run(
      hookArgs(host),
      { ARCHER_SOCKET: fake.socketPath, ARCHER_STATE_DIR: fake.dir, ARCHER_AGENT_ID: "agt_4" },
      root,
    );
    expect(result).toEqual({ code: 0, out: `${briefLine(2)}\n`, err: "" });
    // The count is only what would reach the asking agent (decision 5): the service is told who asks.
    expect(fake.requests).toContainEqual({ method: "inbox", params: { root, agentId: "agt_4", brief: true } });
  },
);

test("a session Archer does not know as an agent is told nothing, and the service is not asked", async () => {
  const fake = await fakeService({ inbox: () => ({ count: 2, messages: [] }) });
  const root = tempDir({ "archer.toml": "version = 1\n" });
  const result = await run(
    hookArgs("claude-code"),
    { ARCHER_SOCKET: fake.socketPath, ARCHER_STATE_DIR: join(fake.dir, "state"), HOME: fake.dir },
    root,
  );
  expect(result).toEqual({ code: 0, out: "", err: "" });
  expect(fake.requests).toEqual([]);
});

// Decision 15: no listening to another checkout; a session file an older CLI wrote after
// `--project … --person-requested` is counted for the checkout the agent works in.
test("the hook of an agent whose older session file names another checkout counts its own", async () => {
  const fake = await fakeService({ inbox: () => ({ count: 1, messages: [] }) });
  const root = tempDir({ "archer.toml": "version = 1\n" });
  const state = join(fake.dir, "state");
  mkdirSync(join(state, "agents"), { recursive: true });
  writeFileSync(
    join(state, "agents", `claude-code-${process.pid}.env`),
    `ARCHER_AGENT_ID=agt_8\nARCHER_AGENT_ROOT=${root}\nARCHER_AGENT_CWD=${root}\nARCHER_AGENT_CLAIMED_ROOT=/other\nARCHER_AGENT_PROJECT=other\n`,
  );
  const { runHook } = await import("../../src/bin/hook.ts");
  const { recogniseAgent } = await import("../../src/bin/agent-id.ts");
  const env = { ARCHER_SOCKET: fake.socketPath, ARCHER_STATE_DIR: state };
  expect(recogniseAgent({ env, cwd: root, detected: { host: "claude-code", hostPid: process.pid } })).toEqual({
    agentId: "agt_8",
    root,
    cwd: root,
  });
  let out = "";
  await runHook(hookArgs("claude-code").slice(1), {
    stdout: (t) => {
      out += t;
    },
    env,
    cwd: root,
    detect: () => ({ host: "claude-code", hostPid: process.pid }),
  });
  expect(fake.requests).toContainEqual({ method: "inbox", params: { root, agentId: "agt_8", brief: true } });
  expect(out).toBe(`${briefLine(1)}\n`);
});

test("the hook prints nothing and exits 0 when nothing waits, the service is older, absent, or the arguments are wrong", async () => {
  const root = tempDir({ "archer.toml": "version = 1\n" });
  const none = await fakeService({ inbox: () => ({ count: 0, messages: [] }) });
  const as = { ARCHER_AGENT_ID: "agt_1", ARCHER_STATE_DIR: join(root, "state") };
  expect(await run(hookArgs("claude-code"), { ARCHER_SOCKET: none.socketPath, ...as }, root)).toEqual({
    code: 0,
    out: "",
    err: "",
  });
  const older = await fakeService();
  expect(await run(hookArgs("claude-code"), { ARCHER_SOCKET: older.socketPath, ...as }, root)).toEqual({
    code: 0,
    out: "",
    err: "",
  });
  expect(await run(hookArgs("claude-code"), { ARCHER_SOCKET: join(root, "absent.sock"), ...as }, root)).toEqual({
    code: 0,
    out: "",
    err: "",
  });
  expect(await run(["inbox", "--hook", "vscode"], { ARCHER_SOCKET: none.socketPath }, root)).toEqual({
    code: 0,
    out: "",
    err: "",
  });
  expect(await run(["inbox", "--hook", "codex", "--json"], { ARCHER_SOCKET: none.socketPath }, root)).toEqual({
    code: 0,
    out: "",
    err: "",
  });
});

test("a recognised listener's hook is its heartbeat", async () => {
  const fake = await fakeService({
    inbox: () => ({ count: 1, messages: [] }),
    heartbeat: () => ({ state: "next-turn" }),
  });
  const root = tempDir({ "archer.toml": "version = 1\n" });
  const result = await run(
    hookArgs("codex"),
    { ARCHER_SOCKET: fake.socketPath, ARCHER_AGENT_ID: "agt_7", ARCHER_STATE_DIR: join(root, "state") },
    root,
  );
  expect(result.out).toBe(`${briefLine(1)}\n`);
  expect(fake.requests).toContainEqual({ method: "heartbeat", params: { agentId: "agt_7", via: "hook" } });
});

test("a service that never answers costs at most the hook's deadline", async () => {
  const fake = await fakeService({ inbox: () => new Promise(() => undefined) });
  const root = tempDir({ "archer.toml": "version = 1\n" });
  const started = Date.now();
  expect(
    await run(
      hookArgs("claude-code"),
      { ARCHER_SOCKET: fake.socketPath, ARCHER_AGENT_ID: "agt_1", ARCHER_STATE_DIR: join(root, "state") },
      root,
    ),
  ).toEqual({ code: 0, out: "", err: "" });
  expect(Date.now() - started).toBeLessThan(3000);
});

test.each([
  ["archer.toml above", { "archer.toml": "version = 1\n", "src/a/x.txt": "" }, "src/a"],
  ["a repository", { ".git/HEAD": "ref: x\n", "src/x.txt": "" }, "src"],
  ["inside .archer", { ".archer/notes/x.md": "" }, ".archer/notes"],
  ["nothing", { "a/x.txt": "" }, "a"],
])("the hook finds the project root findProject finds: %s", (_name, files, sub) => {
  const root = tempDir(files);
  expect(hookProjectRoot(join(root, sub))).toBe(findProject(join(root, sub)).root);
});

// The real executable, as the host runs it: no service anywhere, and every module it loads recorded.
test("the installed command finishes fast with no service, starts none, and loads no compiler, Mermaid or MCP SDK", () => {
  const root = tempDir({ "archer.toml": "version = 1\n" });
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  const record = join(root, "loaded.txt");
  const recorder = join(root, "record.mjs");
  writeFileSync(
    recorder,
    `import { registerHooks } from "node:module"; import { appendFileSync } from "node:fs";
registerHooks({ load(url, context, next) { appendFileSync(${JSON.stringify(record)}, url + "\\n"); return next(url, context); } });\n`,
  );
  const entry = fileURLToPath(new URL("../../src/bin/archer.ts", import.meta.url));
  const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    ["--import", recorder, "--import", loader, entry, ...hookArgs("claude-code")],
    {
      cwd: root,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: root,
        ARCHER_STATE_DIR: state,
        ARCHER_HOME: join(root, ".archer-home"),
      },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  const elapsed = Date.now() - started;
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(elapsed).toBeLessThan(8000);
  expect(existsSync(join(state, "archer.sock"))).toBe(false);
  expect(existsSync(join(state, "service.log"))).toBe(false);
  const loaded = readFileSync(record, "utf8")
    .split("\n")
    .filter((url) => url.includes("/ts/src/") || url.includes("node_modules"));
  const ours = loaded.filter((url) => url.includes("/ts/src/")).map((url) => url.slice(url.indexOf("/ts/src/") + 8));
  expect(ours.length).toBeGreaterThan(3);
  expect(
    ours.filter((path) => /^(mermaid|model|application|project|mcp|export|terminal|comments|notes)\//.test(path)),
  ).toEqual([]);
  expect(
    loaded.filter((url) =>
      /node_modules\/(mermaid|elkjs|markdown-it|dompurify|@modelcontextprotocol|@resvg)\//.test(url),
    ),
  ).toEqual([]);
}, 30_000);
