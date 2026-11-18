// The 0.7.0 install (ADR 0035 §5–8), fast: setup's pieces against temp HOMEs, and `archer setup`,
// `uninstall` and `upgrade` run from a small fake package (the real pkg/bin, a stub CLI), with stand-in
// `claude` and `codex` commands. The real tgz end to end is install.test.ts.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { HOOK_COMMAND as CONTRACT_HOOK } from "../../src/agents/contract.ts";
import {
  HOOK_COMMAND,
  MIN_NODE,
  main as setupMain,
  SKILL_MODES,
  addTurnHook,
  isOwnShim,
  shimText,
  setupCodexMcp,
  hookCommand,
  installSkill,
  paths,
  removeSkill,
  removeTurnHook,
  // @ts-expect-error -- a plain .mjs script without types
} from "../../pkg/bin/setup.mjs";
// @ts-expect-error -- a plain .mjs script without types
import { skillDigest } from "../../pkg/bin/upgrade.mjs";
import { FAKE_CLAUDE } from "./fake-claude.ts";

const PKG_BIN = resolve(import.meta.dirname, "../../pkg/bin");
const scratch = mkdtempSync(join(tmpdir(), "archer-agent-install-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string): string => {
  const dir = join(scratch, `${name}-${made++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

type Paths = ReturnType<typeof paths> & {
  data: string;
  claudeSkill: string;
  codexSkill: string;
  claudeSettings: string;
  codexHooks: string;
};
const pathsFor = (home: string, extra: Record<string, string> = {}): Paths => paths({ HOME: home, ...extra });

test("the hook commands are the contract's, and every host has a skill mode", () => {
  expect(HOOK_COMMAND).toEqual(CONTRACT_HOOK);
  expect(Object.keys(SKILL_MODES).sort()).toEqual(["claude", "codex"]);
  for (const mode of Object.values(SKILL_MODES)) expect(["link", "copy"]).toContain(mode);
  // Written with the shim's absolute, quoted path: a desktop host need not have the bin folder on PATH.
  expect(hookCommand({ shim: "/home/o'k/.local/bin/archer" }, "codex")).toBe(
    "'/home/o'\\''k/.local/bin/archer' inbox --brief --hook codex",
  );
});

test("a shim setup wrote is still its own after a later build rewords the shim and asks for a newer Node (decision 42)", async () => {
  const home = fresh("own-shim");
  const p = pathsFor(home);
  mkdirSync(p.bin, { recursive: true });
  const entry = `'${join(p.data, "current", "bin", "archer.mjs")}'`;
  // A later setup: this one with shimText's message reworded and a newer MIN_NODE.
  const later = join(fresh("later-setup"), "setup.mjs");
  const source = readFileSync(join(PKG_BIN, "setup.mjs"), "utf8");
  const reworded = source
    .replace("export const MIN_NODE = [22, 18];", "export const MIN_NODE = [24, 0];")
    .replace(
      "Archer's Node (%s) is missing and there is no node on PATH.",
      "cannot find Archer's Node (%s), nor any node on PATH.",
    );
  expect(reworded).not.toBe(source);
  writeFileSync(later, reworded);
  const next = (await import(later)) as { isOwnShim: typeof isOwnShim; shimText: typeof shimText };
  expect(next.shimText("/usr/bin/node", entry)).not.toBe(shimText("/usr/bin/node", entry));
  const own = (text: string): boolean => {
    writeFileSync(p.shim, text);
    return isOwnShim(p, p.shim) && next.isOwnShim(p, p.shim);
  };
  const written = shimText("/usr/bin/node", entry);
  expect(own(written)).toBe(true);
  expect(own(shimText("/home/o'k/node", entry))).toBe(true);
  // A shim without the marker line (as the 0.6.x and early 0.7.0 builds wrote) is not setup's.
  expect(written).toContain("\n# archer-shim v1\n");
  expect(own(written.replace("# archer-shim v1\n", ""))).toBe(false);
  expect(own(`#!/bin/sh\nexec node ${entry} "$@"\n`)).toBe(false);
  // Another program's file, a shim for another data directory, or one with lines added after it is not.
  for (const text of [
    '#!/bin/sh\nexec /opt/other/archer "$@"\n',
    shimText("/usr/bin/node", "'/elsewhere/current/bin/archer.mjs'"),
    `${written}rm -rf ~\n`,
  ]) {
    writeFileSync(p.shim, text);
    expect([isOwnShim(p, p.shim), next.isOwnShim(p, p.shim)]).toEqual([false, false]);
  }
});

test("setup, the shim's entry, the CLI and the package ask for the same Node", () => {
  const ts = resolve(import.meta.dirname, "../..");
  const want = `${MIN_NODE[0]}.${MIN_NODE[1]}`;
  expect(want).toBe("22.18");
  const cli = readFileSync(join(ts, "src", "bin", "archer.ts"), "utf8");
  expect(cli).toContain(`major < ${MIN_NODE[0]} || (major === ${MIN_NODE[0]} && minor < ${MIN_NODE[1]})`);
  expect(readFileSync(join(PKG_BIN, "archer.mjs"), "utf8")).toContain(
    `major < ${MIN_NODE[0]} || (major === ${MIN_NODE[0]} && minor < ${MIN_NODE[1]})`,
  );
  expect(JSON.parse(readFileSync(join(ts, "package.json"), "utf8")).engines.node).toBe(`>=${want}`);
  expect(readFileSync(join(ts, "scripts", "package.ts"), "utf8")).toContain(`engines: { node: ">=${want}" }`);
});

describe("the skill", () => {
  function installed(home: string): Paths {
    const p = pathsFor(home);
    mkdirSync(join(p.data, "versions", "1.0.0-a", "skills", "archer"), { recursive: true });
    writeFileSync(join(p.data, "versions", "1.0.0-a", "skills", "archer", "SKILL.md"), "skill one\n");
    symlinkSync(join("versions", "1.0.0-a"), join(p.data, "current"));
    return p;
  }

  test("is linked to the installed version, so an upgrade reaches it at once", () => {
    const p = installed(fresh("skill-link"));
    const todo: string[] = [];
    for (const host of ["claude", "codex"] as const)
      expect(installSkill(p, host, "1.0.0-a", todo, "link")).toContain("link");
    expect(todo).toEqual([]);
    expect(readlinkSync(p.claudeSkill)).toBe(join(p.data, "current", "skills", "archer"));
    expect(readFileSync(join(p.codexSkill, "SKILL.md"), "utf8")).toBe("skill one\n");
    // The next version: `current` moves and the linked skill with it.
    mkdirSync(join(p.data, "versions", "1.0.1-b", "skills", "archer"), { recursive: true });
    writeFileSync(join(p.data, "versions", "1.0.1-b", "skills", "archer", "SKILL.md"), "skill two\n");
    rmSync(join(p.data, "current"));
    symlinkSync(join("versions", "1.0.1-b"), join(p.data, "current"));
    expect(readFileSync(join(p.claudeSkill, "SKILL.md"), "utf8")).toBe("skill two\n");
    expect(removeSkill(p, "claude")).toBe(true);
    expect(existsSync(p.claudeSkill)).toBe(false);
  });

  test("is a marked copy for a host set to copy, refreshed by running setup again", () => {
    const p = installed(fresh("skill-copy"));
    installSkill(p, "codex", "1.0.0-a", [], "copy");
    expect(lstatSync(p.codexSkill).isDirectory()).toBe(true);
    expect(readFileSync(join(p.codexSkill, ".archer-setup"), "utf8")).toBe("1.0.0-a\n");
    writeFileSync(join(p.data, "versions", "1.0.0-a", "skills", "archer", "SKILL.md"), "refreshed\n");
    installSkill(p, "codex", "1.0.0-a", [], "copy");
    expect(readFileSync(join(p.codexSkill, "SKILL.md"), "utf8")).toBe("refreshed\n");
    // A host moved from copy to link (or back) is switched over: both are setup's.
    installSkill(p, "codex", "1.0.0-a", [], "link");
    expect(lstatSync(p.codexSkill).isSymbolicLink()).toBe(true);
  });

  test("never replaces someone else's folder or link, and says so", () => {
    const p = installed(fresh("skill-foreign"));
    mkdirSync(p.claudeSkill, { recursive: true });
    writeFileSync(join(p.claudeSkill, "SKILL.md"), "mine\n");
    mkdirSync(dirname(p.codexSkill), { recursive: true });
    symlinkSync(join(scratch, "elsewhere"), p.codexSkill);
    const todo: string[] = [];
    expect(installSkill(p, "claude", "1.0.0-a", todo, "link")).toBeUndefined();
    expect(installSkill(p, "codex", "1.0.0-a", todo, "link")).toBeUndefined();
    expect(readFileSync(join(p.claudeSkill, "SKILL.md"), "utf8")).toBe("mine\n");
    expect(readlinkSync(p.codexSkill)).toBe(join(scratch, "elsewhere"));
    expect(todo).toHaveLength(2);
    expect(todo[0]).toContain("is not setup's");
    expect(removeSkill(p, "claude")).toBe(false);
    expect(removeSkill(p, "codex")).toBe(false);
    expect(existsSync(join(p.claudeSkill, "SKILL.md"))).toBe(true);
  });
});

describe("the turn-start hook", () => {
  const command = HOOK_COMMAND["claude-code"];
  test("is added once beside the person's own settings and hooks, and removed alone", () => {
    const file = join(fresh("hook"), "settings.json");
    const before = {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "my-own-hook" }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }],
      },
      enabledPlugins: { "x@y": true },
    };
    writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`, { mode: 0o640 });
    expect(addTurnHook(file, command)).toBe("added");
    expect(addTurnHook(file, command)).toBe("present");
    const added = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(added)).toEqual(["model", "permissions", "hooks", "enabledPlugins"]);
    expect(added.hooks.Stop).toEqual(before.hooks.Stop);
    expect(added.hooks.UserPromptSubmit).toEqual([
      ...before.hooks.UserPromptSubmit,
      { hooks: [{ type: "command", command, timeout: 5 }] },
    ]);
    expect(lstatSync(file).mode & 0o777).toBe(0o640);
    expect(removeTurnHook(file, command)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(before);
    expect(removeTurnHook(file, command)).toBe(false);
  });

  test("in a group the person shares with it, only its own entry goes; an empty settings file gets one", () => {
    const file = join(fresh("hook-shared"), "settings.json");
    const own = { type: "command", command, timeout: 5 };
    writeFileSync(
      file,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine" }, own] }] } }),
    );
    expect(addTurnHook(file, command)).toBe("present");
    expect(removeTurnHook(file, command)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine" }] }] },
    });
    const empty = join(fresh("hook-new"), "nested", "hooks.json");
    expect(addTurnHook(empty, HOOK_COMMAND.codex)).toBe("added");
    expect(JSON.parse(readFileSync(empty, "utf8"))).toEqual({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: HOOK_COMMAND.codex, timeout: 5 }] }] },
    });
    expect(removeTurnHook(empty, HOOK_COMMAND.codex)).toBe(true);
    expect(JSON.parse(readFileSync(empty, "utf8"))).toEqual({});
  });

  test("writes a linked settings file where it points, keeping the link", () => {
    const dir = fresh("hook-link");
    writeFileSync(join(dir, "real.json"), "{}\n");
    symlinkSync(join(dir, "real.json"), join(dir, "settings.json"));
    expect(addTurnHook(join(dir, "settings.json"), command)).toBe("added");
    expect(readlinkSync(join(dir, "settings.json"))).toBe(join(dir, "real.json"));
    expect(JSON.parse(readFileSync(join(dir, "real.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
  });

  test("moves the bare form, or another shim's path, to this command in place, once", () => {
    const file = join(fresh("hook-move"), "settings.json");
    const absolute = "'/home/me/.local/bin/archer' inbox --brief --hook claude-code";
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command, timeout: 5 },
                { type: "command", command: "mine" },
              ],
            },
            { hooks: [{ type: "command", command: "'/old/bin/archer' inbox --brief --hook claude-code" }] },
          ],
        },
      }),
    );
    expect(addTurnHook(file, absolute)).toBe("updated");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.UserPromptSubmit).toEqual([
      {
        hooks: [
          { type: "command", command: absolute, timeout: 5 },
          { type: "command", command: "mine" },
        ],
      },
    ]);
    expect(addTurnHook(file, absolute)).toBe("present");
    // Someone else's program of another name, with the same arguments, is not Archer's.
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "/usr/bin/archery inbox --brief --hook claude-code" }] },
          ],
        },
      }),
    );
    expect(addTurnHook(file, absolute)).toBe("added");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.UserPromptSubmit).toHaveLength(2);
  });

  test("an exact entry beside a leftover bare form: the bare form goes, so the hook runs once", () => {
    const file = join(fresh("hook-leftover"), "settings.json");
    const absolute = "'/x/bin/archer' inbox --brief --hook claude-code";
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command },
                { type: "command", command: "mine" },
              ],
            },
            { hooks: [{ type: "command", command: absolute, timeout: 5 }] },
          ],
        },
      }),
    );
    expect(addTurnHook(file, absolute)).toBe("updated");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "mine" }] },
      { hooks: [{ type: "command", command: absolute, timeout: 5 }] },
    ]);
    expect(addTurnHook(file, absolute)).toBe("present");
  });

  test("a read-only linked file (home-manager's) is reported and left, never half-written", () => {
    const dir = fresh("hook-ro");
    mkdirSync(join(dir, "store"));
    writeFileSync(join(dir, "store", "settings.json"), "{}\n");
    chmodSync(join(dir, "store", "settings.json"), 0o444);
    chmodSync(join(dir, "store"), 0o555);
    symlinkSync(join(dir, "store", "settings.json"), join(dir, "settings.json"));
    try {
      expect(addTurnHook(join(dir, "settings.json"), command)).toBe("read-only");
      expect(readFileSync(join(dir, "store", "settings.json"), "utf8")).toBe("{}\n");
      expect(readdirSync(join(dir, "store"))).toEqual(["settings.json"]);
      expect(readlinkSync(join(dir, "settings.json"))).toBe(join(dir, "store", "settings.json"));
    } finally {
      chmodSync(join(dir, "store"), 0o755);
    }
    // A read-only file in a folder that can be written is not replaced either.
    const plain = join(dir, "plain.json");
    writeFileSync(plain, "{}\n", { mode: 0o444 });
    expect(addTurnHook(plain, command)).toBe("read-only");
    expect(readFileSync(plain, "utf8")).toBe("{}\n");
  });

  test("a dangling link is reported and stays a link", () => {
    const dir = fresh("hook-dangling");
    symlinkSync(join(dir, "dotfiles", "settings.json"), join(dir, "settings.json"));
    expect(addTurnHook(join(dir, "settings.json"), command)).toBe("dangling");
    expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, "dotfiles"))).toBe(false);
  });

  test("the temporary file is exclusive: a link planted at the old fixed name is never written through", () => {
    const dir = fresh("hook-planted");
    const file = join(dir, "settings.json");
    writeFileSync(file, "{}\n");
    writeFileSync(join(dir, "victim"), "keep\n");
    symlinkSync(join(dir, "victim"), `${file}.archer-${process.pid}`);
    expect(addTurnHook(file, command)).toBe("added");
    expect(readFileSync(join(dir, "victim"), "utf8")).toBe("keep\n");
    expect(readdirSync(dir).sort()).toEqual([`settings.json`, `settings.json.archer-${process.pid}`, "victim"].sort());
  });

  test("leaves a file it cannot read as JSON exactly as it was", () => {
    const file = join(fresh("hook-bad"), "settings.json");
    const text = '{\n  // a comment\n  "model": "x"\n}\n';
    writeFileSync(file, text);
    expect(addTurnHook(file, command)).toBe("unreadable");
    expect(removeTurnHook(file, command)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(text);
    writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: "not a list" } }));
    expect(addTurnHook(file, command)).toBe("unreadable");
  });
});

/** A small package: the real pkg/bin, a skill, and a stub CLI that says Archer is not running. */
function fakePackage(name: string, skill = "skill text\n"): string {
  const root = join(fresh(name), "package");
  cpSync(PKG_BIN, join(root, "bin"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "archer",
      version: "0.7.0-test",
      type: "module",
      private: true,
      bin: { archer: "bin/archer.mjs" },
    }),
  );
  mkdirSync(join(root, "skills", "archer"), { recursive: true });
  writeFileSync(join(root, "skills", "archer", "SKILL.md"), skill);
  mkdirSync(join(root, "dist"));
  writeFileSync(
    join(root, "dist", "package.json"),
    JSON.stringify({ name: "archer", type: "module", archerMcp: "relay" }),
  );
  writeFileSync(join(root, "dist", "archer.js"), 'console.error("Archer is not running"); process.exit(1);\n');
  return root;
}

/** A temp HOME with stand-in `claude` and `codex` on PATH (and nothing of the person's own). */
function machine(
  name: string,
  claudeState?: unknown,
): { home: string; env: Record<string, string>; p: Paths; claudeDir: string } {
  const home = fresh(name);
  const tools = join(home, "tools");
  const claudeDir = join(home, ".claude");
  mkdirSync(tools);
  mkdirSync(claudeDir);
  writeFileSync(join(tools, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  writeFileSync(join(tools, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (claudeState !== undefined) writeFileSync(join(claudeDir, "stub.json"), JSON.stringify(claudeState));
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    PATH: [join(home, ".local", "bin"), tools, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  };
  return { home, env, p: pathsFor(home, { CLAUDE_CONFIG_DIR: claudeDir }), claudeDir };
}
const archer = (pkg: string, env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, [join(pkg, "bin", "archer.mjs"), ...args], { encoding: "utf8", env, timeout: 60_000 });
const userServers = (dir: string) =>
  existsSync(join(dir, ".claude.json"))
    ? ((JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as { mcpServers?: Record<string, unknown> })
        .mcpServers ?? {})
    : {};

describe("archer setup and uninstall", () => {
  test("a new install links the skill and adds one turn-start hook per host, with no plugin and no MCP", () => {
    const pkg = fakePackage("new");
    const { env, p, claudeDir } = machine("new-home");
    writeFileSync(
      p.claudeSettings,
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine" }] }] },
        theme: "dark",
      }),
    );
    const setup = archer(pkg, env, "setup");
    expect(setup.status, setup.stderr + setup.stdout).toBe(0);
    for (const skill of [p.claudeSkill, p.codexSkill])
      expect(readlinkSync(skill)).toBe(join(p.data, "current", "skills", "archer"));
    expect(readFileSync(join(p.claudeSkill, "SKILL.md"), "utf8")).toBe("skill text\n");
    // No plugin and no second skill: the package root has no .claude-plugin for a host to load.
    expect(existsSync(join(realpathSync(join(p.data, "current")), ".claude-plugin"))).toBe(false);
    const calls = join(claudeDir, "calls.log");
    expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").not.toMatch(/install|mcp add/);
    expect(userServers(claudeDir)).toEqual({});
    expect(existsSync(p.codexConfig)).toBe(false);
    const settings = JSON.parse(readFileSync(p.claudeSettings, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(JSON.parse(readFileSync(p.codexHooks, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      hookCommand(p, "codex"),
    );
    expect(JSON.parse(readFileSync(p.claudeSettings, "utf8")).hooks.UserPromptSubmit[1].hooks[0].command).toBe(
      `'${p.shim}' inbox --brief --hook claude-code`,
    );
    const linked = lstatSync(join(p.data, "current")).mtimeMs;
    // Again: the same, one hook each.
    expect(archer(pkg, env, "setup").status).toBe(0);
    expect(JSON.parse(readFileSync(p.claudeSettings, "utf8")).hooks.UserPromptSubmit).toHaveLength(2);
    expect(JSON.parse(readFileSync(p.codexHooks, "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
    // The same copy again leaves `current` alone, so no session is later taken for one from before it.
    expect(lstatSync(join(p.data, "current")).mtimeMs).toBe(linked);

    const removed = archer(join(p.data, "current"), env, "uninstall");
    expect(removed.status, removed.stderr).toBe(0);
    expect(() => lstatSync(p.claudeSkill)).toThrow();
    expect(() => lstatSync(p.codexSkill)).toThrow();
    expect(JSON.parse(readFileSync(p.claudeSettings, "utf8"))).toEqual({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine" }] }] },
      theme: "dark",
    });
    expect(JSON.parse(readFileSync(p.codexHooks, "utf8"))).toEqual({});
  });

  test("--mcp registers one server named archer on each host, running the relay; uninstall removes only those", () => {
    const pkg = fakePackage("mcp");
    const { env, p, claudeDir } = machine("mcp-home");
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }),
    );
    const setup = archer(pkg, env, "setup", "--mcp");
    expect(setup.status, setup.stderr + setup.stdout).toBe(0);
    expect(userServers(claudeDir)).toEqual({
      other: { command: "x", args: [] },
      archer: { type: "stdio", command: p.shim, args: ["mcp"], env: {} },
    });
    expect(readFileSync(p.codexConfig, "utf8")).toContain(
      `[mcp_servers.archer]\ncommand = ${JSON.stringify(p.shim)}\nargs = ["mcp"]`,
    );
    // A rerun keeps the one registration; without --mcp too (the install has MCP now).
    expect(archer(pkg, env, "setup").status).toBe(0);
    expect(Object.keys(userServers(claudeDir))).toEqual(["other", "archer"]);
    expect(readFileSync(p.codexConfig, "utf8").match(/\[mcp_servers\.archer\]/g)).toHaveLength(1);
    expect(readFileSync(join(claudeDir, "calls.log"), "utf8").match(/^mcp add/gm)).toHaveLength(1);
    expect(archer(pkg, env, "uninstall").status).toBe(0);
    expect(userServers(claudeDir)).toEqual({ other: { command: "x", args: [] } });
    expect(readFileSync(p.codexConfig, "utf8")).not.toContain("mcp_servers.archer");
  });

  test("--mcp leaves a person's own Claude Code server named archer", () => {
    const pkg = fakePackage("mcp-own");
    const { env, claudeDir } = machine("mcp-own-home");
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { archer: { command: "mine", args: [] } } }),
    );
    const setup = archer(pkg, env, "setup", "--mcp", "--no-codex");
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("a user MCP server named archer is already configured");
    expect(userServers(claudeDir)).toEqual({ archer: { command: "mine", args: [] } });
    expect(archer(pkg, env, "uninstall", "--no-codex").status).toBe(0);
    expect(userServers(claudeDir)).toEqual({ archer: { command: "mine", args: [] } });
  });

  test("a read-only settings file is a to-do line; the rest of setup still runs", () => {
    const pkg = fakePackage("ro-settings");
    const { env, p, claudeDir } = machine("ro-settings-home");
    const store = join(claudeDir, "store");
    mkdirSync(store);
    writeFileSync(join(store, "settings.json"), "{}\n");
    chmodSync(store, 0o555);
    symlinkSync(join(store, "settings.json"), p.claudeSettings);
    try {
      const setup = archer(pkg, env, "setup");
      expect(setup.status, setup.stderr + setup.stdout).toBe(0);
      expect(setup.stdout).toMatch(
        /settings\.json cannot be written \(read-only, through a link\), so setup added no turn-start hook/,
      );
      expect(readFileSync(join(store, "settings.json"), "utf8")).toBe("{}\n");
      // Codex, after Claude Code, was still set up.
      expect(JSON.parse(readFileSync(p.codexHooks, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command).toBe(
        hookCommand(p, "codex"),
      );
      expect(readlinkSync(p.codexSkill)).toBe(join(p.data, "current", "skills", "archer"));
    } finally {
      chmodSync(store, 0o755);
    }
  });

  test("a read-only Codex config.toml is a to-do line; setup and uninstall finish the rest and exit 0", () => {
    const pkg = fakePackage("ro-codex");
    const { env, p, home } = machine("ro-codex-home");
    const store = join(home, "store");
    mkdirSync(store);
    writeFileSync(join(store, "config.toml"), 'model = "x"\n');
    chmodSync(join(store, "config.toml"), 0o444);
    chmodSync(store, 0o555);
    mkdirSync(p.codex, { recursive: true });
    symlinkSync(join(store, "config.toml"), p.codexConfig);
    try {
      const setup = archer(pkg, env, "setup", "--mcp");
      expect(setup.status, setup.stderr + setup.stdout).toBe(0);
      expect(setup.stdout).toMatch(
        /config\.toml cannot be written \(read-only, through a link\), so setup left it as it was/,
      );
      expect(setup.stdout).toContain("Still to do by hand");
      expect(readFileSync(join(store, "config.toml"), "utf8")).toBe('model = "x"\n');
      expect(readdirSync(store)).toEqual(["config.toml"]);
      // Everything after it still ran: the Codex hook and skill, the shim.
      expect(JSON.parse(readFileSync(p.codexHooks, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command).toBe(
        hookCommand(p, "codex"),
      );
      expect(readlinkSync(p.codexSkill)).toBe(join(p.data, "current", "skills", "archer"));
      expect(existsSync(p.shim)).toBe(true);
    } finally {
      chmodSync(store, 0o755);
    }

    // Setup's block in a config that became read-only: uninstall says so and removes the rest.
    rmSync(p.codexConfig);
    expect(archer(pkg, env, "setup", "--mcp").status).toBe(0);
    expect(readFileSync(p.codexConfig, "utf8")).toContain("[mcp_servers.archer]");
    chmodSync(p.codexConfig, 0o444);
    chmodSync(p.codex, 0o555);
    try {
      const removed = archer(join(p.data, "current"), env, "uninstall");
      expect(removed.status, removed.stderr + removed.stdout).toBe(0);
      expect(removed.stdout).toMatch(/config\.toml cannot be written \(read-only\), so uninstall left it as it was/);
      expect(readFileSync(p.codexConfig, "utf8")).toContain("[mcp_servers.archer]");
      expect(existsSync(p.data)).toBe(false);
      expect(existsSync(p.shim)).toBe(false);
    } finally {
      chmodSync(p.codex, 0o755);
    }
  });

  test("Codex MCP registration reads again and retries once when another program wrote the config meanwhile", () => {
    const p = pathsFor(fresh("codex-changed"));
    mkdirSync(p.codex, { recursive: true });
    writeFileSync(p.codexConfig, 'model = "x"\n');
    const todo: string[] = [];
    let writes = 0;
    // Codex writes its config between setup's read and its write, once.
    setupCodexMcp(p, todo, {
      beforeWrite: () => {
        if (writes++ === 0) writeFileSync(p.codexConfig, 'model = "y"\n');
      },
    });
    expect(writes).toBe(2);
    expect(todo).toEqual([]);
    const after = readFileSync(p.codexConfig, "utf8");
    expect(after.startsWith('model = "y"\n')).toBe(true);
    expect(after).toContain(`[mcp_servers.archer]\ncommand = ${JSON.stringify(p.shim)}`);
    // Changed on every attempt: a to-do line, the file as the other program left it.
    writeFileSync(p.codexConfig, 'model = "x"\n');
    let n = 0;
    setupCodexMcp(p, todo, { beforeWrite: () => writeFileSync(p.codexConfig, `model = "z${n++}"\n`) });
    expect(todo).toHaveLength(1);
    expect(todo[0]).toMatch(/kept changing while setup ran/);
    expect(readFileSync(p.codexConfig, "utf8")).toMatch(/^model = "z\d"\n$/);
  });

  test("the shim is written through an exclusive temporary file: a link planted at the old fixed name is never followed", () => {
    const pkg = fakePackage("shim-planted");
    const { env, p, home } = machine("shim-planted-home");
    mkdirSync(p.bin, { recursive: true });
    writeFileSync(join(home, "victim"), "keep\n");
    symlinkSync(join(home, "victim"), `${p.shim}.tmp`);
    const setup = archer(pkg, env, "setup", "--no-claude", "--no-codex");
    expect(setup.status, setup.stderr + setup.stdout).toBe(0);
    expect(readFileSync(join(home, "victim"), "utf8")).toBe("keep\n");
    expect(readFileSync(p.shim, "utf8")).toMatch(/^#!\/bin\/sh\n/);
    expect(readdirSync(p.bin).sort()).toEqual(["archer", "archer.tmp"]);
  });

  test("a shim whose Node is gone, with no node on PATH: the hook exits 0 with one line, other commands exit 1", () => {
    const pkg = fakePackage("shim-no-node");
    const { env, p, home } = machine("shim-no-node-home");
    const setup = archer(pkg, env, "setup", "--no-claude", "--no-codex");
    expect(setup.status, setup.stderr + setup.stdout).toBe(0);
    // The Node setup ran with, since removed (an upgraded Homebrew or nvm Node, say).
    const gone = join(home, "gone-node", "bin", "node");
    const shim = join(home, "shim-gone");
    writeFileSync(shim, readFileSync(p.shim, "utf8").replaceAll(`'${process.execPath}'`, `'${gone}'`), { mode: 0o755 });
    expect(readFileSync(shim, "utf8")).toContain(gone);
    const empty = join(home, "no-node");
    mkdirSync(empty);
    const run = (path: string, ...args: string[]) =>
      spawnSync("/bin/sh", [shim, ...args], { encoding: "utf8", env: { HOME: home, PATH: path } });
    const hook = run(empty, "inbox", "--brief", "--hook", "codex");
    expect(hook.status, hook.stderr).toBe(0);
    expect(hook.stdout).toBe("");
    expect(hook.stderr.trim().split("\n")).toHaveLength(1);
    expect(hook.stderr).toMatch(
      /^archer: Archer's Node \(.*gone-node.*\) is missing and there is no node on PATH.*archer setup {2}again/,
    );
    const other = run(empty, "--version");
    expect(other.status).toBe(1);
    expect(other.stderr).toBe(hook.stderr);
    // `nodejs` on PATH (Debian's name) is used when `node` is not.
    const debian = join(home, "debian");
    mkdirSync(debian);
    symlinkSync(process.execPath, join(debian, "nodejs"));
    const fallback = run(debian, "inbox", "--brief", "--hook", "codex");
    expect(fallback.stderr).toContain("Archer is not running");
    expect(archer(pkg, env, "uninstall", "--no-claude", "--no-codex").status).toBe(0);
    expect(existsSync(p.shim)).toBe(false);
  });

  test("bad options are refused before anything changes", () => {
    const pkg = fakePackage("flags");
    const { env, p } = machine("flags-home");
    expect(archer(pkg, env, "setup", "--legacy").status).toBe(2);
    expect(archer(pkg, env, "uninstall", "--mcp").status).toBe(2);
    expect(archer(pkg, env, "uninstall", "--legacy").status).toBe(2);
    expect(existsSync(p.data)).toBe(false);
  });
});

describe("archer upgrade", () => {
  /** The fake package as a tgz, as `npm pack` lays it out. */
  function tgz(root: string, name: string): string {
    const out = join(dirname(root), `${name}.tgz`);
    expect(spawnSync("tar", ["-czf", out, "-C", dirname(root), "package"]).status).toBe(0);
    return out;
  }
  const offline = {
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_offline: "true",
  };

  test("ends with one restart line only when the skill changed, and refreshes the linked skill", () => {
    const { env, p } = machine("upgrade-home");
    const first = fakePackage("up-1", "one\n");
    expect(archer(first, env, "setup", "--no-claude").status).toBe(0);
    const shim = p.shim;
    const run = (pkg: string) =>
      spawnSync(shim, ["upgrade", tgz(pkg, "archer-0.7.0-test"), "--no-claude"], {
        encoding: "utf8",
        env: { ...env, ...offline, npm_config_cache: join(p.home, "npm-cache") },
        timeout: 240_000,
      });
    // Same skill, other bytes elsewhere: no restart line.
    const same = fakePackage("up-2", "one\n");
    writeFileSync(join(same, "dist", "extra.js"), "// changed\n");
    const quiet = run(same);
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0);
    expect(quiet.stdout).toContain("Archer was not running");
    expect(quiet.stdout).not.toMatch(/[Rr]estart your/);
    // A new skill: one line, and the link already shows it.
    const changed = run(fakePackage("up-3", "two\n"));
    expect(changed.status, changed.stdout + changed.stderr).toBe(0);
    expect(
      changed.stdout.match(/Restart your Claude Code and Codex sessions to load the new Archer skill\./g),
    ).toHaveLength(1);
    expect(readFileSync(join(p.codexSkill, "SKILL.md"), "utf8")).toBe("two\n");
    expect(skillDigest(join(p.data, "current"))).toMatch(/^[0-9a-f]{64}$/);
  }, 300_000);

  test("a setup that stops after the new copy became current says so, not that nothing changed", () => {
    const { env, p } = machine("upgrade-fail-home");
    expect(archer(fakePackage("upf-1", "one\n"), env, "setup", "--no-claude").status).toBe(0);
    const old = readlinkSync(join(p.data, "current"));
    // An unterminated managed block in the Codex config stops setup after `current` moved.
    writeFileSync(
      p.codexConfig,
      "# >>> archer setup (managed: `archer uninstall` removes this block)\n[mcp_servers.archer]\n",
    );
    const result = spawnSync(
      p.shim,
      ["upgrade", tgz(fakePackage("upf-2", "two\n"), "archer-0.7.0-test"), "--no-claude"],
      { encoding: "utf8", env: { ...env, ...offline, npm_config_cache: join(p.home, "npm-cache") }, timeout: 240_000 },
    );
    expect(result.status).toBe(1);
    expect(readlinkSync(join(p.data, "current"))).not.toBe(old);
    expect(result.stderr).toContain("setup did not finish");
    expect(result.stderr).toContain("The running Archer was not swapped");
    expect(result.stderr).not.toContain("unchanged");
  }, 300_000);
});

test("setup --help prints its usage and exits 0 instead of calling --help an unknown option", async () => {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  try {
    expect(await setupMain("setup", ["--help"])).toBe(0);
  } finally {
    log.mockRestore();
  }
  expect(lines.join("\n")).toContain("archer setup [--mcp]");
});
