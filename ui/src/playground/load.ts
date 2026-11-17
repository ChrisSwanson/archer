import type { PlaygroundProject, PlaygroundSnapshot } from "../../../shared/playground-snapshot.mts";
import {
  unpackProject,
  type PackedProject,
  type PackedShared,
  type PlaygroundIndex,
} from "../../../shared/playground-delivery.mts";

export const INDEX_ELEMENT = "archer-playground-index";

/** The document's inline index: names, notices and digest, but no project data. */
export function readPlaygroundIndex(doc: Document): PlaygroundIndex {
  const payload = doc.getElementById(INDEX_ELEMENT)?.textContent;
  if (!payload) throw new Error("The example index is missing.");
  const index = JSON.parse(payload) as PlaygroundIndex;
  if (
    index.formatVersion !== 1 ||
    !Array.isArray(index.projects) ||
    index.projects.length !== 3 ||
    typeof index.shared !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(index.manifest?.digest)
  )
    throw new Error("The example index is invalid.");
  return index;
}

async function readJson<T>(url: URL, fetcher: typeof fetch): Promise<T> {
  // The data files are the document's own published files: same origin, no credentials, no service.
  if (!/^https?:$/.test(url.protocol)) throw new Error("The example data is unavailable.");
  const response = await fetcher(url, { credentials: "omit" });
  if (!response.ok) throw new Error("The example data could not load.");
  return (await response.json()) as T;
}

export type ProjectLoader = (slug: string) => Promise<PlaygroundProject | undefined>;

/**
 * Downloads one example project's file (and, once, the shared responses) beside the document. A failed download
 * is forgotten, so asking again retries it.
 */
export function projectLoader(
  index: PlaygroundIndex,
  documentUrl: string,
  fetcher: typeof fetch = fetch,
): ProjectLoader {
  const document = new URL(documentUrl);
  let shared: Promise<PackedShared> | undefined;
  const readShared = () => {
    shared ??= readJson<PackedShared>(new URL(index.shared, document), fetcher).catch((error: unknown) => {
      shared = undefined;
      throw error;
    });
    return shared;
  };
  return async (slug) => {
    const entry = index.projects.find((candidate) => candidate.slug === slug);
    if (!entry) return undefined;
    const [packed, common] = await Promise.all([
      readJson<PackedProject>(new URL(entry.data, document), fetcher),
      readShared(),
    ]);
    return unpackProject(entry, packed, common);
  };
}

/** Fetch only the named projects' files (and the shared responses) beside the document. */
export async function loadPlaygroundSnapshot(
  index: PlaygroundIndex,
  slugs: readonly string[],
  documentUrl: string,
  fetcher: typeof fetch = fetch,
  load: ProjectLoader = projectLoader(index, documentUrl, fetcher),
): Promise<PlaygroundSnapshot> {
  const entries = index.projects.filter((entry) => slugs.includes(entry.slug));
  const projects = await Promise.all(entries.map((entry) => load(entry.slug)));
  return {
    formatVersion: 1,
    manifest: index.manifest,
    fontLicense: index.fontLicense,
    projects: projects.filter((project): project is PlaygroundProject => project !== undefined),
  };
}
