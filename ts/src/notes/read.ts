/** Current authoring-note source, captured once through bounded no-follow admission. */
import { posix } from "node:path";
import { parseDiagramAddress } from "../../../shared/note-diagrams.mts";
import {
  discoverAuthoringDocuments,
  readDiscoveredDocumentDetailed,
  type DiscoveryLimits,
  type DiscoveryDiagnostic,
} from "../project/discovery.ts";
import { revisionOf } from "../project/envelope.ts";
import { splitFrontMatter, type FrontMatter } from "../project/inventory.ts";
import type { Project } from "../project/project.ts";
import type { Revision } from "../model/index.ts";

export type NoteReadErrorCode =
  | "invalid_arguments"
  | "resource_not_found"
  | "source_too_large"
  | "invalid_source"
  | "io_failure";
export class NoteReadError extends Error {
  constructor(
    readonly code: NoteReadErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "NoteReadError";
  }
}
export interface NoteSource {
  readonly schemaVersion: 1;
  readonly notePath: string;
  readonly sourceRevision: Revision;
  readonly source: { readonly status: "text"; readonly text: string };
  readonly bytes: number;
  readonly complete: true;
  readonly frontMatter: FrontMatter;
  readonly provenance: { readonly scope: "authoring-folder"; readonly currentSource: true };
  readonly inventory: {
    readonly complete: boolean;
    readonly diagnostics: readonly DiscoveryDiagnostic[];
    readonly diagnosticCount: number;
    readonly diagnosticsTruncated: boolean;
  };
}

export function readNoteSource(
  project: Project,
  notePath: unknown,
  testLimits: Partial<DiscoveryLimits> = {},
): NoteSource {
  if (typeof notePath !== "string" || parseDiagramAddress(`${notePath}#a`) === null)
    throw new NoteReadError(
      "invalid_arguments",
      "notePath must be a literal authoring-folder-relative Markdown path without a fragment",
    );
  const catalog = discoverAuthoringDocuments(project, testLimits);
  const inventory = {
    complete: catalog.complete,
    diagnostics: catalog.diagnostics.slice(0, 20),
    diagnosticCount: catalog.diagnostics.length,
    diagnosticsTruncated: catalog.diagnostics.length > 20,
  };
  const details = { inventory };
  const path = posix.join(project.folderSetting, notePath);
  if (catalog.diagnostics.some((diagnostic) => diagnostic.code === "confinement_unavailable"))
    throw new NoteReadError("io_failure", "safe note confinement is unavailable", {
      ...details,
      reason: "confinement_unavailable",
    });
  if (catalog.diagnostics.some((diagnostic) => diagnostic.path === path && diagnostic.code === "source_too_large"))
    throw new NoteReadError("source_too_large", "note exceeds the source byte limit", details);
  if (!catalog.documents.some((document) => document.kind === "markdown" && document.source.path === path)) {
    // A symlink the catalog refused elsewhere hides no note at this path: absence is still plain absence.
    const onlyOtherSymlinks = catalog.diagnostics.every(
      (diagnostic) => diagnostic.code === "symlink_refused" && diagnostic.path !== path,
    );
    if (!catalog.complete && !onlyOtherSymlinks)
      throw new NoteReadError("io_failure", "note admission coverage is incomplete", {
        ...details,
        reason: "coverage_incomplete",
      });
    throw new NoteReadError("resource_not_found", "note is unavailable in the authoring folder", details);
  }
  const read = readDiscoveredDocumentDetailed(project, catalog, path);
  if (!read.ok) {
    if (read.reason === "confinement_unavailable")
      throw new NoteReadError("io_failure", "safe note confinement is unavailable", {
        ...details,
        reason: read.reason,
      });
    if (read.reason === "source_too_large")
      throw new NoteReadError("source_too_large", "note exceeds the source byte limit", details);
    if (read.reason === "invalid_utf8") throw new NoteReadError("invalid_source", "note is not valid UTF-8", details);
    throw new NoteReadError("resource_not_found", "note became unavailable during its confined read", details);
  }
  return {
    schemaVersion: 1,
    notePath,
    sourceRevision: revisionOf(read.bytes),
    source: { status: "text", text: read.text },
    bytes: read.bytes.length,
    complete: true,
    frontMatter: splitFrontMatter(read.text).fields,
    provenance: { scope: "authoring-folder", currentSource: true },
    inventory,
  };
}
