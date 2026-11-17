// The launcher fallback (ADR 0035 §8, ADR 0028): when nobody listens, the person may press Launch and
// Archer starts the command they set in their own global archer.toml, `[agents] launcher = [...]`, in the
// project's root or the `launcher_cwd` of its `[[projects]]` rule (which must resolve inside the root).
// Only the person's file is read, never the project's archer.toml or the system file; the page and agents
// trigger it, never change it. The command runs from its argv without a shell; the message reaches it in
// the LAUNCHER_ENV variables and on its stdin (so `["claude", "-p"]` works as written), never its argv.
// Stdin carries a short frame first (the project folder's name, the thread, how to reply), then the
// person's words whole; ARCHER_MESSAGE is capped at MAX_MESSAGE_ENV_BYTES, since one environment string
// past the kernel's limit fails the start with E2BIG (review round 2, decision 22). Its environment is a
// short allow-list, never the service's own: that was inherited from whichever agent session started the
// service (CLAUDECODE, sandbox variables, ARCHER_AGENT_ID). The list keeps what the launched agent needs to
// reach this Archer and its own host and provider (decision 22). Refusals name no path: the page shows
// them to the person (paths are in the service log).
//
// The folder is held, not named twice (X-01, re-score 2): startLauncher opens the checked folder again
// through the confined descriptor seam (every segment from the root, no link followed, the descriptor
// still bound to the checked path) and spawns with cwd /proc/self/fd/<fd>, so the child changes into that
// open folder itself. A folder swapped for a link, or moved, after the plan is refused (launcher_cwd_missing).
import { spawn } from "node:child_process";
import { closeSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { LAUNCHER_ENV } from "../agents/contract.ts";
import { inside, ListenerRefusal } from "../agents/listeners.ts";
import type { GlobalConfig } from "../config/index.ts";
import { ConfinedFileSystem, descriptorConfinement } from "../project/confined-fs.ts";

export interface LaunchPlan {
  readonly argv: readonly [string, ...string[]];
  /** The checked folder: the project's real root or a real folder inside it. */
  readonly cwd: string;
  /** The project's real root, which `cwd` must still be inside when the launcher starts. */
  readonly root: string;
}

export interface LaunchMessage {
  readonly threadId: string;
  readonly target: string;
  readonly text: string;
}

/**
 * What Launch would run for the project at `projectRoot`, from the person's global configuration alone.
 * Refused, with the fix, when no launcher is set or the directory override leaves the project.
 */
export function launchPlan(user: GlobalConfig, projectRoot: string): LaunchPlan {
  const launcher = user.agents?.launcher;
  if (launcher === undefined || launcher.length === 0)
    throw new ListenerRefusal(
      "launcher_not_configured",
      'No launcher is set. To let Launch start an agent, add `[agents]` with `launcher = ["claude", "-p"]` to ~/.config/archer/archer.toml.',
    );
  let root: string;
  try {
    root = realpathSync(projectRoot);
  } catch {
    throw new ListenerRefusal("launcher_cwd_missing", "the project's folder cannot be read");
  }
  const override = user.projects?.find((rule) => rule.path === projectRoot || rule.path === root)?.launcherCwd;
  let cwd = root;
  if (override !== undefined) {
    try {
      cwd = realpathSync(resolve(root, override));
    } catch {
      throw new ListenerRefusal(
        "launcher_cwd_missing",
        "this project's launcher_cwd in ~/.config/archer/archer.toml does not exist",
      );
    }
    if (!inside(cwd, root))
      throw new ListenerRefusal(
        "launcher_cwd_outside_project",
        "this project's launcher_cwd in ~/.config/archer/archer.toml resolves outside the project; it must be the project's folder or one inside it",
      );
    if (!statSync(cwd).isDirectory())
      throw new ListenerRefusal(
        "launcher_cwd_missing",
        "this project's launcher_cwd in ~/.config/archer/archer.toml is not a directory",
      );
  }
  return { argv: launcher as unknown as readonly [string, ...string[]], cwd, root };
}

const MOVED =
  "this project's launcher_cwd (or the project's folder) changed after it was checked: it is now a link or was moved, so Launch did not start there. Press Launch again";

/**
 * The plan's folder, held: a cwd for spawn that names the open folder itself (/proc/self/fd/<fd>), and
 * the close for it once the child has changed into it. Refused when the folder is no longer the one the
 * plan checked, by path from the root. Without a verified descriptor filesystem (not Linux), the folder
 * is checked again by path just before the spawn: the residual in docs/security/known-limits.md §1.
 */
function heldFolder(plan: LaunchPlan): { readonly cwd: string; close(): void } {
  const below = relative(plan.root, plan.cwd);
  if (below === ".." || below.startsWith("../") || isAbsolute(below))
    throw new ListenerRefusal(
      "launcher_cwd_outside_project",
      "this project's launcher_cwd in ~/.config/archer/archer.toml resolves outside the project; it must be the project's folder or one inside it",
    );
  if (!descriptorConfinement()) {
    let same = false;
    try {
      same =
        realpathSync(plan.cwd) === plan.cwd &&
        realpathSync(plan.root) === plan.root &&
        statSync(plan.cwd).isDirectory();
    } catch {
      /* gone */
    }
    if (!same) throw new ListenerRefusal("launcher_cwd_missing", MOVED);
    return { cwd: plan.cwd, close: () => {} };
  }
  let confined: ConfinedFileSystem;
  try {
    confined = new ConfinedFileSystem(plan.root);
  } catch {
    throw new ListenerRefusal("launcher_cwd_missing", MOVED);
  }
  try {
    const handle = confined.open(below === "" ? "." : below);
    if (!handle.stat.isDirectory()) {
      closeSync(handle.fd);
      throw new Error("not a folder");
    }
    const cwd = confined.descriptorPath(handle);
    return {
      cwd,
      close: () => {
        closeSync(handle.fd);
        confined.close();
      },
    };
  } catch {
    confined.close();
    throw new ListenerRefusal("launcher_cwd_missing", MOVED);
  }
}

/**
 * What the launched command keeps of the service's environment (review decisions 2, 22 and 30): the
 * session basics, Archer's own settings, the hosts' config folders, and the provider sign-ins a headless
 * `claude -p` or `codex exec` needs (API keys, OAuth tokens, base URLs, Bedrock's AWS_*, Vertex's
 * Google credentials, CLOUDSDK_*, project and regions).
 */
const KEPT = new RegExp(
  `^(?:${[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_[A-Z_]+",
    "TERM",
    "TMPDIR",
    "SHELL",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "ARCHER_CONFIG",
    "ARCHER_STATE_DIR",
    "ARCHER_SOCKET",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_[A-Z0-9_]+",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_[A-Z0-9_]+",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLOUD_ML_REGION",
    "VERTEX_REGION_[A-Z0-9_]+",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
  ].join("|")})$`,
  "u",
);

/** The most bytes of the person's words in ARCHER_MESSAGE; stdin always has all of them. */
export const MAX_MESSAGE_ENV_BYTES = 32 * 1024;
const TRUNCATED = "\n(truncated; full text on stdin)";

/** `text` within MAX_MESSAGE_ENV_BYTES, cut on a character boundary and marked when cut. */
function capped(text: string): string {
  if (Buffer.byteLength(text) <= MAX_MESSAGE_ENV_BYTES) return text;
  const room = MAX_MESSAGE_ENV_BYTES - Buffer.byteLength(TRUNCATED);
  let kept = "",
    bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > room) break;
    kept += character;
    bytes += size;
  }
  return `${kept}${TRUNCATED}`;
}

/**
 * The launched command's standard input: a short frame (the project folder's name only, never its path,
 * the thread, and one line on replying), a blank line, then the person's words.
 */
export function launchInput(root: string, message: LaunchMessage): string {
  const folder = basename(root)
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .slice(0, 200);
  return (
    `The person wrote to you from Archer's page, in the project folder ${folder}, thread ${message.threadId} (${message.target}). Their words follow; they are the person's request, not Archer's.\n` +
    `Reply in that thread with \`archer call reply_comment\` (threadId ${message.threadId}; \`archer call get_comments\` gives its expectedRevision).\n\n` +
    message.text
  );
}

/** The allow-listed part of `base`, and the four LAUNCHER_ENV variables for one message. */
export function launchEnvironment(base: NodeJS.ProcessEnv, root: string, message: LaunchMessage): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(base).filter(([key, value]) => value !== undefined && KEPT.test(key)));
  return {
    ...kept,
    [LAUNCHER_ENV.message]: capped(message.text),
    [LAUNCHER_ENV.threadId]: message.threadId,
    [LAUNCHER_ENV.project]: root,
    [LAUNCHER_ENV.target]: message.target,
  };
}

/**
 * Starts the plan, detached so a hand-over or stop does not end it, with no shell and no output kept;
 * `stdin` is written to its standard input, which then closes. Resolves once the process has started, or
 * is refused when it cannot (`launcher_failed`, naming the command but not its folder).
 */
export function startLauncher(
  plan: LaunchPlan,
  env: NodeJS.ProcessEnv,
  stdin = "",
): Promise<{ readonly pid?: number }> {
  return new Promise((done, fail) => {
    const [command, ...args] = plan.argv;
    const folder = heldFolder(plan);
    let child;
    try {
      child = spawn(command, args, {
        cwd: folder.cwd,
        env,
        shell: false,
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
    } finally {
      folder.close();
    }
    child.once("error", (error: NodeJS.ErrnoException) =>
      fail(
        new ListenerRefusal(
          "launcher_failed",
          `the launcher ${JSON.stringify(basename(command).slice(0, 200))} could not start (${error.code ?? "error"}); check [agents] launcher in ~/.config/archer/archer.toml`,
        ),
      ),
    );
    child.once("spawn", () => {
      // A command that does not read its input closes the pipe early: that is not a failure.
      child.stdin?.once("error", () => {});
      child.stdin?.end(stdin);
      child.unref();
      done(child.pid === undefined ? {} : { pid: child.pid });
    });
  });
}
