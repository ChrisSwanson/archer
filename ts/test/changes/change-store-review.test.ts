import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CHANGE_STORE_LIMITS, ChangeStore, parseChangeIndex } from "../../src/changes/index.ts";
import { withChangeStoreIo } from "../../src/changes/io.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function setup(hook?: ConstructorParameters<typeof ChangeStore>[0]["onCommitStep"]) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "archer-review-")));
  chmodSync(stateDir, 0o700);
  roots.push(stateDir);
  const store = new ChangeStore({
    stateDir,
    serviceName: "main",
    assertOwner() {},
    now: () => Date.parse("2026-10-18T12:00:00.000Z"),
    ...(hook ? { onCommitStep: hook } : {}),
  });
  const input = {
    operationId: "1".repeat(32),
    projectRoot: "/projects/one",
    format: "mermaid" as const,
    origin: "browser_editor" as const,
    target: { kind: "draft" as const, id: "draft1" },
    eventKind: "draft.saved" as const,
    before: null,
    after: Buffer.from("flowchart LR\n a[A]\n"),
  };
  const record = store.admit(input).record;
  const indexPath = join(stateDir, "runtime/change-review/index.json");
  return { store, input, record, stateDir, indexPath };
}

test.each([
  ["handled", "agent"],
  ["declined", "agent"],
  ["withdrawn", "browser"],
] as const)("%s is a persisted shared CAS transition with immutable contents", (disposition, actor) => {
  const { store, record, input, stateDir, indexPath } = setup();
  expect(JSON.parse(readFileSync(indexPath, "utf8")).version).toBe(1);
  const result = store.resolveReview(input.projectRoot, record.changeId, 1, disposition, actor);
  expect(result).toEqual({
    ...record,
    disposition,
    reviewRevision: 2,
    resolvedAt: "2026-10-18T12:00:00.000Z",
    resolvedBy: actor,
  });
  expect(store.readSnapshot(input.projectRoot, record.changeId, "after")).toEqual(input.after);
  expect(store.pending(input.projectRoot, { limit: 10 }).records).toEqual([]);
  const reopened = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  expect(reopened.get(input.projectRoot, record.changeId)).toEqual(result);
  expect(parseChangeIndex(readFileSync(indexPath)).version).toBe(2);
  expect(store.resolveReview(input.projectRoot, record.changeId, 2, disposition, actor)).toEqual(result);
});

test("stale, cross-project, invalid actor and terminal replacement refuse without changing authority", () => {
  const { store, record, input, indexPath } = setup();
  const before = readFileSync(indexPath);
  expect(() => store.resolveReview(input.projectRoot, record.changeId, 2, "handled", "agent")).toThrowError(
    expect.objectContaining({ code: "change_review_conflict" }),
  );
  expect(() => store.resolveReview("/projects/other", record.changeId, 1, "handled", "agent")).toThrowError(
    expect.objectContaining({ code: "change_not_found" }),
  );
  expect(() => store.resolveReview(input.projectRoot, record.changeId, 1, "withdrawn", "agent")).toThrowError(
    expect.objectContaining({ code: "change_review_invalid" }),
  );
  expect(readFileSync(indexPath)).toEqual(before);
  store.resolveReview(input.projectRoot, record.changeId, 1, "handled", "agent");
  const terminal = readFileSync(indexPath);
  expect(() => store.resolveReview(input.projectRoot, record.changeId, 1, "handled", "agent")).toThrowError(
    expect.objectContaining({ code: "change_review_conflict" }),
  );
  expect(() => store.resolveReview(input.projectRoot, record.changeId, 2, "declined", "agent")).toThrowError(
    expect.objectContaining({ code: "change_review_terminal" }),
  );
  expect(readFileSync(indexPath)).toEqual(terminal);
});

test("resolution frees pending capacity without removing history or changing replay identity", () => {
  const { store, input, record, stateDir } = setup();
  const limits = CHANGE_STORE_LIMITS as { -readonly [K in keyof typeof CHANGE_STORE_LIMITS]: number };
  const original = limits.pendingPerProject;
  limits.pendingPerProject = 1;
  try {
    expect(() => store.admit({ ...input, operationId: "2".repeat(32) })).toThrowError(
      expect.objectContaining({ code: "change_store_capacity" }),
    );
    const handled = store.resolveReview(input.projectRoot, record.changeId, 1, "handled", "agent");
    const next = store.admit({ ...input, operationId: "2".repeat(32) }).record;
    expect(next.sequence).toBe(2);
    expect(store.admit(input)).toEqual({ kind: "replayed", record: handled });
    const reopened = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
    expect(reopened.get(input.projectRoot, record.changeId)).toEqual(handled);
    expect(reopened.pending(input.projectRoot, { limit: 10 }).records.map((r) => r.changeId)).toEqual([next.changeId]);
  } finally {
    limits.pendingPerProject = original;
  }
});

test("v2 authority validates terminal metadata and rejects terminal records in v1", () => {
  const { store, input, record, indexPath } = setup();
  store.resolveReview(input.projectRoot, record.changeId, 1, "handled", "agent");
  const valid = JSON.parse(readFileSync(indexPath, "utf8"));
  for (const mutate of [
    (x: typeof valid) => {
      x.version = 1;
    },
    (x: typeof valid) => {
      x.records[0].disposition = { toString: null };
    },
    (x: typeof valid) => {
      delete x.records[0].resolvedAt;
    },
    (x: typeof valid) => {
      x.records[0].resolvedBy = "someone";
    },
    (x: typeof valid) => {
      x.records[0].reviewRevision = 1;
    },
    (x: typeof valid) => {
      x.records[0].resolvedAt = "not-a-date";
    },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    expect(() => parseChangeIndex(Buffer.from(JSON.stringify(changed)))).toThrowError(
      expect.objectContaining({ code: "change_store_invalid" }),
    );
  }
});

test("failed review publication preserves old authority; post-publication failure is uncertain", () => {
  let armed: "before" | "after" | null = null;
  const { store, input, record, indexPath } = setup((step) => {
    if (armed === "before" && step === "before_index_rename") throw new Error("injected before publish");
    if (armed === "after" && step === "after_index_rename") throw new Error("injected after publish");
  });
  const before = readFileSync(indexPath);
  armed = "before";
  expect(() => store.resolveReview(input.projectRoot, record.changeId, 1, "handled", "agent")).toThrowError(
    expect.objectContaining({ code: "change_store_io" }),
  );
  expect(readFileSync(indexPath)).toEqual(before);
  armed = "after";
  expect(() => store.resolveReview(input.projectRoot, record.changeId, 1, "handled", "agent")).toThrowError(
    expect.objectContaining({ code: "change_store_uncertain" }),
  );
  armed = null;
  expect(store.get(input.projectRoot, record.changeId)).toMatchObject({ disposition: "handled", reviewRevision: 2 });
});

test("review index publication reserves transient physical capacity before changing authority", () => {
  const { store, input, record, stateDir, indexPath } = setup();
  const before = readFileSync(indexPath);
  const used = withChangeStoreIo(stateDir, (io) =>
    io.inventory({
      entries: CHANGE_STORE_LIMITS.directoryEntries,
      physicalBytes: CHANGE_STORE_LIMITS.physicalBytes,
      snapshotBytes: CHANGE_STORE_LIMITS.snapshotBytes,
    }),
  ).physicalBytes;
  const limits = CHANGE_STORE_LIMITS as { -readonly [K in keyof typeof CHANGE_STORE_LIMITS]: number };
  const original = limits.physicalBytes;
  limits.physicalBytes = used;
  try {
    expect(() => store.resolveReview(input.projectRoot, record.changeId, 1, "handled", "agent")).toThrowError(
      expect.objectContaining({ code: "change_store_capacity" }),
    );
    expect(readFileSync(indexPath)).toEqual(before);
    expect(store.get(input.projectRoot, record.changeId)?.disposition).toBe("pending");
  } finally {
    limits.physicalBytes = original;
  }
});

test("an identical terminal retry confirms the durability barrier before acknowledging", () => {
  let stepToFail: string | null = null;
  const { store, input, record } = setup((step) => {
    if (step === stepToFail) throw new Error("injected sync barrier");
  });
  stepToFail = "after_index_rename";
  expect(() => store.resolveReview(input.projectRoot, record.changeId, 1, "handled", "agent")).toThrowError(
    expect.objectContaining({ code: "change_store_uncertain" }),
  );
  stepToFail = "before_uncertain_replay_sync";
  expect(() => store.resolveReview(input.projectRoot, record.changeId, 2, "handled", "agent")).toThrowError(
    expect.objectContaining({ code: "change_store_uncertain" }),
  );
  stepToFail = null;
  expect(store.resolveReview(input.projectRoot, record.changeId, 2, "handled", "agent")).toMatchObject({
    disposition: "handled",
    reviewRevision: 2,
  });
});
