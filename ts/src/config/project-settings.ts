// Project settings for the page's settings modal (ADR 0017, "Project
// settings"; ADR 0028): a read-only snapshot of what archer.toml and the
// service say about one attached project. The page never writes archer.toml;
// name and description are set in the file by the person or an agent.
import { browserEditing, type EditSource } from "./write-policy.ts";
import { lstatSync, openSync, fstatSync, readSync, closeSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { MANIFEST, MAX_MANIFEST_BYTES, readManifestFile, type Project } from "../project/project.ts";
import { revisionOf } from "../project/envelope.ts";
import { ConfinedRefusal, ConfinedTooLarge } from "../project/confined-fs.ts";
import { ProjectError } from "../project/errors.ts";
import type { DiscoverySettings } from "../project/discovery.ts";
import type { ResolvedFeedbackConfiguration } from "./feedback-resolution.ts";
import type { ProjectLifecycleMetadata } from "../state/project-lifecycle.ts";
import type { ConfigFileSystem } from "./index.ts";

export class ProjectSettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** @internal Filesystem seam for the manifest read. */
export type ProjectSettingsFileSystem = ConfigFileSystem & { readonly realpathSync: (path: string) => string };
/** @internal */
export const PROJECT_SETTINGS_FILE_SYSTEM: ProjectSettingsFileSystem = Object.freeze({
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  realpathSync,
});

export interface ManifestSnapshot {
  readonly text: string;
  readonly revision: string;
  readonly file: { readonly dev: number; readonly ino: number; readonly mode: number };
}

/**
 * The project's archer.toml, read through the confined seam (project.ts readManifestFile: no link, one
 * name, bound to the project root, trusted owner and mode on the descriptor), or null when it has none.
 */
export function readProjectManifest(
  project: Project,
  fs: ProjectSettingsFileSystem = PROJECT_SETTINGS_FILE_SYSTEM,
): ManifestSnapshot | null {
  if (project.manifest === null) return null;
  manifestPath(project, fs);
  let read: { readonly bytes: Buffer; readonly stat: Stats };
  try {
    read = readManifestFile(project.root);
  } catch (error) {
    if (error instanceof ConfinedRefusal || (error instanceof ProjectError && error.code === "untrusted_manifest"))
      throw unsafe();
    if (error instanceof ConfinedTooLarge)
      throw new ProjectSettingsError(409, "manifest_invalid", `archer.toml is over ${MAX_MANIFEST_BYTES} bytes`);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw changed();
    throw ioFailure(error);
  }
  let text: string;
  // Keep a BOM in the text so an edit writes it back.
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
  } catch {
    throw new ProjectSettingsError(409, "manifest_invalid", "archer.toml is not UTF-8");
  }
  return {
    text,
    revision: revisionOf(read.bytes),
    file: { dev: read.stat.dev, ino: read.stat.ino, mode: read.stat.mode },
  };
}

/** `<root>/archer.toml`, with the root still the real directory the project loaded. */
function manifestPath(project: Project, fs: ProjectSettingsFileSystem): string {
  const path = join(project.root, MANIFEST);
  if (project.manifest !== path || basename(path) !== MANIFEST) throw unsafe();
  let real: string;
  try {
    real = fs.realpathSync(project.root);
  } catch (error) {
    throw ioFailure(error);
  }
  if (real !== project.root) throw unsafe();
  return path;
}

const changed = (): ProjectSettingsError =>
  new ProjectSettingsError(409, "revision_conflict", "archer.toml was removed or replaced; reload the settings", {
    revision: null,
  });
const unsafe = (): ProjectSettingsError =>
  new ProjectSettingsError(
    409,
    "manifest_unsafe",
    "archer.toml is a link, is owned by another user or writable by others, or has moved; Archer reads only the project's own plain archer.toml",
  );
const ioFailure = (error: unknown): ProjectSettingsError =>
  new ProjectSettingsError(
    500,
    "settings_io_failure",
    `archer.toml could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
  );

// ------------------------------------------------------------ the snapshot

export interface ProjectSettingsSnapshot {
  readonly schemaVersion: 1;
  readonly slug: string;
  /** archer.toml's exact-bytes revision; null without a manifest. */
  readonly revision: string | null;
  /** Whether the values below were loaded from that same revision. */
  readonly loaded: boolean;
  readonly general: {
    readonly name: string;
    readonly nameSource: "archer.toml" | "directory";
    readonly description: string | null;
    readonly descriptionSource: "archer.toml" | null;
    /** Where the project lives, home-relative (`~/code/archer`); never the absolute path, which would name the account to every grant holder. */
    readonly location: string;
    readonly folder: string;
    /** Whether the person may create and edit in the page, and which archer.toml says so (browserEditing). Read-only here. */
    readonly editing: { readonly enabled: boolean; readonly source: EditSource };
  };
  readonly views: readonly {
    readonly id: string;
    readonly kind: string;
    readonly title: string;
    readonly source: string;
    readonly covers?: readonly string[];
  }[];
  readonly viewProblems: readonly { readonly position: number; readonly id: string | null; readonly message: string }[];
  readonly discovery: {
    readonly roots: readonly string[];
    readonly exclude: readonly string[];
    readonly configured: DiscoverySettings;
  };
  readonly feedback: Pick<
    ResolvedFeedbackConfiguration,
    "changes" | "delivery" | "allowNotifications" | "notificationPolicy" | "sources"
  > | null;
  readonly visibility: ProjectLifecycleMetadata;
  readonly manifest: { readonly path: typeof MANIFEST; readonly text: string } | null;
}

/** An unreadable account configuration refuses page writes (fail closed), so it shows as off. */
function editingOf(project: Project): { enabled: boolean; source: EditSource } {
  try {
    return browserEditing(project);
  } catch {
    return { enabled: false, source: "account" };
  }
}

export function projectSettingsSnapshot(input: {
  readonly slug: string;
  readonly name: string;
  readonly project: Project;
  readonly loadedRevision: string | undefined;
  readonly manifest: ManifestSnapshot | null;
  readonly discovery: Required<DiscoverySettings>;
  readonly feedback: ResolvedFeedbackConfiguration | null;
  readonly lifecycle: ProjectLifecycleMetadata;
}): ProjectSettingsSnapshot {
  const { project, manifest, feedback } = input;
  return {
    schemaVersion: 1,
    slug: input.slug,
    revision: manifest?.revision ?? null,
    loaded: manifest === null ? project.manifest === null : manifest.revision === input.loadedRevision,
    general: {
      name: input.name,
      nameSource: project.name === undefined ? "directory" : "archer.toml",
      description: project.description ?? null,
      descriptionSource: project.description === undefined ? null : "archer.toml",
      location: displayLocation(project.root),
      folder: project.folderSetting,
      editing: editingOf(project),
    },
    views: project.views.map((view) => ({
      id: view.id,
      kind: view.kind,
      title: view.title,
      source: view.source,
      ...(view.covers === undefined ? {} : { covers: view.covers }),
    })),
    viewProblems: project.problems,
    discovery: { roots: input.discovery.roots, exclude: input.discovery.exclude, configured: project.discovery ?? {} },
    feedback:
      feedback === null
        ? null
        : {
            changes: feedback.changes,
            delivery: feedback.delivery,
            allowNotifications: feedback.allowNotifications,
            notificationPolicy: feedback.notificationPolicy,
            sources: feedback.sources,
          },
    visibility: input.lifecycle,
    manifest: manifest === null ? null : { path: MANIFEST, text: manifest.text },
  };
}

/** `~/…` under the home directory; elsewhere only the folder's own name, so no absolute path leaves the service. */
export function displayLocation(root: string, home: string = homedir()): string {
  if (home !== "" && root === home) return "~";
  if (home !== "" && root.startsWith(home + sep))
    return (
      "~/" +
      root
        .slice(home.length + 1)
        .split(sep)
        .join("/")
    );
  return "\u2026/" + basename(root);
}
