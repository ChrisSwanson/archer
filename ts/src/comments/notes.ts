// Notes for the page (ticket 09): which notes are about a view, and a note's
// content with its front matter split out. Only notes the inventory lists
// are served, so a path is always a `.md` inside the Archer folder that is
// not hidden; anything else is "not found", whatever the reason.
import { posix } from "node:path";
import {
  listNotes,
  MAX_NOTE_BYTES,
  readInFolderOrNull,
  revisionOf,
  splitFrontMatter,
  type NoteEntry,
  type Project,
} from "../project/index.ts";
import { embeddedFromText } from "../notes/embedded.ts";
import { noteDescription } from "../project/describe.ts";
import type { FileDates } from "../project/file-dates.ts";
import type { AllNotes, NoteContent, NoteListing, NoteSummary, NotesForView, ThreadStatus } from "./contract.ts";

export class NoteNotFound extends Error {
  readonly code = "note_not_found";
  override name = "NoteNotFound";
}

/** The inventory's notes, or none when the folder cannot be walked. */
export function notesOf(project: Project): NoteEntry[] {
  try {
    return listNotes(project);
  } catch {
    return [];
  }
}

/** A note's bytes, or null when it is gone, unreadable or too large. */
export function noteBytes(project: Project, path: string): Buffer | null {
  // The confined seam: no link followed, one name, read from the descriptor (G6; ADR 0018 amended 2026-10-31).
  return readInFolderOrNull(project, path, MAX_NOTE_BYTES);
}

/** A note's Markdown after its front matter, or null. */
export function noteMarkdown(project: Project, path: string): string | null {
  const bytes = noteBytes(project, path);
  return bytes === null ? null : splitFrontMatter(bytes.toString("utf8")).body;
}

/** The notes about the diagram at `source` (folder-relative). */
export function notesForView(
  project: Project,
  viewId: string,
  source: string,
  notes: readonly NoteEntry[] = notesOf(project),
): NotesForView {
  return {
    viewId,
    notes: notes
      .filter((n) => n.diagrams.includes(source))
      .map((n): NoteSummary => {
        return {
          path: n.path,
          title: noteTitle(project, n.path),
          ...(n.type === undefined ? {} : { type: n.type }),
          ...(n.status === undefined ? {} : { status: n.status }),
        };
      }),
  };
}

/**
 * Every note in the Archer folder, those about no diagram among them, with
 * the views each is about. `viewsBySource` maps a folder-relative source path
 * to the views drawn from it.
 */
export function allNotes(
  project: Project,
  viewsBySource: ReadonlyMap<string, readonly string[]>,
  notes: readonly NoteEntry[] = notesOf(project),
  dates: (path: string) => FileDates = () => ({}),
  threads: (path: string) => Readonly<Record<ThreadStatus, number>> | null = () => null,
): AllNotes {
  return {
    notes: notes.map((n): NoteListing => {
      const viewIds = [...new Set(n.diagrams.flatMap((source) => viewsBySource.get(source) ?? []))].sort();
      const text = noteBytes(project, n.path)?.toString("utf8") ?? null;
      const split = text === null ? null : splitFrontMatter(text);
      const heading = split === null ? null : firstHeading(split.body);
      const author = split?.fields.author;
      const counts = threads(n.path);
      return {
        path: n.path,
        title: heading ?? posix.basename(n.path),
        ...(n.type === undefined ? {} : { type: n.type }),
        ...(n.status === undefined ? {} : { status: n.status }),
        diagrams: [...n.diagrams],
        viewIds,
        ...(counts === null ? {} : { threads: counts }),
        ...dates(n.path),
        ...((text === null ? null : noteDescription(text)) ?? {}),
        ...(author === "agent" || author === "person" ? { author } : {}),
      };
    }),
  };
}

/** A note's title: its first heading, else its file name. */
export function noteTitle(project: Project, path: string): string {
  const markdown = noteMarkdown(project, path);
  return (markdown === null ? null : firstHeading(markdown)) ?? posix.basename(path);
}

export function noteContent(project: Project, path: string): NoteContent {
  const listed = notesOf(project).some((n) => n.path === path);
  const bytes = listed ? noteBytes(project, path) : null;
  if (bytes === null)
    throw new NoteNotFound(
      `no note ${JSON.stringify(path.slice(0, 200))} in the Archer folder (${project.folderSetting})`,
    );
  const text = bytes.toString("utf8");
  const { fields, body } = splitFrontMatter(text);
  const revision = revisionOf(bytes);
  const { diagrams, problems } = embeddedFromText(path, text, revision);
  return {
    path,
    frontMatter: { ...fields },
    markdown: body,
    revision,
    ...(diagrams.length === 0 ? {} : { diagrams }),
    ...(problems.length === 0 ? {} : { diagramProblems: problems }),
  };
}

/** The text of the first ATX heading outside code fences, or null. Linear in the text. */
export function firstHeading(markdown: string): string | null {
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.length - trimmed.length > 3 || !trimmed.startsWith("#")) continue;
    let level = 0;
    while (trimmed[level] === "#") level++;
    if (level > 6 || (trimmed[level] !== " " && trimmed[level] !== "\t" && trimmed[level] !== undefined)) continue;
    const content = trimmed.slice(level).trim();
    // A closing run of `#` counts only after a space: `# C#` keeps its `#`.
    let end = content.length;
    while (end > 0 && content[end - 1] === "#") end--;
    const text = (
      end === 0 || content[end - 1] === " " || content[end - 1] === "\t" ? content.slice(0, end) : content
    ).trim();
    if (text !== "") return text;
  }
  return null;
}
