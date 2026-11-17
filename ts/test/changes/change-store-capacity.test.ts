import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CHANGE_STORE_LIMITS, ChangeStore, type ChangeStoreError } from "../../src/changes/index.ts";
import { withChangeStoreIo } from "../../src/changes/io.ts";

type MutableLimits = { -readonly [Key in keyof typeof CHANGE_STORE_LIMITS]: number };
const limits = CHANGE_STORE_LIMITS as MutableLimits;
const defaults = { ...CHANGE_STORE_LIMITS };
const roots: string[] = [];

afterEach(() => {
  Object.assign(limits, defaults);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-change-capacity-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

const shared = Buffer.from("flowchart LR\n  shared[Already stored]\n");
const unique = Buffer.from("flowchart LR\n  shared[Already stored]\n  shared --> new[Only new blob]\n");
const first = {
  operationId: "11111111111111111111111111111111",
  projectRoot: "/projects/capacity",
  format: "mermaid" as const,
  origin: "browser_editor" as const,
  target: { kind: "document" as const, path: ".archer/capacity.mmd" },
  eventKind: "document.created" as const,
  before: null,
  after: shared,
};
const second = {
  ...first,
  operationId: "22222222222222222222222222222222",
  eventKind: "document.updated" as const,
  before: shared,
  after: unique,
};
const third = {
  ...second,
  operationId: "33333333333333333333333333333333",
  before: unique,
  after: Buffer.from("flowchart LR\n  third[One past]\n"),
};

function paths(stateDir: string) {
  const directory = join(stateDir, "runtime/change-review");
  return { index: join(directory, "index.json"), snapshots: join(directory, "snapshots") };
}

function inventory(stateDir: string) {
  return withChangeStoreIo(stateDir, (io) =>
    io.inventory({
      entries: defaults.directoryEntries,
      physicalBytes: defaults.physicalBytes,
      snapshotBytes: defaults.snapshotBytes,
    }),
  );
}

function seeded() {
  const stateDir = state();
  const store = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {}, now: () => 1_760_688_000_000 });
  const admitted = store.admit(first);
  return { stateDir, store, admitted };
}

function expectCapacity(call: () => unknown): void {
  expect(call).toThrowError(expect.objectContaining<Partial<ChangeStoreError>>({ code: "change_store_capacity" }));
}

function expectRefusalPreservesStore(
  stateDir: string,
  store: ChangeStore,
  originalIndex: Buffer,
  originalSnapshots: string[],
): void {
  const storePaths = paths(stateDir);
  expect(readFileSync(storePaths.index)).toEqual(originalIndex);
  expect(readdirSync(storePaths.snapshots).sort()).toEqual(originalSnapshots);
  const reopened = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
  expect(reopened.pending(first.projectRoot, { limit: 100 }).records).toHaveLength(1);
  expect(reopened.admit(first)).toEqual({ kind: "replayed", record: store.admit(first).record });
}

function withLimits(overrides: Partial<MutableLimits>, run: () => void): void {
  const originals = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, limits[key as keyof MutableLimits]]),
  ) as Partial<MutableLimits>;
  Object.assign(limits, overrides);
  try {
    run();
  } finally {
    Object.assign(limits, originals);
  }
}

test("published default aggregate limits remain the ADR contract", () => {
  expect(CHANGE_STORE_LIMITS).toMatchObject({
    records: 4_096,
    indexBytes: 8 * 1024 * 1024,
    snapshotBytes: 128 * 1024 * 1024,
    physicalBytes: 160 * 1024 * 1024,
    directoryEntries: 8_192,
  });
});

test("total record capacity accepts the scaled limit and refuses one past without disabling replay", () => {
  withLimits({ records: 2, pendingPerProject: 3 }, () => {
    const { stateDir, store } = seeded();
    expect(store.admit(second).kind).toBe("admitted");
    const storePaths = paths(stateDir);
    const exactIndex = readFileSync(storePaths.index);
    const exactSnapshots = readdirSync(storePaths.snapshots).sort();

    expectCapacity(() => store.admit(third));
    expect(readFileSync(storePaths.index)).toEqual(exactIndex);
    expect(readdirSync(storePaths.snapshots).sort()).toEqual(exactSnapshots);
    const reopened = new ChangeStore({ stateDir, serviceName: "main", assertOwner() {} });
    expect(reopened.pending(first.projectRoot, { limit: 100 }).records).toHaveLength(2);
    expect(reopened.admit(first).kind).toBe("replayed");
  });
});

test("index capacity accepts the actual next index bytes and refuses one byte less", () => {
  const probe = seeded();
  probe.store.admit(second);
  const exact = readFileSync(paths(probe.stateDir).index).byteLength;

  withLimits({ indexBytes: exact }, () => {
    const { stateDir, store } = seeded();
    expect(store.admit(second).kind).toBe("admitted");
    expect(readFileSync(paths(stateDir).index)).toHaveLength(exact);
  });

  withLimits({ indexBytes: exact - 1 }, () => {
    const { stateDir, store } = seeded();
    const storePaths = paths(stateDir),
      originalIndex = readFileSync(storePaths.index),
      originalSnapshots = readdirSync(storePaths.snapshots).sort();
    expectCapacity(() => store.admit(second));
    expectRefusalPreservesStore(stateDir, store, originalIndex, originalSnapshots);
  });
});

test("snapshot capacity counts only a new deduplicated blob at exact and one-past boundaries", () => {
  const probe = seeded();
  const before = inventory(probe.stateDir);
  probe.store.admit(second);
  const exact = inventory(probe.stateDir).snapshotBytes;
  expect(exact - before.snapshotBytes).toBe(unique.byteLength);

  withLimits({ snapshotBytes: exact }, () => {
    const { stateDir, store } = seeded();
    expect(store.admit(second).kind).toBe("admitted");
    expect(inventory(stateDir).snapshotBytes).toBe(exact);
  });

  withLimits({ snapshotBytes: exact - 1 }, () => {
    const { stateDir, store } = seeded();
    const storePaths = paths(stateDir),
      originalIndex = readFileSync(storePaths.index),
      originalSnapshots = readdirSync(storePaths.snapshots).sort();
    expectCapacity(() => store.admit(second));
    expectRefusalPreservesStore(stateDir, store, originalIndex, originalSnapshots);
  });
});

test("physical capacity reserves current bytes, one new blob, and the full temporary next index", () => {
  const probe = seeded();
  const before = inventory(probe.stateDir);
  probe.store.admit(second);
  const nextIndexBytes = readFileSync(paths(probe.stateDir).index).byteLength;
  const exactReservation = before.physicalBytes + unique.byteLength + nextIndexBytes;

  withLimits({ physicalBytes: exactReservation }, () => {
    const { stateDir, store } = seeded();
    expect(store.admit(second).kind).toBe("admitted");
    expect(readFileSync(paths(stateDir).index)).toHaveLength(nextIndexBytes);
    expect(inventory(stateDir).snapshotBytes - shared.byteLength).toBe(unique.byteLength);
  });

  withLimits({ physicalBytes: exactReservation - 1 }, () => {
    const { stateDir, store } = seeded();
    const storePaths = paths(stateDir),
      originalIndex = readFileSync(storePaths.index),
      originalSnapshots = readdirSync(storePaths.snapshots).sort();
    expectCapacity(() => store.admit(second));
    expectRefusalPreservesStore(stateDir, store, originalIndex, originalSnapshots);
  });
});
