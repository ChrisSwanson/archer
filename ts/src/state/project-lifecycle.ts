/** Private service state for project visibility. Attachment remains owned by account.ts. */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { PersistenceError } from "./account.ts";

export const PROJECT_EMPTY_GRACE_MS = 10 * 60 * 1_000;
export const MAX_PROJECT_LIFECYCLE_BYTES = 2 * 1024 * 1024;
/** Root object (0), projects array (1), record (2), scalar fields (3). */
export const MAX_PROJECT_LIFECYCLE_DEPTH = 3;
export const MAX_PROJECT_LIFECYCLE_VALUES = 4096;
const MAX_PROJECTS = 256;

export type ProjectContent = "content" | "empty" | "unknown";
export type ProjectVisibility = "auto" | "visible" | "hidden";
export interface ProjectLifecycleMetadata {
  readonly state: "active" | "grace" | "inactive" | "unknown";
  readonly visibility: ProjectVisibility;
  readonly reason?: "empty" | "manual";
  readonly emptySince?: string;
}

interface ProjectLifecycleRecord {
  readonly root: string;
  readonly firstObservedAt: string;
  readonly emptySince?: string;
  readonly everHadContent: boolean;
  readonly automaticEligible: boolean;
  readonly visibility: ProjectVisibility;
}
interface ProjectLifecycleFile {
  readonly version: 1;
  readonly projects: readonly ProjectLifecycleRecord[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const visibility = (value: unknown): value is ProjectVisibility =>
  value === "auto" || value === "visible" || value === "hidden";
function fail(message: string, code = "invalid_saved_state"): never {
  throw new PersistenceError(code, message);
}

/** Strict bounded parser for the independent lifecycle file. */
export function parseProjectLifecycle(text: string): ProjectLifecycleFile {
  if (Buffer.byteLength(text) > MAX_PROJECT_LIFECYCLE_BYTES)
    fail(`project lifecycle state exceeds ${MAX_PROJECT_LIFECYCLE_BYTES} bytes`, "saved_state_capacity");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("project lifecycle state is not valid JSON");
  }
  const pending: { value: unknown; depth: number }[] = [{ value: raw, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (++count > MAX_PROJECT_LIFECYCLE_VALUES)
      fail("project lifecycle state exceeds its value limit", "saved_state_capacity");
    if (depth > MAX_PROJECT_LIFECYCLE_DEPTH)
      fail(`project lifecycle state exceeds depth ${MAX_PROJECT_LIFECYCLE_DEPTH}`, "saved_state_depth");
    if (value !== null && typeof value === "object")
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  if (!object(raw)) fail("project lifecycle state is incompatible or exceeds its project limit");
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.projects) ||
    raw.projects.length > MAX_PROJECTS ||
    Object.keys(raw).some((key) => key !== "version" && key !== "projects")
  )
    fail("project lifecycle state is incompatible or exceeds its project limit");
  const roots = new Set<string>();
  for (const project of raw.projects) {
    if (
      !object(project) ||
      typeof project.root !== "string" ||
      !isAbsolute(project.root) ||
      roots.has(project.root) ||
      !iso(project.firstObservedAt) ||
      (project.emptySince !== undefined && !iso(project.emptySince)) ||
      typeof project.everHadContent !== "boolean" ||
      typeof project.automaticEligible !== "boolean" ||
      !visibility(project.visibility) ||
      Object.keys(project).some(
        (key) =>
          !["root", "firstObservedAt", "emptySince", "everHadContent", "automaticEligible", "visibility"].includes(key),
      )
    )
      fail("project lifecycle record is malformed");
    roots.add(project.root);
  }
  return raw as unknown as ProjectLifecycleFile;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return fail("project lifecycle directory cannot be inspected", "saved_state_io");
  }
  if (
    !info.isDirectory() ||
    (process.getuid !== undefined && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  )
    fail("project lifecycle directory is not private", "saved_state_io");
}

function readPrivate(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail("project lifecycle state cannot be read", "saved_state_io");
  }
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.size > MAX_PROJECT_LIFECYCLE_BYTES ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    )
      fail("project lifecycle state file is unsafe or exceeds its limit", "saved_state_io");
    const bytes = Buffer.alloc(info.size);
    let used = 0;
    while (used < bytes.length) {
      const amount = readSync(fd, bytes, used, bytes.length - used, used);
      if (amount === 0) fail("project lifecycle state changed during read", "saved_state_io");
      used += amount;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

class LifecycleCommitError extends PersistenceError {
  constructor(
    message: string,
    readonly renamed: boolean,
  ) {
    super("saved_state_io", message);
  }
}

function atomic(path: string, bytes: Uint8Array): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let used = 0;
    while (used < bytes.length) {
      const amount = writeSync(fd, bytes, used, bytes.length - used);
      if (amount <= 0) fail("project lifecycle state write made no progress", "saved_state_io");
      used += amount;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    renamed = true;
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (failure) {
    if (failure instanceof PersistenceError) throw failure;
    throw new LifecycleCommitError("project lifecycle state could not be durably committed", renamed);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* absent after rename */
    }
  }
}

export class ProjectLifecycleStore {
  readonly directory: string;
  readonly path: string;
  readonly #now: () => number;
  #state: ProjectLifecycleFile;

  constructor(stateDir: string, now: () => number = Date.now) {
    const directory = join(stateDir, "runtime");
    privateDirectory(directory);
    this.directory = directory;
    this.path = join(directory, "project-lifecycle.json");
    this.#now = now;
    const bytes = readPrivate(this.path);
    this.#state = bytes === null ? { version: 1, projects: [] } : parseProjectLifecycle(bytes.toString("utf8"));
  }

  observe(root: string, content: ProjectContent, automaticEligible: boolean): ProjectLifecycleMetadata {
    const at = new Date(this.#now()).toISOString();
    const before = this.#state.projects.find((project) => project.root === root);
    let after: ProjectLifecycleRecord;
    if (before === undefined) {
      if (this.#state.projects.length >= MAX_PROJECTS)
        fail("project lifecycle state exceeds its project limit", "saved_state_capacity");
      after = {
        root,
        firstObservedAt: at,
        everHadContent: content === "content",
        automaticEligible,
        visibility: "auto",
        ...(content === "empty" ? { emptySince: at } : {}),
      };
    } else if (content === "content" && (!before.everHadContent || before.emptySince !== undefined)) {
      const { emptySince: _emptySince, ...record } = before;
      after = { ...record, everHadContent: true };
    } else if (content === "empty" && !before.everHadContent && before.emptySince === undefined) {
      after = { ...before, emptySince: at };
    } else after = before;
    if (after !== before) this.#replace(before, after);
    return this.#metadata(after, content);
  }

  setVisibility(root: string, next: ProjectVisibility, content: ProjectContent): ProjectLifecycleMetadata | null {
    const before = this.#state.projects.find((project) => project.root === root);
    if (before === undefined) return null;
    const after = before.visibility === next ? before : { ...before, visibility: next };
    if (after !== before) this.#replace(before, after);
    return this.#metadata(after, content);
  }

  #replace(before: ProjectLifecycleRecord | undefined, after: ProjectLifecycleRecord): void {
    privateDirectory(this.directory);
    const projects =
      before === undefined
        ? [...this.#state.projects, after]
        : this.#state.projects.map((project) => (project === before ? after : project));
    const next = { version: 1 as const, projects };
    const text = JSON.stringify(next);
    parseProjectLifecycle(text);
    try {
      atomic(this.path, Buffer.from(text));
    } catch (failure) {
      // rename is already the visible authority even when directory fsync
      // cannot confirm crash durability. Keep this process consistent with it
      // while refusing the acknowledgement.
      if (failure instanceof LifecycleCommitError && failure.renamed) this.#state = next;
      throw failure;
    }
    this.#state = next;
  }

  #metadata(record: ProjectLifecycleRecord, content: ProjectContent): ProjectLifecycleMetadata {
    const emptySince = record.emptySince === undefined ? {} : { emptySince: record.emptySince };
    if (record.visibility === "hidden")
      return { state: "inactive", visibility: "hidden", reason: "manual", ...emptySince };
    if (record.visibility === "visible")
      return { state: "active", visibility: "visible", reason: "manual", ...emptySince };
    if (content === "content" || record.everHadContent) return { state: "active", visibility: "auto" };
    if (content === "unknown" || !record.automaticEligible || record.emptySince === undefined)
      return { state: "unknown", visibility: "auto", ...emptySince };
    const elapsed = this.#now() - Date.parse(record.emptySince);
    return {
      state: elapsed >= PROJECT_EMPTY_GRACE_MS ? "inactive" : "grace",
      visibility: "auto",
      reason: "empty",
      emptySince: record.emptySince,
    };
  }
}
