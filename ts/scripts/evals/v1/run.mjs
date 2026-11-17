// Runs one (agent × task × repetition) of the v1 small-agent evals against the installed package.
// aev-canary-5d1f8e02b7c4 (judge.mjs CANARY: an evaluated agent that reads this file is caught)
//
//   node ts/scripts/evals/v1/run.mjs --install <home with `archer setup`> --out <dir> --agent haiku|sol|luna --task <id> --rep N --port P
//
// Isolation: the project is a fresh copy of ts/test/fixtures/pageturner in <out> (or a task's own layout); Archer's state, socket,
// config and port are private to the run (a short /tmp/aev-* directory, removed afterwards);
// the service it starts is stopped. Claude runs with only project settings (no user MCP
// servers or plugins), no claude.ai connectors, and the packaged plugin (--plugin-dir); Codex runs without the user's config.toml,
// the packaged MCP server via -c, and the packaged skill from the project's .agents/skills, in a Codex home
// of its own (prepareCodexHome): never the owner's ~/.codex config, plugins or skills.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TASKS, holdoutPath } from "./tasks.mjs";
import { AGENTS } from "./agents.mjs";
import { CANARY, repoRoot } from "./judge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(HERE, "../../../test/fixtures/pageturner");
const AGENTS_MD =
  "<!-- archer:begin -->\n## Archer\n\nThis project's diagrams (Mermaid) and notes (Markdown) live in `.archer/`.\nA new diagram is embedded in the note it belongs to, as a ```mermaid block addressed as\n`<note path>#<name>`; one that deserves its own file goes in its `diagrams/` folder as a\nMermaid file, and a new note in `notes/`.\nUse them as reference documentation for the architecture, flows and decisions: read the ones\nthat concern a task before changing what they describe, and offer to update the ones it makes stale.\n`archer list` shows what is there; the folder may be hidden from search tools by default.\n<!-- archer:end -->\n";

export { AGENTS };

/** The wrapper that gives a run its own /tmp (private-tmp.sh). */
const PRIVATE_TMP = join(HERE, "private-tmp.sh");

/**
 * `sealed` (eval.mjs --sealed; Claude runs): the agent gets a /tmp of its own (private-tmp.sh) and its archer
 * sees the run's own skill copy, so nothing on the host outside the run reaches it through /tmp or doctor.
 */
export async function runOne({ install, out, agent, task: taskId, rep, port, timeoutMs = 600_000, sealed = false }) {
  const spec = AGENTS[agent];
  const task = TASKS.find((t) => t.id === taskId);
  if (!spec || !task) throw new Error(`unknown agent ${agent} or task ${taskId}`);
  const repo = repoRoot();
  mkdirSync(out, { recursive: true });
  if (`${realpathSync(out)}/`.startsWith(`${realpathSync(repo)}/`))
    throw new Error(
      `results must live outside the Archer repository (${repo}): an agent run inside it could read the eval`,
    );
  const runDir = join(out, agent, taskId, `r${rep}`);
  if (existsSync(runDir)) throw new Error(`${runDir} exists`);
  mkdirSync(runDir, { recursive: true });
  // Codex reads the skill copy `archer setup` made in the eval home's CODEX_HOME, from the
  // project's .agents/skills (committed in the baseline, so no diff); its own Codex home has no skills.
  const skills = (repo) => {
    if (spec.kind === "codex")
      cpSync(join(install, ".codex", "skills", "archer"), join(repo, ".agents", "skills", "archer"), {
        recursive: true,
      });
  };
  // A task's own layout (a worktree, a fresh repository) or the default: a copy of the corpus at <run>/project.
  // The installed archer, offline and with throwaway state, for a setup that needs it (a generated index.md).
  const archer = (args, cwd) => {
    const scratch = mkdtempSync("/tmp/aev-s-");
    try {
      const r = spawnSync(join(install, ".local", "bin", "archer"), args, {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...cleanEnv(),
          HOME: scratch,
          ARCHER_STATE_DIR: join(scratch, "s"),
          ARCHER_SOCKET: join(scratch, "s", "a.sock"),
          XDG_CONFIG_HOME: join(scratch, "c"),
          XDG_STATE_HOME: join(scratch, "x"),
        },
      });
      if (r.status !== 0) throw new Error(`archer ${args.join(" ")}: ${r.stderr || r.stdout}`);
      return r.stdout;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  const layout =
    task.layout?.(runDir, { demo: DEMO, agentsMd: AGENTS_MD, skills, commit: baseline, archer }) ??
    (() => {
      const project = join(runDir, "project");
      cpSync(DEMO, project, { recursive: true });
      writeFileSync(join(project, "AGENTS.md"), AGENTS_MD);
      task.setup?.(project, { archer });
      skills(project);
      baseline(project);
      return { project };
    })();
  const project = layout.project;
  writeFileSync(
    join(runDir, "layout.json"),
    JSON.stringify({ project, attachFirst: layout.attachFirst ?? [] }, null, 2),
  );
  const data = join(install, ".local", "share", "archer", "current");

  const shimDir = join(install, ".local", "bin");
  const state = mkdtempSync("/tmp/aev-");
  // A task with `config: "none"` runs as a fresh install does: no settings file and no host or HTTP
  // override (the page is local by default; setup_network_access writes XDG_CONFIG_HOME's archer.toml).
  const fresh = task.config === "none";
  if (!fresh)
    writeFileSync(join(state, "archer.toml"), 'version = 1\n[service]\nforce_http = true\nopen_browser = "never"\n');
  const archerEnv = {
    ARCHER_STATE_DIR: join(state, "s"),
    ARCHER_SOCKET: join(state, "s", "a.sock"),
    ...(fresh ? {} : { ARCHER_CONFIG: join(state, "archer.toml") }),
    ARCHER_PORT: String(port),
    ...(fresh ? {} : { ARCHER_HOST: "127.0.0.1", ARCHER_FORCE_HTTP: "true" }),
    ARCHER_OPEN_BROWSER: "never",
    XDG_STATE_HOME: join(state, "xdg-state"),
    XDG_CONFIG_HOME: join(state, "xdg-config"),
  };
  const env = { ...cleanEnv(), ...archerEnv, PATH: `${shimDir}:${process.env.PATH}` };
  const call = (op, input) => {
    const file = join(state, `${op}.json`);
    writeFileSync(file, JSON.stringify(input));
    const r = spawnSync(join(shimDir, "archer"), ["call", op, "--file", file, "--json"], {
      cwd: project,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    try {
      return JSON.parse(r.stdout);
    } catch {
      return { error: (r.stderr || r.stdout).slice(0, 500) };
    }
  };
  // Projects the person already has attached before the agent starts (the service starts here).
  for (const root of layout.attachFirst ?? []) {
    const attached = call("attach_project", { root });
    if (attached.error) throw new Error(`could not attach ${root} first: ${attached.error}`);
  }
  const transcript = join(runDir, "transcript.jsonl");
  let args, command, codex, resumeArgs;
  if (spec.kind === "claude") {
    command = "claude";
    // Project settings only (no user MCP servers or plugins), no claude.ai connectors:
    // the packaged plugin's MCP server is the only one.
    env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
    // The eval itself is out of bounds (judge.mjs detects it anyway; this denies what Claude can).
    const settings = join(state, "eval-settings.json");
    // Sealed: the agent's `archer doctor` reads the run's own copy of the packaged skill as Claude Code's
    // (CLAUDE_CONFIG_DIR, for archer only), never an installed ~/.claude/skills/archer, so each side of a
    // comparison uses its own packaged skill; setup and upgrade, which write into the real HOME, are denied.
    if (sealed) {
      const skillHome = join(state, "claude");
      cpSync(join(data, "skills", "archer"), join(skillHome, "skills", "archer"), { recursive: true });
      mkdirSync(join(state, "bin"));
      writeFileSync(
        join(state, "bin", "archer"),
        `#!/bin/sh\nCLAUDE_CONFIG_DIR='${skillHome}' exec '${join(shimDir, "archer")}' "$@"\n`,
        { mode: 0o755 },
      );
      env.PATH = `${join(state, "bin")}:${env.PATH}`;
    }
    const deny = [
      ...denyRules({ repo, out: realpathSync(out), holdout: holdoutPath() }),
      ...(sealed ? ["Bash(archer setup:*)", "Bash(archer upgrade:*)"] : []),
    ];
    writeFileSync(settings, JSON.stringify({ permissions: { deny } }));
    args = [
      "--settings",
      settings,
      "-p",
      "--model",
      spec.model,
      "--effort",
      spec.effort,
      "--setting-sources",
      "project",
      "--plugin-dir",
      data,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "mcp__plugin_archer-ts_archer-ts__*",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Skill",
      "ListMcpResourcesTool",
      "ReadMcpResourceTool",
      "Bash(archer:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "--disallowedTools",
      "mcp__claude_ai*",
      "--",
      task.prompt,
    ];
    // The person's reply, as a second turn of the same session.
    resumeArgs = (session) => [
      ...args.slice(0, -2).flatMap((a) => (a === "-p" ? ["--resume", session, "-p"] : [a])),
      "--",
      task.followUp,
    ];
  } else {
    command = "codex";
    codex = prepareCodexHome({});
    env.CODEX_HOME = codex.dir;
    args = codexArgs({ project, spec, task, shim: join(shimDir, "archer"), archerEnv });
    resumeArgs = (session) => codexResumeArgs({ args, session, followUp: task.followUp });
  }
  // What a kept file must never hold: the owner's Codex login, before the run and after a refresh in it.
  const before = codex ? codexCredentials() : [];
  const credentials = () => (codex ? [...new Set([...codexCredentials(), ...before])] : []);
  let scrubbed = 0;
  const kept = (buffer) => {
    const { text, found } = scrubCredentials(buffer, credentials());
    scrubbed += found;
    return text;
  };
  const started = Date.now();
  let exit;
  try {
    writeFileSync(
      join(runDir, "command.json"),
      JSON.stringify(
        {
          canary: CANARY,
          command,
          args,
          archerEnv,
          agent: spec,
          ...(sealed ? { sealed: true } : {}),
          ...(codex ? { codexHome: codex.dir } : {}),
        },
        null,
        2,
      ),
    );
    // Sealed: the agent sees an empty /tmp of its own, with only the run's state directory in it.
    const wrapped = (turnArgs) =>
      sealed && spec.kind === "claude"
        ? [
            "unshare",
            [
              "-rm",
              "/bin/sh",
              PRIVATE_TMP,
              String(process.getuid()),
              String(process.getgid()),
              state,
              project,
              command,
              ...turnArgs,
            ],
          ]
        : [command, turnArgs];
    const turn = (turnArgs) =>
      new Promise((done) => {
        const child = spawn(...wrapped(turnArgs), { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
        const chunks = [],
          errors = [];
        child.stdout.on("data", (c) => chunks.push(c));
        child.stderr.on("data", (c) => errors.push(c));
        const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          done({ code, signal, out: kept(Buffer.concat(chunks)), err: kept(Buffer.concat(errors)) });
        });
      });
    const first = await turn(args);
    exit = { code: first.code, signal: first.signal };
    let out = first.out,
      err = first.err;
    // A task with `followUp` answers the agent once more, in the same session (its transcript-1.jsonl is the first turn).
    if (task.followUp !== undefined) {
      writeFileSync(join(runDir, "transcript-1.jsonl"), first.out);
      const session = sessionOf(first.out.toString("utf8"), spec.kind);
      if (session === undefined)
        err = Buffer.concat([
          Buffer.from(err),
          Buffer.from("\n[eval] no session id in the first turn; no follow-up\n"),
        ]);
      else {
        const second = await turn(resumeArgs(session));
        exit = { code: second.code, signal: second.signal, first: { code: first.code, signal: first.signal } };
        out = Buffer.concat([Buffer.from(out), Buffer.from(second.out)]);
        err = Buffer.concat([Buffer.from(err), Buffer.from(second.err)]);
      }
    }
    writeFileSync(transcript, out);
    writeFileSync(join(runDir, "stderr.txt"), err);
  } finally {
    codex?.remove();
  }
  const seconds = (Date.now() - started) / 1000;

  // Evidence from the service before it stops: emphasis and note emphasis live in its state.
  const evidence = {
    exit,
    seconds,
    projects: call("list_projects", {}),
    emphases: call("list_emphases", {}),
    noteEmphases: Object.fromEntries(
      ["notes/0002-side-effects-through-the-queue.md"].map((p) => [p, call("list_note_emphases", { notePath: p })]),
    ),
  };
  const stop = spawnSync(join(shimDir, "archer"), ["stop"], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  evidence.stop = (stop.stdout + stop.stderr).trim();
  // The service log explains a service that did not start; tokens in it stay in the private run directory.
  if (existsSync(join(state, "s", "service.log")))
    writeFileSync(join(runDir, "service.log"), kept(readFileSync(join(state, "s", "service.log"))));
  if (codex) evidence.codexCredentialsScrubbed = scrubbed;
  writeFileSync(join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  rmSync(state, { recursive: true, force: true });
  return runDir;
}

/** The owner's Codex home, where their login lives (`codex login`). */
const ownerCodexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

/**
 * A Codex home for one run, removed afterwards: its only entry is a link to the owner's auth.json, so the
 * run has none of their config, plugins, skills, sessions or memories. A link, not a copy: the credential
 * stays in one owner-only file, and a token refresh in the run writes that file in place (Codex opens
 * auth.json with truncate, no rename), so the owner's refresh token never forks. Not under /tmp, where
 * Codex refuses to install its helper commands.
 */
export function prepareCodexHome({
  owner = ownerCodexHome(),
  parent = join(homedir(), ".cache", "archer-eval-codex"),
}) {
  const auth = join(owner, "auth.json");
  if (!existsSync(auth))
    throw new Error(`no Codex login at ${auth}: run \`codex login\` (with the file credential store) first`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(parent, "run-"));
  chmodSync(dir, 0o700);
  symlinkSync(auth, join(dir, "auth.json"));
  // Removes the link, never what it points at.
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The owner's Codex credential values (tokens, API key), kept in memory only, to scrub from what a run keeps. */
export function codexCredentials(owner = ownerCodexHome()) {
  let auth;
  try {
    auth = JSON.parse(readFileSync(join(owner, "auth.json"), "utf8"));
  } catch {
    return [];
  }
  const values = [];
  const walk = (value) => {
    if (typeof value === "string") values.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(auth.tokens);
  walk(auth.OPENAI_API_KEY);
  // A short value (an account id, a mode) is no secret and would scrub ordinary text.
  return values.filter((v) => v.length >= 20);
}

/** `buffer` with every credential value replaced, and how many were found. */
export function scrubCredentials(buffer, secrets) {
  let text = buffer.toString("utf8"),
    found = 0;
  for (const secret of secrets) {
    const parts = text.split(secret);
    found += parts.length - 1;
    text = parts.join("[codex credential]");
  }
  return { text: found ? Buffer.from(text) : buffer, found };
}

/** One Codex run's arguments: the packaged MCP server and settings via -c, none of the owner's config. */
export function codexArgs({ project, spec, task, shim, archerEnv }) {
  const tomlEnv = `{${Object.entries(archerEnv)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(",")}}`;
  return [
    "exec",
    "--json",
    ...(task.followUp === undefined ? ["--ephemeral"] : []),
    "--ignore-user-config",
    "-C",
    project,
    "-m",
    spec.model,
    "-c",
    `model_reasoning_effort="${spec.effort}"`,
    "-s",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    // A login shell would put the owner's ~/.local/bin (their own archer) before the eval's shim.
    "-c",
    "allow_login_shell=false",
    // The login from the auth.json link, never the OS keyring (keyed by the home's path: none for this one).
    "-c",
    'cli_auth_credentials_store="file"',
    // A task with `mcp: false` leaves the Archer MCP server out: the agent has only the CLI.
    ...(task.mcp === false
      ? []
      : [
          "-c",
          `mcp_servers.archer.command=${JSON.stringify(shim)}`,
          "-c",
          'mcp_servers.archer.args=["mcp"]',
          "-c",
          `mcp_servers.archer.env=${tomlEnv}`,
          "-c",
          "mcp_servers.archer.startup_timeout_sec=30",
          "-c",
          'mcp_servers.archer.default_tools_approval_mode="approve"',
        ]),
    task.prompt,
  ];
}

/** The session a first turn ran in: Claude's stream-json `session_id`, Codex's `thread.started` `thread_id`. */
export function sessionOf(text, kind) {
  for (const line of text.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (kind === "claude" && typeof event.session_id === "string") return event.session_id;
    if (kind === "codex" && event.type === "thread.started" && typeof event.thread_id === "string")
      return event.thread_id;
  }
  return undefined;
}

/**
 * The second turn of a Codex run: `codex exec resume <id>`, with the first turn's settings. `resume`
 * takes no -C or -s (the cwd is the project; the sandbox is a -c), and the session must have been kept
 * (no --ephemeral on a task with a follow-up: codexArgs).
 */
export function codexResumeArgs({ args, session, followUp }) {
  const kept = [];
  for (let i = 1; i < args.length - 1; i++) {
    const a = args[i];
    if (a === "-C") {
      i++;
      continue;
    }
    if (a === "-s") {
      kept.push("-c", `sandbox_mode="${args[++i]}"`);
      continue;
    }
    if (a === "--ephemeral") continue;
    kept.push(a);
  }
  return ["exec", "resume", ...kept, session, followUp];
}

/** Claude permission rules that keep an evaluated agent out of the repository, the hold-out and other runs' results. */
export function denyRules({
  repo,
  out,
  home = process.env.HOME,
  holdout = join(home, ".config", "archer-evals", "holdout.mjs"),
}) {
  // Not ~/.cache/archer-evals: the default results directory, where the run's own project is.
  const paths = [repo, join(home, ".config", "archer-evals")];
  const results = [...["results.json", "summary.md", "progress.log"].map((name) => join(out, name)), holdout];
  return [
    ...paths.flatMap((path) => ["Read", "Edit", "Grep", "Glob"].map((tool) => `${tool}(/${path}/**)`)),
    ...results.map((path) => `Read(/${path})`),
    ...[...paths, ...results].flatMap((path) => ["cat", "ls"].map((command) => `Bash(${command} ${path}*)`)),
    "Bash(cat ~/.config/archer-evals*)",
    "Bash(ls ~/.config/archer-evals*)",
  ];
}

/** The baseline commit the judge diffs against. */
function baseline(repo) {
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=eval", "-c", "user.email=eval@invalid", "commit", "-q", "-m", "baseline"]);
}

export function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** The parent session's own variables never reach the agent: no plugin dirs, no Archer settings. */
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("ARCHER_") ||
      key.startsWith("CLAUDE_CODE_") ||
      key === "CLAUDECODE" ||
      key === "CLAUDE_PID" ||
      key === "CLAUDE_EFFORT"
    )
      continue;
    env[key] = value;
  }
  return env;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      install: { type: "string" },
      out: { type: "string" },
      agent: { type: "string" },
      task: { type: "string" },
      rep: { type: "string" },
      port: { type: "string" },
    },
  });
  const dir = await runOne({
    install: resolve(values.install),
    out: resolve(values.out),
    agent: values.agent,
    task: values.task,
    rep: Number(values.rep ?? 1),
    port: Number(values.port),
  });
  console.log(dir);
}
