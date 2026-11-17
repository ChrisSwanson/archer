// Durable operation receipts for the page's comment writes (ADR 0016, O67).
//
// A comment POST whose answer is lost after the service committed it must not become a second comment when
// the person (or the page) sends it again. The page names each write with an operation identity it keeps
// across retries; the service records a receipt for that identity in the SAME comments file, in the same
// atomic replacement, as the effect itself, and answers a repeat with the original acknowledgement instead
// of a new effect. There is no separate journal and no in-memory cache: a restarted service reads the file.
//
// - Identity: a 128-bit client nonce (32 lowercase hex), a millisecond `issuedAt`, the operation name and
//   the target. The digest is SHA-256 over a canonical (sorted-key) encoding of the validated payload, the
//   identity and the caller's authorization realm (the owner's sign-in, or one access grant), so a repeat
//   with other content, or from another grant, is refused as `operation_payload_mismatch` and learns
//   nothing of the original. No credential is stored: the realm is a grant id, and only inside the digest.
// - Bounds, per target file: a receipt is replayable for RECEIPT_REPLAY_MS (30 days) after its issuedAt;
//   at most MAX_RECEIPTS_PER_TARGET (4,096) live receipts; the file's existing 8 MiB cap. A full ledger
//   refuses a new operation (`operation_capacity_exceeded`) before any effect; it never evicts a live one.
// - Time: effective time is the larger of the wall clock and the file's persisted watermark, so a clock
//   rollback moves neither the watermark nor the expiry floor backwards. An identity at or below the floor
//   is `operation_expired` whether its receipt was kept or pruned; one more than MAX_OPERATION_SKEW_MS ahead
//   of effective time is refused as invalid.
import {
  MAX_OPERATION_SKEW_MS,
  MAX_RECEIPTS_PER_TARGET,
  RECEIPT_REPLAY_MS,
  type CommentOperation,
  type CommentOperationName,
  type CommentReceipt,
  type ReceiptLedger,
  type SubmitOperation,
} from "../ts/src/comments/contract.ts";

const OPERATION_ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAMES: readonly CommentOperationName[] = ["comment.create", "comment.reply"];
const THREAD_FIELDS = ["id", "issuedAt", "operation", "digest", "threadId", "commentId", "revision", "committedAt"];
const SUBMIT_FIELDS = ["id", "issuedAt", "operation", "digest", "submitted", "committedAt"];
/** Below this an `issuedAt` is not a plausible millisecond time (2020-01-01). */
const EARLIEST_MS = Date.UTC(2020, 0, 1);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Why an envelope or a ledger is not what the contract says. */
export class ReceiptShapeError extends Error {}

/** The operation part of an envelope, checked for shape: the payload is its operation's to check. */
export function readOperation(
  raw: unknown,
  name: CommentOperationName,
  readTarget: (raw: unknown) => string | null,
): CommentOperation {
  if (!isObject(raw))
    throw new ReceiptShapeError("the operation must be an object with an id, issuedAt, name and target");
  for (const key of Object.keys(raw))
    if (!["id", "issuedAt", "name", "target"].includes(key))
      throw new ReceiptShapeError(`the operation has a field "${key.slice(0, 32)}" it does not take`);
  const id = raw["id"];
  if (typeof id !== "string" || !OPERATION_ID.test(id))
    throw new ReceiptShapeError("the operation id must be 32 lowercase hex characters (128 random bits)");
  const issuedAt = raw["issuedAt"];
  if (!isTime(issuedAt) || issuedAt < EARLIEST_MS)
    throw new ReceiptShapeError("the operation's issuedAt must be a time in milliseconds");
  if (raw["name"] !== name) throw new ReceiptShapeError(`this route takes the operation "${name}"`);
  const target = readTarget(raw["target"]);
  if (target === null)
    throw new ReceiptShapeError('the operation target must be "view:<view id>", "note:<path>" or "project:"');
  return { id, issuedAt, name, target: target as CommentOperation["target"] };
}

/** A submit's operation (O83): an id, issuedAt and the name, and no target (its payload names what it sends). */
export function readSubmitOperation(raw: unknown): SubmitOperation {
  if (!isObject(raw)) throw new ReceiptShapeError("the operation must be an object with an id, issuedAt and name");
  for (const key of Object.keys(raw))
    if (!["id", "issuedAt", "name"].includes(key))
      throw new ReceiptShapeError(`the submit operation has a field "${key.slice(0, 32)}" it does not take`);
  const id = raw["id"];
  if (typeof id !== "string" || !OPERATION_ID.test(id))
    throw new ReceiptShapeError("the operation id must be 32 lowercase hex characters (128 random bits)");
  const issuedAt = raw["issuedAt"];
  if (!isTime(issuedAt) || issuedAt < EARLIEST_MS)
    throw new ReceiptShapeError("the operation's issuedAt must be a time in milliseconds");
  if (raw["name"] !== "comment.submit") throw new ReceiptShapeError('this route takes the operation "comment.submit"');
  return { id, issuedAt, name: "comment.submit" };
}

/** JSON with every object's keys sorted, recursively: equal for equal values whatever order the keys came in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A ledger as a file holds it, checked; anything else is a malformed file (never repaired). */
export function readLedger(raw: unknown): ReceiptLedger {
  if (!isObject(raw)) throw new ReceiptShapeError("its receipts are not an object");
  for (const key of Object.keys(raw))
    if (!["floor", "watermark", "entries"].includes(key))
      throw new ReceiptShapeError(`its receipts have a field "${key.slice(0, 32)}" they do not have`);
  const { floor, watermark, entries } = raw;
  if (!isTime(floor) || !isTime(watermark))
    throw new ReceiptShapeError("its receipts' floor and watermark must be times in milliseconds");
  if (!Array.isArray(entries)) throw new ReceiptShapeError("its receipts' entries are not a list");
  if (entries.length > MAX_RECEIPTS_PER_TARGET)
    throw new ReceiptShapeError(`it holds ${entries.length} receipts, more than ${MAX_RECEIPTS_PER_TARGET}`);
  const seen = new Set<string>();
  const read = entries.map((entry, i): CommentReceipt => {
    const where = `receipts.entries[${i}]`;
    if (!isObject(entry)) throw new ReceiptShapeError(`${where} is not an object`);
    const { id, issuedAt, operation, digest, threadId, commentId, revision, committedAt } = entry;
    const submit = operation === "comment.submit";
    if (!submit && !NAMES.includes(operation as CommentOperationName))
      throw new ReceiptShapeError(`${where}.operation is not comment.create, comment.reply or comment.submit`);
    for (const key of Object.keys(entry))
      if (!(submit ? SUBMIT_FIELDS : THREAD_FIELDS).includes(key))
        throw new ReceiptShapeError(
          `${where} has a field "${key.slice(0, 32)}" ${submit ? "submit" : "create and reply"} receipts do not have`,
        );
    if (typeof id !== "string" || !OPERATION_ID.test(id))
      throw new ReceiptShapeError(`${where}.id is not an operation id`);
    if (seen.has(id)) throw new ReceiptShapeError(`two receipts have the operation id ${id}`);
    seen.add(id);
    if (!isTime(issuedAt)) throw new ReceiptShapeError(`${where}.issuedAt is not a time`);
    if (typeof digest !== "string" || !DIGEST.test(digest))
      throw new ReceiptShapeError(`${where}.digest is not a SHA-256 digest`);
    if (typeof committedAt !== "string" || committedAt === "")
      throw new ReceiptShapeError(`${where}.committedAt must be a time`);
    if (submit) {
      const submitted = entry["submitted"];
      // A receipt is written only by a submit that changed its file, so it sent at least one thread there.
      if (typeof submitted !== "number" || !Number.isSafeInteger(submitted) || submitted < 1)
        throw new ReceiptShapeError(`${where}.submitted must be a whole number from 1`);
      return { id, issuedAt, operation: "comment.submit", digest, submitted, committedAt };
    }
    if (
      typeof threadId !== "string" ||
      !ITEM_ID.test(threadId) ||
      typeof commentId !== "string" ||
      !ITEM_ID.test(commentId)
    )
      throw new ReceiptShapeError(`${where} does not name a thread and a comment`);
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
      throw new ReceiptShapeError(`${where}.revision must be a whole number from 1`);
    return {
      id,
      issuedAt,
      operation: operation as CommentOperationName,
      digest,
      threadId,
      commentId,
      revision,
      committedAt,
    };
  });
  return { floor, watermark, entries: read };
}

/** What a ledger says of an identity now: replay its receipt, or admit it with the ledger it will be written with. */
export type Admission =
  | { readonly kind: "replay"; readonly receipt: CommentReceipt }
  | { readonly kind: "admit"; readonly record: (result: ReceiptResult) => ReceiptLedger };

/** What a receipt records of its operation's result: a create's or reply's ids, or a submit's count in this file. */
export type ReceiptResult =
  | { readonly threadId: string; readonly commentId: string; readonly revision: number; readonly committedAt: string }
  | { readonly submitted: number; readonly committedAt: string };

export type ReceiptRefusal =
  | "operation_expired"
  | "operation_payload_mismatch"
  | "operation_capacity_exceeded"
  | "invalid_operation";

/**
 * Checks an identity against a target's ledger at wall time `wallMs`. Throws `refuse(code, message)` for an
 * expired, mismatched, too-early or capacity-refused one, before anything changes.
 */
export function admit(
  ledger: ReceiptLedger | undefined,
  operation: CommentOperation | SubmitOperation,
  digest: string,
  wallMs: number,
  refuse: (code: ReceiptRefusal, message: string, details?: Readonly<Record<string, unknown>>) => never,
  limits: { readonly maxReceipts?: number } = {},
): Admission {
  const maxReceipts = limits.maxReceipts ?? MAX_RECEIPTS_PER_TARGET;
  const effective = Math.max(wallMs, ledger?.watermark ?? 0);
  const floor = Math.max(ledger?.floor ?? 0, effective - RECEIPT_REPLAY_MS);
  const window = { expiresBefore: floor, replayWindowMs: RECEIPT_REPLAY_MS };
  if (operation.issuedAt <= floor)
    refuse(
      "operation_expired",
      `operation ${operation.id} was issued more than ${RECEIPT_REPLAY_MS / 86_400_000} days ago, so it can no longer be sent or confirmed; read the discussion to see whether it was added`,
      window,
    );
  const held = ledger?.entries.find((r) => r.id === operation.id);
  if (held !== undefined) {
    if (held.digest !== digest || held.issuedAt !== operation.issuedAt || held.operation !== operation.name)
      refuse(
        "operation_payload_mismatch",
        `operation ${operation.id} was already used for another request; nothing was done`,
      );
    return { kind: "replay", receipt: held };
  }
  if (operation.issuedAt > effective + MAX_OPERATION_SKEW_MS)
    refuse(
      "invalid_operation",
      `operation ${operation.id} is dated more than ${MAX_OPERATION_SKEW_MS / 60_000} minutes ahead of Archer's clock; check this computer's clock`,
    );
  const live = (ledger?.entries ?? []).filter((r) => r.issuedAt > floor);
  if (live.length >= maxReceipts)
    refuse(
      "operation_capacity_exceeded",
      `this diagram or note already holds ${live.length} recent comment receipts, the most it keeps; try again later`,
      window,
    );
  return {
    kind: "admit",
    record: (result) => ({
      floor,
      watermark: effective,
      entries: [
        ...live,
        {
          id: operation.id,
          issuedAt: operation.issuedAt,
          operation: operation.name,
          digest,
          ...result,
        } as CommentReceipt,
      ],
    }),
  };
}
