/** Local source transactions, shared by participating writers in one PID namespace/filesystem.
 * Old builds, hard-link aliases, external editors and hostile directory renames are not CAS peers. */
import { lstatSync, realpathSync } from "node:fs";
import { assertWriteAllowed, browserEditing } from "../config/write-policy.ts";
import { ConfinedRefusal, ConfinedTooLarge, ensureConfinedDirectories, publishConfined } from "./confined-fs.ts";
import { ProjectError } from "./errors.ts";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { archerIdOf, replaceDiagramBody } from "../../../shared/note-diagrams.mts";
import { CommentsLockError, withCommentsLock } from "../comments/lock.ts";
import { MAX_SOURCE_BYTES } from "../mermaid/limits.ts";
import { isStableId, type Revision } from "../model/index.ts";
import { compileEmbedded, embeddedFromText, readEmbedded, type EmbeddedRead } from "../notes/embedded.ts";
import { compileDiagramBytes, revisionOf } from "./envelope.ts";
import { listDiagrams, MAX_NOTE_BYTES } from "./inventory.ts";
import {
  ConfinedWriteUncertainError,
  confine,
  findProject,
  readInFolder,
  realFolder,
  resolveInFolder,
  writeConfined,
  type Project,
  type View,
} from "./project.ts";
export type SourceTarget = { kind: "view"; viewId: string } | { kind: "embedded"; address: string };
export interface BeforeWritePlan {
  readonly path: string;
  readonly blockId: string | null;
  readonly before: Buffer | null;
  readonly after: Buffer;
  /** BEFORE/current verified body CAS token, not the written revision nor necessarily the blob digest. */
  readonly sourceRevision: Revision | null;
}
export interface SourceWriteOptions {
  readonly syncDirectory?: boolean;
  /** Synchronous terminal journal/review publication, inside the lock after observed source bytes. */
  readonly afterWrite?: (receipt: SourcePublication) => void;
  /** Synchronous private journal IO only; throw to abort before source publication. No source/sidecar locks. */
  readonly beforeWrite?: (plan: BeforeWritePlan) => void;
}
export interface SourceWriteReceipt {
  readonly before: Buffer;
  readonly after: Buffer;
  readonly sourceRevision: Revision;
  readonly path: string;
  readonly blockId: string | null;
  readonly outcome: "updated" | "unchanged";
}
export interface SourcePublication {
  readonly before: Buffer | null;
  readonly after: Buffer;
  readonly sourceRevision: Revision;
  readonly path: string;
  readonly blockId: string | null;
  readonly outcome: "updated" | "unchanged" | "created";
}
export class SourceWriteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SourceWriteError";
  }
}
export const EDITING_DISABLED =
  "Creating and editing in the page are off (edit = false in archer.toml). You can still read and comment; your agent can still change diagrams.";
/** The page's editor writes nothing where `edit = false`, the project's or the account's (ADR 0028, browserEditing). */
function assertEditing(project: Project): void {
  if (!browserEditing(project).enabled)
    throw Object.assign(new SourceWriteError("editing_disabled", EDITING_DISABLED), { phase: "prepublication" });
}
function checkCallbacks(options: SourceWriteOptions): void {
  for (const callback of [options.beforeWrite, options.afterWrite])
    if (callback?.constructor.name === "AsyncFunction")
      throw new SourceWriteError("invalid_callback", "source publication callbacks must be synchronous");
}
function complete<T extends SourcePublication>(options: SourceWriteOptions, receipt: T): T {
  if (options.afterWrite)
    observe(() => {
      const result: unknown = options.afterWrite!({
        ...receipt,
        before: receipt.before === null ? null : Buffer.from(receipt.before),
        after: Buffer.from(receipt.after),
      });
      if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result)
        throw new Error("afterWrite must not return a promise");
    });
  return receipt;
}
function beforeWrite(options: SourceWriteOptions, plan: BeforeWritePlan): void {
  if (!options.beforeWrite) return;
  if (options.beforeWrite.constructor.name === "AsyncFunction")
    throw new SourceWriteError("invalid_callback", "beforeWrite must be synchronous");
  const result: unknown = options.beforeWrite({
    ...plan,
    before: plan.before === null ? null : Buffer.from(plan.before),
    after: Buffer.from(plan.after),
  });
  if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result)
    throw new SourceWriteError("invalid_callback", "beforeWrite must not return a promise");
}
/** Synchronous callback only: no lock is retained across service/compiler awaits. */
export function withSourceWriterLock<T>(project: Project, path: string, work: () => T, timeoutMs?: number): T {
  if (work.constructor.name === "AsyncFunction")
    throw new SourceWriteError("invalid_callback", "source writer callbacks must be synchronous");
  const destination = resolveInFolder(project, path);
  // Existing files use their real identity; new files use their real parent and final name.
  let canonical: string;
  try {
    canonical = realpathSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonical = join(realpathSync(dirname(destination)), basename(destination));
  }
  try {
    return withCommentsLock(
      project,
      confine(project, canonical),
      () => {
        const result = work();
        if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result)
          throw new SourceWriteError("invalid_callback", "source writer callbacks must not return promises");
        return result;
      },
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof ConfinedWriteUncertainError)
      throw new SourceWriteError("write_uncertain", error.message, { cause: error });
    if (error instanceof CommentsLockError)
      throw new SourceWriteError("source_busy", "source is being changed by another writer; try again", {
        cause: error,
      });
    throw error;
  }
}
function viewFor(project: Project, id: string): { path: string; view?: View } {
  const registered = project.views.find((v) => v.id === id);
  if (registered) return { path: registered.source, view: registered };
  if (!isStableId(id)) throw new SourceWriteError("invalid_target", "invalid standalone view identity");
  const matches = listDiagrams(project).filter(
    (entry) => entry.view === undefined && posix.basename(entry.path, ".mmd") === id,
  );
  if (matches.length !== 1) throw new SourceWriteError("invalid_target", "view mapping is missing or ambiguous");
  return matches[0]!;
}
/** A standalone source's bytes through the confined seam (no link, one name, read from its descriptor). */
function readStandalone(project: Project, path: string): Buffer {
  try {
    return readInFolder(project, path, MAX_SOURCE_BYTES);
  } catch (error) {
    if (error instanceof ConfinedTooLarge)
      throw new SourceWriteError("invalid_target", "source exceeds its size limit");
    if (error instanceof ProjectError)
      throw new SourceWriteError(
        "invalid_target",
        `source must be a regular file within its size limit: ${error.message}`,
        { cause: error },
      );
    throw error;
  }
}
/** Evidence is an observed result, never merely the candidate we attempted to publish. */
function observe<T>(work: () => T): T {
  try {
    return work();
  } catch (cause) {
    throw new SourceWriteError(
      "write_uncertain",
      "source result could not be confirmed; reconcile without rollback or automatic replay",
      { cause },
    );
  }
}
function observeEmbedded(
  project: Project,
  address: string,
  canonical: string,
  planned: Buffer,
  plannedRevision: Revision,
): { bytes: Buffer; revision: Revision } {
  return observe(() => {
    const read = readEmbedded(project, address);
    if (!read || realpathSync(resolveInFolder(project, read.notePath)) !== canonical)
      throw new Error("embedded mapping changed after publication");
    const bytes = rawBody(read);
    if (!bytes.equals(planned) || read.sourceRevision !== plannedRevision)
      throw new Error("embedded body or identity differs from the publication plan");
    return { bytes, revision: read.sourceRevision };
  });
}
function rawBody(read: EmbeddedRead): Buffer {
  return Buffer.from(
    read.noteText
      .split(/(?<=\n)/u)
      .slice(read.bodyLine - 1, read.bodyLine - 1 + read.diagram.bodyLineCount)
      .join(""),
    "utf8",
  );
}
function checkIdentity(read: EmbeddedRead, text: string): void {
  if (!read.writable || !read.diagram.closed)
    throw new SourceWriteError("invalid_target", "browser edits require an existing writable closed top-level block");
  const named = archerIdOf(text.replace(/\r\n?/gu, "\n"));
  if (named !== null && named !== read.name)
    throw new SourceWriteError("invalid_target", "browser edits cannot rename an embedded diagram");
}
/** Compile before acquiring; re-resolve mapping, read, compare and replace synchronously under lock.
 * Callers must finish announcements before entering this helper. Buffers are standalone file bytes
 * or exact embedded BODY bytes, including identity markers and original line endings. */
export async function applySource(
  project: Project,
  target: SourceTarget,
  expected: Revision,
  text: string,
  options: SourceWriteOptions = {},
): Promise<SourceWriteReceipt> {
  checkCallbacks(options);
  const initial = target.kind === "view" ? viewFor(project, target.viewId) : undefined;
  const embedded = target.kind === "embedded" ? readEmbedded(project, target.address) : null;
  if (target.kind === "embedded" && embedded === null)
    throw new SourceWriteError("invalid_target", "embedded diagram does not exist");
  if (embedded) checkIdentity(embedded, text);
  const path = initial?.path ?? embedded!.notePath;
  const root = realpathSync(project.folder);
  const canonical = realpathSync(resolveInFolder(project, path));
  const entry = { path, ...(initial?.view ? { view: initial.view } : {}) };
  const compiled = embedded
    ? await compileEmbedded(embedded, text)
    : await compileDiagramBytes(entry, Buffer.from(text));
  if (!compiled.envelope) throw new SourceWriteError("invalid_source", "browser source must compile before applying");
  return withSourceWriterLock(project, path, () => {
    const fresh = findProject(project.root);
    if (fresh.root !== project.root || fresh.folder !== project.folder || realpathSync(fresh.folder) !== root)
      throw new SourceWriteError("revision_conflict", "project authoring folder changed");
    assertEditing(fresh);
    const mapping = target.kind === "view" ? viewFor(fresh, target.viewId) : undefined;
    if (mapping && (mapping.path !== path || JSON.stringify(mapping.view) !== JSON.stringify(initial?.view)))
      throw new SourceWriteError("revision_conflict", "view mapping changed");
    if (realpathSync(resolveInFolder(fresh, path)) !== canonical)
      throw new SourceWriteError("revision_conflict", "source file identity changed");
    const actualPath = confine(fresh, canonical);
    if (target.kind === "view") {
      const before = readStandalone(fresh, actualPath);
      if (revisionOf(before) !== expected) throw new SourceWriteError("revision_conflict", "source revision changed");
      const after = Buffer.from(text, "utf8");
      const outcome = before.equals(after) ? "unchanged" : "updated";
      if (outcome === "updated") assertWriteAllowed(fresh.root, "diagrams");
      beforeWrite(options, { path: actualPath, blockId: null, before, after, sourceRevision: expected });
      if (outcome === "updated") writeConfined(fresh, actualPath, text, "diagrams", options);
      const observed = observe(() => {
        const bytes = readStandalone(fresh, actualPath);
        if (!bytes.equals(after)) throw new Error("source differs from the publication plan");
        return bytes;
      });
      return complete(options, {
        before,
        after: observed,
        sourceRevision: revisionOf(observed),
        path: actualPath,
        blockId: null,
        outcome,
      });
    }
    const read = readEmbedded(fresh, target.address);
    if (!read || read.notePath !== path) throw new SourceWriteError("revision_conflict", "embedded mapping changed");
    checkIdentity(read, text);
    if (read.sourceRevision !== expected)
      throw new SourceWriteError("revision_conflict", "embedded source revision changed");
    const before = rawBody(read);
    // A no-op does not pin an implicit identity or normalize line endings.
    if (text === read.source) {
      beforeWrite(options, { path: actualPath, blockId: read.name, before, after: before, sourceRevision: expected });
      const observed = observeEmbedded(fresh, target.address, canonical, before, expected);
      return complete(options, {
        before,
        after: observed.bytes,
        sourceRevision: observed.revision,
        path: actualPath,
        blockId: read.name,
        outcome: "unchanged",
      });
    }
    let next: string;
    try {
      next = replaceDiagramBody(
        read.noteText,
        { ...read.diagram, fenceLine: read.line, bodyLine: read.bodyLine },
        text,
      );
    } catch (cause) {
      throw new SourceWriteError("invalid_target", "replacement would change the surrounding note", { cause });
    }
    if (Buffer.byteLength(next) > MAX_NOTE_BYTES)
      throw new SourceWriteError("invalid_source", "updated note exceeds its size limit");
    const written = embeddedFromText(read.notePath, next, revisionOf(Buffer.from(next))).diagrams.find(
      (d) => d.name === read.name,
    );
    if (!written) throw new SourceWriteError("invalid_target", "replacement loses embedded identity");
    // New body length is determined from the following unchanged closing fence position.
    const prefix = read.noteText
      .split(/(?<=\n)/u)
      .slice(0, read.bodyLine - 1)
      .join("");
    const suffix = read.noteText
      .split(/(?<=\n)/u)
      .slice(read.bodyLine - 1 + read.diagram.bodyLineCount)
      .join("");
    const actualAfter = Buffer.from(next.slice(prefix.length, next.length - suffix.length));
    const outcome = next === read.noteText ? "unchanged" : "updated";
    if (outcome === "updated") assertWriteAllowed(fresh.root, "notes");
    beforeWrite(options, {
      path: actualPath,
      blockId: read.name,
      before,
      after: actualAfter,
      sourceRevision: expected,
    });
    if (outcome === "updated") writeConfined(fresh, actualPath, next, "notes", options);
    const observed = observeEmbedded(fresh, target.address, canonical, actualAfter, written.sourceRevision);
    return complete(options, {
      before,
      after: observed.bytes,
      sourceRevision: observed.revision,
      path: actualPath,
      blockId: read.name,
      outcome,
    });
  });
}
/** Where the service may create files, inside the Archer folder (ADR 0028). */
export const CREATE_ROOTS = ["diagrams", "notes"] as const;
/** At most this many folders below `diagrams/` or `notes/` on the way to a new file. */
export const MAX_CREATE_DEPTH = 8;
const CREATE_SEGMENT = /^[^./\\\0][^/\\\0]{0,254}$/u;

/** The folder-relative segments of a path the service may create, or a refusal naming why not. */
export function creatableParts(path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !CREATE_SEGMENT.test(part)))
    throw new SourceWriteError(
      "invalid_target",
      "name a new file inside the Archer folder with no empty, hidden, . or .. parts, such as diagrams/checkout-flow.mmd",
    );
  if (parts.length < 2 || !(CREATE_ROOTS as readonly string[]).includes(parts[0]!))
    throw new SourceWriteError(
      "create_not_allowed",
      `Archer creates new files only in ${CREATE_ROOTS.map((root) => `${root}/`).join(" or ")} inside the Archer folder; choose one of those folders, such as diagrams/checkout-flow.mmd`,
    );
  if (parts.length - 2 > MAX_CREATE_DEPTH)
    throw new SourceWriteError(
      "create_not_allowed",
      `a new file can be at most ${MAX_CREATE_DEPTH} folders below ${parts[0]}/`,
    );
  return parts;
}

/**
 * Makes the missing folders on the way to a new file through the confined seam: each is created inside
 * the folder just opened without following links (O_NOFOLLOW), so a link or a file in the way refuses
 * instead of redirecting the write.
 */
function ensureFolders(project: Project, parts: readonly string[]): void {
  const folders = parts.slice(0, -1);
  // The Archer folder may itself be a link inside the project (an alias); start at its real place.
  let real: string;
  try {
    real = realFolder(project);
  } catch (cause) {
    throw new SourceWriteError("invalid_target", "the Archer folder is not inside the project", { cause });
  }
  try {
    ensureConfinedDirectories(real, folders, (at) =>
      at === 0 ? project.folderSetting : folders.slice(0, at).join("/"),
    );
  } catch (cause) {
    if (cause instanceof ConfinedRefusal || (cause as NodeJS.ErrnoException).code === "ENOTDIR")
      throw new SourceWriteError(
        "invalid_target",
        `${folders.join("/")} is a link or not a folder; Archer creates files only in real folders`,
        { cause },
      );
    throw cause;
  }
}

/** Exclusive publication: link is atomic and refuses EEXIST even for destination links. */
export function createConfined(project: Project, path: string, text: string, options: SourceWriteOptions = {}): string {
  checkCallbacks(options);
  if (!path.endsWith(".mmd")) throw new SourceWriteError("invalid_target", "new diagrams must use .mmd");
  const parts = creatableParts(path);
  // Every refusal that needs no folder comes first, so a refused create leaves no folder behind:
  // the current project (its folder unchanged), editing on, the account's rules.
  const current = findProject(project.root);
  if (current.root !== project.root || current.folder !== project.folder)
    throw new SourceWriteError("revision_conflict", "project authoring folder changed");
  assertEditing(current);
  assertWriteAllowed(project.root, "diagrams");
  ensureFolders(current, parts);
  const authoringRoot = realpathSync(project.folder);
  return withSourceWriterLock(project, path, () => {
    const fresh = findProject(project.root);
    if (fresh.root !== project.root || fresh.folder !== project.folder || realpathSync(fresh.folder) !== authoringRoot)
      throw new SourceWriteError("revision_conflict", "project authoring folder changed");
    assertEditing(fresh);
    const destination = resolveInFolder(fresh, path);
    const parent = realpathSync(dirname(destination)); // explicit parent existence; never mkdir implicitly
    const actual = join(parent, basename(destination));
    const actualPath = confine(fresh, actual);
    // The allowance again on the real path, under the lock: a folder swapped for a link since the
    // folders were made must not move the new file elsewhere in the Archer folder.
    creatableParts(actualPath);
    try {
      lstatSync(actual);
      throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    assertWriteAllowed(fresh.root, "diagrams");
    beforeWrite(options, {
      path: actualPath,
      blockId: null,
      before: null,
      after: Buffer.from(text),
      sourceRevision: null,
    });
    // Exclusive publication by link(2) inside the parent the confined walk opened: it never overwrites.
    const parentParts = relative(authoringRoot, parent) === "" ? [] : relative(authoringRoot, parent).split(sep);
    publishConfined(authoringRoot, parentParts, basename(destination), text, actualPath, {
      exclusive: true,
      randomBytes: 12,
      ...(options.syncDirectory ? { syncDirectory: true } : {}),
    });
    try {
      const observed = observe(() => {
        const bytes = readStandalone(fresh, actualPath);
        if (!bytes.equals(Buffer.from(text, "utf8")))
          throw new Error("created source differs from the publication plan");
        return bytes;
      });
      complete(options, {
        before: null,
        after: observed,
        sourceRevision: revisionOf(observed),
        path: actualPath,
        blockId: null,
        outcome: "created",
      });
    } catch (cause) {
      if (cause instanceof ConfinedWriteUncertainError) throw cause;
      throw new ConfinedWriteUncertainError(actual, cause);
    }
    return actual;
  });
}
