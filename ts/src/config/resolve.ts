import { dirname, isAbsolute, join, normalize } from "node:path";
import { isIP } from "node:net";
import { ProjectError } from "../project/errors.ts";
import { serviceDirs } from "../service/paths.ts";
import type { Admission, CommentSubmission, GlobalConfig, OpenBrowser, ProjectRule, ServiceConfig } from "./index.ts";
import { SERVICE_NAME_PATTERN as SERVICE_NAME } from "../service-name.ts";
import { PAIRING_MINUTES_DEFAULT } from "../service/pairing-codes.ts";

export type SettingSource = "flag" | "env" | "user" | "system" | "builtin";
export type ServiceNameSource = SettingSource | "user-project" | "system-project" | "project";

export interface ServiceFlags {
  readonly serviceName?: string;
  readonly host?: string;
  readonly port?: number;
  readonly admission?: Admission;
  readonly publicUrl?: string;
  readonly tlsCert?: string;
  readonly tlsKey?: string;
  readonly forceHttp?: boolean;
  readonly openBrowser?: OpenBrowser;
  readonly autoStart?: boolean;
  readonly restore?: boolean;
  readonly commentSubmission?: CommentSubmission;
}

export interface ResolveServiceConfigurationInput {
  readonly projectRoot: string;
  readonly projectServiceName?: string;
  readonly system?: GlobalConfig;
  readonly user?: GlobalConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly flags?: ServiceFlags;
}

export interface ResolvedServiceSettings {
  readonly host: string;
  readonly port?: number;
  readonly admission: Admission;
  readonly publicUrl?: string;
  readonly tlsCert?: string;
  readonly tlsKey?: string;
  readonly forceHttp?: boolean;
  readonly openBrowser: OpenBrowser;
  readonly autoStart: boolean;
  readonly restore: boolean;
  readonly commentSubmission: CommentSubmission;
  readonly pairingCodeMinutes: number;
}

export interface ResolvedServiceConfiguration {
  readonly serviceName: string;
  readonly serviceNameSource: ServiceNameSource;
  readonly settings: ResolvedServiceSettings;
  readonly settingSources: Readonly<Record<keyof ResolvedServiceSettings, SettingSource>>;
  readonly dirs: { readonly stateDir: string; readonly socketDir: string; readonly socketPath: string };
  readonly dirSources: { readonly stateDir: "env" | "builtin"; readonly socketPath: "env" | "builtin" };
  readonly projectRule?: ProjectRule;
  readonly projectRuleSource?: "user" | "system";
}

const MAX_MATCH_BYTES = 4096;
const MAX_MATCH_WORK = 64_000_000;
const SETTING_KEYS = [
  "host",
  "port",
  "admission",
  "publicUrl",
  "openBrowser",
  "autoStart",
  "restore",
  "commentSubmission",
  "tlsCert",
  "tlsKey",
  "forceHttp",
  "pairingCodeMinutes",
] as const;

export function projectPatternMatches(pattern: string, canonicalPath: string): boolean {
  validateCanonicalPath(pattern, "project pattern");
  validateCanonicalPath(canonicalPath, "project root");
  if (!pattern.includes("*")) return pattern === canonicalPath;
  if (pattern.endsWith("/**") && canonicalPath === pattern.slice(0, -3)) return true;
  const patternPoints = [...pattern];
  let states = epsilonClosure(patternPoints, new Set([0]));
  for (const character of [...canonicalPath]) {
    const next = new Set<number>();
    for (const at of states) {
      if (at >= patternPoints.length) continue;
      if (patternPoints[at] === "*" && (patternPoints[at + 1] === "*" || character !== "/")) next.add(at);
      else if (patternPoints[at] === character) next.add(at + 1);
    }
    states = epsilonClosure(patternPoints, next);
    if (states.size === 0) return false;
  }
  return epsilonClosure(patternPoints, states).has(patternPoints.length);
}

export function selectProjectRule(projectRoot: string, rules: readonly ProjectRule[]): ProjectRule | undefined {
  validateCanonicalPath(projectRoot, "project root");
  let exact: ProjectRule | undefined;
  for (const rule of rules) {
    validateCanonicalPath(rule.path, "project pattern");
    if (!rule.path.includes("*") && rule.path === projectRoot) exact = rule;
  }
  if (exact !== undefined) return exact;
  let work = 0;
  let winner: ProjectRule | undefined;
  let specificity = -1;
  for (const rule of rules) {
    if (!rule.path.includes("*")) continue;
    work += (rule.path.length + 1) * (projectRoot.length + 1);
    if (work > MAX_MATCH_WORK) throw configError(`project rule matching exceeds the ${MAX_MATCH_WORK} cell work limit`);
    if (!projectPatternMatches(rule.path, projectRoot)) continue;
    const literal = [...rule.path].filter((character) => character !== "*").length;
    if (literal >= specificity) {
      winner = rule;
      specificity = literal;
    }
  }
  return winner;
}

export function resolveServiceConfiguration(input: ResolveServiceConfigurationInput): ResolvedServiceConfiguration {
  validateCanonicalPath(input.projectRoot, "project root");
  const env = input.env ?? process.env;
  const flags = input.flags ?? {};
  if (flags.serviceName !== undefined) validateName(flags.serviceName, "service name");
  const environmentService = emptyUnset(env["ARCHER_SERVICE"]);
  if (environmentService !== undefined) validateName(environmentService, "ARCHER_SERVICE");
  const activeRules = input.user?.projects !== undefined ? input.user.projects : input.system?.projects;
  const projectRule = activeRules === undefined ? undefined : selectProjectRule(input.projectRoot, activeRules);
  const projectRuleSource =
    projectRule === undefined ? undefined : input.user?.projects !== undefined ? "user" : "system";
  const candidates: readonly [string | undefined, ServiceNameSource][] = [
    [flags.serviceName, "flag"],
    [environmentService, "env"],
    [projectRule?.service, projectRuleSource === "user" ? "user-project" : "system-project"],
    [input.projectServiceName, "project"],
    [input.user?.service?.name, "user"],
    [input.system?.service?.name, "system"],
    ["default", "builtin"],
  ];
  const selected = candidates.find(([name]) => name !== undefined) as [string, ServiceNameSource];
  validateName(selected[0], selected[1] === "env" ? "ARCHER_SERVICE" : "service name");

  const settings: Record<string, unknown> = {
    host: "127.0.0.1",
    admission: "any",
    openBrowser: "auto",
    autoStart: true,
    restore: true,
    commentSubmission: "immediate",
    forceHttp: false,
    pairingCodeMinutes: PAIRING_MINUTES_DEFAULT,
  };
  const settingSources = Object.fromEntries(SETTING_KEYS.map((key) => [key, "builtin"])) as Record<
    keyof ResolvedServiceSettings,
    SettingSource
  >;
  overlayLayer(settings, settingSources, selected[0], input.system, "system");
  overlayLayer(settings, settingSources, selected[0], input.user, "user");
  overlayEnvironment(settings, settingSources, env);
  overlayFlags(settings, settingSources, flags);

  const cleanEnv = { ...env, ARCHER_STATE_DIR: undefined, ARCHER_SOCKET: undefined };
  const legacyBase = serviceDirs(cleanEnv);
  const stateOverride = absolute(env["ARCHER_STATE_DIR"]);
  const socketOverride = absolute(env["ARCHER_SOCKET"]);
  const builtInState =
    selected[0] === "default" ? legacyBase.stateDir : join(legacyBase.stateDir, "services", selected[0]);
  const stateDir = stateOverride ?? builtInState;
  const socketPath = socketOverride ?? join(stateDir, "archer.sock");
  const resultSettings = settings as unknown as ResolvedServiceSettings;
  return {
    serviceName: selected[0],
    serviceNameSource: selected[1],
    settings: resultSettings,
    settingSources,
    dirs: { stateDir, socketDir: dirname(socketPath), socketPath },
    dirSources: {
      stateDir: stateOverride === undefined ? "builtin" : "env",
      socketPath: socketOverride !== undefined || stateOverride !== undefined ? "env" : "builtin",
    },
    ...(projectRule === undefined ? {} : { projectRule, projectRuleSource: projectRuleSource as "user" | "system" }),
  };
}

function epsilonClosure(pattern: readonly string[], initial: Set<number>): Set<number> {
  const closure = new Set(initial);
  const pending = [...initial];
  while (pending.length > 0) {
    const at = pending.pop() as number;
    if (pattern[at] !== "*") continue;
    const double = pattern[at + 1] === "*";
    const after = at + (double ? 2 : 1);
    if (!closure.has(after)) {
      closure.add(after);
      pending.push(after);
    }
    const afterWholeSegment =
      double && pattern[after] === "/" && (at === 0 || pattern[at - 1] === "/") ? after + 1 : -1;
    if (afterWholeSegment >= 0 && !closure.has(afterWholeSegment)) {
      closure.add(afterWholeSegment);
      pending.push(afterWholeSegment);
    }
  }
  return closure;
}

function overlayLayer(
  settings: Record<string, unknown>,
  sources: Record<string, SettingSource>,
  identity: string,
  config: GlobalConfig | undefined,
  source: "user" | "system",
): void {
  if (config === undefined) return;
  overlay(settings, sources, serviceSettingsForIdentity(config, identity), source);
}
/** Per-field service-table overlay shared by runtime resolution and editable instance settings. */
export function serviceSettingsForIdentity(config: GlobalConfig, identity: string): ServiceConfig {
  const settings: Record<string, unknown> = {};
  const ignored: Record<string, SettingSource> = {};
  if (identity === "default" && config.service !== undefined) overlay(settings, ignored, config.service, "user");
  const named = config.services?.find((entry) => entry.name === identity);
  if (named !== undefined) overlay(settings, ignored, named, "user");
  return settings as ServiceConfig;
}
function overlay(
  settings: Record<string, unknown>,
  sources: Record<string, SettingSource>,
  value: ServiceConfig,
  source: SettingSource,
): void {
  for (const key of SETTING_KEYS)
    if (value[key] !== undefined) {
      settings[key] = value[key];
      sources[key] = source;
    }
}
function overlayEnvironment(
  settings: Record<string, unknown>,
  sources: Record<string, SettingSource>,
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const [key, name] of [
    ["tlsCert", "ARCHER_TLS_CERT"],
    ["tlsKey", "ARCHER_TLS_KEY"],
  ] as const) {
    const value = emptyUnset(env[name]);
    if (value !== undefined) set(settings, sources, key, validTlsPath(value, name), "env");
  }
  if (env["ARCHER_FORCE_HTTP"] !== undefined)
    set(settings, sources, "forceHttp", validBoolean(env["ARCHER_FORCE_HTTP"], "ARCHER_FORCE_HTTP", false), "env");
  const host = emptyUnset(env["ARCHER_HOST"]);
  if (host !== undefined) set(settings, sources, "host", validHost(host, "ARCHER_HOST"), "env");
  const port = emptyUnset(env["ARCHER_PORT"]);
  if (port !== undefined) set(settings, sources, "port", validPort(port, "ARCHER_PORT"), "env");
  const admission = emptyUnset(env["ARCHER_ADMISSION"]);
  if (admission !== undefined)
    set(settings, sources, "admission", validAdmission(admission, "ARCHER_ADMISSION"), "env");
  const publicUrl = emptyUnset(env["ARCHER_PUBLIC_URL"]);
  if (publicUrl !== undefined)
    set(settings, sources, "publicUrl", validPublicUrl(publicUrl, "ARCHER_PUBLIC_URL"), "env");
  const browser = env["ARCHER_OPEN_BROWSER"];
  if (browser !== undefined) set(settings, sources, "openBrowser", validBrowser(browser, "ARCHER_OPEN_BROWSER"), "env");
  const autoStart = env["ARCHER_AUTO_START"];
  if (autoStart !== undefined)
    set(settings, sources, "autoStart", validBoolean(autoStart, "ARCHER_AUTO_START", true), "env");
  const restore = env["ARCHER_RESTORE_STATE"];
  if (restore !== undefined)
    set(settings, sources, "restore", validBoolean(restore, "ARCHER_RESTORE_STATE", false), "env");
}
function overlayFlags(
  settings: Record<string, unknown>,
  sources: Record<string, SettingSource>,
  flags: ServiceFlags,
): void {
  for (const key of ["tlsCert", "tlsKey"] as const)
    if (flags[key] !== undefined) set(settings, sources, key, validTlsPath(flags[key], key), "flag");
  if (flags.forceHttp !== undefined) {
    if (typeof flags.forceHttp !== "boolean") throw configError("force_http must be boolean");
    set(settings, sources, "forceHttp", flags.forceHttp, "flag");
  }
  if (flags.host !== undefined) set(settings, sources, "host", validHost(flags.host, "--host"), "flag");
  if (flags.port !== undefined) set(settings, sources, "port", validPort(flags.port, "--port"), "flag");
  if (flags.admission !== undefined)
    set(settings, sources, "admission", validAdmission(flags.admission, "--admission"), "flag");
  if (flags.publicUrl !== undefined)
    set(settings, sources, "publicUrl", validPublicUrl(flags.publicUrl, "--public-url"), "flag");
  if (flags.openBrowser !== undefined)
    set(settings, sources, "openBrowser", validBrowser(flags.openBrowser, "--open-browser"), "flag");
  if (flags.autoStart !== undefined) {
    if (typeof flags.autoStart !== "boolean") throw configError("--auto-start must be boolean");
    set(settings, sources, "autoStart", flags.autoStart, "flag");
  }
  if (flags.restore !== undefined) {
    if (typeof flags.restore !== "boolean") throw configError("--restore must be boolean");
    set(settings, sources, "restore", flags.restore, "flag");
  }
}
function set(
  settings: Record<string, unknown>,
  sources: Record<string, SettingSource>,
  key: string,
  value: unknown,
  source: SettingSource,
): void {
  settings[key] = value;
  sources[key] = source;
}

function validHost(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253)
    throw configError(`${label} must be an IP address or DNS hostname`);
  if (isIP(value) !== 0) return value;
  const labels = value.endsWith(".") ? value.slice(0, -1).split(".") : value.split(".");
  if (
    !labels.every(
      (part) => part.length > 0 && part.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part),
    )
  )
    throw configError(`${label} must be an IP address or DNS hostname`);
  return value;
}
function validPort(value: unknown, label: string): number {
  const port = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw configError(`${label} must be a whole number from 1024 through 65535`);
  return port;
}
function validAdmission(value: unknown, label: string): Admission {
  if (value !== "any" && value !== "listed") throw configError(`${label} must be any or listed`);
  return value;
}
function validBrowser(value: unknown, label: string): OpenBrowser {
  if (value !== "auto" && value !== "always" && value !== "never")
    throw configError(`${label} must be auto, always or never`);
  return value;
}
function validBoolean(value: string, label: string, numeric: boolean): boolean {
  if (value === "true" || (numeric && value === "1")) return true;
  if (value === "false" || (numeric && value === "0")) return false;
  throw configError(`${label} must be ${numeric ? "true, false, 1 or 0" : "true or false"}`);
}
function validPublicUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || value.includes("?") || value.includes("#"))
    throw configError(`${label} must be an absolute HTTP(S) root origin`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError(`${label} must be an absolute HTTP(S) root origin`);
  }
  const afterScheme = value.slice(value.indexOf("://") + 3);
  const slash = afterScheme.indexOf("/");
  const authority = slash < 0 ? afterScheme : afterScheme.slice(0, slash);
  const rawPath = slash < 0 ? "" : afterScheme.slice(slash);
  if (
    url.username ||
    url.password ||
    authority.includes("@") ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (rawPath !== "" && rawPath !== "/")
  )
    throw configError(`${label} must be an absolute HTTP(S) root origin without credentials`);
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}
function validateName(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SERVICE_NAME.test(value))
    throw configError(`${label} must match ^[a-z0-9][a-z0-9-]{0,31}$`);
}
function emptyUnset(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}
function absolute(value: string | undefined): string | undefined {
  return value !== undefined && isAbsolute(value) ? value : undefined;
}
function validateCanonicalPath(value: string, label: string): void {
  validateMatchString(value, label);
  if (!isAbsolute(value) || normalize(value) !== value || /[\0-\x1f\x7f]/.test(value))
    throw configError(`${label} must be a canonical absolute path`);
}
function validateMatchString(value: string, label: string): void {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_MATCH_BYTES)
    throw configError(`${label} must be at most ${MAX_MATCH_BYTES} UTF-8 bytes`);
}
const configError = (why: string) => new ProjectError("manifest_error", `service configuration cannot be used: ${why}`);

function validTlsPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value)
  )
    throw configError(`${label} requires an absolute bounded path`);
  return value;
}
