import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { CHANGE_STORE_LIMITS, ChangeStore, ChangeStoreError, parseChangeIndex } from "../../src/changes/index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function state(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-change-store-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

test("exact Unicode, BOM and CRLF snapshots and outcome survive reopen", () => {
  const stateDir = state();
  const before = Buffer.from("\ufeffflowchart LR\r\n  café[猫]\r\n", "utf8");
  const after = Buffer.from("\ufeffflowchart LR\r\n  café[猫]\r\n  café --> fin\r\n", "utf8");
  const input = {
    operationId: "0123456789abcdef0123456789abcdef",
    projectRoot: "/projects/café",
    format: "mermaid" as const,
    origin: "browser_editor" as const,
    target: { kind: "document" as const, path: ".archer/café.mmd" },
    eventKind: "document.updated" as const,
    before,
    after,
    intent: "Preserve 猫 exactly",
  };
  const admitted = new ChangeStore({
    stateDir,
    serviceName: "main",
    assertOwner() {},
    now: () => Date.parse("2026-10-17T12:34:56.789Z"),
  }).admit(input);
  expect(admitted.kind).toBe("admitted");
  expect(admitted.record).toMatchObject({
    sequence: 1,
    savedAt: "2026-10-17T12:34:56.789Z",
    disposition: "pending",
    reviewRevision: 1,
  });
  expect(admitted.record.before?.revision).toBe(`sha256:${cryptoHash(before)}`);
  expect(admitted.record.after.revision).toBe(`sha256:${cryptoHash(after)}`);

  const reopened = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  expect(reopened.status()).toEqual({ storeId: admitted.record.storeId, generation: admitted.record.generation });
  expect(reopened.admit(input)).toEqual({ kind: "replayed", record: admitted.record });
  expect(reopened.get(input.projectRoot, admitted.record.changeId)).toEqual(admitted.record);
  expect(reopened.readSnapshot(input.projectRoot, admitted.record.changeId, "before")).toEqual(before);
  expect(reopened.readSnapshot(input.projectRoot, admitted.record.changeId, "after")).toEqual(after);
});

import { createHash } from "node:crypto";
function cryptoHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const base = (operationId: string, projectRoot = "/projects/one") => ({
  operationId,
  projectRoot,
  format: "mermaid" as const,
  origin: "browser_editor" as const,
  target: { kind: "document" as const, path: ".archer/a.mmd" },
  eventKind: "document.updated" as const,
  before: Buffer.from("flowchart LR\n  a[A]\n"),
  after: Buffer.from(`flowchart LR\n  a[A]\n  ${operationId.slice(0, 2)}@a --> b\n`),
});
const code = (expected: string) => (error: unknown) => error instanceof ChangeStoreError && error.code === expected;
function expectCode(expected: string, call: () => unknown): void {
  try {
    call();
  } catch (error) {
    expect(code(expected)(error), String(error)).toBe(true);
    return;
  }
  throw new Error(`expected ${expected}`);
}

test("event, target and before-presence matrix is enforced by production admission", () => {
  const store = new ChangeStore({ stateDir: state(), serviceName: "main", assertOwner() {} });
  const cases = [
    ["draft.saved", { kind: "draft", id: "draft-1" }, null, true],
    ["draft.saved", { kind: "document", path: "a.mmd" }, null, false],
    ["proposal.saved", { kind: "document", path: "a.mmd" }, Buffer.from("old"), true],
    ["proposal.saved", { kind: "document", path: "a.mmd" }, null, false],
    ["document.created", { kind: "document", path: "a.mmd" }, null, true],
    ["document.created", { kind: "document", path: "a.mmd" }, Buffer.from("old"), false],
    ["document.updated", { kind: "document", path: "a.mmd" }, Buffer.from("old"), true],
    ["document.updated", { kind: "draft", id: "draft-1" }, Buffer.from("old"), false],
  ] as const;
  for (const [eventKind, target, before, accepted] of cases) {
    const input = {
      ...base(cryptoHash(Buffer.from(JSON.stringify([eventKind, target, before]))).slice(0, 32)),
      eventKind,
      target,
      before,
      after: Buffer.from("new"),
    };
    if (accepted) expect(store.admit(input).kind).toBe("admitted");
    else expectCode("change_invalid_input", () => store.admit(input));
  }
  expectCode("change_invalid_input", () =>
    store.admit({
      ...base("99999999999999999999999999999999"),
      target: { kind: "document", path: "a.mmd", extra: true } as never,
    }),
  );
  expectCode("change_invalid_input", () =>
    store.admit({
      ...base("99999999999999999999999999999998"),
      operationId: { toString: () => "a".repeat(32) },
    } as never),
  );
});

test("stable pages exclude later records, reject invalid cursors and protect retained state", () => {
  const store = new ChangeStore({ stateDir: state(), serviceName: "main", assertOwner() {} });
  const first = store.admit(base("00000000000000000000000000000001")).record;
  const second = store.admit(base("00000000000000000000000000000002")).record;
  const page = store.pending("/projects/one", { limit: 1 });
  expect(page).toMatchObject({ upperSequence: 2, nextAfterSequence: 1 });
  (page.records[0]!.target as { path: string }).path = "mutated";
  store.admit(base("00000000000000000000000000000003"));
  expect(
    store
      .pending("/projects/one", {
        afterSequence: page.nextAfterSequence!,
        upperSequence: page.upperSequence,
        limit: 100,
      })
      .records.map((r) => r.changeId),
  ).toEqual([second.changeId]);
  expect(store.get("/projects/one", first.changeId)?.target).toEqual({ kind: "document", path: ".archer/a.mmd" });
  expectCode("change_cursor_invalid", () => store.pending("/projects/one", { upperSequence: 4, limit: 1 }));
  expectCode("change_cursor_invalid", () =>
    store.pending("/projects/one", { afterSequence: 3, upperSequence: 2, limit: 1 }),
  );
});

test("operation replay is global, precedes mutation, and changed payload is refused", () => {
  const store = new ChangeStore({ stateDir: state(), serviceName: "main", assertOwner() {} });
  const input = base("11111111111111111111111111111111");
  expect(store.admit(input).kind).toBe("admitted");
  expect(store.admit(input).kind).toBe("replayed");
  expectCode("change_operation_mismatch", () => store.admit({ ...input, projectRoot: "/projects/two" }));
  expectCode("change_operation_mismatch", () => store.admit({ ...input, after: input.before }));
  expectCode("change_operation_mismatch", () => store.admit({ ...input, intent: " " }));
  expectCode("change_invalid_input", () =>
    store.admit({ ...input, intent: undefined } as unknown as Parameters<ChangeStore["admit"]>[0]),
  );
});

test("old authority after commit IO is retained without automatic retry", () => {
  let armed = false,
    attempts = 0;
  const store = new ChangeStore({
    stateDir: state(),
    serviceName: "main",
    assertOwner() {},
    onCommitStep(step) {
      if (armed && step === "before_index_rename") {
        attempts++;
        throw new Error("injected pre-publication failure");
      }
    },
  });
  armed = true;
  expectCode("change_store_io", () => store.admit(base("12121212121212121212121212121212")));
  expect(attempts).toBe(1);
  armed = false;
  expect(store.admit(base("12121212121212121212121212121212")).kind).toBe("admitted");
});

test.skipIf(process.getuid?.() === 0)("EACCES while recovery reads authority permanently latches the owner", () => {
  const stateDir = state();
  let armed = false;
  const store = new ChangeStore({
    stateDir,
    serviceName: "main",
    assertOwner() {},
    onCommitStep(step) {
      if (armed && step === "before_index_rename") {
        armed = false;
        chmodSync(join(stateDir, "runtime/change-review/index.json"), 0o000);
        throw new Error("authority became unreadable");
      }
    },
  });
  armed = true;
  try {
    expectCode("change_store_unavailable", () => store.admit(base("13131313131313131313131313131313")));
  } finally {
    chmodSync(join(stateDir, "runtime/change-review/index.json"), 0o600);
  }
  expectCode("change_store_unavailable", () => store.status());
});

test("project scope is checked before any snapshot read", () => {
  const stateDir = state(),
    store = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  const record = store.admit(base("22222222222222222222222222222222")).record;
  unlinkSync(join(stateDir, "runtime/change-review/snapshots", record.after.revision.slice(7)));
  expectCode("change_not_found", () => store.readSnapshot("/projects/other", record.changeId, "after"));
  expectCode("change_store_invalid", () => store.readSnapshot("/projects/one", record.changeId, "after"));
});

test("post-rename failure is uncertain and only identical retry confirms the visible record", () => {
  let publishFailure = false,
    replaySyncFailures = 1,
    replaySyncAttempts = 0;
  const store = new ChangeStore({
    stateDir: state(),
    serviceName: "main",
    assertOwner() {},
    onCommitStep(step) {
      if (publishFailure && step === "after_index_rename") {
        publishFailure = false;
        throw new Error("injected directory-sync boundary");
      }
      if (step === "before_uncertain_replay_sync") {
        replaySyncAttempts++;
        if (replaySyncFailures-- > 0) throw new Error("injected replay sync failure");
      }
    },
  });
  publishFailure = true;
  const input = base("33333333333333333333333333333333");
  expectCode("change_store_uncertain", () => store.admit(input));
  expectCode("change_store_uncertain", () => store.admit(input));
  expect(store.admit(input).kind).toBe("replayed");
  expect(replaySyncAttempts).toBe(2);
});

test("strict parser rejects semantic mutations of a production-persisted record", () => {
  const stateDir = state(),
    store = new ChangeStore({
      stateDir,
      serviceName: "main",
      assertOwner() {},
      now: () => Date.parse("2026-10-17T01:02:03.004Z"),
    });
  store.admit(base("abababababababababababababababab"));
  const original = JSON.parse(readFileSync(join(stateDir, "runtime/change-review/index.json"), "utf8")) as {
    records: Array<Record<string, unknown>>;
  };
  const mutations: Array<[string, (record: Record<string, unknown>) => void]> = [
    [
      "store identity",
      (record) => {
        record.storeId = `store_${"f".repeat(32)}`;
      },
    ],
    [
      "payload digest",
      (record) => {
        record.intent = "changed";
      },
    ],
    [
      "change identity",
      (record) => {
        record.changeId = `chg_${"f".repeat(32)}`;
      },
    ],
    [
      "canonical timestamp",
      (record) => {
        record.savedAt = "2026-10-17T01:02:03.004+00:00";
      },
    ],
    [
      "sequence",
      (record) => {
        record.sequence = 2;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const changed = structuredClone(original);
    mutate(changed.records[0]!);
    expectCode("change_store_invalid", () => parseChangeIndex(Buffer.from(JSON.stringify(changed))));
    expect(name).not.toBe("");
  }
});

test("caller byte and identifier limits accept exact values and refuse one past", () => {
  const store = new ChangeStore({ stateDir: state(), serviceName: "main", assertOwner() {} });
  const cases = [
    [
      "source",
      { after: Buffer.alloc(CHANGE_STORE_LIMITS.sourceBytes, 0x61), eventKind: "document.created", before: null },
      { after: Buffer.alloc(CHANGE_STORE_LIMITS.sourceBytes + 1, 0x61), eventKind: "document.created", before: null },
    ],
    [
      "intent",
      { intent: "a".repeat(CHANGE_STORE_LIMITS.intentBytes) },
      { intent: "a".repeat(CHANGE_STORE_LIMITS.intentBytes + 1) },
    ],
    [
      "root",
      { projectRoot: `/${"a".repeat(CHANGE_STORE_LIMITS.projectRootBytes - 1)}` },
      { projectRoot: `/${"a".repeat(CHANGE_STORE_LIMITS.projectRootBytes)}` },
    ],
    [
      "path",
      { target: { kind: "document", path: "a".repeat(CHANGE_STORE_LIMITS.targetPathBytes) } },
      { target: { kind: "document", path: "a".repeat(CHANGE_STORE_LIMITS.targetPathBytes + 1) } },
    ],
    [
      "opaque",
      {
        target: { kind: "draft", id: "a".repeat(CHANGE_STORE_LIMITS.opaqueIdCharacters) },
        eventKind: "draft.saved",
        before: null,
      },
      {
        target: { kind: "draft", id: "a".repeat(CHANGE_STORE_LIMITS.opaqueIdCharacters + 1) },
        eventKind: "draft.saved",
        before: null,
      },
    ],
  ] as const;
  for (let index = 0; index < cases.length; index++) {
    const [name, exact, over] = cases[index]!;
    const operationId = `aa${index.toString(16)}`.padEnd(32, "a");
    expect(store.admit({ ...base(operationId), ...exact } as never).kind, name).toBe("admitted");
    expectCode(
      name === "opaque" || name === "path" || name === "root" ? "change_invalid_input" : "change_store_limit",
      () => store.admit({ ...base(`bb${index.toString(16)}`.padEnd(32, "b")), ...over } as never),
    );
  }
}, 15_000);

test("admission refuses before writing an index that exceeds the parser value budget", () => {
  const stateDir = state(),
    store = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  store.admit(base("cacacacacacacacacacacacacacacaca"));
  const indexPath = join(stateDir, "runtime/change-review/index.json"),
    snapshots = join(stateDir, "runtime/change-review/snapshots");
  const oneRecord = readFileSync(indexPath),
    mutableLimits = CHANGE_STORE_LIMITS as unknown as { jsonValues: number },
    originalLimit = mutableLimits.jsonValues;
  let exact = 1;
  const names = readdirSync(snapshots);
  try {
    for (; exact <= 1_000; exact++) {
      mutableLimits.jsonValues = exact;
      try {
        parseChangeIndex(oneRecord);
        break;
      } catch (error) {
        if (!(error instanceof ChangeStoreError) || error.code !== "change_store_limit") throw error;
      }
    }
    expect(exact).toBeLessThanOrEqual(1_000);
    expectCode("change_store_capacity", () => store.admit(base("cbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcb")));
    expect(
      new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} }).pending("/projects/one", { limit: 1 })
        .upperSequence,
    ).toBe(1);
  } finally {
    mutableLimits.jsonValues = originalLimit;
  }
  expect(readFileSync(indexPath)).toEqual(oneRecord);
  expect(readdirSync(snapshots)).toEqual(names);
  expect(new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} }).status()).toEqual(store.status());
  expect(exact).toBeGreaterThan(1);
});

test("missing index in a nonempty store refuses instead of minting new authority", () => {
  const stateDir = state();
  new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  unlinkSync(join(stateDir, "runtime/change-review/index.json"));
  expectCode("change_store_invalid", () => new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} }));
});

test("strict parser bounds traversal at depth four with a named refusal", () => {
  const valid = Buffer.from(
    JSON.stringify({
      version: 1,
      serviceName: "main",
      storeId: `store_${"a".repeat(32)}`,
      generation: `gen_${"b".repeat(32)}`,
      records: [],
    }),
  );
  expect(parseChangeIndex(valid)).toMatchObject({ version: 1, records: [] });
  const depthFive = Buffer.from(
    JSON.stringify({
      version: 1,
      serviceName: "main",
      storeId: `store_${"a".repeat(32)}`,
      generation: `gen_${"b".repeat(32)}`,
      records: [[[[0]]]],
    }),
  );
  expectCode("change_store_limit", () => parseChangeIndex(depthFive));
  expectCode("change_store_invalid", () => parseChangeIndex(Buffer.from([0xff])));
});

test("owner guard runs before construction IO and every public operation", () => {
  let owned = false;
  expectCode(
    "change_store_closed",
    () =>
      new ChangeStore({
        stateDir: "/does/not/exist",
        serviceName: "main",
        assertOwner() {
          if (!owned) throw new ChangeStoreError("change_store_closed", "closed");
        },
      }),
  );
  owned = true;
  const store = new ChangeStore({
    stateDir: state(),
    serviceName: "main",
    assertOwner() {
      if (!owned) throw new ChangeStoreError("change_store_closed", "closed");
    },
  });
  owned = false;
  for (const call of [
    () => store.status(),
    () => store.get("/p", "chg_x"),
    () => store.readSnapshot("/p", "chg_x", "after"),
    () => store.pending("/p", { limit: 1 }),
    () => store.admit(base("44444444444444444444444444444444")),
  ])
    expectCode("change_store_closed", call);
});

test("per-project capacity accepts 256 meaningful admissions, refuses one more, and still replays", () => {
  const stateDir = state(),
    store = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  let first: ReturnType<typeof base> | undefined;
  for (let index = 0; index < 256; index++) {
    const operationId = index.toString(16).padStart(32, "0");
    const input = { ...base(operationId), after: Buffer.from(`flowchart LR\n  n${index}[Save ${index}]\n`) };
    first ??= input;
    expect(store.admit(input).record.sequence).toBe(index + 1);
  }
  expectCode("change_store_capacity", () => store.admit(base("ffffffffffffffffffffffffffffffff")));
  expect(store.admit(first!).kind).toBe("replayed");
  expect(
    new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} }).pending("/projects/one", { limit: 100 })
      .upperSequence,
  ).toBe(256);
}, 45_000); // 256 durable publications measured 18.1 s under concurrent review load.

test("strict parser refuses a production-signed persisted 257th pending record", () => {
  const stateDir = state(),
    mutableLimits = CHANGE_STORE_LIMITS as unknown as { pendingPerProject: number };
  mutableLimits.pendingPerProject = 257;
  try {
    const store = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
    for (let index = 0; index < 257; index++)
      store.admit({
        ...base(index.toString(16).padStart(32, "0")),
        after: Buffer.from(`flowchart LR\n  p${index}[Pending ${index}]\n`),
      });
  } finally {
    mutableLimits.pendingPerProject = 256;
  }
  expectCode("change_store_limit", () =>
    parseChangeIndex(readFileSync(join(stateDir, "runtime/change-review/index.json"))),
  );
}, 45_000); // 257 durable publications share the measured boundary-fixture budget.

test("a child exit after index rename leaves visible authority gated by reopen sync", () => {
  const stateDir = state();
  new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  const module = new URL("../../src/changes/index.ts", import.meta.url).href;
  const script = `import {ChangeStore} from ${JSON.stringify(module)}; const s=new ChangeStore({stateDir:process.env.CHANGE_TEST_STATE,serviceName:"main",assertOwner(){},onCommitStep(step){if(step==="after_index_rename")process.exit(41)}}); s.admit({operationId:"55555555555555555555555555555555",projectRoot:"/projects/one",format:"mermaid",origin:"browser_editor",target:{kind:"document",path:".archer/a.mmd"},eventKind:"document.created",before:null,after:Buffer.from("flowchart LR\\n  crash[Visible]\\n")});`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--eval", script], {
    env: { ...process.env, CHANGE_TEST_STATE: stateDir },
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(41);
  expectCode(
    "change_store_unavailable",
    () =>
      new ChangeStore({
        stateDir,
        serviceName: "main",
        assertOwner() {},
        onCommitStep(step) {
          if (step === "before_open_sync") throw new Error("reopen barrier failed");
        },
      }),
  );
  const reopened = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  const input = {
    ...base("55555555555555555555555555555555"),
    eventKind: "document.created" as const,
    before: null,
    after: Buffer.from("flowchart LR\n  crash[Visible]\n"),
  };
  expect(reopened.admit(input).kind).toBe("replayed");
}, 15_000);

test("ChangeStore reconciles a child exit between immutable blob link and temp unlink", () => {
  const stateDir = state();
  new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  const module = new URL("../../src/changes/index.ts", import.meta.url).href;
  const script = `import {ChangeStore} from ${JSON.stringify(module)}; const s=new ChangeStore({stateDir:process.env.CHANGE_TEST_STATE,serviceName:"main",assertOwner(){},onCommitStep(step){if(step==="after_blob_link")process.exit(42)}}); s.admit({operationId:"56565656565656565656565656565656",projectRoot:"/projects/one",format:"mermaid",origin:"browser_editor",target:{kind:"document",path:".archer/a.mmd"},eventKind:"document.created",before:null,after:Buffer.from("flowchart LR\\n  linked[Crash pair]\\n")});`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--eval", script], {
    env: { ...process.env, CHANGE_TEST_STATE: stateDir },
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(42);
  const snapshots = join(stateDir, "runtime/change-review/snapshots");
  expect(readdirSync(snapshots).some((name) => /^\.blob\..+\.tmp$/u.test(name))).toBe(true);
  const reopened = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  expect(readdirSync(snapshots).some((name) => /^\.blob\..+\.tmp$/u.test(name))).toBe(false);
  expect(
    reopened.admit({
      ...base("56565656565656565656565656565656"),
      eventKind: "document.created",
      before: null,
      after: Buffer.from("flowchart LR\n  linked[Crash pair]\n"),
    }).kind,
  ).toBe("admitted");
}, 15_000);

test("missing index refuses without cleaning an interrupted blob publication pair", () => {
  const stateDir = state();
  new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  const module = new URL("../../src/changes/index.ts", import.meta.url).href;
  const script = `import {ChangeStore} from ${JSON.stringify(module)}; const s=new ChangeStore({stateDir:process.env.CHANGE_TEST_STATE,serviceName:"main",assertOwner(){},onCommitStep(step){if(step==="after_blob_link")process.exit(43)}}); s.admit({operationId:"57575757575757575757575757575757",projectRoot:"/projects/one",format:"mermaid",origin:"browser_editor",target:{kind:"document",path:".archer/a.mmd"},eventKind:"document.created",before:null,after:Buffer.from("flowchart LR\\n  linked[Keep pair]\\n")});`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--eval", script], {
    env: { ...process.env, CHANGE_TEST_STATE: stateDir },
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(43);
  const directory = join(stateDir, "runtime/change-review"),
    snapshots = join(directory, "snapshots");
  unlinkSync(join(directory, "index.json"));
  const names = readdirSync(snapshots);
  expectCode("change_store_invalid", () => new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} }));
  expect(readdirSync(snapshots)).toEqual(names);
}, 15_000);

test("reopen refuses missing, world-readable, and multiply-linked authority files", () => {
  for (const damage of ["missing", "readable", "linked"] as const) {
    const stateDir = state(),
      store = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
    const record = store.admit(base(`66${damage.charCodeAt(0).toString(16)}`.padEnd(32, "6"))).record;
    const blob = join(stateDir, "runtime/change-review/snapshots", record.after.revision.slice(7));
    if (damage === "missing") unlinkSync(blob);
    if (damage === "readable") chmodSync(join(stateDir, "runtime/change-review/index.json"), 0o644);
    if (damage === "linked") linkSync(blob, join(stateDir, "runtime/change-review/snapshots", "f".repeat(64)));
    expectCode("change_store_invalid", () => new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} }));
  }
});

test("orphan and strict temporary files are retained and counted without becoming records", () => {
  const stateDir = state(),
    store = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  const snapshots = join(stateDir, "runtime/change-review/snapshots");
  writeFileSync(join(snapshots, "e".repeat(64)), "orphan", { mode: 0o600 });
  writeFileSync(join(snapshots, `.blob.${"d".repeat(32)}.tmp`), "temporary", { mode: 0o600 });
  const reopened = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  expect(reopened.pending("/projects/one", { limit: 100 }).records).toEqual([]);
  writeFileSync(join(snapshots, "unexpected"), "bad", { mode: 0o600 });
  expectCode("change_store_invalid", () => new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} }));
});

test("inventory accepts exactly 8192 entries and refuses entry 8193", () => {
  const stateDir = state();
  new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  const snapshots = join(stateDir, "runtime/change-review/snapshots");
  for (let index = 0; index < 8_190; index++)
    writeFileSync(join(snapshots, index.toString(16).padStart(64, "0")), "", { mode: 0o600 });
  expect(new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} }).status().storeId).toMatch(/^store_/u);
  writeFileSync(join(snapshots, "f".repeat(64)), "", { mode: 0o600 });
  expectCode("change_store_limit", () => new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} }));
}, 30_000);

test("changed, overwritten, or removed index authority latches unavailable before reads or writes", () => {
  for (const damage of ["replace", "overwrite", "remove"] as const) {
    const stateDir = state(),
      store = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
    const record = store.admit(base(`77${damage.charCodeAt(0).toString(16)}`.padEnd(32, "7"))).record;
    const directory = join(stateDir, "runtime/change-review"),
      index = join(directory, "index.json"),
      snapshots = join(directory, "snapshots");
    const changed = Buffer.from(
      readFileSync(index).toString("utf8").replace('"serviceName":"main"', '"serviceName":"evil"'),
    );
    if (damage === "replace") {
      const replacement = join(directory, ".external");
      writeFileSync(replacement, changed, { mode: 0o600 });
      renameSync(replacement, index);
    }
    if (damage === "overwrite") writeFileSync(index, changed, { mode: 0o600 });
    if (damage === "remove") unlinkSync(index);
    const snapshotNames = readdirSync(snapshots),
      authority = existsSync(index) ? readFileSync(index) : null;
    expectCode("change_store_unavailable", () => store.get("/projects/one", record.changeId));
    expectCode("change_store_unavailable", () => store.admit(base("88888888888888888888888888888888")));
    expect(readdirSync(snapshots)).toEqual(snapshotNames);
    expect(existsSync(index) ? readFileSync(index) : null).toEqual(authority);
    expect(readdirSync(directory).some((name) => /^\.index\..+\.tmp$/u.test(name))).toBe(false);
  }
});
