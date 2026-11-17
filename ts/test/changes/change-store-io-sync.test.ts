import { afterEach, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const counter = vi.hoisted(() => ({ directories: 0, failNext: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync(fd: number) {
      if (actual.fstatSync(fd).isDirectory()) {
        if (counter.failNext) {
          counter.failNext = false;
          throw Object.assign(new Error("injected directory sync failure"), { code: "EIO" });
        }
        counter.directories++;
      }
      actual.fsyncSync(fd);
    },
  };
});
import { withChangeStoreIo } from "../../src/changes/io.ts";

const roots: string[] = [];
afterEach(() => {
  counter.directories = 0;
  counter.failNext = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function state(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-change-store-sync-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
const limits = { entries: 10, physicalBytes: 1024, snapshotBytes: 1024 };

// Regression (seen on CI): every store open synced the state and runtime directories,
// about 40 directory fsyncs per browser Save. On a congested disk one Save took 42 s and
// reads paid the same cost. A directory is made durable once; later opens only read.
test("reopening an existing store does not sync its directories again", () => {
  const stateDir = state();
  withChangeStoreIo(stateDir, (io) => io.ensureSnapshots());
  expect(counter.directories).toBeGreaterThan(0);
  counter.directories = 0;
  for (let i = 0; i < 5; i++)
    withChangeStoreIo(stateDir, (io) => {
      io.ensureSnapshots();
      io.inventory(limits);
    });
  expect(counter.directories).toBe(0);
  // A write still syncs its own publication.
  withChangeStoreIo(stateDir, (io) => io.writeBlob("a".repeat(64), Buffer.from("x")));
  expect(counter.directories).toBeGreaterThan(0);
});

test("a recreated store directory is synced again, and a failed sync is retried", () => {
  const stateDir = state();
  withChangeStoreIo(stateDir, (io) => io.ensureSnapshots(), "authoring");
  rmSync(join(stateDir, "runtime", "authoring"), { recursive: true });
  counter.directories = 0;
  withChangeStoreIo(stateDir, (io) => io.ensureSnapshots(), "authoring");
  expect(counter.directories).toBeGreaterThan(0);

  const fresh = state();
  counter.failNext = true;
  expect(() => withChangeStoreIo(fresh, (io) => io.inventory(limits), "authoring-presentations")).toThrow(
    /injected directory sync failure/,
  );
  counter.directories = 0;
  withChangeStoreIo(fresh, (io) => io.inventory(limits), "authoring-presentations");
  expect(counter.directories).toBeGreaterThan(0);
});
