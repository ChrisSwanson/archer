/** Service-owned authoring transactions. No HTTP credentials or UI state enter this domain. */
import { browserEditing, writesAllowed } from "../config/write-policy.ts";
import { archerIdOf } from "../../../shared/note-diagrams.mts";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  parseAuthoringRequest,
  parseAuthoringTarget,
  type AuthoringRequest,
  type AuthoringReceipt,
  type AuthoringStatus,
  type AuthoringOpen,
  type AuthoringSnapshot,
  type AuthoringTarget,
} from "../../../shared/authoring-contract.mts";
import { compileDiagramBytes, revisionOf, type CompiledDiagram } from "../project/envelope.ts";
import { ConfinedRefusal, ConfinedTooLarge } from "../project/confined-fs.ts";
import {
  confine,
  findProject,
  readInFolder,
  readInProject,
  realOf,
  resolveInFolder,
  type Project,
} from "../project/project.ts";
import {
  applySource,
  createConfined,
  EDITING_DISABLED,
  SourceWriteError,
  type BeforeWritePlan,
  type SourcePublication,
} from "../project/source-writer.ts";
import { findView, inventory, type ViewEntry } from "../application/diagrams.ts";
import { readEmbedded, type EmbeddedRead } from "../notes/embedded.ts";
import { isStableId } from "../model/index.ts";
import { listDiagrams } from "../project/inventory.ts";
import { readPreamble } from "../mermaid/preamble.ts";
import { MAX_SOURCE_BYTES } from "../mermaid/limits.ts";
import type { Revision } from "../model/index.ts";
import type { ChangeInput, ChangeStore } from "../changes/index.ts";
import type {
  AuthoringStore,
  DraftOrigin,
  JournalFeedback,
  JournalIntent,
  JournalRecord,
  JournalReview,
  JournalCompletion,
  SavedDraft,
  SavedRevision,
} from "./store.ts";
export interface AuthoringCoordinatorOptions {
  store: AuthoringStore;
  changes: ChangeStore;
  project: () => Project;
  authority: () => { grantId: string; entitlementId: string };
  feedback: (project: Project) => JournalFeedback;
  /** Tests may wrap the production compiler to control an awaited window. */
  compile?: typeof compileDiagramBytes;
}
export class AuthoringCoordinatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = "AuthoringCoordinatorError";
  }
}
const fail = (code: string, message: string): never => {
  throw new AuthoringCoordinatorError(code, message);
};
/**
 * Whether the page may edit this project: `edit` (the project's archer.toml, else the account's: `global`),
 * then the account's `[[projects]]` write rules (`account`).
 */
export function editState(project: Project): { enabled: boolean; reason?: "project" | "global" | "account" } {
  let editing: { enabled: boolean; source: string };
  try {
    editing = browserEditing(project);
  } catch {
    editing = { enabled: false, source: "account" };
  }
  if (!editing.enabled) return { enabled: false, reason: editing.source === "project" ? "project" : "global" };
  let diagrams = false,
    notes = false;
  try {
    diagrams = writesAllowed(project.root, ["diagrams"]);
    notes = writesAllowed(project.root, ["notes"]);
  } catch {
    /* unreadable: neither */
  }
  return diagrams || notes ? { enabled: true } : { enabled: false, reason: "account" };
}
const digest = (value: unknown): string => revisionOf(Buffer.from(JSON.stringify(canonical(value))));
function canonical(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, v]) => [key, canonical(v)]),
      )
    : value;
}
function projectPath(project: Project, absolute: string): string {
  const p = relative(project.root, absolute).split(sep).join("/");
  if (!p || p.startsWith("../") || isAbsolute(p))
    return fail("authoring_target_invalid", "browser authoring requires a canonical project-relative target");
  return p;
}
/** A standalone source's exact bytes through the confined seam (G6): no link followed, one name, read from its descriptor. */
function exactBytes(read: (limit: number) => Buffer): Buffer {
  try {
    return read(MAX_SOURCE_BYTES);
  } catch (error) {
    if (error instanceof ConfinedTooLarge)
      return fail("authoring_target_invalid", "source must be a bounded regular file");
    if (error instanceof ConfinedRefusal)
      return fail(
        "authoring_target_invalid",
        error.reason === "not_regular" ? "source must be a bounded regular file" : error.message,
      );
    throw error;
  }
}
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
function body(read: EmbeddedRead): Buffer {
  return Buffer.from(
    read.noteText
      .split(/(?<=\n)/u)
      .slice(read.bodyLine - 1, read.bodyLine - 1 + read.diagram.bodyLineCount)
      .join(""),
  );
}
const compileSlots = new WeakMap<AuthoringStore, { active: number }>();
interface Context {
  project: Project;
  folder: string;
  authority: { grantId: string; entitlementId: string };
}
interface Opened {
  public: AuthoringOpen;
  bytes: Buffer;
  canonical: string;
}
class Replay extends Error {
  constructor(readonly record: JournalRecord) {
    super("operation already exists");
  }
}
export class AuthoringCoordinator {
  #options: AuthoringCoordinatorOptions;
  constructor(options: AuthoringCoordinatorOptions) {
    this.#options = options;
  }
  #context(): Context {
    const authority = this.#options.authority(),
      project = this.#options.project();
    return { project, folder: realpathSync(project.folder), authority };
  }
  #fresh(context: Context): Project {
    const authority = this.#options.authority(),
      project = this.#options.project();
    if (
      project.root !== context.project.root ||
      project.folder !== context.project.folder ||
      realpathSync(project.folder) !== context.folder ||
      authority.grantId !== context.authority.grantId ||
      authority.entitlementId !== context.authority.entitlementId
    )
      return fail(
        "authoring_authority_changed",
        "project, authoring folder or authoring authority changed while preparing the operation",
      );
    return project;
  }
  #lookup(id: string, payload: string, root: string): JournalRecord | null {
    const found = this.#options.store.getOperation(id);
    if (found && (found.payloadDigest !== payload || found.projectRoot !== root))
      return fail("authoring_operation_mismatch", "operation ID was used with another payload or project");
    return found;
  }
  #receipt(record: JournalRecord): AuthoringReceipt {
    const base: AuthoringReceipt = {
      operationId: record.operationId,
      state: record.state,
      ...(record.target.kind === "document"
        ? {
            subject: { path: record.target.path, ...(record.target.blockId ? { blockId: record.target.blockId } : {}) },
          }
        : {}),
    };
    if (record.state === "terminal") return { ...base, ...structuredClone(record.completion) };
    if (record.state === "uncertain") {
      try {
        return { ...base, current: this.#probe(record) };
      } catch {
        return { ...base, probeUnavailable: true };
      }
    }
    return base;
  }
  #targetRevision(project: Project, target: AuthoringTarget, canonical: string, blockId: string | null): string {
    return digest({
      version: 1,
      projectRoot: project.root,
      configuredFolder: project.folder,
      authoringRoot: realpathSync(project.folder),
      documentPath: canonical,
      blockId,
      target,
    });
  }
  #checkTarget(opened: Opened, expected: string): void {
    if (opened.public.targetRevision !== expected)
      fail(
        "authoring_target_conflict",
        "target identity changed since it was opened; reopen the intended diagram before saving",
      );
  }
  #open(project: Project, target: AuthoringTarget): Opened {
    if (target.kind === "view") {
      const view = findView(project, target.viewId, "read_diagram");
      if (view.registration === "embedded")
        return fail("authoring_target_invalid", "standalone target cannot name an embedded diagram");
      const canonical = realpathSync(resolveInFolder(project, view.source)),
        bytes = exactBytes((limit) => readInFolder(project, view.source, limit));
      return {
        canonical,
        bytes,
        public: {
          target: structuredClone(target),
          path: projectPath(project, canonical),
          authoringPath: confine(project, canonical),
          blockId: null,
          source: decode(bytes),
          sourceRevision: revisionOf(bytes),
          targetRevision: this.#targetRevision(project, target, canonical, null),
          writable: true,
        },
      };
    }
    const read = readEmbedded(project, target.address);
    if (!read) return fail("authoring_not_found", "embedded diagram not found");
    const canonical = realpathSync(resolveInFolder(project, read.notePath)),
      bytes = body(read);
    return {
      canonical,
      bytes,
      public: {
        target: structuredClone(target),
        path: projectPath(project, canonical),
        authoringPath: confine(project, canonical),
        blockId: read.name,
        source: decode(bytes),
        sourceRevision: read.sourceRevision,
        targetRevision: this.#targetRevision(project, target, canonical, read.name),
        writable: read.writable && read.diagram.closed,
      },
    };
  }
  open(target: unknown): AuthoringOpen {
    const context = this.#context();
    return this.#open(context.project, parseAuthoringTarget(target)).public;
  }
  snapshot(draftId: string, draftRevision: number): AuthoringSnapshot {
    const context = this.#context(),
      draft = this.#draft(context.project.root, draftId),
      saved = this.#saved(draft, draftRevision);
    return {
      draftId,
      draftRevision,
      source: decode(this.#options.store.readSnapshot(saved.source)),
      valid: saved.valid,
      ...(saved.intent === undefined ? {} : { intent: saved.intent }),
    };
  }
  operation(id: string): AuthoringReceipt | null {
    const context = this.#context(),
      record = this.#options.store.getOperation(id);
    if (!record || record.projectRoot !== context.project.root) return null;
    return this.#receipt(record);
  }
  #originTarget(
    project: Project,
    origin: DraftOrigin,
    views: readonly ViewEntry[],
  ): Pick<AuthoringOpen, "target" | "targetRevision"> | undefined {
    if (origin.kind !== "document") return undefined;
    try {
      const absolute = resolve(project.root, origin.path);
      if (realpathSync(absolute) !== absolute) return undefined;
      const authoringPath = confine(project, absolute);
      if (origin.blockId) {
        const target: AuthoringTarget = { kind: "embedded", address: `${authoringPath}#${origin.blockId}` };
        const opened = this.#open(project, target);
        return opened.public.sourceRevision === origin.baseSourceRevision
          ? { target, targetRevision: opened.public.targetRevision }
          : undefined;
      }
      for (const view of views) {
        if (view.registration === "embedded") continue;
        if (realpathSync(resolveInFolder(project, view.source)) !== absolute) continue;
        const target: AuthoringTarget = { kind: "view", viewId: view.id };
        const opened = this.#open(project, target);
        if (opened.public.sourceRevision === origin.baseSourceRevision)
          return { target, targetRevision: opened.public.targetRevision };
      }
    } catch {
      /* Unsafe, changed or no-longer-discoverable paths offer no automatic Apply target. */
    }
    return undefined;
  }
  status(limit = 100, offset = 0): AuthoringStatus {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
      return fail("authoring_invalid_request", "invalid status page");
    const context = this.#context(),
      store = this.#options.store,
      all = store.listOperations(context.project.root).reverse(),
      views = inventory(context.project).views;
    const heldSourceOperations = store
      .listReviews(context.project.root)
      .filter((review) => review.state === "pending" && review.delivery === "held")
      .map((review) => store.getOperation(review.lastOperationId))
      .filter((record): record is JournalRecord => record !== null)
      .map((record) => this.#receipt(record));
    return {
      ...store.status(),
      edit: editState(findProject(context.project.root)),
      heldSourceOperations,
      usage: store.usage(context.project.root),
      drafts: store.listDrafts(context.project.root).map((d) => ({
        draftId: d.draftId,
        draftRevision: d.draftRevision,
        state: d.state,
        valid: d.head.valid,
        sourceRevision: d.head.source.revision,
        savedAt: d.head.savedAt,
        origin:
          d.origin.kind === "new"
            ? { kind: "new", ...(d.origin.proposedPath ? { path: d.origin.proposedPath } : {}) }
            : {
                kind: "document",
                path: d.origin.path,
                ...(d.origin.blockId ? { blockId: d.origin.blockId } : {}),
                baseSourceRevision: d.origin.baseSourceRevision,
                ...((target) => ({ diverged: target === undefined, ...(target ?? {}) }))(
                  this.#originTarget(context.project, d.origin, views),
                ),
              },
      })),
      operations: all.slice(offset, offset + limit).map((r) => this.#receipt(r)),
      unfinishedOperations: all
        .filter((r) => r.state !== "terminal")
        .map((r) => ({
          operationId: r.operationId,
          state: r.state,
          ...(r.target.kind === "document"
            ? { subject: { path: r.target.path, ...(r.target.blockId ? { blockId: r.target.blockId } : {}) } }
            : {}),
        })),
      nextOffset: offset + limit < all.length ? offset + limit : null,
    };
  }
  async #slot<T>(work: () => Promise<T>): Promise<T> {
    let slots = compileSlots.get(this.#options.store);
    if (!slots) {
      slots = { active: 0 };
      compileSlots.set(this.#options.store, slots);
    }
    if (slots.active >= 2) return fail("authoring_busy", "at most two authoring requests may compile concurrently");
    slots.active++;
    try {
      return await work();
    } finally {
      slots.active--;
    }
  }
  async #compile(source: string): Promise<CompiledDiagram> {
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return fail("authoring_source_limit", "source exceeds 256 KiB");
    return (this.#options.compile ?? compileDiagramBytes)({ path: "preview.mmd" }, Buffer.from(source));
  }
  async compile(source: string): Promise<CompiledDiagram> {
    this.#context();
    return this.#slot(() => this.#compile(source));
  }
  #draft(root: string, id: string): SavedDraft {
    return this.#options.store.getDraft(root, id) ?? fail("authoring_not_found", "draft not found in project");
  }
  #saved(draft: SavedDraft, revision: number): SavedRevision {
    return (
      draft.revisions.find((r) => r.draftRevision === revision) ??
      fail("authoring_not_found", "saved draft revision not found")
    );
  }
  #review(feedback: JournalFeedback, state: JournalReview["state"]): JournalReview {
    return { mode: feedback.changes, configRevision: feedback.effectiveRevision, state };
  }
  /** Details are built only after re-authorization and the replay lookup, so a refused or
   * replayed request never writes snapshot blobs (orphans count against storage limits). */
  #begin(
    context: Context,
    request: AuthoringRequest,
    payload: string,
    details: () => Pick<JournalIntent, "target" | "expected" | "base" | "candidate">,
  ): JournalRecord {
    const project = this.#fresh(context),
      existing = this.#lookup(request.operationId, payload, project.root);
    if (existing) throw new Replay(existing);
    // Again at the journal boundary: `edit = false` may have landed while the request compiled.
    if (!browserEditing(project).enabled) fail("editing_disabled", EDITING_DISABLED);
    return this.#options.store.beginOperation({
      operationId: request.operationId,
      payloadDigest: payload,
      op: request.op,
      projectRoot: project.root,
      authority: context.authority,
      feedback: this.#options.feedback(project),
      ...details(),
      ...("intent" in request && request.intent !== undefined ? { intent: request.intent } : {}),
    }).record;
  }
  #complete(record: JournalRecord, completion: JournalCompletion): JournalRecord {
    return this.#options.store.completeOperation(record.operationId, record.payloadDigest, completion);
  }
  #retryAdmission(record: JournalRecord): JournalRecord {
    if (record.state !== "terminal" || record.completion.review.state !== "admission_pending") return record;
    try {
      const admission = this.#admission(record);
      const queued = this.#options.changes.admit(admission).record;
      return this.#options.store.updateOperationReview(record.operationId, record.payloadDigest, {
        ...record.completion.review,
        state: "queued",
        changeId: queued.changeId,
      });
    } catch {
      try {
        return this.#options.store.getOperation(record.operationId) ?? record;
      } catch {
        return record;
      }
    }
  }
  #existingReview(
    record: JournalRecord,
    draftRef?: { draftId: string; draftRevision: number },
    sourceOperationId?: string,
  ): JournalReview | null {
    for (const old of this.#options.store.listOperations(record.projectRoot)) {
      if (old.state !== "terminal" || !old.completion.review.changeId) continue;
      const matches = draftRef
        ? old.completion.draft?.draftId === draftRef.draftId &&
          old.completion.draft?.draftRevision === draftRef.draftRevision
        : old.operationId === sourceOperationId ||
          (old.op === "operation.send" &&
            old.target.kind === "operation" &&
            old.target.operationId === sourceOperationId);
      if (!matches) continue;
      const change = this.#options.changes.get(record.projectRoot, old.completion.review.changeId);
      if (change)
        return {
          ...this.#review(record.feedback, change.disposition === "withdrawn" ? "withdrawn" : "queued"),
          changeId: change.changeId,
        };
    }
    return null;
  }
  #conflict(record: JournalRecord, error: unknown): JournalRecord | null {
    const code = (error as { code?: string }).code;
    const kind =
      code === "authoring_draft_conflict"
        ? "draft"
        : code === "change_review_conflict" || code === "change_review_terminal"
          ? "review"
          : null;
    return kind
      ? this.#complete(record, {
          outcome: "conflict",
          conflict: { kind },
          review: this.#review(record.feedback, "not_queued_no_effect"),
        })
      : null;
  }
  #admission(record: JournalRecord): ChangeInput {
    if (record.state !== "terminal") return fail("authoring_operation_uncertain", "operation is not terminal");
    const store = this.#options.store;
    if (record.completion.draft) {
      const ref = record.completion.draft,
        draft = this.#draft(record.projectRoot, ref.draftId),
        saved = this.#saved(draft, ref.draftRevision);
      const before =
        draft.origin.kind === "document"
          ? store.readSnapshot(draft.origin.base)
          : ref.draftRevision > 1
            ? store.readSnapshot(this.#saved(draft, ref.draftRevision - 1).source)
            : null;
      const target: ChangeInput["target"] =
        draft.origin.kind === "document"
          ? {
              kind: "document",
              path: draft.origin.path,
              ...(draft.origin.blockId ? { blockId: draft.origin.blockId } : {}),
            }
          : {
              kind: "draft",
              id: draft.draftId,
              ...(draft.origin.proposedPath ? { proposedPath: draft.origin.proposedPath } : {}),
            };
      return {
        operationId: createHash("sha256")
          .update(`draft:${record.projectRoot}:${draft.draftId}:${ref.draftRevision}`)
          .digest("hex")
          .slice(0, 32),
        projectRoot: record.projectRoot,
        format: "mermaid",
        origin: "browser_editor",
        target,
        eventKind: draft.origin.kind === "document" ? "proposal.saved" : "draft.saved",
        before,
        after: store.readSnapshot(saved.source),
        ...(saved.intent === undefined ? {} : { intent: saved.intent }),
      };
    }
    let original: JournalRecord = record;
    if (record.op === "operation.send" && record.target.kind === "operation")
      original =
        store.getOperation(record.target.operationId) ?? fail("authoring_not_found", "original operation is missing");
    if (original.state !== "terminal" || !original.completion.document || !original.candidate)
      return fail("authoring_invalid_request", "operation has no immutable source effect to send");
    return {
      operationId: createHash("sha256").update(`document:${original.operationId}`).digest("hex").slice(0, 32),
      projectRoot: record.projectRoot,
      format: "mermaid",
      origin: "browser_editor",
      target: {
        kind: "document",
        path: original.completion.document.path,
        ...(original.completion.document.blockId ? { blockId: original.completion.document.blockId } : {}),
      },
      eventKind: original.completion.outcome === "created" ? "document.created" : "document.updated",
      before: original.base ? store.readSnapshot(original.base) : null,
      after: store.readSnapshot(original.candidate),
      ...(original.intent === undefined ? {} : { intent: original.intent }),
    };
  }
  async mutate(value: unknown): Promise<AuthoringReceipt> {
    const request = parseAuthoringRequest(value),
      payload = digest(request),
      context = this.#context();
    // `edit = false` (ADR 0028): no editor action at all, drafts included. Read fresh from archer.toml;
    // the source writers check it again inside their lock.
    if (!browserEditing(findProject(context.project.root)).enabled) fail("editing_disabled", EDITING_DISABLED);
    const existing = this.#lookup(request.operationId, payload, context.project.root);
    if (existing) return this.#receipt(this.#retryAdmission(existing));
    if (
      request.journalGeneration !== undefined &&
      request.journalGeneration !== this.#options.store.status().generation
    )
      fail(
        "authoring_generation_retired",
        "This save belongs to a retired journal. Preserve its source and reopen before creating a new save.",
      );
    try {
      if (
        request.op === "draft.save" ||
        request.op === "document.apply" ||
        request.op === "document.publish" ||
        request.op === "draft.send" ||
        request.op === "operation.send"
      )
        return await this.#slot(() => this.#runCompiled(context, request, payload));
      return this.#receipt(this.#runSync(context, request, payload));
    } catch (error) {
      if (error instanceof Replay) return this.#receipt(this.#retryAdmission(error.record));
      throw error;
    }
  }
  #afterCompile(context: Context, request: AuthoringRequest, payload: string): Project {
    const project = this.#fresh(context),
      existing = this.#lookup(request.operationId, payload, project.root);
    if (existing) throw new Replay(existing);
    return project;
  }
  async #runCompiled(context: Context, request: AuthoringRequest, payload: string): Promise<AuthoringReceipt> {
    if (request.op === "draft.save") {
      const initialOrigin =
        request.origin?.kind === "document" ? this.#open(context.project, request.origin.target) : null;
      if (initialOrigin && request.origin?.kind === "document")
        this.#checkTarget(initialOrigin, request.origin.expectedTargetRevision);
      const compiled = await this.#compile(request.source),
        fresh = this.#afterCompile(context, request, payload);
      const old = this.#options.store.getDraft(context.project.root, request.draftId);
      let origin: () => DraftOrigin;
      if (old) {
        if (request.origin !== undefined)
          return fail("authoring_draft_mismatch", "existing saved origin is immutable; omit origin on later saves");
        const kept = old.origin;
        origin = () => kept;
      } else if (request.origin?.kind === "new") {
        const path = request.origin.path ? this.#newPath(context, request.origin.path).stored : undefined;
        origin = () => ({ kind: "new", ...(path ? { proposedPath: path } : {}) });
      } else if (request.origin?.kind === "document") {
        const opened = this.#open(fresh, request.origin.target);
        this.#checkTarget(opened, request.origin.expectedTargetRevision);
        if (opened.canonical !== initialOrigin!.canonical)
          return fail("revision_conflict", "proposal base source changed");
        // A proposal keeps the base the person opened (ADR 0025), never the file's newer bytes: rebasing onto an
        // external write would claim the person undid it (ADR 0027). When the file changed since, that base is the
        // editor's opened copy, accepted only if it is exactly the revision it was opened at; status reports it diverged.
        const expected = request.origin.expectedSourceRevision,
          claimed = request.origin.baseSource === undefined ? null : Buffer.from(request.origin.baseSource);
        const baseBytes =
          opened.public.sourceRevision === expected
            ? opened.bytes
            : claimed && revisionOf(claimed) === expected
              ? claimed
              : null;
        if (!baseBytes)
          return fail(
            "revision_conflict",
            claimed ? "proposal base is not the revision it was opened at" : "proposal base source changed",
          );
        let made: DraftOrigin | undefined; // its base snapshot is written once, after re-authorization
        origin = () =>
          (made ??= {
            kind: "document",
            path: opened.public.path,
            ...(opened.public.blockId ? { blockId: opened.public.blockId } : {}),
            baseSourceRevision: expected,
            base: this.#options.store.putSnapshot(baseBytes),
          });
      } else return fail("authoring_invalid_request", "first save requires an origin");
      const record = this.#begin(
        context,
        request,
        payload,
        () => (
          origin(),
          {
            target: { kind: "draft", draftId: request.draftId },
            expected: {
              ...(request.expectedDraftRevision === null ? {} : { draftRevision: request.expectedDraftRevision }),
            },
            base: old?.head.source ?? null,
            candidate: this.#options.store.putSnapshot(Buffer.from(request.source)),
          }
        ),
      );
      try {
        const saved = this.#options.store.saveDraft({
          projectRoot: context.project.root,
          draftId: request.draftId,
          expectedDraftRevision: request.expectedDraftRevision,
          origin: origin(),
          source: Buffer.from(request.source),
          valid: compiled.envelope !== null,
          ...(request.intent === undefined ? {} : { intent: request.intent }),
        });
        const noEffect =
          saved.kind === "unchanged" ||
          (saved.draft.origin.kind === "document" &&
            saved.draft.origin.base.revision === saved.draft.head.source.revision);
        const state = noEffect
          ? "not_queued_no_effect"
          : !saved.draft.head.valid
            ? "not_queued_invalid"
            : record.feedback.changes === "manual"
              ? "not_queued_manual"
              : "admission_pending";
        return this.#receipt(
          this.#retryAdmission(
            this.#complete(record, {
              outcome: saved.kind,
              draft: { draftId: request.draftId, draftRevision: saved.draft.draftRevision },
              review: this.#review(record.feedback, state),
              evidence: "observed",
            }),
          ),
        );
      } catch (error) {
        const conflict = this.#conflict(record, error);
        return conflict ? this.#receipt(conflict) : this.#failed(record);
      }
    }
    if (request.op === "draft.send") {
      const draft = this.#draft(context.project.root, request.draftId),
        saved = this.#saved(draft, request.draftRevision);
      if (draft.state === "discarded") return fail("authoring_draft_conflict", "discarded draft cannot be sent");
      const source = this.#options.store.readSnapshot(saved.source);
      const compiled = await this.#compile(decode(source));
      this.#afterCompile(context, request, payload);
      if (this.#draft(context.project.root, request.draftId).state === "discarded")
        return fail("authoring_draft_conflict", "draft was discarded while preparing review");
      if (!compiled.envelope) return fail("invalid_source", "invalid saved source cannot be sent for review");
      const record = this.#begin(context, request, payload, () => ({
        target: { kind: "draft", draftId: request.draftId },
        expected: { draftRevision: request.draftRevision },
        base:
          draft.origin.kind === "document"
            ? draft.origin.base
            : request.draftRevision > 1
              ? this.#saved(draft, request.draftRevision - 1).source
              : null,
        candidate: saved.source,
      }));
      const ref = { draftId: request.draftId, draftRevision: request.draftRevision },
        existing = this.#existingReview(record, ref),
        noEffect = record.base?.revision === record.candidate?.revision;
      const result = this.#complete(record, {
        outcome: existing || noEffect ? "no_effect" : "sent",
        draft: ref,
        review: existing ?? this.#review(record.feedback, noEffect ? "not_queued_no_effect" : "admission_pending"),
      });
      return this.#receipt(this.#retryAdmission(result));
    }
    if (request.op === "operation.send") {
      const original = this.#options.store.getOperation(request.targetOperationId);
      if (!original || original.projectRoot !== context.project.root)
        return fail("authoring_not_found", "original operation not found");
      if (
        original.state !== "terminal" ||
        (!original.completion.document &&
          !(original.completion.evidence === "inferred_confirmed" && original.completion.review.reviewId)) ||
        !["applied", "created", "resolved"].includes(original.completion.outcome) ||
        !original.candidate
      )
        return fail("authoring_invalid_request", "only a completed source effect can be sent");
      const compiled = await this.#compile(decode(this.#options.store.readSnapshot(original.candidate)));
      this.#afterCompile(context, request, payload);
      if (!compiled.envelope) return fail("invalid_source", "operation snapshot does not compile");
      const record = this.#begin(context, request, payload, () => ({
        target: { kind: "operation", operationId: original.operationId },
        expected: {},
        base: original.base,
        candidate: original.candidate,
      }));
      if (original.completion.review.reviewId) {
        const current =
          this.#options.store.getReview(context.project.root, original.completion.review.reviewId) ??
          fail("authoring_not_found", "cumulative review not found");
        if (current.state === "cleared")
          return this.#receipt(
            this.#complete(record, {
              outcome: "no_effect",
              review: this.#review(record.feedback, "not_queued_no_effect"),
            }),
          );
        const offered = this.#options.store.offerReview(context.project.root, current.reviewId, current.reviewRevision);
        return this.#receipt(
          this.#complete(record, {
            outcome: current.delivery === "offered" ? "no_effect" : "sent",
            review: {
              ...this.#review(record.feedback, "tracked"),
              reviewId: offered.reviewId,
              reviewRevision: offered.reviewRevision,
            },
          }),
        );
      }
      const existing = this.#existingReview(record, undefined, original.operationId);
      return this.#receipt(
        this.#retryAdmission(
          this.#complete(record, {
            outcome: existing ? "no_effect" : "sent",
            review: existing ?? this.#review(record.feedback, "admission_pending"),
          }),
        ),
      );
    }
    if (request.op !== "document.apply" && request.op !== "document.publish")
      return fail("authoring_invalid_request", "unknown compiled operation");
    const opened = request.op === "document.apply" ? this.#open(context.project, request.target) : null;
    if (opened && request.op === "document.apply") this.#checkTarget(opened, request.expectedTargetRevision);
    const newPath = request.op === "document.publish" ? this.#newPath(context, request.path) : null;
    const publication =
      request.op === "document.publish"
        ? this.#publishIdentity(context.project, request.path, newPath!.canonical)
        : null;
    if (
      opened &&
      readPreamble(opened.public.source).family !== undefined &&
      readPreamble(opened.public.source).family !== readPreamble(request.source).family
    )
      return fail("invalid_source", "changing an existing diagram family is outside this editor");
    const compiled = await this.#compile(request.source);
    this.#afterCompile(context, request, payload);
    if (!compiled.envelope) return fail("invalid_source", "browser source must compile before publication");
    this.#fresh(context);
    let begun: JournalRecord | null = null,
      finished: JournalRecord | null = null,
      prepared = false;
    const completionFor = (written: SourcePublication, record: JournalRecord): JournalCompletion => ({
      outcome: written.outcome === "created" ? "created" : written.outcome === "unchanged" ? "unchanged" : "applied",
      document: {
        path: projectPath(context.project, realOf(resolveInFolder(context.project, written.path))),
        ...(request.op === "document.apply"
          ? { target: request.target, targetRevision: request.expectedTargetRevision }
          : publication!),
        ...(written.blockId ? { blockId: written.blockId } : {}),
        sourceRevision: written.sourceRevision,
        modelRevision: null,
        ...(request.op === "document.apply"
          ? {
              normalized: {
                pinnedName: written.blockId !== null && archerIdOf(request.source.replace(/\r\n?/gu, "\n")) === null,
                lineEndings:
                  [...request.source.matchAll(/\r\n|\r|\n/gu)].some(
                    (match) => match[0] !== /\r\n|\r|\n/u.exec(written.after.toString("utf8"))?.[0],
                  ) || /[\r\n]$/u.test(request.source) !== /[\r\n]$/u.test(written.after.toString("utf8")),
              },
            }
          : {}),
      },
      review: this.#review(
        record.feedback,
        written.outcome === "unchanged" ? "not_queued_no_effect" : "admission_pending",
      ),
      evidence: "observed",
    });
    const planned = (plan: BeforeWritePlan) => {
      const fresh = this.#fresh(context);
      if (request.op === "document.apply")
        this.#checkTarget(this.#open(fresh, request.target), request.expectedTargetRevision);
      else if (
        this.#publishIdentity(fresh, request.path, newPath!.canonical).targetRevision !== publication!.targetRevision
      )
        fail("authoring_target_conflict", "publish identity changed while preparing source");
      const actualStored = projectPath(context.project, realOf(resolveInFolder(context.project, plan.path)));
      if (actualStored !== (opened?.public.path ?? newPath!.stored))
        return fail("authoring_authority_changed", "canonical target changed while preparing source");
      begun = this.#begin(context, request, payload, () => ({
        target: { kind: "document", path: actualStored, ...(plan.blockId ? { blockId: plan.blockId } : {}) },
        expected: { sourceRevision: plan.sourceRevision },
        base: plan.before ? this.#options.store.putSnapshot(plan.before) : null,
        candidate: this.#options.store.putSnapshot(plan.after),
      }));
      const future = completionFor(
        {
          ...plan,
          sourceRevision: revisionOf(plan.after),
          outcome: plan.before === null ? "created" : plan.before.equals(plan.after) ? "unchanged" : "updated",
        },
        begun,
      );
      this.#options.store.assertSourceReviewCapacity(begun.operationId, begun.payloadDigest, future);
      prepared = true;
    };
    const published = (written: SourcePublication) => {
      if (!begun) return fail("authoring_operation_uncertain", "source publication has no durable intent");
      // Authority was checked immediately before publication. After the effect, record observed facts.
      if (request.op === "document.publish") {
        const actual = this.#open(context.project, publication!.target);
        if (
          actual.canonical !== newPath!.canonical ||
          actual.public.targetRevision !== publication!.targetRevision ||
          revisionOf(actual.bytes) !== begun.candidate!.revision
        )
          throw new SourceWriteError("write_uncertain", "published diagram identity could not be observed");
      }
      if (
        revisionOf(written.after) !== begun.candidate!.revision ||
        (written.before === null) !== (begun.base === null) ||
        (written.before !== null && revisionOf(written.before) !== begun.base?.revision)
      )
        throw new SourceWriteError("write_uncertain", "source observation differs from durable intent");
      finished = this.#options.store.completeSourceOperation(
        begun.operationId,
        begun.payloadDigest,
        completionFor(written, begun),
      );
    };
    try {
      if (request.op === "document.apply")
        await applySource(context.project, request.target, request.expectedSourceRevision as Revision, request.source, {
          syncDirectory: true,
          beforeWrite: planned,
          afterWrite: published,
        });
      else
        createConfined(context.project, request.path, request.source, {
          syncDirectory: true,
          beforeWrite: planned,
          afterWrite: published,
        });
      if (!finished)
        return fail("authoring_operation_uncertain", "source writer returned without terminal publication");
      return this.#receipt(finished);
    } catch (error) {
      if (error instanceof Replay) throw error;
      if (begun) {
        if (finished) return this.#receipt(finished);
        // Only explicit preparation evidence proves no canonical publication occurred.
        // Untagged rename/link failures stay uncertain even if their OS code looks retryable.
        if (!prepared || (error as { phase?: string }).phase === "prepublication") {
          const record = begun as JournalRecord;
          this.#complete(record, {
            outcome: "no_effect",
            review: this.#review(record.feedback, "not_queued_no_effect"),
          });
          throw error;
        }
        return this.#failed(begun);
      }
      if ((error as { code?: string }).code === "revision_conflict" || (error as { code?: string }).code === "EEXIST") {
        const record = this.#begin(context, request, payload, () => ({
          target: {
            kind: "document",
            path: opened?.public.path ?? newPath!.stored,
            ...(opened?.public.blockId ? { blockId: opened.public.blockId } : {}),
          },
          expected: { sourceRevision: request.op === "document.apply" ? request.expectedSourceRevision : null },
          base: opened ? this.#options.store.putSnapshot(opened.bytes) : null,
          candidate: this.#options.store.putSnapshot(Buffer.from(request.source)),
        }));
        return this.#receipt(
          this.#complete(record, {
            outcome: "conflict",
            conflict: { kind: (error as { code: string }).code === "EEXIST" ? "exists" : "source" },
            review: this.#review(record.feedback, "not_queued_no_effect"),
          }),
        );
      }
      throw error;
    }
  }
  #publishIdentity(
    project: Project,
    path: string,
    canonical: string,
  ): { target: AuthoringTarget; targetRevision: string } {
    const viewId = basename(path, ".mmd");
    if (
      !isStableId(viewId) ||
      confine(project, canonical)
        .split("/")
        .some((segment) => segment.startsWith("."))
    )
      return fail("authoring_target_invalid", "new diagrams require a discoverable stable basename ID");
    const mapped = project.views.some(
      (view) => view.id === viewId && realOf(resolveInFolder(project, view.source)) !== canonical,
    );
    const discovered = listDiagrams(project).some(
      (entry) =>
        entry.view === undefined &&
        basename(entry.path, ".mmd") === viewId &&
        realOf(resolveInFolder(project, entry.path)) !== canonical,
    );
    if (mapped || discovered)
      return fail("authoring_target_conflict", "new diagram basename already names another view");
    const target: AuthoringTarget = { kind: "view", viewId };
    return { target, targetRevision: this.#targetRevision(project, target, canonical, null) };
  }
  #newPath(context: Context, path: string): { stored: string; canonical: string } {
    const destination = resolveInFolder(context.project, path),
      canonical = realOf(destination); /* folders on the way may not exist yet: the writer makes them (ADR 0028) */
    return { stored: projectPath(context.project, canonical), canonical };
  }
  #failed(record: JournalRecord): never {
    try {
      this.#options.store.markOperationUncertain(record.operationId, record.payloadDigest);
    } catch {
      /* An unavailable journal is recovered by the next owner; never repeat the source effect. */
    }
    throw new AuthoringCoordinatorError(
      "authoring_operation_uncertain",
      `operation ${record.operationId} requires reconciliation; no automatic replay`,
      record.operationId,
    );
  }
  #runSync(context: Context, request: AuthoringRequest, payload: string): JournalRecord {
    if (request.op === "draft.discard") {
      const draft = this.#draft(context.project.root, request.draftId),
        record = this.#begin(context, request, payload, () => ({
          target: { kind: "draft", draftId: request.draftId },
          expected: { draftRevision: request.draftRevision },
          base: draft.head.source,
          candidate: draft.head.source,
        }));
      try {
        const updated = this.#options.store.setDraftState(
          context.project.root,
          request.draftId,
          request.draftRevision,
          "discarded",
        );
        return this.#complete(record, {
          outcome: draft.state === updated.state ? "no_effect" : "discarded",
          draft: { draftId: updated.draftId, draftRevision: updated.draftRevision },
          review: this.#review(record.feedback, "not_queued_no_effect"),
        });
      } catch (error) {
        return this.#conflict(record, error) ?? this.#failed(record);
      }
    }
    if (request.op === "change.withdraw") {
      const change = this.#options.changes.get(context.project.root, request.changeId);
      if (!change) return fail("authoring_not_found", "change not found in project");
      const record = this.#begin(context, request, payload, () => ({
        target: { kind: "change", changeId: request.changeId },
        expected: { reviewRevision: request.reviewRevision },
        base: null,
        candidate: null,
      }));
      try {
        this.#options.changes.resolveReview(
          context.project.root,
          request.changeId,
          request.reviewRevision,
          "withdrawn",
          "browser",
        );
        return this.#complete(record, {
          outcome: change.disposition === "withdrawn" ? "no_effect" : "withdrawn",
          review: this.#review(record.feedback, "withdrawn"),
        });
      } catch (error) {
        return this.#conflict(record, error) ?? this.#failed(record);
      }
    }
    if (request.op === "operation.resolve_uncertain") {
      const original = this.#options.store.getOperation(request.targetOperationId);
      if (!original || original.projectRoot !== context.project.root)
        return fail("authoring_not_found", "uncertain operation not found");
      if (original.state !== "uncertain")
        return fail("authoring_invalid_request", "only an uncertain operation may be resolved");
      const current = this.#probe(original);
      if (request.resolution === "abandon" && current.observed === "matches_candidate")
        return fail("authoring_resolution_conflict", "observed candidate must be confirmed and tracked");
      if (request.resolution === "confirm_candidate" && current.observed !== "matches_candidate")
        return fail("authoring_resolution_conflict", "current source does not match candidate");
      const record = this.#begin(context, request, payload, () => ({
        target: { kind: "operation", operationId: original.operationId },
        expected: {},
        base: original.base,
        candidate: original.candidate,
      }));
      const resolution: JournalCompletion = {
        outcome: "resolved",
        current,
        evidence: request.resolution === "confirm_candidate" ? "inferred_confirmed" : "abandoned",
        review: this.#review(original.feedback, "not_queued_no_effect"),
      };
      const resolved =
        original.target.kind === "document"
          ? this.#options.store.resolveSourceOperation(original.operationId, original.payloadDigest, resolution)
          : this.#options.store.resolveOperation(original.operationId, original.payloadDigest, resolution);
      const tracked = resolved.state === "terminal" ? resolved.completion.review : null;
      return this.#complete(record, {
        ...resolution,
        review: tracked?.reviewId
          ? {
              ...this.#review(record.feedback, tracked.state),
              reviewId: tracked.reviewId,
              reviewRevision: tracked.reviewRevision!,
            }
          : this.#review(record.feedback, "not_queued_no_effect"),
      });
    }
    return fail("authoring_invalid_request", "unknown synchronous operation");
  }
  #probe(record: JournalRecord): NonNullable<JournalCompletion["current"]> {
    let bytes: Buffer | null = null,
      sourceRevision: string | null = null;
    if (record.target.kind === "draft") {
      const draft = this.#options.store.getDraft(record.projectRoot, record.target.draftId);
      if (draft) {
        bytes = this.#options.store.readSnapshot(draft.head.source);
        sourceRevision = draft.head.source.revision;
      }
    } else if (record.target.kind === "document") {
      const stored = record.target.path,
        absolute = resolve(record.projectRoot, stored);
      try {
        if (realpathSync(absolute) !== absolute)
          return fail("authoring_probe_unavailable", "original source path has been redirected");
        if (record.target.blockId) {
          const project: Project = {
            root: record.projectRoot,
            folder: dirname(absolute),
            folderSetting: relative(record.projectRoot, dirname(absolute)),
            manifest: null,
            views: [],
            problems: [],
          };
          const read = readEmbedded(project, `${basename(absolute)}#${record.target.blockId}`);
          if (read) {
            bytes = body(read);
            sourceRevision = read.sourceRevision;
          }
        } else {
          bytes = exactBytes((limit) =>
            readInProject(
              {
                root: record.projectRoot,
                folder: dirname(absolute),
                folderSetting: relative(record.projectRoot, dirname(absolute)),
                manifest: null,
                views: [],
                problems: [],
              },
              stored,
              limit,
            ),
          );
          sourceRevision = revisionOf(bytes);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          return fail(
            "authoring_probe_unavailable",
            "The original source cannot be inspected safely. Restore its access and identity before resolving this operation.",
          );
      }
    }
    const contentRevision = bytes ? revisionOf(bytes) : null;
    const observed =
      bytes === null
        ? "missing"
        : record.candidate?.revision === contentRevision
          ? "matches_candidate"
          : record.base?.revision === contentRevision
            ? "matches_base"
            : "diverged";
    return { observed, sourceRevision, contentRevision, inferred: true };
  }
}
