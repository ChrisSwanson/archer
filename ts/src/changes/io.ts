import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { ConfinedFileSystem, type ConfinedHandle } from "../project/confined-fs.ts";
import { ChangeStoreError } from "./errors.ts";

export type PrivateStoreArea = "change-review" | "authoring" | "authoring-presentations";

export interface ChangeStoreInventoryLimits {
  readonly entries: number;
  readonly physicalBytes: number;
  readonly snapshotBytes: number;
}
export interface ChangeStoreInventory {
  readonly entries: number;
  readonly physicalBytes: number;
  readonly snapshotBytes: number;
}
export interface ChangeStoreInventoryOptions {
  /** Set only after the caller has read and strictly validated index authority. */
  readonly reconcileBlobPublications?: boolean;
  /** Test seam immediately before publication pathnames are reopened. */
  readonly beforeBlobReconcile?: () => void;
}
export type ChangeStoreIoStep =
  | "before_blob_publish"
  | "after_blob_link"
  | "after_blob_publish"
  | "before_index_publish"
  | "after_index_publish"
  | "after_index_sync";
export type ChangeStoreIoHook = (step: ChangeStoreIoStep) => void;
export interface ChangeStoreIo {
  ensureSnapshots(): void;
  readIndex(maxBytes: number): Buffer;
  existsIndex(): boolean;
  readSnapshot(name: string, maxBytes: number): Buffer;
  existsSnapshot(name: string): boolean;
  inventory(limits: ChangeStoreInventoryLimits, options?: ChangeStoreInventoryOptions): ChangeStoreInventory;
  writeBlob(name: string, bytes: Uint8Array, hook?: ChangeStoreIoHook): void;
  replaceIndex(bytes: Uint8Array, hook?: ChangeStoreIoHook): void;
  syncOpenBindings(): void;
}

const fail = (code: string, message: string): never => {
  throw new ChangeStoreError(code, message);
};
const currentUid = (): number | undefined => process.getuid?.();
function privateDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (currentUid() !== undefined && stat.uid !== currentUid()))
    fail("change_store_invalid", `${label} is not a private owner directory`);
}
function privateFile(stat: Stats, label: string, links = 1): void {
  if (
    !stat.isFile() ||
    stat.nlink !== links ||
    (stat.mode & 0o077) !== 0 ||
    (currentUid() !== undefined && stat.uid !== currentUid())
  )
    fail("change_store_invalid", `${label} is not a private owner regular file`);
}
function close(handle: ConfinedHandle | undefined): void {
  if (handle !== undefined) closeSync(handle.fd);
}
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (count <= 0) fail("change_store_io", "change-store write made no progress");
    offset += count;
  }
}

class OperationIo implements ChangeStoreIo {
  #snapshots: ConfinedHandle | undefined;
  constructor(
    readonly fs: ConfinedFileSystem,
    readonly state: ConfinedHandle,
    readonly runtime: ConfinedHandle,
    readonly store: ConfinedHandle,
    readonly area: PrivateStoreArea,
  ) {}
  openExistingSnapshots(): void {
    let snapshots: ConfinedHandle | undefined;
    try {
      snapshots = this.fs.open(`runtime/${this.area}/snapshots`);
      privateDirectory(snapshots.stat, "snapshot directory");
      this.#snapshots = snapshots;
      snapshots = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      close(snapshots);
    }
  }
  close(): void {
    close(this.#snapshots);
    close(this.store);
    close(this.runtime);
    close(this.state);
    this.fs.close();
  }
  #assertBound(includeSnapshots = this.#snapshots !== undefined): void {
    if (
      !this.fs.bound(this.state) ||
      !this.fs.bound(this.runtime) ||
      !this.fs.bound(this.store) ||
      (includeSnapshots && (this.#snapshots === undefined || !this.fs.bound(this.#snapshots)))
    )
      fail("change_store_io", "change-store directory binding changed");
  }
  #path(handle: ConfinedHandle, name = ""): string {
    return `${this.fs.descriptorPath(handle)}/${name}`;
  }
  /** Whether `name` in the still-bound `parent` is the file `stat` describes. */
  #holds(parent: ConfinedHandle, name: string, stat: Stats, snapshots: boolean): boolean {
    try {
      this.#assertBound(snapshots);
      const now = lstatSync(this.#path(parent, name));
      return now.isFile() && now.dev === stat.dev && now.ino === stat.ino;
    } catch {
      return false;
    }
  }
  /**
   * Creates a temporary (exclusive, no link at the end) and proves the parent still holds it before a
   * byte is written. Where `descriptorPath` is a plain path (no descriptor filesystem), a parent swapped
   * after the last check would otherwise receive the whole file (ADR 0018, amended 2026-11-10).
   */
  #create(parent: ConfinedHandle, name: string, snapshots: boolean): { fd: number; stat: Stats } {
    this.#assertBound(snapshots);
    const fd = openSync(
      this.#path(parent, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (!this.#holds(parent, name, stat, snapshots))
        fail("change_store_io", "change-store directory binding changed");
      return { fd, stat };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  ensureSnapshots(): void {
    this.#assertBound(false);
    if (this.#snapshots !== undefined) return;
    let created = true;
    try {
      mkdirSync(this.#path(this.store, "snapshots"), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      created = false;
    }
    const snapshots = (this.#snapshots = this.fs.open(`runtime/${this.area}/snapshots`));
    privateDirectory(snapshots.stat, "snapshot directory");
    this.#assertBound();
    syncOnce(snapshots, created, () => {
      fsyncSync(this.store.fd);
      fsyncSync(snapshots.fd);
    });
    this.#assertBound();
  }
  #requireSnapshots(): ConfinedHandle {
    const snapshots = this.#snapshots;
    if (snapshots === undefined) throw new ChangeStoreError("change_store_invalid", "snapshot directory is missing");
    return snapshots;
  }
  #read(parent: ConfinedHandle, name: string, maxBytes: number, label: string, links = 1): Buffer {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail("change_store_limit", `${label} byte limit is invalid`);
    this.#assertBound(parent === this.#snapshots);
    let fd: number | undefined;
    try {
      fd = openSync(this.#path(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd);
      privateFile(before, label, links);
      if (before.size > maxBytes) fail("change_store_limit", `${label} exceeds its byte limit`);
      const result = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < result.length) {
        const count = readSync(fd, result, offset, result.length - offset, offset);
        if (count === 0) fail("change_store_invalid", `${label} ended before its declared size`);
        offset += count;
      }
      const after = fstatSync(fd);
      privateFile(after, label, links);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size)
        fail("change_store_invalid", `${label} changed while reading`);
      this.#assertBound(parent === this.#snapshots);
      return result;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") fail("change_store_invalid", `${label} is missing`);
      if (code === "ELOOP") fail("change_store_invalid", `${label} is a symbolic link`);
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  readIndex(maxBytes: number): Buffer {
    return this.#read(this.store, "index.json", maxBytes, "change-store index");
  }
  existsIndex(): boolean {
    return this.#exists(this.store, "index.json", "change-store index", false);
  }
  #validSnapshotName(name: string): void {
    if (!/^[0-9a-f]{64}$/u.test(name)) fail("change_store_invalid", "invalid snapshot name");
  }
  readSnapshot(name: string, maxBytes: number): Buffer {
    this.#validSnapshotName(name);
    return this.#read(this.#requireSnapshots(), name, maxBytes, "snapshot");
  }
  existsSnapshot(name: string): boolean {
    this.#validSnapshotName(name);
    return this.#exists(this.#requireSnapshots(), name, "snapshot", true);
  }
  #exists(parent: ConfinedHandle, name: string, label: string, snapshots: boolean): boolean {
    this.#assertBound(snapshots);
    let fd: number | undefined;
    try {
      fd = openSync(this.#path(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      privateFile(fstatSync(fd), label);
      this.#assertBound(snapshots);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#assertBound(snapshots);
        return false;
      }
      if ((error as NodeJS.ErrnoException).code === "ELOOP")
        fail("change_store_invalid", `${label} is a symbolic link`);
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  inventory(limits: ChangeStoreInventoryLimits, options: ChangeStoreInventoryOptions = {}): ChangeStoreInventory {
    for (const [name, value] of Object.entries(limits))
      if (!Number.isSafeInteger(value) || value < 0) fail("change_store_limit", `${name} limit is invalid`);
    this.#assertBound();
    let entries = 0,
      physicalBytes = 0,
      snapshotBytes = 0;
    const linked = new Map<string, Array<{ name: string; stat: Stats }>>();
    const count = (size: number, snapshot: boolean, entryDelta = 1): void => {
      entries += entryDelta;
      physicalBytes += size;
      if (snapshot) snapshotBytes += size;
      if (entries > limits.entries) fail("change_store_limit", "change store exceeds directoryEntries");
      if (physicalBytes > limits.physicalBytes) fail("change_store_limit", "change store exceeds physicalBytes");
      if (snapshotBytes > limits.snapshotBytes) fail("change_store_limit", "change store exceeds snapshotBytes");
    };
    const scan = (directory: ConfinedHandle, snapshot: boolean): void => {
      const stream = opendirSync(this.#path(directory));
      // A path-anchored stream is checked as it is read: a folder swapped in for the whole scan is refused.
      const check = (): void => {
        if (!this.fs.bound(directory)) fail("change_store_io", "change-store directory binding changed");
      };
      try {
        check();
        for (;;) {
          const entry = stream.readSync();
          if (entry === null) break;
          if (!this.fs.descriptorRelative) check();
          let fd: number | undefined;
          try {
            fd = openSync(
              this.#path(directory, entry.name),
              constants.O_RDONLY |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK |
                (entry.isDirectory() ? constants.O_DIRECTORY : 0),
            );
            const stat = fstatSync(fd);
            if (stat.isDirectory()) {
              privateDirectory(stat, "change-store entry");
              const snapshots = this.#snapshots;
              if (snapshot || entry.name !== "snapshots" || snapshots === undefined)
                throw new ChangeStoreError("change_store_invalid", "unknown change-store directory");
              count(0, false);
              scan(snapshots, true);
            } else {
              const valid = snapshot
                ? /^[0-9a-f]{64}$/u.test(entry.name) || /^\.blob\.[0-9a-f]{32}\.tmp$/u.test(entry.name)
                : entry.name === "index.json" || /^\.index\.[0-9a-f]{32}\.tmp$/u.test(entry.name);
              if (!valid) fail("change_store_invalid", "unknown change-store entry");
              if (snapshot && stat.nlink === 2) {
                privateFile(stat, "change-store entry", 2);
                count(0, true);
                const key = `${stat.dev}:${stat.ino}`;
                const group = linked.get(key) ?? [];
                group.push({ name: entry.name, stat });
                linked.set(key, group);
              } else {
                privateFile(stat, "change-store entry");
                count(stat.size, snapshot);
              }
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ELOOP")
              fail("change_store_invalid", "change-store entry is a symbolic link");
            throw error;
          } finally {
            if (fd !== undefined) closeSync(fd);
          }
        }
      } finally {
        stream.closeSync();
      }
    };
    scan(this.store, false);
    if (linked.size > 0) {
      const snapshots = this.#requireSnapshots();
      for (const group of linked.values()) {
        const destination = group.find((entry) => /^[0-9a-f]{64}$/u.test(entry.name));
        const temporary = group.find((entry) => /^\.blob\.[0-9a-f]{32}\.tmp$/u.test(entry.name));
        if (group.length !== 2 || destination === undefined || temporary === undefined)
          throw new ChangeStoreError("change_store_invalid", "snapshot has unrecognized hard links");
        const bytes = this.#read(snapshots, destination.name, limits.snapshotBytes, "snapshot publication", 2);
        if (createHash("sha256").update(bytes).digest("hex") !== destination.name)
          fail("change_store_invalid", "snapshot publication digest does not match");
        count(destination.stat.size, true, 0);
        if (options.reconcileBlobPublications === true) {
          options.beforeBlobReconcile?.();
          this.#assertBound();
          let destinationFd: number | undefined, temporaryFd: number | undefined;
          try {
            destinationFd = openSync(
              this.#path(snapshots, destination.name),
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            temporaryFd = openSync(
              this.#path(snapshots, temporary.name),
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            const destinationNow = fstatSync(destinationFd),
              temporaryNow = fstatSync(temporaryFd);
            privateFile(destinationNow, "snapshot publication", 2);
            privateFile(temporaryNow, "snapshot publication temporary", 2);
            if (
              destinationNow.dev !== destination.stat.dev ||
              destinationNow.ino !== destination.stat.ino ||
              temporaryNow.dev !== destination.stat.dev ||
              temporaryNow.ino !== destination.stat.ino
            )
              fail("change_store_invalid", "snapshot publication binding changed");
            this.#assertBound();
            unlinkSync(this.#path(snapshots, temporary.name));
            const published = fstatSync(destinationFd);
            privateFile(published, "snapshot publication");
            if (published.dev !== destination.stat.dev || published.ino !== destination.stat.ino)
              fail("change_store_invalid", "snapshot publication binding changed");
          } finally {
            if (temporaryFd !== undefined) closeSync(temporaryFd);
            if (destinationFd !== undefined) closeSync(destinationFd);
          }
          fsyncSync(snapshots.fd);
          this.#assertBound();
          entries--;
        }
      }
    }
    this.#assertBound();
    return { entries, physicalBytes, snapshotBytes };
  }
  writeBlob(name: string, bytes: Uint8Array, hook?: ChangeStoreIoHook): void {
    this.#validSnapshotName(name);
    const snapshots = this.#requireSnapshots();
    if (this.existsSnapshot(name)) {
      const existing = this.readSnapshot(name, bytes.byteLength);
      if (!existing.equals(Buffer.from(bytes))) fail("change_store_invalid", "existing snapshot bytes differ");
      return;
    }
    this.#publish(snapshots, `.blob.${randomBytes(16).toString("hex")}.tmp`, name, bytes, false, hook);
  }
  replaceIndex(bytes: Uint8Array, hook?: ChangeStoreIoHook): void {
    this.#publish(this.store, `.index.${randomBytes(16).toString("hex")}.tmp`, "index.json", bytes, true, hook);
  }
  #publish(
    parent: ConfinedHandle,
    temporary: string,
    destination: string,
    bytes: Uint8Array,
    replace: boolean,
    hook?: ChangeStoreIoHook,
  ): void {
    const snapshots = parent === this.#snapshots;
    this.#assertBound(snapshots);
    const tempPath = this.#path(parent, temporary),
      destinationPath = this.#path(parent, destination);
    let fd: number | undefined, created: Stats | undefined;
    try {
      ({ fd, stat: created } = this.#create(parent, temporary, snapshots));
      writeAll(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      hook?.(replace ? "before_index_publish" : "before_blob_publish");
      this.#assertBound(snapshots);
      if (replace) {
        renameSync(tempPath, destinationPath);
        created = undefined;
      } else {
        linkSync(tempPath, destinationPath);
        hook?.("after_blob_link");
        if (!this.#holds(parent, temporary, created, snapshots))
          fail("change_store_io", "change-store directory binding changed");
        unlinkSync(tempPath);
        created = undefined;
      }
      this.#assertBound(parent === this.#snapshots);
      hook?.(replace ? "after_index_publish" : "after_blob_publish");
      fsyncSync(parent.fd);
      this.#assertBound(parent === this.#snapshots);
      if (replace) hook?.("after_index_sync");
    } catch (error) {
      if (!replace && (error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = this.#read(parent, destination, bytes.byteLength, "snapshot");
        if (existing.equals(Buffer.from(bytes))) return;
      }
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      // Only a temporary the bound parent still holds is removed; a name behind a changed binding is left.
      if (created !== undefined && this.#holds(parent, temporary, created, snapshots)) {
        try {
          unlinkSync(tempPath);
        } catch {
          /* retain primary error */
        }
      }
    }
  }
  syncOpenBindings(): void {
    this.#assertBound();
    for (const handle of [this.state, this.runtime, this.store, this.#snapshots])
      if (handle !== undefined) fsyncSync(handle.fd);
    this.#assertBound();
  }
}

/**
 * Store directories this process has already made durable, by identity. A new directory's
 * entry is synced into its parent once, the first time this process sees it (it may have
 * been created by a process that stopped before syncing). Syncing on every open made each
 * read and write pay two directory fsyncs: about 40 per browser Save, which took 42 s on a
 * congested CI disk and blocked the event loop.
 */
const durableDirectories = new Set<string>();
/** Runs `sync` unless this directory was already made durable here; a failed sync is retried next time. */
function syncOnce(child: ConfinedHandle, created: boolean, sync: () => void): void {
  const key = `${child.stat.dev}:${child.stat.ino}`;
  if (!created && durableDirectories.has(key)) return;
  sync();
  durableDirectories.add(key);
}

function ensureChild(fs: ConfinedFileSystem, parent: ConfinedHandle, path: string, name: string): ConfinedHandle {
  if (!fs.bound(parent)) fail("change_store_io", "change-store parent binding changed");
  let created = true;
  try {
    mkdirSync(`${fs.descriptorPath(parent)}/${name}`, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    created = false;
  }
  const child = fs.open(path);
  try {
    privateDirectory(child.stat, path);
    if (!fs.bound(parent) || !fs.bound(child)) fail("change_store_io", "change-store directory binding changed");
    syncOnce(child, created, () => fsyncSync(parent.fd));
    return child;
  } catch (error) {
    close(child);
    throw error;
  }
}

export function withChangeStoreIo<T>(
  stateDir: string,
  callback: (io: ChangeStoreIo) => T,
  area: PrivateStoreArea = "change-review",
): T {
  if (area !== "change-review" && area !== "authoring" && area !== "authoring-presentations")
    fail("change_store_invalid", "unknown private store area");
  let fs: ConfinedFileSystem | undefined,
    state: ConfinedHandle | undefined,
    runtime: ConfinedHandle | undefined,
    store: ConfinedHandle | undefined;
  try {
    fs = new ConfinedFileSystem(stateDir);
    state = fs.open(".");
    privateDirectory(state.stat, "state directory");
    runtime = ensureChild(fs, state, "runtime", "runtime");
    store = ensureChild(fs, runtime, `runtime/${area}`, area);
    const operation = new OperationIo(fs, state, runtime, store, area);
    operation.openExistingSnapshots();
    fs = undefined;
    state = undefined;
    runtime = undefined;
    store = undefined;
    try {
      return callback(operation);
    } finally {
      operation.close();
    }
  } catch (error) {
    if (error instanceof ChangeStoreError) throw error;
    throw new ChangeStoreError("change_store_io", error instanceof Error ? error.message : "change-store I/O failed");
  } finally {
    close(store);
    close(runtime);
    close(state);
    fs?.close();
  }
}
