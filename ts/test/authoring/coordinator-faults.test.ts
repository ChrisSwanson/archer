import { chmodSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AuthoringCoordinator, type AuthoringCoordinatorOptions } from "../../src/authoring/coordinator.ts";
import { AuthoringStore } from "../../src/authoring/store.ts";
import { ChangeStore } from "../../src/changes/index.ts";
import { findProject } from "../../src/project/project.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import { resolveFeedbackConfiguration } from "../../src/config/feedback-resolution.ts";
import { blockWriters, FLOW, removeTempDirs, tempDir } from "../project/support.ts";
afterEach(removeTempDirs);
const id = (n = 1) => n.toString(16).padStart(32, "0");
function fixture(embedded = false) {
  const note = "# Flow\r\n```mermaid\r\nflowchart LR\r\na[A]\r\n```\r\nTail";
  const root = tempDir({
    "archer.toml": 'version = 1\n[feedback]\nchanges = "on_save"\n',
    ".archer/a.mmd": FLOW,
    ...(embedded ? { ".archer/n.md": note } : {}),
  });
  const state = tempDir();
  chmodSync(state, 0o700);
  let terminalFault = false,
    admissionFault = false,
    terminalStep = "before_index_publish";
  const original = embedded ? note : FLOW;
  const destination = join(root, embedded ? ".archer/n.md" : ".archer/a.mmd");
  const storeOptions = {
    stateDir: state,
    serviceName: "main",
    assertOwner() {},
    onCommitStep(step: string) {
      if (terminalFault && step === terminalStep && readFileSync(destination, "utf8") !== original)
        throw new Error("terminal journal fault");
    },
  };
  const store = new AuthoringStore(storeOptions),
    changes = new ChangeStore({
      stateDir: state,
      serviceName: "main",
      assertOwner() {},
      onCommitStep(step) {
        if (admissionFault && step === "before_index_rename") throw new Error("review admission fault");
      },
    });
  const options: AuthoringCoordinatorOptions = {
    store,
    changes,
    project: () => findProject(root),
    authority: () => ({ grantId: "g", entitlementId: "e" }),
    feedback: (project) => {
      const f = resolveFeedbackConfiguration({ user: {} as never, project, serviceName: "main" });
      return { changes: f.changes, delivery: f.delivery, effectiveRevision: f.revision };
    },
  };
  return {
    root,
    state,
    destination,
    store,
    changes,
    storeOptions,
    options,
    coordinator: new AuthoringCoordinator(options),
    terminalFault(value: boolean, step = "before_index_publish") {
      terminalFault = value;
      terminalStep = step;
    },
    admissionFault(value: boolean) {
      admissionFault = value;
    },
  };
}
test("source completion and cumulative tracking are atomic and independent from legacy admission failure", async () => {
  const f = fixture();
  f.admissionFault(true);
  const opened = f.coordinator.open({ kind: "view", viewId: "a" });
  const request = {
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedSourceRevision: opened.sourceRevision,
    expectedTargetRevision: opened.targetRevision,
    source: FLOW.replace("Client", "Changed"),
  } as const;
  const pending = await f.coordinator.mutate(request);
  expect(pending).toMatchObject({ state: "terminal", outcome: "applied", review: { state: "tracked" } });
  expect(f.store.getOperation(id())).toMatchObject({ state: "terminal", completion: { outcome: "applied" } });
  writeFileSync(f.destination, FLOW.replace("Client", "External"));
  f.admissionFault(false);
  const replay = await f.coordinator.mutate(request);
  expect(replay.review?.state).toBe("tracked");
  expect(readFileSync(f.destination, "utf8")).toContain("External");
  expect(f.changes.pending(f.root, { limit: 10 }).records).toHaveLength(0);
  expect(f.store.listReviews(f.root)).toHaveLength(1);
});
test("unacknowledged terminal journal after publication restarts uncertain and explicit resolution never rewrites source", async () => {
  const f = fixture();
  f.terminalFault(true);
  const opened = f.coordinator.open({ kind: "view", viewId: "a" }),
    source = FLOW.replace("Client", "Changed");
  const request = {
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedSourceRevision: opened.sourceRevision,
    expectedTargetRevision: opened.targetRevision,
    source,
  } as const;
  await expect(f.coordinator.mutate(request)).rejects.toMatchObject({
    code: "authoring_operation_uncertain",
    operationId: id(),
  });
  expect(readFileSync(f.destination, "utf8")).toBe(source);
  f.terminalFault(false);
  const store = new AuthoringStore(f.storeOptions),
    restarted = new AuthoringCoordinator({ ...f.options, store });
  expect(restarted.operation(id())).toMatchObject({
    state: "uncertain",
    current: {
      observed: "matches_candidate",
      inferred: true,
      sourceRevision: revisionOf(Buffer.from(source)),
      contentRevision: revisionOf(Buffer.from(source)),
    },
  });
  expect(await restarted.mutate(request)).toMatchObject({ state: "uncertain" });
  writeFileSync(f.destination, FLOW);
  expect(restarted.operation(id())?.current?.observed).toBe("matches_base");
  writeFileSync(f.destination, "external");
  expect(restarted.operation(id())?.current?.observed).toBe("diverged");
  await expect(
    restarted.mutate({
      op: "operation.resolve_uncertain",
      operationId: id(2),
      targetOperationId: id(),
      resolution: "confirm_candidate",
    }),
  ).rejects.toMatchObject({ code: "authoring_resolution_conflict" });
  unlinkSync(f.destination);
  expect(restarted.operation(id())?.current?.observed).toBe("missing");
  writeFileSync(f.destination, source);
  await expect(
    restarted.mutate({
      op: "operation.resolve_uncertain",
      operationId: id(4),
      targetOperationId: id(),
      resolution: "abandon",
    }),
  ).rejects.toMatchObject({ code: "authoring_resolution_conflict" });
  const freshlyOpened = restarted.open({ kind: "view", viewId: "a" });
  await expect(
    restarted.mutate({
      op: "document.apply",
      operationId: id(5),
      target: freshlyOpened.target,
      expectedSourceRevision: freshlyOpened.sourceRevision,
      expectedTargetRevision: freshlyOpened.targetRevision,
      source: source.replace("Changed", "Again"),
    }),
  ).rejects.toMatchObject({ code: "authoring_reconcile_required" });
  expect(readFileSync(f.destination, "utf8")).toBe(source);
  const before = statSync(f.destination);
  const resolved = await restarted.mutate({
    op: "operation.resolve_uncertain",
    operationId: id(3),
    targetOperationId: id(),
    resolution: "confirm_candidate",
  });
  expect(resolved).toMatchObject({
    outcome: "resolved",
    evidence: "inferred_confirmed",
    review: { state: "tracked", reviewRevision: 1 },
  });
  expect(store.listReviews(f.root)).toHaveLength(1);
  expect(statSync(f.destination).ino).toBe(before.ino);
  expect(statSync(f.destination).mtimeMs).toBe(before.mtimeMs);
  expect(restarted.operation(id())).toMatchObject({
    state: "terminal",
    outcome: "resolved",
    evidence: "inferred_confirmed",
  });
});
test("embedded journal captures actual normalized candidate and probe distinguishes salted CAS from blob content hash", async () => {
  const f = fixture(true);
  const opened = f.coordinator.open({ kind: "embedded", address: "n.md#flow" });
  expect(opened.sourceRevision).not.toBe(revisionOf(Buffer.from(opened.source)));
  f.terminalFault(true);
  await expect(
    f.coordinator.mutate({
      op: "document.apply",
      operationId: id(),
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
      source: FLOW,
    }),
  ).rejects.toMatchObject({ code: "authoring_operation_uncertain" });
  f.terminalFault(false);
  const store = new AuthoringStore(f.storeOptions),
    restarted = new AuthoringCoordinator({ ...f.options, store }),
    record = store.getOperation(id())!;
  expect(record.target).toEqual({ kind: "document", path: ".archer/n.md", blockId: "flow" });
  expect(store.readSnapshot(record.candidate!).toString()).toContain("%% archer-id: flow\r\n");
  expect(restarted.operation(id())?.current?.observed).toBe("matches_candidate");
  const original = "# Flow\r\n```mermaid\r\nflowchart LR\r\na[A]\r\n```\r\nTail";
  writeFileSync(f.destination, original);
  const probe = restarted.operation(id())!.current!;
  expect(probe.observed).toBe("matches_base");
  expect(probe.sourceRevision).not.toBe(probe.contentRevision);
  expect(probe.contentRevision).toBe(record.base!.revision);
  await restarted.mutate({
    op: "operation.resolve_uncertain",
    operationId: id(2),
    targetOperationId: id(),
    resolution: "abandon",
  });
  expect(readFileSync(f.destination, "utf8")).toBe(original);
});
test("source_busy before writer callback has no journaled effect and current source remains unchanged", async () => {
  const f = fixture(),
    opened = f.coordinator.open({ kind: "view", viewId: "a" });
  blockWriters(findProject(f.root), "a.mmd");
  await expect(
    f.coordinator.mutate({
      op: "document.apply",
      operationId: id(),
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
      source: FLOW.replace("Client", "Changed"),
    }),
  ).rejects.toMatchObject({ code: "source_busy" });
  expect(f.store.getOperation(id())).toBeNull();
  expect(readFileSync(f.destination, "utf8")).toBe(FLOW);
});

test("visible terminal index with unacknowledged sync recovers terminal and cumulative review together", async () => {
  const f = fixture(),
    opened = f.coordinator.open({ kind: "view", viewId: "a" });
  f.terminalFault(true, "after_index_publish");
  const request = {
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedSourceRevision: opened.sourceRevision,
    expectedTargetRevision: opened.targetRevision,
    source: FLOW.replace("Client", "Changed"),
  } as const;
  await expect(f.coordinator.mutate(request)).rejects.toMatchObject({ code: "authoring_operation_uncertain" });
  f.terminalFault(false);
  writeFileSync(f.destination, FLOW.replace("Client", "External after restart"));
  const store = new AuthoringStore(f.storeOptions),
    restarted = new AuthoringCoordinator({ ...f.options, store });
  expect(restarted.operation(id())).toMatchObject({
    state: "terminal",
    outcome: "applied",
    review: { state: "tracked" },
  });
  const replay = await restarted.mutate(request);
  expect(replay.review?.state).toBe("tracked");
  expect(readFileSync(f.destination, "utf8")).toContain("External after restart");
  expect(f.changes.pending(f.root, { limit: 10 }).records).toHaveLength(0);
  expect(store.listReviews(f.root)).toHaveLength(1);
});

test("observed source completion does not reauthorize after the canonical effect", async () => {
  const f = fixture();
  let checksAfterWrite = 0;
  const coordinator = new AuthoringCoordinator({
    ...f.options,
    authority: () => {
      if (readFileSync(f.destination, "utf8") !== FLOW) {
        checksAfterWrite++;
        throw new Error("grant revoked after publication");
      }
      return { grantId: "g", entitlementId: "e" };
    },
  });
  const opened = coordinator.open({ kind: "view", viewId: "a" });
  const saved = await coordinator.mutate({
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedTargetRevision: opened.targetRevision,
    expectedSourceRevision: opened.sourceRevision,
    source: FLOW.replace("Client", "Observed"),
  });
  expect(saved).toMatchObject({ state: "terminal", outcome: "applied", evidence: "observed" });
  expect(checksAfterWrite).toBe(0);
  expect(f.store.getOperation(id())?.state).toBe("terminal");
});

test("fresh browser status exposes unfinished subject outside the normal operations page", async () => {
  const f = fixture();
  f.terminalFault(true);
  const opened = f.coordinator.open({ kind: "view", viewId: "a" });
  await expect(
    f.coordinator.mutate({
      op: "document.apply",
      operationId: id(),
      target: opened.target,
      expectedTargetRevision: opened.targetRevision,
      expectedSourceRevision: opened.sourceRevision,
      source: FLOW.replace("Client", "Recovery"),
    }),
  ).rejects.toMatchObject({ code: "authoring_operation_uncertain" });
  f.terminalFault(false);
  const store = new AuthoringStore(f.storeOptions),
    coordinator = new AuthoringCoordinator({ ...f.options, store });
  await coordinator.mutate({
    op: "draft.save",
    operationId: id(2),
    draftId: "drf_" + id(2),
    expectedDraftRevision: null,
    origin: { kind: "new" },
    source: FLOW,
  });
  const status = coordinator.status(1);
  expect(status.operations).toHaveLength(1);
  expect(status.operations[0]!.operationId).toBe(id(2));
  expect(status.unfinishedOperations).toEqual([
    { operationId: id(), state: "uncertain", subject: { path: ".archer/a.mmd" } },
  ]);
  expect(coordinator.operation(id())).toMatchObject({
    subject: { path: ".archer/a.mmd" },
    current: { observed: "matches_candidate" },
  });
});

test("known temporary-file refusal before publication is terminal no-effect, not uncertain", async () => {
  const f = fixture(),
    opened = f.coordinator.open({ kind: "view", viewId: "a" }),
    folder = join(f.root, ".archer");
  f.storeOptions.onCommitStep = (step: string) => {
    if (step === "after_index_publish") chmodSync(folder, 0o500);
  };
  try {
    await expect(
      f.coordinator.mutate({
        op: "document.apply",
        operationId: id(),
        target: opened.target,
        expectedTargetRevision: opened.targetRevision,
        expectedSourceRevision: opened.sourceRevision,
        source: FLOW.replace("Client", "Never written"),
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(readFileSync(f.destination, "utf8")).toBe(FLOW);
    expect(f.store.getOperation(id())).toMatchObject({ state: "terminal", completion: { outcome: "no_effect" } });
    expect(f.store.listReviews(f.root)).toEqual([]);
  } finally {
    chmodSync(folder, 0o700);
  }
});

test("a stale browser journal generation refuses new effects but retained exact replays still work", async () => {
  const f = fixture(),
    opened = f.coordinator.open({ kind: "view", viewId: "a" }),
    generation = f.store.status().generation;
  const request = {
    op: "document.apply",
    operationId: id(),
    journalGeneration: generation,
    target: opened.target,
    expectedTargetRevision: opened.targetRevision,
    expectedSourceRevision: opened.sourceRevision,
    source: FLOW.replace("Client", "Generation bound"),
  } as const;
  const saved = await f.coordinator.mutate(request);
  expect(await f.coordinator.mutate(request)).toEqual(saved);
  expect(f.coordinator.status().usage).toMatchObject({
    operations: { used: 1, limit: 4096 },
    reviews: { used: 1, limit: 1024 },
    savedDraftRevisions: { used: 0, limit: 256 },
    perDraftRevisionLimit: 32,
  });
  const before = readFileSync(f.destination);
  await expect(
    f.coordinator.mutate({
      ...request,
      operationId: id(2),
      journalGeneration: "gen_" + "f".repeat(32),
      expectedSourceRevision: saved.document!.sourceRevision,
      source: FLOW,
    }),
  ).rejects.toMatchObject({ code: "authoring_generation_retired" });
  expect(readFileSync(f.destination)).toEqual(before);
  expect(f.store.getOperation(id(2))).toBeNull();
});

test("unreadable uncertain subjects remain discoverable without blocking unrelated project authoring", async () => {
  const f = fixture(),
    opened = f.coordinator.open({ kind: "view", viewId: "a" });
  f.terminalFault(true);
  const request = {
    op: "document.apply",
    operationId: id(),
    target: opened.target,
    expectedTargetRevision: opened.targetRevision,
    expectedSourceRevision: opened.sourceRevision,
    source: FLOW.replace("Client", "Uncertain"),
  } as const;
  await expect(f.coordinator.mutate(request)).rejects.toMatchObject({ code: "authoring_operation_uncertain" });
  f.terminalFault(false);
  const store = new AuthoringStore(f.storeOptions),
    coordinator = new AuthoringCoordinator({ ...f.options, store });
  const other = join(f.root, ".archer/other.mmd");
  writeFileSync(other, FLOW);
  unlinkSync(f.destination);
  symlinkSync(other, f.destination);
  expect(coordinator.status().operations[0]).toMatchObject({
    state: "uncertain",
    probeUnavailable: true,
    subject: { path: ".archer/a.mmd" },
  });
  expect(coordinator.operation(id())).toMatchObject({ state: "uncertain", probeUnavailable: true });
  expect(await coordinator.mutate(request)).toMatchObject({ state: "uncertain", probeUnavailable: true });
  await expect(
    coordinator.mutate({
      op: "operation.resolve_uncertain",
      operationId: id(2),
      targetOperationId: id(),
      resolution: "abandon",
    }),
  ).rejects.toMatchObject({ code: "authoring_probe_unavailable" });
  expect(store.getOperation(id(2))).toBeNull();
  const independent = coordinator.open({ kind: "view", viewId: "other" });
  expect(
    (
      await coordinator.mutate({
        op: "document.apply",
        operationId: id(3),
        target: independent.target,
        expectedTargetRevision: independent.targetRevision,
        expectedSourceRevision: independent.sourceRevision,
        source: FLOW.replace("Client", "Independent"),
      })
    ).outcome,
  ).toBe("applied");
});
// Snapshot blobs were written while evaluating the journal intent, before the
// re-authorization and replay check inside it: a refused request left orphan
// blobs that count against storage limits forever.
test("a request refused while beginning its journal intent writes no snapshot blobs", async () => {
  const f = fixture();
  let refuse = false;
  const coordinator = new AuthoringCoordinator({
    ...f.options,
    feedback: (project) => {
      if (refuse) throw Object.assign(new Error("feedback policy unavailable"), { code: "invalid_configuration" });
      return f.options.feedback(project);
    },
  });
  const opened = coordinator.open({ kind: "view", viewId: "a" }),
    snapshots = join(f.state, "runtime/authoring/snapshots");
  const blobs = () => {
    try {
      return readdirSync(snapshots).length;
    } catch {
      return 0;
    }
  };
  writeFileSync(f.destination, FLOW.replace("Client", "External"));
  const before = blobs();
  refuse = true;
  // A stale Save takes the conflict path; a document-origin proposal snapshots its base.
  await expect(
    coordinator.mutate({
      op: "document.apply",
      operationId: id(),
      target: opened.target,
      expectedSourceRevision: opened.sourceRevision,
      expectedTargetRevision: opened.targetRevision,
      source: FLOW.replace("Client", "Mine"),
    }),
  ).rejects.toMatchObject({ code: "invalid_configuration" });
  const fresh = coordinator.open({ kind: "view", viewId: "a" });
  await expect(
    coordinator.mutate({
      op: "draft.save",
      operationId: id(2),
      draftId: "drf_" + "a".repeat(32),
      expectedDraftRevision: null,
      origin: {
        kind: "document",
        target: fresh.target,
        expectedSourceRevision: fresh.sourceRevision,
        expectedTargetRevision: fresh.targetRevision,
      },
      source: FLOW.replace("Client", "Proposal"),
    }),
  ).rejects.toMatchObject({ code: "invalid_configuration" });
  expect(blobs()).toBe(before);
  expect(f.store.getOperation(id())).toBeNull();
  expect(f.store.getOperation(id(2))).toBeNull();
});
