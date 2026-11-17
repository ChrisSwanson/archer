import { chmodSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AuthoringCoordinator } from "../../src/authoring/coordinator.ts";
import { AuthoringStore } from "../../src/authoring/store.ts";
import { ChangeStore } from "../../src/changes/index.ts";
import { findProject } from "../../src/project/project.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import { resolveFeedbackConfiguration } from "../../src/config/feedback-resolution.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";
afterEach(removeTempDirs);
const id = (n = 1) => n.toString(16).padStart(32, "0");
const draftId = "drf_" + id();
function setup(mode: "manual" | "on_save" = "manual") {
  const root = tempDir({ "archer.toml": `version = 1\n[feedback]\nchanges = "${mode}"\n`, ".archer/a.mmd": FLOW });
  const state = tempDir();
  chmodSync(state, 0o700);
  let authorized = true;
  const store = new AuthoringStore({ stateDir: state, serviceName: "main", assertOwner() {} });
  const changes = new ChangeStore({ stateDir: state, serviceName: "main", assertOwner() {} });
  const coordinator = new AuthoringCoordinator({
    store,
    changes,
    project: () => findProject(root),
    authority: () => {
      if (!authorized) throw Object.assign(new Error("revoked"), { code: "authoring_forbidden" });
      return { grantId: "grant", entitlementId: "entitlement" };
    },
    feedback: (project) => {
      const f = resolveFeedbackConfiguration({ user: {} as never, project, serviceName: "main" });
      return { changes: f.changes, delivery: f.delivery, effectiveRevision: f.revision };
    },
  });
  return {
    root,
    state,
    store,
    changes,
    coordinator,
    revoke() {
      authorized = false;
    },
  };
}
test("save creates immutable private revision and replay receipt without writing source", async () => {
  const { coordinator, store, root, changes } = setup();
  const request = {
    op: "draft.save",
    operationId: id(),
    draftId,
    expectedDraftRevision: null,
    origin: { kind: "new", path: "diagrams/new.mmd" },
    source: FLOW,
  } as const;
  const first = await coordinator.mutate(request);
  expect(first).toMatchObject({
    operationId: id(),
    state: "terminal",
    outcome: "saved",
    draft: { draftId, draftRevision: 1 },
    review: { state: "not_queued_manual" },
  });
  expect(await coordinator.mutate(request)).toEqual(first);
  expect(store.getDraft(root, draftId)?.head.valid).toBe(true);
  expect(() => readFileSync(join(root, ".archer/diagrams/new.mmd"))).toThrow();
  expect(changes.pending(root, { limit: 10 }).records).toEqual([]);
});
test("invalid private save is acknowledged but never queued; immutable valid revision sends once", async () => {
  const { coordinator, changes, root } = setup("on_save");
  const invalid = await coordinator.mutate({
    op: "draft.save",
    operationId: id(1),
    draftId,
    expectedDraftRevision: null,
    origin: { kind: "new" },
    source: "invalid source",
  });
  expect(invalid.review?.state).toBe("not_queued_invalid");
  expect(changes.pending(root, { limit: 10 }).records).toHaveLength(0);
  await expect(
    coordinator.mutate({ op: "draft.send", operationId: id(2), draftId, draftRevision: 1 }),
  ).rejects.toMatchObject({ code: "invalid_source" });
  const valid = await coordinator.mutate({
    op: "draft.save",
    operationId: id(3),
    draftId,
    expectedDraftRevision: 1,
    source: FLOW,
  });
  expect(valid.review?.state).toBe("queued");
  await coordinator.mutate({ op: "draft.send", operationId: id(4), draftId, draftRevision: 2 });
  await coordinator.mutate({ op: "draft.send", operationId: id(5), draftId, draftRevision: 2 });
  expect(changes.pending(root, { limit: 10 }).records).toHaveLength(1);
  expect(coordinator.snapshot(draftId, 1).source).toBe("invalid source");
  expect(coordinator.snapshot(draftId, 2).source).toBe(FLOW);
});
test("direct Apply journals before source write, replays without repeating effect and manual send offers its cumulative review", async () => {
  const { coordinator, changes, root, store } = setup();
  const opened = coordinator.open({ kind: "view", viewId: "a" });
  const source = FLOW.replace("Client", "Changed");
  const request = {
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedSourceRevision: opened.sourceRevision,
    expectedTargetRevision: opened.targetRevision,
    source,
  } as const;
  const result = await coordinator.mutate(request);
  expect(result).toMatchObject({
    state: "terminal",
    outcome: "applied",
    document: { path: ".archer/a.mmd", sourceRevision: revisionOf(Buffer.from(source)) },
    review: { state: "tracked_held" },
    evidence: "observed",
  });
  expect(store.getOperation(id())?.candidate?.revision).toBe(revisionOf(Buffer.from(source)));
  writeFileSync(join(root, ".archer/a.mmd"), FLOW.replace("Client", "External"));
  expect(await coordinator.mutate(request)).toEqual(result);
  expect(readFileSync(join(root, ".archer/a.mmd"), "utf8")).toContain("External");
  await coordinator.mutate({ op: "operation.send", operationId: id(2), targetOperationId: id() });
  const reviews = store.listReviews(root);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]!.delivery).toBe("offered");
  expect(store.readSnapshot(reviews[0]!.latest).toString()).toBe(source);
  expect(changes.pending(root, { limit: 10 }).records).toHaveLength(0);
  await expect(coordinator.mutate({ ...request, source: FLOW })).rejects.toMatchObject({
    code: "authoring_operation_mismatch",
  });
});
test("Publish creates exactly once, existing destination returns conflict and no-effect Apply never queues", async () => {
  const { coordinator, root, changes, store } = setup("on_save");
  const request = { op: "document.publish", operationId: id(), path: "diagrams/new.mmd", source: FLOW } as const;
  const published = await coordinator.mutate(request);
  expect(published.outcome).toBe("created");
  expect(await coordinator.mutate(request)).toEqual(published);
  expect((await coordinator.mutate({ ...request, operationId: id(2) })).outcome).toBe("conflict");
  const opened = coordinator.open({ kind: "view", viewId: "a" });
  const unchanged = await coordinator.mutate({
    op: "document.apply",
    operationId: id(3),
    target: opened.target,
    expectedSourceRevision: opened.sourceRevision,
    expectedTargetRevision: opened.targetRevision,
    source: opened.source,
  });
  expect(unchanged).toMatchObject({ outcome: "unchanged", review: { state: "not_queued_no_effect" } });
  expect(changes.pending(root, { limit: 10 }).records).toHaveLength(0);
  expect(store.listReviews(root)).toHaveLength(1);
  expect(readFileSync(join(root, ".archer/diagrams/new.mmd"), "utf8")).toBe(FLOW);
});
test("proposal retains exact original path/base and status resolves target only while mapping and base still match", async () => {
  const { coordinator, store, root } = setup();
  const opened = coordinator.open({ kind: "view", viewId: "a" });
  await coordinator.mutate({
    op: "draft.save",
    operationId: id(),
    draftId,
    expectedDraftRevision: null,
    origin: {
      kind: "document",
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
    },
    source: FLOW.replace("Client", "Proposal"),
  });
  const original = store.getDraft(root, draftId)!.origin;
  expect(original).toMatchObject({
    kind: "document",
    path: ".archer/a.mmd",
    baseSourceRevision: opened.sourceRevision,
  });
  expect(coordinator.status().drafts[0]!.origin.target).toEqual(opened.target);
  writeFileSync(join(root, ".archer/a.mmd"), FLOW.replace("Client", "External"));
  await coordinator.mutate({
    op: "draft.save",
    operationId: id(2),
    draftId,
    expectedDraftRevision: 1,
    source: FLOW.replace("Client", "Revised proposal"),
  });
  expect(store.getDraft(root, draftId)!.origin).toEqual(original);
  expect(coordinator.status().drafts[0]!.origin.target).toBeUndefined();
});
test("discard and withdrawal use revision CAS and keep immutable saved work", async () => {
  const { coordinator, changes, root } = setup("on_save");
  const saved = await coordinator.mutate({
    op: "draft.save",
    operationId: id(),
    draftId,
    expectedDraftRevision: null,
    origin: { kind: "new" },
    source: FLOW,
  });
  expect(saved.review?.changeId).toBeDefined();
  const change = changes.get(root, saved.review!.changeId!)!;
  const withdrawn = await coordinator.mutate({
    op: "change.withdraw",
    operationId: id(2),
    changeId: change.changeId,
    reviewRevision: change.reviewRevision,
  });
  expect(withdrawn.outcome).toBe("withdrawn");
  expect(changes.get(root, change.changeId)?.disposition).toBe("withdrawn");
  expect(
    (await coordinator.mutate({ op: "draft.discard", operationId: id(3), draftId, draftRevision: 1 })).outcome,
  ).toBe("discarded");
  expect(coordinator.snapshot(draftId, 1).source).toBe(FLOW);
});
test("ill-formed UTF-16 source or intent is refused before private save or publication", async () => {
  const { coordinator, store, root } = setup();
  for (const request of [
    {
      op: "draft.save",
      operationId: id(),
      draftId,
      expectedDraftRevision: null,
      origin: { kind: "new" },
      source: "\uD800",
    },
    {
      op: "draft.save",
      operationId: id(2),
      draftId,
      expectedDraftRevision: null,
      origin: { kind: "new" },
      source: FLOW,
      intent: "\uDC00",
    },
    { op: "document.publish", operationId: id(3), path: "diagrams/new.mmd", source: FLOW + "\uD800" },
  ])
    await expect(coordinator.mutate(request)).rejects.toMatchObject({ code: "authoring_invalid_request" });
  expect(store.listDrafts(root)).toEqual([]);
  expect(store.listOperations(root)).toEqual([]);
  expect(() => readFileSync(join(root, ".archer/diagrams/new.mmd"))).toThrow();
  const exact = '\uFEFFflowchart LR\r\na["🐦"]\r\n';
  const valid = await coordinator.mutate({
    op: "document.publish",
    operationId: id(4),
    path: "diagrams/new.mmd",
    source: exact,
    intent: "🐦 preserved",
  });
  expect(valid.outcome).toBe("created");
  expect(readFileSync(join(root, ".archer/diagrams/new.mmd"))).toEqual(Buffer.from(exact));
});
test("direct Apply refuses diagram-family changes before any journal or canonical effect", async () => {
  const { coordinator, store, root } = setup(),
    opened = coordinator.open({ kind: "view", viewId: "a" });
  const sequence = "sequenceDiagram\nparticipant A as Alice\nparticipant B as Bob\nA->>B: hi\n";
  await expect(
    coordinator.mutate({
      op: "document.apply",
      operationId: id(),
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
      source: sequence,
    }),
  ).rejects.toMatchObject({ code: "invalid_source" });
  expect(readFileSync(join(root, ".archer/a.mmd"), "utf8")).toBe(FLOW);
  expect(store.getOperation(id())).toBeNull();
});
test("stale draft and review CAS produce terminal no-effect conflict receipts, not recovery uncertainty", async () => {
  const { coordinator, store, changes, root } = setup("on_save");
  const saved = await coordinator.mutate({
    op: "draft.save",
    operationId: id(),
    draftId,
    expectedDraftRevision: null,
    origin: { kind: "new" },
    source: FLOW,
  });
  const stale = await coordinator.mutate({
    op: "draft.save",
    operationId: id(2),
    draftId,
    expectedDraftRevision: 2,
    source: FLOW.replace("Client", "New"),
  });
  expect(stale).toMatchObject({ state: "terminal", outcome: "conflict", conflict: { kind: "draft" } });
  const change = changes.get(root, saved.review!.changeId!)!;
  const review = await coordinator.mutate({
    op: "change.withdraw",
    operationId: id(3),
    changeId: change.changeId,
    reviewRevision: change.reviewRevision + 1,
  });
  expect(review).toMatchObject({ state: "terminal", outcome: "conflict", conflict: { kind: "review" } });
  expect(store.getOperation(id(3))?.state).toBe("terminal");
  expect(changes.get(root, change.changeId)?.disposition).toBe("pending");
});
test("manual send of an older immutable valid saved revision queues its exact bytes only once", async () => {
  const { coordinator, changes, root } = setup();
  await coordinator.mutate({
    op: "draft.save",
    operationId: id(),
    draftId,
    expectedDraftRevision: null,
    origin: { kind: "new" },
    source: FLOW,
  });
  await coordinator.mutate({
    op: "draft.save",
    operationId: id(2),
    draftId,
    expectedDraftRevision: 1,
    source: FLOW.replace("Client", "Later"),
  });
  const sent = await coordinator.mutate({ op: "draft.send", operationId: id(3), draftId, draftRevision: 1 });
  const duplicate = await coordinator.mutate({ op: "draft.send", operationId: id(4), draftId, draftRevision: 1 });
  expect(duplicate).toMatchObject({
    outcome: "no_effect",
    review: { state: "queued", changeId: sent.review!.changeId },
  });
  const records = changes.pending(root, { limit: 10 }).records;
  expect(records).toHaveLength(1);
  expect(changes.readSnapshot(root, records[0]!.changeId, "after")?.toString()).toBe(FLOW);
});
test("proposal identical to immutable document base saves privately without a pending or manual review admission", async () => {
  const { coordinator, changes, root } = setup("on_save"),
    opened = coordinator.open({ kind: "view", viewId: "a" });
  const saved = await coordinator.mutate({
    op: "draft.save",
    operationId: id(),
    draftId,
    expectedDraftRevision: null,
    origin: {
      kind: "document",
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
    },
    source: opened.source,
  });
  expect(saved).toMatchObject({ outcome: "saved", review: { state: "not_queued_no_effect" } });
  const sent = await coordinator.mutate({ op: "draft.send", operationId: id(2), draftId, draftRevision: 1 });
  expect(sent).toMatchObject({ outcome: "no_effect", review: { state: "not_queued_no_effect" } });
  expect(changes.pending(root, { limit: 10 }).records).toHaveLength(0);
});

test("in-project authoring-folder alias preserves canonical physical project-relative identity on Apply and Publish", async () => {
  const { coordinator, root } = setup();
  renameSync(join(root, ".archer"), join(root, "real-authoring"));
  symlinkSync(join(root, "real-authoring"), join(root, ".archer"));
  const opened = coordinator.open({ kind: "view", viewId: "a" });
  expect(opened.path).toBe("real-authoring/a.mmd");
  const applied = await coordinator.mutate({
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedSourceRevision: opened.sourceRevision,
    expectedTargetRevision: opened.targetRevision,
    source: FLOW.replace("Client", "Changed"),
  });
  expect(applied.document?.path).toBe("real-authoring/a.mmd");
  const published = await coordinator.mutate({
    op: "document.publish",
    operationId: id(2),
    path: "diagrams/new.mmd",
    source: FLOW,
  });
  expect(published.document?.path).toBe("real-authoring/diagrams/new.mmd");
  expect(readFileSync(join(root, "real-authoring/diagrams/new.mmd"), "utf8")).toBe(FLOW);
});
test("embedded normalization disclosure distinguishes actual identity pinning from line-ending changes", async () => {
  const { coordinator, root } = setup();
  writeFileSync(join(root, ".archer/n.md"), "# Flow\n```mermaid\nflowchart LR\na[A]\n```\n");
  const opened = coordinator.open({ kind: "embedded", address: "n.md#flow" }),
    source = 'flowchart LR\na["%% archer-id: flow"]\n';
  const applied = await coordinator.mutate({
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedSourceRevision: opened.sourceRevision,
    expectedTargetRevision: opened.targetRevision,
    source,
  });
  expect(applied.document?.normalized).toEqual({ pinnedName: true, lineEndings: false });
  expect(readFileSync(join(root, ".archer/n.md"), "utf8")).toContain("%% archer-id: flow\n" + source);
});
// O84 (claude-03): the conflict banner's "Save as a proposal privately" after an external write. The proposal keeps the
// base the person opened (ADR 0025: immutable original base bytes; ADR 0027: never rebased to an intervening external
// write), proven by the opened bytes' revision, is reported diverged, and never touches the file.
test("a proposal saved after an external write keeps the opened base, is diverged and leaves the file alone", async () => {
  const { coordinator, store, root } = setup();
  const opened = coordinator.open({ kind: "view", viewId: "a" });
  const external = FLOW.replace("Client", "External");
  writeFileSync(join(root, ".archer/a.mmd"), external);
  const mine = FLOW.replace("Client", "Mine"),
    origin = {
      kind: "document",
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
    } as const;
  await expect(
    coordinator.mutate({
      op: "draft.save",
      operationId: id(1),
      draftId,
      expectedDraftRevision: null,
      origin,
      source: mine,
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await expect(
    coordinator.mutate({
      op: "draft.save",
      operationId: id(2),
      draftId,
      expectedDraftRevision: null,
      origin: { ...origin, baseSource: opened.source.replace("Client", "Forged") },
      source: mine,
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(store.getDraft(root, draftId)).toBeNull();
  const saved = await coordinator.mutate({
    op: "draft.save",
    operationId: id(3),
    draftId,
    expectedDraftRevision: null,
    origin: { ...origin, baseSource: opened.source },
    source: mine,
  });
  expect(saved).toMatchObject({ state: "terminal", outcome: "saved", draft: { draftId, draftRevision: 1 } });
  const draft = store.getDraft(root, draftId)!;
  expect(draft.origin).toMatchObject({
    kind: "document",
    path: ".archer/a.mmd",
    baseSourceRevision: opened.sourceRevision,
  });
  expect(draft.origin.kind === "document" && store.readSnapshot(draft.origin.base).toString()).toBe(opened.source);
  expect(coordinator.snapshot(draftId, 1).source).toBe(mine);
  expect(readFileSync(join(root, ".archer/a.mmd"), "utf8")).toBe(external);
  const listed = coordinator.status().drafts[0]!;
  expect(listed.origin).toMatchObject({ kind: "document", baseSourceRevision: opened.sourceRevision, diverged: true });
  expect(listed.origin.target).toBeUndefined();
});
test("a proposal saved on the current base is not diverged", async () => {
  const { coordinator } = setup();
  const opened = coordinator.open({ kind: "view", viewId: "a" });
  await coordinator.mutate({
    op: "draft.save",
    operationId: id(),
    draftId,
    expectedDraftRevision: null,
    origin: {
      kind: "document",
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
      baseSource: opened.source,
    },
    source: FLOW.replace("Client", "Mine"),
  });
  expect(coordinator.status().drafts[0]!.origin).toMatchObject({ diverged: false, target: opened.target });
});
