// A diagram of the Archer folder compiled into the envelope the page reads
// (schema/diagram-envelope.schema.json). A view listed in archer.toml keeps
// its id, kind and title; an unlisted file is named by its file name (id and
// title), with the kind its diagram is.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CompileResult, Diagnostic } from "../mermaid/index.ts";
import { error, span } from "../mermaid/diagnostics.ts";
import {
  defaultKind,
  describeModel,
  isStableId,
  modelForKind,
  SCHEMA_VERSION,
  type DiagramEnvelope,
  type DiagramKind,
  type DiagramModel,
  type Revision,
  type ViewMetadata,
} from "../model/index.ts";
import type { DiagramEntry } from "./inventory.ts";
import { ConfinedRefusal } from "./confined-fs.ts";
import { ProjectError } from "./errors.ts";
import { readInFolder, type Project } from "./project.ts";

export interface CompiledDiagram {
  /** Folder-relative path of the source. */
  readonly path: string;
  /** Of the bytes read; null when there were none. */
  readonly revision: Revision | null;
  readonly diagnostics: readonly Diagnostic[];
  /** Null while any error stands. */
  readonly envelope: DiagramEnvelope | null;
  /** Exact valid source bytes read by the production compiler. */
  readonly sourceBytes?: Uint8Array;
}

export function revisionOf(bytes: Uint8Array): Revision {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function compileDiagram(project: Project, entry: DiagramEntry): Promise<CompiledDiagram> {
  const failed = (revision: Revision | null, diagnostics: Diagnostic[]): CompiledDiagram => ({
    path: entry.path,
    revision,
    diagnostics,
    envelope: null,
  });
  let bytes: Buffer;
  try {
    // The confined seam (G6): no link followed, one name, read from the descriptor.
    bytes = readInFolder(project, entry.path);
  } catch (e) {
    // A refused file (a link swapped in, a hard link, not a regular file) is a diagnostic; a path leading out is refused.
    if (e instanceof ConfinedRefusal)
      return failed(null, [error("source_missing", `${entry.path} cannot be read: ${e.message}`, span(1, 1))]);
    if (e instanceof ProjectError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    return failed(null, [
      error(
        "source_missing",
        code === "ENOENT"
          ? `${entry.path} does not exist in the Archer folder`
          : `${entry.path} cannot be read (${code ?? String(e)})`,
        span(1, 1),
      ),
    ]);
  }
  return compileDiagramBytes(entry, bytes);
}

/**
 * The same production compiler for exact disk, Git and verified recovery bytes; never rereads source.
 * `compileText` may reuse an earlier result for the same text (the authoring preview's compile cache);
 * the envelope then shares that result's model, so such a caller must not keep or change it.
 */
export async function compileDiagramBytes(
  entry: DiagramEntry,
  bytes: Uint8Array,
  compileText?: (text: string) => Promise<CompileResult>,
): Promise<CompiledDiagram> {
  const failed = (revision: Revision | null, diagnostics: readonly Diagnostic[]): CompiledDiagram => ({
    path: entry.path,
    revision,
    diagnostics,
    envelope: null,
  });
  const revision = revisionOf(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failed(revision, [
      error("source_not_utf8", `${entry.path} is not UTF-8 text; save it as UTF-8`, span(1, 1)),
    ]);
  }

  const { model, diagnostics } = await (compileText ?? (await import("../mermaid/index.ts")).compile)(text);
  if (model === null) return failed(revision, diagnostics);

  const view = entry.view ?? viewFromFile(entry.path, model);
  if (typeof view === "string") return failed(revision, [...diagnostics, error("invalid_view_id", view, span(1, 1))]);
  const typed = modelForKind(model, view.kind);
  if (typed === null)
    return failed(revision, [
      ...diagnostics,
      error(
        "kind_model_mismatch",
        `view "${view.id}" is declared as kind ${view.kind} in archer.toml, but ${entry.path} is ` +
          `${describeModel(model)}; change the kind or the diagram`,
        span(1, 1),
      ),
    ]);
  const metadata: ViewMetadata = { id: view.id, kind: view.kind, title: view.title };
  return {
    path: entry.path,
    revision,
    diagnostics,
    sourceBytes: bytes.slice(),
    envelope: { schemaVersion: SCHEMA_VERSION, view: metadata, revision, model: typed },
  };
}

/** The view an unlisted file stands for, or why it has none. */
function viewFromFile(path: string, model: DiagramModel): { id: string; kind: DiagramKind; title: string } | string {
  const stem = posix.basename(path, ".mmd");
  if (!isStableId(stem))
    return (
      `the file name "${stem}" is not a view ID (letters, digits, "-" and "_", starting with a letter or digit); ` +
      "rename the file, or list it in archer.toml under [[views]] with an id"
    );
  return { id: stem, kind: defaultKind(model), title: stem };
}
