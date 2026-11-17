import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AuthoringCoordinator } from "../../src/authoring/coordinator.ts";
import { AuthoringStore } from "../../src/authoring/store.ts";
import { ChangeStore } from "../../src/changes/index.ts";
import { findProject } from "../../src/project/project.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import { resolveFeedbackConfiguration } from "../../src/config/feedback-resolution.ts";
import { FLOW, tempDir, removeTempDirs } from "../project/support.ts";
afterEach(removeTempDirs);
const id = (n = 1) => n.toString(16).padStart(32, "0");
function fixture(extra: Record<string, string> = {}) {
  const root = tempDir({
    "archer.toml": 'version = 1\n[feedback]\nchanges = "manual"\n',
    ".archer/a.mmd": FLOW,
    ".archer/b.mmd": FLOW,
    ...extra,
  });
  const state = tempDir();
  chmodSync(state, 0o700);
  const store = new AuthoringStore({ stateDir: state, serviceName: "main", assertOwner() {} }),
    changes = new ChangeStore({ stateDir: state, serviceName: "main", assertOwner() {} });
  const options = {
    store,
    changes,
    project: () => findProject(root),
    authority: () => ({ grantId: "g", entitlementId: "e" }),
    feedback: (project: ReturnType<typeof findProject>) => {
      const f = resolveFeedbackConfiguration({ user: {} as never, project, serviceName: "main" });
      return { changes: f.changes, delivery: f.delivery, effectiveRevision: f.revision };
    },
  };
  return { root, state, store, options, coordinator: new AuthoringCoordinator(options) };
}

test("two direct Saves atomically retain oldest baseline and latest source without admitting ChangeStore events", async () => {
  const f = fixture(),
    opened = f.coordinator.open({ kind: "view", viewId: "a" }),
    firstSource = FLOW.replace("Client", "First"),
    latestSource = FLOW.replace("Client", "Latest");
  const first = await f.coordinator.mutate({
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedTargetRevision: opened.targetRevision,
    expectedSourceRevision: opened.sourceRevision,
    source: firstSource,
  });
  const second = await f.coordinator.mutate({
    op: "document.apply",
    operationId: id(2),
    target: opened.target,
    expectedTargetRevision: opened.targetRevision,
    expectedSourceRevision: first.document!.sourceRevision,
    source: latestSource,
  });
  expect(second.review).toMatchObject({
    state: "tracked_held",
    reviewId: expect.stringMatching(/^rev_[0-9a-f]{32}$/u),
    reviewRevision: 2,
  });
  const reviews = f.store.listReviews(f.root);
  expect(reviews).toHaveLength(1);
  expect(f.store.readSnapshot(reviews[0]!.baseline!).toString()).toBe(FLOW);
  expect(f.store.readSnapshot(reviews[0]!.latest).toString()).toBe(latestSource);
  expect(reviews[0]!.saveCount).toBe(2);
  expect(f.options.changes.pending(f.root, { limit: 10 }).records).toEqual([]);
}, 15000);
test("manual Send offers the outstanding cumulative review once, without legacy event admission", async () => {
  const f = fixture(),
    opened = f.coordinator.open({ kind: "view", viewId: "a" }),
    saved = await f.coordinator.mutate({
      op: "document.apply",
      operationId: id(),
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
      source: FLOW.replace("Client", "Changed"),
    });
  const sent = await f.coordinator.mutate({ op: "operation.send", operationId: id(2), targetOperationId: id() });
  expect(sent).toMatchObject({
    outcome: "sent",
    review: { state: "tracked", reviewId: saved.review!.reviewId, reviewRevision: 2 },
  });
  const again = await f.coordinator.mutate({ op: "operation.send", operationId: id(3), targetOperationId: id() });
  expect(again).toMatchObject({ outcome: "no_effect", review: { reviewRevision: 2 } });
  expect(f.store.listReviews(f.root)[0]!.delivery).toBe("offered");
  expect(f.options.changes.pending(f.root, { limit: 10 }).records).toHaveLength(0);
  const later = await f.coordinator.mutate({
    op: "document.apply",
    operationId: id(4),
    target: opened.target,
    expectedTargetRevision: opened.targetRevision,
    expectedSourceRevision: saved.document!.sourceRevision,
    source: FLOW.replace("Client", "Fresh"),
  });
  expect(later.review).toMatchObject({ state: "tracked_held", reviewRevision: 3 });
  const status = f.coordinator.status(1, 99);
  expect(status.operations).toEqual([]);
  expect(status.heldSourceOperations).toMatchObject([
    {
      operationId: id(4),
      state: "terminal",
      subject: { path: ".archer/a.mmd" },
      review: { state: "tracked_held", reviewRevision: 3 },
    },
  ]);
}, 15000);
test("unchanged Save does not fold; A→B→A stays pending until CAS clear; later Save opens another baseline", async () => {
  const f = fixture(),
    opened = f.coordinator.open({ kind: "view", viewId: "a" });
  let token = opened.sourceRevision;
  const save = async (n: number, source: string) => {
    const r = await f.coordinator.mutate({
      op: "document.apply",
      operationId: id(n),
      target: opened.target,
      expectedTargetRevision: opened.targetRevision,
      expectedSourceRevision: token,
      source,
    });
    token = r.document!.sourceRevision;
    return r;
  };
  await save(1, FLOW.replace("Client", "B"));
  const noop = await save(2, FLOW.replace("Client", "B"));
  expect(noop.review?.state).toBe("not_queued_no_effect");
  expect(f.store.listReviews(f.root)[0]!.reviewRevision).toBe(1);
  await save(3, FLOW);
  const review = f.store.listReviews(f.root)[0]!;
  expect(review).toMatchObject({ state: "pending", saveCount: 2, reviewRevision: 2 });
  expect(review.latest).toEqual(review.baseline);
  expect(() => f.store.clearReview(f.root, review.reviewId, 1, "understood")).toThrow(/currentReviewRevision=2/u);
  f.store.clearReview(f.root, review.reviewId, 2, "understood");
  await save(4, FLOW.replace("Client", "D"));
  const reviews = f.store.listReviews(f.root);
  expect(reviews).toHaveLength(2);
  expect(reviews[1]!.baseline).toEqual(review.latest);
  expect(reviews[1]!.reviewId).not.toBe(review.reviewId);
}, 15000);
test("Publish starts with absent baseline; embedded saves preserve prose and use separate block subjects", async () => {
  const note =
    "Before\r\n```mermaid\r\n%% archer-id: one\r\nflowchart LR\r\na[A]\r\n```\r\nMiddle\r\n```mermaid\r\n%% archer-id: two\r\nflowchart LR\r\nb[B]\r\n```\r\nAfter";
  const f = fixture({ ".archer/n.md": note });
  await f.coordinator.mutate({ op: "document.publish", operationId: id(), path: "diagrams/born.mmd", source: FLOW });
  expect(f.store.listReviews(f.root)[0]!.baseline).toBeNull();
  for (const [n, name] of [
    [2, "one"],
    [3, "two"],
  ] as const) {
    const opened = f.coordinator.open({ kind: "embedded", address: `n.md#${name}` });
    await f.coordinator.mutate({
      op: "document.apply",
      operationId: id(n),
      target: opened.target,
      expectedTargetRevision: opened.targetRevision,
      expectedSourceRevision: opened.sourceRevision,
      source: FLOW,
    });
  }
  const reviews = f.store.listReviews(f.root);
  expect(reviews).toHaveLength(3);
  expect(reviews.slice(1).map((r) => r.subject.blockId)).toEqual(["one", "two"]);
  const actual = readFileSync(join(f.root, ".archer/n.md"), "utf8");
  expect(actual.startsWith("Before\r\n")).toBe(true);
  expect(actual).toContain("```\r\nMiddle\r\n```");
  expect(actual.endsWith("```\r\nAfter")).toBe(true);
}, 15000);
test("interleaved compiler awaits fold in actual source publication order", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let waiting = false;
  const { compileDiagramBytes } = await import("../../src/project/envelope.ts");
  const slow = new AuthoringCoordinator({
      ...f.options,
      compile: async (entry, bytes) => {
        waiting = true;
        await gate;
        return compileDiagramBytes(entry, bytes);
      },
    }),
    opened = slow.open({ kind: "view", viewId: "a" });
  const pending = slow.mutate({
    op: "document.apply",
    operationId: id(2),
    target: opened.target,
    expectedTargetRevision: opened.targetRevision,
    expectedSourceRevision: revisionOf(Buffer.from(FLOW.replace("Client", "Fast"))),
    source: FLOW.replace("Client", "Slow"),
  });
  expect(waiting).toBe(true);
  const fast = await f.coordinator.mutate({
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedTargetRevision: opened.targetRevision,
    expectedSourceRevision: opened.sourceRevision,
    source: FLOW.replace("Client", "Fast"),
  });
  release();
  const last = await pending;
  expect(last.outcome).toBe("applied");
  expect(f.store.listReviews(f.root)).toHaveLength(1);
  expect(f.store.listReviews(f.root)[0]!.lastOperationId).toBe(last.operationId);
  expect(f.store.listReviews(f.root)[0]!.firstOperationId).toBe(fast.operationId);
  expect(f.store.listReviews(f.root)[0]!.saveCount).toBe(2);
  expect(f.store.readSnapshot(f.store.listReviews(f.root)[0]!.baseline!).toString()).toBe(FLOW);
  expect(f.store.readSnapshot(f.store.listReviews(f.root)[0]!.latest)).toEqual(
    readFileSync(join(f.root, ".archer/a.mmd")),
  );
}, 15000);

test("review capacity refuses actual source publication before any canonical bytes change", async () => {
  const f = fixture(),
    opened = f.coordinator.open({ kind: "view", viewId: "a" });
  await f.coordinator.mutate({
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedTargetRevision: opened.targetRevision,
    expectedSourceRevision: opened.sourceRevision,
    source: FLOW.replace("Client", "Seed"),
  });
  const indexPath = join(f.state, "runtime/authoring/index.json"),
    disk = JSON.parse(readFileSync(indexPath, "utf8")),
    original = disk.reviews[0],
    op = disk.operations[0];
  for (let i = 1; i < 256; i++) {
    const operationId = id(i + 1),
      reviewId = "rev_" + operationId,
      path = `.archer/item${i}.mmd`;
    disk.reviews.push({
      ...original,
      reviewId,
      sequence: i + 1,
      subject: { kind: "document", path },
      firstOperationId: operationId,
      lastOperationId: operationId,
    });
    disk.operations.push({
      ...op,
      operationId,
      target: { kind: "document", path },
      completion: {
        ...op.completion,
        document: { ...op.completion.document, path },
        review: { ...op.completion.review, reviewId },
      },
    });
  }
  writeFileSync(indexPath, JSON.stringify(disk));
  const store = new AuthoringStore({ stateDir: f.state, serviceName: "main", assertOwner() {} }),
    coordinator = new AuthoringCoordinator({ ...f.options, store }),
    second = coordinator.open({ kind: "view", viewId: "b" });
  await expect(
    coordinator.mutate({
      op: "document.apply",
      operationId: id(257),
      target: second.target,
      expectedTargetRevision: second.targetRevision,
      expectedSourceRevision: second.sourceRevision,
      source: FLOW.replace("Client", "Refused"),
    }),
  ).rejects.toMatchObject({ code: "authoring_store_capacity" });
  expect(readFileSync(join(f.root, ".archer/b.mmd"), "utf8")).toBe(FLOW);
  expect(store.listReviews(f.root)).toHaveLength(256);
  expect(store.getOperation(id(257))).toMatchObject({ state: "terminal", completion: { outcome: "no_effect" } });
}, 15000);
