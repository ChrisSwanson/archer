/**
 * What a comments or notes payload is allowed to say.
 *
 * Everything the server sends is read here before the page holds it, the way
 * `inventory.ts` and `compile-status.ts` read theirs: a shape this page does
 * not know is dropped (a whole payload) or skipped (one thread or note in a
 * list), never half-applied. Text is kept as text; nothing here, or anywhere
 * downstream, hands a comment body to the DOM as markup.
 */
import { readTargetRef } from "./target";
import {
  COMMENTS_SCHEMA_VERSION,
  type Anchor,
  type Capabilities,
  type Comment,
  type EmbeddedDiagramContent,
  type EmbeddedDiagramSummary,
  type NoteFreshness,
  type NoteContent,
  type NoteSummary,
  type NotesForView,
  type OperationAck,
  type SubmitAck,
  type Pending,
  type TargetRef,
  type Thread,
  type ThreadList,
  type ThreadStatus,
} from "./contract";

type Rec = Record<string, unknown>;

function record(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

const isString = (value: unknown): value is string => typeof value === "string";

/** Off unless the server says exactly `true`. */
export function parseCapabilities(snapshot: unknown): Capabilities {
  const capabilities = record(record(snapshot)?.capabilities);
  const project = record(record(snapshot)?.project);
  const name = project?.name;
  return {
    comments: capabilities?.comments === true,
    notes: capabilities?.notes === true,
    noteEmphasis: capabilities?.noteEmphasis === true,
    instanceSettings: capabilities?.instanceSettings === true,
    listeners: capabilities?.listeners === true,
    ...(isString(name) && name.trim() !== "" ? { projectName: name.trim() } : {}),
    ...(project?.nestedView === false ? { nestedView: false as const } : {}),
  };
}

export function isTargetRef(value: unknown): value is TargetRef {
  return readTargetRef(value) !== null;
}

function parseRef(value: unknown): { id: string; label: string } | undefined {
  const r = record(value);
  return r !== undefined && isString(r.id) && isString(r.label) ? { id: r.id, label: r.label } : undefined;
}

function parseRefs(value: unknown): { id: string; label: string }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const refs = value.map(parseRef);
  return refs.every((ref) => ref !== undefined) ? (refs as { id: string; label: string }[]) : undefined;
}

/** Where the person was when they commented on an element (absent is fine; a half-written one is not). */
function parseContext(value: unknown): { walkthrough: string; step: string } | null | undefined {
  if (value === undefined) return null;
  const r = record(value);
  return r !== undefined && isString(r.walkthrough) && isString(r.step)
    ? { walkthrough: r.walkthrough, step: r.step }
    : undefined;
}

export function parseAnchor(value: unknown): Anchor | undefined {
  const r = record(value);
  if (r === undefined) {
    return undefined;
  }
  const context = parseContext(r.context);
  if (context === undefined) return undefined;
  const seen = context === null ? {} : { context };
  switch (r.kind) {
    case "view":
      return { kind: "view" };
    case "project":
      return { kind: "project" };
    case "node":
    case "edge":
    case "group": {
      const ref = parseRef(r);
      return ref === undefined ? undefined : { kind: r.kind, id: ref.id, label: ref.label, ...seen };
    }
    case "selection": {
      const nodes = parseRefs(r.nodes);
      const edges = parseRefs(r.edges);
      return nodes === undefined || edges === undefined ? undefined : { kind: "selection", nodes, edges, ...seen };
    }
    case "walkthrough":
      return isString(r.walkthrough) && isString(r.label)
        ? { kind: "walkthrough", walkthrough: r.walkthrough, label: r.label }
        : undefined;
    case "step":
      return isString(r.walkthrough) && isString(r.step) && isString(r.label)
        ? { kind: "step", walkthrough: r.walkthrough, step: r.step, label: r.label }
        : undefined;
    case "passage":
      return isString(r.quote) && isString(r.prefix) && isString(r.suffix)
        ? { kind: "passage", quote: r.quote, prefix: r.prefix, suffix: r.suffix }
        : undefined;
    default:
      return undefined;
  }
}

function parseComment(value: unknown): Comment | undefined {
  const r = record(value);
  if (
    r === undefined ||
    !isString(r.id) ||
    (r.author !== "person" && r.author !== "agent") ||
    !isString(r.body) ||
    !isString(r.createdAt)
  ) {
    return undefined;
  }
  const where = record(r.context);
  return {
    id: r.id,
    author: r.author,
    body: r.body,
    createdAt: r.createdAt,
    ...(isString(r.editedAt) ? { editedAt: r.editedAt } : {}),
    // Where the person sent it from (wave 2); a half-written one is dropped, not fatal.
    ...(where !== undefined && isString(where.page)
      ? { context: { page: where.page, ...(isString(where.document) ? { document: where.document } : {}) } }
      : {}),
  };
}

const STATUSES: readonly ThreadStatus[] = ["draft", "sent", "read", "answered", "resolved"];

/** A status as schema version 2 names it (the service normalises what it stores to version 2). */
function statusOf(value: unknown): ThreadStatus | undefined {
  return STATUSES.find((known) => known === value);
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function revisionOf(value: unknown): number | undefined {
  return isCount(value) ? value : undefined;
}

export function parseThread(value: unknown): Thread | undefined {
  const r = record(value);
  if (r === undefined || !isString(r.id) || !isTargetRef(r.target) || !Array.isArray(r.comments)) {
    return undefined;
  }
  const status = statusOf(r.status);
  const revision = revisionOf(r.revision);
  const anchor = parseAnchor(r.anchor);
  const comments = r.comments.map(parseComment);
  const identity = record(r.identity);
  if (
    r.identity !== undefined &&
    (identity === undefined ||
      identity.version !== 1 ||
      typeof identity.fingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.fingerprint) ||
      typeof identity.unique !== "boolean" ||
      (identity.unique === false && r.orphaned !== true) ||
      Object.keys(identity).some((key) => !["version", "fingerprint", "unique"].includes(key)) ||
      (anchor?.kind !== "group" && anchor?.kind !== "node") ||
      !r.target.startsWith("view:"))
  )
    return undefined;
  if (
    r.modelRevision !== undefined &&
    (typeof r.modelRevision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(r.modelRevision))
  )
    return undefined;
  if (status === undefined || revision === undefined || anchor === undefined || comments.some((c) => c === undefined)) {
    return undefined;
  }
  return {
    id: r.id,
    target: r.target,
    anchor,
    status,
    revision,
    ...(typeof r.modelRevision === "string" ? { modelRevision: r.modelRevision } : {}),
    ...(identity === undefined
      ? {}
      : {
          identity: {
            version: 1 as const,
            fingerprint: identity.fingerprint as string,
            unique: identity.unique as boolean,
          },
        }),
    ...(r.changedAfterSubmit === true ? { changedAfterSubmit: true } : {}),
    ...(r.orphaned === true ? { orphaned: true } : {}),
    comments: comments as Comment[],
  };
}

/** `GET api/comments/pending`: the total, and each target's drafts. A target it cannot read is dropped. */
export function parsePending(value: unknown): Pending | undefined {
  const r = record(value);
  if (r === undefined || !isCount(r.total) || !Array.isArray(r.targets)) {
    return undefined;
  }
  const targets: Pending["targets"][number][] = [];
  for (const raw of r.targets) {
    const t = record(raw);
    if (t !== undefined && isTargetRef(t.target) && isString(t.title) && isCount(t.drafts)) {
      targets.push({ target: t.target, title: t.title, drafts: t.drafts });
    }
  }
  return { total: r.total, targets };
}

export function parseThreadList(value: unknown): ThreadList | undefined {
  const r = record(value);
  if (
    r === undefined ||
    r.schemaVersion !== COMMENTS_SCHEMA_VERSION ||
    !isTargetRef(r.target) ||
    !Array.isArray(r.threads)
  ) {
    return undefined;
  }
  const threads: Thread[] = [];
  for (const raw of r.threads) {
    const thread = parseThread(raw);
    if (thread === undefined) {
      console.warn("[archer] dropped a comment thread this page cannot read");
      continue;
    }
    threads.push(thread);
  }
  return { schemaVersion: COMMENTS_SCHEMA_VERSION, target: r.target, threads };
}

/** `DELETE` answers the thread as it now is, or that the thread itself is gone. */
export function parseDeleteResult(
  value: unknown,
): { readonly deleted: true } | { readonly deleted: false; readonly thread: Thread } | undefined {
  if (record(value)?.deleted === true) {
    return { deleted: true };
  }
  const thread = parseThread(value);
  return thread === undefined ? undefined : { deleted: false, thread };
}

export function parseNoteSummary(value: unknown): NoteSummary | undefined {
  const r = record(value);
  if (r === undefined || !isString(r.path) || !isString(r.title)) {
    return undefined;
  }
  return {
    path: r.path,
    title: r.title,
    ...(isString(r.type) ? { type: r.type } : {}),
    ...(isString(r.status) ? { status: r.status } : {}),
  };
}

export function parseNotesForView(value: unknown): NotesForView | undefined {
  const r = record(value);
  if (r === undefined || !isString(r.viewId) || !Array.isArray(r.notes)) {
    return undefined;
  }
  const notes = r.notes.map(parseNoteSummary).filter((note): note is NoteSummary => note !== undefined);
  return { viewId: r.viewId, notes };
}

export function parseNoteContent(value: unknown): NoteContent | undefined {
  const r = record(value);
  if (r === undefined || !isString(r.path) || !isString(r.markdown) || !isString(r.revision)) {
    return undefined;
  }
  // Figures pair with the note's fences by order, so one diagram the page
  // cannot read drops the list, and every fence stays code.
  const diagrams = Array.isArray(r.diagrams) ? r.diagrams.map(parseEmbeddedSummary) : undefined;
  const freshness = parseFreshness(r.freshness);
  return {
    path: r.path,
    frontMatter: record(r.frontMatter) ?? {},
    markdown: r.markdown,
    revision: r.revision,
    ...(diagrams?.every((d) => d !== undefined) ? { diagrams: diagrams as EmbeddedDiagramSummary[] } : {}),
    ...(freshness === undefined ? {} : { freshness }),
  };
}

const isPositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function parseFreshness(value: unknown): NoteFreshness | undefined {
  const r = record(value);
  switch (r?.status) {
    case "committed":
      return isString(r.commit) && isString(r.committedAt) && typeof r.uncommitted === "boolean"
        ? { status: "committed", commit: r.commit, committedAt: r.committedAt, uncommitted: r.uncommitted }
        : undefined;
    case "never-committed":
    case "not-in-git":
      return { status: r.status };
    case "unavailable":
      return { status: "unavailable", reason: isString(r.reason) ? r.reason : "unknown" };
    default:
      return undefined;
  }
}

export function parseEmbeddedSummary(value: unknown): EmbeddedDiagramSummary | undefined {
  const r = record(value);
  if (r === undefined || !isString(r.name) || !isString(r.address) || !isString(r.kind) || !isString(r.sourceRevision))
    return undefined;
  if (
    !isPositive(r.ordinal) ||
    !isPositive(r.line) ||
    !isPositive(r.bodyLine) ||
    typeof r.explicit !== "boolean" ||
    typeof r.writable !== "boolean"
  )
    return undefined;
  if (r.heading !== null && !isString(r.heading)) return undefined;
  return {
    name: r.name,
    address: r.address,
    explicit: r.explicit,
    ordinal: r.ordinal,
    heading: r.heading,
    kind: r.kind,
    line: r.line,
    bodyLine: r.bodyLine,
    writable: r.writable,
    sourceRevision: r.sourceRevision,
  };
}

export function parseEmbeddedDiagram(value: unknown): EmbeddedDiagramContent | undefined {
  const r = record(value);
  const summary = parseEmbeddedSummary(value);
  const freshness = parseFreshness(r?.freshness);
  if (
    r === undefined ||
    summary === undefined ||
    freshness === undefined ||
    !isString(r.notePath) ||
    !isString(r.source) ||
    !Array.isArray(r.diagnostics)
  )
    return undefined;
  const diagnostics = r.diagnostics.filter((d): d is EmbeddedDiagramContent["diagnostics"][number] => {
    const x = record(d);
    return (
      x !== undefined && isString(x.code) && isString(x.severity) && isString(x.message) && record(x.span) !== undefined
    );
  });
  return { ...summary, notePath: r.notePath, source: r.source, diagnostics, envelope: r.envelope ?? null, freshness };
}

/** An operation's acknowledgement (ADR 0016): what was committed, and the thread as it is now (or null). */
export function parseOperationAck(value: unknown): OperationAck | undefined {
  const r = record(value);
  const operation = record(r?.operation),
    committed = record(r?.committed);
  if (r === undefined || operation === undefined || committed === undefined || typeof r.replayed !== "boolean")
    return undefined;
  if (
    !isString(operation.id) ||
    typeof operation.issuedAt !== "number" ||
    (operation.name !== "comment.create" && operation.name !== "comment.reply")
  )
    return undefined;
  if (
    !isString(committed.threadId) ||
    !isString(committed.commentId) ||
    typeof committed.revision !== "number" ||
    !isString(committed.committedAt)
  )
    return undefined;
  let thread: Thread | null = null;
  if (r.thread !== null) {
    const parsed = parseThread(r.thread);
    if (parsed === undefined) return undefined;
    thread = parsed;
  }
  return {
    operation: { id: operation.id, issuedAt: operation.issuedAt, name: operation.name },
    replayed: r.replayed,
    committed: {
      threadId: committed.threadId,
      commentId: committed.commentId,
      revision: committed.revision,
      committedAt: committed.committedAt,
    },
    thread,
  };
}

/** A submit's acknowledgement (O83): how many it sent (receipts' counts on a repeat), and skipped-file notes. */
export function parseSubmitAck(value: unknown): SubmitAck | undefined {
  const r = record(value);
  const operation = record(r?.operation);
  if (r === undefined || operation === undefined || typeof r.replayed !== "boolean" || typeof r.submitted !== "number")
    return undefined;
  if (!isString(operation.id) || typeof operation.issuedAt !== "number" || operation.name !== "comment.submit")
    return undefined;
  const problems = Array.isArray(r.problems) ? r.problems.filter(isString) : [];
  return {
    operation: { id: operation.id, issuedAt: operation.issuedAt, name: "comment.submit" },
    replayed: r.replayed,
    submitted: r.submitted,
    ...(problems.length > 0 ? { problems } : {}),
  };
}
