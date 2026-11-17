import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import {
  AuthoringStore,
  AuthoringStoreError,
  parseAuthoringIndex,
  type JournalIntent,
  type JournalCompletion,
} from "../../src/authoring/store.ts";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function state() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-authoring-journal-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
const make = (stateDir = state(), epoch = "a".repeat(32)) =>
  new AuthoringStore({ stateDir, serviceName: "main", epoch, assertOwner() {} });
function intent(s: AuthoringStore, n = 1): JournalIntent {
  return {
    operationId: n.toString(16).padStart(32, "0"),
    payloadDigest: "sha256:" + "b".repeat(64),
    op: "document.apply",
    projectRoot: "/projects/one",
    authority: { grantId: "grant-one", entitlementId: "ent-one" },
    feedback: { changes: "on_save", delivery: "next_call", effectiveRevision: "sha256:" + "c".repeat(64) },
    target: { kind: "document", path: ".archer/a.mmd" },
    expected: { sourceRevision: "sha256:" + "d".repeat(64) },
    base: s.putSnapshot(Buffer.from("before")),
    candidate: s.putSnapshot(Buffer.from("after")),
    intent: "Check the API connection",
  };
}
const completion = (): JournalCompletion => ({
  outcome: "applied",
  document: { path: ".archer/a.mmd", sourceRevision: "sha256:" + "e".repeat(64), modelRevision: null },
  evidence: "observed",
  review: { mode: "on_save", configRevision: "sha256:" + "c".repeat(64), state: "admission_pending" },
});
function code(expected: string, f: () => unknown) {
  try {
    f();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthoringStoreError);
    expect((error as AuthoringStoreError).code).toBe(expected);
    return;
  }
  throw new Error("expected " + expected);
}
test("durable intent precedes terminal receipt; global replay preserves immutable input and outcome", () => {
  const root = state(),
    s = make(root),
    request = intent(s),
    first = s.beginOperation(request);
  expect(first.kind).toBe("begun");
  expect(first.record.state).toBe("intent");
  expect(make(root).getOperation(request.operationId)).toEqual(first.record);
  expect(s.beginOperation(request)).toEqual({ kind: "replayed", record: first.record });
  for (const change of [
    { payloadDigest: "sha256:" + "f".repeat(64) },
    { projectRoot: "/projects/other" },
    { authority: { grantId: "other", entitlementId: "ent-one" } },
    { intent: "different intent" },
    { expected: { sourceRevision: null } },
  ])
    code("authoring_operation_mismatch", () => s.beginOperation({ ...request, ...change }));
  const done = s.completeOperation(request.operationId, request.payloadDigest, completion());
  expect(done.state).toBe("terminal");
  expect(s.completeOperation(request.operationId, request.payloadDigest, completion())).toEqual(done);
  expect(s.beginOperation(request).record).toEqual(done);
  code("authoring_operation_mismatch", () =>
    s.completeOperation(request.operationId, request.payloadDigest, { ...completion(), outcome: "unchanged" }),
  );
  expect(make(root, "z".repeat(32).replaceAll("z", "0")).getOperation(request.operationId)).toEqual(done);
  const copy = s.getOperation(request.operationId)!;
  (
    copy.authority as {
      grantId: string;
    }
  ).grantId = "mutated";
  expect(s.getOperation(request.operationId)!.authority.grantId).toBe("grant-one");
});
test("old-epoch unfinished intents become uncertain without any effect, and never replay on begin", () => {
  const root = state(),
    s = make(root),
    request = intent(s);
  s.beginOperation(request);
  const recovered = make(root, "b".repeat(32)),
    op = recovered.getOperation(request.operationId)!;
  expect(op.state).toBe("uncertain");
  expect(op.candidate).toEqual(request.candidate);
  expect(op.base).toEqual(request.base);
  expect(recovered.beginOperation(request)).toEqual({ kind: "replayed", record: op });
  code("authoring_operation_uncertain", () =>
    recovered.completeOperation(request.operationId, request.payloadDigest, completion()),
  );
  const disk = parseAuthoringIndex(readFileSync(join(root, "runtime/authoring/index.json")));
  expect(disk.operations[0]!.state).toBe("uncertain");
});
test("terminal admission may advance once from pending to queued while source outcome stays immutable", () => {
  const s = make(),
    request = intent(s);
  s.beginOperation(request);
  const original = s.completeOperation(request.operationId, request.payloadDigest, completion());
  const queued = { ...completion().review, state: "queued" as const, changeId: "chg_" + "1".repeat(32) };
  const done = s.updateOperationReview(request.operationId, request.payloadDigest, queued);
  expect(done.state).toBe("terminal");
  if (done.state !== "terminal" || original.state !== "terminal") throw new Error("expected terminal");
  expect(done.completion).toEqual({ ...original.completion, review: queued });
  expect(s.updateOperationReview(request.operationId, request.payloadDigest, queued)).toEqual(done);
  code("authoring_operation_mismatch", () =>
    s.updateOperationReview(request.operationId, request.payloadDigest, {
      ...queued,
      changeId: "chg_" + "2".repeat(32),
    }),
  );
  code("authoring_operation_mismatch", () =>
    s.updateOperationReview(request.operationId, request.payloadDigest, completion().review),
  );
});
test.each(["inferred_confirmed", "abandoned"] as const)(
  "explicit uncertain resolution records %s without relabelling a sourceeffect",
  (evidence) => {
    const root = state(),
      first = make(root),
      request = intent(first);
    first.beginOperation(request);
    const s = make(root, "b".repeat(32));
    const resolved: JournalCompletion = {
      outcome: "resolved",
      evidence,
      current: {
        observed: evidence === "inferred_confirmed" ? "matches_candidate" : "diverged",
        sourceRevision: evidence === "inferred_confirmed" ? "sha256:" + "f".repeat(64) : "sha256:" + "a".repeat(64),
        contentRevision: evidence === "inferred_confirmed" ? request.candidate!.revision : request.base!.revision,
        inferred: true,
      },
      review: { ...completion().review, state: "not_queued_no_effect" },
    };
    const result = s.resolveOperation(request.operationId, request.payloadDigest, resolved);
    expect(result.state).toBe("terminal");
    if (result.state !== "terminal") throw new Error("not terminal");
    expect(result.completion.outcome).toBe("resolved");
    expect(result.target).toEqual(request.target);
    expect(result.base).toEqual(request.base);
    expect(result.candidate).toEqual(request.candidate);
    expect(s.resolveOperation(request.operationId, request.payloadDigest, resolved)).toEqual(result);
    code("authoring_operation_mismatch", () =>
      s.completeOperation(request.operationId, request.payloadDigest, completion()),
    );
  },
);
test("uncertain confirmation requires an exact candidate observation and cannot claim an applied effect", () => {
  const root = state(),
    first = make(root),
    request = intent(first);
  first.beginOperation(request);
  const s = make(root, "b".repeat(32));
  const wrong: JournalCompletion = {
    outcome: "resolved",
    evidence: "inferred_confirmed",
    current: {
      observed: "matches_base",
      sourceRevision: request.base!.revision,
      contentRevision: request.base!.revision,
      inferred: true,
    },
    review: { ...completion().review, state: "not_queued_no_effect" },
  };
  code("authoring_store_invalid", () => s.resolveOperation(request.operationId, request.payloadDigest, wrong));
  code("authoring_store_invalid", () =>
    s.resolveOperation(request.operationId, request.payloadDigest, { ...wrong, outcome: "applied" }),
  );
  code("authoring_store_invalid", () =>
    s.resolveOperation(request.operationId, request.payloadDigest, {
      ...wrong,
      current: {
        observed: "matches_candidate",
        sourceRevision: request.candidate!.revision,
        contentRevision: request.base!.revision,
        inferred: true,
      },
    }),
  );
  expect(s.getOperation(request.operationId)!.state).toBe("uncertain");
});
test("begin refuses unpersisted references, malformed exact fields and invalid target matrix", () => {
  const s = make(),
    request = intent(s);
  for (const changed of [
    { extra: true },
    { target: { kind: "document", path: "../bad" } },
    { feedback: { ...request.feedback, secret: "bad" } },
    { target: { kind: "draft", draftId: "drf_" + "a".repeat(32) } },
  ])
    code("authoring_store_invalid", () => s.beginOperation({ ...request, ...changed } as JournalIntent));
  expect(() => s.beginOperation({ ...request, candidate: { revision: "sha256:" + "0".repeat(64), bytes: 1 } })).toThrow(
    AuthoringStoreError,
  );
  code("authoring_store_unavailable", () => s.status());
});
test("unknown operation probe is null and persisted terminal receipt rejects arbitrary JSON fields", () => {
  const root = state(),
    s = make(root),
    request = intent(s);
  expect(s.getOperation("f".repeat(32))).toBe(null);
  s.beginOperation(request);
  s.completeOperation(request.operationId, request.payloadDigest, completion());
  const p = join(root, "runtime/authoring/index.json"),
    raw = JSON.parse(readFileSync(p, "utf8"));
  raw.operations[0].completion.document.secret = "no";
  writeFileSync(p, JSON.stringify(raw), { mode: 0o600 });
  code("authoring_store_invalid", () => make(root));
});
test("global operation quota allows exact replay at capacity and refuses a new identity without pruning", () => {
  const root = state(),
    s = make(root),
    request = intent(s),
    seed = s.beginOperation(request).record,
    p = join(root, "runtime/authoring/index.json"),
    raw = JSON.parse(readFileSync(p, "utf8"));
  raw.operations = Array.from({ length: 4096 }, (_, i) => ({
    ...seed,
    operationId: (i + 1).toString(16).padStart(32, "0"),
  }));
  const encoded = Buffer.from(JSON.stringify(raw));
  expect(parseAuthoringIndex(encoded).operations).toHaveLength(4096);
  writeFileSync(p, encoded, { mode: 0o600 });
  const full = make(root);
  expect(full.beginOperation(request).kind).toBe("replayed");
  code("authoring_store_capacity", () => full.beginOperation({ ...request, operationId: "f".repeat(32) }));
  expect(full.getOperation("0".repeat(31) + "1")).not.toBe(null);
});
test("live epoch uncertainty is durable, idempotent and explicitly resolved without completion laundering", () => {
  const root = state(),
    s = make(root),
    request = intent(s);
  s.beginOperation(request);
  const uncertain = s.markOperationUncertain(request.operationId, request.payloadDigest);
  expect(uncertain.state).toBe("uncertain");
  expect(s.markOperationUncertain(request.operationId, request.payloadDigest)).toEqual(uncertain);
  expect(make(root).getOperation(request.operationId)?.state).toBe("uncertain");
  code("authoring_operation_uncertain", () =>
    s.completeOperation(request.operationId, request.payloadDigest, completion()),
  );
  const resolved = s.resolveOperation(request.operationId, request.payloadDigest, {
    outcome: "resolved",
    evidence: "abandoned",
    current: { observed: "missing", sourceRevision: null, contentRevision: null, inferred: true },
    review: { ...completion().review, state: "not_queued_no_effect" },
  });
  expect(resolved.state).toBe("terminal");
  code("authoring_operation_mismatch", () => s.markOperationUncertain(request.operationId, request.payloadDigest));
});
test("uncertain cannot be stored as a terminal completion outcome", () => {
  const s = make(),
    request = intent(s);
  s.beginOperation(request);
  code("authoring_store_invalid", () =>
    s.completeOperation(request.operationId, request.payloadDigest, { ...completion(), outcome: "uncertain" as never }),
  );
  expect(s.getOperation(request.operationId)?.state).toBe("intent");
});

test("project operation history is isolated, copied, durable and owner guarded", () => {
  const root = state();
  let active = true;
  const s = new AuthoringStore({
    stateDir: root,
    serviceName: "main",
    epoch: "a".repeat(32),
    assertOwner() {
      if (!active) throw new Error("closed");
    },
  });
  const first = intent(s),
    second = { ...intent(s, 2), projectRoot: "/projects/two" };
  s.beginOperation(first);
  s.beginOperation(second);
  expect(s.listOperations(first.projectRoot).map((x) => x.operationId)).toEqual([first.operationId]);
  const copy = s.listOperations(first.projectRoot);
  (copy[0]!.authority as { grantId: string }).grantId = "changed";
  expect(s.getOperation(first.operationId)!.authority.grantId).toBe("grant-one");
  expect(
    make(root)
      .listOperations(second.projectRoot)
      .map((x) => x.operationId),
  ).toEqual([second.operationId]);
  expect(s.listOperations("/projects/empty")).toEqual([]);
  active = false;
  expect(() => s.listOperations(first.projectRoot)).toThrow("closed");
});
