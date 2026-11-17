// The project side of the tools: which views the Archer folder holds, what is
// in a view's file, and compiling it. Read fresh from disk on every call, so an
// edit to archer.toml or a file is seen at once; the only state kept is the
// last model each view compiled to, which read_diagram returns beside a
// source that no longer compiles (as Rust 0.3 keeps its last valid envelope).
import { WriteRuleDenied } from "../config/write-policy.ts";
import { posix } from "node:path";
import type { Diagnostic } from "../mermaid/index.ts";
import { compile } from "../mermaid/index.ts";
import { MAX_SOURCE_BYTES } from "../mermaid/limits.ts";
import { kindOfSource } from "../mermaid/preamble.ts";
import {
  describeModel,
  isStableId,
  kindFits,
  type DiagramEnvelope,
  type DiagramKind,
  type DiagramModel,
  type Revision,
} from "../model/index.ts";
import {
  compileDiagram,
  findProject,
  listDiagrams,
  ProjectError,
  readInFolder,
  revisionOf,
  splitFrontMatter,
  type DiagramEntry,
  type Project,
  type View,
  type CompiledDiagram,
} from "../project/index.ts";
import { commentsPathFor } from "../comments/store.ts";
import {
  allEmbedded,
  compileEmbedded,
  embeddedCommentsPath,
  readEmbedded,
  type EmbeddedRead,
} from "../notes/embedded.ts";
import { toolError, type ErrorCode } from "./errors.ts";

export interface ViewEntry {
  readonly id: string;
  readonly kind: DiagramKind;
  readonly title: string;
  /**
   * Listed in archer.toml (`durable`), a file named by its file name
   * (`ephemeral`), or a mermaid block in a note named by its address
   * (`embedded`, ADR 0012).
   */
  readonly registration: "durable" | "ephemeral" | "embedded";
  /** Relative to the Archer folder: for an embedded diagram, its note. */
  readonly source: string;
  readonly view?: View;
  /** For an embedded diagram: its name in its note. */
  readonly name?: string;
  /** For an embedded diagram: its note's front matter `status` and `based-on` (ADR 0036 A1). */
  readonly status?: string;
  readonly basedOn?: string;
}

/** A diagnostic as the tools send it: the compiler's own shape. */
export type WireDiagnostic =
  | Diagnostic
  | { readonly code: string; readonly severity: "error"; readonly message: string };

export function summary(view: ViewEntry): Record<string, unknown> {
  return {
    id: view.id,
    kind: view.kind,
    title: view.title,
    registration: view.registration,
    source: view.source,
    ...(view.view?.covers === undefined ? {} : { covers: view.view.covers }),
  };
}

export function diagnosticLine(d: WireDiagnostic): string {
  return "span" in d
    ? `[${d.code}] line ${d.span.start.line}:${d.span.start.column}: ${d.message}`
    : `[${d.code}] ${d.message}`;
}

/** A project-level refusal as the tool error that carries it. */
export function projectFailure(error: unknown): unknown {
  if (!(error instanceof ProjectError)) return error;
  const code: ErrorCode = (
    {
      manifest_error: "manifest_error",
      untrusted_manifest: "untrusted_manifest",
      path_outside_archer_folder: "path_outside_archer_folder",
      path_outside_project: "path_outside_archer_folder",
      diagram_not_found: "diagram_not_found",
      ambiguous_diagram: "invalid_request",
      io_error: "io_failure",
      write_rule_denied: "write_rule_denied",
    } as const
  )[error.code];
  const failure = toolError(code, error.message, error instanceof WriteRuleDenied ? { rule: error.rule } : {});
  // The configuration's own diagnostic stays off the wire (it can name the file): only the local
  // CLI reads it, from this non-enumerable property.
  if (error instanceof WriteRuleDenied && error.detail !== undefined)
    Object.defineProperty(failure, "localDetail", { value: error.detail });
  return failure;
}

export function openProject(cwd: string): Project {
  try {
    return findProject(cwd);
  } catch (error) {
    throw projectFailure(error);
  }
}

function sniffKind(project: Project, path: string): DiagramKind {
  try {
    return kindOfSource(readInFolder(project, path, MAX_SOURCE_BYTES).toString("utf8"));
  } catch {
    return "freeform";
  }
}

/** Every view of the project, and why any file or manifest entry is not one. */
export function inventory(project: Project): { views: ViewEntry[]; problems: WireDiagnostic[] } {
  const { views, problems } = inventoryWithReads(project);
  return { views, problems };
}

/** `inventory`, with each embedded view's block as read for it, by address. */
export function inventoryWithReads(project: Project): {
  views: ViewEntry[];
  problems: WireDiagnostic[];
  embedded: ReadonlyMap<string, EmbeddedRead>;
} {
  const problems: WireDiagnostic[] = project.problems.map((p) => ({
    code: "manifest_error",
    severity: "error" as const,
    message: `archer.toml view ${p.position}${p.id === null ? "" : ` ("${p.id}")`} was not loaded: ${p.message}`,
  }));
  const durable: ViewEntry[] = project.views.map((view) => ({
    id: view.id,
    kind: view.kind,
    title: view.title,
    registration: "durable",
    source: view.source,
    view,
  }));
  const taken = new Set(durable.map((v) => v.id));
  const byStem = new Map<string, string[]>();
  for (const entry of listDiagrams(project)) {
    if (entry.view !== undefined) continue;
    const stem = posix.basename(entry.path, ".mmd");
    if (!isStableId(stem)) {
      problems.push({
        code: "invalid_view_id",
        severity: "error",
        message: `${entry.path}: the file name "${stem}" is not a view id (letters, digits, "-" and "_", starting with a letter or digit); rename the file, or give it an id with register_diagram`,
      });
      continue;
    }
    byStem.set(stem, [...(byStem.get(stem) ?? []), entry.path]);
  }
  const ephemeral: ViewEntry[] = [];
  for (const [stem, paths] of byStem) {
    if (taken.has(stem) || paths.length > 1) {
      problems.push({
        code: "ambiguous_view_id",
        severity: "error",
        message:
          `${[...(taken.has(stem) ? [`archer.toml's view "${stem}"`] : []), ...paths].join(" and ")} would all be view "${stem}"; ` +
          `${paths.join(", ")} cannot be presented until it is given another id with register_diagram, or renamed`,
      });
      continue;
    }
    const path = paths[0] ?? "";
    ephemeral.push({ id: stem, kind: sniffKind(project, path), title: stem, registration: "ephemeral", source: path });
  }
  // Diagrams embedded in notes, under their addresses (ADR 0012): never
  // the same id as a file view, since an address holds a `#`.
  const reads = allEmbedded(project);
  const fronts = new Map<string, { status?: string; basedOn?: string }>();
  const embedded: ViewEntry[] = reads.map((read) => {
    let front = fronts.get(read.notePath);
    if (front === undefined) fronts.set(read.notePath, (front = splitFrontMatter(read.noteText).fields));
    return {
      id: read.address,
      kind: read.kind,
      title: read.heading ?? read.name,
      registration: "embedded",
      source: read.notePath,
      name: read.name,
      ...(front.status === undefined ? {} : { status: front.status }),
      ...(front.basedOn === undefined ? {} : { basedOn: front.basedOn }),
    };
  });
  const views = [...durable, ...ephemeral.sort((a, b) => a.source.localeCompare(b.source)), ...embedded];
  return { views, problems, embedded: new Map(reads.map((read) => [read.address, read])) };
}

export function findView(project: Project, viewId: string, tool: string): ViewEntry {
  return findViewIn(inventory(project).views, project, viewId, tool);
}

/** `findView` over an inventory already in hand. */
export function findViewIn(views: readonly ViewEntry[], project: Project, viewId: string, tool: string): ViewEntry {
  const view = views.find((v) => v.id === viewId);
  if (view !== undefined) return view;
  const advice =
    tool === "write_diagram" || tool === "validate_diagram"
      ? " For a new diagram, embed it in a note by default (a top-level ```mermaid block in notes/<file>.md whose first line is %% archer-id: <name>) and use notes/<file>.md#<name>; a diagram that needs its own file is diagrams/<name>.mmd, the view <name>."
      : "";
  throw toolError(
    "diagram_not_found",
    `no diagram view is named '${viewId}' in the Archer folder (${project.folderSetting}). Call list_diagrams to see the views.${advice}`,
  );
}

/**
 * Whether `view`, found in an earlier listing, is still what its id names in `project`, from the manifest
 * alone: a registered view keeps its source, a file-named one is not registered under that id since.
 * Callers confirm the file itself (its real path and revision); nothing here lists the folder.
 */
export function stillSameView(project: Project, view: ViewEntry): boolean {
  const registered = project.views.find((v) => v.id === view.id);
  return view.registration === "durable"
    ? registered !== undefined && registered.source === view.source
    : registered === undefined;
}

export const entryOf = (view: ViewEntry): DiagramEntry =>
  view.view === undefined ? { path: view.source } : { path: view.source, view: view.view };

export type SourceOnDisk =
  | { readonly status: "text"; readonly text: string; readonly revision: Revision }
  | { readonly status: "not-utf8"; readonly revision: Revision }
  | { readonly status: "too-large"; readonly bytes: number; readonly revision: Revision }
  | { readonly status: "missing" }
  | { readonly status: "unreadable"; readonly reason: string };

export function readSource(project: Project, view: ViewEntry): SourceOnDisk {
  let bytes: Buffer;
  try {
    // The confined seam (G6): no link followed, one name, read from the descriptor.
    bytes = readInFolder(project, view.source);
  } catch (error) {
    if (error instanceof ProjectError) return { status: "unreadable", reason: error.message };
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { status: "missing" }
      : { status: "unreadable", reason: `it cannot be read (${code ?? "unknown error"})` };
  }
  const revision = revisionOf(bytes);
  if (bytes.length > MAX_SOURCE_BYTES) return { status: "too-large", bytes: bytes.length, revision };
  try {
    return { status: "text", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), revision };
  } catch {
    return { status: "not-utf8", revision };
  }
}

/** The last model each view compiled to in this session, by view id and source. */
export class ModelCache {
  private readonly models = new Map<string, DiagramEnvelope>();
  private key = (view: ViewEntry) => `${view.id}\0${view.source}`;

  async compile(project: Project, view: ViewEntry): Promise<CompiledDiagram> {
    const compiled =
      view.registration === "embedded"
        ? await compileEmbeddedView(project, view)
        : await compileDiagram(project, entryOf(view));
    if (compiled.envelope !== null) this.models.set(this.key(view), compiled.envelope);
    return compiled;
  }

  last(view: ViewEntry): DiagramEnvelope | null {
    return this.models.get(this.key(view)) ?? null;
  }
}

/** Compiles `text` as `view`'s source would compile, without writing it. */
export async function compileText(
  view: ViewEntry,
  text: string,
): Promise<{ valid: boolean; diagnostics: Diagnostic[]; model?: DiagramModel }> {
  const { model, diagnostics } = await compile(text);
  if (model === null) return { valid: false, diagnostics };
  // The kind archer.toml declares must match the diagram, as compileDiagram checks.
  if (view.view !== undefined && !kindFits(view.kind, model)) {
    const what = describeModel(model);
    return {
      valid: false,
      diagnostics: [
        ...diagnostics,
        {
          code: "kind_model_mismatch",
          severity: "error",
          message: `view "${view.id}" is declared as kind ${view.kind} in archer.toml, but this source is ${what}; change the kind with register_diagram or the diagram`,
          span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        },
      ],
    };
  }
  return { valid: true, diagnostics, model };
}

/** An embedded view compiled from its block as it is now, or source_missing when its address names no block. */
async function compileEmbeddedView(project: Project, view: ViewEntry): Promise<CompiledDiagram> {
  const read = readEmbedded(project, view.id);
  if (read !== null) return compileEmbedded(read);
  return {
    path: view.source,
    revision: null,
    envelope: null,
    diagnostics: [
      {
        code: "source_missing",
        severity: "error",
        message: `${view.id} names no diagram in ${view.source} now: it was renamed, moved or deleted`,
        span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      },
    ],
  };
}

/** The comments file of a view (folder-relative): beside its diagram, or its note for an embedded one. */
export const commentPathForView = (view: ViewEntry): string =>
  view.registration === "embedded" ? embeddedCommentsPath(view.source, view.name ?? "") : commentsPathFor(view.source);
