/** Browser authoring DTOs. Credentials, project roots, feedback and snapshots are server-owned. */
export type AuthoringTarget = { kind: "view"; viewId: string } | { kind: "embedded"; address: string };
export type DraftOriginInput =
  | { kind: "new"; path?: string }
  | {
      kind: "document";
      target: AuthoringTarget;
      expectedSourceRevision: string;
      expectedTargetRevision: string;
      /** The exact source the editor opened (its revision is expectedSourceRevision). With it, a first save after an external
       * write keeps that opened base and is reported diverged, instead of being refused (O84; ADR 0025 immutable base). */
      baseSource?: string;
    };
type Mutation = { operationId: string; journalGeneration?: string };
export type AuthoringRequest = Mutation &
  (
    | {
        op: "draft.save";
        draftId: string;
        expectedDraftRevision: number | null;
        source: string;
        origin?: DraftOriginInput;
        intent?: string;
      }
    | { op: "draft.send" | "draft.discard"; draftId: string; draftRevision: number }
    | {
        op: "document.apply";
        target: AuthoringTarget;
        expectedSourceRevision: string;
        expectedTargetRevision: string;
        source: string;
        intent?: string;
      }
    | { op: "document.publish"; path: string; source: string; intent?: string }
    | { op: "operation.send"; targetOperationId: string }
    | { op: "change.withdraw"; changeId: string; reviewRevision: number }
    | { op: "operation.resolve_uncertain"; targetOperationId: string; resolution: "confirm_candidate" | "abandon" }
  );
export interface AuthoringReceipt {
  operationId: string;
  state: "intent" | "uncertain" | "terminal";
  outcome?: string;
  review?: {
    mode: "on_save" | "manual";
    configRevision: string;
    state: string;
    changeId?: string;
    reviewId?: string;
    reviewRevision?: number;
  };
  subject?: { path: string; blockId?: string };
  artifact?: { status: "written" | "removed" | "blocked" | "unavailable" | "stale"; path?: string; message?: string };
  draft?: { draftId: string; draftRevision: number };
  document?: {
    path: string;
    blockId?: string;
    target?: AuthoringTarget;
    targetRevision?: string;
    sourceRevision: string;
    modelRevision: string | null;
    normalized?: { pinnedName: boolean; lineEndings: boolean };
  };
  current?: {
    observed: "matches_base" | "matches_candidate" | "diverged" | "missing";
    sourceRevision: string | null;
    contentRevision: string | null;
    inferred: true;
  };
  /** Current bytes cannot be inspected safely; this is not evidence of missing or unchanged source. */
  probeUnavailable?: true;
  evidence?: "observed" | "inferred_confirmed" | "abandoned";
  conflict?: {
    kind: "source" | "draft" | "review" | "exists";
    currentSourceRevision?: string | null;
    currentDraftRevision?: number;
    currentMatchesCandidate?: boolean;
  };
}
export class AuthoringInputError extends Error {
  readonly code = "authoring_invalid_request";
}
const invalid = (): never => {
  throw new AuthoringInputError("invalid or oversized authoring request");
};
const bytes = (s: string) => new TextEncoder().encode(s).length;
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    keys.length > 12 ||
    required.some((k) => !Object.hasOwn(descriptors, k)) ||
    keys.some((k) => !required.includes(k) && !optional.includes(k)) ||
    keys.some((k) => descriptors[k]?.get || descriptors[k]?.set)
  )
    return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\uD800-\uDFFF]/u.test(value) ||
    bytes(value) > max ||
    (pattern && !pattern.test(value))
  )
    return invalid();
  return value;
}
function integer(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
}
function path(value: unknown): void {
  const p = text(value, 1024);
  if (
    !p ||
    /[\\\0-\x1f\x7f?#:]/u.test(p) ||
    p.startsWith("/") ||
    p.split("/").some((s) => !s || s === "." || s === "..")
  )
    invalid();
}
const opId = (v: unknown) => text(v, 32, /^[0-9a-f]{32}$/u);
const draftId = (v: unknown) => text(v, 36, /^drf_[0-9a-f]{32}$/u);
const revision = (v: unknown) => text(v, 71, /^sha256:[0-9a-f]{64}$/u);
export function parseAuthoringTarget(value: unknown): AuthoringTarget {
  const v = object(value, ["kind"], ["viewId", "address"]);
  if (v.kind === "view") {
    object(v, ["kind", "viewId"]);
    text(v.viewId, 128, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
  } else if (v.kind === "embedded") {
    object(v, ["kind", "address"]);
    const a = text(v.address, 1200);
    const split = a.split("#");
    if (split.length !== 2) invalid();
    path(split[0]);
    text(split[1], 128, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
    if (!split[0]!.endsWith(".md")) invalid();
  } else invalid();
  return structuredClone(v) as AuthoringTarget;
}
export function parseAuthoringRequest(value: unknown): AuthoringRequest {
  try {
    const full = object(
      value,
      ["op", "operationId"],
      [
        "journalGeneration",
        "draftId",
        "expectedDraftRevision",
        "source",
        "origin",
        "intent",
        "draftRevision",
        "target",
        "expectedSourceRevision",
        "expectedTargetRevision",
        "path",
        "targetOperationId",
        "changeId",
        "reviewRevision",
        "resolution",
      ],
    );
    const { journalGeneration, ...v } = full;
    if (journalGeneration !== undefined) text(journalGeneration, 36, /^gen_[0-9a-f]{32}$/u);
    opId(v.operationId);
    if (v.op === "draft.save") {
      object(v, ["op", "operationId", "draftId", "expectedDraftRevision", "source"], ["origin", "intent"]);
      draftId(v.draftId);
      if (v.expectedDraftRevision !== null) integer(v.expectedDraftRevision);
      if (v.origin !== undefined) {
        const o = object(
          v.origin,
          ["kind"],
          ["path", "target", "expectedSourceRevision", "expectedTargetRevision", "baseSource"],
        );
        if (o.kind === "new") {
          object(o, ["kind"], ["path"]);
          if (o.path !== undefined) path(o.path);
        } else if (o.kind === "document") {
          object(o, ["kind", "target", "expectedSourceRevision", "expectedTargetRevision"], ["baseSource"]);
          parseAuthoringTarget(o.target);
          revision(o.expectedSourceRevision);
          revision(o.expectedTargetRevision);
          if (o.baseSource !== undefined) text(o.baseSource, 262144);
        } else invalid();
      }
    } else if (v.op === "draft.send" || v.op === "draft.discard") {
      object(v, ["op", "operationId", "draftId", "draftRevision"]);
      draftId(v.draftId);
      integer(v.draftRevision);
    } else if (v.op === "document.apply") {
      object(
        v,
        ["op", "operationId", "target", "expectedSourceRevision", "expectedTargetRevision", "source"],
        ["intent"],
      );
      parseAuthoringTarget(v.target);
      revision(v.expectedSourceRevision);
      revision(v.expectedTargetRevision);
    } else if (v.op === "document.publish") {
      object(v, ["op", "operationId", "path", "source"], ["intent"]);
      path(v.path);
      if (!(v.path as string).endsWith(".mmd")) invalid();
    } else if (v.op === "operation.send") {
      object(v, ["op", "operationId", "targetOperationId"]);
      opId(v.targetOperationId);
    } else if (v.op === "change.withdraw") {
      object(v, ["op", "operationId", "changeId", "reviewRevision"]);
      text(v.changeId, 36, /^chg_[0-9a-f]{32}$/u);
      integer(v.reviewRevision);
    } else if (v.op === "operation.resolve_uncertain") {
      object(v, ["op", "operationId", "targetOperationId", "resolution"]);
      opId(v.targetOperationId);
      if (v.resolution !== "confirm_candidate" && v.resolution !== "abandon") invalid();
    } else invalid();
    if (v.source !== undefined) text(v.source, 262144);
    if (v.intent !== undefined) text(v.intent, 2048);
    return {
      ...structuredClone(v),
      ...(journalGeneration === undefined ? {} : { journalGeneration }),
    } as AuthoringRequest;
  } catch {
    return invalid();
  }
}
export interface AuthoringDraftSummary {
  draftId: string;
  draftRevision: number;
  state: "open" | "discarded" | "applied" | "published";
  valid: boolean;
  sourceRevision: string;
  savedAt: string;
  origin: {
    kind: "new" | "document";
    path?: string;
    blockId?: string;
    baseSourceRevision?: string;
    target?: AuthoringTarget;
    targetRevision?: string;
    /** A proposal whose base is no longer the file's current source (the file changed or went away since it was opened). */
    diverged?: boolean;
  };
}
export interface AuthoringStatus {
  storeId: string;
  generation: string;
  drafts: AuthoringDraftSummary[];
  operations: AuthoringReceipt[];
  /** Cursor for the next operations page; drafts are bounded by the store's project revision limit. */
  nextOffset: number | null;
  /** All unfinished metadata, bounded by journal capacity; probe explicitly for current evidence. */
  unfinishedOperations?: AuthoringReceipt[];
  /** Latest saved source operations with a pending held review, independent of history pagination. */
  heldSourceOperations?: AuthoringReceipt[];
  usage?: {
    operations: { used: number; limit: number };
    reviews: { used: number; limit: number };
    savedDraftRevisions: { used: number; limit: number };
    perDraftRevisionLimit: number;
  };
  /**
   * Whether the person may create and edit in the page (ADR 0028, decided 2026-10-28): `project` is the project's
   * archer.toml `edit = false`, `global` the account's archer.toml `edit = false`, `account` its `[[projects]]` rules.
   */
  edit: { enabled: boolean; reason?: "project" | "global" | "account" };
}
export interface AuthoringOpen {
  target: AuthoringTarget;
  path: string;
  authoringPath: string;
  blockId: string | null;
  source: string;
  sourceRevision: string;
  targetRevision: string;
  writable: boolean;
}
export interface AuthoringSnapshot {
  draftId: string;
  draftRevision: number;
  source: string;
  valid: boolean;
  intent?: string;
}
export type AuthoringAccessStatus = { authorized: false } | ({ authorized: true } & AuthoringStatus);
