// What `archer draw <name>` and its siblings accept, as the prototype's /draw
// did: a path to a `.mmd` file (relative to the working directory or to the
// Archer folder, or absolute), a view id from archer.toml, or a file's name
// without `.mmd` (or its folder path without it). A file outside the Archer
// folder is refused, however it is named.
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { ProjectError } from "./errors.ts";
import { listDiagrams, type DiagramEntry } from "./inventory.ts";
import { confine, readInFolder, type Project } from "./project.ts";

export interface ResolveOptions {
  /** Where a relative path is read from. */
  readonly cwd: string;
  /** Whether a diagram compiles; decides between files that share a name. */
  readonly compiles?: (project: Project, entry: DiagramEntry) => Promise<boolean>;
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

export async function resolveDiagram(project: Project, name: string, options: ResolveOptions): Promise<DiagramEntry> {
  const all = listDiagrams(project);
  const withView = (path: string): DiagramEntry => all.find((d) => d.path === path) ?? viewFor(project, path);

  if (name.endsWith(".mmd")) {
    const candidates = isAbsolute(name) ? [name] : [resolve(options.cwd, name), join(project.folder, name)];
    let refused: unknown;
    for (const candidate of candidates.filter(isFile)) {
      try {
        return withView(confine(project, candidate));
      } catch (error) {
        refused ??= error;
      }
    }
    if (refused !== undefined) throw refused;
  }

  const view = project.views.find((v) => v.id === name);
  if (view) return { path: view.source, view };

  const stem = name.replace(/\.mmd$/, "");
  const named = all.filter((d) => d.path.slice(0, -".mmd".length) === stem || posix.basename(d.path, ".mmd") === stem);
  if (named.length === 1 && named[0]) return named[0];
  const list = (entries: readonly DiagramEntry[]) => entries.map((d) => `  ${d.path}`).join("\n");
  if (named.length > 1) {
    // A name shared with a file that does not compile still picks the one that does.
    const compiles = options.compiles ?? compilesNow;
    const good: DiagramEntry[] = [];
    for (const entry of named) if (await compiles(project, entry)) good.push(entry);
    if (good.length === 1 && good[0]) return good[0];
    throw new ProjectError(
      "ambiguous_diagram",
      `"${name}" matches more than one diagram; give its path:\n${list(named)}`,
    );
  }
  throw new ProjectError(
    "diagram_not_found",
    all.length === 0
      ? `no diagram named "${name}": the Archer folder (${project.folderSetting}) has none yet`
      : `no diagram named "${name}" in ${project.folderSetting}. Diagrams here:\n${list(all)}`,
  );
}

function viewFor(project: Project, path: string): DiagramEntry {
  const view = project.views.find((v) => v.source === path);
  return view === undefined ? { path } : { path, view };
}

async function compilesNow(project: Project, entry: DiagramEntry): Promise<boolean> {
  let text: string;
  try {
    text = readInFolder(project, entry.path).toString("utf8");
  } catch {
    return false;
  }
  const { compile } = await import("../mermaid/index.ts");
  return (await compile(text)).model !== null;
}
