// Durable passage emphasis for Markdown notes. This is intentionally separate
// from graph emphasis: it decorates rendered note text and never changes the
// Markdown, Mermaid, semantic models, comments, or service recovery state.
import { lstatSync } from "node:fs";
import { locatePassage, type PassageAnchor } from "../../../shared/note-markdown.mts";
import {
  MAX_NOTE_EMPHASES,
  MAX_NOTE_EMPHASIS_CONTEXT_CHARS,
  MAX_NOTE_EMPHASIS_FILE_BYTES,
  MAX_NOTE_EMPHASIS_PASSAGES,
  MAX_NOTE_EMPHASIS_QUOTE_CHARS,
  NOTE_EMPHASIS_AUTHORS,
  NOTE_EMPHASIS_SCHEMA_VERSION,
  NOTE_EMPHASIS_SLOT_PALETTES,
  noteEmphasisCharacters,
  validateNoteEmphasisSnapshot,
  validateNoteEmphasisUpsert,
  type NoteEmphasis,
  type NoteEmphasisAuthor,
  type NoteEmphasisRead,
  type NoteEmphasisSnapshot,
  type UpsertNoteEmphasisInput,
} from "../../../shared/note-emphasis.mts";
import { CommentsLockError, withCommentsLock } from "../comments/lock.ts";
import { renderedNoteFlow, renderedNoteText } from "../comments/note-text.ts";
import {
  ConfinedRefusal,
  ConfinedTooLarge,
  listNotes,
  MAX_NOTE_BYTES,
  ProjectError,
  readInFolder,
  resolveInFolder,
  writeConfined,
  type Project,
} from "../project/index.ts";
import { WriteRuleDenied } from "../config/write-policy.ts";

export type { UpsertNoteEmphasisInput } from "../../../shared/note-emphasis.mts";

export const NOTE_EMPHASIS_SUFFIX = ".emphases.json";

export type NoteEmphasisErrorCode =
  | "invalid_note_emphasis"
  | "note_not_found"
  | "note_emphasis_conflict"
  | "malformed_note_emphasis_file"
  | "note_emphasis_file_conflict"
  | "note_emphasis_file_too_large"
  | "note_emphasis_write_conflict";

const STATUS: Readonly<Record<NoteEmphasisErrorCode, number>> = {
  invalid_note_emphasis: 422,
  note_not_found: 404,
  note_emphasis_conflict: 409,
  malformed_note_emphasis_file: 409,
  note_emphasis_file_conflict: 409,
  note_emphasis_file_too_large: 409,
  note_emphasis_write_conflict: 409,
};

/** A bounded, caller-actionable refusal from the note-emphasis boundary. */
export class NoteEmphasisError extends Error {
  constructor(
    readonly code: NoteEmphasisErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NoteEmphasisError";
  }

  get status(): number {
    return STATUS[this.code];
  }
}
/** `notes/x.md` -> `notes/x.md.emphases.json`. */
export function noteEmphasisPath(notePath: string): string {
  return `${notePath}${NOTE_EMPHASIS_SUFFIX}`;
}

/** Public request parsing. In particular, a caller cannot supply `author`. */
export function readUpsertNoteEmphasis(raw: unknown): UpsertNoteEmphasisInput {
  const checked = validateNoteEmphasisUpsert(raw);
  if (!checked.ok) throw new NoteEmphasisError("invalid_note_emphasis", checked.problem);
  return checked.input;
}

type DiskSnapshot =
  | { readonly kind: "missing"; readonly snapshot: NoteEmphasisSnapshot; readonly bytes: null }
  | { readonly kind: "ok"; readonly snapshot: NoteEmphasisSnapshot; readonly bytes: Buffer };

/** A file's bytes through the confined seam (G6): no link followed, one name, read from its descriptor, at most `maximum`. */
function readDescriptor(project: Project, path: string, maximum: number): Buffer {
  try {
    return readInFolder(project, path, maximum);
  } catch (error) {
    if (error instanceof ConfinedTooLarge)
      throw new NoteEmphasisError(
        "note_emphasis_file_too_large",
        `the emphasis sidecar is over ${maximum} bytes and was not read`,
      );
    if (error instanceof ConfinedRefusal)
      throw new NoteEmphasisError(
        "malformed_note_emphasis_file",
        `the emphasis sidecar was not read: ${error.message}`,
        undefined,
        { cause: error },
      );
    throw error;
  }
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}

const AMBIGUOUS =
  "its quote is ambiguous in the current rendered note; select a longer passage or include distinguishing context";
const MISSING = "its quote is not in the current rendered note";

type Grounding = { readonly problem: string } | { readonly problem: null; readonly anchor: PassageAnchor };

/**
 * Missing is distinct from ambiguous. Scan once without retaining occurrence
 * offsets: a maximum-size repeated quote must use constant extra memory.
 *
 * A quote that is not in `text` as written, and has whitespace, is looked for
 * again in `flow()` (`collapsedFlow`): its whitespace runs then equal any run
 * of spaces or a soft break, so a passage typed across a wrapped source line
 * is found. It never crosses a block edge or hard break. The stored anchor is
 * then the rendered text itself, which the page locates. No pattern is built
 * from the request: both searches are plain `indexOf`.
 */
function ground(text: string, flow: () => CollapsedFlow, anchor: PassageAnchor): Grounding {
  let matches = 0;
  let exact = 0;
  for (let at = text.indexOf(anchor.quote); at !== -1; at = text.indexOf(anchor.quote, at + 1)) {
    matches++;
    const end = at + anchor.quote.length;
    const prefixAt = at - anchor.prefix.length;
    if (prefixAt >= 0 && text.startsWith(anchor.prefix, prefixAt) && text.startsWith(anchor.suffix, end)) {
      exact++;
      // A second exact context can never become unambiguous later.
      if (exact > 1) return { problem: AMBIGUOUS };
    }
  }
  if (matches === 1 || exact === 1) return { problem: null, anchor };
  if (matches > 1) return { problem: AMBIGUOUS };
  return /[ \t\n]/.test(anchor.quote) ? groundAcrossSpaces(text, flow(), anchor) : { problem: MISSING };
}

/**
 * The rendered text with soft breaks as spaces and every run of spaces as
 * one, `start[k]`/`end[k]` the range of the rendered text that character `k`
 * stands for. A block edge or hard break stays `\n`, which a quote never
 * matches once its own whitespace is collapsed to spaces.
 */
interface CollapsedFlow {
  readonly text: string;
  readonly start: Int32Array;
  readonly end: Int32Array;
}

function collapseFlow(flow: string): CollapsedFlow {
  const start = new Int32Array(flow.length);
  const end = new Int32Array(flow.length);
  const pieces: string[] = [];
  let k = 0;
  for (let i = 0; i < flow.length; ) {
    let j = i;
    while (j < flow.length && (flow[j] === " " || flow[j] === "\t")) j++;
    if (j > i) pieces.push(" ");
    else {
      j = i + 1;
      pieces.push(flow[i]!);
    }
    start[k] = i;
    end[k] = j;
    k++;
    i = j;
  }
  return { text: pieces.join(""), start: start.subarray(0, k), end: end.subarray(0, k) };
}

const collapsed = (words: string): string => words.replace(/[ \t\n]+/g, " ");

function groundAcrossSpaces(text: string, flow: CollapsedFlow, anchor: PassageAnchor): Grounding {
  const quote = collapsed(anchor.quote);
  const prefix = collapsed(anchor.prefix);
  const suffix = collapsed(anchor.suffix);
  const haystack = flow.text;
  // `range(from, to)` is the rendered text that collapsed characters [from, to) stand for.
  const range = (from: number, to: number): string =>
    from === to ? "" : text.slice(flow.start[from]!, flow.end[to - 1]!);
  let matches = 0;
  let exact = 0;
  let only: { readonly anchor: PassageAnchor; readonly start: number } | undefined;
  let inContext: { readonly anchor: PassageAnchor; readonly start: number } | undefined;
  for (let at = haystack.indexOf(quote); at !== -1; at = haystack.indexOf(quote, at + 1)) {
    matches++;
    const end = at + quote.length;
    if (matches === 1) only = { anchor: { ...anchor, quote: range(at, end) }, start: flow.start[at]! };
    const prefixAt = at - prefix.length;
    if (prefixAt >= 0 && haystack.startsWith(prefix, prefixAt) && haystack.startsWith(suffix, end)) {
      exact++;
      if (exact > 1) return { problem: AMBIGUOUS };
      inContext = {
        anchor: {
          kind: "passage",
          quote: range(at, end),
          prefix: range(prefixAt, at),
          suffix: range(end, end + suffix.length),
        },
        start: flow.start[at]!,
      };
    }
  }
  const chosen = exact === 1 ? inContext : matches === 1 ? only : undefined;
  if (chosen === undefined) return { problem: matches === 0 ? MISSING : AMBIGUOUS };
  // The rendered spaces may be longer than the typed ones; a stored passage keeps the contract's bounds.
  if (noteEmphasisCharacters(chosen.anchor.quote) > MAX_NOTE_EMPHASIS_QUOTE_CHARS)
    return { problem: `its quote is over ${MAX_NOTE_EMPHASIS_QUOTE_CHARS} characters as it is written in the note` };
  // Over-long context keeps the characters nearest the quote.
  const stored: PassageAnchor = {
    ...chosen.anchor,
    prefix: lastCharacters(chosen.anchor.prefix, MAX_NOTE_EMPHASIS_CONTEXT_CHARS),
    suffix: firstCharacters(chosen.anchor.suffix, MAX_NOTE_EMPHASIS_CONTEXT_CHARS),
  };
  // The page finds the passage with `locatePassage`; what is stored must lead it to this occurrence.
  if (locatePassage(text, stored)?.start !== chosen.start) return { problem: AMBIGUOUS };
  return { problem: null, anchor: stored };
}

const lastCharacters = (value: string, count: number): string => {
  const points = [...value];
  return points.length <= count ? value : points.slice(points.length - count).join("");
};
const firstCharacters = (value: string, count: number): string => {
  const points = [...value];
  return points.length <= count ? value : points.slice(0, count).join("");
};

export class NoteEmphasisStore {
  constructor(readonly project: Project) {}

  /** The current snapshot plus read-only orphan decorators for passages lost to note edits. */
  read(notePath: string): NoteEmphasisRead {
    const note = this.#note(notePath);
    const snapshot = this.#readSnapshot(notePath).snapshot;
    return this.#decorate(snapshot, renderedNoteText(note));
  }

  /** Replace one named set, or remove it when `groups` is empty, under mandatory CAS. */
  upsert(raw: unknown, author: NoteEmphasisAuthor): NoteEmphasisRead {
    const input = readUpsertNoteEmphasis(raw);
    if (!(NOTE_EMPHASIS_AUTHORS as readonly string[]).includes(author))
      throw new NoteEmphasisError("invalid_note_emphasis", "the trusted publishing actor must be person or agent");
    // Refuse an absent/unlisted/link note before lock acquisition creates its
    // private claim directory. It is read again under the sidecar lock.
    this.#note(input.notePath);
    const sidecar = noteEmphasisPath(input.notePath);
    try {
      return withCommentsLock(this.project, sidecar, () => this.#upsertLocked(input, author));
    } catch (error) {
      if (error instanceof NoteEmphasisError) throw error;
      if (error instanceof CommentsLockError)
        throw new NoteEmphasisError(
          "note_emphasis_write_conflict",
          "the note emphasis is being changed by another process; try again",
          undefined,
          { cause: error },
        );
      if (error instanceof WriteRuleDenied) throw error;
      if (error instanceof ProjectError)
        throw new NoteEmphasisError(
          "malformed_note_emphasis_file",
          "the emphasis sidecar is outside the Archer folder or cannot be used",
          undefined,
          { cause: error },
        );
      throw error;
    }
  }

  #upsertLocked(input: UpsertNoteEmphasisInput, author: NoteEmphasisAuthor): NoteEmphasisRead {
    const notePath = input.notePath;
    // One rendered text snapshot grounds the whole request atomically.
    const markdown = this.#note(notePath);
    const rendered = renderedNoteText(markdown);
    // Rendered again only when a quote is not in the text as written.
    let flowText: CollapsedFlow | undefined;
    const flow = (): CollapsedFlow => (flowText ??= collapseFlow(renderedNoteFlow(markdown, rendered)));
    const before = this.#readSnapshot(notePath);
    if (before.snapshot.revision !== input.expectedRevision) {
      throw new NoteEmphasisError(
        "note_emphasis_conflict",
        `note emphasis revision ${input.expectedRevision} is stale; the current revision is ${before.snapshot.revision}. Nothing was written.`,
        { actualSnapshot: before.snapshot },
      );
    }
    if (before.snapshot.revision === Number.MAX_SAFE_INTEGER)
      throw new NoteEmphasisError(
        "invalid_note_emphasis",
        "the note emphasis revision is exhausted; nothing was written",
      );
    const issues: { path: string; problem: string }[] = [];
    const grounding = new Map<string, Grounding>();
    const groundedGroups = input.groups.map((group, groupIndex) =>
      group.passages.map((anchor, passageIndex) => {
        const key = JSON.stringify([anchor.quote, anchor.prefix, anchor.suffix]);
        let result = grounding.get(key);
        if (result === undefined) {
          result = ground(rendered, flow, anchor);
          grounding.set(key, result);
        }
        if (result.problem !== null)
          issues.push({ path: `groups[${groupIndex}].passages[${passageIndex}]`, problem: result.problem });
        return result.problem === null ? result.anchor : anchor;
      }),
    );
    if (issues.length > 0)
      throw new NoteEmphasisError(
        "invalid_note_emphasis",
        `the note emphasis has ${issues.length} ungrounded passage${issues.length === 1 ? "" : "s"}; nothing was written`,
        { issues },
      );

    const existing = before.snapshot.emphases.findIndex((entry) => entry.id === input.id);
    const replacement: NoteEmphasis = {
      id: input.id,
      ...(input.title === undefined ? {} : { title: input.title }),
      author,
      // The palette is derived from position for older readers; nobody chooses it (ADR 0030).
      groups: input.groups.map((group, index) => ({
        id: group.id,
        label: group.label,
        ...(group.description === undefined ? {} : { description: group.description }),
        palette: NOTE_EMPHASIS_SLOT_PALETTES[index] ?? "teal",
        passages: groundedGroups[index]!,
      })),
    };
    const emphases = [...before.snapshot.emphases];
    if (input.groups.length === 0) {
      if (existing >= 0) emphases.splice(existing, 1);
    } else if (existing >= 0) emphases[existing] = replacement;
    else emphases.push(replacement);
    if (emphases.length > MAX_NOTE_EMPHASES)
      throw new NoteEmphasisError(
        "invalid_note_emphasis",
        `a note holds at most ${MAX_NOTE_EMPHASES} named emphases; clear one before adding another`,
      );
    const total = emphases.reduce(
      (count, entry) => count + entry.groups.reduce((n, group) => n + group.passages.length, 0),
      0,
    );
    if (total > MAX_NOTE_EMPHASIS_PASSAGES)
      throw new NoteEmphasisError(
        "invalid_note_emphasis",
        `a note holds at most ${MAX_NOTE_EMPHASIS_PASSAGES} emphasised passages across all named sets`,
      );
    const snapshot: NoteEmphasisSnapshot = {
      schemaVersion: NOTE_EMPHASIS_SCHEMA_VERSION,
      notePath: input.notePath,
      revision: before.snapshot.revision + 1,
      emphases,
    };
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_NOTE_EMPHASIS_FILE_BYTES)
      throw new NoteEmphasisError(
        "note_emphasis_file_too_large",
        `the emphasis sidecar would be over ${MAX_NOTE_EMPHASIS_FILE_BYTES} bytes; clear or shorten some emphasis first`,
      );
    const now = this.#rawSidecar(input.notePath);
    if (!sameBytes(before.bytes, now))
      throw new NoteEmphasisError(
        "note_emphasis_write_conflict",
        "the emphasis sidecar changed while it was being written; nothing was overwritten",
        { actualSnapshot: this.#readSnapshot(input.notePath).snapshot },
      );
    writeConfined(this.project, noteEmphasisPath(input.notePath), serialized, "emphasis");
    return this.#decorate(snapshot, rendered);
  }

  /** A listed, non-hidden, non-link regular Markdown note, read once and decoded strictly. */
  #note(notePath: string): string {
    if (typeof notePath !== "string" || notePath.length === 0 || notePath.length > 4_096)
      throw new NoteEmphasisError("note_not_found", "a note path must be non-empty text of at most 4096 characters");
    let absolute: string;
    try {
      absolute = resolveInFolder(this.project, notePath);
      const entry = lstatSync(absolute);
      // Reject the target link before inventory discovery can read through it.
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("not a plain file");
    } catch (error) {
      throw new NoteEmphasisError(
        "note_not_found",
        `the note ${JSON.stringify(notePath.slice(0, 200))} is not a regular file inside the Archer folder`,
        undefined,
        { cause: error as Error },
      );
    }
    let listed: boolean;
    try {
      listed = listNotes(this.project).some((entry) => entry.path === notePath);
    } catch {
      listed = false;
    }
    if (!listed)
      throw new NoteEmphasisError("note_not_found", `no listed note ${JSON.stringify(notePath.slice(0, 200))}`);
    try {
      const bytes = readDescriptor(this.project, notePath, MAX_NOTE_BYTES);
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      if (error instanceof NoteEmphasisError && error.code === "note_emphasis_file_too_large")
        throw new NoteEmphasisError(
          "note_not_found",
          `the note is over ${MAX_NOTE_BYTES} bytes and cannot be emphasised`,
        );
      throw new NoteEmphasisError(
        "note_not_found",
        `the listed note ${JSON.stringify(notePath.slice(0, 200))} is not a readable regular UTF-8 file`,
        undefined,
        { cause: error as Error },
      );
    }
  }

  #readSnapshot(notePath: string): DiskSnapshot {
    const empty: NoteEmphasisSnapshot = {
      schemaVersion: NOTE_EMPHASIS_SCHEMA_VERSION,
      notePath,
      revision: 0,
      emphases: [],
    };
    let bytes: Buffer;
    const path = noteEmphasisPath(notePath);
    let absolute: string;
    try {
      absolute = resolveInFolder(this.project, path);
    } catch (error) {
      throw new NoteEmphasisError(
        "malformed_note_emphasis_file",
        "the emphasis sidecar is outside the Archer folder",
        undefined,
        { cause: error },
      );
    }
    try {
      const entry = lstatSync(absolute);
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new NoteEmphasisError(
          "malformed_note_emphasis_file",
          "the emphasis sidecar is a link or is not a regular file; it was not read",
        );
      bytes = readDescriptor(this.project, path, MAX_NOTE_EMPHASIS_FILE_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", snapshot: empty, bytes: null };
      if (error instanceof NoteEmphasisError) throw error;
      throw new NoteEmphasisError(
        "malformed_note_emphasis_file",
        "the emphasis sidecar could not be read as a regular file",
        undefined,
        { cause: error as Error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new NoteEmphasisError(
        "malformed_note_emphasis_file",
        "the emphasis sidecar is not JSON in UTF-8; fix or remove it, and nothing will overwrite it",
      );
    }
    const checked = validateNoteEmphasisSnapshot(parsed);
    if (!checked.ok)
      throw new NoteEmphasisError(
        "malformed_note_emphasis_file",
        `the emphasis sidecar does not match schema version 1: ${checked.problem}; fix or remove it, and nothing will overwrite it`,
      );
    if (checked.snapshot.notePath !== notePath)
      throw new NoteEmphasisError(
        "note_emphasis_file_conflict",
        "the emphasis sidecar names another note; it was not read or changed",
      );
    return { kind: "ok", snapshot: checked.snapshot, bytes };
  }

  #rawSidecar(notePath: string): Buffer | null {
    const path = noteEmphasisPath(notePath);
    try {
      resolveInFolder(this.project, path);
    } catch (error) {
      throw new NoteEmphasisError(
        "malformed_note_emphasis_file",
        "the emphasis sidecar is outside the Archer folder",
        undefined,
        { cause: error },
      );
    }
    try {
      return readDescriptor(this.project, path, MAX_NOTE_EMPHASIS_FILE_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  #decorate(snapshot: NoteEmphasisSnapshot, rendered: string): NoteEmphasisRead {
    // Orphaning depends only on whether the quote remains. Context ranks
    // multiple live matches but locatePassage returns one for any occurrence.
    const present = new Map<string, boolean>();
    const orphans = snapshot.emphases.flatMap((entry) =>
      entry.groups.flatMap((group) =>
        group.passages.flatMap((anchor, passageIndex) => {
          let found = present.get(anchor.quote);
          if (found === undefined) {
            found = rendered.includes(anchor.quote);
            present.set(anchor.quote, found);
          }
          return found ? [] : [{ emphasisId: entry.id, groupId: group.id, passageIndex }];
        }),
      ),
    );
    return { snapshot, orphans };
  }
}
