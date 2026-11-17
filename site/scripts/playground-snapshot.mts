import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PlaygroundProject, PlaygroundSnapshot } from "../../shared/playground-snapshot.mts";
import { installationAsset } from "../../ts/src/assets.ts";
import { FONT_LICENSE_ASSET } from "../../ts/src/export/resources.ts";
import { findProject, listNotes, readInFolder, readInFolderOrNull, readInProject } from "../../ts/src/project/index.ts";
import { ProjectState } from "../../ts/src/service/project-state.ts";
import { projectSummary } from "../../ts/src/service/project-summary.ts";
import { walkthroughsPlaces } from "../../ts/src/walkthroughs/store.ts";
import { readNoteSource } from "../../ts/src/notes/read.ts";
import { readEmbedded } from "../../ts/src/notes/embedded.ts";
import { revisionOf } from "../../ts/src/project/envelope.ts";

export interface SnapshotOptions {
  readonly repoRoot: string;
  readonly examplesRoot: string;
}

export const PLAYGROUND_PROJECTS = ["archer-tour", "rfc-2324-htcpcp", "rfc-1149-ipoac"] as const;

const digestOf = (bytes: string | Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const query = (name: string, params: Record<string, string>): string => `api/${name}?${new URLSearchParams(params)}`;

/** Build time only: no server, watcher, account store or browser compiler is started. */
export async function generatePlaygroundSnapshot(options: SnapshotOptions): Promise<PlaygroundSnapshot> {
  const sourceDigests: Record<string, string> = {};
  const projects: PlaygroundProject[] = [];
  const summaries: ReturnType<typeof projectSummary>[] = [];
  const browserSummaries: ReturnType<typeof projectSummary>[] = [];
  for (const slug of PLAYGROUND_PROJECTS) {
    const root = join(options.examplesRoot, slug);
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
      throw new Error(`Playground example ${slug} must be a plain directory`);
    if (!existsSync(join(root, "archer.toml"))) throw new Error(`Missing playground manifest ${slug}/archer.toml`);
    const project = findProject(root);
    if (project.root !== root || project.problems.length > 0)
      throw new Error(`Invalid playground example ${slug}: ${project.problems.map((p) => p.message).join("; ")}`);
    const sourceDigest = (path: string, bytes: Uint8Array): void => {
      sourceDigests[`${slug}/${path}`] = digestOf(bytes);
    };
    sourceDigest("archer.toml", readInProject(project, "archer.toml"));
    const folderPath = (path: string): string => relative(root, join(project.folder, path)).split("\\").join("/");
    const state = await ProjectState.open(
      root,
      () => "",
      () => {},
      { restoreState: false, projectName: () => slug },
    );
    try {
      const failures = state.compileStatus().failures;
      if (failures.length > 0)
        throw new Error(`Cannot compile playground example ${slug}: ${JSON.stringify(failures)}`);
      const documents = state.documentCatalog();
      if (!documents.complete || documents.diagnostics.length > 0)
        throw new Error(`Invalid playground documents ${slug}: ${JSON.stringify(documents.diagnostics)}`);
      const responses: Record<string, unknown> = {
        "api/diagrams": state.inventory(),
        "api/compile": state.compileStatus(),
        "api/bootstrap": state.bootstrap(),
        "api/documents": documents,
        "api/notes/all": state.allNotes(),
        "api/comment-activity": state.commentActivity(),
        "api/comments/pending": state.pendingComments(),
      };
      const toolSources: Record<string, PlaygroundProject["toolSources"][string]> = {};
      for (const entry of documents.documents) {
        const content = await state.readDocument(entry.source.path);
        if (content === null) throw new Error(`Missing playground document ${slug}/${entry.source.path}`);
        responses[query("documents/content", { path: entry.source.path })] = content;
        sourceDigest(entry.source.path, readInProject(project, entry.source.path));
      }
      const notes = listNotes(project);
      for (const note of notes) {
        if (note.problems.length > 0)
          throw new Error(`Invalid playground note ${slug}/${note.path}: ${note.problems.join("; ")}`);
        const content = await state.noteWithFreshness(note.path);
        if (content.diagramProblems?.length)
          throw new Error(`Invalid embedded diagram ${slug}/${note.path}: ${content.diagramProblems.join("; ")}`);
        responses[query("notes/content", { path: note.path })] = content;
        const exact = readNoteSource(project, note.path);
        toolSources[`note:${note.path}`] = {
          notePath: exact.notePath,
          sourceRevision: exact.sourceRevision,
          source: exact.source,
        };
        responses[query("comments", { target: `note:${note.path}` })] = state.listComments(`note:${note.path}`);
        responses[query("note-emphases", { path: note.path })] = state.noteEmphases(note.path);
        sourceDigest(folderPath(note.path), readInFolder(project, note.path));
        for (const diagram of content.diagrams ?? []) {
          const embedded = await state.embeddedDiagram(diagram.address);
          if (embedded?.envelope == null || embedded.diagnostics.some((d) => d.severity === "error"))
            throw new Error(`Cannot compile playground embedded diagram ${slug}/${diagram.address}`);
          responses[query("notes/diagram", { address: diagram.address })] = embedded;
        }
      }
      const inventory = state.inventory();
      const places = walkthroughsPlaces(
        inventory.views.map((view) => {
          if (view.sourcePath === undefined) throw new Error(`Missing playground source path ${slug}/${view.id}`);
          return {
            id: view.id,
            path: view.sourcePath,
            ...(view.name === undefined ? {} : { embedded: { name: view.name } }),
          };
        }),
      );
      for (const view of inventory.views) {
        const envelope = state.envelope(view.id);
        if (envelope === null) throw new Error(`Missing playground envelope ${slug}/${view.id}`);
        const walks = state.walkthroughsFor(view.id);
        if (
          walks.deadCode.length > 0 ||
          walks.resolution?.some((walk) => walk.steps.some((step) => step.status === "out-of-date"))
        )
          throw new Error(`Invalid playground walkthrough references ${slug}/${view.id}`);
        for (const walk of walks.walkthroughs)
          if (walk.note !== undefined && !notes.some((note) => note.path === walk.note))
            throw new Error(`Missing playground walkthrough note ${slug}/${walk.note}`);
        responses[`api/diagrams/${encodeURIComponent(view.id)}`] = envelope;
        const source = await state.diagramSource(view.id);
        if (source === null) throw new Error(`Missing playground source ${slug}/${view.id}`);
        responses[`api/diagram-source/${encodeURIComponent(view.id)}`] = source;
        const embeddedSource = view.name === undefined ? null : readEmbedded(project, view.id);
        toolSources[`view:${view.id}`] = {
          sourceRevision: embeddedSource?.sourceRevision ?? revisionOf(Buffer.from(source.source, "utf8")),
          modelRevision: envelope.revision,
          source: { status: "text", text: source.source },
        };
        responses[`api/emphasis/${encodeURIComponent(view.id)}`] = state.emphasisPayload(view.id);
        responses[query("walkthroughs", { viewId: view.id })] = withoutCommits(walks);
        responses[query("notes", { viewId: view.id })] = state.notesFor(view.id);
        responses[query("comments", { target: `view:${view.id}` })] = state.listComments(`view:${view.id}`);
        if (view.sourcePath === undefined) throw new Error(`Missing playground source path ${slug}/${view.id}`);
        sourceDigest(folderPath(view.sourcePath), readInFolder(project, view.sourcePath));
        const sidecar = places.get(view.id)!.path;
        const bytes = readInFolderOrNull(project, sidecar);
        if (bytes !== null) sourceDigest(folderPath(sidecar), bytes);
      }
      responses[query("comments", { target: "project:" })] = state.listComments("project:");
      const notice = existsSync(join(root, "NOTICE.md"))
        ? readInProject(project, "NOTICE.md").toString("utf8")
        : undefined;
      // The README and the casebook link to the notice, so the example's discovery lists it (and the catalog loop
      // above serves it); a notice it does not list would leave those links unavailable.
      if (notice !== undefined && !documents.documents.some((document) => document.source.path === "NOTICE.md"))
        throw new Error(`The playground example ${slug} has a NOTICE.md its discovery does not list`);
      projects.push({ slug, name: state.name, ...(notice === undefined ? {} : { notice }), responses, toolSources });
      const lifecycle = { state: "active", visibility: "visible" } as const;
      // Static examples never inherit the checkout's worktree identity.
      const { worktree: _worktree, ...summary } = projectSummary(state, lifecycle, false);
      const { worktree: _browserWorktree, ...browserSummary } = projectSummary(state, lifecycle, true);
      summaries.push(exampleFacts(summary, slug));
      browserSummaries.push(exampleFacts(browserSummary, slug));
    } finally {
      state.close();
    }
  }
  const catalog = { schemaVersion: 1, projects: summaries };
  const browserCatalog = { schemaVersion: 1, projects: browserSummaries };
  const completeProjects = projects.map((project) => ({
    ...project,
    responses: { ...project.responses, "api/projects": catalog, "api/browser-projects": browserCatalog },
  }));
  const packageJson = JSON.parse(await readFile(join(options.repoRoot, "ts/package.json"), "utf8")) as {
    version: string;
  };
  const provenance = {
    appVersion: packageJson.version,
    compilerVersion: packageJson.version,
    schemaVersion: 2,
    sourceDigests: Object.fromEntries(Object.entries(sourceDigests).sort(([a], [b]) => a.localeCompare(b))),
  };
  const fontLicense = installationAsset(`export/${FONT_LICENSE_ASSET}`).toString("utf8");
  const digest = digestOf(JSON.stringify({ ...provenance, projects: completeProjects, fontLicense }));
  return { formatVersion: 1, manifest: { ...provenance, digest }, projects: completeProjects, fontLicense };
}

/**
 * A published example names no folder or checkout of the machine that built it: its folder reads as an example
 * project's would (`~/code/<slug>`), and it has no Git facts (the examples are not repositories of their own; the
 * builder's branch and commit would otherwise show in the project header).
 */
function exampleFacts<T extends { readonly facts?: unknown }>(summary: T, slug: string): T {
  if (summary.facts === null || typeof summary.facts !== "object") return summary;
  const { git: _git, ...facts } = summary.facts as Record<string, unknown>;
  return { ...summary, facts: { ...facts, projectFolder: `~/code/${slug}` } };
}

/**
 * A walkthrough's recorded `commit` (ADR 0034 §3) is the example repository's private history: the public site is
 * exported from another repository, and the Playground finds no old version by it (it has no Git). It is optional.
 */
function withoutCommits<T extends { readonly walkthroughs: readonly object[] }>(walks: T): T {
  return {
    ...walks,
    walkthroughs: walks.walkthroughs.map((walk) => {
      const { commit: _commit, ...rest } = walk as { commit?: string };
      return rest;
    }),
  };
}

export function serializePlaygroundSnapshot(snapshot: unknown): string {
  return JSON.stringify(snapshot)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
