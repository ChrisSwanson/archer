// The restart marker (ADR 0032): `<state dir>/restarting.json`, written by `archer restart` for the
// length of a hand-over. While it names a live restart, a front door waits for the replacement to
// answer instead of starting a service of its own.
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ownerToken } from "../comments/lock.ts";
import { entryAlive } from "./instances.ts";

const MARKER = "restarting.json";
/** The longest a front door waits for a hand-over before it gives up. */
export const HANDOVER_WAIT_MS = 10_000;

export const restartMarkerPath = (stateDir: string): string => join(stateDir, MARKER);

/** Marks a restart under way until `until` (epoch ms), for this process. */
export function writeRestartMarker(stateDir: string, until: number): void {
  const owner = ownerToken(process.pid);
  const temporary = join(stateDir, `.${MARKER}.${process.pid}.tmp`);
  writeFileSync(
    temporary,
    `${JSON.stringify({ pid: process.pid, owner: typeof owner === "string" ? owner : "0".repeat(12), until })}\n`,
    { mode: 0o600 },
  );
  renameSync(temporary, restartMarkerPath(stateDir));
}

/**
 * Claims the restart for this process until `until`: the marker is linked into place complete and
 * exclusively, so two restarts never both run. False when a live restart holds it; a stale marker
 * (its process gone, or its time up) is replaced.
 */
export function claimRestart(stateDir: string, until: number): boolean {
  const owner = ownerToken(process.pid);
  const temporary = join(stateDir, `.${MARKER}.${process.pid}.claim`);
  writeFileSync(
    temporary,
    `${JSON.stringify({ pid: process.pid, owner: typeof owner === "string" ? owner : "0".repeat(12), until })}\n`,
    { mode: 0o600 },
  );
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(temporary, restartMarkerPath(stateDir));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (restartInProgress(stateDir)) return false;
      try {
        unlinkSync(restartMarkerPath(stateDir));
      } catch {
        /* removed meanwhile */
      }
    }
    return false;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already gone */
    }
  }
}

/** Removes the marker if this process holds it. */
export function clearRestartMarker(stateDir: string): void {
  try {
    const { pid } = JSON.parse(readFileSync(restartMarkerPath(stateDir), "utf8")) as { pid?: unknown };
    if (pid === process.pid) unlinkSync(restartMarkerPath(stateDir));
  } catch {
    /* gone, or not ours */
  }
}

/** Whether a live restart holds the marker: its process runs, as that incarnation, and its time is not up. */
export function restartInProgress(stateDir: string, now = Date.now()): boolean {
  let fd: number;
  try {
    fd = openSync(restartMarkerPath(stateDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const stats = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stats.isFile() || stats.size > 512 || (uid !== undefined && stats.uid !== uid)) return false;
    const buffer = Buffer.alloc(stats.size);
    readSync(fd, buffer, 0, stats.size, 0);
    const { pid, owner, until } = JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid < 1 ||
      typeof owner !== "string" ||
      typeof until !== "number"
    )
      return false;
    return (
      until > now &&
      (owner === "0".repeat(12)
        ? (() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })()
        : entryAlive({ pid, owner }))
    );
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
