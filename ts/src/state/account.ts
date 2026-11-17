/** Private, versioned account recovery. Sources are verified blobs, never serialized models. */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { MAX_SOURCE_BYTES } from "../mermaid/limits.ts";
import { MAX_CONTINUITY_BYTES, parseContinuity, type ContinuityRecord } from "./continuity.ts";
export const MAX_REMEMBERED_PROJECTS = 256;
export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
export const MAX_METADATA_BYTES = 8 * 1024 * 1024;
export const MAX_STATE_DEPTH = 64;
export const MAX_STATE_VALUES = 500000;
export class PersistenceError extends Error {
  override readonly name = "PersistenceError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface RecoveryView {
  readonly id: string;
  readonly path: string;
  readonly kind: string;
  readonly title: string;
  readonly revision: string;
  readonly sourceRevision: string | null;
  readonly blob: string;
}
export interface RecoveryRecord {
  readonly version: 1;
  readonly root: string;
  readonly presentation: unknown;
  readonly selection: unknown;
  readonly captions: readonly (readonly [
    string,
    {
      readonly at: string;
      readonly caption?: string;
    },
  ])[];
  readonly lastChange: readonly (readonly [
    string,
    {
      readonly at: string;
      readonly by: "person" | "agent";
      readonly summary?: string;
    },
  ])[];
  readonly emphases: unknown;
  readonly views: readonly RecoveryView[];
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const key = (root: string) => createHash("sha256").update(root).digest("hex");
function fail(message: string, code = "invalid_saved_state"): never {
  throw new PersistenceError(code, message);
}
/** Native JSON parser plus iterative vocabulary validation; depth never uses the JS stack. */
function parseBounded(text: string, limit: number): unknown {
  if (Buffer.byteLength(text) > limit) fail(`saved state exceeds ${limit} bytes`, "saved_state_capacity");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("saved state is not valid JSON");
  }
  const pending: {
    v: unknown;
    depth: number;
  }[] = [{ v: raw, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { v, depth } = pending.pop()!;
    if (++count > MAX_STATE_VALUES) fail("saved state exceeds its value limit", "saved_state_capacity");
    if (depth > MAX_STATE_DEPTH) fail(`saved state exceeds depth ${MAX_STATE_DEPTH}`, "saved_state_depth");
    if (v !== null && typeof v === "object") for (const x of Object.values(v)) pending.push({ v: x, depth: depth + 1 });
  }
  return raw;
}
export function parseRecovery(text: string): RecoveryRecord {
  const raw = parseBounded(text, MAX_METADATA_BYTES);
  if (
    !object(raw) ||
    raw.version !== 1 ||
    typeof raw.root !== "string" ||
    !raw.root.startsWith("/") ||
    !Array.isArray(raw.captions) ||
    !Array.isArray(raw.lastChange) ||
    !Array.isArray(raw.views) ||
    !Array.isArray(raw.emphases) ||
    !("presentation" in raw) ||
    !("selection" in raw)
  )
    fail("saved state has an incompatible version or invalid record");
  if (
    Object.keys(raw).some(
      (k) =>
        !["version", "root", "presentation", "selection", "captions", "lastChange", "emphases", "views"].includes(k),
    )
  )
    fail("saved record names unsupported fields");
  if (raw.views.length > 256 || raw.captions.length > 256 || raw.lastChange.length > 256 || raw.emphases.length > 256)
    fail("saved state exceeds the view limit", "saved_state_capacity");
  const seenViews = new Set<string>();
  for (const view of raw.views) {
    if (
      !object(view) ||
      !["id", "path", "kind", "title", "revision", "blob"].every((k) => typeof view[k] === "string") ||
      seenViews.has(String(view.id)) ||
      Object.keys(view).some(
        (k) => !["id", "path", "kind", "title", "revision", "sourceRevision", "blob"].includes(k),
      ) ||
      !/^sha256:[a-f0-9]{64}$/.test(String(view.revision)) ||
      view.blob !== view.revision ||
      (view.sourceRevision !== null &&
        (typeof view.sourceRevision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(view.sourceRevision)))
    )
      fail("saved source reference is malformed");
    seenViews.add(String(view.id));
  }
  for (const [pairs, caption] of [
    [raw.captions, true],
    [raw.lastChange, false],
  ] as const) {
    const seen = new Set<string>();
    for (const pair of pairs) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        seen.has(pair[0]) ||
        !object(pair[1]) ||
        typeof pair[1].at !== "string" ||
        !Number.isFinite(Date.parse(pair[1].at))
      )
        fail("saved history metadata is malformed");
      const value = pair[1];
      if (
        caption
          ? Object.keys(value).some((k) => k !== "at" && k !== "caption") ||
            (value.caption !== undefined && typeof value.caption !== "string")
          : Object.keys(value).some((k) => k !== "at" && k !== "by" && k !== "summary") ||
            (value.by !== "person" && value.by !== "agent") ||
            (value.summary !== undefined && typeof value.summary !== "string")
      )
        fail("saved history metadata is malformed");
      seen.add(pair[0]);
    }
  }
  return raw as unknown as RecoveryRecord;
}
function assertPrivateDirectory(path: string): void {
  let s: ReturnType<typeof lstatSync>;
  try {
    s = lstatSync(path);
  } catch {
    return fail(`saved state directory cannot be inspected: ${path}`, "saved_state_io");
  }
  if (!s.isDirectory() || (process.getuid !== undefined && s.uid !== process.getuid()) || (s.mode & 0o077) !== 0)
    fail(`saved state directory is not private: ${path}`, "saved_state_io");
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(path);
}
function readPrivate(path: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail(`cannot read saved state ${path}: ${String(e)}`, "saved_state_io");
  }
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.size > max ||
      (s.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && s.uid !== process.getuid())
    )
      fail(`saved state file is unsafe or exceeds its limit: ${path}`, "saved_state_io");
    const bytes = Buffer.alloc(s.size);
    let used = 0;
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, used);
      if (n === 0) fail("saved state changed during read", "saved_state_io");
      used += n;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function atomic(path: string, bytes: Uint8Array): void {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let used = 0;
    while (used < bytes.length) {
      const n = writeSync(fd, bytes, used, bytes.length - used);
      if (n <= 0) throw new Error("saved state write made no progress");
      used += n;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch (e) {
    throw new PersistenceError("saved_state_io", `could not commit saved state: ${String(e)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* none */
    }
  }
}
interface Index {
  version: 1;
  projects: {
    root: string;
    attached: boolean;
  }[];
}
export function parseAccountIndex(text: string): Index {
  const parsed = parseBounded(text, MAX_INDEX_BYTES);
  if (
    !object(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.projects) ||
    parsed.projects.length > MAX_REMEMBERED_PROJECTS ||
    Object.keys(parsed).some((k) => k !== "version" && k !== "projects")
  )
    fail("saved account index is incompatible or exceeds its limit");
  const seen = new Set<string>();
  for (const p of parsed.projects) {
    if (
      !object(p) ||
      typeof p.root !== "string" ||
      !p.root.startsWith("/") ||
      typeof p.attached !== "boolean" ||
      seen.has(p.root) ||
      Object.keys(p).some((k) => k !== "root" && k !== "attached")
    )
      fail("saved account project record is malformed");
    seen.add(p.root);
  }
  return parsed as unknown as Index;
}
/** Sole service writer. Synchronous commits serialize mutations and precede publication. */
export class AccountStateStore {
  readonly directory: string;
  #index: Index = { version: 1, projects: [] };
  /**
   * What this process last committed for each root: the record text and the blob digests it
   * verified or wrote. `save` skips what it already holds; `load` and `source` still verify in full.
   */
  #committed = new Map<string, { text: string; digests: Set<string> }>();
  constructor(stateDir: string) {
    this.directory = join(stateDir, "runtime");
    privateDirectory(this.directory);
    const bytes = readPrivate(join(this.directory, "index.json"), MAX_INDEX_BYTES);
    if (bytes !== null) this.#index = parseAccountIndex(bytes.toString("utf8"));
  }
  attachedRoots(): string[] {
    return this.#index.projects.filter((p) => p.attached).map((p) => p.root);
  }
  markAttached(root: string, attached: boolean): void {
    assertPrivateDirectory(this.directory);
    const next: Index = { version: 1, projects: this.#index.projects.map((p) => ({ ...p })) };
    const found = next.projects.find((p) => p.root === root);
    if (found) found.attached = attached;
    else {
      if (next.projects.length === MAX_REMEMBERED_PROJECTS)
        fail(`the account remembers ${MAX_REMEMBERED_PROJECTS} projects; no state was evicted`, "saved_state_capacity");
      next.projects.push({ root, attached });
    }
    const text = JSON.stringify(next);
    parseAccountIndex(text);
    atomic(join(this.directory, "index.json"), Buffer.from(text));
    this.#index = next;
  }
  load(root: string): RecoveryRecord | null {
    assertPrivateDirectory(this.directory);
    const bytes = readPrivate(join(this.directory, `${key(root)}.json`), MAX_METADATA_BYTES);
    if (bytes === null) return null;
    const saved = parseRecovery(bytes.toString("utf8"));
    if (saved.root !== root) fail("saved project root does not match its record");
    return saved;
  }
  source(root: string, revision: string): Buffer {
    if (!/^sha256:[a-f0-9]{64}$/.test(revision)) fail("saved source digest is malformed");
    assertPrivateDirectory(this.directory);
    const sourceDir = join(this.directory, `${key(root)}.sources`);
    assertPrivateDirectory(sourceDir);
    const bytes = readPrivate(join(sourceDir, revision.slice(7)), MAX_SOURCE_BYTES);
    if (bytes === null || digest(bytes) !== revision) fail("saved last-good source is missing or its digest differs");
    return bytes;
  }
  /**
   * The project's restart continuity (`continuity.ts`), or null when there is none or it cannot
   * be trusted: an unsafe file, one past its limit, or one that does not parse is dropped, never thrown.
   */
  continuity(root: string): ContinuityRecord | null {
    try {
      assertPrivateDirectory(this.directory);
      const bytes = readPrivate(join(this.directory, `${key(root)}.continuity.json`), MAX_CONTINUITY_BYTES);
      return bytes === null ? null : parseContinuity(bytes.toString("utf8"), root);
    } catch {
      return null;
    }
  }
  /** Replaces the project's continuity file atomically with `text` (`serializeContinuity`); a PersistenceError when it cannot. */
  saveContinuity(root: string, text: string): void {
    if (parseContinuity(text, root) === null) fail("continuity state is malformed or exceeds its limit");
    assertPrivateDirectory(this.directory);
    atomic(join(this.directory, `${key(root)}.continuity.json`), Buffer.from(text));
  }
  save(
    record: RecoveryRecord,
    sources: readonly {
      revision: string;
      bytes: Uint8Array;
    }[],
  ): void {
    assertPrivateDirectory(this.directory);
    const text = JSON.stringify(record);
    const held = this.#committed.get(record.root);
    if (held !== undefined && held.text === text) return; // Nothing changed since the last commit: no write, no verification, no listing.
    parseRecovery(text);
    const sourceDir = join(this.directory, `${key(record.root)}.sources`);
    privateDirectory(sourceDir); // Validate capacity before any writes.
    const created: string[] = [];
    // A held digest is trusted only while its file is still listed: one listing, whatever the size.
    let listed: Set<string> | undefined;
    if (held !== undefined && sources.some((s) => held.digests.has(s.revision))) {
      try {
        listed = new Set(readdirSync(sourceDir));
      } catch {
        /* unlisted: nothing is trusted, every blob is checked */
      }
    }
    try {
      for (const source of sources) {
        if (held?.digests.has(source.revision) && listed?.has(source.revision.slice(7))) continue; // Verified or written by this process, and still there.
        if (source.bytes.length > MAX_SOURCE_BYTES || digest(source.bytes) !== source.revision)
          fail("last-good source exceeds its limit or does not match its revision");
        const path = join(sourceDir, source.revision.slice(7));
        const onDisk = readPrivate(path, MAX_SOURCE_BYTES);
        if (onDisk !== null) {
          if (digest(onDisk) !== source.revision) fail("saved source blob has been corrupted");
        } else {
          atomic(path, source.bytes);
          created.push(path);
        }
      }
      atomic(join(this.directory, `${key(record.root)}.json`), Buffer.from(text));
    } catch (e) {
      for (const path of created) {
        try {
          unlinkSync(path);
        } catch {
          /* original error is retained */
        }
      }
      throw e;
    }
    const digests = new Set(record.views.map((v) => v.blob));
    this.#committed.set(record.root, { text, digests });
    // Only unreferenced cache blobs may be removed, after metadata commit, and only when the
    // referenced set changed (the first save of a process always lists).
    if (held !== undefined && held.digests.size === digests.size && [...digests].every((d) => held.digests.has(d)))
      return;
    const referenced = new Set([...digests].map((d) => d.slice(7)));
    try {
      for (const name of readdirSync(sourceDir))
        if (/^[a-f0-9]{64}$/.test(name) && !referenced.has(name)) {
          try {
            unlinkSync(join(sourceDir, name));
          } catch {
            /* Cache cleanup cannot undo a committed mutation. */
          }
        }
    } catch {
      /* Listing is optional too: metadata is already committed. */
    }
  }
}
