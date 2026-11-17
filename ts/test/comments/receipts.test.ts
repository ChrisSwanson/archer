// Operation receipts for the page's comment writes (ADR 0016, O67): a create or reply whose answer was lost is
// sent again with the same operation and takes effect once, before and after a restart (a new CommentsStore
// on the same files: the store keeps nothing in memory); other content or another sign-in under the same id
// is refused and changes nothing; a new operation with identical text takes effect; the bounds hold.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  MAX_RECEIPTS_PER_TARGET,
  RECEIPT_REPLAY_MS,
  type TargetRef,
  type Thread,
} from "../../src/comments/contract.ts";
import { canonicalJson, operationDigest } from "../../src/comments/receipts.ts";
import {
  CommentsError,
  CommentsStore,
  PROJECT_COMMENTS_PATH,
  elementsOf,
  type Place,
} from "../../src/comments/store.ts";
import { findProject } from "../../src/project/index.ts";
import type { GraphModel } from "../../src/model/index.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

const GRAPH: GraphModel = {
  type: "freeform-graph",
  nodes: [
    { id: "a", label: "Client" },
    { id: "b", label: "API" },
  ],
  edges: [],
  groups: [],
};
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const OWNER = "service";

function setup() {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const project = findProject(root);
  let clock = T0;
  const time = { now: T0 };
  const open = () => new CommentsStore(project, { now: () => new Date(clock++).toISOString(), clock: () => time.now });
  const view: Place = {
    target: "view:flow",
    path: "flow.comments.json",
    subject: { kind: "view", elements: elementsOf(GRAPH) },
  };
  const file = join(project.folder, view.path);
  const bytes = () => readFileSync(file);
  const onDisk = () =>
    JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      threads: Thread[];
      receipts?: { floor: number; watermark: number; entries: unknown[] };
    };
  return { project, open, view, file, bytes, onDisk, time };
}

let seq = 0;
const op = (name: "comment.create" | "comment.reply", issuedAt = T0, target: TargetRef = "view:flow") => ({
  id: (++seq).toString(16).padStart(32, "0"),
  issuedAt,
  name,
  target,
});
const input = { anchor: { kind: "node", id: "a", label: "x" }, body: "Why is this here?" };

function refused(run: () => unknown, code: string): CommentsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CommentsError);
    expect((error as CommentsError).code, (error as Error).message).toBe(code);
    return error as CommentsError;
  }
  throw new Error(`expected a ${code} refusal`);
}

describe("a create whose answer was lost", () => {
  test("sent again, before and after a restart, makes one thread and answers the original acknowledgement", () => {
    const { open, view, onDisk } = setup();
    const create = op("comment.create");
    const first = open().createOnce(view, create, input, OWNER).value; // the answer is lost
    expect(first.replayed).toBe(false);
    const again = open().createOnce(view, create, input, OWNER).value; // a fresh store: a restarted service
    expect(again).toEqual({ ...first, replayed: true });
    expect(onDisk().threads).toHaveLength(1);
    expect(onDisk().threads[0]!.id).toBe(first.committed.threadId);
    expect(onDisk().version).toBe(5);
    expect(onDisk().receipts!.entries).toHaveLength(1);
  });

  test("a new operation with identical content takes effect: two threads", () => {
    const { open, view, onDisk } = setup();
    open().createOnce(view, op("comment.create"), input, OWNER);
    open().createOnce(view, op("comment.create"), input, OWNER);
    expect(onDisk().threads).toHaveLength(2);
  });

  test("the same id with other content, or from another sign-in, is refused and the file is byte-identical", () => {
    const { open, view, bytes } = setup();
    const create = op("comment.create");
    open().createOnce(view, create, input, OWNER);
    const before = bytes();
    refused(
      () => open().createOnce(view, create, { ...input, body: "Something else" }, OWNER),
      "operation_payload_mismatch",
    );
    refused(
      () => open().createOnce(view, create, { ...input, anchor: { kind: "node", id: "b", label: "x" } }, OWNER),
      "operation_payload_mismatch",
    );
    refused(() => open().createOnce(view, { ...create, issuedAt: T0 + 1 }, input, OWNER), "operation_payload_mismatch");
    // Another grant's repeat learns nothing: no thread, no ids, no acknowledgement.
    const other = refused(() => open().createOnce(view, create, input, "grant:g-other"), "operation_payload_mismatch");
    expect(other.details).toBeUndefined();
    expect(other.message).not.toContain("t-");
    expect(bytes().equals(before)).toBe(true);
  });

  test("equivalent key order is the same request; the digest is canonical", () => {
    const { open, view, onDisk } = setup();
    const create = op("comment.create");
    open().createOnce(view, create, input, OWNER);
    const reordered = { body: input.body, anchor: { label: "x", id: "a", kind: "node" } };
    expect(
      open().createOnce(
        view,
        { target: create.target, name: create.name, issuedAt: create.issuedAt, id: create.id },
        reordered,
        OWNER,
      ).value.replayed,
    ).toBe(true);
    expect(onDisk().threads).toHaveLength(1);
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: " x " } })).toBe(
      '{"a":{"c":" x ","d":[1,{"e":3,"f":2}]},"b":1}',
    );
    expect(operationDigest(create, OWNER, { a: 1, b: "x " })).toBe(operationDigest(create, OWNER, { b: "x ", a: 1 }));
    expect(operationDigest(create, OWNER, { b: "x " })).not.toBe(operationDigest(create, OWNER, { b: "x" }));
  });

  test("a thread resolved since: the repeat acknowledges the earlier commit and recreates nothing", () => {
    const { open, view, onDisk } = setup();
    const create = op("comment.create");
    const first = open().createOnce(view, create, input, OWNER).value;
    open().resolve(first.committed.threadId, "person");
    // A receipt-only file: no threads, kept for its receipts; readers see no threads and no drafts.
    expect(onDisk().threads).toEqual([]);
    expect(open().list(view).threads).toEqual([]);
    expect(open().pending().files).toEqual([]);
    expect(open().createOnce(view, create, input, OWNER).value).toEqual({ ...first, replayed: true });
    expect(onDisk().threads).toEqual([]);
  });

  test("every other write keeps the receipts", () => {
    const { open, view, onDisk } = setup();
    const create = op("comment.create");
    const first = open().createOnce(view, create, input, OWNER).value;
    open().submit("view:flow");
    open().fetchForAgent(undefined, { asListener: true });
    open().reply(first.committed.threadId, "Because.", "agent", 1);
    open().edit(first.committed.threadId, first.committed.commentId, "Why, really?");
    expect(onDisk().receipts!.entries).toHaveLength(1);
    expect(open().createOnce(view, create, input, OWNER).value.replayed).toBe(true);
    expect(onDisk().threads).toHaveLength(1);
  });

  test("a version-4 file without receipts is still written as before by a legacy create", () => {
    const { open, view, onDisk } = setup();
    open().create(view, input);
    expect(onDisk().version).toBe(2);
    expect(onDisk().receipts).toBeUndefined();
  });
});

describe("a reply whose answer was lost", () => {
  test("sent again makes one reply, also after a restart and after the thread is resolved", () => {
    const { open, view, onDisk } = setup();
    const thread = open().create(view, input).value;
    const reply = op("comment.reply");
    const first = open().replyOnce(view, thread.id, reply, "And this?", undefined, OWNER).value;
    expect(open().replyOnce(view, thread.id, reply, "And this?", undefined, OWNER).value).toEqual({
      ...first,
      replayed: true,
    });
    expect(onDisk().threads[0]!.comments).toHaveLength(2);
    refused(
      () => open().replyOnce(view, thread.id, reply, "Other text", undefined, OWNER),
      "operation_payload_mismatch",
    );
    open().resolve(thread.id, "person");
    expect(open().replyOnce(view, thread.id, reply, "And this?", undefined, OWNER).value.replayed).toBe(true);
    expect(onDisk().threads).toEqual([]);
    // A new reply on the gone thread is refused, not a new thread.
    refused(
      () => open().replyOnce(view, thread.id, op("comment.reply"), "And this?", undefined, OWNER),
      "thread_not_found",
    );
  });
});

describe("bounds and time", () => {
  test("an identity older than 30 days is expired, kept or pruned, and a clock rollback does not revive it", () => {
    const { open, view, onDisk, time } = setup();
    const create = op("comment.create");
    open().createOnce(view, create, input, OWNER);
    time.now = T0 + RECEIPT_REPLAY_MS + 1;
    refused(() => open().createOnce(view, create, input, OWNER), "operation_expired");
    // A later operation prunes the old receipt and persists the floor and watermark.
    open().createOnce(view, op("comment.create", time.now), input, OWNER);
    expect(onDisk().receipts!.entries).toHaveLength(1);
    expect(onDisk().receipts!.floor).toBe(T0 + 1);
    time.now = T0; // the clock goes back
    refused(() => open().createOnce(view, create, input, OWNER), "operation_expired");
    expect(onDisk().threads).toHaveLength(2);
  });

  test("an identity dated more than five minutes ahead is refused", () => {
    const { open, view } = setup();
    refused(
      () => open().createOnce(view, op("comment.create", T0 + 5 * 60_000 + 1), input, OWNER),
      "invalid_operation",
    );
    expect(open().createOnce(view, op("comment.create", T0 + 5 * 60_000), input, OWNER).value.replayed).toBe(false);
  });

  test("a full ledger refuses a new operation before any effect and evicts nothing", () => {
    const { open, view, file, bytes } = setup();
    const entries = Array.from({ length: MAX_RECEIPTS_PER_TARGET }, (_, i) => ({
      id: (0xf0000 + i).toString(16).padStart(32, "0"),
      issuedAt: T0 - 1000,
      operation: "comment.create",
      digest: "0".repeat(64),
      threadId: `t-${i}`,
      commentId: "c-1",
      revision: 1,
      committedAt: new Date(T0).toISOString(),
    }));
    writeFileSync(
      file,
      `${JSON.stringify({ version: 5, target: "view:flow", threads: [], receipts: { floor: 0, watermark: T0, entries } }, null, 2)}\n`,
    );
    const before = bytes();
    refused(() => open().createOnce(view, op("comment.create"), input, OWNER), "operation_capacity_exceeded");
    expect(bytes().equals(before)).toBe(true);
  });

  test("a malformed ledger is a malformed file, reported and never rewritten", () => {
    const { open, view, file, bytes } = setup();
    writeFileSync(
      file,
      JSON.stringify({
        version: 5,
        target: "view:flow",
        threads: [],
        receipts: { floor: 0, watermark: 0, entries: [{ id: "nope" }] },
      }),
    );
    const before = bytes();
    refused(() => open().createOnce(view, op("comment.create"), input, OWNER), "malformed_comments_file");
    refused(() => open().list(view), "malformed_comments_file");
    writeFileSync(
      file,
      JSON.stringify({
        version: 4,
        target: "view:flow",
        threads: [],
        receipts: { floor: 0, watermark: 0, entries: [] },
      }),
    );
    refused(() => open().list(view), "malformed_comments_file");
    writeFileSync(file, before);
    expect(bytes().equals(before)).toBe(true);
  });

  test("a malformed envelope is refused as invalid_operation", () => {
    const { open, view } = setup();
    for (const bad of [
      null,
      { ...op("comment.create"), id: "short" },
      { ...op("comment.create"), extra: 1 },
      op("comment.reply"),
      op("comment.create", T0, "view:other"),
    ])
      refused(() => open().createOnce(view, bad, input, OWNER), "invalid_operation");
  });
});

describe("a submit whose answer was lost (O83)", () => {
  const submitOp = (issuedAt = T0) => ({
    id: (++seq).toString(16).padStart(32, "0"),
    issuedAt,
    name: "comment.submit" as const,
  });
  function twoTargets() {
    const s = setup();
    const note: Place = { target: "project:", path: PROJECT_COMMENTS_PATH, subject: { kind: "project" } };
    return {
      ...s,
      note,
      other: () =>
        JSON.parse(readFileSync(join(s.project.folder, note.path), "utf8")) as {
          threads: Thread[];
          receipts?: { entries: Record<string, unknown>[] };
        },
    };
  }

  test("every draft, sent again after a restart: answered from the receipts, nothing sent twice", () => {
    const { open, view, note, onDisk, other, bytes } = twoTargets();
    open().create(view, input);
    open().create(note, { anchor: { kind: "project" }, body: "And here?" });
    const send = submitOp();
    const first = open().submitOnce(undefined, undefined, send, OWNER);
    expect(first).toMatchObject({ replayed: false, submitted: 2 });
    expect(first.changed).toHaveLength(2);
    // Each file it changed holds the submit's receipt, with that file's count, written with the effect.
    expect(onDisk().version).toBe(5);
    expect(onDisk().receipts!.entries).toEqual([
      expect.objectContaining({ id: send.id, operation: "comment.submit", submitted: 1 }),
    ]);
    expect(other().receipts!.entries).toEqual([
      expect.objectContaining({ id: send.id, operation: "comment.submit", submitted: 1 }),
    ]);
    const before = bytes();
    const again = open().submitOnce(undefined, undefined, send, OWNER);
    expect(again).toMatchObject({ replayed: true, submitted: 2 });
    expect(again.changed).toEqual([]);
    expect(bytes().equals(before)).toBe(true);
    expect([...onDisk().threads, ...other().threads].map((t) => t.status)).toEqual(["sent", "sent"]);
  });

  test("a partial first commit completes on the resend: files with the receipt replay, files without it are sent", () => {
    const { open, view, note, other } = twoTargets();
    open().create(view, input);
    const send = submitOp();
    // The first try reached only the view's file (here: only it had a draft yet).
    expect(open().submitOnce(undefined, undefined, send, OWNER)).toMatchObject({ replayed: false, submitted: 1 });
    open().create(note, { anchor: { kind: "project" }, body: "Written between the tries" });
    const again = open().submitOnce(undefined, undefined, send, OWNER);
    expect(again).toMatchObject({ replayed: true, submitted: 2 });
    expect(again.changed.map((c) => c.target)).toEqual(["project:"]);
    expect(other().threads.map((t) => t.status)).toEqual(["sent"]);
  });

  test("one thread, sent again: one send, answered from the receipt, also once the thread is resolved", () => {
    const { open, view, onDisk } = setup();
    const thread = open().create(view, input).value;
    open().create(view, { ...input, body: "Another draft" });
    const send = submitOp();
    expect(open().submitOnce("view:flow", thread.id, send, OWNER)).toMatchObject({ replayed: false, submitted: 1 });
    expect(open().submitOnce("view:flow", thread.id, send, OWNER)).toMatchObject({ replayed: true, submitted: 1 });
    expect(onDisk().threads.map((t) => t.status)).toEqual(["sent", "draft"]);
    open().resolve(thread.id, "person");
    expect(open().submitOnce("view:flow", thread.id, send, OWNER)).toMatchObject({ replayed: true, submitted: 1 });
    expect(onDisk().threads.map((t) => t.status)).toEqual(["draft"]);
    refused(() => open().submitOnce("view:flow", thread.id, submitOp(), OWNER), "thread_not_found");
  });

  test("nothing waiting: submitted 0, and no receipt is written", () => {
    const { open, view, onDisk } = setup();
    open().create(view, input);
    open().submit();
    expect(open().submitOnce(undefined, undefined, submitOp(), OWNER)).toMatchObject({ replayed: false, submitted: 0 });
    expect(onDisk().version).toBe(2);
    expect(onDisk().receipts).toBeUndefined();
  });

  test("the same id for another scope, or from another sign-in, is refused before anything is sent", () => {
    const { open, view, note, bytes, other } = twoTargets();
    const thread = open().create(view, input).value;
    const send = submitOp();
    open().submitOnce("view:flow", thread.id, send, OWNER);
    open().create(view, { ...input, body: "Another draft" });
    open().create(note, { anchor: { kind: "project" }, body: "And here?" });
    const before = bytes();
    refused(() => open().submitOnce(undefined, undefined, send, OWNER), "operation_payload_mismatch");
    refused(() => open().submitOnce("view:flow", thread.id, send, "grant:g-other"), "operation_payload_mismatch");
    expect(bytes().equals(before)).toBe(true);
    expect(other().threads.map((t) => t.status)).toEqual(["draft"]);
  });

  test("a malformed submit envelope is invalid_operation", () => {
    const { open } = setup();
    for (const bad of [
      null,
      { ...submitOp(), target: "view:flow" },
      { ...submitOp(), name: "comment.create" },
      { ...submitOp(), id: "short" },
    ])
      refused(() => open().submitOnce(undefined, undefined, bad, OWNER), "invalid_operation");
  });

  test("the ledger is strict per operation: a submit receipt has a count and no thread, a create receipt no count", () => {
    const { open, view, file } = setup();
    const base = { id: "a".repeat(32), issuedAt: T0, digest: "0".repeat(64), committedAt: new Date(T0).toISOString() };
    const good = { ...base, operation: "comment.submit", submitted: 2 };
    for (const entry of [
      { ...good, threadId: "t-1" },
      { ...good, submitted: -1 },
      { ...good, submitted: 1.5 },
      { ...base, operation: "comment.create", threadId: "t-1", commentId: "c-1", revision: 1, submitted: 1 },
      { ...base, operation: "comment.other", submitted: 1 },
    ]) {
      writeFileSync(
        file,
        JSON.stringify({
          version: 5,
          target: "view:flow",
          threads: [],
          receipts: { floor: 0, watermark: T0, entries: [entry] },
        }),
      );
      refused(() => open().list(view), "malformed_comments_file");
    }
    writeFileSync(
      file,
      JSON.stringify({
        version: 5,
        target: "view:flow",
        threads: [],
        receipts: { floor: 0, watermark: T0, entries: [good] },
      }),
    );
    expect(open().list(view).threads).toEqual([]);
  });
});
