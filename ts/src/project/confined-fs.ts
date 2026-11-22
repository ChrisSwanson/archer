/** Descriptor-anchored filesystem access: the one confined read/write seam (below) and the discovery walk. No untrusted path is followed. */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join, parse } from "node:path";
import { ProjectError, type ProjectErrorCode } from "./errors.ts";
import { folderOthersCanChange } from "./ownership.ts";

export class ConfinementUnavailable extends Error {}
export interface ConfinedHandle {
  readonly fd: number;
  readonly stat: Stats;
  readonly path: string;
}

/**
 * Node has no openat binding. A verified descriptor filesystem supplies its equivalent:
 * each untrusted component is opened separately with O_NOFOLLOW. Where none is verified
 * (macOS, the BSDs, Linux without /proc) the D7 path anchor is used instead: every segment
 * is lstat-ed before and after the open and the descriptor must be the same (dev, ino) as
 * the walk's last entry. That narrows the check-to-use window without closing it (ADR 0018,
 * amended 2026-10-31 and 2026-11-10; docs/security/known-limits.md §1). Handles are operation-local.
 */
export class ConfinedFileSystem {
  readonly #root: number;
  /** The descriptor filesystem segments are opened through; null on the path anchor. */
  readonly #descriptors: string | null;
  /** The path anchor's root, as opened: every walk starts by checking the root is still this directory. */
  readonly #rootStat: Stats | undefined;
  /**
   * Where a descriptor is now, as one syscall. On Linux /proc/self/fd/N is a magic link whose
   * text is the kernel's path of the open file (d_path): already canonical, so it equals what
   * realpath returns for it while the file is reachable, and a moved, unlinked (" (deleted)")
   * or replaced binding reads differently. realpath walks and lstats every component of that
   * path (JavaScript fs.realpathSync), which made the catalog's binding checks most of the
   * service's CPU. Elsewhere (/dev/fd) the full realpath is kept.
   */
  readonly #whereIs: (path: string) => string;
  constructor(readonly root: string) {
    if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY)
      throw new ConfinementUnavailable("no-follow directory opens unavailable");
    const anchor = parse(root).root;
    if (anchor !== "/") throw new ConfinementUnavailable("descriptor-relative discovery unavailable on this platform");
    let fd = openSync(anchor, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      let descriptors: string | undefined;
      for (const candidate of forcePathAnchors ? [] : ["/proc/self/fd", "/dev/fd"]) {
        let probe: number | undefined;
        try {
          probe = openSync(`${candidate}/${fd}/.`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const a = fstatSync(fd),
            b = fstatSync(probe);
          if (a.dev === b.dev && a.ino === b.ino && realpathSync(`${candidate}/${fd}`) === anchor) {
            descriptors = candidate;
            break;
          }
        } catch {
          /* A descriptor filesystem must support directory-relative suffixes and binding checks. */
        } finally {
          if (probe !== undefined) closeSync(probe);
        }
      }
      if (descriptors === undefined) {
        // The path anchor: the root itself must be a real path, no link on the way, opened as the walk saw it.
        closeSync(fd);
        fd = -1;
        const parts = root.slice(anchor.length).split("/").filter(Boolean);
        const walk = (): Stats[] => [lstatSync(anchor), ...lstatWalk(anchor, parts, true)];
        const before = walk();
        fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!sameFile(stat, before.at(-1)!) || !walk().every((entry, index) => sameFile(entry, before[index]!)))
          throw new ConfinementUnavailable("project root changed while opening");
        this.#descriptors = null;
        this.#rootStat = stat;
        this.#whereIs = realpathSync;
        this.#root = fd;
        return;
      }
      this.#descriptors = descriptors;
      this.#rootStat = undefined;
      // The one-syscall form only where the descriptor link is verified to name the anchor exactly.
      let link: string | undefined;
      if (descriptors === "/proc/self/fd")
        try {
          link = readlinkSync(`${descriptors}/${fd}`);
        } catch {
          /* keep realpath */
        }
      this.#whereIs = link === anchor ? readlinkSync : realpathSync;
      for (const part of root.slice(anchor.length).split("/").filter(Boolean)) {
        const next = openSync(
          `${descriptors}/${fd}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        closeSync(fd);
        fd = next;
      }
      this.#root = fd;
      if (!this.bound({ fd, stat: fstatSync(fd), path: "." }))
        throw new ConfinementUnavailable("project root changed while opening");
    } catch (error) {
      if (fd >= 0) closeSync(fd);
      throw error;
    }
  }
  /** Whether segments are opened from the descriptor before them (no check-to-use window), not by the path anchor. */
  get descriptorRelative(): boolean {
    return this.#descriptors !== null;
  }
  /** Before a change in folder `path` (relative to the root): on the path anchor, `refuseSharedFolders`. */
  refuseSharedFolders(path: string, shown = path): void {
    if (this.#descriptors === null) refuseSharedFolders(this.root, segments(path), shown);
  }
  close(): void {
    closeSync(this.#root);
  }
  /** Whether the anchor descriptor is still the directory its path names (not moved, unlinked or replaced). */
  valid(): boolean {
    if (this.#descriptors === null) {
      try {
        const anchor = parse(this.root).root;
        return sameFile(
          [lstatSync(anchor), ...lstatWalk(anchor, this.root.slice(anchor.length).split("/").filter(Boolean), true)].at(
            -1,
          )!,
          this.#rootStat!,
        );
      } catch {
        return false;
      }
    }
    try {
      return this.#whereIs(`${this.#descriptors}/${this.#root}`) === this.root;
    } catch {
      return false;
    }
  }
  /** A name for the open file or folder: its descriptor where the platform allows, else its confined path (checked by `bound`). */
  descriptorPath(handle: ConfinedHandle): string {
    if (this.#descriptors === null)
      return handle.path === "." || handle.path === "" ? this.root : join(this.root, ...handle.path.split("/"));
    return `${this.#descriptors}/${handle.fd}`;
  }
  /** Refuse moved handles and replacement bindings before and after consuming content. */
  bound(handle: ConfinedHandle): boolean {
    if (this.#descriptors === null) {
      try {
        return sameFile(this.#walk(segments(handle.path)).at(-1)!, handle.stat);
      } catch {
        return false;
      }
    }
    try {
      return (
        this.#whereIs(`${this.#descriptors}/${this.#root}`) === this.root &&
        this.#whereIs(this.descriptorPath(handle)) === join(this.root, handle.path)
      );
    } catch {
      return false;
    }
  }
  /** The path anchor's walk: the root (still the directory it opened), then each segment, no link, a folder on the way. */
  #walk(parts: readonly string[]): Stats[] {
    const top = lstatSync(this.root);
    if (!top.isDirectory() || !sameFile(top, this.#rootStat!)) throw new Error("source binding changed");
    return [top, ...lstatWalk(this.root, parts, false)];
  }
  open(path: string): ConfinedHandle {
    const parts = path === "." ? ["."] : path.split("/");
    // Callers validate paths; this defensive check also protects future consumers.
    if (
      parts.some((part) => part !== "." && (part === "" || part === ".." || /[\\/\0]/u.test(part))) ||
      (path !== "." && parts.includes("."))
    )
      throw new Error("invalid confined path");
    if (this.#descriptors === null) {
      const below = segments(path);
      const before = this.#walk(below);
      const fd = openSync(
        this.descriptorPath({ fd: -1, stat: before.at(-1)!, path }),
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      try {
        const stat = fstatSync(fd);
        let after: Stats[];
        try {
          after = this.#walk(below);
        } catch {
          throw new Error("source binding changed");
        }
        if (!sameFile(stat, before.at(-1)!) || !after.every((entry, index) => sameFile(entry, before[index]!)))
          throw new Error("source binding changed");
        return { fd, stat, path };
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    }
    let parent = this.#root;
    try {
      for (let at = 0; at < parts.length; at++) {
        const directory = at < parts.length - 1;
        const fd = openSync(
          `${this.#descriptors}/${parent}/${parts[at]!}`,
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0),
        );
        if (parent !== this.#root) closeSync(parent);
        parent = fd;
      }
      const handle = { fd: parent, stat: fstatSync(parent), path };
      if (!this.bound(handle)) throw new Error("source binding changed");
      parent = this.#root; // ownership transfers to the caller
      return handle;
    } finally {
      if (parent !== this.#root) closeSync(parent);
    }
  }
}

/** A confined path's segments below the root ("." is the root itself). */
const segments = (path: string): string[] => (path === "." || path === "" ? [] : path.split("/"));

/**
 * The path anchor's lstat walk of `parts` below the real directory `base`: a link anywhere is ELOOP (as
 * O_NOFOLLOW reports it), anything but a folder on the way ENOTDIR; `allDirectories` asks the last to be one too.
 */
function lstatWalk(base: string, parts: readonly string[], allDirectories: boolean): Stats[] {
  const seen: Stats[] = [];
  let at = base;
  for (const [index, part] of parts.entries()) {
    at = join(at, part);
    const entry = lstatSync(at);
    if (entry.isSymbolicLink()) throw errno("ELOOP", "a segment is a link");
    if ((allDirectories || index < parts.length - 1) && !entry.isDirectory())
      throw errno("ENOTDIR", "a segment is not a folder");
    seen.push(entry);
  }
  return seen;
}

// ------------------------------------------------------------------ the confined read/write seam
//
// Every reader and writer of a file inside a project goes through the functions below (security rubric
// H4; ADR 0018 and ADR 0028, both amended 2026-10-31). A caller names a real directory (the Archer
// folder's real path, or the project root) and the segments below it; the seam then:
//
// - reads: opens each segment without following a link (a directory for every one but the last), from
//   a descriptor of the directory before it; admits only a regular file with one name (nlink == 1: a
//   hard link is another name for a file that may live outside the project); checks the descriptor is
//   still bound to the confined path; and reads from that descriptor only, never by name again.
// - writes: opens the parent the same way, creates the temporary file inside that open directory,
//   checks the parent is still the confined directory, and publishes by a rename (or, exclusive, a
//   link) inside that same open directory. A parent that moved is refused and the temporary removed.
//
// On Linux a directory descriptor's entries are named `/proc/self/fd/<fd>/<name>`: the kernel resolves
// that magic link to the open directory itself, so each open, create, rename and unlink below is the
// equivalent of openat/renameat/unlinkat (Node has none of them). Where no verified descriptor
// filesystem exists (macOS, or Linux without /proc), a path anchor is used instead: an lstat walk of every
// segment before and after the open, compared by (dev, ino) with the descriptor. That narrows the
// check-to-use window to a few syscalls but cannot close it: see ADR 0018's amendment for what remains.

export type ConfinedRefusalReason = "link" | "hard_link" | "not_regular" | "moved" | "invalid" | "shared";

const REFUSALS: Readonly<Record<ConfinedRefusalReason, (shown: string, detail: string) => string>> = {
  link: (shown) =>
    `${shown} is reached through a link; Archer follows no link when it reads or writes a project file, since a link can lead outside the Archer folder`,
  hard_link: (shown, names) =>
    `${shown} has ${names} names (a hard link); Archer reads only a file with one name, since another name can be a file outside the Archer folder. Replace it with a copy`,
  not_regular: (shown) => `${shown} is not a regular file`,
  moved: (shown) => `${shown} moved while Archer was using it, so nothing was read or written there; try again`,
  invalid: (shown) => `${shown} is not a path inside the Archer folder`,
  shared: (shown, folder) =>
    `${shown} is under ${folder}, a folder another account can change (it is not yours, others can write to it, or it is a link). ` +
    `On this computer Archer cannot change files there safely, so nothing was changed. If the folder is yours, run: chmod go-w "${folder}"`,
};

/** The codes that are not a confinement refusal (`path_outside_archer_folder`). */
const REFUSAL_CODES: Partial<Record<ConfinedRefusalReason, ProjectErrorCode>> = {
  not_regular: "io_error",
  shared: "shared_folder",
};

/** A path the seam will not read or write: `path_outside_archer_folder`, or its `REFUSAL_CODES` entry. */
export class ConfinedRefusal extends ProjectError {
  constructor(
    readonly reason: ConfinedRefusalReason,
    shown: string,
    detail = "",
  ) {
    super(REFUSAL_CODES[reason] ?? "path_outside_archer_folder", REFUSALS[reason](shown, detail));
    this.name = "ConfinedRefusal";
  }
}
/** A file over the caller's limit; nothing past the limit was read. */
export class ConfinedTooLarge extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`the file is over ${limit} bytes`);
    this.name = "ConfinedTooLarge";
  }
}
/** A failure before the publication syscall; canonical source was not changed. */
export class ConfinedWriteRefusedError extends Error {
  readonly phase = "prepublication";
  readonly code: string;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "source preparation failed", { cause });
    this.code = (cause as NodeJS.ErrnoException)?.code ?? "source_refused";
  }
}
/** Publication was attempted; effect or durability is uncertain. Reconcile without rollback or replay. */
export class ConfinedWriteUncertainError extends Error {
  readonly code = "write_uncertain";
  constructor(
    readonly destination: string,
    cause: unknown,
  ) {
    super(`source publication at ${destination} could not be confirmed`, { cause });
  }
}
/** Complete byte writes before fsync/publication; short writes are permitted by write(2). */
export function writeAllSync(fd: number, text: string | Uint8Array): void {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset)
      throw Object.assign(new Error("source write made no valid progress"), { code: "EIO" });
    offset += count;
  }
}

interface Opened {
  readonly fd: number;
  readonly stat: Stats;
}
/** A real directory every confined path is opened from. */
interface Anchor {
  readonly dir: string;
  /** Opens `parts` (none: the anchor itself) following no link; `directory` asks the last to be a directory too. */
  open(parts: readonly string[], directory: boolean, shown: string): Opened;
  /** Whether `opened` is still the entry `parts` names under the anchor. */
  bound(opened: Opened, parts: readonly string[]): boolean;
  /**
   * A name for creating, renaming or removing `name` inside the opened directory `parts`: descriptor-relative
   * where the platform allows. The path anchor refuses one under a folder another account can change.
   */
  child(directory: Opened, parts: readonly string[], name: string, shown: string): string;
  /** Whether the anchor is still the directory at its path (else it is reopened). */
  valid(): boolean;
  close(): void;
}

const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean =>
  a.dev === b.dev && a.ino === b.ino;
const errno = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${message}`), { code });

/** Which refusal an open's failure was: a link on the way (ELOOP from O_NOFOLLOW), a moved binding, or the OS error itself. */
function classify(error: unknown, dir: string, parts: readonly string[], shown: string): unknown {
  if (error instanceof ConfinedRefusal) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ELOOP" || code === "EMLINK" || code === "EFTYPE") return new ConfinedRefusal("link", shown);
  if (code === "ENOTDIR") {
    // A link where a folder should be also fails O_DIRECTORY: name it as a link. This lstat only words the refusal.
    for (let at = 1; at <= parts.length; at++) {
      try {
        if (lstatSync(join(dir, ...parts.slice(0, at))).isSymbolicLink()) return new ConfinedRefusal("link", shown);
      } catch {
        break;
      }
    }
    return error;
  }
  if (error instanceof Error && error.message === "source binding changed") return new ConfinedRefusal("moved", shown);
  if (error instanceof Error && error.message === "invalid confined path") return new ConfinedRefusal("invalid", shown);
  return error;
}

/**
 * A `ConfinedFileSystem` held on the anchor folder. With a verified descriptor filesystem (Linux /proc/self/fd)
 * every segment is opened relative to the descriptor before it; elsewhere it is the path anchor, the lstat walk
 * around each open (docs/security/known-limits.md §1), and every name handed out for a change is refused under
 * a folder another account can change.
 */
class FolderAnchor implements Anchor {
  constructor(
    readonly dir: string,
    readonly fs: ConfinedFileSystem,
  ) {}
  open(parts: readonly string[], directory: boolean, shown: string): Opened {
    let handle: ConfinedHandle;
    try {
      handle = this.fs.open(parts.length === 0 ? "." : parts.join("/"));
    } catch (error) {
      throw classify(error, this.dir, parts, shown);
    }
    if (directory && !handle.stat.isDirectory()) {
      closeSync(handle.fd);
      throw errno("ENOTDIR", `${shown} is not a folder`);
    }
    return { fd: handle.fd, stat: handle.stat };
  }
  bound(opened: Opened, parts: readonly string[]): boolean {
    return this.fs.bound({ fd: opened.fd, stat: opened.stat, path: parts.length === 0 ? "." : parts.join("/") });
  }
  child(directory: Opened, parts: readonly string[], name: string, shown: string): string {
    this.fs.refuseSharedFolders(parts.join("/"), shown);
    return `${this.fs.descriptorPath({ fd: directory.fd, stat: directory.stat, path: parts.length === 0 ? "." : parts.join("/") })}/${name}`;
  }
  valid(): boolean {
    return this.fs.valid();
  }
  close(): void {
    this.fs.close();
  }
}

let descriptorsVerified: boolean | undefined;
let forcePathAnchors = false;
/** For tests: run the portable path anchor on this platform too. */
export function usePathAnchorsForTests(on: boolean): void {
  forcePathAnchors = on;
  for (const anchor of anchors.values()) anchor.close();
  anchors.clear();
}
/** Whether this process has a verified descriptor filesystem (probed once). */
export function descriptorConfinement(): boolean {
  if (forcePathAnchors) return false;
  if (descriptorsVerified === undefined) {
    try {
      const probe = new ConfinedFileSystem("/");
      descriptorsVerified = probe.descriptorRelative;
      probe.close();
    } catch {
      descriptorsVerified = false;
    }
  }
  return descriptorsVerified;
}

/** Anchors kept open between calls, each checked before use (moved, deleted or replaced: reopened). */
const anchors = new Map<string, Anchor>();
const MAX_ANCHORS = 16;
function anchorFor(dir: string, shown: string): Anchor {
  const held = anchors.get(dir);
  if (held !== undefined) {
    anchors.delete(dir);
    if (held.valid()) {
      anchors.set(dir, held);
      return held;
    }
    held.close();
  }
  let opened: ConfinedFileSystem;
  try {
    opened = new ConfinedFileSystem(dir);
  } catch (error) {
    // A failure here is the folder itself: a link on its way, moved, or missing.
    if (error instanceof ConfinementUnavailable) throw new ConfinedRefusal("moved", shown);
    throw classify(error, "/", dir.split("/").filter(Boolean), shown);
  }
  const anchor = new FolderAnchor(dir, opened);
  anchors.set(dir, anchor);
  if (anchors.size > MAX_ANCHORS) {
    const [oldest, evicted] = anchors.entries().next().value!;
    anchors.delete(oldest);
    evicted.close();
  }
  return anchor;
}

/**
 * Refuses a change in `dir`/`parts` when a folder from there up to `/` is one another account can change.
 * The path anchor's check-to-use window can be won only by swapping a folder on the path for a link, which
 * needs write access to that folder's parent: with every folder held by this account (or root), no other
 * account can (docs/security/known-limits.md §1). A descriptor anchor has no window and does not call it.
 */
export function refuseSharedFolders(dir: string, parts: readonly string[], shown: string): void {
  let shared: string | undefined;
  try {
    shared = folderOthersCanChange(join(dir, ...parts));
  } catch (error) {
    throw classify(error, dir, parts, shown);
  }
  if (shared !== undefined) throw new ConfinedRefusal("shared", shown, shared);
}

/** Refuses what is not a plain file with one name. */
function admitFile(stat: Stats, shown: string): void {
  if (!stat.isFile()) throw new ConfinedRefusal("not_regular", shown);
  if (stat.nlink !== 1) throw new ConfinedRefusal("hard_link", shown, String(stat.nlink));
}

export interface ConfinedReadOptions {
  /** Refuse (ConfinedTooLarge) a file over this many bytes, reading at most one byte past it. Unbounded when absent. */
  readonly limit?: number;
  /** The path as the caller's reader knows it, for refusals: never an absolute path. */
  readonly shown: string;
}

/**
 * The bytes of the regular, singly linked file `parts` names under the real directory `dir`, read from
 * the descriptor the confined walk opened. Throws ConfinedRefusal, ConfinedTooLarge, or the OS error
 * (ENOENT for a missing file).
 */
export function readConfined(dir: string, parts: readonly string[], options: ConfinedReadOptions): Buffer {
  return readConfinedFile(dir, parts, options).bytes;
}

/** How many times a read whose file was replaced meanwhile is taken again before it is refused: 8 still lost a read in 5,000 under the stress run's load (O65), where one attempt can stall across several saves. */
const REPLACED_READ_ATTEMPTS = 32;

/**
 * {@link readConfined}, with the descriptor's fstat taken at admission (mode, size). A writer saves by
 * renaming a new file over the name, so a reader can open the old file and then find the name on the new
 * one: that fails the binding check as "moved". The read is then taken again, through the whole confined
 * walk and every check, and refused only if it keeps failing (O65).
 */
export function readConfinedFile(
  dir: string,
  parts: readonly string[],
  options: ConfinedReadOptions,
): { readonly bytes: Buffer; readonly stat: Stats } {
  for (let attempt = 1; ; attempt++) {
    try {
      return readConfinedOnce(dir, parts, options);
    } catch (error) {
      if (!(error instanceof ConfinedRefusal && error.reason === "moved") || attempt >= REPLACED_READ_ATTEMPTS)
        throw error;
    }
  }
}

function readConfinedOnce(
  dir: string,
  parts: readonly string[],
  options: ConfinedReadOptions,
): { readonly bytes: Buffer; readonly stat: Stats } {
  const anchor = anchorFor(dir, options.shown);
  const opened = anchor.open(parts, false, options.shown);
  try {
    // No name left: a writer renamed a newer file over this one (or removed it) after the walk opened it.
    if (opened.stat.nlink === 0) throw new ConfinedRefusal("moved", options.shown);
    admitFile(opened.stat, options.shown);
    const { limit } = options;
    if (limit !== undefined && opened.stat.size > limit) throw new ConfinedTooLarge(opened.stat.size, limit);
    let bytes: Buffer;
    if (limit === undefined) bytes = readFileSync(opened.fd);
    else {
      const buffer = Buffer.alloc(opened.stat.size + 1);
      let length = 0;
      for (let count = -1; count !== 0 && length < buffer.length; length += count)
        count = readSync(opened.fd, buffer, length, buffer.length - length, null);
      if (length > limit) throw new ConfinedTooLarge(length, limit);
      bytes = buffer.subarray(0, length);
    }
    // Still the file the confined path names, and still its only name, after the bytes were taken.
    const after = fstatSync(opened.fd);
    if (after.nlink === 0) throw new ConfinedRefusal("moved", options.shown);
    if (after.nlink !== 1) throw new ConfinedRefusal("hard_link", options.shown, String(after.nlink));
    if (!anchor.bound(opened, parts)) throw new ConfinedRefusal("moved", options.shown);
    return { bytes, stat: opened.stat };
  } finally {
    closeSync(opened.fd);
  }
}

export interface ConfinedPublishOptions {
  /** fsync the parent directory after publication. */
  readonly syncDirectory?: boolean;
  /** Create only: fail with EEXIST rather than replace (publication by link(2), which never overwrites). */
  readonly exclusive?: boolean;
  /** The new file's mode when none exists to copy (default 0o644). */
  readonly mode?: number;
  /** How many random bytes (hex-encoded) name the temporary (default 6). */
  readonly randomBytes?: number;
}

/**
 * Writes `bytes` as `name` in the directory `parentParts` names under the real directory `dir`, never
 * through a link: the temporary is created inside the parent the confined walk opened, the parent is
 * checked again before publication, and the publication is a rename (or exclusive link) inside that same
 * parent. A destination that is a link, or has other names, is replaced as an entry: the other name and
 * the file it names keep their bytes. Returns the destination's absolute path.
 *
 * Throws ConfinedRefusal (parent a link, moved), ConfinedWriteRefusedError (before publication: nothing
 * changed) or ConfinedWriteUncertainError (the publication syscall ran or may have).
 */
export function publishConfined(
  dir: string,
  parentParts: readonly string[],
  name: string,
  bytes: Uint8Array | string,
  shown: string,
  options: ConfinedPublishOptions = {},
): string {
  if (name === "" || name === "." || name === ".." || /[\\/\0]/u.test(name))
    throw new ConfinedRefusal("invalid", shown);
  let anchor: Anchor, parent: Opened;
  try {
    anchor = anchorFor(dir, shown);
    parent = anchor.open(parentParts, true, shown);
  } catch (error) {
    throw error instanceof ConfinedRefusal ? error : new ConfinedWriteRefusedError(error);
  }
  const destination = join(dir, ...parentParts, name);
  try {
    const target = anchor.child(parent, parentParts, name, shown);
    let mode = options.mode ?? 0o644;
    if (!options.exclusive) {
      try {
        const existing = lstatSync(target);
        if (existing.isFile()) mode = existing.mode & 0o777;
      } catch {
        /* A new file. */
      }
    }
    const temporaryName = `.${name}.${randomBytes(options.randomBytes ?? 6).toString("hex")}.tmp`;
    const temporary = anchor.child(parent, parentParts, temporaryName, shown);
    let fd: number;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    } catch (cause) {
      throw new ConfinedWriteRefusedError(cause);
    }
    let created: Stats;
    try {
      writeAllSync(fd, bytes);
      fsyncSync(fd);
      created = fstatSync(fd);
    } catch (error) {
      // Cleanup cannot change the known prepublication phase or mask the primary failure.
      try {
        closeSync(fd);
      } catch {
        /* Preserve the write/fsync cause. */
      }
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* An inert temporary may remain. */
      }
      throw new ConfinedWriteRefusedError(error);
    }
    try {
      closeSync(fd);
    } catch (cause) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Preserve the close cause. */
      }
      throw new ConfinedWriteRefusedError(cause);
    }
    // The parent is still the confined folder, and the temporary is in it, immediately before publication.
    let inPlace = false;
    try {
      inPlace = sameFile(lstatSync(temporary), created);
    } catch {
      /* not there */
    }
    if (!inPlace || !anchor.bound(parent, parentParts)) {
      if (inPlace) {
        try {
          unlinkSync(temporary);
        } catch {
          /* An inert temporary may remain. */
        }
      }
      throw new ConfinedWriteRefusedError(new ConfinedRefusal("moved", shown));
    }
    if (options.exclusive) {
      try {
        linkSync(temporary, target);
      } catch (cause) {
        // no rename-over-file and no overwrite window
        try {
          rmSync(temporary, { force: true });
        } catch {
          /* An inert temporary may remain. */
        }
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new ConfinedWriteRefusedError(cause);
        throw new ConfinedWriteUncertainError(destination, cause);
      }
      try {
        unlinkSync(temporary);
      } catch (cause) {
        throw new ConfinedWriteUncertainError(destination, cause);
      }
    } else {
      try {
        renameSync(temporary, target);
      } catch (cause) {
        throw new ConfinedWriteUncertainError(destination, cause);
      }
    }
    if (options.syncDirectory) {
      try {
        fsyncSync(parent.fd);
      } catch (cause) {
        throw new ConfinedWriteUncertainError(destination, cause);
      }
    }
    // The file went into the open parent; if that parent was moved meanwhile, the path no longer names it.
    if (!anchor.bound(parent, parentParts))
      throw new ConfinedWriteUncertainError(destination, new ConfinedRefusal("moved", shown));
    return destination;
  } finally {
    try {
      closeSync(parent.fd);
    } catch {
      /* Preserve the primary result. */
    }
  }
}

/** Removes the entry `name` in the directory `parentParts` names under `dir` (absent: nothing to do), without following a link to reach it. */
export function removeConfined(dir: string, parentParts: readonly string[], name: string, shown: string): void {
  if (name === "" || name === "." || name === ".." || /[\\/\0]/u.test(name))
    throw new ConfinedRefusal("invalid", shown);
  const anchor = anchorFor(dir, shown);
  let parent: Opened;
  try {
    parent = anchor.open(parentParts, true, shown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    if (!anchor.bound(parent, parentParts)) throw new ConfinedRefusal("moved", shown);
    try {
      unlinkSync(anchor.child(parent, parentParts, name, shown));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    closeSync(parent.fd);
  }
}

/**
 * Makes the missing folders `parts` under `dir`, one at a time: each is created inside the folder just
 * opened by the confined walk, then opened itself without following a link, so a link or a file in the
 * way refuses instead of redirecting the write.
 */
export function ensureConfinedDirectories(
  dir: string,
  parts: readonly string[],
  shown: (at: number) => string,
  mode = 0o755,
): void {
  const anchor = anchorFor(dir, shown(0));
  let parent = anchor.open([], true, shown(0));
  try {
    for (let at = 0; at < parts.length; at++) {
      const prefix = parts.slice(0, at + 1);
      try {
        mkdirSync(anchor.child(parent, parts.slice(0, at), parts[at]!, shown(at)), { mode });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const next = anchor.open(prefix, true, shown(at + 1));
      closeSync(parent.fd);
      parent = next;
    }
  } finally {
    closeSync(parent.fd);
  }
}
