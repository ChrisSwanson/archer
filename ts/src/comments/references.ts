// The exact references a thread carries to the agent (wave 2, ticket 08): where in the project it is about,
// so the agent can open the file and understand the context without guessing.
//
// - `file`: the file, relative to the project root (`.archer/notes/auth.md`); none for the project conversation
//   and for a diagram that is gone.
// - `address`: the diagram's address, `flow` or `notes/auth.md#login` for one embedded in a note (ADR 0012).
// - `anchored`: every element the thread is anchored to, with the id and the label it has now.
// - `lines`: lines of `file`. Of a diagram: the lines that mention the anchored elements' ids (first to last),
//   else the diagram's whole source, or its fence body in a note. Of a note passage: where the quote sits.
//   Absent when nothing resolves. It is a pointer to read, not a proof: an id is found as a whole word.
// - `page`, `document`: where the person sent their latest comment from (`Comment.context`).
import { posix } from "node:path";
import type { ViewEntry } from "../application/diagrams.ts";
import { locatePassage } from "../../../shared/note-markdown.mts";
import { parseDiagramAddress } from "../../../shared/note-diagrams.mts";
import { noteBody, readEmbeddedIn, readNoteText, type EmbeddedRead } from "../notes/embedded.ts";
import { MAX_SOURCE_BYTES } from "../mermaid/limits.ts";
import { readInFolderOrNull, type Project } from "../project/index.ts";
import { PROJECT_TARGET, type Anchor, type Thread } from "./contract.ts";
import { renderedNoteLines, renderedNoteText } from "./note-text.ts";
import type { blockContents, SequenceNote } from "./sequence-blocks.ts";

export interface AnchoredRef {
  readonly kind: "node" | "edge" | "group" | "walkthrough" | "step" | "passage";
  readonly id?: string;
  readonly label?: string;
  /** For a step: its walkthrough. For a passage: nothing else. */
  readonly walkthrough?: string;
  readonly quote?: string;
}

export interface ThreadReferences {
  readonly target: string;
  readonly file?: string;
  readonly address?: string;
  readonly anchored: readonly AnchoredRef[];
  readonly lines?: { readonly start: number; readonly end: number };
  readonly page?: string;
  readonly document?: string;
  /** Verified current whole sequence scope; absent for an orphan or an unavailable model. */
  readonly sequenceBlock?: ReturnType<typeof blockContents> & { readonly modelRevision: string };
  /** Verified current sequence annotation; never a selection or emphasis target. */
  readonly sequenceNote?: {
    readonly text: string;
    readonly position: SequenceNote["note"]["position"];
    readonly participants: SequenceNote["participants"];
    readonly block?: SequenceNote["block"];
    readonly modelRevision: string;
  };
}

/** The elements an anchor names, in the order the thread gives them. */
export function anchoredOf(anchor: Anchor): AnchoredRef[] {
  switch (anchor.kind) {
    case "view":
    case "project":
      return [];
    case "node":
    case "edge":
    case "group":
      return [{ kind: anchor.kind, id: anchor.id, label: anchor.label }];
    case "selection":
      return [
        ...anchor.nodes.map((n) => ({ kind: "node" as const, id: n.id, label: n.label })),
        ...anchor.edges.map((e) => ({ kind: "edge" as const, id: e.id, label: e.label })),
      ];
    case "walkthrough":
      return [{ kind: "walkthrough", id: anchor.walkthrough, label: anchor.label }];
    case "step":
      return [{ kind: "step", id: anchor.step, label: anchor.label, walkthrough: anchor.walkthrough }];
    case "passage":
      return [{ kind: "passage", quote: anchor.quote }];
  }
}

/**
 * What finding references reads from disk, once per `get_comments` call however many threads ask (finding 11):
 * the inventory only when a thread on a diagram needs it, each diagram file, each note's embedded blocks and
 * each note's rendered text and line index.
 */
export interface ReferenceSources {
  readonly views: () => readonly ViewEntry[];
  /** A durable diagram's source text (folder-relative path), or null when it is not a readable regular file. */
  readonly source: (folderRelative: string) => string | null;
  readonly embeddedIn: (notePath: string) => readonly EmbeddedRead[];
  readonly note: (notePath: string) => string | null;
}

export function diskReferenceSources(project: Project, views: () => readonly ViewEntry[]): ReferenceSources {
  return {
    views,
    source: (folderRelative) => {
      const bytes = readInFolderOrNull(project, folderRelative, MAX_SOURCE_BYTES);
      if (bytes === null) return null;
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return null;
      }
    },
    embeddedIn: (notePath) => readEmbeddedIn(project, notePath),
    note: (notePath) => readNoteText(project, notePath)?.text ?? null,
  };
}

/** A note as references read it: where its Markdown starts, and its rendered text traced to source lines. */
interface ReadNote {
  readonly lineOffset: number;
  readonly text: string;
  readonly lineOf: ((offset: number) => number | null) | null;
}

/** The per-call reader: every read memoized, the inventory and the view lookup built on first use. */
export class ReferenceReads {
  readonly #from: ReferenceSources;
  #views: ReadonlyMap<string, ViewEntry> | undefined;
  readonly #sources = new Map<string, string | null>();
  readonly #embedded = new Map<string, readonly EmbeddedRead[]>();
  readonly #notes = new Map<string, ReadNote | null>();

  constructor(from: ReferenceSources) {
    this.#from = from;
  }

  view(id: string): ViewEntry | undefined {
    this.#views ??= new Map(this.#from.views().map((v) => [v.id, v]));
    return this.#views.get(id);
  }

  source(folderRelative: string): string | null {
    if (!this.#sources.has(folderRelative)) this.#sources.set(folderRelative, this.#from.source(folderRelative));
    return this.#sources.get(folderRelative)!;
  }

  embedded(address: string): EmbeddedRead | null {
    const parsed = parseDiagramAddress(address);
    if (parsed === null) return null;
    let reads = this.#embedded.get(parsed.notePath);
    if (reads === undefined) this.#embedded.set(parsed.notePath, (reads = this.#from.embeddedIn(parsed.notePath)));
    return reads.find((r) => r.name === parsed.name) ?? null;
  }

  note(path: string): ReadNote | null {
    if (!this.#notes.has(path)) {
      const raw = this.#from.note(path);
      if (raw === null) this.#notes.set(path, null);
      else {
        const { body, lineOffset } = noteBody(raw);
        const text = renderedNoteText(body);
        this.#notes.set(path, { lineOffset, text, lineOf: renderedNoteLines(body, text) });
      }
    }
    return this.#notes.get(path)!;
  }
}

/** What to tell the agent about where `thread` is. `reads` is shared by every thread of one call. */
export function referencesFor(project: Project, thread: Thread, reads: ReferenceReads): ThreadReferences {
  const anchored = anchoredOf(thread.anchor);
  const latest = [...thread.comments].reverse().find((c) => c.author === "person" && c.context !== undefined)?.context;
  const sentFrom =
    latest === undefined
      ? {}
      : { page: latest.page, ...(latest.document === undefined ? {} : { document: latest.document }) };
  const base = { target: thread.target, anchored, ...sentFrom };
  if (thread.target === PROJECT_TARGET) return base;
  try {
    const refs = thread.target.startsWith("note:")
      ? { ...base, ...noteReferences(project, thread.target.slice(5), thread.anchor, reads) }
      : { ...base, ...viewReferences(project, thread.target.slice(5), anchored, reads) };
    if (thread.orphaned === true && (thread.anchor.kind === "group" || thread.identity !== undefined)) {
      const { lines: _lines, ...withoutCurrentLines } = refs;
      return withoutCurrentLines;
    }
    return refs;
  } catch {
    // A file that cannot be read has no lines to point at; the rest still reads.
    return base;
  }
}

const inProject = (project: Project, folderRelative: string): string =>
  posix.join(project.folderSetting, folderRelative);

function viewReferences(
  project: Project,
  viewId: string,
  anchored: readonly AnchoredRef[],
  reads: ReferenceReads,
): Partial<ThreadReferences> {
  const view = reads.view(viewId);
  if (view === undefined) return { address: viewId };
  const ids = anchored.flatMap((a) =>
    (a.kind === "node" || a.kind === "edge" || a.kind === "group") && a.id !== undefined ? [a.id] : [],
  );
  const file = inProject(project, view.source);
  if (view.registration === "embedded") {
    const read = reads.embedded(viewId);
    if (read === null) return { file, address: viewId };
    return { file, address: viewId, ...linesIn(read.source, read.bodyLine, ids) };
  }
  const text = reads.source(view.source);
  return { file, address: viewId, ...(text === null ? {} : linesIn(text, 1, ids)) };
}

const escapeRegExp = (id: string): string => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The lines of `source` (whose first line is line `first` of its file) that mention the ids, else all of it. */
function linesIn(source: string, first: number, ids: readonly string[]): { lines?: { start: number; end: number } } {
  const lines = source.replace(/\n$/, "").split("\n");
  if (lines.length === 0) return {};
  const word =
    ids.length === 0 ? null : new RegExp(`(^|[^A-Za-z0-9_-])(${ids.map(escapeRegExp).join("|")})($|[^A-Za-z0-9_-])`);
  if (word !== null) {
    const hits = lines.flatMap((line, at) => (word.test(line) ? [at] : []));
    if (hits.length > 0) return { lines: { start: first + hits[0]!, end: first + hits[hits.length - 1]! } };
  }
  return { lines: { start: first, end: first + lines.length - 1 } };
}

/**
 * A note passage is found as the page anchored it: in the rendered note, by its quote and the context either
 * side (`locatePassage`, the same rule the page and the store use), then traced to the source lines it was
 * written on. Not found, or not traceable: no lines, rather than a guess.
 */
function noteReferences(
  project: Project,
  path: string,
  anchor: Anchor,
  reads: ReferenceReads,
): Partial<ThreadReferences> {
  const file = inProject(project, path);
  if (anchor.kind !== "passage") return { file };
  const note = reads.note(path);
  if (note === null || note.lineOf === null) return { file };
  const found = locatePassage(note.text, anchor);
  if (found === null) return { file };
  const start = note.lineOf(found.start);
  const end = note.lineOf(Math.max(found.start, found.end - 1));
  if (start === null || end === null) return { file };
  return { file, lines: { start: note.lineOffset + start + 1, end: note.lineOffset + end + 1 } };
}
