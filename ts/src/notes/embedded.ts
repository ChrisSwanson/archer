// The diagrams embedded in notes (docs/proposals/notes-with-embedded-diagrams.md):
// each mermaid fence of a note, under its note-scoped address
// (`notes/auth.md#login-flow`), compiled by the production compiler from the
// fence's body. A diagram's revision is its body's, so an edit to the prose
// around it changes nothing about it; its positions are lines of the note
// file, front matter included, so an agent can go straight to them.
import { WriteRuleDenied } from "../config/write-policy.ts";
import { withSourceWriterLock } from "../project/source-writer.ts";
import {
  archerIdOf,
  diagramAddress,
  isDiagramAddress,
  noteDiagrams,
  parseDiagramAddress,
  type NoteDiagram,
} from "../../../shared/note-diagrams.mts";
import type { EmbeddedDiagramSummary } from "../comments/contract.ts";
import { kindOfSource } from "../mermaid/preamble.ts";
import type { Diagnostic } from "../mermaid/diagnostics.ts";
import type { DiagramKind, Revision } from "../model/index.ts";
import {
  compileDiagramBytes,
  listNotes,
  MAX_NOTE_BYTES,
  readInFolderOrNull,
  revisionOf,
  splitFrontMatter,
  writeConfined,
  type CompiledDiagram,
  type Project,
} from "../project/index.ts";

export interface EmbeddedSummary extends EmbeddedDiagramSummary {
  readonly kind: DiagramKind;
  readonly sourceRevision: Revision;
}

export interface EmbeddedRead extends EmbeddedSummary {
  readonly notePath: string;
  /** The whole note file, as read. */
  readonly noteText: string;
  readonly noteRevision: Revision;
  /** Lines of front matter before the Markdown the fences were found in. */
  readonly lineOffset: number;
  readonly diagram: NoteDiagram;
  readonly source: string;
}

interface NoteText {
  readonly text: string;
  readonly revision: Revision;
}

/**
 * A note's bytes, or null when it is not a plain `.md` file inside the Archer folder within the size
 * limit. Read through the confined seam (readInFolder): no link followed on any segment, a regular file
 * with one name, opened without blocking and read from its descriptor, so a FIFO or device named like a
 * note can never stall the service's event loop and a file swapped or linked in from outside is refused.
 */
export function readNoteBytes(project: Project, notePath: string): Buffer | null {
  if (!notePath.endsWith(".md")) return null;
  return readInFolderOrNull(project, notePath, MAX_NOTE_BYTES);
}

export function readNoteText(project: Project, notePath: string): NoteText | null {
  const bytes = readNoteBytes(project, notePath);
  if (bytes === null) return null;
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      revision: revisionOf(bytes),
    };
  } catch {
    return null;
  }
}

/**
 * A diagram's revision: of its body's exact bytes (line endings included,
 * as a `.mmd`'s is of the file's). A diagram not yet named explicitly is
 * known only by its place, so its revision also holds its place among the
 * note's fences: when a fence is added or removed anywhere in the note, a
 * write to its old name is a conflict -- never a write to whichever fence
 * took the name, identical body or not. Prose edits move none of it.
 */
export function bodyRevision(rawBody: string, explicit: boolean, ordinal: number, fences: number): Revision {
  return revisionOf(Buffer.from(explicit ? rawBody : `archer-unpinned\0${ordinal}/${fences}\0${rawBody}`, "utf8"));
}

/** The Markdown after the front matter, and how many lines came before it. */
export function noteBody(text: string): { body: string; lineOffset: number } {
  const body = splitFrontMatter(text).body;
  const lineOffset = body === text ? 0 : text.split(/\r?\n/).length - body.split(/\r?\n/).length;
  return { body: body.replace(/^﻿/, ""), lineOffset };
}

function readAll(notePath: string, note: NoteText): { reads: EmbeddedRead[]; problems: string[] } {
  const { body, lineOffset } = noteBody(note.text);
  const { diagrams, problems } = noteDiagrams(body);
  const lines = note.text.split(/(?<=\n)/);
  const reads = diagrams.map((diagram): EmbeddedRead => {
    const first = lineOffset + diagram.bodyLine - 1;
    const rawBody = lines.slice(first, first + diagram.bodyLineCount).join("");
    // What compiles is the body as written, line endings and all; a nested
    // fence's lines carry its list or quote prefix, so its content is used.
    const source = diagram.writable ? rawBody.replace(/^\uFEFF/, "") : diagram.source;
    return {
      name: diagram.name,
      address: diagramAddress(notePath, diagram.name),
      explicit: diagram.explicit,
      ordinal: diagram.ordinal,
      heading: diagram.heading,
      kind: kindOfSource(diagram.source),
      line: lineOffset + diagram.fenceLine,
      bodyLine: lineOffset + diagram.bodyLine,
      writable: diagram.writable,
      sourceRevision: bodyRevision(rawBody, diagram.explicit, diagram.ordinal, diagrams.length),
      notePath,
      noteText: note.text,
      noteRevision: note.revision,
      lineOffset,
      diagram,
      source,
    };
  });
  // Problems are counted in lines of the Markdown; say them in lines of the file.
  const shifted = problems.map((p) => p.replace(/^line (\d+)/, (_m, n: string) => `line ${Number(n) + lineOffset}`));
  // A note whose path cannot spell an address (ADR 0012: no `?`, `#`, `:`,
  // control character, or past 1200 characters) offers no diagram at all.
  if (reads.length > 0 && !isDiagramAddress(reads[0]!.address))
    return {
      reads: [],
      problems: [
        ...shifted,
        `${notePath.slice(0, 200)} cannot name its diagrams: a note's path for a diagram address holds no ?, #, : or control character (ADR 0012); rename the note to open them`,
      ],
    };
  return { reads, problems: shifted };
}

const summaryOf = (read: EmbeddedRead): EmbeddedSummary => ({
  name: read.name,
  address: read.address,
  explicit: read.explicit,
  ordinal: read.ordinal,
  heading: read.heading,
  kind: read.kind,
  line: read.line,
  bodyLine: read.bodyLine,
  writable: read.writable,
  sourceRevision: read.sourceRevision,
});

/** The source of the diagram named `name` in a note's text (an earlier version of it), or null. */
export function embeddedSourceIn(notePath: string, text: string, name: string): string | null {
  return (
    readAll(notePath, { text, revision: revisionOf(Buffer.from(text, "utf8")) }).reads.find(
      (read) => read.name === name,
    )?.source ?? null
  );
}

/** The diagram named `name` in a note's text (an earlier version of the note), read as `notePath`'s, or null. */
export function embeddedReadIn(notePath: string, text: string, name: string): EmbeddedRead | null {
  return (
    readAll(notePath, { text, revision: revisionOf(Buffer.from(text, "utf8")) }).reads.find(
      (read) => read.name === name,
    ) ?? null
  );
}

/** The diagrams embedded in a note's text, read already. */
export function embeddedFromText(
  notePath: string,
  text: string,
  revision: Revision,
): { diagrams: EmbeddedSummary[]; problems: string[] } {
  const { reads, problems } = readAll(notePath, { text, revision });
  return { diagrams: reads.map(summaryOf), problems };
}

/** The diagrams embedded in the note at `notePath` (folder-relative); none when it cannot be read. */
export function embeddedDiagrams(
  project: Project,
  notePath: string,
): { diagrams: EmbeddedSummary[]; problems: string[] } {
  const note = readNoteText(project, notePath);
  if (note === null) return { diagrams: [], problems: [] };
  const { reads, problems } = readAll(notePath, note);
  return { diagrams: reads.map(summaryOf), problems };
}

/** The source of every diagram embedded in a note, by name; empty when the note cannot be read. One read of the note. */
export function embeddedSources(project: Project, notePath: string): Map<string, string> {
  const note = readNoteText(project, notePath);
  return new Map(note === null ? [] : readAll(notePath, note).reads.map((read) => [read.name, read.source]));
}

/** Every diagram embedded in a note, read now (one read and one parse of the note); empty when it cannot be read. */
export function readEmbeddedIn(project: Project, notePath: string): readonly EmbeddedRead[] {
  const note = readNoteText(project, notePath);
  return note === null ? [] : readAll(notePath, note).reads;
}

/** The diagram an address names, read now, or null when it names none. */
export function readEmbedded(project: Project, address: string): EmbeddedRead | null {
  const parsed = parseDiagramAddress(address);
  if (parsed === null) return null;
  const note = readNoteText(project, parsed.notePath);
  if (note === null) return null;
  return readAll(parsed.notePath, note).reads.find((r) => r.name === parsed.name) ?? null;
}

/** Shifts a diagnostic from lines of the fence body to lines of the note file. */
export function inNote(read: Pick<EmbeddedRead, "bodyLine">, d: Diagnostic): Diagnostic {
  const by = read.bodyLine - 1;
  return {
    ...d,
    span: {
      start: { ...d.span.start, line: d.span.start.line + by },
      end: { ...d.span.end, line: d.span.end.line + by },
    },
  };
}

/**
 * `source` as it is compiled: without its `%% archer-id:` line, and which
 * line of the body that was (1-based), so positions can be put back. Pinning
 * a name then changes neither the model nor its revision, and the page's
 * selection survives it.
 */
export function compiledSource(source: string): { text: string; removed: number | null } {
  const lines = source.split(/(?<=\n)/);
  for (let at = 0; at < lines.length; at++) {
    const trimmed = lines[at]!.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("%%")) break;
    if (archerIdOf(trimmed) !== null)
      return { text: [...lines.slice(0, at), ...lines.slice(at + 1)].join(""), removed: at + 1 };
  }
  return { text: source, removed: null };
}

/**
 * The diagram compiled as the view its address names (ADR 0012), titled by
 * its heading, with diagnostics at lines of the note file.
 */
export async function compileEmbedded(read: EmbeddedRead, source: string = read.source): Promise<CompiledDiagram> {
  const { text, removed } = compiledSource(source);
  const compiled = await compileDiagramBytes(
    {
      path: read.notePath,
      view: { id: read.address, kind: kindOfSource(source), title: read.heading ?? read.name, source: read.notePath },
    },
    Buffer.from(text, "utf8"),
  );
  const back = (line: number): number => (removed !== null && line >= removed ? line + 1 : line);
  const restored = compiled.diagnostics.map((d) => ({
    ...d,
    span: {
      start: { ...d.span.start, line: back(d.span.start.line) },
      end: { ...d.span.end, line: back(d.span.end.line) },
    },
  }));
  return { ...compiled, diagnostics: restored.map((d) => inNote(read, d)) };
}

/** Where the comments on an embedded diagram live: `<note stem>.<name>.comments.json` beside the note (ADR 0012). */
export function embeddedCommentsPath(notePath: string, name: string): string {
  return `${notePath.slice(0, -".md".length)}.${name}.comments.json`;
}

/**
 * Where a diagram's walkthroughs live (ADR 0034 §1): `a/x.walkthroughs.json`
 * beside `a/x.mmd`, and `<note stem>.<name>.walkthroughs.json` beside the note
 * for a diagram embedded in it, as comments are named.
 */
export function walkthroughsPathFor(source: string, embeddedName?: string): string {
  if (embeddedName !== undefined) return `${source.slice(0, -".md".length)}.${embeddedName}.walkthroughs.json`;
  const dot = source.lastIndexOf("."),
    slash = source.lastIndexOf("/");
  return `${dot > slash ? source.slice(0, dot) : source}.walkthroughs.json`;
}

/** Every diagram embedded in the notes the inventory lists, read now. */
export function allEmbedded(project: Project): EmbeddedRead[] {
  let notes: string[];
  try {
    notes = listNotes(project).map((n) => n.path);
  } catch {
    return [];
  }
  return notes.flatMap((notePath) => {
    const note = readNoteText(project, notePath);
    return note === null ? [] : readAll(notePath, note).reads;
  });
}

export type PinOutcome = "pinned" | "already" | "stale" | "nested" | "failed";

/**
 * Pins the diagram's name into its block with a `%% archer-id:` line, the
 * first time something must persist against it (a comment, an emphasis).
 * Never on a view or a selection.
 *
 * Only the id line is inserted, ending as the body's first line ends, so
 * every other byte -- and the compiled source, which leaves the line out --
 * stays the same: the model and its revision do not move. `seen` is the
 * revision the caller saw: a block that has changed, or that another block
 * has taken the name of since, is "stale" and left alone.
 */
export function pinEmbedded(project: Project, address: string, seen: Revision | null): PinOutcome {
  const initial = readEmbedded(project, address);
  if (initial === null || (seen !== null && initial.sourceRevision !== seen)) return "stale";
  if (initial.explicit) return "already";
  if (!initial.writable) return "nested";
  try {
    return withSourceWriterLock(project, initial.notePath, () => {
      const read = readEmbedded(project, address);
      if (read === null || (seen !== null && read.sourceRevision !== seen)) return "stale";
      if (read.explicit) return "already";
      if (!read.writable) return "nested";
      const lines = read.noteText.split(/(?<=\n)/);
      const at = read.bodyLine - 1;
      const ending = lines[at]?.endsWith("\r\n")
        ? "\r\n"
        : lines[at]?.endsWith("\n")
          ? "\n"
          : lines[at - 1]?.endsWith("\r\n")
            ? "\r\n"
            : "\n";
      const next = [...lines.slice(0, at), `%% archer-id: ${read.name}${ending}`, ...lines.slice(at)].join("");
      if (Buffer.byteLength(next, "utf8") > MAX_NOTE_BYTES) return "failed";
      const now = readNoteText(project, read.notePath);
      if (now === null || now.revision !== read.noteRevision) return "stale";
      try {
        writeConfined(project, read.notePath, next, "notes");
      } catch (failure) {
        if (failure instanceof WriteRuleDenied) throw failure;
        return "failed";
      }
      return "pinned";
    });
  } catch (failure) {
    // The account's rules refusing the pin is the caller's answer, not an unpinnable diagram.
    if (failure instanceof WriteRuleDenied) throw failure;
    return "failed";
  }
}
