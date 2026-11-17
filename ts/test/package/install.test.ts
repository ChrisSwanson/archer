// The private package end to end: build the tgz, install it with `npx ./<tgz> setup` into a
// throwaway HOME, then drive the installed `archer mcp` over stdio, as Codex would.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildPackage, packageManifest } from "../../scripts/package.ts";
import { REPO } from "../terminal/models.ts";
import { http, pageWorkers } from "../service/support.ts";
import { nextUiBuild, snapshotUiDist } from "./ui-dist.ts";

// Every test here spawns npm/npx or the installed CLI; on a loaded host one call can take well over 15 s.
vi.setConfig({ testTimeout: 120_000 });

let scratch: string;
let tgz: string;
/** The packed package's `bin/archer.mjs`, from the tgz unpacked once (`setupIn`). */
let unpackedBin: string;
let home: string;
/** The packaged pages: a private copy of ui/dist (see ui-dist.ts). */
let pages: string;

/** Only Node on PATH (plus the system tools npm needs), and nothing of the person's own setup. */
function freshEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    // A stand-in `codex`: setup sets Codex up only when it is on PATH.
    PATH: [join(home, ".local", "bin"), join(scratch, "tools"), dirname(process.execPath), "/usr/bin", "/bin"].join(
      ":",
    ),
    HOME: home,
    // The writers root stays shared so a child writer excludes its parent test (src/comments/lock.ts).
    ...(process.env.ARCHER_WRITERS_DIR ? { ARCHER_WRITERS_DIR: process.env.ARCHER_WRITERS_DIR } : {}),
    // npm never reaches the registry: with a fresh HOME (an empty cache) every `npx ./<tgz>` would
    // otherwise ask it for npm's latest version and audit the install before running setup, and
    // a stalled network held setup past its 240 s bound with no output (known failure T4).
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    // One npm cache for the file, not one per HOME: the first `npx ./<tgz>` (the real packed install, in the first
    // test that sets up) unpacks and installs the package; every later one runs that same install of the same tgz
    // instead of unpacking it again. Each HOME, and what setup writes into it, stays its own.
    npm_config_cache: join(scratch, "npm-cache"),
    ...extra,
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "archer-package-"));
  home = join(scratch, "home");
  mkdirSync(home);
  mkdirSync(join(scratch, "tools"));
  writeFileSync(join(scratch, "tools", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // A UI build already in the checkout is reused, from a private copy; otherwise the package script builds it first.
  const kept = await snapshotUiDist(join(scratch, "ui-dist"));
  if (kept === undefined) {
    tgz = await buildPackage(join(scratch, "out"));
    pages = (await snapshotUiDist(join(scratch, "ui-dist")))!;
  } else {
    pages = kept;
    tgz = await buildPackage(join(scratch, "out"), { pages });
  }
  const unpacked = join(scratch, "unpacked");
  mkdirSync(unpacked);
  execFileSync("tar", ["xzf", tgz, "-C", unpacked]);
  unpackedBin = join(unpacked, "package", "bin", "archer.mjs");
}, 180_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("the package manifest refuses publishing three ways", () => {
  const manifest = packageManifest("1.0.0") as {
    private: boolean;
    license: string;
    publishConfig: { registry: string };
    scripts: { prepublishOnly: string };
  };
  expect(manifest.private).toBe(true);
  expect(manifest.license).toBe("Apache-2.0");
  expect(manifest.publishConfig.registry).toMatch(/\.invalid\/$/);
  expect(manifest.scripts.prepublishOnly).toContain("process.exit(1)");
  const stage = join(scratch, "out", "package");
  const publish = spawnSync("npm", ["publish", "--dry-run"], { cwd: stage, encoding: "utf8", env: freshEnv() });
  expect(publish.status).not.toBe(0);
}, 60_000); // npm itself can take >15 s to start on a loaded host

test("the tgz carries the CLI, the fresh page and the skill, and no Claude Code plugin", () => {
  const files = execFileSync("tar", ["tzf", tgz], { encoding: "utf8" }).split("\n");
  for (const file of [
    "bin/archer.mjs",
    "bin/setup.mjs",
    "dist/archer.js",
    "dist/assets/archer-ui.html",
    "skills/archer/SKILL.md",
    "LICENSE",
    "NOTICE",
  ]) {
    expect(files).toContain(`package/${file}`);
  }
  // ADR 0035 §5: no plugin by default. A .claude-plugin at the root would also make Codex rename the linked skill.
  expect(files.filter((file) => /^package\/(\.claude-plugin|\.mcp\.json|hooks)\b/.test(file))).toEqual([]);
  // The bundle says its `archer mcp` is the relay, so setup can tell older MCP processes apart.
  expect(
    JSON.parse(execFileSync("tar", ["xzOf", tgz, "package/dist/package.json"], { encoding: "utf8" })).archerMcp,
  ).toBe("relay");
  // Package review P11: the resvg wasm (MPL-2.0) and elkjs (EPL-2.0) ship with their licences named.
  const notices = execFileSync("tar", ["xzOf", tgz, "package/THIRD_PARTY_NOTICES.md"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  expect(notices).toMatch(/## @resvg\/resvg-wasm@[\d.]+\n\nLicence: MPL-2\.0\. Source: \S+/);
  expect(notices).toMatch(/## elkjs@[\d.]+\n\nLicence: EPL-2\.0/);
  expect(notices).toContain("Mozilla Public License");
  const page = execFileSync("tar", ["xzOf", tgz, "package/dist/assets/archer-ui.html"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(page.equals(readFileSync(join(pages, "index.html")))).toBe(true);
  // The MCP App's single file (ADR 0003), and the web page's layout worker beside it with its compressed copies.
  const mcp = execFileSync("tar", ["xzOf", tgz, "package/dist/assets/archer-mcp-app.html"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(mcp.equals(readFileSync(join(pages, "mcp", "index.html")))).toBe(true);
  const [worker] = readdirSync(join(pages, "page-assets"));
  expect(page.toString("utf8")).toContain(worker!);
  for (const suffix of ["", ".gz", ".br", ".sha256"])
    expect(files).toContain(`package/dist/assets/page-assets/${worker}${suffix}`);
});

test("npx <tgz> setup --mcp installs into HOME, wires Codex, and the installed MCP server works over stdio", async () => {
  const setup = spawnSync("npx", ["--yes", `./${basename(tgz)}`, "setup", "--mcp", "--no-claude"], {
    cwd: dirname(tgz),
    encoding: "utf8",
    env: freshEnv(),
    timeout: 120_000,
  });
  expect(setup.status, setup.stderr).toBe(0);
  const shim = join(home, ".local", "bin", "archer");
  const data = join(home, ".local", "share", "archer");
  // A link to the installed version's skill (no plugin root above it, so Codex names it "archer").
  const codexSkill = join(home, ".codex", "skills", "archer");
  expect(readlinkSync(codexSkill)).toBe(join(data, "current", "skills", "archer"));
  expect(readFileSync(join(codexSkill, "SKILL.md"), "utf8")).toBe(
    readFileSync(join(REPO, "ts", "plugin", "skills", "archer", "SKILL.md"), "utf8"),
  );
  // The hook runs the installed shim by its full, quoted path, and a host runs it through a shell with a PATH that
  // need not hold the bin folder: it prints nothing (no service runs) and exits 0.
  const hook = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks.UserPromptSubmit[0].hooks[0]
    .command as string;
  expect(hook).toBe(`'${shim}' inbox --brief --hook codex`);
  const ran = spawnSync("/bin/sh", ["-c", hook], {
    cwd: scratch,
    encoding: "utf8",
    env: { ...freshEnv(), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    input: "{}",
  });
  expect([ran.status, ran.stdout]).toEqual([0, ""]);
  const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  expect(codex).toContain(`[mcp_servers.archer]\ncommand = ${JSON.stringify(shim)}\nargs = ["mcp"]`);
  // No Claude Code plugin or marketplace of setup's own.
  expect(existsSync(join(data, ".claude-plugin"))).toBe(false);
  expect(existsSync(join(data, "relay-plugin"))).toBe(false);
  // Local use needs no setting; another device is one agent step (or one command) away.
  expect(setup.stdout).not.toMatch(/force_http|tls setup/);
  expect(setup.stdout).toContain("To open Archer on another device, ask your agent, or run  archer network-access");

  const pkgVersion = (JSON.parse(readFileSync(join(REPO, "ts", "package.json"), "utf8")) as { version: string })
    .version;
  expect(execFileSync(shim, ["--version"], { encoding: "utf8", env: freshEnv() })).toBe(`${pkgVersion}\n`);

  // A second setup of the same build is a no-op upgrade: same copy, one Codex block,
  // and the person's own approval line kept.
  writeFileSync(
    join(home, ".codex", "config.toml"),
    codex.replace('args = ["mcp"]', 'args = ["mcp"]\ndefault_tools_approval_mode = "approve"'),
  );
  const again = spawnSync("npx", ["--yes", `./${basename(tgz)}`, "setup", "--no-claude"], {
    cwd: dirname(tgz),
    encoding: "utf8",
    env: freshEnv(),
    timeout: 120_000,
  });
  expect(again.status, again.stderr).toBe(0);
  const upgraded = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  expect(upgraded.match(/\[mcp_servers\.archer\]/g)).toHaveLength(1);
  expect(upgraded).toContain('default_tools_approval_mode = "approve"');
  // Approving Archer's tools never approves opening it to the network: that one still asks, once in the block.
  expect(upgraded.split('[mcp_servers.archer.tools.setup_network_access]\napproval_mode = "prompt"')).toHaveLength(2);
  // So is `archer setup` run from the installed copy.
  const fromInstalled = spawnSync(shim, ["setup", "--no-claude"], { cwd: scratch, encoding: "utf8", env: freshEnv() });
  expect(fromInstalled.status, fromInstalled.stderr).toBe(0);
  expect(readdirSync(join(data, "versions"))).toHaveLength(1);

  const project = join(scratch, "project");
  mkdirSync(join(project, ".archer", "notes"), { recursive: true });
  mkdirSync(join(project, ".git"));
  writeFileSync(
    join(project, ".archer", "notes", "flow.md"),
    "---\nauthor: agent\n---\n# Flow\n\n```mermaid\n%% archer-id: main\nflowchart LR\n  a[Client] e1@-->|calls| b[API]\n```\n",
  );
  const state = join(scratch, "state");
  const env = freshEnv({
    ARCHER_FORCE_HTTP: "true",
    ARCHER_HOST: "127.0.0.1",
    ARCHER_OPEN_BROWSER: "never",
    ARCHER_STATE_DIR: state,
    ARCHER_SOCKET: join(state, "archer.sock"),
  });
  const client = new Client({ name: "package-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: shim, args: ["mcp"], cwd: project, env, stderr: "pipe" }));
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read_diagram", "write_diagram", "present_diagram", "set_emphasis"]),
    );
    const read = await client.callTool({ name: "read_diagram", arguments: { viewId: "notes/flow.md#main" } });
    expect(read.structuredContent).toMatchObject({ compile: { status: "compiled" } });
    const presented = await client.callTool({ name: "present_diagram", arguments: { viewId: "notes/flow.md#main" } });
    const url = (presented.structuredContent as { ui: { url: string } }).ui.url;
    expect(new URL(url).port).not.toBe("40399");
    const opened = await pageWorkers(url);
    expect(opened.page.status).toBe(200);
    expect(opened.workers.map((worker) => [worker.status, worker.contentType])).toEqual([
      [200, "text/javascript; charset=utf-8"],
    ]);
  } finally {
    await client.close();
    const stopped = spawnSync(shim, ["stop"], { cwd: project, encoding: "utf8", env });
    expect(stopped.stdout).toBe("Archer stopped.\n");
  }

  const removed = spawnSync(shim, ["uninstall", "--no-claude"], { cwd: scratch, encoding: "utf8", env: freshEnv() });
  expect(removed.status, removed.stderr).toBe(0);
  expect(existsSync(data)).toBe(false);
  expect(existsSync(shim)).toBe(false);
  expect(() => lstatSync(join(home, ".codex", "skills", "archer"))).toThrow();
  expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).not.toContain("mcp_servers.archer");
  expect(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"))).toEqual({});
}, 240_000);

test("archer upgrade installs a package and hot swaps the running main Archer to it, keeping its address and the old page's worker", async () => {
  const other = join(scratch, "upgrade-home");
  mkdirSync(other);
  const env = {
    ...freshEnv({ ARCHER_FORCE_HTTP: "true", ARCHER_HOST: "127.0.0.1", ARCHER_OPEN_BROWSER: "never" }),
    HOME: other,
    PATH: [join(other, ".local", "bin"), join(scratch, "tools"), dirname(process.execPath), "/usr/bin", "/bin"].join(
      ":",
    ),
  };
  const setup = spawnSync("npx", ["--yes", `./${basename(tgz)}`, "setup", "--no-claude", "--no-codex"], {
    cwd: dirname(tgz),
    encoding: "utf8",
    env,
    timeout: 120_000,
  });
  expect(setup.status, setup.stderr).toBe(0);
  const shim = join(other, ".local", "bin", "archer");
  // A missing or unnamed package is refused before anything is touched.
  expect(spawnSync(shim, ["upgrade"], { encoding: "utf8", env }).status).toBe(2);
  expect(spawnSync(shim, ["upgrade", join(scratch, "missing.tgz")], { encoding: "utf8", env }).status).toBe(1);
  const project = join(scratch, "upgrade-project");
  mkdirSync(join(project, ".archer"), { recursive: true });
  mkdirSync(join(project, ".git"));
  const served = spawnSync(shim, ["serve"], { cwd: project, encoding: "utf8", env, timeout: 60_000 });
  expect(served.status, served.stderr).toBe(0);
  const url = served.stdout.trim().split("\n").pop()!;
  expect(new URL(url).port).not.toBe("40399");
  try {
    // A tab of the running build that has not started its worker yet: it holds the page, which names it.
    // `connection: close`: a kept-alive socket to the service being swapped out would hang up on the next request.
    const exchange = await http(url, { headers: { connection: "close" } });
    const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const loaded = await http(new URL(exchange.headers.location as string, url).href, {
      headers: { cookie, connection: "close" },
    });
    expect(loaded.status).toBe(200);
    // The next build: another worker (other bytes, another name) in another package.
    const next = nextUiBuild(pages, join(scratch, "ui-dist-next"));
    expect(loaded.body).toContain(next.before);
    const nextTgz = await buildPackage(join(scratch, "out-next"), { pages: next.dest });
    // The package sits in an npm project's dist/, as scripts/ship.sh leaves it: npm must not
    // resolve it against that project's root.
    const checkout = join(scratch, "upgrade-checkout");
    mkdirSync(join(checkout, "dist"), { recursive: true });
    writeFileSync(
      join(checkout, "package.json"),
      JSON.stringify({ name: "checkout", private: true, workspaces: ["ts"] }),
    );
    const inProject = join(checkout, "dist", basename(nextTgz));
    copyFileSync(nextTgz, inProject);
    const upgraded = spawnSync(shim, ["upgrade", inProject, "--no-claude", "--no-codex"], {
      cwd: checkout,
      encoding: "utf8",
      env,
      timeout: 240_000,
    });
    expect(upgraded.status, `${upgraded.stdout}\n${upgraded.stderr}`).toBe(0);
    expect(upgraded.stdout).toMatch(/Archer restarted \(\S+\) in \d+ ms/);
    // The same skill: no line about restarting sessions (their tools come through the relay).
    expect(upgraded.stdout).not.toMatch(/[Rr]estart your/);
    // A new tab gets the new page and its worker; the tab loaded before still gets the worker its page named.
    const opened = await pageWorkers(url);
    expect(opened.page.status).toBe(200);
    expect(opened.workers.map((worker) => [worker.name, worker.status])).toEqual([[next.after, 200]]);
    const old = await http(new URL(`/-/page-assets/${next.before}`, url).href, { headers: { cookie } });
    expect(old.status).toBe(200);
    expect(old.body).toBe(readFileSync(join(pages, "page-assets", next.before), "utf8"));
  } finally {
    spawnSync(shim, ["stop"], { cwd: project, encoding: "utf8", env });
  }
}, 300_000);

/**
 * `archer setup` of the packed package, run as the installed bin runs it (`node bin/archer.mjs setup`), from the
 * tgz's own contents unpacked once. The tests above run it through `npx ./<tgz>`, the real packed install (npm
 * unpacking the tgz into its cache, then setup copying itself into HOME); these are about what setup does with a
 * HOME, Codex config or shim it finds, not about npm, so they skip npm's start and install (about 0.8 s each).
 */
const setupIn = (env: Record<string, string>, ...flags: string[]) =>
  spawnSync(process.execPath, [unpackedBin, "setup", ...flags], {
    cwd: dirname(tgz),
    encoding: "utf8",
    env,
    timeout: 120_000,
  });

// Codex review: the Codex config is edited only where setup is certain.
test("setup ignores its own marker lines inside a multi-line string, and keeps a person's lines in its block", () => {
  const stringHome = join(scratch, "codex-string-home");
  const quoted = { home: stringHome, bin: join(stringHome, ".local", "bin"), env: { ...freshEnv(), HOME: stringHome } };
  // Setup's own marker lines inside a string are text too.
  const example = `instructions = """\nExample:\n# >>> archer setup (managed: \`archer uninstall\` removes this block)\n# <<< archer setup\n[example]\ncommand = "example"\n"""\n`;
  mkdirSync(join(quoted.home, ".codex"), { recursive: true });
  writeFileSync(join(quoted.home, ".codex", "config.toml"), example);
  const second = setupIn(quoted.env, "--mcp", "--no-claude");
  expect(second.status, second.stderr).toBe(0);
  const after = readFileSync(join(quoted.home, ".codex", "config.toml"), "utf8");
  expect(after.startsWith(example)).toBe(true);
  expect(after.match(/^\[mcp_servers\.archer\]$/gm)).toHaveLength(1);

  // A person's own lines in setup's block survive a rerun byte for byte, blank lines in a value too.
  const env = '[mcp_servers.archer.env]\nNOTE = """a\n\nb"""';
  const end = after.lastIndexOf("# <<< archer setup");
  writeFileSync(join(quoted.home, ".codex", "config.toml"), `${after.slice(0, end)}${env}\n${after.slice(end)}`);
  const third = setupIn(quoted.env, "--no-claude");
  expect(third.status, third.stderr).toBe(0);
  const rerun = readFileSync(join(quoted.home, ".codex", "config.toml"), "utf8");
  expect(rerun.startsWith(example)).toBe(true);
  expect(rerun).toContain(
    `startup_timeout_sec = 30\n[mcp_servers.archer.tools.setup_network_access]\napproval_mode = "prompt"\n${env}\n# <<< archer setup`,
  );
  // Uninstall removes the real block only.
  expect(
    spawnSync(join(quoted.bin, "archer"), ["uninstall", "--no-claude"], { encoding: "utf8", env: quoted.env }).status,
  ).toBe(0);
  expect(readFileSync(join(quoted.home, ".codex", "config.toml"), "utf8")).toBe(example);
});

test("setup and uninstall leave a shim someone edited, even one naming setup's copy", () => {
  const other = join(scratch, "edited-shim-home");
  const bin = join(other, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const edited = `#!/bin/sh\nnode='/usr/bin/node'; export ARCHER_CONFIG='/custom'\n[ -x "$node" ] || node=node\nexec "$node" '${join(other, ".local", "share", "archer", "current", "bin", "archer.mjs")}' "$@"\n`;
  writeFileSync(join(bin, "archer"), edited, { mode: 0o755 });
  const env = { ...freshEnv(), HOME: other };
  const setup = setupIn(env, "--no-claude", "--no-codex");
  expect(setup.status, setup.stderr).toBe(0);
  expect(readFileSync(join(bin, "archer"), "utf8")).toBe(edited);
  expect(setup.stdout).toContain("belongs to another program");
});

test("setup never overwrites another program's ~/.local/bin/archer, and says what to do", () => {
  const other = join(scratch, "other-home");
  mkdirSync(join(other, ".local", "bin"), { recursive: true });
  writeFileSync(join(other, ".local", "bin", "archer"), "#!/bin/sh\necho an older archer\n", { mode: 0o755 });
  const setup = setupIn({ ...freshEnv(), HOME: other }, "--no-claude", "--no-codex");
  expect(setup.status, setup.stderr).toBe(0);
  expect(readFileSync(join(other, ".local", "bin", "archer"), "utf8")).toBe("#!/bin/sh\necho an older archer\n");
  expect(setup.stdout).toContain("ARCHER_BIN_DIR");
  expect(setup.stdout).not.toContain("force_http");
});

// Codex review of this branch (2026-10-21): setup and uninstall touch only what setup owns.
test("setup and uninstall keep other people's files, Codex tables and blank lines", () => {
  const other = join(scratch, "review-home");
  const bin = join(other, ".local", "bin");
  mkdirSync(join(other, ".codex"), { recursive: true });
  const config = 'model = "x"\ninstructions = """\na\n\n\n\nb\n"""\n\n[mcp_servers."archer"]\ncommand = "mine"\n';
  writeFileSync(join(other, ".codex", "config.toml"), config);
  const env = { ...freshEnv(), HOME: other };
  const setup = setupIn(env, "--mcp", "--no-claude");
  expect(setup.status, setup.stderr).toBe(0);
  // A quoted table name is the same table: not appended again.
  expect(readFileSync(join(other, ".codex", "config.toml"), "utf8")).toBe(config);
  expect(setup.stdout).toContain("already has [mcp_servers.archer]");
  const removed = spawnSync(join(bin, "archer"), ["uninstall", "--no-claude"], { encoding: "utf8", env });
  expect(removed.status, removed.stderr).toBe(0);
  expect(readFileSync(join(other, ".codex", "config.toml"), "utf8")).toBe(config);

  // Uninstall refuses a data directory setup did not make.
  const foreign = join(other, "foreign");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "keep.txt"), "someone else's");
  mkdirSync(bin, { recursive: true });
  const again = setupIn(env, "--no-claude", "--no-codex");
  expect(again.status, again.stderr).toBe(0);
  const refused = spawnSync(join(bin, "archer"), ["uninstall", "--no-claude", "--no-codex"], {
    encoding: "utf8",
    env: { ...env, ARCHER_INSTALL_DIR: foreign },
  });
  expect(refused.status).not.toBe(0);
  expect(readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("someone else's");
});

test("with another program's ~/.local/bin/archer, Codex is not pointed at it", () => {
  const other = join(scratch, "conflict-home");
  mkdirSync(join(other, ".local", "bin"), { recursive: true });
  writeFileSync(join(other, ".local", "bin", "archer"), "#!/bin/sh\necho other\n", { mode: 0o755 });
  const setup = setupIn({ ...freshEnv(), HOME: other }, "--mcp", "--no-claude");
  expect(setup.status, setup.stderr).toBe(0);
  const config = existsSync(join(other, ".codex", "config.toml"))
    ? readFileSync(join(other, ".codex", "config.toml"), "utf8")
    : "";
  expect(config).not.toContain(JSON.stringify(join(other, ".local", "bin", "archer")));
});

// Package review P9: a Claude-only machine gets no ~/.codex.
test("without codex on PATH, setup leaves ~/.codex alone and says so", () => {
  const other = join(scratch, "claude-only-home");
  mkdirSync(other);
  const env = {
    ...freshEnv(),
    HOME: other,
    PATH: [join(other, ".local", "bin"), dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  };
  const setup = setupIn(env, "--no-claude");
  expect(setup.status, setup.stderr).toBe(0);
  expect(existsSync(join(other, ".codex"))).toBe(false);
  expect(setup.stdout).toMatch(/Codex: not found on PATH/);
});

// Package review P8, P12, P13.
test("setup remembers ARCHER_BIN_DIR, keeps the current and previous copies, and the shim runs setup's node", () => {
  const other = join(scratch, "bin-home");
  const bin = join(other, "tools-bin");
  const data = join(other, ".local", "share", "archer");
  mkdirSync(join(data, "versions", "0.0.1-older"), { recursive: true });
  mkdirSync(join(data, "versions", "0.0.2-previous"), { recursive: true });
  writeFileSync(join(data, ".archer-setup"), "archer setup\n");
  symlinkSync(join("versions", "0.0.2-previous"), join(data, "current"));
  const env = { ...freshEnv(), HOME: other };
  const setup = setupIn({ ...env, ARCHER_BIN_DIR: bin }, "--no-claude", "--no-codex");
  expect(setup.status, setup.stderr).toBe(0);
  expect(readdirSync(join(data, "versions")).sort()).toEqual(expect.arrayContaining(["0.0.2-previous"]));
  expect(readdirSync(join(data, "versions"))).not.toContain("0.0.1-older");
  expect(readdirSync(join(data, "versions"))).toHaveLength(2);
  expect(readFileSync(join(bin, "archer"), "utf8")).toContain(process.execPath);
  // Running setup again (same build) still keeps the copy it replaced the first time.
  const again = spawnSync(join(bin, "archer"), ["setup", "--no-claude", "--no-codex"], { encoding: "utf8", env });
  expect(again.status, again.stderr).toBe(0);
  expect(readdirSync(join(data, "versions"))).toContain("0.0.2-previous");
  const removed = spawnSync(join(bin, "archer"), ["uninstall", "--no-claude", "--no-codex"], { encoding: "utf8", env });
  expect(removed.status, removed.stderr).toBe(0);
  expect(existsSync(join(bin, "archer"))).toBe(false);
  expect(removed.stdout).toContain(`removed ${join(bin, "archer")} and ${data}`);
  expect(removed.stdout).not.toContain(join(other, ".local", "bin"));
});

// O38: a copy older than the previous one stays while a process still runs it by path, and setup names
// those sessions.
test("setup keeps an older copy a running process uses, and names that session", () => {
  const other = join(scratch, "used-home");
  const data = join(other, ".local", "share", "archer");
  for (const [name, body] of [
    ["0.0.0-used", { name: "archer" }],
    ["0.0.1-older", { name: "archer" }],
    ["0.0.2-previous", { archerMcp: "relay" }],
  ] as const) {
    mkdirSync(join(data, "versions", name, "dist"), { recursive: true });
    writeFileSync(join(data, "versions", name, "dist", "package.json"), JSON.stringify(body));
  }
  writeFileSync(join(data, ".archer-setup"), "archer setup\n");
  symlinkSync(join("versions", "0.0.2-previous"), join(data, "current"));
  // A /proc of one session's MCP server, run from 0.0.0-used by path.
  const proc = join(other, "proc"),
    pid = join(proc, "4242"),
    session = join(other, "code", "x");
  mkdirSync(pid, { recursive: true });
  mkdirSync(session, { recursive: true });
  const uid = process.getuid?.() ?? 0;
  writeFileSync(join(proc, "stat"), "cpu  1 2 3\nbtime 1000\n");
  writeFileSync(join(pid, "cmdline"), `node\0${join(data, "versions", "0.0.0-used", "dist", "archer.js")}\0mcp\0`);
  writeFileSync(join(pid, "status"), `Name:\tnode\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  writeFileSync(join(pid, "stat"), `4242 (node) S ${Array.from({ length: 18 }, () => "0").join(" ")} 0 0\n`);
  writeFileSync(join(pid, "comm"), "node\n");
  symlinkSync(session, join(pid, "cwd"));
  const env = { ...freshEnv(), HOME: other, ARCHER_TEST_PROC: proc };
  const setup = setupIn(env, "--no-claude", "--no-codex");
  expect(setup.status, setup.stderr).toBe(0);
  expect(readdirSync(join(data, "versions"))).toEqual(expect.arrayContaining(["0.0.0-used", "0.0.2-previous"]));
  expect(readdirSync(join(data, "versions"))).not.toContain("0.0.1-older");
  expect(setup.stdout).toContain("kept the older copy 0.0.0-used: still used by pid 4242 (~/code/x)");
  // Network access off (no record): the hint says how to turn it on.
  expect(setup.stdout).toContain("To open Archer on another device, ask your agent");
});

// O44: a relay (or any command) started through `current` names no copy on its command line; it runs the
// copy `current` named when it started. Two upgrades later setup removed that copy while the session ran.
test("setup keeps the copy a session started through current still runs, two upgrades on", () => {
  const other = join(scratch, "through-current-home");
  const data = join(other, ".local", "share", "archer");
  for (const name of ["0.0.0-started-on", "0.0.1-unused", "0.0.2-current"]) {
    mkdirSync(join(data, "versions", name, "dist"), { recursive: true });
    writeFileSync(join(data, "versions", name, "dist", "package.json"), JSON.stringify({ archerMcp: "relay" }));
  }
  writeFileSync(join(data, ".archer-setup"), "archer setup\n");
  writeFileSync(join(data, "previous-version"), "0.0.0-started-on\n");
  symlinkSync(join("versions", "0.0.2-current"), join(data, "current"));
  // A relay started (in 1970, by this fake /proc) through current, before current moved to 0.0.2-current.
  const proc = join(other, "proc"),
    pid = join(proc, "4343"),
    session = join(other, "code", "y");
  mkdirSync(pid, { recursive: true });
  mkdirSync(session, { recursive: true });
  const uid = process.getuid?.() ?? 0;
  writeFileSync(join(proc, "stat"), "cpu  1 2 3\nbtime 1000\n");
  writeFileSync(join(pid, "cmdline"), `node\0${join(data, "current", "bin", "archer.mjs")}\0mcp\0`);
  writeFileSync(join(pid, "status"), `Name:\tnode\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  writeFileSync(join(pid, "stat"), `4343 (node) S ${Array.from({ length: 18 }, () => "0").join(" ")} 0 0\n`);
  writeFileSync(join(pid, "comm"), "node\n");
  symlinkSync(session, join(pid, "cwd"));
  const env = { ...freshEnv(), HOME: other, ARCHER_TEST_PROC: proc };
  const setup = setupIn(env, "--no-claude", "--no-codex");
  expect(setup.status, setup.stderr).toBe(0);
  const versions = readdirSync(join(data, "versions"));
  expect(versions).toEqual(expect.arrayContaining(["0.0.0-started-on", "0.0.2-current"]));
  expect(versions).not.toContain("0.0.1-unused");
  expect(setup.stdout).toContain("kept the older copy 0.0.0-started-on: still used by pid 4343 (~/code/y)");
  // The history now records the move, so the next setup knows the same without the seed.
  expect(readFileSync(join(data, "current-history"), "utf8")).toMatch(
    /^0 0\.0\.0-started-on\n\d+ 0\.0\.2-current\n\d+ \S+\n$/,
  );
});

// O39: with network access on, setup's last line says where the page is open, not how to open it.
test("setup's page hint follows network access", () => {
  const other = join(scratch, "net-home");
  mkdirSync(join(other, ".local", "state", "archer"), { recursive: true });
  writeFileSync(
    join(other, ".local", "state", "archer", "network-access.json"),
    JSON.stringify({ enabled: true, host: "mybox.lan", bind: "192.168.1.42", since: "2026-10-23T13:47:05.818Z" }),
  );
  const setup = setupIn({ ...freshEnv(), HOME: other }, "--no-claude", "--no-codex");
  expect(setup.status, setup.stderr).toBe(0);
  expect(setup.stdout).toContain(
    "Archer's page is open to your network over HTTPS at mybox.lan (since 2026-10-23T13:47:05.818Z)",
  );
  expect(setup.stdout).not.toContain("ask your agent");
});

const oldNode = ["/usr/bin/node"].find(
  (path) =>
    existsSync(path) &&
    Number(spawnSync(path, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8" }).stdout.trim()) < 22,
);
test.skipIf(oldNode === undefined)("the CLI refuses a Node below 22.18 first on PATH, naming it", () => {
  const dist = join(scratch, "out", "package", "dist", "archer.js");
  const run = spawnSync(oldNode!, [dist, "--version"], { encoding: "utf8" });
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/needs Node 22\.18 or newer; .* is 20\./);
});
