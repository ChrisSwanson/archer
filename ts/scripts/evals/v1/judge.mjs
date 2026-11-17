// Judges one run directory from run.mjs: parses the transcript, diffs the project against
// its baseline commit, compiles what changed, and applies the task's rubric (tasks.mjs).
//
//   node ts/scripts/evals/v1/judge.mjs --install <home> <run dir>...   (writes <run dir>/judgement.json)
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TASKS, holdoutPath } from "./tasks.mjs";
import { AGENTS } from "./agents.mjs";

const AGENT_NAMES = Object.keys(AGENTS);
const HERE = dirname(fileURLToPath(import.meta.url));

/** The Archer repository's root: the main checkout, which holds every worktree of it. */
export function repoRoot() {
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: HERE,
    encoding: "utf8",
  }).stdout.trim();
  return common ? dirname(common) : resolve(HERE, "../../../..");
}

/**
 * A string only the eval's own files and records carry (scripts, tasks, the hold-out, baseline, docs,
 * every run's command.json, judgement and results). A tool result that holds it means the agent read
 * the eval, however it spelled the path: the guarantee behind the path checks below.
 */
export const CANARY = "aev-canary-5d1f8e02b7c4";

// File names only the eval's own files and records carry.
const EVAL_NAMES = new Set([
  "tasks.mjs",
  "facts.mjs",
  "judge.mjs",
  "eval.mjs",
  "run.mjs",
  "holdout.mjs",
  "holdout.json",
  "small-agents.json",
  "eval-baseline.md",
  "normalise.mjs",
  "normalise-report.mjs",
  "normalisation.json",
  "command.json",
  "transcript.jsonl",
  "transcript-1.jsonl",
  "judgement.json",
  "evidence.json",
  "layout.json",
  "results.json",
  "summary.md",
  "progress.log",
]);

const segments = (path) => path.split("/").filter(Boolean);
const GLOB = /[*?[\]]/;
/** A shell glob segment as a regular expression; a malformed one matches anything (judged as a hit, not a crash). */
function globRegex(segment) {
  try {
    return new RegExp(
      `^${segment
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\[[^\]]*\]/g, ".")
        .replace(/[[\]]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
  } catch {
    return /^/;
  }
}
/** Whether `path` (which may hold shell wildcards) is `root` or below it. */
function within(path, root) {
  const p = segments(path),
    r = segments(root);
  if (p.length < r.length && !p.includes("**")) return false;
  for (let i = 0; i < r.length; i++) {
    if (p[i] === "**") return true;
    if (p[i] === undefined || !(p[i] === r[i] || (GLOB.test(p[i]) && globRegex(p[i]).test(r[i])))) return false;
  }
  return true;
}

const expand = (word, { cwd, home }) =>
  word
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{?HOME\}?/g, home)
    .replace(/\$\{?PWD\}?/g, cwd);

/**
 * The path-like words of a shell command, with ~, $HOME and $PWD expanded, followed through `cd`, and
 * resolved: `path` lexically, `raw` as the kernel walks it (a symlink before `..` is followed first).
 */
export function pathsIn(text, { cwd, home }) {
  const out = [];
  for (const part of text.split(/&&|\|\||[;\n|]/)) {
    // A quoted path may hold spaces.
    const quoted = [...part.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)]
      .map((m) => m[1] ?? m[2])
      .filter((q) => q.includes("/") && /\s/.test(q));
    const words = [
      ...quoted,
      ...part
        .replace(/["'`\\]/g, "")
        .split(/[\s<>(){}=,]+/)
        .filter(Boolean),
    ];
    for (let word of words) {
      word = expand(word, { cwd, home });
      if (word.includes("$")) continue;
      if (!word.includes("/") && !EVAL_NAMES.has(word)) continue;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) continue; // a URL
      out.push({ path: resolve(cwd, word), raw: word.startsWith("/") ? word : `${cwd}/${word}` });
    }
    const cd = /^\s*(?:builtin\s+)?(?:cd|pushd)\s+(\S+)/.exec(part.replace(/["']/g, ""));
    if (cd) cwd = resolve(cwd, expand(cd[1], { cwd, home }));
  }
  return out;
}

// The arguments that name files: not bodies, labels or sources.
const PATH_KEYS = new Set([
  "file_path",
  "path",
  "paths",
  "notePath",
  "root",
  "cwd",
  "file",
  "directory",
  "dir",
  "sourcePath",
  "notebook_path",
]);
function argumentPaths(call, input = call.input, depth = 0) {
  if (depth > 3 || input === null || typeof input !== "object") return [];
  return Object.entries(input).flatMap(([key, value]) => {
    if (typeof value === "string")
      return (PATH_KEYS.has(key) || (call.tool === "Glob" && key === "pattern")) && !value.includes("\n")
        ? [value]
        : [];
    return argumentPaths(call, value, depth + 1);
  });
}

// Tools that read a whole tree: given an ancestor of the repository (or a symlink to one), they reach it.
const TREE_TOOLS = /(?:^|[\s;&|(])(?:ln|cp|rsync|tar|zip|find|fd|rg|ag|grep\s+-\w*[rR]\w*|ls\s+-\w*R\w*|du)\s/;

/**
 * Where a run touched the eval itself: a tool result holding the CANARY (any read of an eval file, however
 * spelled), or a tool argument or shell word naming the Archer repository, the private hold-out, the owner's
 * own ~/.codex (or the credential link in the run's Codex home), or the results tree outside the run's own folder (other runs, other campaigns' records). The run's own folder
 * and the installed package are its to use; paths are resolved (`..`, `cd`, symlinks, globs) before judging.
 * Best effort against a path built at run time: the canary is the guarantee for whole-file reads.
 */
export function contamination(
  calls,
  {
    runDir,
    out,
    install,
    project = join(runDir, "project"),
    repo = repoRoot(),
    home = homedir(),
    holdout = holdoutPath(),
    finalText = "",
    codexHome,
    ownerCodex = join(home, ".codex"),
  },
) {
  const real = (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return path;
    }
  };
  const entries = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const allowed = [runDir, install].filter(Boolean).flatMap((path) => [path, real(path)]);
  // The owner's own Codex home (config, plugins, skills, login) is outside every run: a Codex run has its
  // own (run.mjs prepareCodexHome), whose only link back, auth.json, is the owner's credential.
  const roots = [
    repo,
    real(repo),
    holdout,
    real(holdout),
    ownerCodex,
    real(ownerCodex),
    ...(codexHome ? [join(codexHome, "auth.json")] : []),
  ];
  // The private hold-out's folder, when it is the owner's own (a custom file's folder may be anywhere).
  if (resolve(holdout) === resolve(home, ".config", "archer-evals", "holdout.mjs")) roots.push(dirname(holdout));
  // The results tree beside the run: every entry that is not on the way to the run's own folder.
  const chain = [];
  for (let dir = runDir; dir.length > out.length && dir.startsWith(out); dir = dirname(dir)) chain.push(dir);
  for (const dir of [out, ...chain.slice(1)]) {
    try {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (!chain.includes(full) && !allowed.includes(full)) roots.push(full);
      }
    } catch {
      /* gone */
    }
  }
  // An ancestor of a protected root below home (~/code for ~/code/archer), for the tree tools.
  const ancestors = (path) =>
    path !== "/" &&
    path !== home &&
    segments(path).length > segments(home).length &&
    [repo, holdout].some((root) => within(root, path) && root !== path);
  const hits = [];
  const note = (call, why) => hits.push(`${call.tool}${call.via === "cli" ? " (cli)" : ""}: ${why}`);
  for (const call of calls) {
    if (call.canary) {
      note(call, "its result holds the eval canary");
      continue;
    }
    const shell = call.server === "shell" || call.via === "cli";
    const command = call.command ?? call.input?.command ?? "";
    const words = shell
      ? pathsIn(command, { cwd: project, home })
      : argumentPaths(call).map((path) => {
          const word = expand(path, { cwd: project, home });
          return { path: resolve(project, word), raw: word.startsWith("/") ? word : `${project}/${word}` };
        });
    for (const { path, raw } of words) {
      const glob = GLOB.test(path);
      const resolved = glob ? path : real(raw);
      if (!glob && allowed.some((root) => within(resolved, root) && within(path, root))) continue;
      const root = roots.find((root) => within(path, root) || within(resolved, root));
      // Another campaign's record: an eval file name (or a glob of one) that exists outside the run.
      const named = glob
        ? entries(dirname(path)).some((name) => EVAL_NAMES.has(name) && globRegex(basename(path)).test(name))
        : EVAL_NAMES.has(basename(path)) && existsSync(path);
      const record = !root && named && !allowed.some((dir) => within(resolved, dir));
      const tree =
        !root && !record && shell && TREE_TOOLS.test(` ${command}`) && ancestors(glob ? path : resolve(path));
      if (root || record || tree) {
        note(call, root ? `${path} (under ${root})` : tree ? `${path} (holds the repository or the hold-out)` : path);
        break;
      }
    }
  }
  if (finalText.includes(CANARY)) hits.push("final answer: holds the eval canary");
  return hits;
}

const URL_PATTERN = /https?:\/\/127\.0\.0\.1:\d+\/[^\s"'<>)\]`{}]+/g;

/** Every tool call in the transcript, in order: {server, tool, input, ok, text, url}. */
export function parseTranscript(file, kind) {
  const calls = [];
  let finalText = "",
    usage = null;
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  if (kind === "claude") {
    const byId = new Map();
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "assistant") {
        for (const part of event.message?.content ?? []) {
          if (part.type !== "tool_use") continue;
          const call = classify(part.name, part.input);
          byId.set(part.id, call);
          calls.push(call);
        }
      } else if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const part of event.message.content) {
          if (part.type !== "tool_result") continue;
          const call = byId.get(part.tool_use_id);
          if (!call) continue;
          const text =
            typeof part.content === "string" ? part.content : (part.content ?? []).map((c) => c.text ?? "").join("\n");
          settle(call, !part.is_error && !/^Error|"isError":true/.test(text), text);
        }
      } else if (event.type === "result") {
        finalText = event.result ?? "";
        usage = {
          turns: event.num_turns,
          costUsd: event.total_cost_usd,
          seconds: event.duration_ms / 1000,
          ...(event.usage ? { tokens: event.usage } : {}),
        };
      }
    }
  } else {
    // A command that started and never finished (the run was stopped) may still have read something.
    const started = new Map();
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "item.started" && event.item?.type === "command_execution")
        started.set(event.item.id, event.item);
      if (event.type === "item.completed") started.delete(event.item?.id);
      if (event.type === "item.completed") {
        const item = event.item;
        if (item.type === "mcp_tool_call") {
          const call = {
            server: item.server === "archer" ? "archer" : item.server,
            tool: item.tool,
            input: item.arguments,
            via: "mcp",
          };
          const text = item.result
            ? (item.result.content ?? []).map((c) => c.text ?? "").join("\n") +
              JSON.stringify(item.result.structured_content ?? {})
            : (item.error?.message ?? "");
          settle(call, item.status === "completed" && !item.result?.is_error, text);
          calls.push(call);
        } else if (item.type === "command_execution") {
          const call = classify("Bash", { command: item.command });
          settle(call, item.exit_code === 0, item.aggregated_output ?? "");
          calls.push(call);
        } else if (item.type === "file_change") {
          calls.push({
            server: "file",
            tool: "file_change",
            input: item.changes,
            ok: item.status === "completed",
            via: "edit",
          });
        } else if (item.type === "agent_message") {
          finalText = item.text ?? finalText;
        } else if (item.type !== "reasoning") {
          calls.push({ server: "other", tool: item.type, input: null, ok: true, via: "other" });
        }
      } else if (event.type === "turn.completed") {
        usage = { tokens: event.usage };
      }
    }
    for (const item of started.values()) {
      const call = classify("Bash", { command: item.command });
      settle(call, false, item.aggregated_output ?? "");
      calls.push(call);
    }
  }
  return { calls, finalText, usage };
}

function classify(name, input) {
  const mcp = /^mcp__(?:plugin_archer-ts_archer-ts|archer)__(.+)$/.exec(name);
  if (mcp) return { server: "archer", tool: mcp[1], input, via: "mcp" };
  if (name === "Bash") {
    const command = input?.command ?? "";
    // `archer present [name]` is present_diagram (its name is the view; arguments may come in a file or stdin).
    const present = /\barcher\s+present\b(?:\s+(?!-)([^\s|;&<>'"]+))?/.exec(command);
    if (present)
      return {
        server: "archer",
        tool: "present_diagram",
        input: { ...inlineArgs(command), ...(present[1] ? { viewId: present[1] } : {}) },
        via: "cli",
        command,
      };
    const cli =
      /\barcher\s+call\s+([a-z_]+)/.exec(command) ??
      /\barcher\s+(list|validate|compile|draw|serve|stop|tools|docs|emphasis|init)\b/.exec(command);
    if (cli) return { server: "archer", tool: cli[1], input: inlineArgs(command), via: "cli", command };
    // `archer walkthrough list|show|write|delete` is list_walkthroughs or write_walkthrough (its arguments are on the command line).
    const walkthrough = /\barcher\s+walkthrough\s+(list|show|write|delete)\b/.exec(command);
    if (walkthrough)
      return {
        server: "archer",
        tool: walkthrough[1] === "list" || walkthrough[1] === "show" ? "list_walkthroughs" : "write_walkthrough",
        input: {},
        via: "cli",
        command,
      };
    if (/\barcher\s+pair\b/.test(command))
      return { server: "archer", tool: "issue_pairing_code", input: {}, via: "cli", command };
    if (/\barcher\s+network-access\b/.test(command))
      return { server: "archer", tool: "setup_network_access", input: { personConfirmed: false }, via: "cli", command };
    return { server: "shell", tool: "Bash", input, via: "shell" };
  }
  return { server: "builtin", tool: name, input, via: "builtin" };
}

/** JSON arguments written inline in a CLI command (echo '{...}' | archer call ...), when present. */
function inlineArgs(command) {
  const match = /'(\{.*\})'/s.exec(command);
  if (!match) return {};
  try {
    return JSON.parse(match[1].replace(/\\"/g, '"'));
  } catch {
    return {};
  }
}

function settle(call, ok, text) {
  call.ok = ok;
  if (text.includes(CANARY)) call.canary = true;
  call.text = text.slice(0, 4000);
  if (call.tool === "present_diagram" || call.tool === "get_ui_url") {
    // Every URL it returned: the page, and for a diagram in a note also the note's page (noteUrl).
    call.urls = [...new Set((text.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;]+$/, "")))];
    call.url = call.urls[0];
  }
  if (call.via === "cli" && call.tool === "present_diagram" && !call.input?.viewId) {
    // From the text, else from the page URL it returned (…/diagrams/<id>.mmd, or …/notes/<note>.md#<name>).
    const page = call.url ?? "";
    const viewId =
      /viewId="([^"]+)"/.exec(text)?.[1] ??
      /\/diagrams\/(?:[^?#]*\/)?([^/?#]+)\.mmd/.exec(page)?.[1] ??
      ((m) => (m ? `${decodeURIComponent(m[1])}#${m[2]}` : undefined))(
        /\/(notes\/[^?#]+\.md)(?:\?[^#]*)?#([\w.-]+)/.exec(page),
      );
    call.input = { ...call.input, viewId };
  }
}

export function judgeRun(runDir, install) {
  const command = JSON.parse(readFileSync(join(runDir, "command.json"), "utf8"));
  const kind = command.agent.kind;
  const taskId = runDir.split("/").at(-2);
  const task = TASKS.find((t) => t.id === taskId);
  const layout = existsSync(join(runDir, "layout.json"))
    ? JSON.parse(readFileSync(join(runDir, "layout.json"), "utf8"))
    : { project: join(runDir, "project"), attachFirst: [] };
  const project = layout.project;
  const { calls, finalText, usage } = parseTranscript(join(runDir, "transcript.jsonl"), kind);
  // A task with a follow-up (run.mjs): its first turn alone, before the person's reply.
  const firstTurn = existsSync(join(runDir, "transcript-1.jsonl"))
    ? parseTranscript(join(runDir, "transcript-1.jsonl"), kind)
    : null;
  const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));

  // Against the baseline commit run.mjs made (the root), not HEAD: an agent that commits
  // its edits must not hide them. Committed, staged, unstaged and untracked all count.
  const git = (args) => spawnSync("git", args, { cwd: project, encoding: "utf8" }).stdout;
  const base = git(["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n")[0];
  const entries = [
    ...git(["diff", "--name-status", "--no-renames", base])
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ code: line[0], path: line.slice(1).trim() })),
    ...git(["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .filter(Boolean)
      .map((path) => ({ code: "A", path })),
  ];
  const changed = [...new Set(entries.map((e) => e.path))];
  const added = [...new Set(entries.filter((e) => e.code === "A").map((e) => e.path))];
  const baselineOf = (path) => spawnSync("git", ["show", `${base}:${path}`], { cwd: project, encoding: "utf8" }).stdout;
  const files = {},
    baseline = {};
  for (const path of [
    ...new Set([...changed, ".archer/diagrams/containers.mmd", ".archer/diagrams/containers.comments.json"]),
  ]) {
    const full = join(project, path);
    if (existsSync(full) && statSync(full).isFile()) files[path] = readFileSync(full, "utf8");
    baseline[path] = baselineOf(path);
  }

  // Compile what changed, offline, with a private state directory.
  const state = mkdtempSync("/tmp/aev-j-");
  const env = {
    PATH: process.env.PATH,
    HOME: state,
    ARCHER_STATE_DIR: join(state, "s"),
    ARCHER_SOCKET: join(state, "s", "a.sock"),
    XDG_CONFIG_HOME: join(state, "c"),
  };
  const archer = join(install, ".local", "bin", "archer");
  const readDiagram = (viewId) => {
    const r = spawnSync(archer, ["call", "read_diagram", "--stdin", "--json"], {
      cwd: project,
      env,
      input: JSON.stringify({ viewId }),
      encoding: "utf8",
      timeout: 60_000,
    });
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  };
  const compiled = {};
  const diagrams = [];
  // A block without `%% archer-id` still has a name Archer derives (from its heading): take it from list_diagrams.
  const listed = (() => {
    const r = spawnSync(archer, ["call", "list_diagrams", "--json"], {
      cwd: project,
      env,
      input: "{}",
      encoding: "utf8",
      timeout: 60_000,
    });
    try {
      return JSON.parse(r.stdout).embedded ?? [];
    } catch {
      return [];
    }
  })();
  for (const path of changed.filter((p) => p.startsWith(".archer/") && existsSync(join(project, p)))) {
    const relative = path.slice(".archer/".length);
    if (path.endsWith(".mmd")) {
      const r = spawnSync(archer, ["validate", path], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
      compiled[path] = r.status === 0 ? "compiled" : "failed";
      if (added.includes(path))
        diagrams.push({
          path,
          viewId: relative
            .replace(/\.mmd$/, "")
            .split("/")
            .pop(),
          source: files[path],
          compiled: compiled[path],
          pinnedInside: true,
        });
    } else if (path.endsWith(".md")) {
      const derived = listed.filter((e) => e.note === relative).map((e) => e.name);
      for (const [index, block] of mermaidBlocks(files[path] ?? "").entries()) {
        block.name ??= derived[index];
        const viewId = `${relative}#${block.name ?? ""}`;
        const read = block.name ? readDiagram(viewId) : null;
        // Pinned as Archer reads it (a `%% archer-id` line before the header), not as a pattern guesses it.
        diagrams.push({
          path,
          viewId,
          name: block.name,
          source: block.body,
          compiled: read?.compile?.status ?? "unnamed",
          pinnedInside: read?.view?.explicit === true,
        });
      }
    }
  }
  const newNotes = added
    .filter((p) => p.endsWith(".md"))
    .map((path) => ({ path, frontMatter: /^---\n([\s\S]*?)\n---/.exec(files[path] ?? "")?.[1] ?? "" }));
  const newDiagram =
    diagrams.find((d) => added.includes(d.path) && d.compiled === "compiled") ??
    diagrams.find((d) => added.includes(d.path));
  if (newDiagram) {
    newDiagram.longLabels = longLabels(newDiagram.source);
    // Archer's own reading rules (ADR 0030), as validate_diagram reports them.
    const r = spawnSync(archer, ["call", "validate_diagram", "--stdin", "--format", "text"], {
      cwd: project,
      env,
      input: JSON.stringify({ viewId: newDiagram.viewId, source: newDiagram.source }),
      encoding: "utf8",
      timeout: 60_000,
    });
    // Not the advisory lint's codes (ADR 0036 §9), which a build with it lists in the same text.
    newDiagram.labelWarnings = (r.stdout.match(/\[edge_label_too_long\]|\[\w*label\w*\]/g) ?? []).filter(
      (code) => !["[code_in_label]", "[label_holds_file]"].includes(code),
    ).length;
  }
  const emphases = (evidence.emphases?.views ?? []).flatMap((view) =>
    (view.emphases ?? []).map((e) => ({ ...e, viewId: view.viewId })),
  );
  const noteEmphases = Object.fromEntries(
    Object.entries(evidence.noteEmphases ?? {}).map(([path, value]) => [
      path,
      value?.snapshot?.emphases ?? value?.emphases ?? [],
    ]),
  );
  const projects = evidence.projects?.projects ?? [];
  // The advisory lint (ADR 0036 §9) of the judge's install, when it has one: a source's warnings and info, or null.
  const lintable =
    spawnSync(archer, ["tools", "find_elements"], { cwd: project, env, encoding: "utf8", timeout: 60_000 }).status ===
    0;
  const lint = (viewId, source) => {
    if (!lintable) return null;
    const r = spawnSync(archer, ["call", "validate_diagram", "--stdin", "--json"], {
      cwd: project,
      env,
      input: JSON.stringify({ viewId, source }),
      encoding: "utf8",
      timeout: 60_000,
    });
    try {
      return JSON.parse(r.stdout).advice ?? [];
    } catch {
      return null;
    }
  };
  const ctx = {
    calls,
    finalText,
    firstTurn,
    changed,
    added,
    files,
    baseline,
    compiled,
    diagrams,
    newDiagram,
    newDiagramSource: newDiagram?.source,
    newNotes,
    emphases,
    noteEmphases,
    projects,
    layout,
    project,
    readDiagram,
    lint,
  };
  let checks, measures;
  try {
    checks = task.judge(ctx);
    measures = task.measures?.(ctx);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
  // A run that read the test is no measurement: contaminated, counted as a fail and listed apart.
  const contaminated = contamination(calls, {
    runDir,
    out: resolve(runDir, "../../.."),
    install,
    project,
    finalText,
    codexHome: command.codexHome,
  });
  if (evidence.codexCredentialsScrubbed)
    contaminated.push(
      `transcript: held the owner's Codex credential ${evidence.codexCredentialsScrubbed} time(s), scrubbed before it was kept`,
    );
  const verdict = contaminated.length
    ? "contaminated"
    : checks.some((c) => c.level === "must" && !c.pass)
      ? "fail"
      : checks.some((c) => !c.pass)
        ? "partial"
        : "pass";
  const judgement = {
    canary: CANARY,
    task: taskId,
    agent: runDir.split("/").at(-3),
    rep: runDir.split("/").at(-1),
    verdict,
    checks,
    ...(contaminated.length ? { contamination: contaminated } : {}),
    toolCalls: calls.length,
    archerCalls: calls.filter((c) => c.server === "archer").length,
    mcpCalls: calls.filter((c) => c.via === "mcp").length,
    cliCalls: calls.filter((c) => c.via === "cli").length,
    failedCalls: calls.filter((c) => c.ok === false).map((c) => `${c.tool}${c.via === "cli" ? " (cli)" : ""}`),
    changed,
    exit: evidence.exit,
    seconds: evidence.seconds,
    usage,
    ...(measures ? { measures } : {}),
    finalText: finalText.slice(0, 1500),
  };
  writeFileSync(join(runDir, "judgement.json"), JSON.stringify(judgement, null, 2));
  return judgement;
}

function mermaidBlocks(text) {
  const blocks = [];
  const pattern = /^```mermaid[^\n]*\n([\s\S]*?)^```/gm;
  for (const match of text.matchAll(pattern)) {
    const body = match[1];
    const first = body.split("\n").find((line) => line.trim()) ?? "";
    const name = /%%\s*archer-id:\s*(\S+)/.exec(body)?.[1];
    const before = text.slice(Math.max(0, match.index - 200), match.index);
    blocks.push({
      body,
      name: name ?? /%%\s*archer-id:\s*(\S+)\s*$/.exec(before)?.[1],
      pinnedInside: /^\s*%%\s*archer-id:/.test(first),
    });
  }
  return blocks;
}

/** Labels over 40 characters: C4 element/relationship labels, flowchart node/edge text, sequence messages. */
export function longLabels(source) {
  const labels = [];
  for (const m of source.matchAll(
    /\b(?:Person|System|Container|Component)(?:Db|Queue|_Ext|Db_Ext|Queue_Ext)*\(\s*\w+\s*,\s*"([^"]*)"/g,
  ))
    labels.push(m[1]);
  for (const m of source.matchAll(/\bRel\w*\(\s*\w+\s*,\s*\w+\s*,\s*"([^"]*)"/g)) labels.push(m[1]);
  if (/^\s*(flowchart|graph)\b/m.test(source)) {
    for (const m of source.matchAll(/\w+(?:\[\[?|\(\(?|\{\{?|>)"?([^"\])}\n]+)"?(?:\]\]?|\)\)?|\}\}?)/g))
      labels.push(m[1]);
    for (const m of source.matchAll(/\|"?([^|"\n]+)"?\|/g)) labels.push(m[1]);
  }
  if (/^\s*sequenceDiagram\b/m.test(source))
    for (const m of source.matchAll(/^\s*\w+\s*-[->x)]+[+-]?\s*\w+\s*:\s*(.+)$/gm)) labels.push(m[1]);
  return labels.map((l) => l.replace(/<br\s*\/?>/g, " ").trim()).filter((l) => l.length > 40);
}

/** Per agent × task: verdicts of every repetition, median tool calls, damage and guidance misses. */
export function summarize(root) {
  const rows = [];
  for (const agent of readdirSync(root).filter((a) => AGENT_NAMES.includes(a))) {
    for (const task of TASKS.map((t) => t.id)) {
      const dir = join(root, agent, task);
      if (!existsSync(dir)) continue;
      const judged = readdirSync(dir)
        .sort()
        .map((rep) => join(dir, rep, "judgement.json"))
        .filter(existsSync)
        .map((f) => JSON.parse(readFileSync(f, "utf8")));
      if (judged.length === 0) continue;
      const calls = judged.map((j) => j.toolCalls).sort((a, b) => a - b);
      const damage = judged.flatMap((j) =>
        j.checks.filter((c) => c.name === "no other files changed" && !c.pass).map((c) => c.detail),
      );
      const guidance = [
        ...new Set(judged.flatMap((j) => j.checks.filter((c) => c.level === "should" && !c.pass).map((c) => c.name))),
      ];
      const misses = [
        ...new Set(
          judged.flatMap((j) =>
            j.checks
              .filter((c) => c.level === "must" && !c.pass && c.name !== "no other files changed")
              .map((c) => c.name),
          ),
        ),
      ];
      rows.push(
        `| ${agent} | ${task} | ${judged.map((j) => j.verdict).join(", ")} | ${calls.join("/")} (${judged.map((j) => j.mcpCalls).join("/")} mcp) | ${damage.length ? damage.join("; ") : "none"} | ${[...misses.map((m) => `✗ ${m}`), ...guidance].join("; ") || "ok"} |`,
      );
    }
  }
  return `| Agent | Task | Verdicts | Tool calls (MCP) | Damage | Misses and guidance |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { install: { type: "string" }, summary: { type: "string" } },
  });
  for (const dir of positionals) {
    const j = judgeRun(resolve(dir), resolve(values.install));
    if (!values.summary)
      console.log(
        `${j.agent} ${j.task} ${j.rep}: ${j.verdict}  calls=${j.toolCalls} archer=${j.archerCalls} (mcp ${j.mcpCalls}, cli ${j.cliCalls})  ${j.checks
          .filter((c) => !c.pass)
          .map((c) => `✗ ${c.name}${c.detail ? ` (${c.detail})` : ""}`)
          .join("; ")}`,
      );
  }
  if (values.summary) writeFileSync(join(resolve(values.summary), "summary.md"), summarize(resolve(values.summary)));
}
