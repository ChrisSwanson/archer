/** An additive project-relative catalog. It never changes legacy source identities or grants writes. */
import { closeSync, fstatSync, opendirSync, readdirSync, readSync, type Stats } from "node:fs";
import { ConfinedFileSystem, ConfinementUnavailable, type ConfinedHandle } from "./confined-fs.ts";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { isStableId } from "../model/ids.ts";
import { MAX_SOURCE_BYTES } from "../mermaid/limits.ts";
import { MAX_NOTE_BYTES } from "./inventory.ts";
import { ProjectError } from "./errors.ts";
import type { Project } from "./project.ts";

export interface DiscoverySettings {
  readonly roots?: readonly string[];
  readonly exclude?: readonly string[];
}
export interface DocumentEntry {
  readonly source: { readonly path: string };
  readonly kind: "markdown" | "mermaid";
  readonly legacy?: { readonly notePath?: string; readonly viewId?: string };
  /** Legacy interaction eligibility only; account write rules must still be enforced. */
  readonly capabilities: {
    readonly read: true;
    readonly sourceWrite: false;
    readonly comments: boolean;
    readonly emphasis: boolean;
  };
}
export interface DiscoveryDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export interface DocumentCatalog {
  readonly documents: readonly DocumentEntry[];
  readonly complete: boolean;
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}
export interface DiscoveryLimits {
  readonly depth: number;
  readonly directories: number;
  readonly entries: number;
  readonly documents: number;
  readonly bytes: number;
  readonly matchWork: number;
}
export const DISCOVERY_LIMITS: DiscoveryLimits = Object.freeze({
  depth: 64,
  directories: 1000,
  entries: 50_000,
  documents: 4096,
  bytes: 16 * 1024 * 1024,
  matchWork: 64_000_000,
});
const MAX_PATH = 4096;
const GENERATED = new Set(["node_modules", "target", "dist", "build", "coverage", "vendor"]);
const admitted = new WeakMap<
  DocumentCatalog,
  { root: string; paths: ReadonlySet<string>; directories: readonly string[] }
>();
const refusal = (message: string): ProjectError => new ProjectError("manifest_error", `discovery: ${message}`);

function literalPath(value: unknown, root: boolean, authoring = false): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH &&
    !isAbsolute(value) &&
    !(authoring ? /[\\:?\u0000-\u001f\u007f]/u : /[\\:*?[\]{}!\u0000-\u001f\u007f]/u).test(value) &&
    ((root && value === ".") || value.split("/").every((part) => part !== "" && part !== "." && part !== ".."))
  );
}
/** Strict shared TOML-section parser; unknown settings never silently disappear. */
export function parseDiscoverySettings(raw: unknown): DiscoverySettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw refusal("expected one [discovery] table");
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "roots" && key !== "exclude") throw refusal(`unknown setting ${JSON.stringify(key)}`);
  const result: { roots?: string[]; exclude?: string[] } = {};
  if (record["roots"] !== undefined) {
    const roots = record["roots"];
    if (!Array.isArray(roots) || roots.length > 64 || !Array.from(roots).every((root) => literalPath(root, true)))
      throw refusal("roots must be at most 64 literal project-relative paths");
    result.roots = [...new Set(roots as string[])];
  }
  if (record["exclude"] !== undefined) {
    const patterns = record["exclude"];
    if (!Array.isArray(patterns) || patterns.length > 128 || !Array.from(patterns).every(validPattern))
      throw refusal("exclude must be at most 128 relative patterns (only * and ** wildcards)");
    result.exclude = [...new Set(patterns as string[])];
  }
  return result;
}
function validPattern(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !isAbsolute(value) &&
    !/[\\:?[\]{}!\u0000-\u001f\u007f]/u.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && (!part.includes("**") || part === "**"))
  );
}
/** Per-field replacement, including empty lists; global paths stay project-relative. */
export function resolveDiscoverySettings(
  project: Project,
  layers: {
    readonly system?: DiscoverySettings;
    readonly user?: DiscoverySettings;
    readonly project?: DiscoverySettings;
  } = {},
): Required<DiscoverySettings> {
  const system = parseDiscoverySettings(layers.system ?? {}),
    user = parseDiscoverySettings(layers.user ?? {}),
    local = parseDiscoverySettings(layers.project ?? project.discovery ?? {});
  return {
    roots: local.roots ?? user.roots ?? system.roots ?? [project.folderSetting],
    exclude: local.exclude ?? user.exclude ?? system.exclude ?? [],
  };
}

/** NFA glob matching: bounded work, no backtracking regular expressions. */
function matches(pattern: string, path: string, spend: () => void): boolean {
  const closure = (states: Set<number>): Set<number> => {
    for (const at of states)
      if (pattern[at] === "*") {
        spend();
        const end = pattern[at + 1] === "*" ? at + 2 : at + 1;
        states.add(end);
        if (end === at + 2 && pattern[end] === "/") states.add(end + 1);
      }
    return states;
  };
  let states = closure(new Set([0]));
  for (const character of path) {
    const next = new Set<number>();
    for (const at of states) {
      spend();
      if (pattern[at] === "*" && (pattern[at + 1] === "*" || character !== "/")) next.add(at);
      else if (pattern[at] === character) next.add(at + 1);
    }
    states = closure(next);
    if (states.size === 0) return false;
  }
  return closure(states).has(pattern.length);
}

/** The project's root README: discovered by default beside the configured roots (ADR 0017). */
export const PROJECT_README = "README.md";
/**
 * Whether `dir` holds an entry spelled exactly `name`. Opening by name finds `readme.md` too on a
 * case-insensitive filesystem (macOS's default APFS); the README is admitted by its exact name only.
 */
function exactEntry(dir: string, name: string): boolean {
  try {
    return readdirSync(dir).includes(name);
  } catch {
    return false;
  }
}
export interface DiscoveryOptions {
  /** Default true: also admit the root README.md, read-only, unless an exclusion names it. */
  readonly readme?: boolean;
}

/** Test limits may only reduce production limits. Traversal never recursively consumes the stack. */
export function discoverDocuments(
  project: Project,
  settings: DiscoverySettings = {},
  testLimits: Partial<DiscoveryLimits> = {},
  options: DiscoveryOptions = {},
): DocumentCatalog {
  return discover(project, settings, testLimits, false, options.readme ?? true);
}

/** Fixed authoring scope: browser roots, exclusions and generated-directory filters do not apply. */
export function discoverAuthoringDocuments(
  project: Project,
  testLimits: Partial<DiscoveryLimits> = {},
): DocumentCatalog {
  return discover(project, { roots: [project.folderSetting], exclude: [] }, testLimits, true, false);
}

function discover(
  project: Project,
  settings: DiscoverySettings,
  testLimits: Partial<DiscoveryLimits>,
  authoring: boolean,
  readme: boolean,
): DocumentCatalog {
  const parsed = authoring ? settings : parseDiscoverySettings(settings);
  const roots = parsed.roots ?? [project.folderSetting],
    exclude = parsed.exclude ?? [];
  const limits = { ...DISCOVERY_LIMITS };
  for (const key of Object.keys(DISCOVERY_LIMITS) as (keyof DiscoveryLimits)[]) {
    const supplied = testLimits[key];
    if (supplied !== undefined) {
      if (!Number.isSafeInteger(supplied) || supplied < 0 || supplied > DISCOVERY_LIMITS[key])
        throw refusal(`invalid ${key} test limit`);
      limits[key] = supplied;
    }
  }
  const documents: DocumentEntry[] = [],
    diagnostics: DiscoveryDiagnostic[] = [];
  const seen = new Set<string>(),
    visited = new Set<string>(),
    watchParents = new Set<string>();
  let entries = 0,
    bytes = 0,
    work = 0;
  const problem = (code: string, path: string, message: string): void => {
    diagnostics.push({ code, path, message });
  };
  const stop = new Error("discovery budget exhausted");
  const excluded = (path: string): boolean =>
    exclude.some((pattern) =>
      matches(pattern, path, () => {
        if (++work > limits.matchWork) throw stop;
      }),
    );
  const folderRelative = (path: string): string | null => {
    const absolute = join(project.root, ...path.split("/"));
    const rel = relative(project.folder, absolute);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
      ? rel.split(sep).join("/")
      : null;
  };
  const add = (path: string, stat: Stats): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const kind = path.endsWith(".md") ? "markdown" : path.endsWith(".mmd") ? "mermaid" : null;
    if (kind === null) return;
    if (stat.size > (kind === "markdown" ? MAX_NOTE_BYTES : MAX_SOURCE_BYTES)) {
      problem("source_too_large", path, "document exceeds its source byte limit");
      return;
    }
    if (documents.length >= limits.documents || bytes + stat.size > limits.bytes) {
      problem("catalog_limit", path, "document count or total byte budget exceeded");
      throw stop;
    }
    bytes += stat.size;
    const oldPath = folderRelative(path);
    const old = oldPath?.split("/").every((part) => !part.startsWith(".")) ? oldPath : null;
    const view = old === null ? undefined : project.views.find((candidate) => candidate.source === old);
    const inferred = posix.basename(path, ".mmd");
    const legacy =
      old === null
        ? undefined
        : kind === "markdown"
          ? { notePath: old }
          : view !== undefined
            ? { viewId: view.id }
            : isStableId(inferred)
              ? { viewId: inferred }
              : undefined;
    documents.push({
      source: { path },
      kind,
      ...(legacy === undefined ? {} : { legacy }),
      capabilities: { read: true, sourceWrite: false, comments: legacy !== undefined, emphasis: legacy !== undefined },
    });
  };
  let confined: ConfinedFileSystem | undefined;
  // The implicit README comes last so a configured root that already reached it wins; when it is
  // absent, linked, oversized or not a file it is silently left out, never an incomplete catalog.
  const scan = [
    ...roots.map((root) => ({ root, implicit: false })),
    ...(readme ? [{ root: PROJECT_README, implicit: true }] : []),
  ];
  try {
    for (const { root, implicit } of scan) {
      if (implicit && seen.has(root)) continue;
      if (root.split("/").includes(".git")) {
        problem("protected_path", root, "Git internals are not documentation");
        continue;
      }
      if (excluded(root)) continue;
      try {
        confined ??= new ConfinedFileSystem(project.root);
      } catch {
        if (implicit) continue; // nothing configured is missing: the README is simply not admitted
        problem("confinement_unavailable", "", "safe descriptor-relative discovery is unavailable");
        throw stop;
      }
      // Parent subscriptions detect explicitly selected files and missing roots appearing later.
      let parent = project.root;
      watchParents.add(parent);
      for (const part of root === "." ? [] : root.split("/").slice(0, -1)) {
        parent = join(parent, part);
        try {
          const handle = confined.open(relative(project.root, parent).split(sep).join("/"));
          const directory = handle.stat.isDirectory();
          closeSync(handle.fd);
          if (!directory) break;
          watchParents.add(parent);
        } catch {
          break;
        }
      }
      let location: ConfinedHandle;
      try {
        location = confined.open(root);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (implicit) continue;
        if (code === "ELOOP" || code === "ENOTDIR")
          problem("symlink_refused", root, "discovery roots must not traverse symlinks");
        else if (parsed.roots !== undefined || root !== project.folderSetting)
          problem("root_unavailable", root, "configured discovery root is missing or unreadable");
        continue;
      }
      const rootStat = location.stat;
      closeSync(location.fd);
      if (implicit) {
        if (rootStat.isFile() && rootStat.size <= MAX_NOTE_BYTES && exactEntry(project.root, root)) add(root, rootStat);
        continue;
      }
      if (rootStat.isFile()) {
        add(root, rootStat);
        continue;
      }
      if (!rootStat.isDirectory()) {
        problem("not_regular", root, "discovery root is neither a regular file nor directory");
        continue;
      }
      const pending = [{ path: root, depth: 0 }];
      for (let at = 0; at < pending.length; at++) {
        const current = pending[at]!;
        if (visited.has(current.path)) continue;
        if (visited.size >= limits.directories) {
          problem("directory_limit", current.path, "directory budget exceeded");
          throw stop;
        }
        visited.add(current.path);
        let directory, handle: ConfinedHandle | undefined;
        try {
          handle = confined.open(current.path);
          if (!handle.stat.isDirectory()) throw new Error("not a directory");
          directory = opendirSync(confined.descriptorPath(handle));
          if (!confined.bound(handle)) throw new Error("directory binding changed");
        } catch {
          directory?.closeSync();
          if (handle !== undefined) closeSync(handle.fd);
          problem("directory_unreadable", current.path, "directory cannot be enumerated safely");
          continue;
        }
        try {
          for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
            if (!confined.bound(handle)) {
              problem("directory_unreadable", current.path, "directory binding changed");
              break;
            }
            if (++entries > limits.entries) {
              problem("entry_limit", current.path, "directory entry budget exceeded");
              throw stop;
            }
            const path = current.path === "." ? entry.name : `${current.path}/${entry.name}`;
            if (
              entry.name === ".git" ||
              (entry.name.startsWith(".") && path !== project.folderSetting) ||
              (!authoring && GENERATED.has(entry.name)) ||
              excluded(path)
            )
              continue;
            if (path.length > MAX_PATH) {
              problem("path_limit", path.slice(0, 200), "project-relative path is too long");
              continue;
            }
            if (!literalPath(path, false, authoring)) {
              problem("unsupported_path", path, "file name cannot be represented safely");
              continue;
            }
            if (entry.isSymbolicLink()) {
              problem("symlink_refused", path, "symlinks are not followed by the project catalog");
              continue;
            }
            if (entry.isDirectory()) {
              if (current.depth >= limits.depth)
                problem("depth_limit", path, `directory depth exceeds ${limits.depth}`);
              else pending.push({ path, depth: current.depth + 1 });
            } else if (entry.isFile()) {
              try {
                const candidate = confined.open(path);
                try {
                  if (candidate.stat.isFile()) add(path, candidate.stat);
                  else problem("source_unavailable", path, "document changed while discovering");
                } finally {
                  closeSync(candidate.fd);
                }
              } catch (error) {
                if (error === stop) throw error;
                problem("source_unavailable", path, "document cannot be inspected");
              }
            }
          }
        } catch (error) {
          if (error === stop) throw error;
          problem("directory_unreadable", current.path, "directory cannot be enumerated safely");
        } finally {
          try {
            directory.closeSync();
          } finally {
            closeSync(handle.fd);
          }
        }
      }
    }
  } catch (error) {
    if (error !== stop) throw error;
    if (work > limits.matchWork) problem("match_limit", "", "exclude pattern work budget exceeded");
  } finally {
    confined?.close();
  }
  const claimed = new Set(project.views.map((view) => view.id));
  const registeredPaths = new Set(project.views.map((view) => posix.join(project.folderSetting, view.source)));
  const ordered = [...documents].sort((a, b) => (a.source.path < b.source.path ? -1 : 1));
  for (const entry of ordered) {
    const id = entry.legacy?.viewId;
    if (id === undefined || registeredPaths.has(entry.source.path)) continue;
    if (claimed.has(id)) {
      const index = documents.indexOf(entry);
      documents[index] = {
        source: entry.source,
        kind: entry.kind,
        capabilities: { read: true, sourceWrite: false, comments: false, emphasis: false },
      };
    } else claimed.add(id);
  }
  documents.sort((a, b) => (a.source.path < b.source.path ? -1 : a.source.path > b.source.path ? 1 : 0));
  const watchDirectories = [
    ...new Set([
      ...watchParents,
      ...[...visited].map((path) => (path === "." ? project.root : join(project.root, ...path.split("/")))),
    ]),
  ];
  if (watchDirectories.length > DISCOVERY_LIMITS.directories)
    problem("watcher_limit", "", "directory subscription budget exceeded");
  const catalog: DocumentCatalog = Object.freeze({
    documents: Object.freeze(documents),
    complete: diagnostics.length === 0,
    diagnostics: Object.freeze(diagnostics),
  });
  admitted.set(catalog, {
    root: project.root,
    paths: new Set(documents.map((document) => document.source.path)),
    directories: watchDirectories.slice(0, DISCOVERY_LIMITS.directories),
  });
  return catalog;
}

export type DiscoveredDocumentRead =
  | { readonly ok: true; readonly text: string; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly reason: "unavailable" | "confinement_unavailable" | "source_too_large" | "invalid_utf8";
    };

/** Detailed refusals share exactly the legacy descriptor reader and its admission checks. */
export function readDiscoveredDocumentDetailed(
  project: Project,
  catalog: DocumentCatalog,
  path: string,
  shared?: ConfinedFileSystem,
): DiscoveredDocumentRead {
  const admission = admitted.get(catalog);
  const unavailable = { ok: false, reason: "unavailable" } as const;
  if (admission?.root !== project.root || !admission.paths.has(path)) return unavailable;
  if (shared !== undefined && shared.root !== project.root) return unavailable;
  let confined: ConfinedFileSystem | undefined, handle: ConfinedHandle | undefined;
  try {
    // Authentic admission already checked this policy's literal path grammar. A caller reading many
    // documents in one operation may share one anchor: every open still walks each component with
    // O_NOFOLLOW from it and checks the root's and the file's binding before and after the read.
    confined = shared ?? new ConfinedFileSystem(project.root);
    handle = confined.open(path);
    const { fd, stat } = handle,
      max = path.endsWith(".md") ? MAX_NOTE_BYTES : MAX_SOURCE_BYTES;
    // A regular file with one name only: a hard link is another name for a file that may live outside the project (G6).
    if (!stat.isFile() || stat.nlink !== 1) return unavailable;
    if (stat.size > max) return { ok: false, reason: "source_too_large" };
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (!confined.bound(handle) || fstatSync(fd).nlink !== 1) return unavailable;
    if (length > max) return { ok: false, reason: "source_too_large" };
    if (length > stat.size) return unavailable;
    const bytes = buffer.subarray(0, length);
    try {
      return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), bytes };
    } catch {
      return { ok: false, reason: "invalid_utf8" };
    }
  } catch (error) {
    return error instanceof ConfinementUnavailable ? { ok: false, reason: "confinement_unavailable" } : unavailable;
  } finally {
    if (handle !== undefined) closeSync(handle.fd);
    if (confined !== shared) confined?.close();
  }
}

/** Revalidates admission and all path components; null means unavailable, never an arbitrary file read. */
export function readDiscoveredDocument(
  project: Project,
  catalog: DocumentCatalog,
  path: string,
  shared?: ConfinedFileSystem,
): { text: string; bytes: Uint8Array } | null {
  const result = readDiscoveredDocumentDetailed(project, catalog, path, shared);
  return result.ok ? { text: result.text, bytes: result.bytes } : null;
}

/** Directory subscriptions are produced by the same confined bounded traversal as the catalog. */
export function discoveredDirectories(catalog: DocumentCatalog): readonly string[] {
  return admitted.get(catalog)?.directories ?? [];
}
