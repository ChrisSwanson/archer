/**
 * The comments and notes contract, as the page sees it.
 *
 * One source of truth: the types and limits are the TypeScript service's own
 * (`ts/src/comments/contract.ts`, schema version 2), re-exported so nothing in
 * the page restates them. Only the page's own reading of the bootstrap
 * capability lives here. `parse.ts` reads version 2 only: the service
 * normalises what it stores (comments/store.ts) before it answers.
 */
export type {
  Anchor,
  Author,
  Comment,
  CommentContext,
  CommentOperation,
  CommentOperationName,
  CommentsChanged,
  EmbeddedDiagramContent,
  EmbeddedDiagramSummary,
  NoteFreshness,
  NewThread,
  NoteContent,
  NoteSummary,
  NotesForView,
  OperationAck,
  Pending,
  SubmitAck,
  SubmitOperation,
  SubmitResult,
  ReceiptLedger,
  TargetRef,
  Thread,
  ThreadList,
  ThreadReceipt,
  ThreadStatus,
} from "../../../ts/src/comments/contract";
export {
  COMMENTS_SCHEMA_VERSION,
  MAX_COMMENT_CHARS,
  MAX_CONTEXT_DOCUMENT_CHARS,
  MAX_CONTEXT_PAGE_CHARS,
  MAX_PASSAGE_CONTEXT_CHARS,
  RECEIPT_REPLAY_MS,
  MAX_PASSAGE_QUOTE_CHARS,
  MAX_SELECTION_ELEMENTS,
  MAX_THREADS_PER_TARGET,
  PROJECT_TARGET,
} from "../../../ts/src/comments/contract";
export type {
  NoteEmphasis,
  NoteEmphasisAuthor,
  NoteEmphasisGroup,
  NoteEmphasisGroupInput,
  NoteEmphasisOrphan,
  NoteEmphasisPalette,
  NoteEmphasisRead,
  NoteEmphasisSnapshot,
  UpsertNoteEmphasisInput,
} from "../../../shared/note-emphasis.mts";
export {
  MAX_NOTE_EMPHASES,
  MAX_NOTE_EMPHASIS_GROUPS,
  MAX_NOTE_EMPHASIS_PASSAGES,
  MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP,
  NOTE_EMPHASIS_PALETTES,
  NOTE_EMPHASIS_SLOT_PALETTES,
  NOTE_EMPHASIS_TEXT_LIMITS,
  validateNoteEmphasisSnapshot,
} from "../../../shared/note-emphasis.mts";
import {
  MAX_NOTE_EMPHASIS_PASSAGES,
  validateNoteEmphasisSnapshot,
  type NoteEmphasisOrphan,
  type NoteEmphasisRead,
} from "../../../shared/note-emphasis.mts";

/**
 * What the service said it supports, read off `api/bootstrap`. Each is off unless the service says `true`:
 * until the bootstrap answers (`NO_CAPABILITIES`), and when it cannot be read, the page offers none of them.
 * Comment create, reply and submit are always ADR 0016 operations (every service since 0.15.0 takes them).
 */
export type Capabilities = {
  readonly comments: boolean;
  readonly notes: boolean;
  /** Durable passage highlights. */
  readonly noteEmphasis: boolean;
  /** Shared instance configuration controls. */
  readonly instanceSettings: boolean;
  /** Agent listeners (ADR 0035 §7–8: `api/listeners`, the `listeners` event). */
  readonly listeners: boolean;
  /** The project's name, when the server sends one with its capabilities. */
  readonly projectName?: string;
  /** archer.toml `nested_view = false` (ADR 0029): draw every diagram as written. Absent means the nested view is offered. */
  readonly nestedView?: false;
};

export const NO_CAPABILITIES: Capabilities = {
  comments: false,
  notes: false,
  noteEmphasis: false,
  instanceSettings: false,
  listeners: false,
};

/** Strictly reads the service response, including bounded orphan references into its snapshot. */
export function parseNoteEmphasisRead(value: unknown): NoteEmphasisRead | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "snapshot" && key !== "orphans") || !Array.isArray(record.orphans))
    return undefined;
  const validated = validateNoteEmphasisSnapshot(record.snapshot);
  if (!validated.ok || record.orphans.length > MAX_NOTE_EMPHASIS_PASSAGES) return undefined;
  const emphases = new Map(validated.snapshot.emphases.map((emphasis) => [emphasis.id, emphasis]));
  const orphans: NoteEmphasisOrphan[] = [];
  for (const raw of record.orphans) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const orphan = raw as Record<string, unknown>;
    if (Object.keys(orphan).some((key) => key !== "emphasisId" && key !== "groupId" && key !== "passageIndex"))
      return undefined;
    if (
      typeof orphan.emphasisId !== "string" ||
      typeof orphan.groupId !== "string" ||
      !Number.isSafeInteger(orphan.passageIndex) ||
      (orphan.passageIndex as number) < 0
    )
      return undefined;
    const emphasis = emphases.get(orphan.emphasisId);
    const group = emphasis?.groups.find((candidate) => candidate.id === orphan.groupId);
    if (group === undefined || (orphan.passageIndex as number) >= group.passages.length) return undefined;
    orphans.push({
      emphasisId: orphan.emphasisId,
      groupId: orphan.groupId,
      passageIndex: orphan.passageIndex as number,
    });
  }
  return { snapshot: validated.snapshot, orphans };
}
