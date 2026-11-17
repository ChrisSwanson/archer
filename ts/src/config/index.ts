import { parseDiscoverySettings, type DiscoverySettings } from "../project/discovery.ts";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, type Stats } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, normalize } from "node:path";
import { ProjectError } from "../project/errors.ts";
import { groupIsPrivate, MAX_MANIFEST_BYTES } from "../project/project.ts";
import {
  misplacedAgentsKeyMessage,
  misplacedKey,
  misplacedKeyMessage,
  parseToml,
  TomlError,
  type TomlTable,
  type TomlValue,
} from "../project/toml.ts";
import { SERVICE_NAME_PATTERN as SERVICE_NAME } from "../service-name.ts";
import { parseFeedbackSettings, type GlobalFeedbackSettings } from "./feedback.ts";
import { DELIVERY_KEYS, deliveryKeyAlsoUnder, parseDeliverySettings, type DeliverySettings } from "./agents.ts";
import { withConfigurationSource } from "./source-revision.ts";
import { PAIRING_MINUTES_MAX, PAIRING_MINUTES_MIN, validPairingMinutes } from "../service/pairing-codes.ts";

export {
  parseFeedbackSettings,
  type FeedbackChanges,
  type FeedbackDelivery,
  type FeedbackSettings,
  type GlobalFeedbackSettings,
} from "./feedback.ts";

export type Admission = "any" | "listed";
export type OpenBrowser = "auto" | "always" | "never";
export type CommentSubmission = "queued" | "immediate";

export interface ServiceConfig {
  readonly name?: string;
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
  /** How long a pairing code lasts, 1–60 whole minutes (ADR 0014, amended 2026-10-22). */
  readonly pairingCodeMinutes?: number;
}

export interface NamedServiceConfig extends ServiceConfig {
  readonly name: string;
}

/** A `[[projects]]` rule; `delivery`, `next_turn_wait`, `launch` and `launch_for` override `[agents]` for that project (ADR 0035, amended 2026-10-31). */
export interface ProjectRule extends DeliverySettings {
  readonly path: string;
  readonly service?: string;
  readonly readOnly?: boolean;
  readonly admit?: boolean;
  readonly diagrams?: boolean;
  readonly notes?: boolean;
  readonly comments?: boolean;
  readonly emphasis?: boolean;
  readonly register?: boolean;
  readonly manifest?: boolean;
  /**
   * `launcher_cwd`: the directory the person's launcher (`[agents] launcher`) runs in for this project,
   * absolute or relative to the project root; it must resolve inside that root (ADR 0035 §8).
   */
  readonly launcherCwd?: string;
}

/**
 * `[agents]`: what the person lets Archer start for them (ADR 0035 §8), and the order a message is offered in
 * (`delivery`, `next_turn_wait`, `launch`, `launch_for`: config/agents.ts). Read from the person's own file only.
 */
export interface AgentsConfig extends DeliverySettings {
  /**
   * `launcher = ["claude", "-p"]`: the command Launch runs, as argv, never through a shell. The message
   * reaches it only in the LAUNCHER_ENV variables (agents/contract.ts).
   */
  readonly launcher?: readonly string[];
}

export interface GlobalConfig {
  readonly discovery?: DiscoverySettings;
  readonly feedback?: GlobalFeedbackSettings;
  readonly version: 1;
  readonly service?: ServiceConfig;
  readonly services?: readonly NamedServiceConfig[];
  readonly projects?: readonly ProjectRule[];
  readonly agents?: AgentsConfig;
  /** `edit`: whether the person may create and edit in the page; a project's own `edit` wins. Absent means on. Agents are never affected. */
  readonly edit?: boolean;
}

export interface ReadGlobalConfigOptions {
  readonly principal: "user" | "system";
  readonly required?: boolean;
}

export interface GlobalConfigSnapshot {
  readonly config: GlobalConfig;
  /** Exact trusted UTF-8 source bytes decoded from the same descriptor that was validated. */
  readonly source: string;
  readonly file: { readonly dev: number; readonly ino: number; readonly mode: number } | null;
}

/** Filesystem seam for deterministic contract tests of races and I/O failures. */
export interface ConfigFileSystem {
  readonly lstatSync: (path: string) => Stats;
  readonly openSync: (path: string, flags: number) => number;
  readonly fstatSync: (fd: number) => Stats;
  readonly readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => number;
  readonly closeSync: (fd: number) => void;
}

export const CONFIG_FILE_SYSTEM: ConfigFileSystem = Object.freeze({
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
});

const SERVICE_KEYS = new Set([
  "name",
  "host",
  "port",
  "admission",
  "public_url",
  "open_browser",
  "auto_start",
  "restore",
  "comment_submission",
  "tls_cert",
  "tls_key",
  "force_http",
  "pairing_code_minutes",
]);
const PROJECT_KEYS = new Set([
  "path",
  "service",
  "read_only",
  "admit",
  "diagrams",
  "notes",
  "comments",
  "emphasis",
  "register",
  "manifest",
  "launcher_cwd",
  ...DELIVERY_KEYS,
]);
const TOP_KEYS = new Set(["version", "service", "services", "projects", "discovery", "feedback", "agents", "edit"]);
const AGENTS_KEYS = new Set(["launcher", ...DELIVERY_KEYS]);
/** The most arguments, and characters in one, a launcher may have. */
export const MAX_LAUNCHER_ARGS = 32,
  MAX_LAUNCHER_ARG_CHARS = 4096;
const EMPTY: GlobalConfig = Object.freeze({ version: 1 });

export function parseGlobalConfig(text: string): GlobalConfig {
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) throw configError(`it is over ${MAX_MANIFEST_BYTES} bytes`);
  let doc: TomlTable;
  try {
    doc = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError) throw configError(error.message);
    throw error;
  }
  // C-30: `edit` after a table header is that table's key; name the line rather than "unknown setting".
  const misplaced = misplacedKey(text, "edit");
  if (misplaced !== null) throw configError(misplacedKeyMessage("edit", misplaced));
  // C-33/X-19: a delivery key belongs in [agents] or a [[projects]] rule; anywhere else, name its line.
  for (const key of DELIVERY_KEYS) {
    const at = misplacedKey(text, key, ["[agents]", "[[projects]]", ...deliveryKeyAlsoUnder(key)]);
    if (at !== null) throw configError(misplacedAgentsKeyMessage(key, at));
  }
  unknownKeys(doc, TOP_KEYS, "top level");
  if (doc["version"] !== 1)
    throw configError(
      doc["version"] === undefined
        ? "it has no `version = 1`"
        : `version ${JSON.stringify(doc["version"])} is not supported; expected 1`,
    );

  const discovery = doc["discovery"] === undefined ? undefined : parseDiscoverySettings(doc["discovery"]);
  const feedback = doc["feedback"] === undefined ? undefined : parseFeedbackSettings(doc["feedback"], "global");
  const rawService = doc["service"];
  const rawServices = doc["services"];
  const rawProjects = doc["projects"];
  const service = rawService === undefined ? undefined : serviceConfig(table(rawService, "service"), false);
  if (rawServices !== undefined && !isTableList(rawServices))
    throw configError("`services` must be a list of [[services]] tables");
  const services =
    rawServices === undefined
      ? undefined
      : rawServices.map((entry) => serviceConfig(entry, true) as NamedServiceConfig);
  const names = new Set<string>();
  for (const entry of services ?? []) {
    if (names.has(entry.name))
      throw configError(`named service ${JSON.stringify(entry.name)} is defined more than once`);
    names.add(entry.name);
  }
  if (rawProjects !== undefined && !isTableList(rawProjects))
    throw configError("`projects` must be a list of [[projects]] tables");
  const projects = rawProjects === undefined ? undefined : rawProjects.map(projectRule);
  const agents = doc["agents"] === undefined ? undefined : agentsConfig(table(doc["agents"], "agents"));
  // Automatic launch needs both the person's launcher and their `launch = "auto"` (ADR 0035, amended 2026-10-31).
  if (agents?.launcher === undefined && (agents?.launch === "auto" || projects?.some((rule) => rule.launch === "auto")))
    throw configError('launch = "auto" needs a launcher: add `launcher = ["claude", "-p"]` (your command) to [agents]');
  const edit = doc["edit"];
  if (edit !== undefined && typeof edit !== "boolean")
    throw configError(
      "`edit` must be true or false (false turns creating and editing in the page off; agents can still write)",
    );
  return withConfigurationSource(
    {
      version: 1,
      ...(discovery === undefined ? {} : { discovery }),
      ...(feedback === undefined ? {} : { feedback }),
      ...(service === undefined ? {} : { service }),
      ...(services === undefined ? {} : { services }),
      ...(projects === undefined ? {} : { projects }),
      ...(agents === undefined ? {} : { agents }),
      ...(edit === undefined ? {} : { edit }),
    },
    text,
  );
}

export function readGlobalConfig(path: string, options: ReadGlobalConfigOptions): GlobalConfig {
  return readGlobalConfigSnapshotWithFileSystem(path, options, CONFIG_FILE_SYSTEM).config;
}

export function readGlobalConfigSnapshot(path: string, options: ReadGlobalConfigOptions): GlobalConfigSnapshot {
  return readGlobalConfigSnapshotWithFileSystem(path, options, CONFIG_FILE_SYSTEM);
}

/** @internal Shared production path used to exercise filesystem failure contracts. */
export function readGlobalConfigWithFileSystem(
  path: string,
  options: ReadGlobalConfigOptions,
  fileSystem: ConfigFileSystem,
): GlobalConfig {
  return readGlobalConfigSnapshotWithFileSystem(path, options, fileSystem).config;
}

/** @internal Same-descriptor trusted source/config snapshot seam for settings CAS tests. */
export function readGlobalConfigSnapshotWithFileSystem(
  path: string,
  options: ReadGlobalConfigOptions,
  fileSystem: ConfigFileSystem,
): GlobalConfigSnapshot {
  let before;
  try {
    before = fileSystem.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.required !== true)
      return { config: EMPTY, source: "", file: null };
    throw configError(`${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
  }
  if (!before.isFile() || before.isSymbolicLink() || !trusted(before.uid, before.gid, before.mode, options.principal))
    throw untrusted(path, options.principal);
  let fd: number;
  try {
    fd = fileSystem.openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw untrusted(path, options.principal);
    throw configError(`${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
  }
  let bodyFailed = false;
  try {
    const after = fileSystem.fstatSync(fd);
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      !trusted(after.uid, after.gid, after.mode, options.principal)
    )
      throw untrusted(path, options.principal);
    // One name only (X-18), as the project manifest: a hard link is another name for a file elsewhere.
    if (after.nlink !== 1) throw hardLinked(path, after.nlink);
    if (after.size > MAX_MANIFEST_BYTES) throw configError(`${path} is over ${MAX_MANIFEST_BYTES} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_MANIFEST_BYTES + 1 - total));
      const count = fileSystem.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
      if (total > MAX_MANIFEST_BYTES) throw configError(`${path} is over ${MAX_MANIFEST_BYTES} bytes`);
    }
    const source = Buffer.concat(chunks, total);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      throw configError(`${path} is not UTF-8`);
    }
    return {
      config: withConfigurationSource(parseGlobalConfig(text), source),
      source: text,
      file: { dev: after.dev, ino: after.ino, mode: after.mode },
    };
  } catch (error) {
    bodyFailed = true;
    if (error instanceof ProjectError) throw error;
    throw configError(`${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
  } finally {
    try {
      fileSystem.closeSync(fd);
    } catch (error) {
      if (!bodyFailed)
        // biome-ignore lint/correctness/noUnsafeFinally: guarded by bodyFailed, so it never replaces the body's own error; a close failure after a good read is reported.
        throw configError(`${path} cannot be closed (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
    }
  }
}

function serviceConfig(doc: TomlTable, requireName: boolean): ServiceConfig {
  unknownKeys(doc, SERVICE_KEYS, requireName ? "[[services]]" : "[service]");
  const name = optionalString(doc, "name");
  if (requireName && name === undefined) throw configError("each [[services]] table requires `name`");
  if (name !== undefined && !SERVICE_NAME.test(name))
    throw configError(`service name ${JSON.stringify(name)} must match ^[a-z0-9][a-z0-9-]{0,31}$`);
  const host = optionalString(doc, "host");
  if (host !== undefined && !validHost(host))
    throw configError(`service host ${JSON.stringify(host)} is not an IP address or DNS hostname`);
  const port = doc["port"];
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535))
    throw configError("service `port` must be a whole number from 1024 through 65535");
  const admission = optionalString(doc, "admission");
  if (admission !== undefined && admission !== "any" && admission !== "listed")
    throw configError('service `admission` must be "any" or "listed"');
  const openBrowser = optionalString(doc, "open_browser");
  if (openBrowser !== undefined && openBrowser !== "auto" && openBrowser !== "always" && openBrowser !== "never")
    throw configError('service `open_browser` must be "auto", "always" or "never"');
  const tlsCert = optionalString(doc, "tls_cert"),
    tlsKey = optionalString(doc, "tls_key"),
    forceHttp = optionalBoolean(doc, "force_http");
  for (const path of [tlsCert, tlsKey])
    if (path !== undefined && (!isAbsolute(path) || path.length > 4096 || path.includes("\0")))
      throw configError("TLS certificate/key paths must be absolute and bounded");
  const publicUrlRaw = optionalString(doc, "public_url");
  const publicUrl = publicUrlRaw === undefined ? undefined : normalizedPublicUrl(publicUrlRaw);
  const autoStart = optionalBoolean(doc, "auto_start");
  const restore = optionalBoolean(doc, "restore");
  const commentSubmission = optionalString(doc, "comment_submission");
  if (commentSubmission !== undefined && commentSubmission !== "queued" && commentSubmission !== "immediate")
    throw configError('service `comment_submission` must be "queued" or "immediate"');
  const pairingCodeMinutes = doc["pairing_code_minutes"];
  if (pairingCodeMinutes !== undefined && !validPairingMinutes(pairingCodeMinutes))
    throw configError(
      `service \`pairing_code_minutes\` must be a whole number from ${PAIRING_MINUTES_MIN} through ${PAIRING_MINUTES_MAX}`,
    );
  return {
    ...(name === undefined ? {} : { name }),
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(tlsCert === undefined ? {} : { tlsCert }),
    ...(tlsKey === undefined ? {} : { tlsKey }),
    ...(forceHttp === undefined ? {} : { forceHttp }),
    ...(admission === undefined ? {} : { admission }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(openBrowser === undefined ? {} : { openBrowser }),
    ...(autoStart === undefined ? {} : { autoStart }),
    ...(restore === undefined ? {} : { restore }),
    ...(commentSubmission === undefined ? {} : { commentSubmission }),
    ...(pairingCodeMinutes === undefined ? {} : { pairingCodeMinutes }),
  } as ServiceConfig;
}

function agentsConfig(doc: TomlTable): AgentsConfig {
  unknownKeys(doc, AGENTS_KEYS, "[agents]");
  const launcher = doc["launcher"];
  const delivery = parseDeliverySettings(doc, "[agents]", configError);
  if (launcher === undefined) return delivery;
  if (
    !Array.isArray(launcher) ||
    launcher.length === 0 ||
    launcher.length > MAX_LAUNCHER_ARGS ||
    !launcher.every((arg) => typeof arg === "string" && arg.length <= MAX_LAUNCHER_ARG_CHARS && !arg.includes("\0")) ||
    launcher[0] === ""
  )
    throw configError(
      `[agents] \`launcher\` must be a list of 1 to ${MAX_LAUNCHER_ARGS} quoted strings, the command first, such as ["claude", "-p"]`,
    );
  return { launcher: launcher as string[], ...delivery };
}

function projectRule(doc: TomlTable): ProjectRule {
  unknownKeys(doc, PROJECT_KEYS, "[[projects]]");
  const path = requiredString(doc, "path", "each [[projects]] table requires an absolute `path`");
  if (!isAbsolute(path) || normalize(path) !== path || /[\0-\x1f\x7f]/.test(path))
    throw configError(
      `project path ${JSON.stringify(path)} must be a canonical absolute path for this operating system`,
    );
  const service = optionalString(doc, "service");
  if (service !== undefined && !SERVICE_NAME.test(service))
    throw configError(`project service ${JSON.stringify(service)} must match ^[a-z0-9][a-z0-9-]{0,31}$`);
  const launcherCwd = optionalString(doc, "launcher_cwd");
  if (
    launcherCwd !== undefined &&
    (launcherCwd === "" || launcherCwd.length > 4096 || /[\0-\x1f\x7f]/.test(launcherCwd))
  )
    throw configError(
      "project `launcher_cwd` must be a directory path of at most 4096 characters, without control characters",
    );
  const delivery = parseDeliverySettings(doc, "[[projects]]", configError);
  const booleans = Object.fromEntries(
    ["read_only", "admit", "diagrams", "notes", "comments", "emphasis", "register", "manifest"]
      .map((key) => [key, optionalBoolean(doc, key)])
      .filter((entry) => entry[1] !== undefined),
  );
  return {
    path,
    ...(service === undefined ? {} : { service }),
    ...(booleans["read_only"] === undefined ? {} : { readOnly: booleans["read_only"] }),
    ...(booleans["admit"] === undefined ? {} : { admit: booleans["admit"] }),
    ...(booleans["diagrams"] === undefined ? {} : { diagrams: booleans["diagrams"] }),
    ...(booleans["notes"] === undefined ? {} : { notes: booleans["notes"] }),
    ...(booleans["comments"] === undefined ? {} : { comments: booleans["comments"] }),
    ...(booleans["emphasis"] === undefined ? {} : { emphasis: booleans["emphasis"] }),
    ...(booleans["register"] === undefined ? {} : { register: booleans["register"] }),
    ...(booleans["manifest"] === undefined ? {} : { manifest: booleans["manifest"] }),
    ...(launcherCwd === undefined ? {} : { launcherCwd }),
    ...delivery,
  } as ProjectRule;
}

function normalizedPublicUrl(value: string): string {
  if (!/^https?:\/\//i.test(value))
    throw configError(
      `service public_url ${JSON.stringify(value)} is not an absolute HTTP(S) origin with :// authority syntax`,
    );
  const authorityStart = value.indexOf("://") + 3;
  const afterAuthorityStart = value.slice(authorityStart);
  const authorityLength = afterAuthorityStart.search(/[/?#]/u);
  const authority = authorityLength < 0 ? afterAuthorityStart : afterAuthorityStart.slice(0, authorityLength);
  if (authority.includes("@"))
    throw configError(`service public_url ${JSON.stringify(value)} must have no credentials`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError(`service public_url ${JSON.stringify(value)} is not an absolute HTTP(S) origin`);
  }
  const slash = value.indexOf("/", authorityStart);
  const rawPath = slash < 0 ? "" : value.slice(slash);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    (rawPath !== "" && rawPath !== "/") ||
    value.includes("?") ||
    value.includes("#")
  )
    throw configError(
      `service public_url ${JSON.stringify(value)} must be an HTTP(S) origin with no credentials, path, query or fragment`,
    );
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

function validHost(value: string): boolean {
  if (isIP(value) !== 0) return true;
  if (value.length === 0 || value.length > 253 || /[^A-Za-z0-9.-]/.test(value)) return false;
  const labels = value.endsWith(".") ? value.slice(0, -1).split(".") : value.split(".");
  return labels.every(
    (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
  );
}

function unknownKeys(doc: TomlTable, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(doc))
    if (!allowed.has(key)) throw configError(`unknown ${where} setting ${JSON.stringify(key)}`);
}
function table(value: TomlValue, name: string): TomlTable {
  if (typeof value !== "object" || Array.isArray(value)) throw configError(`\`${name}\` must be one [${name}] table`);
  return value;
}
function isTableList(value: TomlValue): value is TomlTable[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "object" && !Array.isArray(entry));
}
function optionalString(doc: TomlTable, key: string): string | undefined {
  const value = doc[key];
  if (value !== undefined && typeof value !== "string") throw configError(`\`${key}\` must be a quoted string`);
  return value as string | undefined;
}
function requiredString(doc: TomlTable, key: string, message: string): string {
  const value = optionalString(doc, key);
  if (value === undefined || value === "") throw configError(message);
  return value;
}
function optionalBoolean(doc: TomlTable, key: string): boolean | undefined {
  const value = doc[key];
  if (value !== undefined && typeof value !== "boolean") throw configError(`\`${key}\` must be true or false`);
  return value as boolean | undefined;
}
function trusted(uid: number, gid: number, mode: number, principal: "user" | "system"): boolean {
  const current = process.getuid?.();
  if (current === undefined) return false;
  if (uid !== (principal === "system" ? 0 : current) || (mode & 0o002) !== 0) return false;
  if ((mode & 0o020) === 0) return true;
  if (principal === "system") return false;
  try {
    return groupIsPrivate(current, gid, readFileSync("/etc/passwd", "utf8"), readFileSync("/etc/group", "utf8"));
  } catch {
    return false;
  }
}
const hardLinked = (path: string, names: number) =>
  new ProjectError(
    "untrusted_manifest",
    `${path} has ${names} names (a hard link); Archer reads its settings only from a file with one name: make it a plain copy: cp ${path} ${path}.copy && mv ${path}.copy ${path}`,
  );
const configError = (why: string) => new ProjectError("manifest_error", `global archer.toml cannot be used: ${why}`);
const untrusted = (path: string, principal: "user" | "system") =>
  new ProjectError(
    "untrusted_manifest",
    `${path} is not a regular ${principal === "system" ? "root-owned" : "current-user-owned"} file or is writable by other users; make it a plain trusted file and remove group/other write access`,
  );
