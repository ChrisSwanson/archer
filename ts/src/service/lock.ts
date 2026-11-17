// The service's identity and socket locks: `archer.lock`, holding `<pid> <owner>`, where
// `<owner>` names that process's incarnation (its boot and start time, comments/lock.ts).
//
// A lock is linked into place complete, so another starter never reads it half written (server
// review S9: an O_EXCL create followed by the pid write let a reader find it empty and steal
// it). A lock is stale when its process is gone, or when its pid now belongs to another process
// (S4: a reused pid blocked every start until the lock was deleted by hand). A lock written
// before owners were recorded (`<pid>` alone) is held while its pid runs and started before the
// lock was written.

import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { ownerMatches, ownerToken, processStartMs } from "../comments/lock.ts";

export interface LockHolder {
  readonly pid: number;
  readonly owner?: string;
}

/** `<pid> <owner>` as written; null when the content is not a lock's. */
export function parseLock(text: string): LockHolder | null {
  const match = /^([1-9][0-9]{0,9})(?: ([0-9a-f]{12}))?\s*$/.exec(text);
  if (match === null) return null;
  return match[2] === undefined ? { pid: Number(match[1]) } : { pid: Number(match[1]), owner: match[2] };
}

/** The holder of the lock at `path`, or null when it is missing or not a lock. */
export function readLock(path: string): LockHolder | null {
  try {
    return parseLock(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** This process's lock line. */
export function lockLine(pid = process.pid): string {
  const owner = ownerToken(pid);
  return typeof owner === "string" ? `${pid} ${owner}\n` : `${pid}\n`;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the lock at `path`, read as `holder`, still names a live holder. */
export function held(path: string, holder: LockHolder | null): boolean {
  if (holder === null || !running(holder.pid)) return false;
  const now = ownerToken(holder.pid);
  if (now === null) return false;
  if (now === undefined) return true; // the start time cannot be read: a running pid is trusted
  if (holder.owner !== undefined) return ownerMatches(holder.pid, holder.owner, now);
  // A lock from before owners were recorded: the pid was reused if its process started after the lock was written.
  return !startedAfter(holder.pid, path);
}

/** Whether `pid` started after `path` was last written (false when either cannot be read). */
function startedAfter(pid: number, path: string): boolean {
  const started = startedAt(pid);
  if (started === undefined) return false;
  try {
    return started > statSync(path).mtimeMs + 1_000;
  } catch {
    return false;
  }
}

/** When `pid` started, in epoch ms: /proc on Linux, else `ps` (processStartMs: C locale, UTC, to the second). */
function startedAt(pid: number): number | undefined {
  if (process.platform === "linux") {
    try {
      return statSync(`/proc/${pid}`).ctimeMs;
    } catch {
      return undefined;
    }
  }
  return processStartMs(pid) ?? undefined;
}

/**
 * Takes the lock at `path` for this process, replacing a stale one. Throws `taken(holder)` when a
 * live process holds it, and `raced()` when another starter took it meanwhile.
 *
 * A stale lock is removed only under `<path>.reclaim`, itself taken by link, and only while the
 * lock still reads as the stale holder judged: two starters that judged the same stale lock can
 * otherwise each remove it, the second removing the first's fresh lock (Codex review).
 * `afterJudged` is for tests: it runs between judging the lock stale and reclaiming it.
 */
export function takeLock(
  path: string,
  taken: (pid: number) => Error,
  raced: () => Error,
  afterJudged?: () => void,
): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
  const line = lockLine();
  writeFileSync(temporary, line, { mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(temporary, path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const text = readText(path);
      const holder = text === null ? null : parseLock(text);
      if (held(path, holder)) throw taken(holder!.pid);
      afterJudged?.();
      if (!reclaim(path, temporary, text)) throw raced();
    }
    throw raced();
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already gone */
    }
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Removes the lock at `path` if it still reads `stale`, holding `<path>.reclaim` meanwhile; false when another starter holds that. */
function reclaim(path: string, temporary: string, stale: string | null): boolean {
  const guard = `${path}.reclaim`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      linkSync(temporary, guard);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A guard left by a starter that died mid-reclaim is stale in turn.
      if (attempt === 1 || held(guard, readLock(guard))) return false;
      try {
        unlinkSync(guard);
      } catch {
        /* removed meanwhile */
      }
    }
  }
  try {
    // Only the guard's holder removes a lock, so it cannot change between this read and the unlink.
    if (readText(path) === stale) {
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    }
    return true;
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      /* already gone */
    }
  }
}

/** Removes the lock at `path` if this process holds it. */
export function releaseLock(path: string): void {
  if (readLock(path)?.pid !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}
