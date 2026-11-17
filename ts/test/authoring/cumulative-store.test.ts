import { chmodSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import {
  AUTHORING_STORE_LIMITS,
  AuthoringStore,
  JOURNAL_FULL,
  parseAuthoringIndex,
  type JournalIntent,
  type JournalCompletion,
} from "../../src/authoring/store.ts";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const revision = "sha256:" + "c".repeat(64),
  root = "/projects/one";
function setup() {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "archer-cumulative-")));
  chmodSync(stateDir, 0o700);
  roots.push(stateDir);
  const options = { stateDir, serviceName: "main", epoch: "a".repeat(32), assertOwner() {} };
  return { stateDir, options, store: new AuthoringStore(options) };
}
function request(
  s: AuthoringStore,
  n: number,
  before: string | null = "A",
  after = "B",
  blockId?: string,
  manual = false,
): JournalIntent {
  return {
    operationId: n.toString(16).padStart(32, "0"),
    payloadDigest: revision,
    op: before === null ? "document.publish" : "document.apply",
    projectRoot: root,
    authority: { grantId: "g", entitlementId: "e" },
    feedback: { changes: manual ? "manual" : "on_save", delivery: "next_call", effectiveRevision: revision },
    target: { kind: "document", path: blockId ? ".archer/n.md" : ".archer/a.mmd", ...(blockId ? { blockId } : {}) },
    expected: { sourceRevision: before === null ? null : revision },
    base: before === null ? null : s.putSnapshot(Buffer.from(before)),
    candidate: s.putSnapshot(Buffer.from(after)),
  };
}
function completion(r: JournalIntent): JournalCompletion {
  return {
    outcome: r.base === null ? "created" : "applied",
    document: {
      path: r.target.kind === "document" ? r.target.path : "",
      ...(r.target.kind === "document" && r.target.blockId ? { blockId: r.target.blockId } : {}),
      sourceRevision: revision,
      modelRevision: null,
    },
    evidence: "observed",
    review: { mode: r.feedback.changes, configRevision: revision, state: "admission_pending" },
  };
}
function save(s: AuthoringStore, r: JournalIntent) {
  s.beginOperation(r);
  return s.completeSourceOperation(r.operationId, r.payloadDigest, completion(r));
}
test("source terminal and cumulative review publish atomically with immutable oldest baseline", () => {
  const f = setup(),
    s = f.store,
    r1 = request(s, 1);
  save(s, r1);
  save(s, request(s, 2, "B", "C"));
  const reviews = s.listReviews(root);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({
    state: "pending",
    reviewRevision: 2,
    saveCount: 2,
    baseline: r1.base,
    latest: { revision: s.putSnapshot(Buffer.from("C")).revision },
    externalGaps: 0,
  });
  const index = parseAuthoringIndex(readFileSync(join(f.stateDir, "runtime/authoring/index.json")));
  expect(index.version).toBe(2);
  expect(index.operations.every((o) => o.state === "terminal" && o.completion.review.state === "tracked")).toBe(true);
  expect(new AuthoringStore(f.options).listReviews(root)).toEqual(reviews);
});
function only(s: AuthoringStore) {
  const r = s.listReviews(root);
  expect(r).toHaveLength(1);
  return r[0]!;
}
test("clear is revision checked, unfinished subjects block clear/save, clear then Save opens new baseline", () => {
  const { store: s } = setup();
  save(s, request(s, 1));
  const first = only(s);
  save(s, request(s, 2, "B", "C"));
  expect(() => s.clearReview(root, first.reviewId, 1, "understood")).toThrow(/currentReviewRevision=2/u);
  try {
    s.clearReview(root, first.reviewId, 1, "understood");
  } catch (error) {
    expect(error).toMatchObject({ code: "change_review_conflict", currentReviewRevision: 2 });
  }
  const r3 = request(s, 3, "C", "D");
  s.beginOperation(r3);
  s.markOperationUncertain(r3.operationId, r3.payloadDigest);
  expect(() => s.clearReview(root, first.reviewId, 2, "understood")).toThrow(/unfinished/u);
  const r4 = request(s, 4, "D", "E");
  s.beginOperation(r4);
  expect(() => s.assertSourceReviewCapacity(r4.operationId, r4.payloadDigest, completion(r4))).toThrow(/unfinished/u);
  const abandon = (r: JournalIntent): JournalCompletion => ({
    outcome: "resolved",
    evidence: "abandoned",
    current: { observed: "diverged", sourceRevision: revision, contentRevision: revision, inferred: true },
    review: { mode: "on_save", configRevision: revision, state: "not_queued_no_effect" },
  });
  s.markOperationUncertain(r4.operationId, r4.payloadDigest);
  s.resolveSourceOperation(r4.operationId, r4.payloadDigest, abandon(r4));
  s.resolveSourceOperation(r3.operationId, r3.payloadDigest, abandon(r3));
  const cleared = s.clearReview(root, first.reviewId, 2, "understood after questions");
  expect(cleared).toMatchObject({ state: "cleared", reviewRevision: 3, summary: "understood after questions" });
  const last = request(s, 5, "C", "Z");
  save(s, last);
  const reviews = s.listReviews(root);
  expect(reviews).toHaveLength(2);
  expect(reviews[1]).toMatchObject({ state: "pending", baseline: last.base, saveCount: 1, reviewRevision: 1 });
  expect(reviews[1]!.reviewId).not.toBe(first.reviewId);
});
test("exact content hashes detect external gaps, salted source CAS does not; A→B→A stays pending", () => {
  const { store: s } = setup(),
    r1 = request(s, 1);
  save(s, r1);
  save(s, request(s, 2, "B", "C"));
  expect(only(s).externalGaps).toBe(0);
  save(s, request(s, 3, "External", "A"));
  expect(only(s)).toMatchObject({
    baseline: r1.base,
    latest: r1.base,
    state: "pending",
    saveCount: 3,
    externalGaps: 1,
    reviewRevision: 3,
  });
});
test("no effect does not migrate or fold; manual source review is held, visible, and offered once", () => {
  const { store: s, stateDir } = setup(),
    noop = request(s, 1, "A", "A");
  s.beginOperation(noop);
  s.completeSourceOperation(noop.operationId, noop.payloadDigest, {
    ...completion(noop),
    outcome: "unchanged",
    review: { mode: "on_save", configRevision: revision, state: "not_queued_no_effect" },
  });
  expect(s.listReviews(root)).toEqual([]);
  expect(parseAuthoringIndex(readFileSync(join(stateDir, "runtime/authoring/index.json"))).version).toBe(1);
  const r = request(s, 2, "A", "B", undefined, true),
    done = save(s, r);
  expect(done.state === "terminal" && done.completion.review.state).toBe("tracked_held");
  const held = only(s);
  expect(held.delivery).toBe("held");
  const offered = s.offerReview(root, held.reviewId, held.reviewRevision);
  expect(offered).toMatchObject({ delivery: "offered", reviewRevision: 2 });
  expect(s.offerReview(root, offered.reviewId, 2)).toEqual(offered);
  expect(() => s.offerReview(root, offered.reviewId, 1)).toThrow(/currentReviewRevision=2/u);
});
test("two embedded blocks are separate subjects and Publish baseline is absent, distinct from empty", () => {
  const { store: s } = setup();
  save(s, request(s, 1, "A", "B", "one"));
  save(s, request(s, 2, "A", "C", "two"));
  save(s, request(s, 3, null, "New"));
  const reviews = s.listReviews(root);
  expect(reviews).toHaveLength(3);
  expect(reviews.map((r) => r.subject.blockId ?? null)).toEqual(["one", "two", null]);
  expect(reviews[2]!.baseline).toBeNull();
  expect(s.readSnapshot(reviews[2]!.latest).toString()).toBe("New");
});
test("uncertain candidate must be confirmed and folds once with inferred evidence; abandon cannot hide observed candidate", () => {
  const { store: s } = setup(),
    r = request(s, 1);
  s.beginOperation(r);
  s.markOperationUncertain(r.operationId, r.payloadDigest);
  const confirmed: JournalCompletion = {
    outcome: "resolved",
    evidence: "inferred_confirmed",
    current: {
      observed: "matches_candidate",
      sourceRevision: revision,
      contentRevision: r.candidate!.revision,
      inferred: true,
    },
    review: { mode: "on_save", configRevision: revision, state: "not_queued_no_effect" },
  };
  expect(() =>
    s.resolveSourceOperation(r.operationId, r.payloadDigest, { ...confirmed, evidence: "abandoned" }),
  ).toThrow(/cannot be abandoned/u);
  const done = s.resolveSourceOperation(r.operationId, r.payloadDigest, confirmed);
  expect(done.state === "terminal" && done.completion).toMatchObject({
    evidence: "inferred_confirmed",
    review: { state: "tracked", reviewRevision: 1 },
  });
  expect(s.resolveSourceOperation(r.operationId, r.payloadDigest, confirmed)).toEqual(done);
  expect(only(s).saveCount).toBe(1);
});
for (const step of ["before_index_publish", "after_index_publish", "after_index_sync"] as const)
  test(`crash at ${step} leaves source terminal and fold both present or both absent`, () => {
    const f = setup(),
      r = request(f.store, 1);
    f.store.beginOperation(r);
    let armed = true;
    const crashing = new AuthoringStore({
      ...f.options,
      onCommitStep(actual) {
        if (armed && actual === step) {
          armed = false;
          throw new Error("simulated crash");
        }
      },
    });
    expect(() => crashing.completeSourceOperation(r.operationId, r.payloadDigest, completion(r))).toThrow(
      /not acknowledged/u,
    );
    const recovered = new AuthoringStore({ ...f.options, epoch: "b".repeat(32) }),
      op = recovered.getOperation(r.operationId)!;
    expect(recovered.listReviews(root)).toHaveLength(step === "before_index_publish" ? 0 : 1);
    expect(op.state).toBe(step === "before_index_publish" ? "uncertain" : "terminal");
  });
test("capacity reserves bounded terminal/fold and future clear before effect; parser refuses duplicate subjects", () => {
  const f = setup(),
    s = f.store,
    r = request(s, 1);
  s.beginOperation(r);
  s.assertSourceReviewCapacity(r.operationId, r.payloadDigest, completion(r));
  save(s, request(s, 2, "A", "B", "other"));
  expect(() =>
    s.assertSourceReviewCapacity(r.operationId, r.payloadDigest, {
      ...completion(r),
      document: { ...completion(r).document!, path: "wrong.mmd" },
    }),
  ).toThrow(/identity/u);
  s.completeSourceOperation(r.operationId, r.payloadDigest, completion(r));
  const disk = JSON.parse(readFileSync(join(f.stateDir, "runtime/authoring/index.json"), "utf8"));
  disk.reviews.push({ ...disk.reviews[0], reviewId: "rev_" + "f".repeat(32), sequence: 3 });
  expect(() => parseAuthoringIndex(Buffer.from(JSON.stringify(disk)))).toThrow(/duplicate pending/u);
});

test("the 257th pending subject is refused in preflight, while an existing subject still folds", () => {
  const f = setup(),
    s = f.store;
  save(s, request(s, 1));
  const indexPath = join(f.stateDir, "runtime/authoring/index.json"),
    disk = JSON.parse(readFileSync(indexPath, "utf8")),
    original = disk.reviews[0],
    op = disk.operations[0];
  for (let i = 1; i < 256; i++) {
    const id = (i + 1).toString(16).padStart(32, "0"),
      reviewId = "rev_" + id,
      path = `.archer/item${i}.mmd`;
    disk.reviews.push({
      ...original,
      reviewId,
      sequence: i + 1,
      subject: { kind: "document", path },
      firstOperationId: id,
      lastOperationId: id,
    });
    disk.operations.push({
      ...op,
      operationId: id,
      target: { kind: "document", path },
      completion: {
        ...op.completion,
        document: { ...op.completion.document, path },
        review: { ...op.completion.review, reviewId },
      },
    });
  }
  writeFileSync(indexPath, JSON.stringify(disk));
  const full = new AuthoringStore(f.options),
    next = request(full, 257, "A", "B", "newsubject");
  full.beginOperation(next);
  expect(() => full.assertSourceReviewCapacity(next.operationId, next.payloadDigest, completion(next))).toThrow(
    /capacity/u,
  );
  expect(full.getOperation(next.operationId)!.state).toBe("intent");
  expect(full.listReviews(root)).toHaveLength(256);
  save(full, request(full, 258, "B", "C"));
  expect(full.listReviews(root)[0]!.saveCount).toBe(2);
});
test("confirming an uncertain no-effect observation does not invent a cumulative review", () => {
  const { store: s } = setup(),
    r = request(s, 1, "A", "A");
  s.beginOperation(r);
  s.markOperationUncertain(r.operationId, r.payloadDigest);
  const done = s.resolveSourceOperation(r.operationId, r.payloadDigest, {
    outcome: "resolved",
    evidence: "inferred_confirmed",
    current: {
      observed: "matches_candidate",
      sourceRevision: revision,
      contentRevision: r.candidate!.revision,
      inferred: true,
    },
    review: { mode: "on_save", configRevision: revision, state: "not_queued_no_effect" },
  });
  expect(done.state === "terminal" && done.completion.review.state).toBe("not_queued_no_effect");
  expect(s.listReviews(root)).toHaveLength(0);
});
test("source admission reserves the final operation slot for explicit uncertain resolution", () => {
  const f = setup(),
    s = f.store;
  save(s, request(s, 1));
  const indexPath = join(f.stateDir, "runtime/authoring/index.json"),
    disk = JSON.parse(readFileSync(indexPath, "utf8")),
    first = disk.operations[0];
  // Settled history (conflicts and no-ops would leave the replay window instead).
  for (let n = 2; n <= 4094; n++)
    disk.operations.push({
      ...first,
      operationId: n.toString(16).padStart(32, "0"),
      completion: {
        outcome: "resolved",
        evidence: "abandoned",
        current: { observed: "diverged", sourceRevision: revision, contentRevision: revision, inferred: true },
        review: { mode: "on_save", configRevision: revision, state: "not_queued_no_effect" },
      },
    });
  writeFileSync(indexPath, JSON.stringify(disk));
  const full = new AuthoringStore(f.options),
    source = request(full, 5000, "B", "C");
  full.beginOperation(source);
  full.markOperationUncertain(source.operationId, source.payloadDigest);
  expect(() => full.beginOperation(request(full, 5001, "B", "C", "extra"))).toThrow(/resolution reservations/u);
  const resolve = {
    ...source,
    operationId: (5002).toString(16).padStart(32, "0"),
    op: "operation.resolve_uncertain" as const,
    target: { kind: "operation" as const, operationId: source.operationId },
  };
  expect(full.beginOperation(resolve).kind).toBe("begun");
  expect(full.listOperations(root)).toHaveLength(4096);
  const done = full.resolveSourceOperation(source.operationId, source.payloadDigest, {
    outcome: "resolved",
    evidence: "inferred_confirmed",
    current: {
      observed: "matches_candidate",
      sourceRevision: revision,
      contentRevision: source.candidate!.revision,
      inferred: true,
    },
    review: { mode: "on_save", configRevision: revision, state: "not_queued_no_effect" },
  });
  expect(done.state).toBe("terminal");
});
test("v2 parser refuses review evidence inconsistent with its source operation snapshots or CAS", () => {
  const f = setup();
  save(f.store, request(f.store, 1));
  const disk = JSON.parse(readFileSync(join(f.stateDir, "runtime/authoring/index.json"), "utf8"));
  for (const version of ["1", "2", true, 0, 3])
    expect(() => parseAuthoringIndex(Buffer.from(JSON.stringify({ ...disk, version })))).toThrow();
  for (const patch of [
    { latestSourceRevision: "sha256:" + "f".repeat(64) },
    { baseline: disk.reviews[0].latest },
    { saveCount: 2 },
    { externalGaps: 1 },
    { subject: { kind: "document", path: ".archer/another.mmd" } },
  ]) {
    const changed = structuredClone(disk);
    Object.assign(changed.reviews[0], patch);
    expect(() => parseAuthoringIndex(Buffer.from(JSON.stringify(changed)))).toThrow();
  }
});
// B4: every conflict and no-op Save took a lifetime journal slot, so a busy
// service eventually refused every browser Save for good.
test("conflicts and no-op saves keep only a bounded replay window while settled history stays", () => {
  const f = setup(),
    window = AUTHORING_STORE_LIMITS.replayWindow;
  save(f.store, request(f.store, 1));
  const indexPath = join(f.stateDir, "runtime/authoring/index.json"),
    disk = JSON.parse(readFileSync(indexPath, "utf8")),
    first = disk.operations[0];
  const noEffect = (n: number) => ({
    ...first,
    operationId: n.toString(16).padStart(32, "0"),
    completion:
      n % 2
        ? {
            outcome: "conflict",
            conflict: { kind: "source" },
            review: { mode: "on_save", configRevision: revision, state: "not_queued_no_effect" },
          }
        : {
            ...first.completion,
            outcome: "unchanged",
            review: { mode: "on_save", configRevision: revision, state: "not_queued_no_effect" },
          },
  });
  for (let n = 2; n < window + 60; n++) disk.operations.push(noEffect(n));
  writeFileSync(indexPath, JSON.stringify(disk));
  const s = new AuthoringStore(f.options);
  const stale = request(s, 4000, "B", "B");
  s.beginOperation(stale);
  s.completeOperation(stale.operationId, stale.payloadDigest, {
    outcome: "conflict",
    conflict: { kind: "source" },
    review: { mode: "on_save", configRevision: revision, state: "not_queued_no_effect" },
  });
  expect(s.listOperations(root)).toHaveLength(1 + window);
  expect(s.getOperation(request(s, 1).operationId)?.state).toBe("terminal"); // the applied Save and its review stay
  expect(only(s).firstOperationId).toBe(request(s, 1).operationId);
  expect(s.getOperation(noEffect(2).operationId)).toBeNull(); // the oldest no-effect records left the window
  expect(s.getOperation(noEffect(window + 59).operationId)).not.toBeNull();
  expect(s.beginOperation(stale).kind).toBe("replayed"); // a recent retry still replays exactly
  save(s, request(s, 5000, "B", "C"));
  expect(s.listOperations(root)).toHaveLength(1 + window);
  expect(only(s).saveCount).toBe(2);
  expect(new AuthoringStore(f.options).listOperations(root)).toHaveLength(1 + window);
});
test("the lifetime operation cap refuses with rotation guidance", () => {
  const f = setup(),
    s = f.store;
  save(s, request(s, 1));
  const indexPath = join(f.stateDir, "runtime/authoring/index.json"),
    disk = JSON.parse(readFileSync(indexPath, "utf8")),
    first = disk.operations[0];
  for (let n = 2; n <= AUTHORING_STORE_LIMITS.operations; n++)
    disk.operations.push({
      ...first,
      operationId: n.toString(16).padStart(32, "0"),
      completion: {
        outcome: "resolved",
        evidence: "abandoned",
        current: { observed: "diverged", sourceRevision: revision, contentRevision: revision, inferred: true },
        review: { mode: "on_save", configRevision: revision, state: "not_queued_no_effect" },
      },
    });
  writeFileSync(indexPath, JSON.stringify(disk));
  const full = new AuthoringStore(f.options);
  let refusal: unknown;
  try {
    full.beginOperation(request(full, 5000, "B", "C"));
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({ code: "authoring_store_capacity", message: JOURNAL_FULL });
  expect(JOURNAL_FULL).toMatch(/runtime\/authoring.*new journal generation/u);
});
