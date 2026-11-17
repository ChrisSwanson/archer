// `archer doctor` (ADR 0035 §5): run by the agent on first use in a session, from its own sandbox. It
// checks that the CLI runs, the service is reachable and its page loads, and that the installed skill is
// this CLI's; every failure ends in one line beginning "Tell the person:".
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import type { ServiceClient } from "../service/service-client.ts";
import { detectHost, HOST_NAMES, type DetectedHost } from "./agent-id.ts";
import { safe, usage, version, type Io } from "./main.ts";
import { skillFiles } from "./skill.ts";
import { findProject } from "../project/project.ts";
import { loadGlobalConfiguration } from "../config/load.ts";

export interface DoctorDeps {
  readonly connect: (io: Io) => Promise<ServiceClient>;
  readonly checkPage: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  readonly detect: (io: Io) => DetectedHost;
  /** This CLI's skill: SKILL.md, then references/*.md, relative to the folder. */
  readonly bundledSkill: () => readonly { path: string; text: string }[];
}

const defaultDeps: DoctorDeps = {
  connect: async (io) => (await import("../service/client.ts")).ensureService({ env: io.env }),
  checkPage: async (url) => (await import("./present.ts")).checkPage(url),
  detect: (io) => detectHost(io.env),
  bundledSkill: () => skillFiles(),
};

/** Where Claude Code and Codex look for a global skill named archer. */
export function installedSkillPaths(env: Io["env"]): { host: "claude-code" | "codex"; path: string }[] {
  const home = env["HOME"] !== undefined && isAbsolute(env["HOME"]) ? env["HOME"] : homedir();
  const codexHome =
    env["CODEX_HOME"] !== undefined && isAbsolute(env["CODEX_HOME"]) ? env["CODEX_HOME"] : join(home, ".codex");
  const claudeHome =
    env["CLAUDE_CONFIG_DIR"] !== undefined && isAbsolute(env["CLAUDE_CONFIG_DIR"])
      ? env["CLAUDE_CONFIG_DIR"]
      : join(home, ".claude");
  return [
    { host: "claude-code", path: join(claudeHome, "skills", "archer", "SKILL.md") },
    { host: "codex", path: join(codexHome, "skills", "archer", "SKILL.md") },
  ];
}

/**
 * The project's and the account's archer.toml (C-30): a setting Archer cannot use, such as `edit`
 * written under a table header, is named with its line here as in the page's settings, never passed over.
 */
function configCheck(io: Io, lines: string[], failure: (line: string, tell: string) => void): void {
  let clean = true;
  try {
    const project = findProject(io.cwd ?? process.cwd());
    for (const problem of project.problems) {
      clean = false;
      failure(
        `Config: ${project.manifest ?? "archer.toml"} view ${problem.position}${problem.id === null ? "" : ` (${problem.id})`}: ${problem.message}`,
        `this project's archer.toml has a setting Archer cannot use (above); fix the line it names, then ask me again.`,
      );
    }
  } catch (error) {
    clean = false;
    failure(
      `Config: ${error instanceof Error ? error.message : String(error)}`,
      "this project's archer.toml cannot be used as it is (above); fix what it names, then ask me again.",
    );
  }
  try {
    loadGlobalConfiguration(io.env);
  } catch (error) {
    clean = false;
    failure(
      `Config: ${error instanceof Error ? error.message : String(error)}`,
      "your account's archer.toml cannot be used as it is (above), so Archer refuses page edits and project writes until it is fixed; fix what it names, then ask me again.",
    );
  }
  if (clean) lines.push("✓ Config: archer.toml (this project's, and the account's) has no problems");
}

/** An installed skill folder's files, as `skillFiles` reads them; none when it cannot be read. */
function readSkill(dir: string): { path: string; text: string }[] {
  try {
    return skillFiles(dir);
  } catch {
    return [];
  }
}

export async function runDoctor(args: readonly string[], io: Io, deps: Partial<DoctorDeps> = {}): Promise<number> {
  usage(() => parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {} }));
  const use: DoctorDeps = { ...defaultDeps, ...deps };
  const lines: string[] = [];
  let failed = false;
  const failure = (line: string, tell: string): void => {
    failed = true;
    lines.push(`✗ ${line}`, `  Tell the person: ${tell}`);
  };

  lines.push(`✓ CLI: archer ${version()} runs (node ${process.versions.node})`);
  configCheck(io, lines, failure);

  let client: ServiceClient | null = null;
  try {
    client = await use.connect(io);
    const hello = await client.call("hello", { protocolVersion: 1 });
    const page = await use.checkPage(hello.homeUrl);
    const behind =
      hello.version !== version()
        ? ` (the service runs ${hello.version}, this CLI is ${version()}: archer restart replaces it)`
        : "";
    if (page.ok) lines.push(`✓ Service: reachable, and its page loads${behind}`);
    else
      failure(
        `Service: reachable, but ${page.reason}`,
        `Archer's page does not load from here (${page.reason}); check that nothing blocks ${new URL(hello.homeUrl).host}, or run  archer restart.`,
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fix = /sandbox/.test(message)
      ? "Its sandbox blocks local connections; allow local network access for it (the message above names the setting)."
      : // R4: a state or socket directory named by ARCHER_STATE_DIR or ARCHER_SOCKET is refused while others can read it.
        /run: chmod 700 /.test(message)
        ? "The folder Archer is set to keep its token or socket in is open to other accounts, so Archer will not use it; run the chmod line above, then ask me again."
        : "Run  archer serve  in a terminal, then ask me again.";
    failure(`Service: not reachable: ${message}`, `this session cannot reach Archer's service. ${fix}`);
  } finally {
    client?.close();
  }

  let ours: readonly { path: string; text: string }[] | undefined;
  try {
    ours = use.bundledSkill();
  } catch (error) {
    failure(
      `Skill: this installation has none (${error instanceof Error ? error.message : String(error)})`,
      "reinstall Archer: its package carries the skill.",
    );
  }
  if (ours !== undefined) {
    const detected = use.detect(io);
    const found = installedSkillPaths(io.env).filter((entry) => existsSync(entry.path));
    const checked = detected.host === "other" ? found : found.filter((entry) => entry.host === detected.host);
    if (checked.length === 0) {
      const where = detected.host === "other" ? "for Claude Code or Codex" : `for ${HOST_NAMES[detected.host]}`;
      failure(
        `Skill: no Archer skill installed ${where}`,
        "the Archer skill is not installed for this agent; run  archer setup  (or  archer skill --write <the host's skills folder>/archer), then restart this session.",
      );
    }
    for (const entry of checked) {
      // File by file: an upgrade can change a reference and leave SKILL.md as it was (O43).
      const theirs = new Map(readSkill(dirname(entry.path)).map((file) => [file.path, file.text]));
      const differ = ours.flatMap((file) =>
        theirs.has(file.path)
          ? theirs.get(file.path) === file.text
            ? []
            : [`${file.path} differs`]
          : [`${file.path} is missing`],
      );
      if (differ.length === 0)
        lines.push(`✓ Skill: ${HOST_NAMES[entry.host]}'s copy is this CLI's (${version()}, ${ours.length} files)`);
      else
        failure(
          `Skill: ${HOST_NAMES[entry.host]}'s copy (${dirname(entry.path)}) is not this CLI's (${version()}): ${differ.join(", ")}`,
          `the Archer skill ${HOST_NAMES[entry.host]} loads is from another version; run  archer upgrade  (or  archer setup) to refresh it, then restart this session.`,
        );
    }
  }
  io.stdout(`${lines.map(safe).join("\n")}\n${failed ? "" : "Archer is ready.\n"}`);
  return failed ? 1 : 0;
}
