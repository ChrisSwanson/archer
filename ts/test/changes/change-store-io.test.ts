import {
  chmodSync,
  chownSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { withChangeStoreIo } from "../../src/changes/io.ts";
import { ChangeStoreError } from "../../src/changes/errors.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-change-store-io-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

test("creates snapshots only when explicitly requested", () => {
  const stateDir = state();
  withChangeStoreIo(stateDir, (io) => io.ensureSnapshots());
  expect(() =>
    withChangeStoreIo(stateDir, (io) => io.inventory({ entries: 3, physicalBytes: 1, snapshotBytes: 1 })),
  ).not.toThrow();
});

function expectCode(expected: string, action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ChangeStoreError);
    expect((error as ChangeStoreError).code).toBe(expected);
    return;
  }
  throw new Error(`expected ${expected}`);
}
// The process's open descriptors: Linux lists them under /proc/self/fd; macOS has no /proc but lists them under /dev/fd.
const descriptorDir = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const openDescriptors = () => readdirSync(descriptorDir).length;
const limits = { entries: 10, physicalBytes: 1024, snapshotBytes: 1024 };

test("reads exact bytes and publishes blobs without replacing immutable content", () => {
  const stateDir = state(),
    name = "a".repeat(64),
    exact = Buffer.from([0xef, 0xbb, 0xbf, 0x0d, 0x0a]);
  withChangeStoreIo(stateDir, (io) => {
    io.replaceIndex(Buffer.from("index\r\n"));
    io.ensureSnapshots();
    io.writeBlob(name, exact);
    expect(io.readIndex(7)).toEqual(Buffer.from("index\r\n"));
    expect(io.readSnapshot(name, exact.length)).toEqual(exact);
    io.writeBlob(name, exact);
    expectCode("change_store_invalid", () => io.writeBlob(name, Buffer.from("other")));
  });
});

test.each([
  ["symlink", (path: string, outside: string) => symlinkSync(outside, path)],
  ["directory", (path: string) => mkdirSync(path, { mode: 0o700 })],
  ["unsafe mode", (path: string) => writeFileSync(path, "bad", { mode: 0o644 })],
  [
    "hard link",
    (path: string, outside: string) => {
      writeFileSync(outside, "bad", { mode: 0o600 });
      linkSync(outside, path);
    },
  ],
])("refuses %s snapshot reads", (_label, damage) => {
  const stateDir = state(),
    outside = join(state(), "outside"),
    name = "b".repeat(64);
  withChangeStoreIo(stateDir, (io) => io.ensureSnapshots());
  damage(join(stateDir, "runtime/change-review/snapshots", name), outside);
  expectCode("change_store_invalid", () =>
    withChangeStoreIo(stateDir, (io) => {
      io.ensureSnapshots();
      io.readSnapshot(name, 100);
    }),
  );
});

test.runIf(process.getuid?.() === 0)("refuses a snapshot owned by another uid", () => {
  const stateDir = state(),
    name = "d".repeat(64),
    snapshot = join(stateDir, "runtime/change-review/snapshots", name);
  withChangeStoreIo(stateDir, (io) => io.ensureSnapshots());
  writeFileSync(snapshot, "bad", { mode: 0o600 });
  chownSync(snapshot, 1, 1);
  expectCode("change_store_invalid", () => withChangeStoreIo(stateDir, (io) => io.readSnapshot(name, 100)));
});

test("enforces exact read bounds", () => {
  const stateDir = state();
  withChangeStoreIo(stateDir, (io) => {
    io.replaceIndex(Buffer.from("123"));
    expectCode("change_store_limit", () => io.readIndex(2));
  });
});

test("recovers a crash between immutable link publication and temporary unlink", () => {
  const stateDir = state(),
    name = createHash("sha256").update("exact").digest("hex"),
    module = new URL("../../src/changes/io.ts", import.meta.url).href;
  withChangeStoreIo(stateDir, (io) => {
    io.replaceIndex(Buffer.from("valid authority"));
    io.ensureSnapshots();
  });
  const script = `import {withChangeStoreIo} from ${JSON.stringify(module)}; withChangeStoreIo(process.env.CHANGE_IO_STATE, io => { io.writeBlob(process.env.CHANGE_IO_NAME, Buffer.from("exact"), step => { if (step === "after_blob_link") process.exit(47); }); });`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    env: { ...process.env, CHANGE_IO_STATE: stateDir, CHANGE_IO_NAME: name },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.status).toBe(47);
  withChangeStoreIo(stateDir, (io) => {
    expectCode("change_store_limit", () =>
      io.inventory({ ...limits, entries: 3 }, { reconcileBlobPublications: true }),
    );
    expect(readdirSync(join(stateDir, "runtime/change-review/snapshots"))).toHaveLength(2);
    expect(io.inventory(limits)).toMatchObject({ entries: 4, snapshotBytes: 5 });
    expect(readdirSync(join(stateDir, "runtime/change-review/snapshots"))).toHaveLength(2);
    expect(io.inventory(limits, { reconcileBlobPublications: true })).toMatchObject({ entries: 3, snapshotBytes: 5 });
    io.writeBlob(name, Buffer.from("exact"));
    expectCode("change_store_invalid", () => io.writeBlob(name, Buffer.from("wrong")));
  });
}, 15_000);

test("does not reconcile an arbitrary external hard link", () => {
  const stateDir = state(),
    name = "f".repeat(64),
    outside = join(state(), "external");
  withChangeStoreIo(stateDir, (io) => io.ensureSnapshots());
  writeFileSync(outside, "external", { mode: 0o600 });
  linkSync(outside, join(stateDir, "runtime/change-review/snapshots", name));
  expectCode("change_store_invalid", () => withChangeStoreIo(stateDir, (io) => io.inventory(limits)));
});

test("refuses a publication pathname replaced after inventory validation", () => {
  const stateDir = state(),
    bytes = Buffer.from("race"),
    name = createHash("sha256").update(bytes).digest("hex"),
    module = new URL("../../src/changes/io.ts", import.meta.url).href;
  withChangeStoreIo(stateDir, (io) => {
    io.replaceIndex(Buffer.from("valid authority"));
    io.ensureSnapshots();
  });
  const script = `import {withChangeStoreIo} from ${JSON.stringify(module)}; withChangeStoreIo(process.env.CHANGE_IO_STATE, io => io.writeBlob(process.env.CHANGE_IO_NAME, Buffer.from("race"), step => { if (step === "after_blob_link") process.exit(48); }));`;
  expect(
    spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      env: { ...process.env, CHANGE_IO_STATE: stateDir, CHANGE_IO_NAME: name },
      encoding: "utf8",
      timeout: 10_000,
    }).status,
  ).toBe(48);
  const snapshots = join(stateDir, "runtime/change-review/snapshots"),
    temporary = readdirSync(snapshots).find((entry) => entry.startsWith(".blob."));
  expect(temporary).toBeDefined();
  expectCode("change_store_invalid", () =>
    withChangeStoreIo(stateDir, (io) =>
      io.inventory(limits, {
        reconcileBlobPublications: true,
        beforeBlobReconcile() {
          unlinkSync(join(snapshots, temporary!));
          writeFileSync(join(snapshots, temporary!), "replacement", { mode: 0o600 });
        },
      }),
    ),
  );
  expect(readFileSync(join(snapshots, temporary!), "utf8")).toBe("replacement");
  expect(readFileSync(join(snapshots, name))).toEqual(bytes);
}, 15_000);

test("cleans the temporary link after a native unlink failure and permits safe retry", () => {
  const stateDir = state(),
    bytes = Buffer.from("unlink failure"),
    name = createHash("sha256").update(bytes).digest("hex"),
    snapshots = join(stateDir, "runtime/change-review/snapshots"),
    module = new URL("../../src/changes/io.ts", import.meta.url).href;
  withChangeStoreIo(stateDir, (io) => {
    io.replaceIndex(Buffer.from("valid authority"));
    io.ensureSnapshots();
  });
  const script = `import {chmodSync} from "node:fs"; import {withChangeStoreIo} from ${JSON.stringify(module)}; withChangeStoreIo(process.env.CHANGE_IO_STATE, io => io.writeBlob(process.env.CHANGE_IO_NAME, Buffer.from("unlink failure"), step => { if (step === "after_blob_link") chmodSync(process.env.CHANGE_IO_SNAPSHOTS, 0o500); }));`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    env: { ...process.env, CHANGE_IO_STATE: stateDir, CHANGE_IO_NAME: name, CHANGE_IO_SNAPSHOTS: snapshots },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.status).not.toBe(0);
  chmodSync(snapshots, 0o700);
  expect(readdirSync(snapshots)).toHaveLength(2);
  withChangeStoreIo(stateDir, (io) => {
    expect(io.inventory(limits, { reconcileBlobPublications: true }).entries).toBe(3);
    io.writeBlob(name, bytes);
    expect(io.readSnapshot(name, bytes.length)).toEqual(bytes);
  });
}, 15_000);

test("refuses a replaced snapshots binding before native publication", () => {
  const stateDir = state(),
    snapshots = join(stateDir, "runtime/change-review/snapshots"),
    displaced = `${snapshots}.old`,
    name = "c".repeat(64);
  expectCode("change_store_io", () =>
    withChangeStoreIo(stateDir, (io) => {
      io.ensureSnapshots();
      io.writeBlob(name, Buffer.from("secret"), (step) => {
        if (step === "before_blob_publish") {
          renameSync(snapshots, displaced);
          mkdirSync(snapshots, { mode: 0o700 });
        }
      });
    }),
  );
  expect(readdirSync(snapshots)).toEqual([]);
  expect(readdirSync(displaced).some((entry) => entry === name)).toBe(false);
});

test("refuses a replaced store binding before index publication", () => {
  const stateDir = state(),
    store = join(stateDir, "runtime/change-review"),
    displaced = `${store}.old`;
  expectCode("change_store_io", () =>
    withChangeStoreIo(stateDir, (io) =>
      io.replaceIndex(Buffer.from("new"), (step) => {
        if (step === "before_index_publish") {
          renameSync(store, displaced);
          mkdirSync(store, { mode: 0o700 });
          writeFileSync(join(store, "sentinel"), "outside", { mode: 0o600 });
        }
      }),
    ),
  );
  expect(readFileSync(join(store, "sentinel"), "utf8")).toBe("outside");
  expect(readdirSync(displaced).includes("index.json")).toBe(false);
});

test("streams inventory through the exact entry limit and refuses one past", () => {
  const stateDir = state();
  withChangeStoreIo(stateDir, (io) => {
    io.replaceIndex(Buffer.alloc(0));
    io.ensureSnapshots();
    for (let index = 0; index < 3; index++) io.writeBlob(index.toString(16).padStart(64, "0"), Buffer.alloc(0));
    expect(io.inventory({ ...limits, entries: 5 }).entries).toBe(5);
    expectCode("change_store_limit", () => io.inventory({ ...limits, entries: 4 }));
  });
});

test("closes every operation-local descriptor after success and failure", () => {
  const before = openDescriptors(),
    stateDir = state();
  withChangeStoreIo(stateDir, (io) => io.ensureSnapshots());
  expect(openDescriptors()).toBe(before);
  expectCode("change_store_io", () =>
    withChangeStoreIo(stateDir, () => {
      throw new Error("injected");
    }),
  );
  expect(openDescriptors()).toBe(before);
});

test.each(["runtime", "runtime/change-review", "runtime/change-review/snapshots"])(
  "closes descriptors when unsafe %s validation fails",
  (path) => {
    const stateDir = state(),
      full = join(stateDir, path);
    mkdirSync(full, { recursive: true, mode: 0o700 });
    chmodSync(full, 0o755);
    const before = openDescriptors();
    expectCode("change_store_invalid", () => withChangeStoreIo(stateDir, () => undefined));
    expect(openDescriptors()).toBe(before);
  },
);
