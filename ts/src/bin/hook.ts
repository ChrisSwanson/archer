// `archer inbox --brief --hook claude-code|codex`: the one Archer-owned turn-start hook
// (agents/contract.ts HOOK_COMMAND). It runs before every prompt, so it always exits 0 (exit 2 would
// block the person's prompt), prints the brief line or nothing, never starts the service, and loads
// only the socket client: no compiler, no Mermaid, no MCP SDK (test/bin/hook.test.ts holds that).
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { briefLine } from "../agents/contract.ts";
import { serviceDirs, type Env } from "../service/paths.ts";
import { connectService, type ServiceClient } from "../service/service-client.ts";
import { detectHost, psProcess, readProcess, recogniseAgent, type DetectedHost } from "./agent-id.ts";

/** The whole hook gives up after this long and prints nothing. */
export const HOOK_DEADLINE_MS = 1500;
/** Without /proc the hook's ps walk takes at most this long in all (decision 45): it is synchronous… */
export const HOOK_PS_BUDGET_MS = 300;
/** …and reads at most this many ancestors (the session's shell, then Claude Code or Codex). */
export const HOOK_PS_MAX_DEPTH = 4;

export interface HookIo {
  readonly stdout: (text: string) => void;
  readonly env: Env;
  readonly cwd?: string | undefined;
  /**
   * The host process this hook runs under (tests inject it): from /proc, else (macOS) from ps within
   * HOOK_PS_BUDGET_MS and HOOK_PS_MAX_DEPTH ancestors, so it finds the session file `listen --claim` wrote.
   */
  readonly detect?: () => DetectedHost;
}

/**
 * The project root findProject (project/project.ts) would choose, without loading it: the nearest
 * archer.toml, else the repository, else the parent of a `.archer` folder, else the directory itself,
 * walking up only through this user's directories. Only for addressing the inbox; nothing is read.
 */
export function hookProjectRoot(start: string): string {
  let from: string;
  try {
    from = realpathSync(resolve(start));
  } catch {
    return resolve(start);
  }
  let home: string | null = null;
  try {
    home = realpathSync(homedir());
  } catch {
    /* none */
  }
  let insideFolder: string | null = null;
  for (let dir = from; ; dir = dirname(dir)) {
    // As findProject: the walk stops at a directory someone else could change (another owner, o+w).
    if (dir !== from && !ownedHere(dir)) break;
    const manifest = join(dir, "archer.toml");
    try {
      if (statSync(manifest).isFile()) return dir;
    } catch {
      /* absent */
    }
    if (insideFolder === null && basename(dir) === ".archer") insideFolder = dirname(dir);
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === home || dirname(dir) === dir) break;
  }
  return insideFolder ?? from;
}

/** findProject's trust check, short: this user's, and not writable by others (a private group is not checked). */
function ownedHere(dir: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  try {
    const stats = statSync(dir);
    return stats.uid === uid && (stats.mode & 0o002) === 0;
  } catch {
    return false;
  }
}

/** Parses the hook's arguments; null when they are not the hook's (the caller then refuses them). */
export function hookHost(args: readonly string[]): "claude-code" | "codex" | null {
  const at = args.indexOf("--hook");
  const host = at < 0 ? undefined : args[at + 1];
  const rest = args.filter((_arg, index) => index !== at && index !== at + 1);
  if ((host !== "claude-code" && host !== "codex") || rest.some((arg) => arg !== "--brief")) return null;
  return host;
}

/** Runs the hook; always resolves to 0. */
export async function runHook(args: readonly string[], io: HookIo): Promise<0> {
  if (hookHost(args) === null) return 0;
  let client: ServiceClient | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOOK_DEADLINE_MS);
  timer.unref();
  try {
    const cwd = io.cwd ?? process.cwd();
    let real = cwd;
    try {
      real = realpathSync(cwd);
    } catch {
      /* as given */
    }
    // Only what would reach this session is counted (decision 5): a session Archer does not know as an
    // agent (no listen --claim, no MCP relay, no ARCHER_AGENT_ID) is told nothing.
    const known = recogniseAgent({
      env: io.env,
      cwd: real,
      detected:
        io.detect?.() ??
        detectHost(
          io.env,
          readProcess({ ps: psProcess(undefined, { budgetMs: HOOK_PS_BUDGET_MS, maxDepth: HOOK_PS_MAX_DEPTH }) }),
        ),
    });
    if (known === null) return 0;
    const root = known.root ?? hookProjectRoot(cwd);
    const socketPath = serviceDirs(io.env).socketPath;
    if (!existsSync(socketPath)) return 0;
    client = await connectService(socketPath, undefined, controller.signal);
    const deadline = new Promise<null>((ok) =>
      controller.signal.addEventListener("abort", () => ok(null), { once: true }),
    );
    // A recognised listener's hook is its heartbeat between waits; the count never marks anything read.
    const heartbeat = client.call("heartbeat", { agentId: known.agentId, via: "hook" }).catch(() => null);
    const answered = await Promise.race([
      Promise.all([client.call("inbox", { root, agentId: known.agentId, brief: true }), heartbeat]),
      deadline,
    ]);
    const line = answered === null ? "" : briefLine(answered[0].count);
    if (line !== "") io.stdout(`${line}\n`);
  } catch {
    // No service, a refusal, a sandbox refusal: the person's prompt goes ahead with nothing added.
  } finally {
    clearTimeout(timer);
    client?.close();
  }
  return 0;
}

export { detectHost };
