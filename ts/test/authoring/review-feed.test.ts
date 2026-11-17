import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthoringStore, type JournalIntent } from "../../src/authoring/store.ts";
import { listCumulativeReviews, readCumulativeReview } from "../../src/authoring/review-feed.ts";
import { revisionOf } from "../../src/project/envelope.ts";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "archer-cumulative-feed-"));
  dirs.push(d);
  return d;
};
function setup() {
  const state = temp(),
    root = temp();
  mkdirSync(join(root, ".archer"));
  writeFileSync(join(root, "archer.toml"), "version = 1\n");
  return { root, store: new AuthoringStore({ stateDir: state, serviceName: "default", assertOwner() {} }) };
}
function save(
  store: AuthoringStore,
  root: string,
  n: number,
  previous: string | null,
  next: string,
  path = "a.mmd",
  manual = false,
) {
  const operationId = n.toString(16).padStart(32, "0");
  const intent: JournalIntent = {
    operationId,
    payloadDigest: revisionOf(Buffer.from(String(n))),
    op: previous === null ? "document.publish" : "document.apply",
    projectRoot: root,
    authority: { grantId: "grant", entitlementId: "ent" },
    feedback: {
      changes: manual ? "manual" : "on_save",
      delivery: "next_call",
      effectiveRevision: revisionOf(Buffer.from("policy")),
    },
    target: { kind: "document", path: ".archer/" + path },
    expected: { sourceRevision: previous === null ? null : revisionOf(Buffer.from(previous)) },
    base: previous === null ? null : store.putSnapshot(Buffer.from(previous)),
    candidate: store.putSnapshot(Buffer.from(next)),
  };
  store.beginOperation(intent);
  writeFileSync(join(root, ".archer", path), next);
  store.completeSourceOperation(operationId, intent.payloadDigest, {
    outcome: previous === null ? "created" : "applied",
    document: { path: ".archer/" + path, sourceRevision: revisionOf(Buffer.from(next)), modelRevision: null },
    evidence: "observed",
    review: {
      mode: manual ? "manual" : "on_save",
      configRevision: intent.feedback.effectiveRevision,
      state: "admission_pending",
    },
  });
}
test("three saves expose one oldest-baseline to latest review and bounded source/diff", () => {
  const { root, store } = setup();
  save(store, root, 1, "flowchart LR\na[A]\n", "flowchart LR\na[B]\n");
  save(store, root, 2, "flowchart LR\na[B]\n", "flowchart LR\na[C]\n");
  const page = listCumulativeReviews(store, root);
  expect(page.reviews).toHaveLength(1);
  expect(page.reviews[0]).toMatchObject({ saveCount: 2, reviewRevision: 2, netEffect: "changed" });
  const detail = readCumulativeReview(store, root, page.reviews[0]!.reviewId);
  expect(detail.baseline.text).toBe("flowchart LR\na[A]\n");
  expect(detail.latest.text).toBe("flowchart LR\na[C]\n");
  expect(detail.diff.text).toContain("-a[A]");
  expect(detail.diff.text).toContain("+a[C]");
  expect(detail.current.status).toBe("matches_after");
  expect(detail.untrusted).toBe(true);
});
test("review cursors are project/store bound; held reviews stay visible but are omitted from hints", () => {
  const { root, store } = setup();
  save(store, root, 1, null, "flowchart LR\na[A]\n", "a.mmd");
  save(store, root, 2, null, "flowchart LR\nb[B]\n", "b.mmd", true);
  const first = listCumulativeReviews(store, root, 1);
  expect(first.reviews).toHaveLength(1);
  expect(first.hasMore).toBe(true);
  expect(listCumulativeReviews(store, root, 1, first.nextCursor!).reviews[0]!.delivery).toBe("held");
  expect(listCumulativeReviews(store, root, 3, undefined, true).reviews).toHaveLength(1);
  expect(() => listCumulativeReviews(store, temp(), 1, first.nextCursor!)).toThrow();
  expect(() => readCumulativeReview(store, temp(), first.reviews[0]!.reviewId)).toThrow();
});
