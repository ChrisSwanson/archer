// Recognising the listener on later calls (0.7.0 plan, default 5). `archer listen --claim` prints an
// agent id and writes it to this session's environment file; `wait` and `inbox` take `--as <id>`,
// else ARCHER_AGENT_ID, else the file of the `claude` or `codex` process they run under, when the
// working directory is inside the checkout it claimed. Light on purpose: the turn-start hook loads it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, isAbsolute } from "node:path";
import type { AgentHost } from "../agents/contract.ts";
import { serviceDirs, type Env } from "../service/paths.ts";

/**
 * One process as /proc (or ps) shows it: its parent, its executable's name (`comm`; argv[0] when absent)
 * and its arguments, the program first. From ps, whose argument line is one string where a path may hold
 * spaces, a runtime's script is the longest leading run of words that is a file (argvOfArgs).
 */
export interface ProcessFacts {
  readonly ppid: number;
  readonly argv: readonly string[];
  readonly comm?: string;
}
/**
 * Reads one process; `maxDepth` caps how many ancestors a walk with it reads, and `isFile` is the file check
 * a walk with it uses for a runtime's script.
 */
export type ReadProcess = ((pid: number) => ProcessFacts | null) & {
  readonly maxDepth?: number;
  readonly isFile?: (path: string) => boolean;
};

/** The host agent process this command runs under, or `other` with no pid. */
export interface DetectedHost {
  readonly host: AgentHost;
  readonly hostPid?: number;
}

const MAX_DEPTH = 16;
/** Without /proc each ancestor costs two `ps` runs: at most this many ancestors… */
export const PS_MAX_DEPTH = 8;
/** …and at most this long in `ps` for one detection (decisions 37, 47). */
export const PS_BUDGET_MS = 1_000;

/** /proc/<pid>: the parent pid from `stat`, the executable's name from `comm`, the arguments from `cmdline`; null off Linux or when gone. */
export const readProc: ReadProcess = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is in parentheses and may hold spaces; the fields after it are fixed.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(after[1]);
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter((part) => part !== "");
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").replace(/\n$/u, "");
    return Number.isInteger(ppid) ? { ppid, argv, comm } : null;
  } catch {
    return null;
  }
};

/** Runs `ps` with these arguments, killed after `timeoutMs`: its output, or null when it fails or is not there. */
export type RunPs = (args: readonly string[], timeoutMs: number) => string | null;

const runPs: RunPs = (args, timeoutMs) => {
  try {
    return execFileSync("ps", [...args], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

/** Whether an absolute path is a regular file (a relative one would be relative to the process's own folder). */
const isRegularFile = (path: string): boolean => {
  if (!isAbsolute(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export interface PsOptions {
  /** The time in `ps` this reader may spend, across every run (PS_BUDGET_MS). */
  readonly budgetMs?: number;
  /** The most ancestors a walk with it reads (PS_MAX_DEPTH). */
  readonly maxDepth?: number;
  readonly clock?: () => number;
  readonly isFile?: (path: string) => boolean;
}

/**
 * One process as `ps` shows it, where there is no /proc (macOS): the parent and executable from
 * `ps -o ppid= -o comm=`, and the argument line from `ps -o args=`. Every run counts against the reader's
 * one budget (each run's timeout is what is left); once it is spent the answer is null, so a slow `ps`
 * never holds the command past it. Null when ps fails. A reader serves one detection (decision 47).
 */
export function psProcess(run: RunPs = runPs, options: PsOptions = {}): ReadProcess {
  const budgetMs = options.budgetMs ?? PS_BUDGET_MS;
  const clock = options.clock ?? Date.now;
  const isFile = options.isFile ?? isRegularFile;
  let spent = 0;
  const ps = (args: readonly string[]): string | null => {
    const left = budgetMs - spent;
    if (left <= 0) return null;
    const started = clock();
    try {
      return run(args, left);
    } finally {
      spent += Math.max(1, clock() - started);
    }
  };
  const read = (pid: number): ProcessFacts | null => {
    const head = ps(["-o", "ppid=", "-o", "comm=", "-p", String(pid)])
      ?.trim()
      .match(/^(\d+)\s+(\S.*)$/u);
    if (head === null || head === undefined) return null;
    const comm = head[2]!;
    // The executable decides first; only a runtime's arguments are read.
    if (hostName(comm) !== null || !RUNTIME.test(basename(comm))) return { ppid: Number(head[1]), comm, argv: [comm] };
    const args = ps(["-o", "args=", "-p", String(pid)])?.trim() ?? "";
    return { ppid: Number(head[1]), comm, argv: args === "" ? [comm] : argvOfArgs(args, comm, isFile) };
  };
  return Object.assign(read, { maxDepth: options.maxDepth ?? PS_MAX_DEPTH, isFile });
}

/** /proc where the system has it, else ps; both injectable so either path is tested on any system. */
export function readProcess(
  options: { readonly proc?: ReadProcess; readonly ps?: ReadProcess; readonly procAvailable?: () => boolean } = {},
): ReadProcess {
  const proc = options.proc ?? readProc;
  const ps = options.ps ?? psProcess();
  const available = options.procAvailable ?? (() => existsSync("/proc/self/stat"));
  const read = (pid: number) => (available() ? proc(pid) : ps(pid));
  return Object.defineProperties(read, {
    maxDepth: { get: () => (available() ? proc.maxDepth : ps.maxDepth) },
    isFile: { get: () => (available() ? proc.isFile : ps.isFile) },
  }) as ReadProcess;
}

const HOST_NAME = /^(?:claude(?:\.exe)?|claude-code\S*)$/u;
const CODEX_NAME = /^codex(?:\.exe)?$/u;
const RUNTIME = /^(?:node|nodejs|bun)(?:\.exe)?$/u;
/**
 * Runtime options whose value is the next argument (a `--name=value` is one argument). Not every such
 * option of node or bun is here: one missing (`--redirect-warnings <file>`, say) can let its value pass for
 * the script. That is accepted (decision 54): the walk recognises the host, it does not authenticate it,
 * and the value would still have to be an existing file named like a host.
 */
const VALUE_OPTIONS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--input-type",
  "--env-file",
  "--title",
]);
/** Runtime options that run code without a script, also attached (`--eval=…`, `-e…`; decision 54). */
const NO_SCRIPT = /^(?:--eval(?:=.*)?|--print(?:=.*)?|-e.*|-p.*)$/su;
/**
 * The one title that counts: a runtime whose argument line starts with exactly the bare name, as the
 * npm-installed Claude Code sets it (macOS ps keeps comm `node`). Its host pid finds the session file.
 */
const BARE_TITLE = /^(?:claude|codex)$/u;
/** The most words a script path is taken to span in ps's argument line. */
const MAX_PATH_WORDS = 64;

/** The host an executable or script path is: its name, or the package it is in. */
function hostName(path: string): AgentHost | null {
  const name = basename(path);
  if (HOST_NAME.test(name) || path.includes("/@anthropic-ai/claude-code/")) return "claude-code";
  if (CODEX_NAME.test(name) || path.includes("/@openai/codex/")) return "codex";
  return null;
}

/** Where a runtime's script is among its arguments, after its options; -1 when it runs none. */
function scriptAt(argv: readonly string[], from: number): number {
  let at = from;
  while (at < argv.length && argv[at]!.startsWith("-")) {
    if (NO_SCRIPT.test(argv[at]!)) return -1;
    at += VALUE_OPTIONS.has(argv[at]!) ? 2 : 1;
  }
  return at < argv.length ? at : -1;
}

/**
 * Which host a process is (decision 51): its executable (`comm`, else argv[0]) by name, or, for node,
 * nodejs or bun, the script it runs after its options, only when that script is a regular file, or a
 * first argument that is exactly the bare name `claude` or `codex` (BARE_TITLE). Later arguments and any
 * other title never count.
 */
export function hostOf(
  argv: readonly string[],
  isFile: (path: string) => boolean = isRegularFile,
  comm?: string,
): AgentHost | null {
  const program = comm ?? argv[0];
  if (program === undefined) return null;
  const host = hostName(program);
  if (host !== null || !RUNTIME.test(basename(program))) return host;
  if (BARE_TITLE.test(argv[0] ?? "")) return hostName(argv[0]!);
  const at = scriptAt(argv, 1);
  return at < 0 || !isFile(argv[at]!) ? null : hostName(argv[at]!);
}

/** The longest run of leading words (at most MAX_PATH_WORDS) that is a regular file, joined; null when none is. */
function leadingFile(
  words: readonly string[],
  isFile: (path: string) => boolean,
): { readonly path: string; readonly count: number } | null {
  for (let count = Math.min(words.length, MAX_PATH_WORDS); count >= 1; count--) {
    const path = words.slice(0, count).join(" ");
    if (isFile(path)) return { path, count };
  }
  return null;
}

/** How many leading words name the runtime executable: `comm` itself, else the shortest run whose name is a runtime's; 0 when none does (a title). */
function runtimeWords(words: readonly string[], args: string, comm: string): number {
  if (comm !== "" && (args === comm || args.startsWith(`${comm} `))) return comm.split(" ").length;
  for (let count = 1; count <= Math.min(words.length, MAX_PATH_WORDS); count++)
    if (RUNTIME.test(basename(words.slice(0, count).join(" ")))) return count;
  return 0;
}

/**
 * ps's argument line of a runtime as argv, where paths may hold spaces: the executable, its options split
 * on spaces, then its script as the longest leading run of words that is a regular file, then the rest.
 * A line that does not start with a runtime (a title the process set) is only `[comm]`, unless its first
 * word is a bare host name (BARE_TITLE), which is kept with the rest; a script that is
 * no file is left split, so it never matches.
 */
export function argvOfArgs(args: string, comm: string, isFile: (path: string) => boolean = isRegularFile): string[] {
  const words = args.split(" ");
  const programWords = runtimeWords(words, args, comm);
  if (programWords === 0) return BARE_TITLE.test(words[0]!) ? words : [comm];
  const program = words.slice(0, programWords).join(" ");
  const rest = words.slice(programWords);
  const at = scriptAt(rest, 0);
  if (at < 0) return [program, ...rest];
  const script = leadingFile(rest.slice(at), isFile);
  if (script === null) return [program, ...rest];
  return [program, ...rest.slice(0, at), script.path, ...rest.slice(at + script.count)];
}

/** Which host ps's argument line is, given its executable (decision 51). */
export function hostOfArgs(
  args: string,
  comm = "",
  isFile: (path: string) => boolean = isRegularFile,
): AgentHost | null {
  return hostName(comm) ?? (RUNTIME.test(basename(comm)) ? hostOf(argvOfArgs(args, comm, isFile), isFile, comm) : null);
}

/**
 * Walks up from `pid` (this process's parent by default) to the nearest claude or codex process, at most
 * the reader's `maxDepth` ancestors. The default reader is a fresh one, with its own ps budget.
 */
export function detectHost(
  env: Env,
  read: ReadProcess = readProcess(),
  start = process.ppid,
  isFile: (path: string) => boolean = read.isFile ?? isRegularFile,
): DetectedHost {
  const maxDepth = read.maxDepth ?? MAX_DEPTH;
  for (let pid = start, depth = 0; pid > 1 && depth < maxDepth; depth += 1) {
    const facts = read(pid);
    if (facts === null) break;
    const host = hostOf(facts.argv, isFile, facts.comm);
    if (host !== null) return { host, hostPid: pid };
    pid = facts.ppid;
  }
  // No process found (another OS, a container): the hosts' own variables still say which it is.
  if (env["CLAUDECODE"] === "1" || env["CLAUDE_CODE_ENTRYPOINT"] !== undefined) return { host: "claude-code" };
  if (env["CODEX_SANDBOX"] !== undefined || env["CODEX_THREAD_ID"] !== undefined) return { host: "codex" };
  return { host: "other" };
}

/** A detector that detects once per command (its environment) and gives every later lookup that answer (decision 47). */
export function detectOnce(detect: (env: Env) => DetectedHost): (env: Env) => DetectedHost {
  const found = new WeakMap<Env, DetectedHost>();
  return (env) => {
    let host = found.get(env);
    if (host === undefined) found.set(env, (host = detect(env)));
    return host;
  };
}

/** This command's host: one walk, whatever number of lookups (reporting in, the caller's id). */
export const commandHost = detectOnce((env) => detectHost(env));

export const HOST_NAMES: Readonly<Record<AgentHost, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  other: "Agent",
};

/**
 * The place an agent works, as the page may show it: `~/code/archer` under the person's home, else only
 * the folder's name. Never an absolute path (decision 13: paths never reach the page).
 */
export function displayPath(path: string, home = homedir()): string {
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return basename(path) || "/";
}

/** The picker's label for an agent: "Claude Code · ~/code/archer", at most 80 code points, as the registry counts. */
export function agentLabel(host: AgentHost, cwd: string, home = homedir()): string {
  const points = [...`${HOST_NAMES[host]} · ${displayPath(cwd, home)}`];
  return points.length <= 80 ? points.join("") : `${points.slice(0, 79).join("")}…`;
}

/**
 * What `listen --claim` (or the MCP relay) remembers for this session: its id, and the checkout it works
 * in and listens to (`root`; decision 15: no listening to another checkout in 0.7.0). Other keys in the
 * file are ignored.
 */
export interface Recognised {
  readonly agentId: string;
  readonly root?: string;
  readonly cwd?: string;
}

const sessionFile = (env: Env, host: AgentHost, hostPid: number): string =>
  join(serviceDirs(env).stateDir, "agents", `${host}-${hostPid}.env`);

/** Writes the session's environment file (ARCHER_AGENT_ID=…), private, replaced whole. Null without a host pid. */
export function rememberAgent(
  env: Env,
  detected: DetectedHost,
  facts: Recognised & { readonly root: string; readonly cwd: string },
): string | null {
  if (detected.hostPid === undefined) return null;
  const path = sessionFile(env, detected.host, detected.hostPid);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const lines = [
    `ARCHER_AGENT_ID=${facts.agentId}`,
    `ARCHER_AGENT_ROOT=${facts.root}`,
    `ARCHER_AGENT_CWD=${facts.cwd}`,
  ];
  writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Reads a session file; null when absent or not one. */
function readSessionFile(path: string): Recognised | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const fields = Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const),
  );
  const agentId = fields["ARCHER_AGENT_ID"];
  if (agentId === undefined || !AGENT_ID.test(agentId)) return null;
  const optional = (key: string, name: keyof Recognised) => (fields[key] ? { [name]: fields[key] } : {});
  return { agentId, ...optional("ARCHER_AGENT_ROOT", "root"), ...optional("ARCHER_AGENT_CWD", "cwd") };
}

/** Whether this host process already has a session file (the CLI's claim, or the relay's first id). */
export function hasSessionFile(env: Env, detected: DetectedHost): boolean {
  return detected.hostPid !== undefined && readSessionFile(sessionFile(env, detected.host, detected.hostPid)) !== null;
}

const inside = (base: string, path: string): boolean => {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The listener this command speaks for: `--as`, else ARCHER_AGENT_ID, else the session file of the host
 * process when `cwd` is inside the checkout it claimed (or the directory it claimed from). Null otherwise.
 */
export function recogniseAgent(options: {
  readonly as?: string | undefined;
  readonly env: Env;
  readonly cwd: string;
  readonly detected?: DetectedHost;
}): Recognised | null {
  if (options.as !== undefined) return { agentId: options.as };
  const fromEnv = options.env["ARCHER_AGENT_ID"];
  if (fromEnv !== undefined && AGENT_ID.test(fromEnv)) return { agentId: fromEnv };
  const detected = options.detected ?? detectHost(options.env);
  if (detected.hostPid === undefined) return null;
  const found = readSessionFile(sessionFile(options.env, detected.host, detected.hostPid));
  if (found === null) return null;
  const within = [found.root, found.cwd].some((base) => base !== undefined && inside(base, options.cwd));
  return within ? found : null;
}

export const isAgentId = (value: string): boolean => AGENT_ID.test(value);
