/** Derived, disposable review files. Private AuthoringStore state is the sole authority. */
import { writesAllowed } from "../config/write-policy.ts";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { relative, sep } from "node:path";
import { cumulativeDiff } from "../changes/cumulative-diff.ts";
import { ConfinedFileSystem, ConfinedRefusal, type ConfinedHandle } from "../project/confined-fs.ts";
import { findProject, writeAllSync, type Project } from "../project/project.ts";
import { SourceWriteError, withSourceWriterLock } from "../project/source-writer.ts";
import type { AuthoringStore, CumulativeReview } from "./store.ts";
export const REVIEW_ARTIFACT_LIMITS = { bytes: 512 * 1024 } as const;
export interface ReviewArtifactResult {
  status: "written" | "removed" | "blocked" | "unavailable" | "stale";
  path?: string;
  message?: string;
}
/** Fault injection only; hooks never supply source bytes or authority. */
export interface ReviewArtifactOptions {
  onStep?: (step: "temporary_synced" | "before_publish" | "published" | "ignore_linked") => void;
  /** The source-writer lock's wait bound; background refresh passes a short one and retries later. */
  lockTimeoutMs?: number;
}
/** The `blocked` message when another writer held the review's source past the wait bound. */
export const REVIEW_SOURCE_BUSY = "review source is being changed by another writer; refresh later";
const marker = "# archer-review v1";
const ignoreMarker = "# archer-review-ignore v1";
class Refusal extends Error {
  constructor(
    readonly status: ReviewArtifactResult["status"],
    message: string,
  ) {
    super(message);
  }
}
function refuse(status: ReviewArtifactResult["status"], message: string): never {
  throw new Refusal(status, message);
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const portable = (path: string) => path.split(sep).join("/");
function folder(project: Project): string {
  const current = findProject(project.root);
  if (current.root !== project.root || current.folder !== project.folder)
    refuse("unavailable", "effective authoring folder changed");
  const path = portable(relative(project.root, project.folder));
  if (!path || path.startsWith("../") || path === ".." || path.startsWith("/"))
    refuse("unavailable", "authoring folder is not confined");
  return path;
}
function filename(review: CumulativeReview): string {
  const subject = review.subject.path + (review.subject.blockId ? "#" + review.subject.blockId : "");
  const slug = subject.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "review";
  return `${slug}--${review.reviewId}.diff`;
}
function identity(store: AuthoringStore, review: CumulativeReview): string {
  return "# identity " + JSON.stringify({ ...store.status(), reviewId: review.reviewId, subject: review.subject });
}
function render(store: AuthoringStore, review: CumulativeReview): string {
  const before = review.baseline === null ? null : store.readSnapshot(review.baseline).toString("utf8");
  const after = store.readSnapshot(review.latest).toString("utf8");
  const diff = cumulativeDiff(
    before,
    after,
    review.subject.path + (review.subject.blockId ? "#" + review.subject.blockId : ""),
  );
  const header = `${marker}\n${identity(store, review)}\n# derived: private Archer state; do not edit; not authoritative\n# review ${JSON.stringify({ reviewRevision: review.reviewRevision, state: review.state, saveCount: review.saveCount, baseline: review.baseline, latest: review.latest, netEffect: diff.netEffect, externalGaps: review.externalGaps, delivery: review.delivery, algorithm: diff.algorithm })}\n`;
  const complete =
    diff.complete &&
    Buffer.byteLength(header) + Buffer.byteLength("# diff complete=true\n") + diff.bytes <=
      REVIEW_ARTIFACT_LIMITS.bytes;
  return (
    header +
    (complete
      ? "# diff complete=true\n" + diff.text
      : "# diff complete=false; body omitted; exact source available through read_change baseline/latest parts\n")
  );
}
/** Before a change in folder `path`: refused, as blocked, under a folder another account can change (known-limits §1). */
function refuseShared(fs: ConfinedFileSystem, path: string): void {
  try {
    fs.refuseSharedFolders(path);
  } catch (error) {
    if (error instanceof ConfinedRefusal) refuse("blocked", error.message);
    throw error;
  }
}

function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
interface Existing {
  stat: Stats;
  text: string;
}
function readEntry(fs: ConfinedFileSystem, directory: ConfinedHandle, name: string): Existing | null {
  let fd: number | undefined;
  const path = `${fs.descriptorPath(directory)}/${name}`;
  try {
    const named = lstatSync(path);
    if (!named.isFile() || named.nlink !== 1 || named.size > REVIEW_ARTIFACT_LIMITS.bytes)
      refuse("blocked", "review artifact is not a managed single-link regular file");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > REVIEW_ARTIFACT_LIMITS.bytes || !same(stat, named))
      refuse("blocked", "review artifact binding changed");
    // Bounded descriptor read: a concurrently grown file cannot allocate arbitrarily.
    const bytes = Buffer.alloc(REVIEW_ARTIFACT_LIMITS.bytes + 1);
    // readFileSync would read beyond the checked size if an external process grows it.
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSyncBounded(fd, bytes, offset);
      if (n === 0) break;
      offset += n;
    }
    const content = bytes.subarray(0, offset),
      first = content.indexOf(10),
      headerEnd = first < 0 ? -1 : content.indexOf(10, first + 1);
    if (headerEnd >= 0)
      try {
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content.subarray(0, headerEnd + 1));
      } catch {
        refuse("blocked", "artifact identity is not exact UTF-8");
      }
    const text = content.toString("utf8"),
      after = fstatSync(fd);
    if (
      offset > REVIEW_ARTIFACT_LIMITS.bytes ||
      !same(stat, after) ||
      after.nlink !== stat.nlink ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      after.size !== offset ||
      !fs.bound(directory)
    )
      refuse("blocked", "review artifact changed while reading");
    return { stat: after, text };
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function existing(fs: ConfinedFileSystem, directory: ConfinedHandle, name: string, expected: string): Existing | null {
  const found = readEntry(fs, directory, name);
  if (found !== null && !found.text.startsWith(marker + "\n" + expected + "\n"))
    refuse("blocked", "review artifact marker or identity does not match");
  return found;
}
function ignoreText(store: AuthoringStore): string {
  return `${ignoreMarker}\n# identity ${JSON.stringify(store.status())}\n*\n`;
}
/** Existing project rules are user-owned: inspect metadata only and never rewrite them. */
function validIgnore(fs: ConfinedFileSystem, directory: ConfinedHandle): boolean {
  const path = `${fs.descriptorPath(directory)}/.gitignore`;
  let fd: number | undefined;
  try {
    const named = lstatSync(path);
    if (!named.isFile() || named.nlink !== 1) refuse("blocked", "gitignore is not a single-link regular file");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd),
      now = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || !same(stat, named) || !same(stat, now) || !fs.bound(directory))
      refuse("blocked", "gitignore binding changed");
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function ensureIgnore(
  fs: ConfinedFileSystem,
  parent: ConfinedHandle,
  directory: ConfinedHandle,
  project: Project,
  store: AuthoringStore,
  options: ReviewArtifactOptions,
): void {
  if (validIgnore(fs, directory)) return;
  const text = ignoreText(store),
    name = `.ignore.${randomBytes(16).toString("hex")}.tmp`,
    temporaryPath = `${fs.descriptorPath(directory)}/${name}`,
    finalPath = `${fs.descriptorPath(directory)}/.gitignore`;
  let stat: Stats | undefined,
    linked = false;
  const { fd } = createTemporary(fs, parent, directory, project, name);
  try {
    try {
      writeAllSync(fd, text);
      fsyncSync(fd);
      stat = fstatSync(fd);
    } finally {
      closeSync(fd);
    }
    checkBinding(fs, parent, directory, project);
    const now = lstatSync(temporaryPath);
    if (!same(now, stat) || !now.isFile() || now.nlink !== 1 || now.size !== stat.size || now.ctimeMs !== stat.ctimeMs)
      refuse("blocked", "ignore temporary binding changed");
    // Atomic no-clobber publication: an existing user .gitignore always wins.
    try {
      linkSync(temporaryPath, finalPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!validIgnore(fs, directory)) refuse("stale", "gitignore disappeared");
      return;
    }
    options.onStep?.("ignore_linked");
    checkBinding(fs, parent, directory, project);
    const a = lstatSync(temporaryPath),
      b = lstatSync(finalPath);
    if (!a.isFile() || !b.isFile() || a.nlink !== 2 || b.nlink !== 2 || !same(a, stat) || !same(b, stat))
      refuse("blocked", "ignore publication binding changed");
    unlinkSync(temporaryPath);
    fsyncSync(directory.fd);
    checkBinding(fs, parent, directory, project);
    if (!validIgnore(fs, directory)) refuse("stale", "published gitignore disappeared");
  } finally {
    // Only an unlinked temporary is ours to remove. A linked pair left by an interruption stays, and later
    // materialisations refuse it as blocked: no reconciliation pass runs (ADR 0027, amended 2026-11-10).
    if (!linked && stat !== undefined && fs.bound(directory))
      try {
        const now = lstatSync(temporaryPath);
        if (
          now.isFile() &&
          now.nlink === 1 &&
          same(now, stat) &&
          now.size === stat.size &&
          now.ctimeMs === stat.ctimeMs
        )
          unlinkSync(temporaryPath);
      } catch {
        /* Leave uncertain entries untouched. */
      }
  }
}
/**
 * Creates a temporary (exclusive, no link at the end) and proves the bound folder holds it before a byte
 * is written: where `descriptorPath` is a plain path (no descriptor filesystem), a folder swapped after the
 * last check would otherwise receive the whole file (ADR 0018, amended 2026-11-10).
 */
function createTemporary(
  fs: ConfinedFileSystem,
  parent: ConfinedHandle,
  directory: ConfinedHandle,
  project: Project,
  name: string,
): { fd: number; stat: Stats } {
  checkBinding(fs, parent, directory, project);
  const path = `${fs.descriptorPath(directory)}/${name}`,
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    const stat = fstatSync(fd);
    checkBinding(fs, parent, directory, project);
    const now = lstatSync(path);
    if (!now.isFile() || !same(now, stat)) refuse("blocked", "temporary binding changed");
    return { fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function readSyncBounded(fd: number, bytes: Buffer, offset: number): number {
  return readSync(fd, bytes, offset, bytes.length - offset, null);
}
function checkBinding(
  fs: ConfinedFileSystem,
  parent: ConfinedHandle,
  directory: ConfinedHandle,
  project: Project,
): void {
  folder(project);
  if (!fs.bound(parent) || !fs.bound(directory)) refuse("stale", "authoring directory binding changed");
}
function checkExisting(fs: ConfinedFileSystem, directory: ConfinedHandle, name: string, old: Existing | null): void {
  try {
    const now = lstatSync(`${fs.descriptorPath(directory)}/${name}`);
    if (
      old === null ||
      !now.isFile() ||
      now.nlink !== 1 ||
      !same(now, old.stat) ||
      now.size !== old.stat.size ||
      now.mtimeMs !== old.stat.mtimeMs ||
      now.ctimeMs !== old.stat.ctimeMs
    )
      refuse("blocked", "review artifact changed before publication");
  } catch (error) {
    if (missing(error) && old === null) return;
    throw error;
  }
}
const READ_ONLY: ReviewArtifactResult = {
  status: "blocked",
  message: "Your Archer settings make this project read-only; the review diff file was not written.",
};
export function materializeReview(
  project: Project,
  store: AuthoringStore,
  reviewId: string,
  options: ReviewArtifactOptions = {},
): ReviewArtifactResult {
  // Derived files follow the source rules (ADR 0013): a read-only project gets none.
  if (!writesAllowed(project.root, ["diagrams", "notes"])) return READ_ONLY;
  let path: string | undefined;
  try {
    const initial = store.getReview(project.root, reviewId);
    if (initial === null) return { status: "unavailable", message: "review not found" };
    const folderPath = folder(project),
      prefix = folderPath + "/";
    if (!initial.subject.path.startsWith(prefix))
      refuse("unavailable", "review subject is outside current authoring folder");
    const fs = new ConfinedFileSystem(project.root);
    let source: ConfinedHandle | undefined;
    try {
      if (initial.state === "pending") {
        try {
          source = fs.open(initial.subject.path);
        } catch {
          refuse("unavailable", "review source is unavailable");
        }
        if (!source.stat.isFile()) refuse("unavailable", "review source is not a regular file");
      }
      return withSourceWriterLock(
        project,
        initial.subject.path.slice(prefix.length),
        () => {
          const review = store.getReview(project.root, reviewId);
          if (review === null) refuse("unavailable", "review no longer exists");
          if (JSON.stringify(review.subject) !== JSON.stringify(initial.subject))
            refuse("stale", "review identity changed");
          folder(project);
          if (review.state === "pending" && (source === undefined || !fs.bound(source)))
            refuse("unavailable", "review source binding changed");
          let parent: ConfinedHandle | undefined,
            directory: ConfinedHandle | undefined,
            temp: string | undefined,
            temporaryStat: Stats | undefined,
            published = false;
          try {
            parent = fs.open(folderPath);
            if (!parent.stat.isDirectory()) refuse("blocked", "authoring folder is not a directory");
            refuseShared(fs, folderPath);
            const directoryPath = folderPath + "/.review";
            path = directoryPath + "/" + filename(review);
            if (review.state === "pending") {
              if (!fs.bound(parent)) refuse("stale", "authoring folder binding changed");
              try {
                mkdirSync(`${fs.descriptorPath(parent)}/.review`, { mode: 0o755 });
                fsyncSync(parent.fd);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              }
            }
            try {
              directory = fs.open(directoryPath);
            } catch (error) {
              if (missing(error) && review.state === "cleared") return { status: "removed", path };
              throw error;
            }
            if (!directory.stat.isDirectory()) refuse("blocked", "review directory is not a directory");
            refuseShared(fs, directoryPath);
            checkBinding(fs, parent, directory, project);
            if (review.state === "pending") ensureIgnore(fs, parent, directory, project, store, options);
            const name = filename(review),
              old = existing(fs, directory, name, identity(store, review));
            if (review.state === "cleared") {
              // Refresh state under this source lock immediately before the derived removal.
              if (store.getReview(project.root, reviewId)?.state !== "cleared")
                refuse("stale", "review is not cleared");
              checkBinding(fs, parent, directory, project);
              checkExisting(fs, directory, name, old);
              if (old !== null) {
                unlinkSync(`${fs.descriptorPath(directory)}/${name}`);
                fsyncSync(directory.fd);
              }
              checkBinding(fs, parent, directory, project);
              return { status: "removed", path };
            }
            const text = render(store, review);
            if (Buffer.byteLength(text) > REVIEW_ARTIFACT_LIMITS.bytes)
              refuse("unavailable", "review metadata exceeds artifact bound");
            if (old?.text === text) {
              checkBinding(fs, parent, directory, project);
              checkExisting(fs, directory, name, old);
              return { status: "written", path };
            }
            temp = `.artifact.${randomBytes(16).toString("hex")}.tmp`;
            const { fd } = createTemporary(fs, parent, directory, project, temp);
            try {
              writeAllSync(fd, text);
              fsyncSync(fd);
              temporaryStat = fstatSync(fd);
            } finally {
              closeSync(fd);
            }
            options.onStep?.("temporary_synced");
            options.onStep?.("before_publish");
            checkBinding(fs, parent, directory, project);
            checkExisting(fs, directory, name, old);
            const temporaryNow = lstatSync(`${fs.descriptorPath(directory)}/${temp}`);
            if (
              !temporaryNow.isFile() ||
              temporaryNow.nlink !== 1 ||
              !same(temporaryNow, temporaryStat) ||
              temporaryNow.size !== temporaryStat.size ||
              temporaryNow.mtimeMs !== temporaryStat.mtimeMs ||
              temporaryNow.ctimeMs !== temporaryStat.ctimeMs
            )
              refuse("blocked", "temporary artifact binding changed");
            if (store.getReview(project.root, reviewId)?.reviewRevision !== review.reviewRevision)
              refuse("stale", "review changed before publication");
            renameSync(`${fs.descriptorPath(directory)}/${temp}`, `${fs.descriptorPath(directory)}/${name}`);
            temp = undefined;
            published = true;
            options.onStep?.("published");
            fsyncSync(directory.fd);
            checkBinding(fs, parent, directory, project);
            const committed = lstatSync(`${fs.descriptorPath(directory)}/${name}`);
            if (!committed.isFile() || committed.nlink !== 1 || !same(committed, temporaryStat))
              refuse("stale", "published artifact binding changed");
            if (store.getReview(project.root, reviewId)?.reviewRevision !== review.reviewRevision)
              refuse("stale", "review changed during publication");
            return { status: "written", path };
          } catch (error) {
            if (published)
              return {
                status: "stale",
                ...(path ? { path } : {}),
                message: "artifact publication needs reconciliation",
              };
            throw error;
          } finally {
            if (temp !== undefined && temporaryStat !== undefined && directory !== undefined && fs.bound(directory)) {
              try {
                const temporaryPath = `${fs.descriptorPath(directory)}/${temp}`,
                  now = lstatSync(temporaryPath);
                if (now.isFile() && now.nlink === 1 && same(now, temporaryStat)) unlinkSync(temporaryPath);
              } catch {
                /* Preserve the original failure; unknown entries stay untouched. */
              }
            }
            if (directory !== undefined) closeSync(directory.fd);
            if (parent !== undefined) closeSync(parent.fd);
          }
        },
        options.lockTimeoutMs,
      );
    } finally {
      if (source !== undefined) closeSync(source.fd);
      fs.close();
    }
  } catch (error) {
    if (error instanceof SourceWriteError && error.code === "source_busy")
      return { status: "blocked", ...(path ? { path } : {}), message: REVIEW_SOURCE_BUSY };
    return {
      status: error instanceof Refusal ? error.status : missing(error) ? "unavailable" : "blocked",
      ...(path ? { path } : {}),
      message: error instanceof Refusal ? error.message : "review artifact unavailable; private review unchanged",
    };
  }
}
