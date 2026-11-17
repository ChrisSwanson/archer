// `archer setup` / `archer uninstall`: installs this package for one user (ADR 0035 §5–8).
//
//   <data>/versions/<id>/       an immutable copy of this package
//   <data>/current -> versions/<id>
//   <bin>/archer                shim running <data>/current/bin/archer.mjs
//   ~/.claude/skills/archer     the skill: a link to <data>/current/skills/archer (SKILL_MODES)
//   $CODEX_HOME/skills/archer   the same, for Codex
//   ~/.claude/settings.json     one UserPromptSubmit hook running '<bin>/archer' inbox --brief --hook claude-code
//                               (the shim by absolute, quoted path: a desktop host need not have <bin> on PATH)
//   $CODEX_HOME/hooks.json      the same for Codex (`--hook codex`)
//   MCP, only for an install that had it or with --mcp: Claude Code user server `archer`
//   (`claude mcp add`), Codex [mcp_servers.archer] (between setup's marker lines). Both run
//   `archer mcp`, the relay to the one service.
//
// <data> is $XDG_DATA_HOME/archer (default ~/.local/share/archer), <bin> is ~/.local/bin or
// ARCHER_BIN_DIR (remembered in <data>/bin-dir, so uninstall finds it without the variable).
// Diagrams, ~/.config/archer and ~/.local/state/archer are never touched.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_NAME = "archer";
const BEGIN = "# >>> archer setup (managed: `archer uninstall` removes this block)";
const END = "# <<< archer setup";
/** The Node the CLI needs (ts/src/bin/archer.ts, bin/archer.mjs and the package's engines say the same; a test keeps them equal). */
export const MIN_NODE = [22, 18];
const MARKER = ".archer-setup";
const BIN_RECORD = "bin-dir";
const PREVIOUS_RECORD = "previous-version";
/** When `current` named each copy: one "<ms since the epoch> <id>" line per move, oldest first (O44). */
const HISTORY_RECORD = "current-history";
/** Setup registered the Claude Code user MCP server `archer` (uninstall removes it only then). */
const CLAUDE_MCP_RECORD = "claude-mcp";

/**
 * How each host gets the skill: a link to <data>/current/skills/archer (an upgrade reaches it at
 * once) or a copy that setup refreshes. Codex 0.163 follows a linked skill folder (checked with
 * `codex debug prompt-input`); it names a skill under a plugin root "<plugin>:<skill>", which is why
 * the package root carries no .claude-plugin. Claude Code is assumed to follow it too; set "copy"
 * for a host that does not.
 */
export const SKILL_MODES = { claude: "link", codex: "link" };

/**
 * The one Archer-owned turn-start hook per host, as ts/src/agents/contract.ts HOOK_COMMAND names it (a test keeps
 * them equal). Setup writes it with the shim's absolute, quoted path in place of `archer` (`hookCommand`), so it
 * runs where the host's PATH lacks <bin>; the bare form, and an older shim path, are recognised as Archer's.
 */
export const HOOK_COMMAND = {
  "claude-code": "archer inbox --brief --hook claude-code",
  codex: "archer inbox --brief --hook codex",
};
/** The hook as setup writes it: the installed shim, by absolute quoted path. */
export const hookCommand = (p, host) => `${quote(p.shim)} ${HOOK_COMMAND[host].slice("archer ".length)}`;
/** Seconds: the hook prints nothing and exits 0 when no service runs, so this is only a backstop. */
const HOOK_TIMEOUT = 5;

export function paths(env = process.env) {
  const home = env.HOME || homedir();
  const data = resolve(env.ARCHER_INSTALL_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "archer"));
  const bin = resolve(env.ARCHER_BIN_DIR || recordedBin(data) || join(home, ".local", "bin"));
  const codex = resolve(env.CODEX_HOME || join(home, ".codex"));
  const claude = resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
  return {
    home,
    data,
    bin,
    shim: join(bin, "archer"),
    codex,
    codexConfig: join(codex, "config.toml"),
    codexSkill: join(codex, "skills", "archer"),
    claude,
    claudeSkill: join(claude, "skills", "archer"),
    claudeSettings: join(claude, "settings.json"),
    // Where Claude Code keeps user-scope MCP servers (read only; written through `claude mcp`).
    claudeJson: env.CLAUDE_CONFIG_DIR ? join(claude, ".claude.json") : join(home, ".claude.json"),
    codexHooks: join(codex, "hooks.json"),
  };
}

function record(data, name) {
  try {
    return readFileSync(join(data, name), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
const recordedBin = (data) => record(data, BIN_RECORD);

const USAGE = "usage: archer setup [--mcp] [--no-claude] [--no-codex] | archer uninstall [--no-claude] [--no-codex]";

export async function main(command, args) {
  const flags = new Set(args);
  const allowed = command === "setup" ? ["--mcp", "--no-claude", "--no-codex"] : ["--no-claude", "--no-codex"];
  for (const flag of flags) {
    if (!allowed.includes(flag)) {
      console.error(`unknown option ${flag}\n${USAGE}`);
      return 2;
    }
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    console.error(`Archer needs Node ${MIN_NODE.join(".")} or newer; this is ${process.versions.node}.`);
    return 1;
  }
  const p = paths();
  const todo = [];
  try {
    if (command === "setup") setup(p, flags, todo);
    else uninstall(p, flags, todo);
  } catch (error) {
    console.error(`archer ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  printTodo(todo);
  return 0;
}

function printTodo(todo) {
  if (todo.length > 0) console.log(`\nStill to do by hand:\n${todo.map((line) => `  - ${line}`).join("\n")}`);
}

function setup(p, flags, todo) {
  const pkg = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
  const id = `${pkg.version}-${contentHash(PACKAGE)}`;
  const dest = join(p.data, "versions", id);
  mkdirSync(join(p.data, "versions"), { recursive: true });
  // Uninstall removes the data directory only when this marker says setup made it.
  writeFileSync(join(p.data, MARKER), "archer setup\n");
  if (!existsSync(dest)) {
    // Copy into a staging name first: a half-written copy is never selected.
    const staging = `${dest}.partial-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    cpSync(PACKAGE, staging, { recursive: true, dereference: false });
    renameSync(staging, dest);
  }
  // The copy this one replaces, remembered so that running setup again keeps it too.
  const prior = currentVersion(p);
  noteCurrentMove(p, prior, record(p.data, PREVIOUS_RECORD), id);
  if (prior !== undefined && prior !== id) writeFileSync(join(p.data, PREVIOUS_RECORD), `${prior}\n`);
  const previous = prior !== undefined && prior !== id ? prior : record(p.data, PREVIOUS_RECORD);
  // The same copy again leaves `current` as it is: re-linking would move its time, and later runs would list
  // sessions started meanwhile as running the copy before it.
  if (prior !== id) replaceSymlink(join("versions", id), join(p.data, "current"));
  console.log(`installed Archer ${pkg.version} -> ${dest}${prior === id ? " (already installed)" : ""}`);
  // The previous copy stays (running sessions and services load assets from the copy they started
  // with), and so does any older one a running process names (O38). The rest are removed. Without /proc (macOS) only the previous one is kept.
  // A process started through `current` names no copy on its command line; it runs the copy `current`
  // named when it started (O44: a relay started on one build lost its files two upgrades later).
  const history = readHistory(p.data);
  const throughCurrent = processesUsing(join(p.data, "current"), undefined, true) ?? [];
  for (const entry of readdirSync(join(p.data, "versions"))) {
    if (entry === id || entry === previous || entry.includes(".partial-")) continue;
    const byPath = processesUsing(join(p.data, "versions", entry));
    const users =
      byPath === undefined
        ? undefined
        : [
            ...byPath,
            ...throughCurrent.filter((user) => user.started !== undefined && copyAt(history, user.started) === entry),
          ];
    if (users !== undefined && users.length > 0) {
      console.log(
        `kept the older copy ${entry}: still used by ${users.map((user) => `pid ${user.pid}${user.cwd === undefined ? "" : ` (${homeRelative(p, user.cwd)})`}`).join(", ")}; a later setup removes it once those sessions have restarted`,
      );
      continue;
    }
    rmSync(join(p.data, "versions", entry), { recursive: true, force: true });
    console.log(`removed the older copy ${entry}`);
  }

  mkdirSync(p.bin, { recursive: true });
  writeFileSync(join(p.data, BIN_RECORD), `${p.bin}\n`);
  const shim = shimText(process.execPath, quote(join(p.data, "current", "bin", "archer.mjs")));
  const shimConflict = existsSync(p.shim) && !isOwnShim(p, p.shim);
  if (shimConflict) {
    // Another program (an older Archer, say) owns that name: leave it.
    todo.push(
      `${p.shim} belongs to another program, so setup left it. Move it away, then run  node ${quote(join(p.data, "current", "bin", "archer.mjs"))} setup  again; or run that with ARCHER_BIN_DIR set to another directory on your PATH (setup remembers it)`,
    );
  } else {
    // An exclusive temporary name (`wx`: never an existing file, never through a planted link), then one rename.
    const temporary = join(p.bin, `.archer.setup-${process.pid}-${randomBytes(6).toString("hex")}`);
    writeFileSync(temporary, shim, { mode: 0o755, flag: "wx" });
    try {
      renameSync(temporary, p.shim);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    }
    console.log(`command: ${p.shim}`);
  }
  if (
    !(process.env.PATH || "")
      .split(delimiter)
      .map((entry) => resolve(entry))
      .includes(p.bin)
  ) {
    todo.push(`put ${p.bin} on your PATH, e.g. add  export PATH="${p.bin}:$PATH"  to ~/.bashrc or ~/.zshrc`);
  }

  if (!flags.has("--no-claude")) setupClaude(p, flags, id, todo, shimConflict);
  if (!flags.has("--no-codex")) {
    // Codex runs the shim: never point it at another program of that name.
    if (shimConflict) todo.push("Codex: not set up, as it runs the archer command; the setup run above sets it up too");
    else if (!which("codex"))
      todo.push("Codex: not found on PATH, so ~/.codex was left alone. After installing it, run  archer setup  again");
    else setupCodex(p, flags, id, todo);
  }
  tlsHint(p);
}

function setupClaude(p, flags, id, todo, shimConflict) {
  const cli = which("claude");
  if (!cli && !existsSync(p.claude)) {
    todo.push(
      "Claude Code: not found (no claude on PATH, no ~/.claude). After installing it, run  archer setup  again",
    );
    return;
  }
  if (shimConflict)
    todo.push(
      "Claude Code: no turn-start hook or MCP server, as both run the archer command; the setup run above adds them",
    );
  else {
    const command = hookCommand(p, "claude-code");
    const hook = addTurnHook(p.claudeSettings, command);
    const problem = hookProblem("Claude Code", p.claudeSettings, hook, command);
    if (problem !== undefined) todo.push(problem);
    else
      console.log(
        `Claude Code: turn-start hook in ${p.claudeSettings}${hook === "present" ? " (already there)" : hook === "updated" ? " (now by the command's full path)" : ""}`,
      );
  }
  // MCP for an install that had it, or when asked.
  if (flags.has("--mcp") || record(p.data, CLAUDE_MCP_RECORD) === MCP_NAME) {
    if (!cli)
      todo.push(
        `Claude Code: the claude command is not on PATH, so setup could not register the MCP server ${MCP_NAME}. Once it is, run  archer setup  again`,
      );
    else if (shimConflict) todo.push(`Claude Code: no MCP server ${MCP_NAME}, as it runs the archer command`);
    else registerClaudeMcp(p, todo);
  }
  const skill = installSkill(p, "claude", id, todo);
  if (skill !== undefined) console.log(`Claude Code: skill ${p.claudeSkill} (${skill})`);
}

/** Claude Code's user-scope MCP servers, read from its own file (never written here); undefined when unreadable. */
function claudeUserServers(p) {
  try {
    const servers = JSON.parse(readFileSync(p.claudeJson, "utf8"))?.mcpServers;
    return servers !== null && typeof servers === "object" ? servers : {};
  } catch (error) {
    return error?.code === "ENOENT" ? {} : undefined;
  }
}
const isOwnServer = (p, server) =>
  server?.command === p.shim && Array.isArray(server.args) && server.args.length === 1 && server.args[0] === "mcp";

/** `claude mcp add --scope user archer -- <shim> mcp`, unless a server of that name is someone else's. */
function registerClaudeMcp(p, todo) {
  const servers = claudeUserServers(p);
  const add = `claude mcp add --scope user ${MCP_NAME} -- ${quote(p.shim)} mcp`;
  if (servers === undefined) {
    todo.push(`Claude Code: could not read ${p.claudeJson}; to use Archer over MCP run:  ${add}`);
    return;
  }
  const server = servers[MCP_NAME];
  if (server !== undefined && !isOwnServer(p, server)) {
    todo.push(
      `Claude Code: a user MCP server named ${MCP_NAME} is already configured and does not run ${p.shim} mcp, so setup left it. To use Archer's: claude mcp remove ${MCP_NAME} --scope user  then  ${add}`,
    );
    return;
  }
  if (server === undefined) {
    const result = run("claude", ["mcp", "add", "--scope", "user", MCP_NAME, "--", p.shim, "mcp"]);
    if (result.status !== 0) {
      todo.push(`Claude Code: \`claude mcp add\` failed (${firstLine(result)}); run:  ${add}`);
      return;
    }
  }
  writeFileSync(join(p.data, CLAUDE_MCP_RECORD), `${MCP_NAME}\n`);
  console.log(
    `Claude Code: MCP server "${MCP_NAME}" (user scope) runs  ${p.shim} mcp, the relay to the running Archer`,
  );
}

function setupCodex(p, flags, id, todo) {
  const skill = installSkill(p, "codex", id, todo);
  if (skill !== undefined) console.log(`Codex: skill ${p.codexSkill} (${skill})`);
  const command = hookCommand(p, "codex");
  const hook = addTurnHook(p.codexHooks, command);
  const problem = hookProblem("Codex", p.codexHooks, hook, command);
  if (problem !== undefined) todo.push(problem);
  else
    console.log(
      `Codex: turn-start hook in ${p.codexHooks}${hook === "present" ? " (already there)" : "; Codex asks once to trust it"}`,
    );
  // MCP for an install that had it (setup's block) or when asked.
  const config = existsSync(p.codexConfig) ? readFileSync(p.codexConfig, "utf8") : "";
  if (flags.has("--mcp") || marker(config, BEGIN) >= 0) setupCodexMcp(p, todo);
}

/**
 * Setup's [mcp_servers.archer] block in the Codex config. Read, edit, write; when another program wrote the file
 * between the read and the write ("changed"), read again and retry once, as the hook writers do. Nothing is said
 * until the outcome is known, so a file left as it was never reads as "replaced". `beforeWrite` is for tests.
 */
export function setupCodexMcp(p, todo, { beforeWrite } = {}) {
  for (let attempt = 0; ; attempt++) {
    const before = existsSync(p.codexConfig) ? readFileSync(p.codexConfig, "utf8") : undefined;
    const config = before ?? "";
    // An upgrade keeps the person's own approval choices from the old block.
    const begin = marker(config, BEGIN);
    const kept =
      begin >= 0 ? keptLines(config.slice(begin + BEGIN.length, Math.max(begin, marker(config, END, begin)))) : [];
    // Opening Archer to the network always asks the person, even when they approve Archer's other tools
    // (default_tools_approval_mode = "approve"); a choice of their own for it is kept.
    const network = `[mcp_servers.${MCP_NAME}.tools.setup_network_access]`;
    const ask = hasToolTable(kept.join("\n"), "setup_network_access") ? [] : [network, 'approval_mode = "prompt"'];
    const block = [
      BEGIN,
      `[mcp_servers.${MCP_NAME}]`,
      `command = ${tomlString(p.shim)}`,
      `args = ["mcp"]`,
      "startup_timeout_sec = 30",
      ...kept,
      ...ask,
      END,
    ].join("\n");
    let next;
    if (begin >= 0) next = replaceBlock(config, block);
    else if (definesServer(config)) {
      todo.push(`Codex: ${p.codexConfig} already has [mcp_servers.${MCP_NAME}]; make it run  ${p.shim} mcp`);
      return;
    } else
      next = `${config}${config === "" || config.endsWith("\n") ? "" : "\n"}${config === "" ? "" : "\n"}${block}\n`;
    if (next !== before) beforeWrite?.();
    const problem = next === before ? undefined : writeConfig(p.codexConfig, next, before);
    if (problem === "changed" && attempt < 1) continue;
    if (problem !== undefined) {
      todo.push(
        configProblem(
          "setup",
          p.codexConfig,
          problem,
          `add  [mcp_servers.${MCP_NAME}]  with  command = ${tomlString(p.shim)}  and  args = ["mcp"]`,
        ),
      );
      return;
    }
    console.log(
      `Codex: MCP server "${MCP_NAME}" in ${p.codexConfig} runs  ${p.shim} mcp, the relay to the running Archer`,
    );
    return;
  }
}

// ---- The skill, linked or copied (SKILL_MODES) ----

const skillPath = (p, host) => (host === "claude" ? p.claudeSkill : p.codexSkill);

/**
 * Who owns the folder at a host's skill path: "archer" (a link into this data directory or a copy
 * carrying setup's marker), "none" (nothing there) or "other" (never touched).
 */
export function skillOwner(p, path) {
  if (isLink(path)) {
    const target = resolve(dirname(path), readlinkSync(path));
    return target === p.data || target.startsWith(p.data + sep) ? "archer" : "other";
  }
  if (!exists(path)) return "none";
  return existsSync(join(path, MARKER)) ? "archer" : "other";
}

/**
 * Puts the skill at the host's path as SKILL_MODES says (or `mode`): a link to
 * <data>/current/skills/archer, or a copy marked with the version id. Returns what it did, or
 * undefined when the path holds someone else's folder (left, with a line to do).
 */
export function installSkill(p, host, id, todo, mode = SKILL_MODES[host]) {
  const path = skillPath(p, host);
  const source = join(p.data, "current", "skills", "archer");
  const owner = skillOwner(p, path);
  if (owner === "other") {
    todo.push(
      `${host === "claude" ? "Claude Code" : "Codex"}: ${path} already exists and is not setup's, so it was left. To use Archer's skill, move it away and run  archer setup  again`,
    );
    return undefined;
  }
  rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  if (mode === "link") {
    symlinkSync(source, path, "dir");
    return `a link to ${source}`;
  }
  cpSync(realpathSync(source), path, { recursive: true });
  writeFileSync(join(path, MARKER), `${id}\n`);
  return `a copy of ${id}, refreshed by archer upgrade`;
}

/** Removes the host's skill only when it is setup's. */
export function removeSkill(p, host) {
  const path = skillPath(p, host);
  if (skillOwner(p, path) !== "archer") return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

// ---- The turn-start hook (Claude Code settings.json, Codex hooks.json: the same shape) ----

/** A hook command's program and the rest: `'<path>' args`, `<path> args` or `archer args`. */
function splitCommand(command) {
  if (typeof command !== "string") return undefined;
  const quoted = /^'((?:[^']|'\\'')*)' (.*)$/.exec(command);
  if (quoted !== null) return { program: quoted[1].replaceAll("'\\''", "'"), rest: quoted[2] };
  const plain = /^(\S+) (.*)$/.exec(command);
  return plain === null ? undefined : { program: plain[1], rest: plain[2] };
}

/** Archer's hook in any form setup wrote: the same arguments, run by `archer` or by a path to a shim named archer. */
function isOwnHook(entry, command) {
  if (entry === null || typeof entry !== "object" || entry.type !== "command") return false;
  if (entry.command === command) return true;
  const want = splitCommand(command),
    have = splitCommand(entry.command);
  if (want === undefined || have === undefined || have.rest !== want.rest) return false;
  return have.program === "archer" || (have.program.startsWith("/") && basename(have.program) === "archer");
}

/**
 * Adds the one Archer-owned UserPromptSubmit command hook to a settings file, keeping every other key and hook as
 * it is. Returns "added", "present" (exactly there: nothing written), "updated" (an older form of it, the bare
 * `archer` or another shim path, replaced in place), "unreadable" (not a JSON object, or `hooks` not shaped as
 * hosts write it), or what kept it from writing (`writeSettings`): nothing is written then, and nothing throws.
 */
export function addTurnHook(file, command) {
  for (let attempt = 0; ; attempt++) {
    const read = readSettings(file);
    if (read === undefined) return "unreadable";
    const { settings } = read;
    const hooks = settings.hooks ?? {};
    if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return "unreadable";
    const groups = hooks.UserPromptSubmit ?? [];
    if (!Array.isArray(groups)) return "unreadable";
    const exact = (hook) => hook?.type === "command" && hook.command === command;
    const own = groups.flatMap((group) =>
      Array.isArray(group?.hooks) ? group.hooks.filter((hook) => isOwnHook(hook, command)) : [],
    );
    // Exactly there, and no other form of it beside: nothing to write.
    if (own.length === 1 && exact(own[0])) return "present";
    const entry = { type: "command", command, timeout: HOOK_TIMEOUT };
    // The exact entry stays where it stands, else the first older form becomes it; every other form goes (a bare
    // `archer` left beside the full path would run the hook twice).
    const keep = own.find(exact) ?? own[0];
    const next = groups
      .map((group) => {
        if (!Array.isArray(group?.hooks) || !group.hooks.some((hook) => isOwnHook(hook, command))) return group;
        const kept = [];
        for (const hook of group.hooks) {
          if (!isOwnHook(hook, command)) kept.push(hook);
          else if (hook === keep) kept.push({ ...hook, command });
        }
        return { ...group, hooks: kept };
      })
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    const replaced = keep !== undefined;
    const value = {
      ...settings,
      hooks: { ...hooks, UserPromptSubmit: replaced ? next : [...groups, { hooks: [entry] }] },
    };
    const problem = writeSettings(file, value, read.text);
    if (problem === "changed" && attempt < 2) continue;
    return problem ?? (replaced ? "updated" : "added");
  }
}

/**
 * Removes only Archer's hook entry (any form of it); a group, the event or `hooks` goes only when Archer's entry was
 * all it held. Returns true when it was removed, false when there was none, or what kept it from writing.
 */
export function removeTurnHook(file, command) {
  if (!exists(file)) return false;
  const read = readSettings(file);
  const settings = read?.settings;
  const groups = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return false;
  let removed = false;
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks) || !group.hooks.some((entry) => isOwnHook(entry, command))) {
      kept.push(group);
      continue;
    }
    removed = true;
    const others = group.hooks.filter((entry) => !isOwnHook(entry, command));
    if (others.length > 0) kept.push({ ...group, hooks: others });
  }
  if (!removed) return false;
  const hooks = { ...settings.hooks };
  if (kept.length > 0) hooks.UserPromptSubmit = kept;
  else delete hooks.UserPromptSubmit;
  const next = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return writeSettings(file, next, read.text) ?? true;
}

/** The settings object and the text it came from (undefined for a missing file); `{}` for a missing or empty file; undefined when it is not a JSON object. */
function readSettings(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { settings: {}, text: undefined } : undefined;
  }
  if (text.trim() === "") return { settings: {}, text };
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? { settings: value, text } : undefined;
  } catch {
    return undefined;
  }
}

const READ_ONLY = new Set(["EACCES", "EPERM", "EROFS"]);

/** Writes the settings whole, with the indent hosts use (`writeConfig`). */
const writeSettings = (path, value, before) => writeConfig(path, `${JSON.stringify(value, null, 2)}\n`, before);

/**
 * Writes a host's settings or config file whole, keeping the file's mode; a linked file (a dotfiles repository's)
 * is written where it points and the link stays. The new text goes to an exclusive temporary file beside the target
 * (`wx`: never an existing name, never through a planted link), which replaces the target only if the target still
 * holds `before` (what was read). Returns undefined when written, else what kept it from writing, with nothing
 * changed: "dangling" (a link to nothing), "read-only" (the file or its folder cannot be written: a home-manager
 * link into /nix/store, say) or "changed" (another program wrote it meanwhile).
 *
 * Accepted window (review decision 24): the compare and the rename are two steps, and no lock the hosts honour
 * covers both, so a host that writes the file between them loses that write. The window is microseconds long and
 * open only while a setup the person started runs; docs/install.md says so.
 */
function writeConfig(path, text, before) {
  let file = path;
  if (isLink(path)) {
    try {
      file = realpathSync(path);
    } catch {
      return "dangling";
    }
  } else {
    try {
      file = realpathSync(path);
    } catch {
      /* not there yet */
    }
  }
  const there = exists(file);
  let mode = 0o600;
  if (there) {
    mode = statSync(file).mode & 0o777;
    try {
      accessSync(file, constants.W_OK);
    } catch (error) {
      if (READ_ONLY.has(error?.code)) return "read-only";
      throw error;
    }
  } else {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch (error) {
      if (READ_ONLY.has(error?.code)) return "read-only";
      throw error;
    }
  }
  const temporary = join(dirname(file), `.${basename(file)}.archer-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temporary, text, { mode, flag: "wx" });
  } catch (error) {
    if (READ_ONLY.has(error?.code)) return "read-only";
    throw error;
  }
  try {
    let now;
    try {
      now = readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (now !== before) {
      unlinkSync(temporary);
      return "changed";
    }
    renameSync(temporary, file);
    return undefined;
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    if (READ_ONLY.has(error?.code)) return "read-only";
    throw error;
  }
}

/** The to-do line for a hook setup could not write, or undefined when it was written (or was there). */
function hookProblem(host, file, outcome, command) {
  const add = `add a UserPromptSubmit command hook running  ${command}`;
  if (outcome === "unreadable")
    return `${host}: ${file} is not plain JSON, so setup did not add its turn-start hook. ${add[0].toUpperCase()}${add.slice(1)}`;
  if (outcome === "dangling")
    return `${host}: ${file} is a link to a file that does not exist, so setup left it and added no turn-start hook. Create the file it points to (or remove the link), then run  archer setup  again; or ${add} where that file is kept`;
  if (outcome === "read-only")
    return `${host}: ${file} cannot be written (read-only${isLink(file) ? ", through a link" : ""}), so setup added no turn-start hook. Where that file is managed (home-manager, a dotfiles repository), ${add}`;
  if (outcome === "changed")
    return `${host}: ${file} kept changing while setup ran, so setup added no turn-start hook. Run  archer setup  again once nothing else is writing it`;
  return undefined;
}

/** The to-do line for a Codex config.toml setup or uninstall could not write (`writeConfig`'s outcome). */
function configProblem(command, file, outcome, what) {
  const why =
    outcome === "dangling"
      ? "is a link to a file that does not exist"
      : outcome === "read-only"
        ? `cannot be written (read-only${isLink(file) ? ", through a link" : ""})`
        : `kept changing while ${command} ran`;
  return `Codex: ${file} ${why}, so ${command} left it as it was. Where that file is managed (home-manager, a dotfiles repository), ${what}; or run  archer ${command}  again once it can be written`;
}

// ---- Processes (read from /proc, never stopped) ----

function bootTime(proc) {
  try {
    const match = /^btime\s+(\d+)$/m.exec(readFileSync(join(proc, "stat"), "utf8"));
    return match ? Number(match[1]) * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Milliseconds since the epoch: field 22 of /proc/<pid>/stat, after the parenthesised command name. */
function startTime(base, boot, ticks) {
  const stat = readFileSync(join(base, "stat"), "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const value = Number(fields[19]);
  return Number.isFinite(value) ? boot + (value / ticks) * 1000 : undefined;
}

function clockTicksPerSecond() {
  const answer = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const value = Number(answer.stdout?.trim());
  return Number.isFinite(value) && value > 0 ? value : 100;
}

/** A path under the home folder as ~/…, else as it is. */
function homeRelative(p, path) {
  const home = p.home.endsWith(sep) ? p.home : p.home + sep;
  return path.startsWith(home) ? `~/${path.slice(home.length)}` : path;
}

/**
 * Where the page can be opened: on this computer only (plain HTTP on loopback, another device one agent step
 * away), or, once network access is on, at its network address too (O39: the hint said "ask your agent" then).
 */
function tlsHint(p, env = process.env) {
  const stateDir = resolve(
    env.ARCHER_STATE_DIR || join(env.XDG_STATE_HOME || join(p.home, ".local", "state"), "archer"),
  );
  let access;
  try {
    access = JSON.parse(readFileSync(join(stateDir, "network-access.json"), "utf8"));
  } catch {
    access = undefined;
  }
  if (access?.enabled === true && typeof access.host === "string")
    console.log(
      `Archer's page is open to your network over HTTPS at ${access.host} (since ${access.since ?? "an earlier setup"}); turn it off with  archer network-access off`,
    );
  else
    console.log(
      "Archer's page works on this computer as it is. To open Archer on another device, ask your agent, or run  archer network-access",
    );
}

/** Removes Archer's hook, or says why it could not and what to remove by hand. */
function unhook(host, file, command, todo) {
  const outcome = removeTurnHook(file, command);
  if (typeof outcome === "string")
    todo.push(
      `${host}: ${file} could not be written (${outcome}), so Archer's turn-start hook is still in it; remove the UserPromptSubmit hook running  ${command}`,
    );
}

function uninstall(p, flags, todo) {
  if (!flags.has("--no-claude")) {
    if (which("claude") && record(p.data, CLAUDE_MCP_RECORD) === MCP_NAME) {
      const server = claudeUserServers(p)?.[MCP_NAME];
      if (server !== undefined && isOwnServer(p, server)) {
        const result = run("claude", ["mcp", "remove", MCP_NAME, "--scope", "user"]);
        if (result.status !== 0)
          todo.push(
            `Claude Code: \`claude mcp remove ${MCP_NAME} --scope user\` failed (${firstLine(result)}); run it by hand`,
          );
      }
    }
    removeSkill(p, "claude");
    unhook("Claude Code", p.claudeSettings, hookCommand(p, "claude-code"), todo);
  }
  if (!flags.has("--no-codex")) {
    if (existsSync(p.codexConfig)) {
      const config = readFileSync(p.codexConfig, "utf8");
      if (marker(config, BEGIN) >= 0) {
        const problem = writeConfig(p.codexConfig, removeBlock(config), config);
        if (problem !== undefined)
          todo.push(configProblem("uninstall", p.codexConfig, problem, `remove the lines from  ${BEGIN}  to  ${END}`));
      }
    }
    removeSkill(p, "codex");
    unhook("Codex", p.codexHooks, hookCommand(p, "codex"), todo);
  }
  if (existsSync(p.data) && !existsSync(join(p.data, MARKER)))
    throw new Error(`${p.data} was not made by archer setup; nothing there was removed`);
  const removed = [];
  if (existsSync(p.shim) && isOwnShim(p, p.shim)) {
    rmSync(p.shim);
    removed.push(p.shim);
  } else if (existsSync(p.shim)) todo.push(`${p.shim} is not setup's, so it was left`);
  if (existsSync(p.data)) {
    rmSync(p.data, { recursive: true, force: true });
    removed.push(p.data);
  }
  console.log(removed.length === 0 ? "nothing of Archer's was installed here" : `removed ${removed.join(" and ")}`);
  console.log(
    "kept your diagrams, ~/.config/archer and ~/.local/state/archer; run  archer stop  first if a service was running",
  );
}

/** `current`'s moves, oldest first; since 0 means "from before the history began". */
export function readHistory(data) {
  let text;
  try {
    text = readFileSync(join(data, HISTORY_RECORD), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => /^(\d+) (\S+)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ since: Number(match[1]), id: match[2] }));
}

/** The copy `current` named at `time` (ms since the epoch), or undefined when the history does not reach back. */
export function copyAt(history, time) {
  let found;
  for (const entry of history) if (entry.since <= time) found = entry.id;
  return found;
}

/**
 * Records that `current` moves from `prior` to `id`. A history begun by this setup is seeded from what was
 * already known: the previous record (from before) and `prior`, current since its link was made.
 */
function noteCurrentMove(p, prior, recordedPrevious, id) {
  const history = readHistory(p.data);
  if (history.length === 0 && prior !== undefined) {
    let flipped = 0;
    try {
      flipped = Math.floor(lstatSync(join(p.data, "current")).mtimeMs);
    } catch {
      /* no link: since 0 */
    }
    if (recordedPrevious !== undefined && recordedPrevious !== prior) history.push({ since: 0, id: recordedPrevious });
    history.push({ since: history.length === 0 ? 0 : flipped, id: prior });
  }
  if (prior !== id) history.push({ since: Date.now(), id });
  if (history.length === 0) return;
  writeFileSync(
    join(p.data, HISTORY_RECORD),
    history
      .slice(-32)
      .map((entry) => `${entry.since} ${entry.id}\n`)
      .join(""),
  );
}

/**
 * This user's processes whose command line names a path under `root` (read from /proc; none stopped), with
 * their start time when `withStart`; undefined without /proc.
 */
function processesUsing(root, proc = process.env.ARCHER_TEST_PROC || "/proc", withStart = false) {
  let entries;
  try {
    entries = readdirSync(proc).filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid);
  } catch {
    return undefined;
  }
  const uid = process.getuid?.();
  const found = [];
  let boot, ticks;
  for (const pid of entries) {
    try {
      if (
        uid !== undefined &&
        !new RegExp(`^Uid:\\s+${uid}\\s`, "m").test(readFileSync(join(proc, pid, "status"), "utf8"))
      )
        continue;
      const argv = readFileSync(join(proc, pid, "cmdline"), "utf8").split("\0");
      if (!argv.some((arg) => arg === root || arg.startsWith(root + sep))) continue;
      let cwd;
      try {
        cwd = readlinkSync(join(proc, pid, "cwd"));
      } catch {}
      let started;
      if (withStart) {
        boot ??= bootTime(proc) ?? null;
        started = boot === null ? undefined : startTime(join(proc, pid), boot, (ticks ??= clockTicksPerSecond()));
      }
      found.push({ pid: Number(pid), cwd, ...(started === undefined ? {} : { started }) });
    } catch {}
  }
  return found;
}

/**
 * Whether `text` has a real `[mcp_servers.archer.tools.<tool>]` table: any spacing, quoted or bare keys, a
 * trailing comment; never one written inside a multi-line string.
 */
export function hasToolTable(text, tool) {
  const key = (name) => `(?:${name}|"${name}"|'${name}')`;
  const header = new RegExp(
    `^\\s*\\[\\s*${key("mcp_servers")}\\s*\\.\\s*${key(MCP_NAME)}\\s*\\.\\s*${key("tools")}\\s*\\.\\s*${key(tool)}\\s*\\]\\s*(?:#.*)?$`,
    "gm",
  );
  const strings = multilineStrings(text);
  for (const match of text.matchAll(header))
    if (!strings.some(([a, b]) => match.index > a && match.index < b)) return true;
  return false;
}

/** The person's own lines in setup's block: everything but the lines setup writes itself. */
function keptLines(body) {
  const lines = body.split("\n");
  const own = /^\s*\[mcp_servers\.archer\]\s*$/;
  const tools = lines.findIndex((line) => /^\s*\[/.test(line) && !own.test(line));
  const main = tools < 0 ? lines : lines.slice(0, tools);
  // Every other line stays as it is, blank lines inside a value too; only the ends are trimmed.
  const kept = [
    ...main.filter((line) => !own.test(line) && !/^\s*(command|args|startup_timeout_sec)\s*=/.test(line)),
    ...(tools < 0 ? [] : lines.slice(tools)),
  ];
  while (kept.length > 0 && kept[0].trim() === "") kept.shift();
  while (kept.length > 0 && kept.at(-1).trim() === "") kept.pop();
  return kept;
}

/** Where setup's marker line starts in a Codex config, from `from` on: a whole line, never text inside a multi-line string; -1 if none. */
function marker(config, text, from = 0) {
  const strings = multilineStrings(config);
  for (let at = config.indexOf(text, Math.max(0, from)); at >= 0; at = config.indexOf(text, at + 1)) {
    const end = at + text.length;
    if (
      (at === 0 || config[at - 1] === "\n") &&
      (end === config.length || config[end] === "\n") &&
      !strings.some(([a, b]) => at > a && at < b)
    )
      return at;
  }
  return -1;
}

/** The [start, end) offsets of the TOML multi-line strings in a text (comments and other strings skipped). */
function multilineStrings(text) {
  const ranges = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "#") {
      const n = text.indexOf("\n", i);
      i = n < 0 ? text.length : n;
      continue;
    }
    const triple = text.startsWith('"""', i) ? '"""' : text.startsWith("'''", i) ? "'''" : undefined;
    if (triple !== undefined) {
      let j = i + 3;
      for (;;) {
        const k = text.indexOf(triple, j);
        if (k < 0) {
          j = text.length;
          break;
        }
        let slashes = 0;
        while (triple === '"""' && text[k - 1 - slashes] === "\\") slashes++;
        if (slashes % 2 === 1) {
          j = k + 1;
          continue;
        }
        j = k + 3;
        while (j < text.length && j < k + 5 && text[j] === triple[0]) j++;
        break;
      }
      ranges.push([i, j]);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += c === '"' && text[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    i++;
  }
  return ranges;
}

/** `archer restart` from the installed copy: a warm hand-over at the same address (ADR 0032). */
export const hotSwap = (p) =>
  spawnSync(process.execPath, [join(p.data, "current", "bin", "archer.mjs"), "restart"], {
    encoding: "utf8",
    timeout: 120_000,
  });

/**
 * Whether the Codex config already defines this MCP server in any TOML spelling: a
 * [mcp_servers.archer] table (names quoted or not), a dotted key, or a key of [mcp_servers].
 * No parser ships with the package, so this errs towards "yes" (setup then asks the person).
 */
function definesServer(config) {
  const name = `\\s*(?:${MCP_NAME}|"${MCP_NAME}"|'${MCP_NAME}')\\s*`;
  if (new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.${name}[\\].]`, "m").test(config)) return true;
  if (new RegExp(`^\\s*mcp_servers\\s*\\.${name}[.=]`, "m").test(config)) return true;
  const table = /^\s*\[\s*mcp_servers\s*\]\s*$/m.exec(config);
  if (table === null) return false;
  const body = config.slice(table.index + table[0].length).split(/^\s*\[/m)[0];
  return new RegExp(`^${name}[.=]`, "m").test(body);
}

function replaceBlock(config, block) {
  const start = marker(config, BEGIN),
    end = marker(config, END, start);
  if (end < 0) throw new Error(`unterminated "${BEGIN}" block in Codex config`);
  return config.slice(0, start) + block + config.slice(end + END.length);
}

/** The managed block and the one blank line setup put before it; every other byte stays. */
function removeBlock(config) {
  const start = marker(config, BEGIN),
    end = marker(config, END, start);
  if (end < 0) throw new Error(`unterminated "${BEGIN}" block in Codex config`);
  let from = start;
  if (config.slice(0, from).endsWith("\n\n")) from -= 1;
  let to = end + END.length;
  if (config[to] === "\n") to += 1;
  return config.slice(0, from) + config.slice(to);
}

/**
 * A short hash of the package's files, so a rebuild of one version still installs as new.
 * plugin.json is left out: setup rewrites its version, and `archer setup` run from an
 * installed copy must find that same copy.
 */
function contentHash(root) {
  const hash = createHash("sha256");
  const pending = [""];
  while (pending.length > 0) {
    const prefix = pending.pop();
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile() && name !== ".claude-plugin/plugin.json")
        hash
          .update(name)
          .update("\0")
          .update(readFileSync(join(root, name)))
          .update("\0");
    }
  }
  return hash.digest("hex").slice(0, 10);
}

/** The version id `current` points at, if any. */
function currentVersion(p) {
  try {
    return readlinkSync(join(p.data, "current")).split(/[\\/]/).pop();
  } catch {
    return undefined;
  }
}

function replaceSymlink(target, path) {
  const temporary = `${path}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary, "dir");
  renameSync(temporary, path);
}

/**
 * The `archer` command: the Node that ran setup (checked above), while it exists; else `node` or `nodejs` on PATH,
 * which the CLI itself checks. With neither, one line on stderr; the turn-start hook (`inbox … --hook`) then exits 0,
 * so a missing Node never fails the agent's turn (exit 127 would show as a hook error on every prompt), and
 * anything else exits 1. Its second line is SHIM_MARKER and its last runs `entry`: `isOwnShim` knows it by those
 * two alone, so the lines between may change in any later build (decision 42).
 */
export function shimText(node, entry) {
  const missing = `archer: Archer's Node (%s) is missing and there is no node on PATH. Install Node ${MIN_NODE.join(".")} or newer, then run  archer setup  again.`;
  return `#!/bin/sh\n${SHIM_MARKER}\npinned=${quote(node)}\nnode=$pinned\n[ -x "$node" ] || node=$(command -v node || command -v nodejs) || {\n  printf "${missing}\\n" "$pinned" >&2\n  if [ "$1" = inbox ]; then for arg; do [ "$arg" = --hook ] && exit 0; done; fi\n  exit 1\n}\n${shimExec(entry)}`;
}
/** Frozen: every shim since 0.7.0 carries this line, and setup knows its own by it. Never reword it. */
const SHIM_MARKER = "# archer-shim v1";
const shimExec = (entry) => `exec "$node" ${entry} "$@"\n`;

/**
 * A shim setup wrote for this data directory's current copy: one with the marker line ending in its `exec` line.
 * Never derived from today's `shimText`, whose wording and Node version change between builds.
 */
export const isOwnShim = (p, path) => {
  let text;
  try {
    if (isLink(path)) return false;
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const exec = shimExec(quote(join(p.data, "current", "bin", "archer.mjs")));
  return (
    text.startsWith(`#!/bin/sh\n${SHIM_MARKER}\n`) &&
    text.endsWith(exec) &&
    text.indexOf(exec) === text.length - exec.length
  );
};
/** Whether anything is at `path`, a dangling link included. */
const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
const which = (command) =>
  (process.env.PATH || "").split(delimiter).some((dir) => dir && existsSync(join(dir, command)));
const run = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
const firstLine = (result) =>
  (`${result.stderr || ""}${result.stdout || ""}`.trim().split("\n")[0] || `exit ${result.status}`).slice(0, 200);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const tomlString = (value) => JSON.stringify(value);
