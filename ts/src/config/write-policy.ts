// ADR 0013's per-project write rules, enforced (ADR 0028). The account's global archer.toml
// `[[projects]]` entries say which Archer-owned writes a project allows: `diagrams`, `notes`,
// `comments`, `emphasis`, `register` and `manifest`. Unspecified rules are true, `read_only = true`
// makes them false, and `register` also needs `manifest`. Every confined writer asks here, inside
// its own write, immediately before the effect; the configuration is read fresh each time, and a
// configuration that cannot be read refuses the write (fail closed).
import { ProjectError } from "../project/errors.ts";
import type { ProjectRule } from "./index.ts";
import { loadGlobalConfiguration } from "./load.ts";
import { selectProjectRule } from "./resolve.ts";

export const WRITE_RULES = ["diagrams", "notes", "comments", "emphasis", "register", "manifest"] as const;
export type WriteRule = (typeof WRITE_RULES)[number];
export type WriteRules = Readonly<Record<WriteRule, boolean>>;

/** The rules one `[[projects]]` entry grants; no entry is the permissive built-in default. */
export function rulesFrom(rule: ProjectRule | undefined): WriteRules {
  const fallback = rule?.readOnly !== true;
  const value = (key: WriteRule): boolean => rule?.[key] ?? fallback;
  const manifest = value("manifest");
  return {
    diagrams: value("diagrams"),
    notes: value("notes"),
    comments: value("comments"),
    emphasis: value("emphasis"),
    register: value("register") && manifest,
    manifest,
  };
}

interface PolicyEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly systemConfigPath?: string;
}
const environments: PolicyEnvironment[] = [];

/**
 * Which account configuration the rules come from while a service runs: its environment, or the
 * process environment when none is configured. The most recently configured one that is still in
 * effect wins. Returns a function that ends this one.
 */
export function configureWritePolicy(next: PolicyEnvironment): () => void {
  const entry = { ...next };
  environments.push(entry);
  return () => {
    const at = environments.indexOf(entry);
    if (at >= 0) environments.splice(at, 1);
  };
}

/** The winning `[[projects]]` entry for a project root, read fresh from the account configuration. */
function projectRuleFor(projectRoot: string): ProjectRule | undefined {
  const { env, systemConfigPath } = environments.at(-1) ?? { env: process.env };
  const loaded =
    systemConfigPath === undefined ? loadGlobalConfiguration(env) : loadGlobalConfiguration(env, systemConfigPath);
  const rules = loaded.user.projects ?? loaded.system?.projects;
  return rules === undefined ? undefined : selectProjectRule(projectRoot, rules);
}

/** Where the person's `edit` comes from: the project's archer.toml, the account's, or the built-in default (on). */
export type EditSource = "project" | "account" | "default";

/**
 * Whether the person may create and edit in the page (decided 2026-10-28): the project's archer.toml `edit`,
 * else the account's (user, then system), else on. Read fresh for every write. Agents' writes never ask here.
 * Any admitted browser link may edit where this is on: a link carries no editing rights of its own.
 */
export function browserEditing(project: { readonly root: string; readonly edit?: boolean }): {
  readonly enabled: boolean;
  readonly source: EditSource;
} {
  if (project.edit !== undefined) return { enabled: project.edit, source: "project" };
  const { env, systemConfigPath } = environments.at(-1) ?? { env: process.env };
  const loaded =
    systemConfigPath === undefined ? loadGlobalConfiguration(env) : loadGlobalConfiguration(env, systemConfigPath);
  const account = loaded.user.edit ?? loaded.system?.edit;
  return account === undefined ? { enabled: true, source: "default" } : { enabled: account, source: "account" };
}

/** The rules for a project root, read fresh from the account configuration. */
export function writeRulesFor(projectRoot: string): WriteRules {
  return rulesFrom(projectRuleFor(projectRoot));
}

/**
 * ADR 0013's admission for attach and restore: `admit = false` on the winning entry denies it, and
 * `listed` also needs a winning entry. `read_only` does not touch admission. An unreadable
 * configuration admits nothing. Returns null when admitted, else why not (safe to show).
 */
export function admissionRefusal(
  projectRoot: string,
  admission: "any" | "listed",
): { readonly message: string; readonly detail?: string } | null {
  let rule: ProjectRule | undefined;
  try {
    rule = projectRuleFor(projectRoot);
  } catch (failure) {
    return {
      message: "Archer could not read your Archer settings, so the project was not attached.",
      detail: failure instanceof Error ? failure.message : String(failure),
    };
  }
  if (rule?.admit === false)
    return {
      message:
        "Your Archer settings do not admit this project (`admit = false` on its [[projects]] entry in the global archer.toml).",
    };
  if (admission === "listed" && rule === undefined)
    return {
      message:
        'This Archer service admits only listed projects (`admission = "listed"`); add a [[projects]] entry for it to the global archer.toml.',
    };
  return null;
}

/** Fixed text: the reason itself can name the configuration file (see `detail`). */
export const CONFIG_UNREADABLE = "Archer could not read your Archer settings; nothing was written.";

const MESSAGES: Readonly<Record<WriteRule, string>> = {
  diagrams: "diagram files",
  notes: "notes",
  comments: "comments",
  emphasis: "highlights",
  register: "registering diagrams in archer.toml",
  manifest: "changes to archer.toml",
};

/** A write the account's rules refuse. `phase` says no effect has happened. */
export class WriteRuleDenied extends ProjectError {
  readonly phase = "prepublication";
  /**
   * Why the configuration could not be read: it can name the file and quote it, so it goes only
   * to the service log and the local CLI's stderr, never into a browser or MCP reply.
   */
  readonly detail?: string;
  constructor(
    readonly rule: WriteRule | "config_unreadable",
    message: string,
    detail?: string,
  ) {
    super("write_rule_denied", message);
    if (detail !== undefined) this.detail = detail;
  }
}

/** Throws `WriteRuleDenied` unless every named rule allows the write in this project. */
export function assertWriteAllowed(projectRoot: string, rules: WriteRule | readonly WriteRule[]): void {
  let allowed: WriteRules;
  try {
    allowed = writeRulesFor(projectRoot);
  } catch (failure) {
    const why = failure instanceof Error ? failure.message : String(failure);
    throw new WriteRuleDenied("config_unreadable", CONFIG_UNREADABLE, why);
  }
  for (const rule of typeof rules === "string" ? [rules] : rules)
    if (!allowed[rule])
      throw new WriteRuleDenied(
        rule,
        `Your Archer settings make this project read-only for ${MESSAGES[rule]} ([[projects]] \`${rule}\` in the global archer.toml). Nothing was written.`,
      );
}

/** Whether every named rule allows a write; an unreadable configuration allows nothing. */
export function writesAllowed(projectRoot: string, rules: readonly WriteRule[]): boolean {
  try {
    assertWriteAllowed(projectRoot, rules);
    return true;
  } catch (failure) {
    if (failure instanceof WriteRuleDenied) return false;
    throw failure;
  }
}
