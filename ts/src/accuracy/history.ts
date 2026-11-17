import { posix } from "node:path";
import { isStableId, type Revision } from "../model/index.ts";
import { compiledSource, compileEmbedded, embeddedReadIn } from "../notes/embedded.ts";
import {
  compileDiagramBytes,
  DEFAULT_FOLDER,
  historicalRegistry,
  MAX_MANIFEST_BYTES,
  MAX_NOTE_BYTES,
  revisionOf,
  type CompiledDiagram,
  type Project,
  type RegistryMetadata,
} from "../project/index.ts";
import { parseDiagramAddress } from "../../../shared/note-diagrams.mts";
import { AccuracyError } from "./errors.ts";
import { GitRepository } from "./git.ts";
export const MAX_HISTORICAL_SOURCE_BYTES = 256 * 1024;
export type HistoricalDiagram =
  | {
      readonly status: "compiled" | "failed";
      readonly viewId: string;
      readonly commit: string;
      readonly path: string;
      readonly sourceRevision: Revision;
      readonly source:
        | {
            readonly status: "text";
            readonly text: string;
          }
        | {
            readonly status: "not-utf8";
          };
      readonly result: CompiledDiagram;
    }
  | {
      readonly status: "unavailable";
      readonly viewId: string;
      readonly commit?: string;
      readonly reason: string;
    };
/** Where a diagram's source lives: a `.mmd` file, or the fence `embedded` of a note (folder-relative path either way). */
export interface HistoricalPlace {
  readonly path: string;
  readonly embedded?: string;
  /** The view archer.toml listed; absent for a file Archer names by its stem. */
  readonly view?: RegistryMetadata["views"][number];
}
const decode = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
};
/** The folder setting and registered views at `commit`; the defaults when it has no archer.toml. */
export async function registryAt(
  git: GitRepository,
  project: Project,
  commit: string,
): Promise<Pick<RegistryMetadata, "folderSetting" | "views" | "problems">> {
  const manifest = await git.entry(commit, "archer.toml");
  if (manifest === null) return { folderSetting: DEFAULT_FOLDER, views: [], problems: [] };
  return historicalRegistry(
    new TextDecoder("utf-8", { fatal: true }).decode(await git.blob(manifest, MAX_MANIFEST_BYTES)),
    project.root,
  );
}
/** Compile the source of `place` as it is at `commit`; unavailable when the commit has none. */
export async function compileAt(
  git: GitRepository,
  folderSetting: string,
  commit: string,
  place: HistoricalPlace,
  viewId: string,
): Promise<HistoricalDiagram> {
  const path = posix.join(folderSetting, place.path);
  const entry = await git.entry(commit, path);
  if (entry === null) return { status: "unavailable", viewId, commit, reason: "historical_source_missing" };
  if (place.embedded !== undefined) {
    const text = decode(await git.blob(entry, MAX_NOTE_BYTES));
    const read = text === null ? null : embeddedReadIn(place.path, text, place.embedded);
    if (read === null)
      return {
        status: "unavailable",
        viewId,
        commit,
        reason: text === null ? "historical_source_missing" : "historical_view_unavailable",
      };
    const result = await compileEmbedded(read);
    return {
      status: result.envelope === null ? "failed" : "compiled",
      viewId,
      commit,
      path,
      sourceRevision: result.revision ?? read.sourceRevision,
      source: { status: "text", text: read.source },
      result,
    };
  }
  const bytes = await git.blob(entry, MAX_HISTORICAL_SOURCE_BYTES);
  const result = await compileDiagramBytes(
    { path: place.path, ...(place.view === undefined ? {} : { view: place.view }) },
    bytes,
  );
  const text = decode(bytes);
  return {
    status: result.envelope === null ? "failed" : "compiled",
    viewId,
    commit,
    path,
    sourceRevision: revisionOf(bytes),
    source: text === null ? { status: "not-utf8" } : { status: "text", text },
    result,
  };
}
/** The most bytes of a blob `revisionOfBlob` reads for `place`. */
export const blobLimitFor = (place: HistoricalPlace): number =>
  place.embedded === undefined ? MAX_HISTORICAL_SOURCE_BYTES : MAX_NOTE_BYTES;
/** The revision of the model `place` compiles to from a blob's bytes (ADR 0002); null when an embedded diagram is not in them. */
export function revisionOfBlob(place: HistoricalPlace, bytes: Uint8Array): Revision | null {
  if (place.embedded === undefined) return revisionOf(bytes);
  const text = decode(bytes);
  const read = text === null ? null : embeddedReadIn(place.path, text, place.embedded);
  return read === null ? null : revisionOf(Buffer.from(compiledSource(read.source).text, "utf8"));
}
/** The revision of the model `place` compiles to at `commit` (ADR 0002), without compiling it; null when the commit has no such source. */
export async function revisionAt(
  git: GitRepository,
  folderSetting: string,
  commit: string,
  place: HistoricalPlace,
): Promise<Revision | null> {
  const entry = await git.entry(commit, posix.join(folderSetting, place.path));
  if (entry === null) return null;
  return revisionOfBlob(place, await git.blob(entry, blobLimitFor(place)));
}
/**
 * Resolve registration and source from the same Git commit; current files and caches never supply historical data.
 * `viewId` is a view archer.toml listed at that commit, a `<note>#<name>` address (the fence of that name in the
 * note at that commit), or the file name of an unlisted `.mmd` in the folder (ADR 0034 §3).
 */
export async function readDiagramAtCommit(project: Project, viewId: string, ref: string): Promise<HistoricalDiagram> {
  let commit: string | undefined;
  try {
    const git = await GitRepository.open(project.root);
    commit = await git.commit(ref);
    const registry = await registryAt(git, project, commit);
    const address = parseDiagramAddress(viewId);
    if (address !== null)
      return await compileAt(
        git,
        registry.folderSetting,
        commit,
        { path: address.notePath, embedded: address.name },
        viewId,
      );
    const unavailable = (reason: string): HistoricalDiagram => ({
      status: "unavailable",
      viewId,
      commit: commit!,
      reason,
    });
    if (registry.problems.some((problem) => problem.id === viewId)) return unavailable("historical_view_unavailable");
    const view = registry.views.find((entry) => entry.id === viewId);
    if (view !== undefined)
      return await compileAt(git, registry.folderSetting, commit, { path: view.source, view }, viewId);
    if (!isStableId(viewId)) return unavailable("historical_view_unavailable");
    const listed = new Set(registry.views.map((entry) => posix.join(registry.folderSetting, entry.source)));
    const free = (await git.tree(commit, registry.folderSetting)).filter(
      (file) => file.path.endsWith(".mmd") && posix.basename(file.path, ".mmd") === viewId && !listed.has(file.path),
    );
    if (free.length > 1) return unavailable("historical_view_ambiguous");
    if (free[0] === undefined) return unavailable("historical_view_unavailable");
    return await compileAt(
      git,
      registry.folderSetting,
      commit,
      { path: free[0].path.slice(registry.folderSetting.length + 1) },
      viewId,
    );
  } catch (error) {
    if (error instanceof AccuracyError && error.code === "invalid_git_ref") throw error;
    return {
      status: "unavailable",
      viewId,
      ...(commit === undefined ? {} : { commit }),
      reason: error instanceof AccuracyError ? error.code : "historical_registry_invalid",
    };
  }
}
