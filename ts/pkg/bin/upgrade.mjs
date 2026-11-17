// `archer upgrade <archer-x.y.z.tgz>` (ADR 0032): installs the package as `setup` does (the
// previous copy is kept), then hot swaps the running main Archer to it (`archer restart`, a warm
// hand-over: open pages and the address stay). Setup, which it runs, refreshes the skill copies and
// MCP registrations. Tools reach running sessions through the relay (ADR 0035 §6), so the upgrade
// ends with one line on restarting sessions only when the skill they loaded changed.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { hotSwap, paths } from "./setup.mjs";

const USAGE = "usage: archer upgrade <path to archer-<version>.tgz> [--mcp] [--no-claude] [--no-codex]";

/** The skill an agent session loaded from an installed copy, as one digest; null when that copy has none. */
export function skillDigest(root) {
  const files = filesUnder(join(root, "skills"));
  if (files.length === 0) return null;
  const hash = createHash("sha256");
  for (const file of files) hash.update(relative(root, file)).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

/** The version id `current` names, or undefined. */
function currentCopy(current) {
  try {
    return readlinkSync(current).split(/[\\/]/).pop();
  } catch {
    return undefined;
  }
}

function filesUnder(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((name) => filesUnder(join(path, name)));
}

export async function upgrade(args) {
  const flags = args.filter((arg) => arg.startsWith("--"));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (
    positional.length !== 1 ||
    flags.some((flag) => !["--mcp", "--no-claude", "--no-codex"].includes(flag)) ||
    !positional[0].endsWith(".tgz")
  ) {
    console.error(USAGE);
    return 2;
  }
  const tgz = resolve(positional[0]);
  if (!existsSync(tgz)) {
    console.error(`archer upgrade: ${tgz} does not exist`);
    return 1;
  }
  const p = paths();
  const current = join(p.data, "current");
  const before = skillDigest(current);
  const copyBefore = currentCopy(current);

  console.log(`Installing ${tgz} …`);
  // As docs/install.md runs it: npx takes a relative `./<file>.tgz` as a package, an absolute path as a command.
  // From a copy in a fresh temp folder: inside an npm project (a checkout's dist/) npm resolves the
  // file against that project's root and finds nothing.
  const stage = mkdtempSync(join(tmpdir(), "archer-upgrade-"));
  let install;
  try {
    copyFileSync(tgz, join(stage, basename(tgz)));
    // npm needs no registry for a local file: without these it audits the install and asks for its own
    // latest version, and a stalled network holds the upgrade there with no output.
    const offline = { npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
    install = spawnSync("npx", ["--yes", `./${basename(tgz)}`, "setup", ...flags], {
      cwd: stage,
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, ...offline },
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  process.stdout.write(install.stdout ?? "");
  process.stderr.write(install.stderr ?? "");
  if (install.status !== 0) {
    const why = install.error ? ` (${install.error.message})` : "";
    const copyAfter = currentCopy(current);
    // Say what really happened: setup may have stopped after the new copy became current.
    if (copyAfter !== copyBefore)
      console.error(
        `archer upgrade: setup did not finish${why}, after it had made ${copyAfter ?? "a new copy"} the current copy (the archer command runs it now). The running Archer was not swapped. Fix the cause above, then run  archer setup  and  archer restart.`,
      );
    else
      console.error(
        `archer upgrade: the install failed${why}; the installed copy and the running Archer are unchanged.`,
      );
    return 1;
  }

  const swap = hotSwap(p);
  if (swap.status === 0) process.stdout.write(swap.stdout);
  else if (/not running/.test(swap.stderr))
    console.log("Archer was not running; the new version starts on its next use.");
  else {
    process.stderr.write(swap.stderr);
    console.error(
      "archer upgrade: installed, but the hot swap did not complete; see above. Run `archer restart` once the cause is fixed.",
    );
    return 1;
  }
  const after = skillDigest(current);
  if (before === null || before !== after)
    console.log("Restart your Claude Code and Codex sessions to load the new Archer skill.");
  return 0;
}
