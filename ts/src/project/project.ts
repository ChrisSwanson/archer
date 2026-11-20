// A project: the directory holding archer.toml (or, without one, the
// directory Archer was started in), and its Archer folder, where every diagram
// and note lives (ticket 09). Archer reads and writes nothing outside that
// folder except archer.toml itself and the pointer `archer init` adds to the
// agents' instructions.
import { parseDiscoverySettings, type DiscoverySettings } from "./discovery.ts";
import { assertWriteAllowed, type WriteRule } from "../config/write-policy.ts";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DIAGRAM_KINDS, isStableId, type DiagramKind } from "../model/index.ts";
import { ProjectError } from "./errors.ts";
import { groupIsPrivate } from "./ownership.ts";
export { groupIsPrivate };
import {
  misplacedAgentsKeyMessage,
  misplacedKey,
  misplacedKeyMessage,
  parseToml,
  TomlError,
  type TomlTable,
  type TomlValue,
} from "./toml.ts";
import { coveragePatterns } from "../accuracy/coverage.ts";
import { SERVICE_NAME_PATTERN as SERVICE_NAME } from "../service-name.ts";
import { MAX_DESCRIPTION_CHARS } from "./describe.ts";
import { parseFeedbackSettings, type FeedbackSettings } from "../config/feedback.ts";
import {
  DELIVERY_KEYS,
  deliveryKeyAlsoUnder,
  parseProjectAgents,
  type ProjectAgentsSettings,
} from "../config/agents.ts";
import {
  configurationSourceRevision,
  withConfigurationRevision,
  withConfigurationSource,
} from "../config/source-revision.ts";
import {
  ConfinedRefusal,
  ConfinedTooLarge,
  ConfinedWriteRefusedError,
  ConfinedWriteUncertainError,
  publishConfined,
  readConfined,
  readConfinedFile,
  removeConfined,
  writeAllSync,
} from "./confined-fs.ts";

export const MANIFEST = "archer.toml";
export const DEFAULT_FOLDER = ".archer";
/** archer.toml's bounds. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_TITLE_CHARS = 200;
export const MAX_VIEWS = 256;

/** A `[[views]]` entry of archer.toml that loaded. */
export interface View {
  readonly id: string;
  readonly kind: DiagramKind;
  readonly title: string;
  /** Relative to the Archer folder, `/`-separated. */
  readonly source: string;
  /** Project-relative code paths/globs; presentation accuracy metadata, not semantic wire metadata. */
  readonly covers?: readonly string[];
}

/** A `[[views]]` entry that did not load, and why. */
export interface ManifestProblem {
  /** Which entry, counting from one in file order. */
  readonly position: number;
  /** The entry's `id` as written, when it is a string. */
  readonly id: string | null;
  readonly message: string;
}

export interface Project {
  /** The project directory, as a real path. */
  readonly root: string;
  /** archer.toml, or null when the project runs on the defaults. */
  readonly manifest: string | null;
  /** The Archer folder, absolute. It need not exist yet. */
  readonly folder: string;
  /** The folder as archer.toml names it (or the default), `/`-separated. */
  readonly folderSetting: string;
  readonly views: readonly View[];
  readonly problems: readonly ManifestProblem[];
  /** The project's name, from archer.toml's `name`, when it gives one. */
  readonly name?: string;
  /** Optional plain-text project summary from archer.toml. */
  readonly description?: string;
  /** The service identity selected by `[service] name`, when the project chooses one. */
  readonly serviceName?: string;
  readonly discovery?: DiscoverySettings;
  readonly feedback?: FeedbackSettings;
  /** archer.toml's `edit` (ADR 0028): `false` turns page editing off; absent means on. */
  readonly edit?: boolean;
  /** archer.toml's `nested_view` (ADR 0029): `false` draws every diagram as written; absent means on. Presentation only. */
  readonly nestedView?: boolean;
  /** archer.toml's `mode` (ADR 0033): `"docs"` keeps a capped doc pack behind `index.md`; absent is today's behaviour. */
  readonly mode?: "docs";
  /** archer.toml's `[agents]` (ADR 0035, amended 2026-10-31): only narrows the person's delivery settings. */
  readonly agents?: ProjectAgentsSettings;
}

const DIAGRAM_KIND_SET = new Set<string>(DIAGRAM_KINDS);

/**
 * The project `start` belongs to: the nearest directory at or above it with
 * an archer.toml, or, without one, the repository `start` is in (or the
 * project whose default Archer folder it is in, or `start` itself), on the
 * defaults.
 *
 * archer.toml decides which folder Archer reads and writes, so the search
 * keeps to directories the user controls: it stops at the repository root (a
 * directory holding `.git`) and at the home directory, and does not enter a
 * directory owned by someone else or writable by others. An archer.toml found
 * that is owned by someone else, or writable by others, is refused.
 */
export function findProject(start: string): Project {
  let from: string;
  try {
    from = realpathSync(resolve(start));
  } catch (error) {
    throw new ProjectError(
      "io_error",
      `cannot open ${start}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
    );
  }
  const home = realHome();
  let repository: string | null = null;
  let insideFolder: string | null = null;
  for (let dir = from; ; dir = dirname(dir)) {
    if (dir !== from && !trusted(dir)) break;
    const manifest = join(dir, MANIFEST);
    if (existsSync(manifest) && statSync(manifest).isFile()) {
      requireTrustedManifest(manifest);
      return loadProject(dir, manifest);
    }
    // Started inside a default Archer folder: the project is the folder's parent.
    if (insideFolder === null && basename(dir) === DEFAULT_FOLDER) insideFolder = dirname(dir);
    if (existsSync(join(dir, ".git"))) {
      repository = dir;
      break;
    }
    if (dir === home || dirname(dir) === dir) break;
  }
  return withFolder(repository ?? insideFolder ?? from, null, DEFAULT_FOLDER, [], []);
}

function realHome(): string | null {
  try {
    return realpathSync(homedir());
  } catch {
    return null;
  }
}

/**
 * Whether only the current user can change what is at `path`: it is theirs,
 * nobody else may write to it, and its group may write only when that group
 * is private to the user (a user-private group, as on umask 002 systems,
 * where every file is group-writable). True where there are no user ids
 * (Windows).
 */
function trusted(path: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return false;
  }
  if (stats.uid !== uid || (stats.mode & 0o002) !== 0) return false;
  if ((stats.mode & 0o020) === 0) return true;
  // Group-writable: only when nobody else is in that group. Accounts that are
  // not in the local files (LDAP and the like) cannot be checked, so a group
  // is private only when both files can be read and show no one else.
  try {
    return groupIsPrivate(uid, stats.gid, readFileSync("/etc/passwd", "utf8"), readFileSync("/etc/group", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Whether an lstat/fstat of archer.toml shows the plain trusted file
 * `findProject` accepts: a regular file (not a link), the current user's,
 * writable by nobody else (its group only when private to the user).
 */
export function isTrustedManifestStat(stats: Stats): boolean {
  if (!stats.isFile() || stats.isSymbolicLink()) return false;
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  if (stats.uid !== uid || (stats.mode & 0o002) !== 0) return false;
  if ((stats.mode & 0o020) === 0) return true;
  try {
    return groupIsPrivate(uid, stats.gid, readFileSync("/etc/passwd", "utf8"), readFileSync("/etc/group", "utf8"));
  } catch {
    return false;
  }
}

function requireTrustedManifest(manifest: string, refused = false): void {
  if (!refused && trusted(manifest) && !isLink(manifest)) return;
  throw new ProjectError(
    "untrusted_manifest",
    `${manifest} is a link, owned by another user or writable by others, and it decides where Archer reads and writes; ` +
      `if it is yours, make it a plain file and run \`chmod go-w ${manifest}\`, or remove it`,
  );
}

function loadProject(root: string, manifest: string): Project {
  const { doc, text } = readManifest(manifest);
  // C-30: `edit` written after a table header is that table's key in TOML. Never read as nothing:
  // under [[views]] it is that view's problem and editing is off until it moves (fail closed); under
  // any other table, where nothing else would load either, the manifest is refused naming the line.
  const misplaced = misplacedKey(text, "edit");
  if (misplaced !== null && misplaced.header !== "[[views]]")
    throw manifestError(misplacedKeyMessage("edit", misplaced));
  // C-33/X-19: so too a delivery key written after a header other than [agents]: under [[views]] that view's
  // problem, with automatic launch off for the project until it moves (the Launch button stays the owner's);
  // under any other table the manifest is refused naming the line.
  const delivery = DELIVERY_KEYS.flatMap((key) => {
    const at = misplacedKey(text, key, ["[agents]", ...deliveryKeyAlsoUnder(key)]);
    return at === null ? [] : [{ key, at }];
  });
  const elsewhere = delivery.find(({ at }) => at.header !== "[[views]]");
  if (elsewhere !== undefined) throw manifestError(misplacedAgentsKeyMessage(elsewhere.key, elsewhere.at));
  const loaded = registryMetadata(root, doc);
  const placed = [
    ...(misplaced === null
      ? []
      : [
          {
            position: misplaced.entry,
            id: viewIdAt(doc, misplaced.entry),
            message: `${misplacedKeyMessage("edit", misplaced)}. Until then, creating and editing in the page are off`,
          },
        ]),
    ...delivery.map(({ key, at }) => ({
      position: at.entry,
      id: viewIdAt(doc, at.entry),
      message: `${misplacedAgentsKeyMessage(key, at)}. Until then, automatic launch is off for this project`,
    })),
  ];
  const positions = new Set(placed.map((problem) => problem.position));
  const metadata: RegistryMetadata =
    placed.length === 0
      ? loaded
      : {
          ...loaded,
          ...(misplaced === null ? {} : { edit: false }),
          ...(delivery.length === 0
            ? {}
            : { agents: { ...loaded.agents, launch: loaded.agents?.launch === "off" ? "off" : "ask" } }),
          problems: [...loaded.problems.filter((problem) => !positions.has(problem.position)), ...placed].sort(
            (a, b) => a.position - b.position,
          ),
        };
  const project = withFolder(root, manifest, metadata.folderSetting, metadata.views, metadata.problems);
  return withConfigurationRevision(
    {
      ...project,
      ...(metadata.name === undefined ? {} : { name: metadata.name }),
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      ...(metadata.serviceName === undefined ? {} : { serviceName: metadata.serviceName }),
      ...(metadata.discovery === undefined ? {} : { discovery: metadata.discovery }),
      ...(metadata.feedback === undefined ? {} : { feedback: metadata.feedback }),
      ...(metadata.edit === undefined ? {} : { edit: metadata.edit }),
      ...(metadata.nestedView === undefined ? {} : { nestedView: metadata.nestedView }),
      ...(metadata.mode === undefined ? {} : { mode: metadata.mode }),
      ...(metadata.agents === undefined ? {} : { agents: metadata.agents }),
    },
    configurationSourceRevision(doc)!,
  );
}

export interface RegistryMetadata {
  readonly folderSetting: string;
  readonly views: View[];
  readonly problems: ManifestProblem[];
  readonly name?: string;
  readonly description?: string;
  readonly serviceName?: string;
  readonly discovery?: DiscoverySettings;
  readonly feedback?: FeedbackSettings;
  readonly edit?: boolean;
  readonly nestedView?: boolean;
  readonly mode?: "docs";
  readonly agents?: ProjectAgentsSettings;
}

/** Validate a historical registry without following today's filesystem paths. */
export function historicalRegistry(text: string, root: string): RegistryMetadata {
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) throw manifestError("historical manifest is too large");
  return registryMetadata(root, parseToml(text), historicalSourceInFolder);
}
function registryMetadata(root: string, doc: TomlTable, sourceResolver = sourceInFolder): RegistryMetadata {
  const projectKeys = new Set([
    "version",
    "name",
    "description",
    "folder",
    "views",
    "service",
    "discovery",
    "feedback",
    "edit",
    "nested_view",
    "mode",
    "agents",
  ]);
  for (const key of Object.keys(doc)) {
    if (!projectKeys.has(key))
      throw manifestError(
        `unknown project setting ${JSON.stringify(key)}; configure service settings in the global archer.toml at ~/.config/archer/archer.toml or $XDG_CONFIG_HOME/archer/archer.toml`,
      );
  }
  const version = doc["version"];
  if (version !== 1)
    throw manifestError(
      version === undefined
        ? "it has no `version = 1`"
        : `version ${JSON.stringify(version)} is not supported; expected 1`,
    );
  const setting = doc["folder"];
  if (setting !== undefined && typeof setting !== "string")
    throw manifestError(`\`folder\` must be a quoted path relative to archer.toml, such as "${DEFAULT_FOLDER}"`);
  const folderSetting = checkFolderSetting(setting ?? DEFAULT_FOLDER);
  const folder = join(root, folderSetting);
  const raw = doc["views"];
  if (raw !== undefined && !(Array.isArray(raw) && raw.every(isTable)))
    throw manifestError("`views` must be a list of [[views]] tables");
  const { views, problems } = readViews(root, folder, raw ?? [], sourceResolver);
  const name = doc["name"];
  if (name !== undefined && (typeof name !== "string" || name.trim() === "" || name.length > MAX_TITLE_CHARS))
    throw manifestError(
      `\`name\` must be a quoted name of at most ${MAX_TITLE_CHARS} characters, such as "Pageturner"`,
    );
  const serviceName = projectServiceName(doc["service"]);
  const description = doc["description"];
  if (description !== undefined && (typeof description !== "string" || [...description].length > MAX_DESCRIPTION_CHARS))
    throw manifestError(`\`description\` must be quoted text of at most ${MAX_DESCRIPTION_CHARS} characters`);
  const discovery = doc["discovery"] === undefined ? undefined : parseDiscoverySettings(doc["discovery"]);
  const feedback = doc["feedback"] === undefined ? undefined : parseFeedbackSettings(doc["feedback"], "project");
  const edit = doc["edit"];
  if (edit !== undefined && typeof edit !== "boolean")
    throw manifestError("`edit` must be true or false (false turns editing in the page off; agents can still write)");
  const nestedView = doc["nested_view"];
  if (nestedView !== undefined && typeof nestedView !== "boolean")
    throw manifestError("`nested_view` must be true or false (false draws every diagram as written; no nested view)");
  const mode = doc["mode"];
  if (mode !== undefined && mode !== "docs")
    throw manifestError(
      '`mode` must be "docs" (docs mode keeps a small doc pack behind .archer/index.md), or be left out',
    );
  const agents = doc["agents"] === undefined ? undefined : parseProjectAgents(doc["agents"], manifestError);
  return {
    folderSetting,
    views,
    problems,
    ...(agents === undefined ? {} : { agents }),
    ...(name === undefined ? {} : { name: name.trim() }),
    ...(typeof description !== "string" || description.trim() === "" ? {} : { description: description.trim() }),
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(discovery === undefined ? {} : { discovery }),
    ...(feedback === undefined ? {} : { feedback }),
    ...(edit === undefined ? {} : { edit }),
    ...(nestedView === undefined ? {} : { nestedView }),
    ...(mode === undefined ? {} : { mode }),
  };
}

function projectServiceName(value: TomlValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isTable(value)) throw manifestError("`service` must be one [service] table");
  for (const key of Object.keys(value)) {
    if (key !== "name")
      throw manifestError(
        `\`[service].${key}\` is global-only; configure it in the global per-user archer.toml under ~/.config/archer (or $XDG_CONFIG_HOME/archer)`,
      );
  }
  const name = value["name"];
  if (name === undefined) return undefined;
  if (typeof name !== "string" || !SERVICE_NAME.test(name))
    throw manifestError('`[service].name` must match ^[a-z0-9][a-z0-9-]{0,31}$, such as "courierdesk"');
  return name;
}

function withFolder(
  root: string,
  manifest: string | null,
  folderSetting: string,
  views: View[],
  problems: ManifestProblem[],
): Project {
  const folder = join(root, folderSetting);
  // The folder itself, or a directory on the way to it, may be a link; it
  // must not lead out of the project.
  if (!within(root, realOf(folder)))
    throw new ProjectError(
      "path_outside_archer_folder",
      `the Archer folder ${folderSetting} leads outside the project (${root}); make it a real folder inside the project`,
    );
  return { root, manifest, folder, folderSetting, views, problems };
}

/**
 * archer.toml's bytes and the descriptor's fstat, read through the confined seam (confined-fs.ts) from
 * the project root: no link at its open, one name only (a hard link is another name for a file that may
 * be outside the project), still bound to `<root>/archer.toml` after the read, and the trusted owner and
 * mode checked on the descriptor itself. Every reader of a project's archer.toml goes through here.
 * Throws ConfinedRefusal, ConfinedTooLarge, the OS error (ENOENT), or ProjectError `untrusted_manifest`.
 */
export function readManifestFile(root: string): { readonly bytes: Buffer; readonly stat: Stats } {
  const read = readConfinedFile(root, [MANIFEST], { limit: MAX_MANIFEST_BYTES, shown: MANIFEST });
  if (!isTrustedManifestStat(read.stat)) requireTrustedManifest(join(root, MANIFEST), true);
  return read;
}

/** The `id` of the `entry`th [[views]] table, when it is a string. */
function viewIdAt(doc: TomlTable, entry: number): string | null {
  const views = doc["views"];
  const id = Array.isArray(views) ? (views[entry - 1] as TomlTable | undefined)?.["id"] : undefined;
  return typeof id === "string" ? id : null;
}

function readManifest(manifest: string): { readonly doc: TomlTable; readonly text: string } {
  let bytes: Buffer;
  try {
    bytes = readManifestFile(dirname(manifest)).bytes;
  } catch (error) {
    if (error instanceof ConfinedTooLarge)
      throw manifestError(`it is over ${MAX_MANIFEST_BYTES} bytes; Archer reads at most that much of a manifest`);
    if (error instanceof ConfinedRefusal)
      throw new ProjectError("untrusted_manifest", `${manifest} was not read: ${error.message}`);
    if (error instanceof ProjectError) throw error;
    throw manifestError(`it cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw manifestError("it is not UTF-8");
  }
  try {
    return { doc: withConfigurationSource(parseToml(text), bytes), text };
  } catch (error) {
    if (error instanceof TomlError) throw manifestError(error.message);
    throw error;
  }
}

const manifestError = (why: string) => new ProjectError("manifest_error", `archer.toml cannot be used: ${why}`);

function isTable(value: TomlValue): value is TomlTable {
  return typeof value === "object" && !Array.isArray(value);
}

/** Splits a relative path on either separator; `null` if it is absolute or empty. */
function segments(path: string): string[] | null {
  if (path === "" || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("\\")) return null;
  return path.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
}

function checkFolderSetting(setting: string): string {
  const parts = segments(setting);
  if (parts === null || parts.length === 0 || parts.includes(".."))
    throw manifestError(
      `folder "${setting}" must be a folder inside the project, relative to archer.toml, with no ".." (the default is "${DEFAULT_FOLDER}")`,
    );
  return parts.join("/");
}

function readViews(
  root: string,
  folder: string,
  entries: readonly TomlTable[],
  sourceResolver = sourceInFolder,
): { views: View[]; problems: ManifestProblem[] } {
  const views: View[] = [];
  const problems: ManifestProblem[] = [];
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const position = index + 1;
    if (views.length === MAX_VIEWS) {
      problems.push({
        position,
        id: null,
        message: `archer.toml lists ${entries.length - index} views past the limit of ${MAX_VIEWS}; they were not read`,
      });
      break;
    }
    const id = typeof entry["id"] === "string" ? entry["id"] : null;
    const reject = (message: string) => problems.push({ position, id, message });
    const unknown = Object.keys(entry).filter((key) => !["id", "kind", "title", "source", "covers"].includes(key));
    if (unknown.length > 0) {
      reject(
        `unknown view setting ${unknown.map((key) => JSON.stringify(key)).join(", ")}; service settings belong in the global archer.toml`,
      );
      continue;
    }
    const fields = ["id", "kind", "title", "source"] as const;
    const missing = fields.filter((f) => typeof entry[f] !== "string");
    if (missing.length > 0) {
      reject(`a view needs ${missing.map((f) => `\`${f}\``).join(", ")} as quoted text`);
      continue;
    }
    const [kind, title, source] = [entry["kind"], entry["title"], entry["source"]] as [string, string, string];
    if (id === null || !isStableId(id)) {
      reject(`"${id}" is not a view ID: letters, digits, "-" and "_", starting with a letter or digit, at most 128`);
      continue;
    }
    if (ids.has(id)) {
      reject(`view ID "${id}" is already used by an earlier view`);
      continue;
    }
    ids.add(id);
    if (!DIAGRAM_KIND_SET.has(kind)) {
      reject(`kind "${kind}" is not one of ${DIAGRAM_KINDS.join(", ")}`);
      continue;
    }
    if ([...title].length > MAX_TITLE_CHARS) {
      reject(`the title is ${[...title].length} characters, and a title holds at most ${MAX_TITLE_CHARS}`);
      continue;
    }
    const inFolder = sourceResolver(root, folder, source);
    if (inFolder === null) {
      reject(
        `source "${source}" is outside the Archer folder (${relative(root, folder).split(sep).join("/")}); ` +
          "move the diagram into it and name it relative to archer.toml",
      );
      continue;
    }
    if (sources.has(inFolder)) {
      reject(`source "${source}" is already the source of an earlier view`);
      continue;
    }
    sources.add(inFolder);
    let covers: string[] | undefined;
    if (entry["covers"] !== undefined) {
      try {
        covers = coveragePatterns(entry["covers"]);
      } catch (error) {
        reject(error instanceof Error ? error.message : "invalid covers");
        continue;
      }
    }
    views.push({ id, kind: kind as DiagramKind, title, source: inFolder, ...(covers === undefined ? {} : { covers }) });
  }
  return { views, problems };
}

function historicalSourceInFolder(root: string, folder: string, source: string): string | null {
  if (source.includes("\0") || source.includes("\\") || source.length > 1024) return null;
  const parts = segments(source);
  if (parts === null || parts.includes("..") || parts.length > 64) return null;
  const inside = relative(folder, resolve(root, source));
  return inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)
    ? null
    : inside.split(sep).join("/");
}

/** A manifest source (relative to archer.toml) as a folder-relative path, or null when it leaves the folder. */
function sourceInFolder(root: string, folder: string, source: string): string | null {
  const parts = segments(source);
  if (parts === null || parts.includes("..")) return null;
  const target = join(root, ...parts);
  if (!within(folder, target) || !within(realOf(folder), realOf(target))) return null;
  return relative(folder, target).split(sep).join("/");
}

/** True when `path` is strictly inside `base` (both absolute). */
export function within(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
}

/**
 * The real location of `path`: links resolved along the part of it that
 * exists, with the rest appended. A dangling link counts as leaving.
 */
export function realOf(path: string): string {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      // The C library's realpath: the same canonical answer as fs.realpathSync, which re-implements
      // the walk in JavaScript with an lstat per component and dominated the catalog's reads.
      return join(realpathSync.native(at), ...rest.reverse());
    } catch {
      // A link whose target is missing is not followed into the unknown.
      if (isLink(at)) return join(sep, "\0dangling");
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      rest.push(basename(at));
      at = parent;
    }
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const outside = (project: Project, path: string) =>
  new ProjectError(
    "path_outside_archer_folder",
    `${path === "" ? "an empty path" : path} is outside the Archer folder (${project.folderSetting}); Archer reads and writes only inside it`,
  );

/**
 * A path given relative to the Archer folder, as an absolute path inside it.
 * Refuses an absolute path, any `..`, and a path whose links lead out.
 */
export function resolveInFolder(project: Project, path: string): string {
  const parts = segments(path);
  if (parts === null || parts.length === 0 || parts.includes("..")) throw outside(project, path);
  const target = join(project.folder, ...parts);
  if (!within(realOf(project.folder), realOf(target))) throw outside(project, path);
  return target;
}

/**
 * An absolute path as a `/`-separated path relative to the Archer folder, or
 * a refusal when it, or the file a link there leads to, is outside it.
 */
export function confine(project: Project, path: string): string {
  const absolute = resolve(path);
  const folderReal = realOf(project.folder);
  const real = realOf(absolute);
  if (!within(folderReal, real)) throw outside(project, path);
  for (const base of [project.folder, folderReal]) {
    if (within(base, absolute)) return relative(base, absolute).split(sep).join("/");
  }
  return relative(folderReal, real).split(sep).join("/");
}

export interface ConfinedWriteOptions {
  readonly syncDirectory?: boolean;
}
export { ConfinedWriteRefusedError, ConfinedWriteUncertainError, writeAllSync };

// ------------------------------------------------------------------ the confined seam, by project
// Every read of a project file's bytes and every write inside the Archer folder goes through these, which
// name the real place and leave the opening to the descriptor seam (confined-fs.ts; rubric H4, ADR 0018
// and ADR 0028 amended 2026-10-31). realpath only chooses which names to walk: the walk itself follows
// no link and admits a file with one name only, so a name changed after realpath is refused, never followed.

/** The Archer folder's real place, inside the project. */
export function realFolder(project: Project): string {
  const real = realOf(project.folder);
  if (!within(project.root, real))
    throw new ProjectError(
      "path_outside_archer_folder",
      `the Archer folder ${project.folderSetting} leads outside the project; make it a real folder inside the project`,
    );
  return real;
}

/** Where a folder-relative path really is: the folder's real path and the real segments below it. Refuses `..`, absolute paths and links leading out. */
export function placeInFolder(project: Project, path: string): { readonly dir: string; readonly parts: string[] } {
  const parts = segments(path);
  if (parts === null || parts.length === 0 || parts.includes("..")) throw outside(project, path);
  const dir = realFolder(project);
  const real = realOf(join(project.folder, ...parts));
  if (!within(dir, real)) throw outside(project, path);
  return { dir, parts: relative(dir, real).split(sep) };
}

/**
 * The bytes of a file in the Archer folder (folder-relative `path`), through the confined seam: a regular
 * file with one name, reached by no link, read from its descriptor. Throws ProjectError (outside, a link,
 * a hard link, moved), ConfinedTooLarge (over `limit`), or the OS error (ENOENT when missing).
 */
export function readInFolder(project: Project, path: string, limit?: number): Buffer {
  const { dir, parts } = placeInFolder(project, path);
  return readConfined(dir, parts, limit === undefined ? { shown: path } : { shown: path, limit });
}

/** {@link readInFolder}, or null for any refusal or failure. */
export function readInFolderOrNull(project: Project, path: string, limit?: number): Buffer | null {
  try {
    return readInFolder(project, path, limit);
  } catch {
    return null;
  }
}

/** Removes a file in the Archer folder through the confined seam (no link followed to reach it); absent is not an error. */
export function removeInFolder(project: Project, path: string): void {
  const parts = segments(path);
  if (parts === null || parts.length === 0 || parts.includes("..")) throw outside(project, path);
  const dir = realFolder(project);
  let parentReal: string;
  try {
    parentReal = realpathSync(join(project.folder, ...parts.slice(0, -1)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw outside(project, path);
  }
  if (parentReal !== dir && !within(dir, parentReal)) throw outside(project, path);
  removeConfined(dir, parentReal === dir ? [] : relative(dir, parentReal).split(sep), parts[parts.length - 1]!, path);
}

/** The bytes of a file at a project-root-relative path (README.md, a code file a note names), through the confined seam. */
export function readInProject(project: Project, path: string, limit?: number): Buffer {
  const parts = segments(path);
  const refused = () => new ProjectError("path_outside_project", `${path} is not a path inside the project`);
  if (parts === null || parts.length === 0 || parts.includes("..")) throw refused();
  const real = realOf(join(project.root, ...parts));
  if (!within(project.root, real)) throw refused();
  return readConfined(
    project.root,
    relative(project.root, real).split(sep),
    limit === undefined ? { shown: path } : { shown: path, limit },
  );
}

/**
 * Writes one file in the Archer folder. `rules` names what the write is for (ADR 0013): the
 * account's rules are checked immediately before the effect, and a refusal writes nothing.
 */
export function writeConfined(
  project: Project,
  path: string,
  text: string,
  rules: WriteRule | readonly WriteRule[],
  options: ConfinedWriteOptions = {},
): string {
  assertWriteAllowed(project.root, rules);
  const parts = segments(path);
  if (parts === null || parts.length === 0 || parts.includes("..")) throw outside(project, path);
  const name = parts[parts.length - 1] ?? "";
  const dir = realFolder(project);
  let parentReal: string;
  try {
    parentReal = realpathSync(join(project.folder, ...parts.slice(0, -1)));
  } catch {
    throw outside(project, path);
  }
  if (parentReal !== dir && !within(dir, parentReal)) throw outside(project, path);
  // The parent is opened, the temporary created in it and the rename made in it by descriptor; the
  // destination entry is replaced (a link or another name there is replaced, never written through).
  return publishConfined(
    dir,
    parentReal === dir ? [] : relative(dir, parentReal).split(sep),
    name,
    text,
    path,
    options.syncDirectory === true ? { syncDirectory: true } : {},
  );
}
