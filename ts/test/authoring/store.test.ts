import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import {
  AuthoringStore,
  AuthoringStoreError,
  parseAuthoringIndex,
  parseJournalCompletion,
  AUTHORING_STORE_LIMITS,
  type SaveDraftInput,
} from "../../src/authoring/store.ts";
const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function state() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-authoring-store-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
function store(stateDir = state(), other: Partial<ConstructorParameters<typeof AuthoringStore>[0]> = {}) {
  return new AuthoringStore({ stateDir, serviceName: "main", assertOwner() {}, ...other });
}
const id = (n = 1) => `drf_${n.toString(16).padStart(32, "0")}`;
const input = (n = 1): SaveDraftInput => ({
  projectRoot: "/projects/one",
  draftId: id(n),
  expectedDraftRevision: null,
  origin: { kind: "new", proposedPath: ".archer/diagrams/new.mmd" },
  source: Buffer.from("\ufeffflowchart LR\r\n  a[🌈]\r\n"),
  valid: true,
});
function code(expected: string, action: () => unknown) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthoringStoreError);
    expect((error as AuthoringStoreError).code).toBe(expected);
    return;
  }
  throw new Error(`expected ${expected}`);
}
const indexPath = (root: string) => join(root, "runtime/authoring/index.json");
test("saved exact Unicode/BOM/CRLF source survives restart, head CAS and returned values are isolated", () => {
  const root = state(),
    s = store(root),
    first = s.saveDraft(input());
  expect(first.kind).toBe("saved");
  expect(first.draft.head.source).toEqual({
    revision: "sha256:" + createHash("sha256").update(input().source).digest("hex"),
    bytes: input().source.byteLength,
  });
  expect(s.readSnapshot(first.draft.head.source)).toEqual(input().source);
  expect(existsSync(join(root, "runtime/change-review"))).toBe(false);
  const reopened = store(root);
  expect(reopened.status()).toEqual(s.status());
  expect(reopened.getDraft("/projects/one", id())).toEqual(first.draft);
  expect(reopened.saveDraft({ ...input(), expectedDraftRevision: 1 }).kind).toBe("unchanged");
  const second = reopened.saveDraft({
    ...input(),
    expectedDraftRevision: 1,
    source: Buffer.from("flowchart TD\n  a[changed]\n"),
  });
  expect(second.draft.draftRevision).toBe(2);
  expect(second.draft.revisions).toHaveLength(2);
  expect(reopened.readSnapshot(second.draft.revisions[0]!.source)).toEqual(input().source);
  code("authoring_draft_conflict", () =>
    reopened.saveDraft({ ...input(), expectedDraftRevision: 1, source: Buffer.from("stale") }),
  );
  const output = reopened.getDraft("/projects/one", id())!;
  (
    output.head.source as {
      revision: string;
    }
  ).revision = "corrupt";
  expect(reopened.getDraft("/projects/one", id())!.head.source.revision).toBe(second.draft.head.source.revision);
  expect(reopened.getDraft("/projects/other", id())).toBe(null);
  expect(reopened.listDrafts("/projects/one")).toHaveLength(1);
});
test("proposal origin is immutable and never writes a canonical project source", () => {
  const root = state(),
    s = store(root),
    base = s.putSnapshot(Buffer.from("flowchart LR\n a[A]\n"));
  const proposal: SaveDraftInput = {
    ...input(),
    origin: { kind: "document", path: ".archer/a.mmd", baseSourceRevision: base.revision, base },
  };
  s.saveDraft(proposal);
  code("authoring_draft_mismatch", () =>
    s.saveDraft({ ...proposal, expectedDraftRevision: 1, projectRoot: "/projects/another" }),
  );
  code("authoring_draft_mismatch", () =>
    s.saveDraft({ ...proposal, expectedDraftRevision: 1, origin: { kind: "new" } }),
  );
  code("authoring_draft_mismatch", () =>
    s.saveDraft({
      ...proposal,
      expectedDraftRevision: 1,
      origin: {
        ...proposal.origin,
        kind: "document",
        path: ".archer/retarget.mmd",
        baseSourceRevision: base.revision,
        base,
      },
    }),
  );
  expect(existsSync("/projects/one/.archer/a.mmd")).toBe(false);
});
test("lifecycle CAS retains all saved source and only transitions open to one terminal state", () => {
  const s = store();
  const saved = s.saveDraft(input()).draft;
  code("authoring_draft_conflict", () => s.setDraftState("/projects/one", id(), 2, "discarded"));
  const closed = s.setDraftState("/projects/one", id(), 1, "applied");
  expect(closed.state).toBe("applied");
  expect(closed.revisions).toEqual(saved.revisions);
  expect(s.setDraftState("/projects/one", id(), 1, "applied")).toEqual(closed);
  code("authoring_draft_conflict", () => s.setDraftState("/projects/one", id(), 1, "published"));
  code("authoring_draft_conflict", () =>
    s.saveDraft({ ...input(), expectedDraftRevision: 1, source: Buffer.from("next") }),
  );
});
test("all public methods first check singleton owner, retained handles cannot write", () => {
  let active = true;
  const s = store(state(), {
      assertOwner() {
        if (!active) throw new Error("owner stopped");
      },
    }),
    saved = s.saveDraft(input());
  active = false;
  const calls = [
    () => s.status(),
    () => s.putSnapshot(Buffer.from("x")),
    () => s.readSnapshot(saved.draft.head.source),
    () => s.saveDraft(input()),
    () => s.getDraft("/projects/one", id()),
    () => s.listDrafts("/projects/one"),
    () => s.setDraftState("/projects/one", id(), 1, "discarded"),
    () => s.getOperation("0".repeat(32)),
    () => s.beginOperation({} as never),
    () => s.completeOperation("", "", "" as never),
    () => s.updateOperationReview("", "", "" as never),
    () => s.resolveOperation("", "", "" as never),
    () => s.markOperationUncertain("", ""),
  ];
  for (const call of calls) expect(call).toThrow("owner stopped");
});
test.each(["corrupt", "unknown key", "wrong version", "wrong service", "duplicate draft"] as const)(
  "strict persisted authority refuses %s without reset",
  (kind) => {
    const root = state(),
      s = store(root);
    s.saveDraft(input());
    const before = JSON.parse(readFileSync(indexPath(root), "utf8"));
    if (kind === "unknown key") before.extra = true;
    if (kind === "wrong version") before.version = 2;
    if (kind === "wrong service") before.serviceName = "other";
    if (kind === "duplicate draft") before.drafts.push(before.drafts[0]);
    writeFileSync(indexPath(root), kind === "corrupt" ? "not json" : JSON.stringify(before), { mode: 0o600 });
    code("authoring_store_invalid", () => store(root));
    expect(readFileSync(indexPath(root), "utf8")).toBe(kind === "corrupt" ? "not json" : JSON.stringify(before));
  },
);
test("missing authority initializes only an empty area, never one with snapshots or a temp", () => {
  for (const name of ["snapshots", ".index." + "a".repeat(32) + ".tmp"]) {
    const root = state();
    mkdirSync(join(root, "runtime/authoring"), { recursive: true, mode: 0o700 });
    if (name === "snapshots") mkdirSync(join(root, "runtime/authoring", name), { mode: 0o700 });
    else writeFileSync(join(root, "runtime/authoring", name), "", { mode: 0o600 });
    code("authoring_store_invalid", () => store(root));
    expect(existsSync(indexPath(root))).toBe(false);
  }
});
test("observed external authority change permanently latches handle even after byte repair", () => {
  const root = state(),
    s = store(root),
    original = readFileSync(indexPath(root));
  writeFileSync(indexPath(root), Buffer.concat([original, Buffer.from("\n")]));
  code("authoring_store_unavailable", () => s.listDrafts("/projects/one"));
  writeFileSync(indexPath(root), original);
  code("authoring_store_unavailable", () => s.status());
  expect(store(root).status().storeId).toMatch(/^store_/);
});
test("byte identical authority replacement is allowed; directory replacement is latched", () => {
  const root = state(),
    s = store(root),
    bytes = readFileSync(indexPath(root)),
    tmp = indexPath(root) + ".copy";
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, indexPath(root));
  expect(s.status().storeId).toMatch(/^store_/);
  renameSync(join(root, "runtime/authoring"), join(root, "runtime/old"));
  mkdirSync(join(root, "runtime/authoring"), { mode: 0o700 });
  code("authoring_store_unavailable", () => s.status());
});
test.each(["missing", "changed", "symlink", "unsafe mode", "hard link"] as const)(
  "snapshot %s refuses and latches cached reads",
  (damage) => {
    const root = state(),
      s = store(root),
      ref = s.putSnapshot(Buffer.from("flowchart LR\n a[A]")),
      p = join(root, "runtime/authoring/snapshots", ref.revision.slice(7));
    if (damage === "missing") unlinkSync(p);
    if (damage === "changed") writeFileSync(p, "changed");
    if (damage === "unsafe mode") chmodSync(p, 0o644);
    if (damage === "symlink") {
      unlinkSync(p);
      const outside = join(state(), "source");
      writeFileSync(outside, "exact", { mode: 0o600 });
      symlinkSync(outside, p);
    }
    if (damage === "hard link") linkSync(p, join(state(), "alias"));
    expect(() => s.readSnapshot(ref)).toThrow(AuthoringStoreError);
    code("authoring_store_unavailable", () => s.status());
  },
);
test("index permissions, directory symlinks, malformed UTF8 and unsupported input refuse", () => {
  const root = state();
  store(root);
  chmodSync(indexPath(root), 0o644);
  code("authoring_store_invalid", () => store(root));
  const other = state();
  mkdirSync(join(other, "runtime"), { mode: 0o700 });
  symlinkSync(state(), join(other, "runtime/authoring"));
  expect(() => store(other)).toThrow(AuthoringStoreError);
  const s = store();
  code("authoring_store_invalid", () => s.putSnapshot(Uint8Array.from([0xff])));
  code("authoring_store_limit", () => s.putSnapshot(Buffer.alloc(AUTHORING_STORE_LIMITS.sourceBytes + 1)));
  code("authoring_store_invalid", () =>
    s.saveDraft({ ...input(), origin: { kind: "new", proposedPath: "../escape" } }),
  );
  code("authoring_store_invalid", () => parseJournalCompletion({ outcome: "saved", review: {}, secret: "no" }));
});
test("named per-draft history limit preserves head and unchanged retries pass at capacity", () => {
  const s = store();
  let d = s.saveDraft({ ...input(), source: Buffer.from("0") }).draft;
  for (let n = 1; n < 32; n++)
    d = s.saveDraft({ ...input(), expectedDraftRevision: n, source: Buffer.from(String(n)) }).draft;
  expect(d.revisions).toHaveLength(32);
  expect(s.saveDraft({ ...input(), expectedDraftRevision: 32, source: Buffer.from("31") }).kind).toBe("unchanged");
  code("authoring_store_capacity", () =>
    s.saveDraft({ ...input(), expectedDraftRevision: 32, source: Buffer.from("32") }),
  );
  expect(s.getDraft("/projects/one", id())?.draftRevision).toBe(32);
});
test("named open/project revision limits are project scoped and do not prune discarded history", () => {
  const s = store();
  for (let n = 1; n <= 64; n++) s.saveDraft(input(n));
  code("authoring_store_capacity", () => s.saveDraft(input(65)));
  s.setDraftState("/projects/one", id(), 1, "discarded");
  expect(s.saveDraft(input(65)).kind).toBe("saved");
  expect(s.saveDraft({ ...input(66), projectRoot: "/projects/two" }).kind).toBe("saved");
  expect(AUTHORING_STORE_LIMITS.revisionsPerProject).toBe(256);
  // Scale only the aggregate ceiling after real admissions, avoiding 256 fsyncs per run.
  const limits = AUTHORING_STORE_LIMITS as unknown as {
    revisionsPerProject: number;
  };
  const original = limits.revisionsPerProject;
  try {
    limits.revisionsPerProject = 65;
    s.setDraftState("/projects/one", id(2), 1, "discarded");
    code("authoring_store_capacity", () => s.saveDraft(input(67)));
    expect(s.listDrafts("/projects/one").reduce((n, d) => n + d.revisions.length, 0)).toBe(65);
  } finally {
    limits.revisionsPerProject = original;
  }
});
test("parser depth is bounded iteratively with named refusal", () => {
  const root = state();
  store(root);
  const valid = JSON.parse(readFileSync(indexPath(root), "utf8"));
  expect(parseAuthoringIndex(Buffer.from(JSON.stringify(valid))).version).toBe(1);
  let deep: unknown = 0;
  for (let n = 0; n < 20; n++) deep = [deep];
  code("authoring_store_limit", () => parseAuthoringIndex(Buffer.from(JSON.stringify({ ...valid, drafts: deep }))));
});
