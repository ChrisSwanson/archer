import { createHash, randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { MAX_SOURCE_BYTES } from "../mermaid/limits.ts";
import { ChangeStoreError } from "./errors.ts";
import { withChangeStoreIo, type ChangeStoreIo, type ChangeStoreIoHook } from "./io.ts";
export { ChangeStoreError } from "./errors.ts";
export const CHANGE_STORE_LIMITS = {
  sourceBytes: MAX_SOURCE_BYTES,
  intentBytes: 2048,
  projectRootBytes: 4096,
  targetPathBytes: 1024,
  opaqueIdCharacters: 128,
  pendingPerProject: 256,
  records: 4096,
  indexBytes: 8 * 1024 * 1024,
  snapshotBytes: 128 * 1024 * 1024,
  physicalBytes: 160 * 1024 * 1024,
  directoryEntries: 8192,
  query: 100,
  jsonDepth: 4,
  jsonValues: 100000,
} as const;
export type ChangeEventKind = "draft.saved" | "proposal.saved" | "document.created" | "document.updated";
export type ChangeTarget =
  | {
      readonly kind: "draft";
      readonly id: string;
      readonly proposedPath?: string;
    }
  | {
      readonly kind: "document";
      readonly path: string;
      readonly blockId?: string;
    };
export interface ChangeInput {
  readonly operationId: string;
  readonly projectRoot: string;
  readonly format: "mermaid";
  readonly origin: "browser_editor";
  readonly target: ChangeTarget;
  readonly eventKind: ChangeEventKind;
  readonly before: Uint8Array | null;
  readonly after: Uint8Array;
  readonly intent?: string;
}
export interface SnapshotReference {
  readonly revision: string;
  readonly bytes: number;
}
export interface ChangeRecord {
  readonly schemaVersion: 1;
  readonly storeId: string;
  readonly generation: string;
  readonly changeId: string;
  readonly projectRoot: string;
  readonly sequence: number;
  readonly operationId: string;
  readonly payloadDigest: string;
  readonly format: "mermaid";
  readonly origin: "browser_editor";
  readonly eventKind: ChangeEventKind;
  readonly target: ChangeTarget;
  readonly before: SnapshotReference | null;
  readonly after: SnapshotReference;
  readonly savedAt: string;
  readonly intent?: string;
  readonly disposition: "pending" | "handled" | "declined" | "withdrawn";
  readonly resolvedAt?: string;
  readonly resolvedBy?: "agent" | "browser";
  readonly reviewRevision: number;
}
export type CommitStep =
  | "before_blob_write"
  | "after_blob_link"
  | "after_blob_sync"
  | "before_index_rename"
  | "after_index_rename"
  | "after_index_directory_sync"
  | "before_open_sync"
  | "before_uncertain_replay_sync";
export interface ChangeStoreOptions {
  readonly stateDir: string;
  readonly serviceName: string;
  readonly assertOwner: () => void;
  readonly now?: () => number;
  readonly onCommitStep?: (step: CommitStep) => void;
}
interface ChangeIndex {
  version: 1 | 2;
  serviceName: string;
  storeId: string;
  generation: string;
  records: ChangeRecord[];
}
const fail = (code: string, message: string): never => {
  throw new ChangeStoreError(code, message);
};
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function requirePlain(value: unknown, code: string, message: string): asserts value is Record<string, unknown> {
  if (!plain(value)) fail(code, message);
}
const exactKeys = (
  object: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
  code = "change_store_invalid",
) => {
  const accepted = new Set([...required, ...optional]);
  if (required.some((k) => !own(object, k)) || Object.keys(object).some((k) => !accepted.has(k)))
    fail(code, "object has unexpected fields");
};
const asString = (value: unknown, name: string): string =>
  typeof value === "string" ? value : fail("change_store_invalid", `${name} must be a string`);
const integer = (value: unknown, name: string): number =>
  Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fail("change_store_invalid", `${name} must be a positive integer`);
const revision = (value: unknown): SnapshotReference => {
  requirePlain(value, "change_store_invalid", "snapshot reference must be an object");
  exactKeys(value, ["revision", "bytes"]);
  const rev = asString(value.revision, "revision");
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(rev) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 0 ||
    Number(value.bytes) > CHANGE_STORE_LIMITS.sourceBytes
  )
    fail("change_store_invalid", "invalid snapshot reference");
  return { revision: rev, bytes: Number(value.bytes) };
};
export function parseChangeIndex(bytes: Uint8Array): ChangeIndex {
  if (bytes.byteLength > CHANGE_STORE_LIMITS.indexBytes) fail("change_store_limit", "change index exceeds indexBytes");
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("change_store_invalid", "change index is not UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("change_store_invalid", "change index is not valid JSON");
  }
  const work: [unknown, number][] = [[raw, 0]];
  let values = 0;
  while (work.length) {
    const [value, depth] = work.pop()!;
    if (++values > CHANGE_STORE_LIMITS.jsonValues) fail("change_store_limit", "change index exceeds jsonValues");
    if (depth > CHANGE_STORE_LIMITS.jsonDepth) fail("change_store_limit", "change index exceeds jsonDepth");
    if (Array.isArray(value)) for (const child of value) work.push([child, depth + 1]);
    else if (plain(value)) for (const child of Object.values(value)) work.push([child, depth + 1]);
  }
  requirePlain(raw, "change_store_invalid", "change index root must be an object");
  exactKeys(raw, ["version", "serviceName", "storeId", "generation", "records"]);
  if (
    (raw.version !== 1 && raw.version !== 2) ||
    !/^store_[0-9a-f]{32}$/u.test(asString(raw.storeId, "storeId")) ||
    !/^gen_[0-9a-f]{32}$/u.test(asString(raw.generation, "generation")) ||
    !Array.isArray(raw.records)
  )
    fail("change_store_invalid", "invalid change index identity");
  const records = Array.isArray(raw.records) ? raw.records : fail("change_store_invalid", "records must be an array");
  if (records.length > CHANGE_STORE_LIMITS.records) fail("change_store_limit", "change index exceeds records");
  const index: ChangeIndex = {
    version: raw.version as 1 | 2,
    serviceName: asString(raw.serviceName, "serviceName"),
    storeId: raw.storeId as string,
    generation: raw.generation as string,
    records: records.map((value) => parseRecord(value, raw.version as 1 | 2)),
  };
  validateChangeIndex(index);
  return index;
}
function canonicalDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function reviewActorValid(disposition: unknown, actor: unknown): boolean {
  return disposition === "withdrawn"
    ? actor === "browser"
    : (disposition === "handled" || disposition === "declined") && actor === "agent";
}
function parseRecord(value: unknown, indexVersion: 1 | 2): ChangeRecord {
  requirePlain(value, "change_store_invalid", "change record must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "storeId",
      "generation",
      "changeId",
      "projectRoot",
      "sequence",
      "operationId",
      "payloadDigest",
      "format",
      "origin",
      "eventKind",
      "target",
      "before",
      "after",
      "savedAt",
      "disposition",
      "reviewRevision",
    ],
    indexVersion === 1 ? ["intent"] : ["intent", "resolvedAt", "resolvedBy"],
  );
  if (value.schemaVersion !== 1 || value.format !== "mermaid" || value.origin !== "browser_editor")
    fail("change_store_invalid", "invalid fixed record field");
  const pending = value.disposition === "pending";
  const terminal =
    typeof value.disposition === "string" && ["handled", "declined", "withdrawn"].includes(value.disposition);
  if (
    (!pending && !terminal) ||
    (pending && (value.reviewRevision !== 1 || own(value, "resolvedAt") || own(value, "resolvedBy"))) ||
    (!pending &&
      (indexVersion !== 2 ||
        !Number.isSafeInteger(value.reviewRevision) ||
        Number(value.reviewRevision) < 2 ||
        !reviewActorValid(value.disposition, value.resolvedBy) ||
        !canonicalDate(value.resolvedAt)))
  )
    fail("change_store_invalid", "invalid review disposition metadata");
  const eventKind = asString(value.eventKind, "eventKind");
  if (!["draft.saved", "proposal.saved", "document.created", "document.updated"].includes(eventKind))
    fail("change_store_invalid", "invalid event kind");
  const record: ChangeRecord = {
    schemaVersion: 1,
    storeId: asString(value.storeId, "storeId"),
    generation: asString(value.generation, "generation"),
    changeId: asString(value.changeId, "changeId"),
    projectRoot: asString(value.projectRoot, "projectRoot"),
    sequence: integer(value.sequence, "sequence"),
    operationId: asString(value.operationId, "operationId"),
    payloadDigest: asString(value.payloadDigest, "payloadDigest"),
    format: "mermaid",
    origin: "browser_editor",
    eventKind: eventKind as ChangeEventKind,
    target: parseTarget(value.target, "change_store_invalid"),
    before: value.before === null ? null : revision(value.before),
    after: revision(value.after),
    savedAt: asString(value.savedAt, "savedAt"),
    disposition: value.disposition as ChangeRecord["disposition"],
    reviewRevision: Number(value.reviewRevision),
    ...(!pending
      ? { resolvedAt: value.resolvedAt as string, resolvedBy: value.resolvedBy as "agent" | "browser" }
      : {}),
    ...(own(value, "intent") ? { intent: asString(value.intent, "intent") } : {}),
  };
  const saved = Date.parse(record.savedAt);
  if (
    !/^chg_[0-9a-f]{32}$/u.test(record.changeId) ||
    !/^[0-9a-f]{32}$/u.test(record.operationId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.payloadDigest) ||
    !Number.isFinite(saved) ||
    new Date(saved).toISOString() !== record.savedAt
  )
    fail("change_store_invalid", "invalid record identity");
  return record;
}
function parseTarget(value: unknown, code = "change_invalid_input"): ChangeTarget {
  requirePlain(value, code, "target must be an object");
  if (value.kind === "draft") {
    exactKeys(value, ["kind", "id"], ["proposedPath"], code);
    return {
      kind: "draft",
      id: opaque(value.id, "draft id", code),
      ...(own(value, "proposedPath") ? { proposedPath: relative(value.proposedPath, "proposedPath", code) } : {}),
    };
  }
  if (value.kind === "document") {
    exactKeys(value, ["kind", "path"], ["blockId"], code);
    return {
      kind: "document",
      path: relative(value.path, "path", code),
      ...(own(value, "blockId") ? { blockId: opaque(value.blockId, "blockId", code) } : {}),
    };
  }
  return fail(code, "invalid target kind");
}
function opaque(value: unknown, name: string, code: string): string {
  const result = typeof value === "string" ? value : fail(code, `${name} must be a string`);
  if (result.length === 0 || result.length > CHANGE_STORE_LIMITS.opaqueIdCharacters || /[\0-\x1f\x7f]/u.test(result))
    fail(code, `invalid ${name}`);
  return result;
}
function relative(value: unknown, name: string, code: string): string {
  const result = typeof value === "string" ? value : fail(code, `${name} must be a string`);
  if (
    Buffer.byteLength(result) > CHANGE_STORE_LIMITS.targetPathBytes ||
    result === "" ||
    isAbsolute(result) ||
    result.includes("\\") ||
    result.split("/").some((x) => x === "" || x === "." || x === "..") ||
    /[\0-\x1f\x7f]/u.test(result)
  )
    fail(code, `invalid ${name}`);
  return result;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
export class ChangeStore {
  readonly #assertOwner: () => void;
  readonly #now: () => number;
  readonly #hook: ((step: CommitStep) => void) | undefined;
  readonly #root: string;
  readonly #stateDir: string;
  #rootDevice: number | undefined;
  #rootInode: number | undefined;
  #index!: ChangeIndex;
  #authorityDigest: string | undefined;
  #unavailable = false;
  readonly #uncertain = new Set<string>();
  constructor(options: ChangeStoreOptions) {
    options.assertOwner();
    this.#assertOwner = options.assertOwner;
    this.#now = options.now ?? Date.now;
    this.#hook = options.onCommitStep;
    this.#stateDir = options.stateDir;
    this.#root = join(options.stateDir, "runtime", "change-review");
    try {
      this.#index = this.#open(options.stateDir, options.serviceName);
    } catch (error) {
      if (error instanceof ChangeStoreError) {
        if (error.code === "change_store_io")
          fail("change_store_unavailable", "change store could not complete its open barriers");
        throw error;
      }
      fail("change_store_unavailable", `change store could not open: ${message(error)}`);
    }
    const binding = lstatSync(this.#root);
    this.#rootDevice = binding.dev;
    this.#rootInode = binding.ino;
    this.#authorityDigest = this.#readAuthorityDigest();
  }
  status() {
    this.#guard();
    return { storeId: this.#index.storeId, generation: this.#index.generation };
  }
  admit(input: ChangeInput): {
    kind: "admitted" | "replayed";
    record: ChangeRecord;
  } {
    this.#guard();
    const valid = validateInput(input);
    const payloadDigest = canonicalDigest(valid);
    const existing = this.#index.records.find((r) => r.operationId === valid.operationId);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest)
        fail("change_operation_mismatch", "operation ID was already used with another payload");
      this.#validateRecordBlobs(existing);
      this.#confirmVisibleCommit(existing.operationId);
      return { kind: "replayed", record: clone(existing) };
    }
    if (valid.before !== null && Buffer.from(valid.before).equals(Buffer.from(valid.after)))
      fail("change_no_effect", "before and after snapshots are identical");
    const projectPending = this.#index.records.filter(
      (r) => r.projectRoot === valid.projectRoot && r.disposition === "pending",
    ).length;
    if (
      this.#index.records.length >= CHANGE_STORE_LIMITS.records ||
      projectPending >= CHANGE_STORE_LIMITS.pendingPerProject
    )
      fail("change_store_capacity", "change store record capacity reached");
    const before = valid.before === null ? null : ref(valid.before);
    const after = ref(valid.after);
    const sequence =
      Math.max(0, ...this.#index.records.filter((r) => r.projectRoot === valid.projectRoot).map((r) => r.sequence)) + 1;
    const changeId = `chg_${digest(Buffer.from(JSON.stringify([this.#index.storeId, this.#index.generation, valid.operationId, payloadDigest]))).slice(0, 32)}`;
    if (this.#index.records.some((r) => r.changeId === changeId)) fail("change_store_collision", "change ID collision");
    const record: ChangeRecord = {
      schemaVersion: 1,
      storeId: this.#index.storeId,
      generation: this.#index.generation,
      changeId,
      projectRoot: valid.projectRoot,
      sequence,
      operationId: valid.operationId,
      payloadDigest,
      format: "mermaid",
      origin: "browser_editor",
      eventKind: valid.eventKind,
      target: clone(valid.target),
      before,
      after,
      savedAt: new Date(this.#now()).toISOString(),
      ...(valid.intent === undefined ? {} : { intent: valid.intent }),
      disposition: "pending",
      reviewRevision: 1,
    };
    const next = { ...this.#index, records: [...this.#index.records, record] };
    const encoded = Buffer.from(JSON.stringify(next));
    if (encoded.length > CHANGE_STORE_LIMITS.indexBytes) fail("change_store_capacity", "change index capacity reached");
    try {
      parseChangeIndex(encoded);
    } catch (error) {
      if (error instanceof ChangeStoreError && error.code === "change_store_limit")
        fail("change_store_capacity", "change index structural capacity reached");
      throw error;
    }
    this.#reserve(valid, encoded.length);
    const old = this.#index;
    try {
      if (valid.before) this.#putBlob(valid.before);
      this.#putBlob(valid.after);
      this.#writeIndex(encoded);
      this.#index = next;
      return { kind: "admitted", record: clone(record) };
    } catch (error) {
      this.#recoverCommit(old, next, record, error);
    }
  }
  get(projectRoot: string, changeId: string): ChangeRecord | null {
    this.#guard();
    const record = this.#index.records.find((r) => r.projectRoot === projectRoot && r.changeId === changeId);
    return record ? clone(record) : null;
  }
  /** Shared review state only: exact snapshot/event identity never changes. */
  resolveReview(
    projectRoot: string,
    changeId: string,
    expectedRevision: number,
    disposition: "handled" | "declined" | "withdrawn",
    actor: "agent" | "browser",
  ): ChangeRecord {
    this.#guard();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !reviewActorValid(disposition, actor))
      return fail("change_review_invalid", "invalid review revision, disposition or actor");
    const index = this.#index.records.findIndex((r) => r.projectRoot === projectRoot && r.changeId === changeId);
    const current = this.#index.records[index];
    if (!current) return fail("change_not_found", "change does not exist in this project");
    if (current.reviewRevision !== expectedRevision)
      return fail("change_review_conflict", "review revision changed; read the current disposition before resolving");
    if (current.disposition !== "pending") {
      if (current.disposition === disposition && current.resolvedBy === actor) {
        this.#confirmVisibleCommit(current.operationId);
        return clone(current);
      }
      return fail("change_review_terminal", "resolved review cannot be replaced or reopened");
    }
    this.#validateRecordBlobs(current);
    const record: ChangeRecord = {
      ...current,
      disposition,
      reviewRevision: current.reviewRevision + 1,
      resolvedAt: new Date(this.#now()).toISOString(),
      resolvedBy: actor,
    };
    const records = [...this.#index.records];
    records[index] = record;
    const next: ChangeIndex = { ...this.#index, version: 2, records };
    const bytes = Buffer.from(JSON.stringify(next));
    if (bytes.length > CHANGE_STORE_LIMITS.indexBytes)
      return fail("change_store_capacity", "change index capacity reached");
    parseChangeIndex(bytes);
    withChangeStoreIo(this.#stateDir, (io) => {
      const inventory = io.inventory(ioLimits(), { reconcileBlobPublications: true });
      if (
        inventory.entries + 1 > CHANGE_STORE_LIMITS.directoryEntries ||
        inventory.physicalBytes + bytes.length > CHANGE_STORE_LIMITS.physicalBytes
      )
        fail("change_store_capacity", "review publication exceeds change-store physical capacity");
    });
    const old = this.#index;
    try {
      this.#writeIndex(bytes);
      this.#index = next;
      return clone(record);
    } catch (error) {
      return this.#recoverCommit(old, next, record, error);
    }
  }
  readSnapshot(projectRoot: string, changeId: string, side: "before" | "after"): Buffer | null {
    this.#guard();
    const found = this.#index.records.find((r) => r.projectRoot === projectRoot && r.changeId === changeId);
    const record = found ?? fail("change_not_found", "change does not exist in this project");
    const reference = record[side];
    return reference === null ? null : this.#readBlob(reference);
  }
  pending(
    projectRoot: string,
    query: {
      afterSequence?: number;
      upperSequence?: number;
      limit: number;
    },
  ) {
    this.#guard();
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > CHANGE_STORE_LIMITS.query)
      fail("change_cursor_invalid", "invalid pending limit");
    const current = Math.max(
        0,
        ...this.#index.records.filter((r) => r.projectRoot === projectRoot).map((r) => r.sequence),
      ),
      upper = query.upperSequence ?? current,
      after = query.afterSequence ?? 0;
    if (
      !Number.isSafeInteger(upper) ||
      upper < 0 ||
      upper > current ||
      !Number.isSafeInteger(after) ||
      after < 0 ||
      after > upper
    )
      fail("change_cursor_invalid", "invalid change cursor");
    const all = this.#index.records
        .filter(
          (r) =>
            r.projectRoot === projectRoot && r.disposition === "pending" && r.sequence > after && r.sequence <= upper,
        )
        .sort((a, b) => a.sequence - b.sequence),
      records = all.slice(0, query.limit).map(clone);
    return {
      records,
      upperSequence: upper,
      nextAfterSequence: all.length > records.length ? records.at(-1)!.sequence : null,
    };
  }
  #guard() {
    this.#assertOwner();
    if (this.#unavailable) fail("change_store_unavailable", "change store authority is unavailable");
    this.#assertBound();
    try {
      if (this.#readAuthorityDigest() !== this.#authorityDigest)
        fail("change_store_unavailable", "change store authority changed");
    } catch {
      this.#unavailable = true;
      fail("change_store_unavailable", "change store authority cannot be verified");
    }
  }
  #assertBound() {
    try {
      const current = lstatSync(this.#root);
      if (!current.isDirectory() || current.dev !== this.#rootDevice || current.ino !== this.#rootInode)
        fail("change_store_unavailable", "change store directory binding changed");
    } catch (error) {
      this.#unavailable = true;
      if (error instanceof ChangeStoreError) throw error;
      fail("change_store_unavailable", "change store directory binding changed");
    }
  }
  #open(stateDir: string, serviceName: string): ChangeIndex {
    return withChangeStoreIo(stateDir, (io) => {
      const inventory = io.inventory(ioLimits());
      if (!io.existsIndex()) {
        if (inventory.entries !== 0)
          fail("change_store_invalid", "change store index is missing from a nonempty store");
        const fresh = freshIndex(serviceName);
        io.replaceIndex(Buffer.from(JSON.stringify(fresh)), this.#ioHook());
        io.ensureSnapshots();
        return fresh;
      }
      const index = parseChangeIndex(io.readIndex(CHANGE_STORE_LIMITS.indexBytes));
      if (index.serviceName !== serviceName) fail("change_store_invalid", "change store service name does not match");
      if (index.records.length === 0) io.ensureSnapshots();
      for (const record of index.records) {
        if (record.before) readIoSnapshot(io, record.before);
        readIoSnapshot(io, record.after);
      }
      io.inventory(ioLimits(), { reconcileBlobPublications: true });
      this.#hook?.("before_open_sync");
      io.syncOpenBindings();
      return index;
    });
  }
  #load(serviceName: string): { index: ChangeIndex; authorityDigest: string } {
    const loaded = withChangeStoreIo(this.#stateDir, (io) => {
      const bytes = io.readIndex(CHANGE_STORE_LIMITS.indexBytes);
      return { index: parseChangeIndex(bytes), authorityDigest: digest(bytes) };
    });
    const { index } = loaded;
    if (index.serviceName !== serviceName) fail("change_store_invalid", "change store service name does not match");
    return loaded;
  }
  #readBlob(reference: SnapshotReference): Buffer {
    return withChangeStoreIo(this.#stateDir, (io) => readIoSnapshot(io, reference));
  }
  #validateRecordBlobs(record: ChangeRecord) {
    if (record.before) this.#readBlob(record.before);
    this.#readBlob(record.after);
  }
  #putBlob(bytes: Uint8Array) {
    withChangeStoreIo(this.#stateDir, (io) => {
      io.ensureSnapshots();
      this.#hook?.("before_blob_write");
      io.writeBlob(digest(bytes), bytes, this.#ioHook());
    });
  }
  #writeIndex(bytes: Uint8Array) {
    withChangeStoreIo(this.#stateDir, (io) => {
      if (
        this.#authorityDigest !== undefined &&
        digest(io.readIndex(CHANGE_STORE_LIMITS.indexBytes)) !== this.#authorityDigest
      ) {
        this.#unavailable = true;
        fail("change_store_unavailable", "change store authority changed before publication");
      }
      io.replaceIndex(bytes, this.#ioHook());
    });
    this.#authorityDigest = digest(bytes);
  }
  #readAuthorityDigest(): string {
    return withChangeStoreIo(this.#stateDir, (io) => digest(io.readIndex(CHANGE_STORE_LIMITS.indexBytes)));
  }
  #confirmVisibleCommit(operationId: string): void {
    if (!this.#uncertain.has(operationId)) return;
    try {
      this.#hook?.("before_uncertain_replay_sync");
      withChangeStoreIo(this.#stateDir, (io) => io.syncOpenBindings());
    } catch {
      fail("change_store_uncertain", "change store commit remains uncertain");
    }
    this.#uncertain.delete(operationId);
  }
  #reserve(input: ChangeInput, indexBytes: number) {
    withChangeStoreIo(this.#stateDir, (io) => {
      io.ensureSnapshots();
      const inventory = io.inventory(ioLimits(), { reconcileBlobPublications: true });
      let physical = inventory.physicalBytes;
      let snapshots = inventory.snapshotBytes;
      const unique = new Map<string, number>();
      if (input.before) unique.set(digest(input.before), input.before.byteLength);
      unique.set(digest(input.after), input.after.byteLength);
      for (const [hex, size] of unique) {
        if (!io.existsSnapshot(hex)) {
          physical += size;
          snapshots += size;
        }
      }
      physical += indexBytes;
      const missing = [...unique].filter(([hex]) => !io.existsSnapshot(hex)).length;
      if (
        inventory.entries + missing + 1 > CHANGE_STORE_LIMITS.directoryEntries ||
        physical > CHANGE_STORE_LIMITS.physicalBytes ||
        snapshots > CHANGE_STORE_LIMITS.snapshotBytes
      )
        fail("change_store_capacity", "change store physical capacity reached");
    });
  }
  #ioHook(): ChangeStoreIoHook {
    return (step) => {
      if (step === "before_index_publish") this.#hook?.("before_index_rename");
      else if (step === "after_index_publish") this.#hook?.("after_index_rename");
      else if (step === "after_index_sync") this.#hook?.("after_index_directory_sync");
      else if (step === "after_blob_link") this.#hook?.("after_blob_link");
      else if (step === "after_blob_publish") this.#hook?.("after_blob_sync");
    };
  }
  #recoverCommit(old: ChangeIndex, next: ChangeIndex, record: ChangeRecord, cause: unknown): never {
    let disk: ChangeIndex;
    let authorityDigest: string;
    try {
      const loaded = this.#load(next.serviceName);
      disk = loaded.index;
      authorityDigest = loaded.authorityDigest;
      for (const item of disk.records) this.#validateRecordBlobs(item);
    } catch (error) {
      this.#unavailable = true;
      return fail("change_store_unavailable", `change store authority cannot be recovered: ${message(error)}`);
    }
    if (JSON.stringify(disk) === JSON.stringify(old)) {
      this.#index = old;
      this.#authorityDigest = authorityDigest;
      fail("change_store_io", `change store commit failed: ${message(cause)}`);
    }
    const visible = disk.records.some(
      (r) => r.operationId === record.operationId && r.payloadDigest === record.payloadDigest,
    );
    if (visible && JSON.stringify(disk) === JSON.stringify(next)) {
      this.#index = disk;
      this.#authorityDigest = authorityDigest;
      this.#uncertain.add(record.operationId);
      fail("change_store_uncertain", "change store commit visibility is uncertain");
    }
    this.#unavailable = true;
    return fail("change_store_unavailable", "change store authority changed unexpectedly");
  }
}
function freshIndex(serviceName: string): ChangeIndex {
  return {
    version: 1,
    serviceName,
    storeId: `store_${randomBytes(16).toString("hex")}`,
    generation: `gen_${randomBytes(16).toString("hex")}`,
    records: [],
  };
}
function validateInput(input: ChangeInput): ChangeInput {
  requirePlain(input, "change_invalid_input", "change input must be an object");
  exactKeys(
    input as unknown as Record<string, unknown>,
    ["operationId", "projectRoot", "format", "origin", "target", "eventKind", "before", "after"],
    ["intent"],
    "change_invalid_input",
  );
  if (typeof input.operationId !== "string" || !/^[0-9a-f]{32}$/u.test(input.operationId))
    fail("change_invalid_input", "invalid operation ID");
  if (
    typeof input.projectRoot !== "string" ||
    !isAbsolute(input.projectRoot) ||
    resolve(input.projectRoot) !== input.projectRoot ||
    Buffer.byteLength(input.projectRoot) > CHANGE_STORE_LIMITS.projectRootBytes ||
    /[\0-\x1f\x7f]/u.test(input.projectRoot)
  )
    fail("change_invalid_input", "invalid canonical project root");
  if (input.format !== "mermaid" || input.origin !== "browser_editor")
    fail("change_invalid_input", "unsupported format or origin");
  const target = parseTarget(input.target);
  if (!(input.before === null || input.before instanceof Uint8Array) || !(input.after instanceof Uint8Array))
    fail("change_invalid_input", "snapshots must be bytes");
  for (const bytes of [input.before, input.after])
    if (bytes && bytes.byteLength > CHANGE_STORE_LIMITS.sourceBytes)
      fail("change_store_limit", "snapshot exceeds sourceBytes");
  for (const bytes of [input.before, input.after])
    if (bytes)
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        fail("change_invalid_input", "snapshot is not UTF-8");
      }
  if (own(input, "intent") && typeof input.intent !== "string") fail("change_invalid_input", "intent must be a string");
  if (typeof input.intent === "string" && Buffer.byteLength(input.intent) > CHANGE_STORE_LIMITS.intentBytes)
    fail("change_store_limit", "intent exceeds intentBytes");
  const before = input.before !== null;
  if (
    (input.eventKind === "draft.saved") !== (target.kind === "draft") ||
    (input.eventKind === "proposal.saved" && (target.kind !== "document" || !before)) ||
    (input.eventKind === "document.created" && (target.kind !== "document" || before)) ||
    (input.eventKind === "document.updated" && (target.kind !== "document" || !before)) ||
    !["draft.saved", "proposal.saved", "document.created", "document.updated"].includes(input.eventKind)
  )
    fail("change_invalid_input", "event and target do not match");
  return {
    ...input,
    target,
    before: input.before === null ? null : Buffer.from(input.before),
    after: Buffer.from(input.after),
  };
}
function ref(bytes: Uint8Array): SnapshotReference {
  return { revision: `sha256:${digest(bytes)}`, bytes: bytes.byteLength };
}
function canonicalDigest(input: ChangeInput): string {
  const before = input.before === null ? null : ref(input.before),
    after = ref(input.after),
    target =
      input.target.kind === "draft"
        ? ["draft", input.target.id, own(input.target, "proposedPath"), input.target.proposedPath ?? null]
        : ["document", input.target.path, own(input.target, "blockId"), input.target.blockId ?? null];
  return `sha256:${digest(Buffer.from(JSON.stringify([input.operationId, input.projectRoot, input.format, input.origin, input.eventKind, target, own(input, "intent"), input.intent ?? null, before, after])))}`;
}
function recordPayloadDigest(record: ChangeRecord): string {
  const target =
    record.target.kind === "draft"
      ? ["draft", record.target.id, own(record.target, "proposedPath"), record.target.proposedPath ?? null]
      : ["document", record.target.path, own(record.target, "blockId"), record.target.blockId ?? null];
  return `sha256:${digest(Buffer.from(JSON.stringify([record.operationId, record.projectRoot, record.format, record.origin, record.eventKind, target, own(record, "intent"), record.intent ?? null, record.before, record.after])))}`;
}
function validateStoredRecord(record: ChangeRecord): void {
  const invalidRoot =
    !isAbsolute(record.projectRoot) ||
    resolve(record.projectRoot) !== record.projectRoot ||
    Buffer.byteLength(record.projectRoot) > CHANGE_STORE_LIMITS.projectRootBytes ||
    /[\0-\x1f\x7f]/u.test(record.projectRoot);
  if (invalidRoot) fail("change_store_invalid", "stored project root is invalid");
  if (record.intent !== undefined && Buffer.byteLength(record.intent) > CHANGE_STORE_LIMITS.intentBytes)
    fail("change_store_invalid", "stored intent exceeds its limit");
  const present = record.before !== null;
  const invalidEvent =
    (record.eventKind === "draft.saved") !== (record.target.kind === "draft") ||
    (record.eventKind === "proposal.saved" && !present) ||
    (record.eventKind === "document.created" && present) ||
    (record.eventKind === "document.updated" && !present);
  if (invalidEvent || (present && record.before!.revision === record.after.revision))
    fail("change_store_invalid", "stored event matrix is invalid");
}
function validateChangeIndex(index: ChangeIndex): void {
  const operations = new Set<string>();
  const changes = new Set<string>();
  const sequences = new Map<string, number>();
  const pending = new Map<string, number>();
  for (const record of index.records) {
    validateStoredRecord(record);
    if (
      record.storeId !== index.storeId ||
      record.generation !== index.generation ||
      operations.has(record.operationId) ||
      changes.has(record.changeId)
    )
      fail("change_store_invalid", "inconsistent change record identity");
    const changeId = `chg_${digest(Buffer.from(JSON.stringify([index.storeId, index.generation, record.operationId, record.payloadDigest]))).slice(0, 32)}`;
    if (recordPayloadDigest(record) !== record.payloadDigest || changeId !== record.changeId)
      fail("change_store_invalid", "change record digest does not match its fields");
    const expected = (sequences.get(record.projectRoot) ?? 0) + 1;
    if (record.sequence !== expected) fail("change_store_invalid", "project sequence is not contiguous");
    const count = (pending.get(record.projectRoot) ?? 0) + (record.disposition === "pending" ? 1 : 0);
    if (count > CHANGE_STORE_LIMITS.pendingPerProject)
      fail("change_store_limit", "change index exceeds pendingPerProject");
    sequences.set(record.projectRoot, record.sequence);
    operations.add(record.operationId);
    changes.add(record.changeId);
    pending.set(record.projectRoot, count);
  }
}
function ioLimits() {
  return {
    entries: CHANGE_STORE_LIMITS.directoryEntries,
    physicalBytes: CHANGE_STORE_LIMITS.physicalBytes,
    snapshotBytes: CHANGE_STORE_LIMITS.snapshotBytes,
  };
}
function readIoSnapshot(io: ChangeStoreIo, reference: SnapshotReference): Buffer {
  let bytes: Buffer;
  try {
    bytes = io.readSnapshot(reference.revision.slice(7), CHANGE_STORE_LIMITS.sourceBytes);
  } catch (error) {
    if (error instanceof ChangeStoreError && error.code === "change_store_io")
      fail("change_store_invalid", "referenced snapshot is missing or unsafe");
    throw error;
  }
  if (bytes.length !== reference.bytes || digest(bytes) !== reference.revision.slice(7))
    fail("change_store_invalid", "snapshot blob does not match its reference");
  return bytes;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
