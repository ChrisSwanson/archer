// Persister (project-state/persister.ts) on its own, against the real AccountStateStore: a durable commit
// saves the record and the views' last-good sources, then the continuity file; a refused save throws and
// writes no continuity; continuity is advisory (logged, never thrown) and not rewritten unchanged; over
// RECOVERY_VIEWS views the presented, selected and emphasised views are the ones kept; no store, no reads.
// Deferred commits (c5) coalesce, ride along with a durable one, are logged and retried when they fail,
// and are saved at once by flush and close.
import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import {
  Persister,
  RECOVERY_VIEWS,
  type RecoverableView,
  type RecoveryState,
} from "../../src/service/project-state/persister.ts";
import { AccountStateStore, PersistenceError } from "../../src/state/account.ts";
import type { ContinuityRecord } from "../../src/state/continuity.ts";
import { activate, deactivate } from "../../src/telemetry/index.ts";
import { Telemetry } from "../../src/telemetry/telemetry.ts";
import { cleanUp, tempDir } from "./support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  cleanUp();
});

const ROOT = "/project";
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function view(id: string): RecoverableView {
  const bytes = Buffer.from(`flowchart LR\n  ${id}[${id}]\n`);
  return {
    id,
    kind: "freeform",
    title: id,
    path: `.archer/${id}.mmd`,
    sourceRevision: null,
    envelope: { revision: digest(bytes) },
    lastGoodSource: bytes,
  };
}

function state(views: RecoverableView[], over: Partial<RecoveryState> = {}): RecoveryState {
  return {
    views,
    presentation: null,
    selection: null,
    captions: new Map(),
    lastChange: new Map(),
    emphases: () => [],
    ...over,
  };
}

const continuity = (writes: ContinuityRecord["writes"] = []): ContinuityRecord => ({ version: 1, root: ROOT, writes });

test("a durable commit saves the record and the last-good sources, then the continuity file", () => {
  const store = new AccountStateStore(tempDir());
  const persister = new Persister(
    store,
    () => ROOT,
    () => {},
  );
  const flow = view("flow");
  // A view with no compiled envelope, or no last-good bytes, is not recovered.
  const failing: RecoverableView = { ...view("broken"), envelope: null };
  persister.commit(
    () =>
      state([flow, failing], {
        presentation: { viewId: "flow" },
        captions: new Map([["flow", { at: "2026-11-11T00:00:00.000Z", caption: "Here" }]]),
      }),
    () => continuity([{ viewId: "flow", at: 1 }]),
    "durable",
  );
  expect(store.load(ROOT)).toEqual({
    version: 1,
    root: ROOT,
    presentation: { viewId: "flow" },
    selection: null,
    captions: [["flow", { at: "2026-11-11T00:00:00.000Z", caption: "Here" }]],
    lastChange: [],
    emphases: [],
    views: [
      {
        id: "flow",
        path: flow.path,
        kind: "freeform",
        title: "flow",
        revision: flow.envelope!.revision,
        sourceRevision: null,
        blob: flow.envelope!.revision,
      },
    ],
  });
  expect(store.source(ROOT, flow.envelope!.revision)).toEqual(Buffer.from(flow.lastGoodSource!));
  expect(store.continuity(ROOT)?.writes).toEqual([{ viewId: "flow", at: 1 }]);
});

test("a save the store refuses throws, and the continuity file is not written", () => {
  const store = new AccountStateStore(tempDir());
  vi.spyOn(store, "save").mockImplementation(() => {
    throw new PersistenceError("saved_state_io", "the disk refused the write");
  });
  const saveContinuity = vi.spyOn(store, "saveContinuity");
  const persister = new Persister(
    store,
    () => ROOT,
    () => {},
  );
  expect(() =>
    persister.commit(
      () => state([view("flow")]),
      () => continuity(),
      "durable",
    ),
  ).toThrow(PersistenceError);
  expect(saveContinuity).not.toHaveBeenCalled();
});

test("continuity is written only when it changed; a refused write is logged, not thrown, and tried again", () => {
  const store = new AccountStateStore(tempDir());
  const lines: string[] = [];
  const persister = new Persister(
    store,
    () => ROOT,
    (line) => lines.push(line),
  );
  const saveContinuity = vi.spyOn(store, "saveContinuity");
  persister.continuity(() => continuity());
  persister.continuity(() => continuity());
  expect(saveContinuity).toHaveBeenCalledTimes(1);
  saveContinuity.mockImplementationOnce(() => {
    throw new PersistenceError("saved_state_io", "no space");
  });
  expect(() => persister.continuity(() => continuity([{ viewId: "flow", at: 2 }]))).not.toThrow();
  expect(lines).toEqual([`[archer] continuity state for ${ROOT} was not saved: no space`]);
  persister.continuity(() => continuity([{ viewId: "flow", at: 2 }]));
  expect(saveContinuity).toHaveBeenCalledTimes(3);
  expect(store.continuity(ROOT)?.writes).toEqual([{ viewId: "flow", at: 2 }]);
});

test("the root is read at each save", () => {
  const store = new AccountStateStore(tempDir());
  let root = "/first";
  const persister = new Persister(
    store,
    () => root,
    () => {},
  );
  persister.commit(
    () => state([]),
    () => ({ version: 1, root, writes: [] }),
    "durable",
  );
  root = "/second";
  persister.commit(
    () => state([]),
    () => ({ version: 1, root, writes: [] }),
    "durable",
  );
  expect(store.load("/first")?.root).toBe("/first");
  expect(store.load("/second")?.root).toBe("/second");
});

test("over RECOVERY_VIEWS views the presented, selected and emphasised come first, then the most recent", () => {
  const store = new AccountStateStore(tempDir());
  const persister = new Persister(
    store,
    () => ROOT,
    () => {},
  );
  const views = Array.from({ length: RECOVERY_VIEWS + 4 }, (_, i) => view(`v${String(i).padStart(3, "0")}`));
  const last = views.length - 1;
  persister.commit(
    () =>
      state(views, {
        presentation: { viewId: views[last]!.id },
        selection: { viewId: views[last - 1]!.id },
        emphases: () => [{ viewId: views[last - 2]!.id }],
        captions: new Map([[views[last - 3]!.id, { at: "2026-11-11T00:00:00.000Z" }]]),
      }),
    () => continuity(),
    "durable",
  );
  const kept = store.load(ROOT)!.views.map((v) => v.id);
  expect(kept).toHaveLength(RECOVERY_VIEWS);
  // Registered order is kept; the four at the end displace the four registered last before them.
  expect(kept.slice(-4)).toEqual(views.slice(-4).map((v) => v.id));
  expect(kept).not.toContain(views[RECOVERY_VIEWS - 1]!.id);
});

test("without a store nothing is read or written", () => {
  const persister = new Persister(
    undefined,
    () => ROOT,
    () => {},
  );
  const read = vi.fn(() => state([]));
  const record = vi.fn(() => continuity());
  persister.commit(read, record, "durable");
  persister.continuity(record);
  expect(read).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

test("deferred commits coalesce into one save of the latest state, after the delay; a durable commit takes them along", async () => {
  const store = new AccountStateStore(tempDir());
  const save = vi.spyOn(store, "save");
  const persister = new Persister(
    store,
    () => ROOT,
    () => {},
    { deferMs: 20 },
  );
  let selected = "a";
  const read = () => state([view("flow")], { selection: { viewId: selected } });
  for (const id of ["a", "b", "c"]) {
    selected = id;
    persister.commit(read, () => continuity(), "deferred");
  }
  expect(save).not.toHaveBeenCalled();
  expect(persister.pending).toBe(true);
  await new Promise((done) => setTimeout(done, 60));
  expect(save).toHaveBeenCalledTimes(1);
  expect(store.load(ROOT)?.selection).toEqual({ viewId: "c" });
  expect(persister.pending).toBe(false);
  // A durable commit while one is deferred saves both, and the timer has nothing left to do.
  selected = "d";
  persister.commit(read, () => continuity(), "deferred");
  persister.commit(read, () => continuity(), "durable");
  expect(persister.pending).toBe(false);
  await new Promise((done) => setTimeout(done, 60));
  expect(save).toHaveBeenCalledTimes(2);
  expect(store.load(ROOT)?.selection).toEqual({ viewId: "d" });
});

test("a deferred save that fails is logged as svc.state-save, never thrown, and made again with the next commit", async () => {
  const telemetry = new Telemetry();
  activate(telemetry);
  try {
    const store = new AccountStateStore(tempDir());
    const lines: string[] = [];
    const persister = new Persister(
      store,
      () => ROOT,
      (line) => lines.push(line),
      { deferMs: 10 },
    );
    const save = vi.spyOn(store, "save").mockImplementationOnce(() => {
      throw new PersistenceError("saved_state_io", "no space");
    });
    persister.commit(
      () => state([], { selection: { viewId: "a" } }),
      () => continuity(),
      "deferred",
    );
    await new Promise((done) => setTimeout(done, 40));
    expect(save).toHaveBeenCalledTimes(1);
    expect(persister.pending).toBe(true);
    expect(lines).toEqual([
      `[archer] state for ${ROOT} was not saved: no space; it is saved again with the next change`,
    ]);
    expect(telemetry.entries({ limit: 10 }).filter((e) => e.code === "svc.state-save")).toEqual([
      expect.objectContaining({ level: "warn", data: { project: ROOT, code: "saved_state_io" } }),
    ]);
    // A durable commit that fails leaves it pending; the flush then saves it.
    save.mockImplementationOnce(() => {
      throw new PersistenceError("saved_state_io", "still no space");
    });
    expect(() =>
      persister.commit(
        () => state([], { selection: { viewId: "a" } }),
        () => continuity(),
        "durable",
      ),
    ).toThrow(PersistenceError);
    expect(persister.pending).toBe(true);
    persister.flush();
    expect(persister.pending).toBe(false);
    expect(store.load(ROOT)?.selection).toEqual({ viewId: "a" });
  } finally {
    deactivate(telemetry);
  }
});

test("close saves what is deferred at once; a deferred commit after it is saved at once", () => {
  const store = new AccountStateStore(tempDir());
  const persister = new Persister(
    store,
    () => ROOT,
    () => {},
    { deferMs: 60_000 },
  );
  persister.commit(
    () => state([], { selection: { viewId: "a" } }),
    () => continuity(),
    "deferred",
  );
  expect(store.load(ROOT)).toBeNull();
  persister.close();
  expect(store.load(ROOT)?.selection).toEqual({ viewId: "a" });
  persister.commit(
    () => state([], { selection: { viewId: "b" } }),
    () => continuity(),
    "deferred",
  );
  expect(persister.pending).toBe(false);
  expect(store.load(ROOT)?.selection).toEqual({ viewId: "b" });
});
