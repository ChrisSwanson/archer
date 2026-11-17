// `archer init`: makes a directory an Archer project. Creates archer.toml and
// the Archer folder when they are missing, and adds a short marked section to
// AGENTS.md (and to CLAUDE.md when there is one) telling agents where the
// folder is and what it is for (ticket 09). Idempotent: a file that already
// has the section is left alone, whatever the section now says.
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { assertWriteAllowed } from "../config/write-policy.ts";
import { basename, join } from "node:path";
import { repositoryOf } from "./repository.ts";
import { ProjectError } from "./errors.ts";
import {
  DEFAULT_FOLDER,
  findProject,
  MANIFEST,
  MAX_TITLE_CHARS,
  readManifestFile,
  realOf,
  within,
  type Project,
} from "./project.ts";
import { publishConfined } from "./confined-fs.ts";

export const POINTER_BEGIN = "<!-- archer:begin -->";
export const POINTER_END = "<!-- archer:end -->";

export interface InitReport {
  readonly project: Project;
  /** Root-relative paths made by this run. */
  readonly created: string[];
  /** Root-relative files this run added the pointer to. */
  readonly updated: string[];
}

export function pointerSection(folderSetting: string): string {
  return `${POINTER_BEGIN}
## Archer

This project's diagrams (Mermaid) and notes (Markdown) live in \`${folderSetting}/\`.
A new diagram is embedded in the note it belongs to, as a \`\`\`mermaid block addressed as
\`<note path>#<name>\`; one that deserves its own file goes in its \`diagrams/\` folder as a
Mermaid file, and a new note in \`notes/\`.
Use them as reference documentation for the architecture, flows and decisions: read the ones
that concern a task before changing what they describe, and offer to update the ones it makes stale.
\`archer list\` shows what is there; the folder may be hidden from search tools by default.
${POINTER_END}
`;
}

/** The one line `archer init --docs` adds inside the marked section (docs/proposals/doc-pack.md, Hard rules). */
export function docsPointer(folderSetting: string): string {
  return `In docs mode: before architecture work, read \`${folderSetting}/index.md\` and only the file your question needs; the rules are \`archer docs docs-mode\`.`;
}

export interface InitOptions {
  /** `--docs`: set `mode = "docs"` and point agents at the router. Writes no files in the Archer folder. */
  readonly docs?: boolean;
}

export function initProject(dir: string, options: InitOptions = {}): InitReport {
  let project = findProject(dir);
  // archer init writes archer.toml, the Archer folder and the agents' pointer: all under `manifest`.
  assertWriteAllowed(project.root, "manifest");
  const created: string[] = [];
  const updated: string[] = [];

  if (project.manifest === null) {
    const manifest = join(project.root, MANIFEST);
    writeFileSync(
      manifest,
      `# Archer: diagrams and notes for this project live in the folder below.\nversion = 1\n${nameLine(project.root)}folder = "${DEFAULT_FOLDER}"\n${options.docs === true ? 'mode = "docs"\n' : ""}`,
      // Only its owner may change it: it decides where Archer reads and writes.
      { flag: "wx", mode: 0o644 },
    );
    created.push(MANIFEST);
    project = findProject(project.root);
  } else if (options.docs === true && project.mode !== "docs") {
    // Read and replaced through the confined seam: never through a link or a second name.
    publishConfined(
      project.root,
      [],
      MANIFEST,
      withModeLine(readManifestFile(project.root).bytes.toString("utf8")),
      MANIFEST,
    );
    updated.push(MANIFEST);
    project = findProject(project.root);
  }

  if (!existsSync(project.folder)) {
    mkdirSync(project.folder, { recursive: true });
    created.push(project.folderSetting);
  } else if (!statSync(project.folder).isDirectory()) {
    throw new ProjectError(
      "io_error",
      `${project.folderSetting} exists and is not a folder; move it aside or name another folder in archer.toml`,
    );
  }

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(project.root, name);
    const present = isPresent(path);
    if (!present && name === "CLAUDE.md") continue;
    if (present) {
      const real = realOf(path);
      if (!within(project.root, real))
        throw new ProjectError(
          "path_outside_project",
          `${name} leads outside the project (to ${real}); Archer leaves it alone`,
        );
    }
    const text = present ? readFileSync(path, "utf8") : "";
    if (text.includes(POINTER_BEGIN)) {
      // --docs adds its one line inside a section an earlier init wrote.
      const line = docsPointer(project.folderSetting);
      const end = text.indexOf(POINTER_END, text.indexOf(POINTER_BEGIN));
      if (options.docs === true && end >= 0 && !text.slice(0, end).includes(line)) {
        writeFileSync(realOf(path), `${text.slice(0, end)}${line}\n${text.slice(end)}`);
        updated.push(name);
      }
      continue;
    }
    // A CLAUDE.md that sends Claude to AGENTS.md already gets the pointer there.
    if (name === "CLAUDE.md" && /\bAGENTS\.md\b/.test(text)) continue;
    const gap = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    const section = pointerSection(project.folderSetting);
    const withDocs =
      options.docs === true
        ? section.replace(POINTER_END, `${docsPointer(project.folderSetting)}\n${POINTER_END}`)
        : section;
    writeFileSync(realOf(path), text + gap + withDocs);
    (present ? updated : created).push(name);
  }
  return { project, created, updated };
}

/**
 * `name = "<repository or folder>"`: the project is named after the app it documents (a
 * worktree after its main repository), never after a task's folder. A TOML basic string;
 * nothing when the name would not be a valid one.
 */
function nameLine(root: string): string {
  const name = (repositoryOf(root)?.name ?? basename(root)).trim();
  if (name === "" || name.length > MAX_TITLE_CHARS || /[\u0000-\u001f\u007f]/u.test(name)) return "";
  return `name = "${name.replace(/[\\"]/g, (character) => `\\${character}`)}"\n`;
}

/** archer.toml with `mode = "docs"` among the top-level keys: before the first table, or at the end. */
function withModeLine(text: string): string {
  const lines = text.split("\n");
  const table = lines.findIndex((line) => /^\s*\[/.test(line));
  if (table < 0) return `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}mode = "docs"\n`;
  // Above any blank lines and comments that introduce the table.
  let at = table;
  while (at > 0 && /^\s*(#.*)?$/.test(lines[at - 1] ?? "")) at--;
  lines.splice(at, 0, 'mode = "docs"');
  return lines.join("\n");
}

function isPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
