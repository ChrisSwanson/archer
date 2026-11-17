import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import {
  AuthoringStore,
  AuthoringStoreError,
  AUTHORING_STORE_LIMITS,
  parseAuthoringIndex,
} from "../../src/authoring/store.ts";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function state() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "authoring-capacity-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
function store(root: string) {
  return new AuthoringStore({ stateDir: root, serviceName: "main", assertOwner() {} });
}
function capacity(action: () => unknown, limit: string) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthoringStoreError);
    expect((error as AuthoringStoreError).code).toBe("authoring_store_capacity");
    expect((error as Error).message).toContain(limit);
    return;
  }
  throw new Error("expected " + limit);
}
function sparse(path: string, bytes: number) {
  writeFileSync(path, "", { mode: 0o600 });
  truncateSync(path, bytes);
}
test("source exact limit is accepted and one byte beyond refuses", () => {
  const s = store(state()),
    bytes = Buffer.alloc(AUTHORING_STORE_LIMITS.sourceBytes, 65);
  const ref = s.putSnapshot(bytes);
  expect(s.readSnapshot(ref)).toEqual(bytes);
  expect(() => s.putSnapshot(Buffer.alloc(bytes.length + 1))).toThrow("sourceBytes");
});
test("snapshotBytes reservation counts retained orphan bytes and preserves existing snapshots", () => {
  const root = state(),
    s = store(root),
    ref = s.putSnapshot(Buffer.from("saved"));
  sparse(join(root, "runtime/authoring/snapshots", "f".repeat(64)), AUTHORING_STORE_LIMITS.snapshotBytes - ref.bytes);
  expect(s.putSnapshot(Buffer.from("saved"))).toEqual(ref);
  capacity(() => s.putSnapshot(Buffer.from("new")), "snapshotBytes");
  expect(s.readSnapshot(ref)).toEqual(Buffer.from("saved"));
});
test("physicalBytes includes private temporary metadata and reserves the prospective index", () => {
  const root = state(),
    s = store(root),
    index = join(root, "runtime/authoring/index.json"),
    initial = readFileSync(index);
  sparse(
    join(root, "runtime/authoring", ".index." + "f".repeat(32) + ".tmp"),
    AUTHORING_STORE_LIMITS.physicalBytes - initial.length - 1,
  );
  capacity(() => s.putSnapshot(Buffer.from("new")), "physicalBytes");
  expect(readFileSync(index)).toEqual(initial);
});
test("directoryEntries is bounded including orphans and reserves temporary publication entry", () => {
  const root = state(),
    s = store(root),
    index = join(root, "runtime/authoring/index.json"),
    initial = readFileSync(index);
  // index + snapshots directory + 8,190 owner-only orphan blobs = exactly 8,192.
  for (let n = 0; n < 8190; n++)
    writeFileSync(join(root, "runtime/authoring/snapshots", n.toString(16).padStart(64, "0")), "", { mode: 0o600 });
  capacity(() => s.putSnapshot(Buffer.from("new")), "directoryEntries");
  expect(readFileSync(index)).toEqual(initial);
}, 15000);
test("indexBytes bound refuses before JSON parsing", () => {
  expect(() => parseAuthoringIndex(Buffer.alloc(AUTHORING_STORE_LIMITS.indexBytes + 1, 32))).toThrow("indexBytes");
});
