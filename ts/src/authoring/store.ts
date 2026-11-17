import { parseAuthoringTarget } from "../../../shared/authoring-contract.mts";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { MAX_SOURCE_BYTES } from "../mermaid/limits.ts";
import { withChangeStoreIo, type ChangeStoreIo, type ChangeStoreIoHook } from "../changes/io.ts";
import { ChangeStoreError } from "../changes/errors.ts";
import { AuthoringStoreError } from "./store-errors.ts";
import type {
  CumulativeReview,
  AuthoringIndex,
  AuthoringOperation,
  DraftOrigin,
  JournalCompletion,
  JournalExpected,
  JournalFeedback,
  JournalIntent,
  JournalRecord,
  JournalReview,
  JournalTarget,
  SavedDraft,
  SavedRevision,
  SaveDraftInput,
  SnapshotRef,
} from "./store-types.ts";
export * from "./store-types.ts";
export { AuthoringStoreError } from "./store-errors.ts";
export const AUTHORING_STORE_LIMITS = {
  sourceBytes: MAX_SOURCE_BYTES,
  intentBytes: 2048,
  projectRootBytes: 4096,
  targetPathBytes: 1024,
  opaqueIdCharacters: 128,
  pendingReviewsPerProject: 256,
  reviews: 1024,
  clearSummaryBytes: 2048,
  futureSourceBytes: 65536,
  openDraftsPerProject: 64,
  revisionsPerProject: 256,
  revisionsPerDraft: 32,
  operations: 4096,
  replayWindow: 256,
  indexBytes: 8 * 1024 * 1024,
  snapshotBytes: 128 * 1024 * 1024,
  physicalBytes: 160 * 1024 * 1024,
  directoryEntries: 8192,
  jsonDepth: 10,
  jsonValues: 500000,
} as const;
/** Terminal outcomes with no source, draft or review effect: replay-window only. */
const EFFECTLESS: ReadonlySet<string> = new Set(["conflict", "no_effect", "unchanged"]);
/** Refusal text for the lifetime operation cap: what is full and how to recover. */
export const JOURNAL_FULL = `the private authoring journal holds its maximum of ${AUTHORING_STORE_LIMITS.operations} settled operations; saves are refused until it is rotated. Stop Archer and move runtime/authoring in the Archer state directory aside (keep it while it has pending reviews); the next start opens a new journal generation`;
export const REVIEWS_FULL = `cumulative review capacity reached: the private authoring journal holds its maximum of ${AUTHORING_STORE_LIMITS.reviews} cumulative reviews (cleared ones included) or ${AUTHORING_STORE_LIMITS.pendingReviewsPerProject} pending reviews in this project; clear pending reviews, or stop Archer and move runtime/authoring in the Archer state directory aside to open a new journal generation`;
export interface AuthoringStoreOptions {
  readonly stateDir: string;
  readonly serviceName: string;
  readonly assertOwner: () => void;
  /** Service lifetime identifier. Generate once per owner, never accept from a browser request. */
  readonly epoch?: string;
  readonly now?: () => number;
  readonly onCommitStep?: ChangeStoreIoHook;
}
const fail = (code: string, message: string): never => {
  throw new AuthoringStoreError(code, message);
};
const invalid = (message: string): never => fail("authoring_store_invalid", message);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!plain(value)) return invalid("expected a plain object");
  if (
    required.some((key) => !own(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid("object has missing or unexpected fields");
  return value;
}
function string(value: unknown, name: string, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > max || /[\0-\x1f\x7f]/u.test(value))
    return invalid(`invalid ${name}`);
  return value;
}
function match(value: unknown, pattern: RegExp, name: string): string {
  const result = string(value, name);
  if (!pattern.test(result)) invalid(`invalid ${name}`);
  return result;
}
const revision = (value: unknown) => match(value, /^sha256:[0-9a-f]{64}$/u, "revision");
const operationId = (value: unknown) => match(value, /^[0-9a-f]{32}$/u, "operationId");
const reviewId = (value: unknown) => match(value, /^rev_[0-9a-f]{32}$/u, "reviewId");
const draftId = (value: unknown) => match(value, /^drf_[0-9a-f]{32}$/u, "draftId");
function integer(value: unknown, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < min) return invalid(`invalid ${name}`);
  return Number(value);
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") return invalid(`invalid ${name}`);
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) return invalid(`invalid ${name}`);
  return value as T;
}
function time(value: unknown): string {
  const s = string(value, "timestamp", 32),
    n = Date.parse(s);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== s) invalid("invalid ISO timestamp");
  return s;
}
function project(value: unknown): string {
  const s = string(value, "projectRoot", AUTHORING_STORE_LIMITS.projectRootBytes);
  if (!isAbsolute(s) || resolve(s) !== s) invalid("projectRoot is not canonical absolute identity");
  return s;
}
function path(value: unknown): string {
  const s = string(value, "path", AUTHORING_STORE_LIMITS.targetPathBytes);
  if (isAbsolute(s) || s.includes("\\") || s.split("/").some((p) => p === "" || p === "." || p === ".."))
    invalid("invalid project-relative path");
  return s;
}
function intent(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > AUTHORING_STORE_LIMITS.intentBytes)
    return invalid("intent exceeds intentBytes or is not text");
  return value;
}
function snapshot(value: unknown): SnapshotRef {
  const v = object(value, ["revision", "bytes"]);
  const bytes = integer(v.bytes, "snapshot bytes");
  if (bytes > AUTHORING_STORE_LIMITS.sourceBytes) invalid("snapshot exceeds sourceBytes");
  return { revision: revision(v.revision), bytes };
}
function origin(value: unknown): DraftOrigin {
  const v = object(
    value,
    ["kind"],
    plain(value) && value.kind === "new" ? ["proposedPath"] : ["path", "blockId", "baseSourceRevision", "base"],
  );
  if (v.kind === "new")
    return { kind: "new", ...(own(v, "proposedPath") ? { proposedPath: path(v.proposedPath) } : {}) };
  if (v.kind !== "document") return invalid("unknown draft origin");
  object(v, ["kind", "path", "baseSourceRevision", "base"], ["blockId"]);
  return {
    kind: "document",
    path: path(v.path),
    ...(own(v, "blockId") ? { blockId: string(v.blockId, "blockId") } : {}),
    baseSourceRevision: revision(v.baseSourceRevision),
    base: snapshot(v.base),
  };
}
function savedRevision(value: unknown): SavedRevision {
  const v = object(value, ["draftRevision", "source", "savedAt", "valid"], ["intent"]);
  return {
    draftRevision: integer(v.draftRevision, "draftRevision", 1),
    source: snapshot(v.source),
    savedAt: time(v.savedAt),
    valid: boolean(v.valid, "valid"),
    ...(own(v, "intent") ? { intent: intent(v.intent) } : {}),
  };
}
function savedDraft(value: unknown): SavedDraft {
  const v = object(value, [
    "draftId",
    "projectRoot",
    "origin",
    "draftRevision",
    "head",
    "revisions",
    "state",
    "createdAt",
    "updatedAt",
  ]);
  if (
    !Array.isArray(v.revisions) ||
    v.revisions.length === 0 ||
    v.revisions.length > AUTHORING_STORE_LIMITS.revisionsPerDraft
  )
    return invalid("invalid draft history length");
  const revisions = v.revisions.map(savedRevision),
    head = savedRevision(v.head),
    current = integer(v.draftRevision, "draftRevision", 1);
  if (
    revisions.some((r, i) => r.draftRevision !== i + 1) ||
    current !== revisions.length ||
    !same(head, revisions.at(-1))
  )
    invalid("draft head/history is inconsistent");
  const result: SavedDraft = {
    draftId: draftId(v.draftId),
    projectRoot: project(v.projectRoot),
    origin: origin(v.origin),
    draftRevision: current,
    head,
    revisions,
    state: choice(v.state, ["open", "discarded", "applied", "published"], "draft state"),
    createdAt: time(v.createdAt),
    updatedAt: time(v.updatedAt),
  };
  if (result.createdAt !== revisions[0]!.savedAt || result.updatedAt < head.savedAt)
    invalid("draft timestamps are inconsistent");
  return result;
}
function target(value: unknown): JournalTarget {
  const v = object(value, ["kind"], ["draftId", "path", "blockId", "changeId", "operationId"]);
  switch (v.kind) {
    case "draft":
      object(v, ["kind", "draftId"]);
      return { kind: "draft", draftId: draftId(v.draftId) };
    case "document":
      object(v, ["kind", "path"], ["blockId"]);
      return {
        kind: "document",
        path: path(v.path),
        ...(own(v, "blockId") ? { blockId: string(v.blockId, "blockId") } : {}),
      };
    case "change":
      object(v, ["kind", "changeId"]);
      return { kind: "change", changeId: match(v.changeId, /^chg_[0-9a-f]{32}$/u, "changeId") };
    case "operation":
      object(v, ["kind", "operationId"]);
      return { kind: "operation", operationId: operationId(v.operationId) };
    default:
      return invalid("unknown journal target");
  }
}
function expected(value: unknown): JournalExpected {
  const v = object(value, [], ["sourceRevision", "draftRevision", "reviewRevision"]);
  return {
    ...(own(v, "sourceRevision")
      ? { sourceRevision: v.sourceRevision === null ? null : revision(v.sourceRevision) }
      : {}),
    ...(own(v, "draftRevision") ? { draftRevision: integer(v.draftRevision, "draftRevision") } : {}),
    ...(own(v, "reviewRevision") ? { reviewRevision: integer(v.reviewRevision, "reviewRevision", 1) } : {}),
  };
}
function feedback(value: unknown): JournalFeedback {
  const v = object(value, ["changes", "delivery", "effectiveRevision"]);
  return {
    changes: choice(v.changes, ["on_save", "manual"], "feedback changes"),
    delivery: choice(v.delivery, ["next_call", "next_call_and_notify"], "delivery"),
    effectiveRevision: revision(v.effectiveRevision),
  };
}
const operations: readonly AuthoringOperation[] = [
  "draft.save",
  "draft.send",
  "draft.discard",
  "document.apply",
  "document.publish",
  "operation.send",
  "change.withdraw",
  "operation.resolve_uncertain",
];
function parseIntent(value: unknown): JournalIntent {
  const v = object(
      value,
      [
        "operationId",
        "payloadDigest",
        "op",
        "projectRoot",
        "authority",
        "feedback",
        "target",
        "expected",
        "base",
        "candidate",
      ],
      ["intent"],
    ),
    a = object(v.authority, ["grantId", "entitlementId"]);
  const parsed: JournalIntent = {
    operationId: operationId(v.operationId),
    payloadDigest: revision(v.payloadDigest),
    op: choice(v.op, operations, "op"),
    projectRoot: project(v.projectRoot),
    authority: { grantId: string(a.grantId, "grantId"), entitlementId: string(a.entitlementId, "entitlementId") },
    feedback: feedback(v.feedback),
    target: target(v.target),
    expected: expected(v.expected),
    base: v.base === null ? null : snapshot(v.base),
    candidate: v.candidate === null ? null : snapshot(v.candidate),
    ...(own(v, "intent") ? { intent: intent(v.intent) } : {}),
  };
  const kind = parsed.op.startsWith("draft.")
    ? "draft"
    : parsed.op.startsWith("document.")
      ? "document"
      : parsed.op === "change.withdraw"
        ? "change"
        : "operation";
  if (parsed.target.kind !== kind) invalid("operation and target kind do not match");
  return parsed;
}
function review(value: unknown): JournalReview {
  const v = object(value, ["mode", "configRevision", "state"], ["changeId", "reviewId", "reviewRevision"]);
  const result: JournalReview = {
    mode: choice(v.mode, ["on_save", "manual"], "review mode"),
    configRevision: revision(v.configRevision),
    state: choice(
      v.state,
      [
        "queued",
        "not_queued_manual",
        "not_queued_no_effect",
        "not_queued_invalid",
        "admission_pending",
        "withdrawn",
        "tracked",
        "tracked_held",
      ],
      "review state",
    ),
    ...(own(v, "changeId") ? { changeId: match(v.changeId, /^chg_[0-9a-f]{32}$/u, "changeId") } : {}),
    ...(own(v, "reviewId")
      ? { reviewId: reviewId(v.reviewId), reviewRevision: integer(v.reviewRevision, "reviewRevision", 1) }
      : {}),
  };
  if ((result.state === "queued") !== own(result, "changeId") && result.state !== "withdrawn")
    invalid("review changeId/state mismatch");
  if (
    own(v, "reviewId") !== own(v, "reviewRevision") ||
    ["tracked", "tracked_held"].includes(result.state) !== own(v, "reviewId")
  )
    invalid("tracked review identity/state mismatch");
  return result;
}
function cumulativeReview(value: unknown): CumulativeReview {
  const v = object(
    value,
    [
      "reviewId",
      "projectRoot",
      "sequence",
      "subject",
      "state",
      "reviewRevision",
      "baseline",
      "latest",
      "latestSourceRevision",
      "firstOperationId",
      "lastOperationId",
      "saveCount",
      "externalGaps",
      "delivery",
      "openedAt",
      "updatedAt",
    ],
    ["clearedAt", "clearedBy", "summary"],
  );
  const subject = target(v.subject);
  if (subject.kind !== "document") return invalid("review subject must be document");
  const state = choice(v.state, ["pending", "cleared"], "review state");
  if (
    (state === "cleared") !== (own(v, "clearedAt") && own(v, "clearedBy") && own(v, "summary")) ||
    (state === "pending" && ["clearedAt", "clearedBy", "summary"].some((k) => own(v, k)))
  )
    invalid("review clear metadata mismatch");
  const r: CumulativeReview = {
    reviewId: reviewId(v.reviewId),
    projectRoot: project(v.projectRoot),
    sequence: integer(v.sequence, "review sequence", 1),
    subject,
    state,
    reviewRevision: integer(v.reviewRevision, "reviewRevision", 1),
    baseline: v.baseline === null ? null : snapshot(v.baseline),
    latest: snapshot(v.latest),
    latestSourceRevision: revision(v.latestSourceRevision),
    firstOperationId: operationId(v.firstOperationId),
    lastOperationId: operationId(v.lastOperationId),
    saveCount: integer(v.saveCount, "saveCount", 1),
    externalGaps: integer(v.externalGaps, "externalGaps"),
    delivery: choice(v.delivery, ["offered", "held"], "delivery"),
    openedAt: time(v.openedAt),
    updatedAt: time(v.updatedAt),
    ...(state === "cleared"
      ? {
          clearedAt: time(v.clearedAt),
          clearedBy: choice(v.clearedBy, ["agent"], "clearedBy"),
          summary: intent(v.summary),
        }
      : {}),
  };
  if (
    r.updatedAt < r.openedAt ||
    r.externalGaps >= r.saveCount ||
    r.reviewRevision < r.saveCount ||
    (r.clearedAt !== undefined && r.clearedAt < r.updatedAt)
  )
    invalid("inconsistent cumulative review");
  return r;
}
export function parseJournalCompletion(value: unknown): JournalCompletion {
  const v = object(value, ["outcome", "review"], ["draft", "document", "conflict", "current", "evidence"]);
  let draft: JournalCompletion["draft"],
    document: JournalCompletion["document"],
    conflict: JournalCompletion["conflict"],
    current: JournalCompletion["current"];
  if (own(v, "draft")) {
    const d = object(v.draft, ["draftId", "draftRevision"]);
    draft = { draftId: draftId(d.draftId), draftRevision: integer(d.draftRevision, "draftRevision", 1) };
  }
  if (own(v, "document")) {
    const d = object(
      v.document,
      ["path", "sourceRevision", "modelRevision"],
      ["blockId", "normalized", "target", "targetRevision"],
    );
    let normalized:
      | {
          pinnedName: boolean;
          lineEndings: boolean;
        }
      | undefined;
    if (own(d, "normalized")) {
      const n = object(d.normalized, ["pinnedName", "lineEndings"]);
      normalized = {
        pinnedName: boolean(n.pinnedName, "pinnedName"),
        lineEndings: boolean(n.lineEndings, "lineEndings"),
      };
    }
    if (own(d, "target") !== own(d, "targetRevision"))
      invalid("document target and targetRevision must be supplied together");
    let target: NonNullable<JournalCompletion["document"]>["target"];
    if (own(d, "target")) {
      try {
        target = parseAuthoringTarget(d.target);
      } catch {
        invalid("invalid document target identity");
      }
      if (
        (target!.kind === "embedded") !== own(d, "blockId") ||
        (target!.kind === "embedded" && target!.address.slice(target!.address.lastIndexOf("#") + 1) !== d.blockId)
      )
        invalid("document target disagrees with block identity");
    }
    document = {
      path: path(d.path),
      sourceRevision: revision(d.sourceRevision),
      modelRevision: d.modelRevision === null ? null : revision(d.modelRevision),
      ...(own(d, "blockId") ? { blockId: string(d.blockId, "blockId") } : {}),
      ...(normalized === undefined ? {} : { normalized }),
      ...(target === undefined ? {} : { target, targetRevision: revision(d.targetRevision) }),
    };
  }
  if (own(v, "conflict")) {
    const c = object(
      v.conflict,
      ["kind"],
      ["currentSourceRevision", "currentDraftRevision", "currentMatchesCandidate"],
    );
    conflict = {
      kind: choice(c.kind, ["source", "draft", "review", "exists"], "conflict kind"),
      ...(own(c, "currentSourceRevision")
        ? { currentSourceRevision: c.currentSourceRevision === null ? null : revision(c.currentSourceRevision) }
        : {}),
      ...(own(c, "currentDraftRevision")
        ? { currentDraftRevision: integer(c.currentDraftRevision, "currentDraftRevision") }
        : {}),
      ...(own(c, "currentMatchesCandidate")
        ? { currentMatchesCandidate: boolean(c.currentMatchesCandidate, "currentMatchesCandidate") }
        : {}),
    };
  }
  if (own(v, "current")) {
    const c = object(v.current, ["observed", "sourceRevision", "contentRevision", "inferred"]);
    if (c.inferred !== true) invalid("current observations must be labelled inferred");
    current = {
      observed: choice(c.observed, ["matches_base", "matches_candidate", "diverged", "missing"], "observed"),
      sourceRevision: c.sourceRevision === null ? null : revision(c.sourceRevision),
      contentRevision: c.contentRevision === null ? null : revision(c.contentRevision),
      inferred: true,
    };
    if (
      (current.observed === "missing") !== (current.sourceRevision === null && current.contentRevision === null) ||
      (current.sourceRevision === null) !== (current.contentRevision === null)
    )
      invalid("missing observations require both source and content revisions absent");
  }
  return {
    outcome: choice(
      v.outcome,
      [
        "saved",
        "unchanged",
        "no_effect",
        "applied",
        "created",
        "sent",
        "discarded",
        "withdrawn",
        "resolved",
        "conflict",
      ],
      "outcome",
    ),
    review: review(v.review),
    ...(draft === undefined ? {} : { draft }),
    ...(document === undefined ? {} : { document }),
    ...(conflict === undefined ? {} : { conflict }),
    ...(current === undefined ? {} : { current }),
    ...(own(v, "evidence")
      ? { evidence: choice(v.evidence, ["observed", "inferred_confirmed", "abandoned"], "evidence") }
      : {}),
  };
}
function record(value: unknown): JournalRecord {
  const v = object(
    value,
    [
      "operationId",
      "payloadDigest",
      "op",
      "projectRoot",
      "authority",
      "feedback",
      "target",
      "expected",
      "base",
      "candidate",
      "epoch",
      "state",
      "createdAt",
      "updatedAt",
    ],
    ["intent", "completion"],
  );
  const { epoch, state, createdAt, updatedAt, completion, ...input } = v,
    base = parseIntent(input),
    common = { ...base, epoch: operationId(epoch), createdAt: time(createdAt), updatedAt: time(updatedAt) };
  if (common.updatedAt < common.createdAt) invalid("operation timestamps are inconsistent");
  if (state === "terminal") {
    if (!own(v, "completion")) invalid("terminal operation has no receipt");
    const receipt = parseJournalCompletion(completion);
    if (
      receipt.review.mode !== base.feedback.changes ||
      receipt.review.configRevision !== base.feedback.effectiveRevision
    )
      invalid("receipt feedback differs from stamped configuration");
    return { ...common, state, completion: receipt };
  }
  if (own(v, "completion")) invalid("nonterminal operation cannot contain a receipt");
  return { ...common, state: choice(state, ["intent", "uncertain"], "operation state") };
}
export function parseAuthoringIndex(bytes: Uint8Array): AuthoringIndex {
  if (!(bytes instanceof Uint8Array)) return invalid("authoring index must be bytes");
  if (bytes.byteLength > AUTHORING_STORE_LIMITS.indexBytes) fail("authoring_store_limit", "index exceeds indexBytes");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid("authoring index is not UTF-8 JSON");
  }
  const work: Array<[unknown, number]> = [[raw, 0]];
  let count = 0;
  while (work.length) {
    const [v, depth] = work.pop()!;
    if (++count > AUTHORING_STORE_LIMITS.jsonValues) fail("authoring_store_limit", "index exceeds jsonValues");
    if (depth > AUTHORING_STORE_LIMITS.jsonDepth) fail("authoring_store_limit", "index exceeds jsonDepth");
    if (Array.isArray(v)) {
      for (const child of v) work.push([child, depth + 1]);
    } else if (plain(v)) {
      for (const child of Object.values(v)) work.push([child, depth + 1]);
    }
  }
  const v = object(
    raw,
    ["version", "serviceName", "storeId", "generation", "drafts", "operations"],
    plain(raw) && raw.version === 2 ? ["reviews"] : [],
  );
  if (
    (v.version !== 1 && v.version !== 2) ||
    !Array.isArray(v.drafts) ||
    !Array.isArray(v.operations) ||
    (v.version === 2 && !Array.isArray(v.reviews))
  )
    return invalid("invalid authoring index version or collections");
  if (v.operations.length > AUTHORING_STORE_LIMITS.operations)
    fail("authoring_store_limit", "index exceeds operations");
  const drafts = v.drafts.map(savedDraft),
    journal = v.operations.map(record),
    ids = new Set<string>(),
    opids = new Set<string>(),
    counts = new Map<
      string,
      {
        open: number;
        revisions: number;
      }
    >();
  for (const draft of drafts) {
    if (ids.has(draft.draftId)) invalid("duplicate draft identity");
    ids.add(draft.draftId);
    const c = counts.get(draft.projectRoot) ?? { open: 0, revisions: 0 };
    c.open += Number(draft.state === "open");
    c.revisions += draft.revisions.length;
    if (c.open > AUTHORING_STORE_LIMITS.openDraftsPerProject)
      fail("authoring_store_limit", "index exceeds openDraftsPerProject");
    if (c.revisions > AUTHORING_STORE_LIMITS.revisionsPerProject)
      fail("authoring_store_limit", "index exceeds revisionsPerProject");
    counts.set(draft.projectRoot, c);
  }
  for (const op of journal) {
    if (opids.has(op.operationId)) invalid("duplicate global operation identity");
    opids.add(op.operationId);
  }
  const reviews = v.version === 2 ? (v.reviews as unknown[]).map(cumulativeReview) : [];
  if (reviews.length > AUTHORING_STORE_LIMITS.reviews)
    fail("authoring_store_limit", "review history capacity exceeded");
  const reviewIds = new Set<string>(),
    pending = new Set<string>(),
    projectReviews = new Map<string, number>(),
    sequences = new Map<string, number>();
  for (const r of reviews) {
    if (reviewIds.has(r.reviewId)) invalid("duplicate review identity");
    reviewIds.add(r.reviewId);
    const seq = (sequences.get(r.projectRoot) ?? 0) + 1;
    if (r.sequence !== seq) invalid("noncontiguous review sequence");
    sequences.set(r.projectRoot, seq);
    if (r.state === "pending") {
      const key = JSON.stringify([r.projectRoot, r.subject]);
      if (pending.has(key)) invalid("duplicate pending subject");
      pending.add(key);
      const n = (projectReviews.get(r.projectRoot) ?? 0) + 1;
      projectReviews.set(r.projectRoot, n);
      if (n > AUTHORING_STORE_LIMITS.pendingReviewsPerProject)
        fail("authoring_store_limit", "pending review capacity exceeded");
    }
    const sourceRecords = journal.filter(
      (o) => o.state === "terminal" && o.completion.review.reviewId === r.reviewId && o.target.kind === "document",
    );
    const first = sourceRecords[0],
      last = sourceRecords.at(-1);
    if (
      !first ||
      !last ||
      first.operationId !== r.firstOperationId ||
      last.operationId !== r.lastOperationId ||
      sourceRecords.length !== r.saveCount
    )
      invalid("review source history mismatch");
    if (!same(r.baseline, first!.base) || !same(r.latest, last!.candidate))
      invalid("review snapshots disagree with source history");
    for (const op of sourceRecords) {
      if (
        op.projectRoot !== r.projectRoot ||
        op.target.kind !== "document" ||
        op.target.path !== r.subject.path ||
        op.target.blockId !== r.subject.blockId
      )
        invalid("review source subject mismatch");
      if (
        op.state !== "terminal" ||
        (!["applied", "created"].includes(op.completion.outcome) &&
          !(op.completion.outcome === "resolved" && op.completion.evidence === "inferred_confirmed")) ||
        op.base?.revision === op.candidate?.revision
      )
        invalid("review references a non-effect source operation");
    }
    const gaps = sourceRecords
      .slice(1)
      .reduce((n, op, i) => n + Number(op.base?.revision !== sourceRecords[i]!.candidate?.revision), 0);
    if (gaps !== r.externalGaps) invalid("review continuity disagrees with source history");
    if (
      last!.state !== "terminal" ||
      (last!.completion.document?.sourceRevision ?? last!.completion.current?.sourceRevision) !== r.latestSourceRevision
    )
      invalid("review source CAS disagrees with last observation");
  }
  for (const op of journal)
    if (op.state === "terminal" && op.completion.review.reviewId !== undefined) {
      const r = reviews.find((r) => r.reviewId === op.completion.review.reviewId);
      if (!r || r.projectRoot !== op.projectRoot || op.completion.review.reviewRevision! > r.reviewRevision)
        invalid("receipt review reference inconsistent");
    }
  return {
    version: v.version as 1 | 2,
    serviceName: string(v.serviceName, "serviceName"),
    storeId: match(v.storeId, /^store_[0-9a-f]{32}$/u, "storeId"),
    generation: match(v.generation, /^gen_[0-9a-f]{32}$/u, "generation"),
    drafts,
    operations: journal,
    ...(v.version === 2 ? { reviews } : {}),
  };
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function refs(index: AuthoringIndex): SnapshotRef[] {
  const unique = new Map<string, SnapshotRef>();
  const all = [
    ...index.drafts.flatMap((d) => [
      ...(d.origin.kind === "document" ? [d.origin.base] : []),
      ...d.revisions.map((r) => r.source),
    ]),
    ...index.operations.flatMap((o) => [
      ...(o.base === null ? [] : [o.base]),
      ...(o.candidate === null ? [] : [o.candidate]),
    ]),
  ];
  all.push(...(index.reviews ?? []).flatMap((r) => [...(r.baseline ? [r.baseline] : []), r.latest]));
  for (const ref of all) {
    const old = unique.get(ref.revision);
    if (old && old.bytes !== ref.bytes) invalid("inconsistent sizes for one snapshot revision");
    unique.set(ref.revision, ref);
  }
  return [...unique.values()];
}
function sourceBytes(bytes: unknown): Buffer {
  if (!(bytes instanceof Uint8Array)) return invalid("source must be bytes");
  if (bytes.byteLength > AUTHORING_STORE_LIMITS.sourceBytes)
    fail("authoring_store_limit", "source exceeds sourceBytes");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("source is not UTF-8");
  }
  return Buffer.from(bytes);
}
const reference = (bytes: Uint8Array): SnapshotRef => ({
  revision: `sha256:${digest(bytes)}`,
  bytes: bytes.byteLength,
});
const inventoryLimits = () => ({
  entries: AUTHORING_STORE_LIMITS.directoryEntries,
  physicalBytes: AUTHORING_STORE_LIMITS.physicalBytes,
  snapshotBytes: AUTHORING_STORE_LIMITS.snapshotBytes,
});
/** Requires the running service's singleton ownership; never instantiate per request/process. */
export class AuthoringStore {
  readonly #options: AuthoringStoreOptions;
  readonly #epoch: string;
  readonly #root: string;
  #rootDev!: number;
  #rootIno!: number;
  #authority!: string;
  #index!: AuthoringIndex;
  #unavailable = false;
  constructor(options: AuthoringStoreOptions) {
    options.assertOwner();
    this.#options = options;
    this.#epoch = operationId(options.epoch ?? randomBytes(16).toString("hex"));
    this.#root = join(options.stateDir, "runtime/authoring");
    try {
      string(options.serviceName, "serviceName");
      this.#io((io) => {
        const inventory = io.inventory(inventoryLimits());
        if (!io.existsIndex()) {
          if (inventory.entries !== 0) invalid("authoring index is missing from a nonempty store");
          const fresh: AuthoringIndex = {
            version: 1,
            serviceName: options.serviceName,
            storeId: `store_${randomBytes(16).toString("hex")}`,
            generation: `gen_${randomBytes(16).toString("hex")}`,
            drafts: [],
            operations: [],
          };
          io.replaceIndex(Buffer.from(JSON.stringify(fresh)), options.onCommitStep);
          io.ensureSnapshots();
        }
        let encoded = io.readIndex(AUTHORING_STORE_LIMITS.indexBytes),
          index = parseAuthoringIndex(encoded);
        if (index.serviceName !== options.serviceName) invalid("authoring service name differs");
        if (refs(index).length === 0) io.ensureSnapshots();
        // Validate committed authority and every referenced blob before cleaning only an
        // interrupted no-clobber publication's temporary alias. Orphans stay counted.
        for (const ref of refs(index)) this.#read(io, ref);
        io.inventory(inventoryLimits(), { reconcileBlobPublications: true });
        const recovered = {
          ...index,
          operations: index.operations.map((op) =>
            op.state === "intent" && op.epoch !== this.#epoch
              ? { ...op, state: "uncertain" as const, updatedAt: this.#time() }
              : op,
          ),
        };
        if (!same(recovered, index)) {
          encoded = Buffer.from(JSON.stringify(recovered));
          parseAuthoringIndex(encoded);
          io.replaceIndex(encoded, options.onCommitStep);
          index = recovered;
        }
        io.syncOpenBindings();
        this.#index = index;
        this.#authority = digest(encoded);
      });
      const root = lstatSync(this.#root);
      this.#rootDev = root.dev;
      this.#rootIno = root.ino;
    } catch (error) {
      if (error instanceof AuthoringStoreError) throw error;
      this.#translate(error);
    }
  }
  status() {
    this.#guard();
    return { storeId: this.#index.storeId, generation: this.#index.generation };
  }
  usage(root: string) {
    this.#guard();
    const drafts = this.#index.drafts.filter((d) => d.projectRoot === root);
    return {
      operations: { used: this.#index.operations.length, limit: AUTHORING_STORE_LIMITS.operations },
      reviews: { used: (this.#index.reviews ?? []).length, limit: AUTHORING_STORE_LIMITS.reviews },
      savedDraftRevisions: {
        used: drafts.reduce((n, d) => n + d.revisions.length, 0),
        limit: AUTHORING_STORE_LIMITS.revisionsPerProject,
      },
      perDraftRevisionLimit: AUTHORING_STORE_LIMITS.revisionsPerDraft,
    };
  }
  putSnapshot(input: Uint8Array): SnapshotRef {
    this.#guard();
    const bytes = sourceBytes(input),
      ref = reference(bytes);
    this.#io((io) => {
      if (io.existsSnapshot(ref.revision.slice(7))) {
        this.#read(io, ref);
        return;
      }
      this.#reserve(io, [bytes], 0);
      this.#writeBlob(io, bytes);
    });
    return ref;
  }
  readSnapshot(input: SnapshotRef): Buffer {
    this.#guard();
    const ref = snapshot(input);
    return this.#io((io) => this.#read(io, ref));
  }
  saveDraft(input: SaveDraftInput): {
    kind: "saved" | "unchanged";
    draft: SavedDraft;
  } {
    this.#guard();
    const v = object(
      input,
      ["projectRoot", "draftId", "expectedDraftRevision", "origin", "source", "valid"],
      ["intent"],
    );
    const root = project(v.projectRoot),
      id = draftId(v.draftId),
      orig = origin(v.origin),
      bytes = sourceBytes(v.source),
      valid = boolean(v.valid, "valid"),
      expectedRevision =
        v.expectedDraftRevision === null ? null : integer(v.expectedDraftRevision, "expectedDraftRevision", 1),
      reason = own(v, "intent") ? intent(v.intent) : undefined;
    const old = this.#index.drafts.find((d) => d.draftId === id);
    if (old && (old.projectRoot !== root || !same(old.origin, orig)))
      fail("authoring_draft_mismatch", "draft identity cannot change project or origin");
    if ((old?.draftRevision ?? null) !== expectedRevision) fail("authoring_draft_conflict", "saved draft head changed");
    if (old?.state !== undefined && old.state !== "open")
      fail("authoring_draft_conflict", "saved draft is no longer open");
    const ref = reference(bytes);
    if (old && same(old.head.source, ref)) {
      this.#io((io) => this.#read(io, ref));
      return { kind: "unchanged", draft: clone(old) };
    }
    if (orig.kind === "document") this.#io((io) => this.#read(io, orig.base));
    if (old && old.revisions.length >= AUTHORING_STORE_LIMITS.revisionsPerDraft)
      fail("authoring_store_capacity", "revisionsPerDraft reached");
    const projectDrafts = this.#index.drafts.filter((d) => d.projectRoot === root);
    if (!old && projectDrafts.filter((d) => d.state === "open").length >= AUTHORING_STORE_LIMITS.openDraftsPerProject)
      fail("authoring_store_capacity", "openDraftsPerProject reached");
    if (projectDrafts.reduce((n, d) => n + d.revisions.length, 0) >= AUTHORING_STORE_LIMITS.revisionsPerProject)
      fail("authoring_store_capacity", "revisionsPerProject reached");
    const now = this.#time(),
      head: SavedRevision = {
        draftRevision: (old?.draftRevision ?? 0) + 1,
        source: ref,
        savedAt: now,
        valid,
        ...(reason === undefined ? {} : { intent: reason }),
      };
    const draft: SavedDraft = {
      draftId: id,
      projectRoot: root,
      origin: orig,
      draftRevision: head.draftRevision,
      head,
      revisions: [...(old?.revisions ?? []), head],
      state: "open",
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    const next = {
      ...this.#index,
      drafts: old ? this.#index.drafts.map((d) => (d.draftId === id ? draft : d)) : [...this.#index.drafts, draft],
    };
    this.#commit(next, [bytes]);
    return { kind: "saved", draft: clone(draft) };
  }
  getDraft(projectRoot: string, id: string): SavedDraft | null {
    this.#guard();
    project(projectRoot);
    draftId(id);
    const d = this.#index.drafts.find((x) => x.projectRoot === projectRoot && x.draftId === id);
    return d ? clone(d) : null;
  }
  listDrafts(projectRoot: string): SavedDraft[] {
    this.#guard();
    project(projectRoot);
    return this.#index.drafts.filter((d) => d.projectRoot === projectRoot).map(clone);
  }
  setDraftState(
    projectRoot: string,
    id: string,
    expectedDraftRevision: number,
    state: "discarded" | "applied" | "published",
  ): SavedDraft {
    this.#guard();
    project(projectRoot);
    draftId(id);
    integer(expectedDraftRevision, "expectedDraftRevision", 1);
    choice(state, ["discarded", "applied", "published"], "draft state");
    const old =
      this.#index.drafts.find((d) => d.projectRoot === projectRoot && d.draftId === id) ??
      fail("authoring_not_found", "draft not found in project");
    if (old.draftRevision !== expectedDraftRevision) fail("authoring_draft_conflict", "saved draft head changed");
    if (old.state === state) return clone(old);
    if (old.state !== "open") fail("authoring_draft_conflict", "draft lifecycle transition already completed");
    const next = { ...old, state, updatedAt: this.#time() };
    this.#commit({ ...this.#index, drafts: this.#index.drafts.map((d) => (d === old ? next : d)) });
    return clone(next);
  }
  beginOperation(input: JournalIntent): {
    kind: "begun" | "replayed";
    record: JournalRecord;
  } {
    this.#guard();
    const valid = parseIntent(input),
      existing = this.#index.operations.find((op) => op.operationId === valid.operationId);
    if (existing) {
      this.#matchOperation(existing, valid.payloadDigest);
      const { epoch: _e, state: _s, createdAt: _c, updatedAt: _u, ...rest } = existing;
      const { completion: _r, ...original } = rest as typeof rest & {
        completion?: JournalCompletion;
      };
      if (!same(valid, original)) fail("authoring_operation_mismatch", "operation identity or stamped input differs");
      this.#io((io) => {
        for (const ref of [existing.base, existing.candidate]) if (ref) this.#read(io, ref);
      });
      return { kind: "replayed", record: clone(existing) };
    }
    const operations = this.#replayWindow(this.#index);
    if (operations.length >= AUTHORING_STORE_LIMITS.operations) fail("authoring_store_capacity", JOURNAL_FULL);
    this.#io((io) => {
      for (const ref of [valid.base, valid.candidate]) if (ref) this.#read(io, ref);
    });
    const now = this.#time(),
      op: JournalRecord = { ...valid, epoch: this.#epoch, state: "intent", createdAt: now, updatedAt: now };
    this.#commit({ ...this.#index, operations: [...operations, op] });
    return { kind: "begun", record: clone(op) };
  }
  /**
   * Operations that settled with no lasting effect (conflicts, no-op and
   * refused saves) are kept only for exact replay of a recent retry: the
   * newest `replayWindow` of them stay, older ones leave the journal. A
   * pruned operation ID is unknown again; journal generations, not old IDs,
   * guard stale browser retries (ADR 0027). Their snapshots stay counted
   * until blob collection lands.
   */
  #replayWindow(index: AuthoringIndex): readonly JournalRecord[] {
    const referenced = new Set<string>();
    for (const o of index.operations) if (o.target.kind === "operation") referenced.add(o.target.operationId);
    for (const r of index.reviews ?? []) {
      referenced.add(r.firstOperationId);
      referenced.add(r.lastOperationId);
    }
    const transient = index.operations.filter(
      (o) =>
        o.state === "terminal" &&
        EFFECTLESS.has(o.completion.outcome) &&
        o.completion.review.changeId === undefined &&
        o.completion.review.reviewId === undefined &&
        o.completion.review.state !== "admission_pending" &&
        !referenced.has(o.operationId),
    );
    if (transient.length < AUTHORING_STORE_LIMITS.replayWindow) return index.operations;
    const dropped = new Set(transient.slice(0, transient.length - AUTHORING_STORE_LIMITS.replayWindow + 1));
    return index.operations.filter((o) => !dropped.has(o));
  }
  listOperations(projectRoot: string): JournalRecord[] {
    this.#guard();
    project(projectRoot);
    return this.#index.operations.filter((o) => o.projectRoot === projectRoot).map(clone);
  }
  getOperation(id: string): JournalRecord | null {
    this.#guard();
    operationId(id);
    const op = this.#index.operations.find((o) => o.operationId === id);
    return op ? clone(op) : null;
  }
  markOperationUncertain(id: string, payloadDigest: string): JournalRecord {
    this.#guard();
    const old = this.#findOperation(id, payloadDigest);
    if (old.state === "uncertain") return clone(old);
    if (old.state === "terminal")
      return fail("authoring_operation_mismatch", "terminal outcome cannot become uncertain");
    const next: JournalRecord = { ...old, state: "uncertain", updatedAt: this.#time() };
    this.#replaceOperation(next);
    return clone(next);
  }
  completeOperation(id: string, payloadDigest: string, input: JournalCompletion): JournalRecord {
    this.#guard();
    const old = this.#findOperation(id, payloadDigest),
      completion = parseJournalCompletion(input);
    if (
      completion.review.mode !== old.feedback.changes ||
      completion.review.configRevision !== old.feedback.effectiveRevision
    )
      invalid("completion changes stamped feedback");
    if (old.state === "terminal") {
      if (!same(old.completion, completion)) fail("authoring_operation_mismatch", "terminal outcome is immutable");
      return clone(old);
    }
    if (old.state === "uncertain")
      fail("authoring_operation_uncertain", "uncertain intent requires explicit coordinator resolution");
    const next: JournalRecord = { ...old, state: "terminal", completion, updatedAt: this.#time() };
    this.#replaceOperation(next);
    return clone(next);
  }
  resolveOperation(id: string, payloadDigest: string, input: JournalCompletion): JournalRecord {
    this.#guard();
    const old = this.#findOperation(id, payloadDigest),
      completion = parseJournalCompletion(input);
    if (
      completion.outcome !== "resolved" ||
      !["inferred_confirmed", "abandoned"].includes(completion.evidence ?? "") ||
      completion.current === undefined
    )
      return invalid("resolution must label inferred observation and explicit disposition");
    if (
      completion.evidence === "inferred_confirmed" &&
      (completion.current.observed !== "matches_candidate" ||
        old.candidate === null ||
        completion.current.contentRevision !== old.candidate.revision)
    )
      invalid("confirmed resolution must observe the candidate");
    if (completion.document !== undefined || completion.draft !== undefined)
      invalid("resolution cannot claim a new source or draft effect");
    if (
      completion.review.mode !== old.feedback.changes ||
      completion.review.configRevision !== old.feedback.effectiveRevision
    )
      invalid("resolution changes stamped feedback");
    if (old.state === "terminal") {
      if (old.completion.outcome === "resolved" && same(old.completion, completion)) return clone(old);
      return fail("authoring_operation_mismatch", "terminal outcome is immutable");
    }
    if (old.state !== "uncertain")
      return fail("authoring_operation_mismatch", "only an uncertain intent can be explicitly resolved");
    const next: JournalRecord = { ...old, state: "terminal", completion, updatedAt: this.#time() };
    this.#replaceOperation(next);
    return clone(next);
  }
  updateOperationReview(id: string, payloadDigest: string, input: JournalReview): JournalRecord {
    this.#guard();
    const old = this.#findOperation(id, payloadDigest),
      nextReview = review(input);
    if (old.state !== "terminal") return fail("authoring_operation_uncertain", "operation is not terminal");
    if (same(old.completion.review, nextReview)) return clone(old);
    if (
      old.completion.review.state !== "admission_pending" ||
      nextReview.state !== "queued" ||
      nextReview.mode !== old.completion.review.mode ||
      nextReview.configRevision !== old.completion.review.configRevision
    )
      fail("authoring_operation_mismatch", "review admission may only advance pending to queued");
    const next: JournalRecord = {
      ...old,
      completion: { ...old.completion, review: nextReview },
      updatedAt: this.#time(),
    };
    this.#replaceOperation(next);
    return clone(next);
  }
  listReviews(projectRoot: string): CumulativeReview[] {
    this.#guard();
    project(projectRoot);
    return (this.#index.reviews ?? []).filter((r) => r.projectRoot === projectRoot).map(clone);
  }
  getReview(projectRoot: string, id: string): CumulativeReview | null {
    this.#guard();
    project(projectRoot);
    reviewId(id);
    const r = (this.#index.reviews ?? []).find((r) => r.projectRoot === projectRoot && r.reviewId === id);
    return r ? clone(r) : null;
  }
  clearReview(projectRoot: string, id: string, expectedReviewRevision: number, summary: string): CumulativeReview {
    this.#guard();
    const old = this.getReview(projectRoot, id) ?? fail("authoring_not_found", "review not found in project");
    integer(expectedReviewRevision, "expectedReviewRevision", 1);
    intent(summary);
    this.#assertSettled(old.projectRoot, old.subject);
    if (old.reviewRevision !== expectedReviewRevision || old.state !== "pending")
      throw new AuthoringStoreError(
        "change_review_conflict",
        `review changed; currentReviewRevision=${old.reviewRevision}`,
        old.reviewRevision,
      );
    const now = this.#time(),
      next: CumulativeReview = {
        ...old,
        state: "cleared",
        reviewRevision: old.reviewRevision + 1,
        updatedAt: now,
        clearedAt: now,
        clearedBy: "agent",
        summary,
      };
    this.#commit({ ...this.#index, reviews: this.#index.reviews!.map((r) => (r.reviewId === id ? next : r)) });
    return clone(next);
  }
  offerReview(projectRoot: string, id: string, expectedReviewRevision: number): CumulativeReview {
    this.#guard();
    const old = this.getReview(projectRoot, id) ?? fail("authoring_not_found", "review not found in project");
    integer(expectedReviewRevision, "expectedReviewRevision", 1);
    if (old.reviewRevision !== expectedReviewRevision || old.state !== "pending")
      throw new AuthoringStoreError(
        "change_review_conflict",
        `review changed; currentReviewRevision=${old.reviewRevision}`,
        old.reviewRevision,
      );
    if (old.delivery === "offered") return old;
    const next: CumulativeReview = {
      ...old,
      delivery: "offered",
      reviewRevision: old.reviewRevision + 1,
      updatedAt: this.#time(),
    };
    this.#commit({ ...this.#index, reviews: this.#index.reviews!.map((r) => (r.reviewId === id ? next : r)) });
    return clone(next);
  }
  /** Runs under the source lock, after exact journal snapshots exist, before canonical bytes change. */
  assertSourceReviewCapacity(id: string, payloadDigest: string, futureCompletion: JournalCompletion): void {
    this.#guard();
    const old = this.#findOperation(id, payloadDigest);
    if (old.state !== "intent") fail("authoring_reconcile_required", "source operation is not a fresh intent");
    this.#assertSettled(
      old.projectRoot,
      old.target.kind === "document" ? old.target : invalid("source target required"),
      id,
    );
    const next = this.#sourceNext(old, futureCompletion, false),
      encoded = Buffer.from(JSON.stringify(next));
    parseAuthoringIndex(encoded);
    this.#assertHeadroom(next, encoded.length);
    this.#io((io) => this.#reserve(io, [], encoded.length + this.#reservedBytes(next)));
  }
  completeSourceOperation(id: string, payloadDigest: string, input: JournalCompletion): JournalRecord {
    this.#guard();
    const old = this.#findOperation(id, payloadDigest);
    if (old.state === "uncertain")
      fail("authoring_operation_uncertain", "uncertain source requires explicit resolution");
    if (old.state === "terminal") return this.#sourceReplay(old, input);
    const next = this.#sourceNext(old, input, false);
    this.#commit(next);
    return clone(next.operations.find((o) => o.operationId === id)!);
  }
  resolveSourceOperation(id: string, payloadDigest: string, input: JournalCompletion): JournalRecord {
    this.#guard();
    const old = this.#findOperation(id, payloadDigest),
      completion = parseJournalCompletion(input);
    if (
      completion.outcome !== "resolved" ||
      completion.current === undefined ||
      !["inferred_confirmed", "abandoned"].includes(completion.evidence ?? "")
    )
      return invalid("source resolution requires explicit inferred evidence");
    if (completion.evidence === "abandoned" && completion.current.observed === "matches_candidate")
      fail("authoring_reconcile_required", "observed candidate cannot be abandoned without review");
    if (old.state === "terminal") return this.#sourceReplay(old, completion);
    if (old.state !== "uncertain") fail("authoring_operation_mismatch", "only uncertain source may be resolved");
    if (
      completion.evidence === "inferred_confirmed" &&
      (completion.current.observed !== "matches_candidate" ||
        completion.current.contentRevision !== old.candidate?.revision)
    )
      invalid("confirmed source resolution must observe candidate content");
    const next = this.#sourceNext(old, completion, true);
    this.#commit(next);
    return clone(next.operations.find((o) => o.operationId === id)!);
  }
  #sourceReplay(old: Extract<JournalRecord, { state: "terminal" }>, input: JournalCompletion): JournalRecord {
    const completion = parseJournalCompletion(input),
      stored = old.completion;
    const comparable = { ...stored, review: { ...stored.review } };
    delete comparable.review.reviewId;
    delete comparable.review.reviewRevision;
    if (["tracked", "tracked_held"].includes(stored.review.state)) comparable.review.state = completion.review.state;
    if (!same(comparable, completion) && !same(stored, completion))
      fail("authoring_operation_mismatch", "terminal source outcome is immutable");
    return clone(old);
  }
  #assertSettled(root: string, subject: { path: string; blockId?: string }, exclude?: string): void {
    if (
      this.#index.operations.some(
        (o) =>
          o.operationId !== exclude &&
          o.projectRoot === root &&
          o.target.kind === "document" &&
          o.target.path === subject.path &&
          o.target.blockId === subject.blockId &&
          o.state !== "terminal",
      )
    )
      fail("authoring_reconcile_required", "subject has an unfinished source intent");
  }
  #sourceNext(old: JournalRecord, input: JournalCompletion, resolving: boolean): AuthoringIndex {
    const completion = parseJournalCompletion(input);
    if (old.target.kind !== "document" || !["document.apply", "document.publish"].includes(old.op))
      return invalid("cumulative source operation requires document target");
    if (
      completion.review.mode !== old.feedback.changes ||
      completion.review.configRevision !== old.feedback.effectiveRevision
    )
      invalid("source completion changes stamped feedback");
    const changed = old.base?.revision !== old.candidate?.revision;
    const effect = resolving
      ? completion.evidence === "inferred_confirmed" && changed
      : ["applied", "created"].includes(completion.outcome);
    if (effect && !changed) return invalid("unchanged source cannot claim a source effect");
    if (!resolving && !["applied", "created", "unchanged", "conflict", "no_effect"].includes(completion.outcome))
      invalid("invalid source outcome");
    if (
      completion.document !== undefined &&
      (completion.document.path !== old.target.path || completion.document.blockId !== old.target.blockId)
    )
      invalid("source completion changes document identity");
    if (!resolving) this.#assertSettled(old.projectRoot, old.target, old.operationId);
    let reviews = [...(this.#index.reviews ?? [])],
      receipt = completion;
    if (effect) {
      this.#assertSettled(old.projectRoot, old.target, old.operationId);
      if (old.candidate === null) return invalid("source effect requires candidate snapshot");
      const sourceRevision = resolving ? completion.current?.sourceRevision : completion.document?.sourceRevision;
      if (sourceRevision == null) return invalid("source effect requires observed source CAS");
      const subject = old.target,
        now = this.#time(),
        pending = reviews.find(
          (r) =>
            r.projectRoot === old.projectRoot &&
            r.state === "pending" &&
            r.subject.path === subject.path &&
            r.subject.blockId === subject.blockId,
        );
      let folded: CumulativeReview;
      if (pending)
        folded = {
          ...pending,
          latest: old.candidate,
          latestSourceRevision: sourceRevision,
          lastOperationId: old.operationId,
          saveCount: pending.saveCount + 1,
          externalGaps: pending.externalGaps + Number(old.base?.revision !== pending.latest.revision),
          reviewRevision: pending.reviewRevision + 1,
          delivery: old.feedback.changes === "on_save" ? "offered" : "held",
          updatedAt: now,
        };
      else {
        if (
          reviews.length >= AUTHORING_STORE_LIMITS.reviews ||
          reviews.filter((r) => r.projectRoot === old.projectRoot && r.state === "pending").length >=
            AUTHORING_STORE_LIMITS.pendingReviewsPerProject
        )
          fail("authoring_store_capacity", REVIEWS_FULL);
        folded = {
          reviewId: `rev_${digest(Buffer.from(JSON.stringify([this.#index.storeId, this.#index.generation, old.projectRoot, old.target, old.operationId]))).slice(0, 32)}`,
          projectRoot: old.projectRoot,
          sequence: reviews.filter((r) => r.projectRoot === old.projectRoot).length + 1,
          subject: old.target,
          state: "pending",
          reviewRevision: 1,
          baseline: old.base,
          latest: old.candidate,
          latestSourceRevision: sourceRevision,
          firstOperationId: old.operationId,
          lastOperationId: old.operationId,
          saveCount: 1,
          externalGaps: 0,
          delivery: old.feedback.changes === "manual" ? "held" : "offered",
          openedAt: now,
          updatedAt: now,
        };
      }
      reviews = pending ? reviews.map((r) => (r === pending ? folded : r)) : [...reviews, folded];
      receipt = {
        ...completion,
        review: {
          mode: old.feedback.changes,
          configRevision: old.feedback.effectiveRevision,
          state: folded.delivery === "held" ? "tracked_held" : "tracked",
          reviewId: folded.reviewId,
          reviewRevision: folded.reviewRevision,
        },
      };
    }
    const terminal: JournalRecord = { ...old, state: "terminal", completion: receipt, updatedAt: this.#time() };
    return {
      ...this.#index,
      ...(effect ? { version: 2 as const, reviews } : {}),
      operations: this.#index.operations.map((o) => (o.operationId === old.operationId ? terminal : o)),
    };
  }
  /** Reserve bounded terminal/fold growth and agent clear metadata for every outstanding subject. */
  #reservedBytes(index: AuthoringIndex): number {
    return (
      index.operations.filter((o) => o.target.kind === "document" && o.state !== "terminal").length *
        AUTHORING_STORE_LIMITS.futureSourceBytes +
      (index.reviews ?? []).filter((r) => r.state === "pending").length *
        (AUTHORING_STORE_LIMITS.clearSummaryBytes * 6 + 256)
    );
  }
  #assertHeadroom(index: AuthoringIndex, bytes: number): void {
    if (bytes + this.#reservedBytes(index) > AUTHORING_STORE_LIMITS.indexBytes)
      fail("authoring_store_capacity", "indexBytes including future source/clear reservations reached");
    const resolving = new Set(
      index.operations
        .filter(
          (o) => o.op === "operation.resolve_uncertain" && o.state !== "terminal" && o.target.kind === "operation",
        )
        .map((o) => (o.target as Extract<JournalTarget, { kind: "operation" }>).operationId),
    );
    const unresolved = index.operations.filter(
      (o) => o.target.kind === "document" && o.state !== "terminal" && !resolving.has(o.operationId),
    ).length;
    if (index.operations.length + unresolved > AUTHORING_STORE_LIMITS.operations)
      fail(
        "authoring_store_capacity",
        `${JOURNAL_FULL}; operation slots include future uncertain resolution reservations`,
      );
  }
  #findOperation(id: string, payloadDigest: string): JournalRecord {
    operationId(id);
    revision(payloadDigest);
    const op =
      this.#index.operations.find((o) => o.operationId === id) ?? fail("authoring_not_found", "operation is unknown");
    this.#matchOperation(op, payloadDigest);
    return op;
  }
  #matchOperation(record: JournalRecord, payloadDigest: string) {
    if (record.payloadDigest !== payloadDigest)
      fail("authoring_operation_mismatch", "operation ID was used with another payload");
  }
  #replaceOperation(next: JournalRecord) {
    this.#commit({
      ...this.#index,
      operations: this.#index.operations.map((op) => (op.operationId === next.operationId ? next : op)),
    });
  }
  #time() {
    const now = (this.#options.now ?? Date.now)();
    if (!Number.isFinite(now)) invalid("invalid server clock");
    return new Date(now).toISOString();
  }
  #io<T>(callback: (io: ChangeStoreIo) => T): T {
    try {
      return withChangeStoreIo(
        this.#options.stateDir,
        (io) => {
          try {
            return callback(io);
          } catch (error) {
            if (error instanceof AuthoringStoreError)
              throw new ChangeStoreError(error.code.replace(/^authoring_/u, "change_"), error.message);
            throw error;
          }
        },
        "authoring",
      );
    } catch (error) {
      if (
        error instanceof ChangeStoreError &&
        (error.code === "change_store_invalid" || error.code === "change_store_io")
      )
        this.#unavailable = true;
      return this.#translate(error);
    }
  }
  #translate(error: unknown): never {
    if (error instanceof AuthoringStoreError) throw error;
    if (error instanceof ChangeStoreError) {
      const code = error.code.replace(/^change_/u, "authoring_");
      throw new AuthoringStoreError(code, error.message);
    }
    throw new AuthoringStoreError(
      "authoring_store_io",
      error instanceof Error ? error.message : "authoring I/O failed",
    );
  }
  #guard() {
    this.#options.assertOwner();
    if (this.#unavailable) fail("authoring_store_unavailable", "authoring authority is unavailable");
    try {
      const root = lstatSync(this.#root);
      if (!root.isDirectory() || root.dev !== this.#rootDev || root.ino !== this.#rootIno)
        throw new Error("root binding changed");
      this.#io((io) => {
        if (digest(io.readIndex(AUTHORING_STORE_LIMITS.indexBytes)) !== this.#authority)
          throw new Error("index authority changed");
      });
    } catch {
      this.#unavailable = true;
      fail("authoring_store_unavailable", "authoring authority cannot be verified");
    }
  }
  #read(io: ChangeStoreIo, ref: SnapshotRef): Buffer {
    try {
      const bytes = io.readSnapshot(ref.revision.slice(7), AUTHORING_STORE_LIMITS.sourceBytes);
      if (bytes.length !== ref.bytes || digest(bytes) !== ref.revision.slice(7))
        invalid("snapshot does not match size and digest");
      sourceBytes(bytes);
      return bytes;
    } catch (error) {
      this.#unavailable = true;
      throw error;
    }
  }
  #writeBlob(io: ChangeStoreIo, bytes: Uint8Array) {
    try {
      io.writeBlob(digest(bytes), bytes, this.#options.onCommitStep);
    } catch (error) {
      this.#unavailable = true;
      throw error;
    }
  }
  #reserve(io: ChangeStoreIo, blobs: readonly Uint8Array[], indexBytes: number) {
    const inventory = io.inventory(inventoryLimits(), { reconcileBlobPublications: true }),
      unique = new Map<string, Uint8Array>();
    for (const bytes of blobs) unique.set(digest(bytes), bytes);
    let physical = inventory.physicalBytes + indexBytes,
      snapshots = inventory.snapshotBytes,
      missing = 0;
    for (const [hex, bytes] of unique) {
      if (io.existsSnapshot(hex)) {
        this.#read(io, reference(bytes));
      } else {
        missing++;
        physical += bytes.byteLength;
        snapshots += bytes.byteLength;
      }
    }
    if (inventory.entries + missing + 1 > AUTHORING_STORE_LIMITS.directoryEntries)
      fail("authoring_store_capacity", "directoryEntries reached");
    if (physical > AUTHORING_STORE_LIMITS.physicalBytes) fail("authoring_store_capacity", "physicalBytes reached");
    if (snapshots > AUTHORING_STORE_LIMITS.snapshotBytes) fail("authoring_store_capacity", "snapshotBytes reached");
  }
  #commit(next: AuthoringIndex, blobs: readonly Uint8Array[] = []) {
    const encoded = Buffer.from(JSON.stringify(next));
    if (encoded.length > AUTHORING_STORE_LIMITS.indexBytes) fail("authoring_store_capacity", "indexBytes reached");
    parseAuthoringIndex(encoded);
    this.#assertHeadroom(next, encoded.length);
    this.#io((io) => {
      this.#reserve(io, blobs, encoded.length + this.#reservedBytes(next));
      try {
        for (const bytes of blobs) this.#writeBlob(io, bytes);
        if (digest(io.readIndex(AUTHORING_STORE_LIMITS.indexBytes)) !== this.#authority)
          throw new Error("index authority changed before publication");
        io.replaceIndex(encoded, this.#options.onCommitStep);
        this.#authority = digest(encoded);
        this.#index = next;
      } catch (error) {
        this.#unavailable = true;
        fail(
          "authoring_store_unavailable",
          `authoring commit not acknowledged: ${error instanceof Error ? error.message : "I/O failed"}; reopen with a new owner`,
        );
      }
    });
  }
}
