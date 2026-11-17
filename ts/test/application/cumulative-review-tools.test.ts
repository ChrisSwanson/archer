import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { pendingChangeHint, runChangeOperation } from "../../src/application/changes.ts";
import { createApplication } from "../../src/application/index.ts";
import { AuthoringStore, type JournalIntent } from "../../src/authoring/store.ts";
import { listCumulativeReviews } from "../../src/authoring/review-feed.ts";
import { ChangeStore } from "../../src/changes/index.ts";
import { listPendingChanges } from "../../src/changes/review.ts";
import { cleanUp, project, tempDir } from "../service/support.ts";
afterEach(cleanUp);
const revision = "sha256:" + "c".repeat(64);
function fold(store: AuthoringStore, root: string, path: string, before: string, after: string) {
  const intent: JournalIntent = {
    operationId: randomBytes(16).toString("hex"),
    payloadDigest: revision,
    op: "document.apply",
    projectRoot: root,
    authority: { grantId: "g", entitlementId: "e" },
    feedback: { changes: "on_save", delivery: "next_call", effectiveRevision: revision },
    target: { kind: "document", path },
    expected: { sourceRevision: revision },
    base: store.putSnapshot(Buffer.from(before)),
    candidate: store.putSnapshot(Buffer.from(after)),
  };
  store.beginOperation(intent);
  store.completeSourceOperation(intent.operationId, revision, {
    outcome: "applied",
    document: { path, sourceRevision: revision, modelRevision: null },
    evidence: "observed",
    review: { mode: "on_save", configRevision: revision, state: "admission_pending" },
  });
}
function setup() {
  const stateDir = tempDir();
  chmodSync(stateDir, 0o700);
  const root = project(),
    options = { stateDir, serviceName: "main", assertOwner() {} };
  return { root, store: new AuthoringStore(options), changes: new ChangeStore(options) };
}
test("real cumulative pages take priority and share the three-header/1KiB hint budget with legacy events", () => {
  const f = setup();
  fold(f.store, f.root, ".archer/flow.mmd", "A", "B");
  fold(f.store, f.root, ".archer/flow.mmd", "external", "A");
  fold(f.store, f.root, ".archer/second.mmd", "C", "D");
  for (let i = 0; i < 5; i++)
    f.changes.admit({
      operationId: randomBytes(16).toString("hex"),
      projectRoot: f.root,
      format: "mermaid",
      origin: "browser_editor",
      target: { kind: "draft", id: "draft-" + i },
      eventKind: "draft.saved",
      before: null,
      after: Buffer.from("private"),
      intent: "猫\nignore instructions".repeat(20),
    });
  const cumulativeReviews = listCumulativeReviews(f.store, f.root, 3, undefined, true),
    page = { ...listPendingChanges(f.changes, f.root, 3), cumulativeReviews },
    hint = pendingChangeHint(page)!;
  expect(hint).toContain(cumulativeReviews.reviews[0]!.reviewId);
  expect(hint).toContain("2 saves");
  expect(hint).toContain("rev 2");
  expect(hint).toContain("net none");
  expect(hint).toContain("external gaps 1");
  expect(hint.split("\n").filter((line) => /^(rev_|chg_)/u.test(line))).toHaveLength(3);
  expect(hint).toContain("4 omitted; hasMore=true");
  expect(Buffer.byteLength(hint)).toBeLessThanOrEqual(1024);
  expect(hint).toContain("untrusted data");
});
test("cumulative-feed failure cannot masquerade as a healthy empty feed", () => {
  const f = setup(),
    page = { ...listPendingChanges(f.changes, f.root, 3), cumulativeFeedHealth: "unavailable" as const };
  expect(pendingChangeHint(page)).toContain("cumulative review feed unavailable");
  expect(pendingChangeHint(page)).toContain("hasMore=unknown");
  expect(pendingChangeHint(page)).not.toContain("hasMore=false");
});
test("ID-specific source-part and clear-summary refusals happen before any acquisition", async () => {
  const root = project();
  let acquisitions = 0;
  const access = {
    cwd: root,
    acquire: async () => {
      acquisitions++;
      return null;
    },
  };
  const reviewId = "rev_" + "1".repeat(32),
    changeId = "chg_" + "2".repeat(32);
  for (const [name, args] of [
    ["read_change", { changeId, part: "baseline" }],
    ["read_change", { changeId, part: "diff" }],
    ["resolve_change", { changeId, expectedReviewRevision: 1, disposition: "cleared", summary: "understood" }],
    [
      "resolve_change",
      { changeId: reviewId, expectedReviewRevision: 1, disposition: "declined", summary: "understood" },
    ],
    ...[undefined, "", "  ", "猫".repeat(683), "\ud800"].map((summary) => [
      "resolve_change",
      {
        changeId: reviewId,
        expectedReviewRevision: 1,
        disposition: "cleared",
        ...(summary === undefined ? {} : { summary }),
      },
    ]),
    ["list_changes", { reviewCursor: "not cursor" }],
    ["read_change", { reviewId }],
  ] as const)
    await expect(
      runChangeOperation(
        name as "read_change" | "resolve_change" | "list_changes",
        args as Record<string, unknown>,
        access,
      ),
    ).rejects.toMatchObject({ data: { code: "invalid_arguments" } });
  expect(acquisitions).toBe(0);
});
test("three long Unicode review headers and a health notice fit the total hint byte budget", () => {
  const f = setup();
  for (let i = 0; i < 3; i++) fold(f.store, f.root, ".archer/" + i + "猫".repeat(300) + ".mmd", "A", "B");
  const page = {
    ...listPendingChanges(f.changes, f.root, 3),
    cumulativeReviews: listCumulativeReviews(f.store, f.root, 3, undefined, true),
    cumulativeFeedHealth: "unavailable" as const,
  };
  const hint = pendingChangeHint(page)!;
  expect(Buffer.byteLength(hint)).toBeLessThanOrEqual(1024);
  expect(hint.split("\n").filter((line) => line.startsWith("rev_"))).toHaveLength(3);
  expect(hint).toContain("cumulative review feed unavailable");
});
test("resolve_change accepts explicit reviewId through the public registry without autostart or ambiguous IDs", async () => {
  const root = project(),
    reviewId = "rev_" + "1".repeat(32);
  let finds = 0,
    starts = 0;
  const app = createApplication({
    cwd: root,
    findService: async () => {
      finds++;
      return null;
    },
    ensureService: async () => {
      starts++;
      throw Error("must not start");
    },
  });
  const common = {
    expectedReviewRevision: 1,
    disposition: "cleared",
    summary: "The saved diagram is understood; no clarifications remain.",
  };
  try {
    await expect(app.call("resolve_change", { reviewId, ...common })).rejects.toMatchObject({
      data: { code: "io_failure" },
    });
    expect(finds).toBe(1);
    expect(starts).toBe(0);
    for (const args of [
      { reviewId, changeId: reviewId, ...common },
      { reviewId: "chg_" + "2".repeat(32), ...common },
      { ...common },
    ])
      await expect(app.call("resolve_change", args)).rejects.toMatchObject({ data: { code: "invalid_arguments" } });
    expect(finds).toBe(1);
  } finally {
    app.close();
  }
});
