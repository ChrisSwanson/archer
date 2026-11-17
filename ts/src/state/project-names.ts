/**
 * Readable project names for page addresses (`/projects/<name>/`, ADR 0017).
 *
 * A name is the project folder's name, lowercased with every other run of characters a hyphen (a linked git
 * worktree's is `<repository>-<folder>`, `project/repository.ts`); on a collision `-2`, `-3`, … follow. The allocation is private, service-wide state keyed by
 * absolute root: a root keeps its name across restarts and detach/re-attach, and a name
 * once recorded is never given to another root. A corrupt file fails closed.
 */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";
import { PersistenceError } from "./account.ts";
import { repositoryOf } from "../project/repository.ts";

export const MAX_PROJECT_NAMES = 4096;
export const MAX_PROJECT_NAMES_BYTES = 2 * 1024 * 1024;
const FILE = "project-names.json";
const MAX_NAME = 40;
const NAME = /^[a-z0-9][a-z0-9-]{0,239}$/;

interface NameRecord {
  readonly root: string;
  readonly name: string;
}
interface NamesFile {
  readonly version: 1;
  readonly names: readonly NameRecord[];
}

function fail(message: string, code = "invalid_saved_state"): never {
  throw new PersistenceError(code, message);
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The folder name, lower-cased, every other run of characters a hyphen; `project` when nothing is left. */
export function readableName(root: string): string {
  return readableSegment(basename(root));
}

/** `text` spelled as a page address segment, as `readableName` spells a folder name. */
export function readableSegment(text: string): string {
  const name = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME)
    .replace(/-+$/, "");
  return name === "" ? "project" : name;
}

/** Strict bounded parser: fixed depth, known fields, unique roots and names. */
export function parseProjectNames(text: string): NamesFile {
  if (Buffer.byteLength(text) > MAX_PROJECT_NAMES_BYTES)
    fail("project names exceed their byte limit", "saved_state_capacity");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("project names are not valid JSON");
  }
  if (
    !object(raw) ||
    raw.version !== 1 ||
    Object.keys(raw).some((key) => key !== "version" && key !== "names") ||
    !Array.isArray(raw.names)
  )
    fail("project names have an unsupported shape");
  if (raw.names.length > MAX_PROJECT_NAMES) fail("project names exceed their capacity", "saved_state_capacity");
  const roots = new Set<string>(),
    names = new Set<string>();
  for (const record of raw.names) {
    if (
      !object(record) ||
      Object.keys(record).length !== 2 ||
      typeof record.root !== "string" ||
      !isAbsolute(record.root) ||
      record.root.length > 4096 ||
      /[\u0000]/u.test(record.root) ||
      typeof record.name !== "string" ||
      !NAME.test(record.name) ||
      roots.has(record.root) ||
      names.has(record.name)
    )
      fail("project names contain an invalid or duplicate record");
    roots.add(record.root);
    names.add(record.name);
  }
  return raw as unknown as NamesFile;
}

/** Single writer: construct only while holding the service's state lock. */
export class ProjectNameStore {
  readonly path: string;
  #state: NamesFile;

  constructor(readonly stateDir: string) {
    this.path = join(stateDir, FILE);
    const bytes = readPrivate(this.path);
    this.#state = bytes === null ? { version: 1, names: [] } : parseProjectNames(bytes.toString("utf8"));
  }

  /**
   * The recorded name of `root`, allocating and durably recording one first if it has none:
   * `base` (default: the folder's readable name), suffixed on collision. A recorded name never
   * changes, whatever base later callers give.
   */
  nameFor(root: string, base = readableName(root)): string {
    const recorded = this.recorded(root);
    if (recorded !== undefined) return recorded;
    if (!isAbsolute(root)) fail("a project name needs an absolute root", "invalid_arguments");
    if (!NAME.test(base) || base.length > MAX_NAME)
      fail("a project name base must be a readable name", "invalid_arguments");
    if (this.#state.names.length >= MAX_PROJECT_NAMES)
      fail("project names reached their capacity", "saved_state_capacity");
    const taken = new Set(this.#state.names.map((record) => record.name));
    let name = base;
    for (let suffix = 2; taken.has(name); suffix++) name = `${base}-${suffix}`;
    const next: NamesFile = { version: 1, names: [...this.#state.names, { root, name }] };
    const text = JSON.stringify(next);
    parseProjectNames(text);
    atomic(this.path, Buffer.from(text));
    this.#state = next;
    return name;
  }

  /** The recorded name of `root`, if any; never allocates. */
  recorded(root: string): string | undefined {
    return this.#state.names.find((record) => record.root === root)?.name;
  }
}

function readPrivate(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail("project names cannot be read", "saved_state_io");
  }
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.size > MAX_PROJECT_NAMES_BYTES ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    )
      fail("project names file is unsafe or exceeds its limit", "saved_state_io");
    const bytes = Buffer.alloc(info.size);
    let used = 0;
    while (used < bytes.length) {
      const amount = readSync(fd, bytes, used, bytes.length - used, used);
      if (amount === 0) fail("project names changed during read", "saved_state_io");
      used += amount;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function atomic(path: string, bytes: Uint8Array): void {
  const directory = join(path, "..");
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  )
    fail("project names directory is not private", "saved_state_io");
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let used = 0;
    while (used < bytes.length) used += writeSync(fd, bytes, used, bytes.length - used);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const handle = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch (failure) {
    if (failure instanceof PersistenceError) throw failure;
    fail("project names could not be durably saved", "saved_state_io");
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* absent after rename */
    }
  }
}

/**
 * The readable page address a new project is given (before any collision suffix): its folder,
 * as before; a linked worktree's is `<repository>-<folder>`, so it reads as the repository's
 * and stays apart from the main checkout. A folder already starting with the repository's
 * name is used as it is.
 */
export function slugBase(root: string, repository = repositoryOf(root)): string {
  const folder = readableSegment(basename(root));
  if (repository?.worktree === undefined) return folder;
  const repo = readableSegment(repository.name);
  if (folder === repo || folder.startsWith(`${repo}-`)) return folder;
  return readableSegment(`${repo}-${folder}`);
}
