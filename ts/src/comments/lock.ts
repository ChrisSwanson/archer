/**
 * Local, cross-process writer transactions for one file (Lamport's bakery).
 *
 * Every Archer writer of a project file (browser Save, MCP/CLI writes, pin,
 * presentation save, comments, emphases, review-artifact refresh)
 * enters here, in the service and in offline CLI/MCP processes alike.
 *
 * Protocol. Claims live in PRIVATE per-user runtime state, never in the repo:
 * `<writers root>/<sha256(canonical path)[0..32]>/<pid>.<owner>.<random>.claim`.
 * The writers root is `ARCHER_WRITERS_DIR`, else `<state>/writers` where
 * `<state>` is `ARCHER_STATE_DIR`, else `$XDG_STATE_HOME/archer` (the same
 * base directory every front door reads, independent of the service name),
 * so the service and the offline CLI/MCP agree as long as they share that
 * environment. The canonical path is `realpath.native` of the file (or of its
 * parent plus the final name for a new file), so case aliases and symlinked
 * routes to one file share one lock.
 *
 * Each entrant FIRST publishes a unique empty claim (choosing), THEN atomically
 * renames its selected ticket over that claim. It waits for every choosing
 * entrant and every lower (ticket, name) pair. A late entrant either appeared
 * as choosing in our scan, or sees our published ticket and chooses above it.
 * A claim is removed by renaming it to an inert temporary, out of every later
 * scan at once, and unlinking that off the caller's path.
 *
 * Liveness is the PID plus `<owner>`, a digest of the process's boot id and
 * start time. A claim whose PID is gone, or whose PID now belongs to a
 * different process (reuse) or a different boot, is stale and reclaimed. Only
 * when the start time cannot be read at all is a running PID trusted. There is
 * no age-based stealing: a suspended live process still owns its transaction.
 * Unknown files in a claim directory are removed or ignored, never followed.
 * Waiting is a short synchronous bound (callers run on the service's event
 * loop); background work passes a smaller one and retries later.
 * Assumes atomic create/rename and coherent directory reads on one machine;
 * network filesystems and writers bypassing Archer's lock are not coordinated.
 *
 * Mixed versions are not coordinated either. Archer 0.6.4 to 0.15.0 remove a
 * claim directory once it is empty, and on macOS (APFS) that removal can
 * succeed around a claim just created in it, taking the claim out of every
 * other writer's sight. This version never removes one, and begins its work
 * only on a scan that shows its own claim (`withCommentsLock`), but a removal
 * by an older writer after that scan, or during the work, is not detectable:
 * two writers may then overlap. Run one version at a time: stop older Archer
 * services and agent sessions before writing with a newer one.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlink,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { serviceDirs, ensurePrivateDir } from "../service/paths.ts";
import { confine, resolveInFolder, type Project } from "../project/index.ts";

/** The longest a writer waits on live contenders. Holders run one synchronous write. */
export const COMMENTS_LOCK_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 2_000;
const MAX_CLAIMS = 256;
/** Entries scanned per pass; past it a pass cleans what it can and refuses. */
const MAX_ENTRIES = 4_096;
const CLAIM = /^([1-9][0-9]{0,9})\.([a-f0-9]{12})\.([a-f0-9]{24})\.claim$/;
const TEMPORARY = /^\.([1-9][0-9]{0,9})\.([a-f0-9]{12})\.[a-f0-9]{24}\.claim\.[a-f0-9]{12}\.tmp$/;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Where one acquisition spent its time, for diagnosing refusals: preparing
 * the claim directory, publishing the claim, waiting on contenders that
 * were really there, the work, and removing the claim.
 */
export interface CommentsLockTiming {
  setupMs: number;
  publishMs: number;
  waitMs: number;
  workMs: number;
  releaseMs: number;
  /** The most contenders seen ahead at once (0: entered without waiting). */
  contenders: number;
}

export class CommentsLockError extends Error {
  constructor(
    message: string,
    readonly timing?: Readonly<CommentsLockTiming>,
  ) {
    super(message);
  }
}

/** A private-state failure, distinct from contention and from the protected file's I/O. */
export class WriterStateError extends Error {
  constructor(
    readonly directory: string,
    cause: unknown,
  ) {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    super(
      `Could not access private writer-state directory ${directory}${typeof code === "string" ? ` (${code})` : ""}. Check its permissions, or set ARCHER_WRITERS_DIR to a writable private directory.`,
      { cause },
    );
    this.name = "WriterStateError";
  }
}

function privateWriterState<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof CommentsLockError) throw error;
    throw new WriterStateError(writersRoot(), error);
  }
}

let lastTiming: CommentsLockTiming | null = null;
/** The timing of this process's most recent acquisition, entered or refused. */
export function lastCommentsLockTiming(): CommentsLockTiming | null {
  return lastTiming;
}

/** Bounded on-disk vocabulary: empty means choosing; invalid bytes are undefined. */
export function parseClaimTicket(raw: string): number | null | undefined {
  if (raw === "") return null;
  if (raw.length > 16 || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n < Number.MAX_SAFE_INTEGER ? n : undefined;
}

/** The private directory holding every file's claim directory. */
export function writersRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["ARCHER_WRITERS_DIR"];
  if (explicit !== undefined && isAbsolute(explicit)) return explicit;
  return join(serviceDirs(env).stateDir, "writers");
}

let bootId: string | undefined;
function boot(): string {
  if (bootId !== undefined) return bootId;
  try {
    bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    bootId = "";
  } // not Linux: `ps` start times are absolute wall times
  return bootId;
}

/**
 * `ps -o lstart=` for `pid` in `env`: null when no such process exists, undefined when it cannot be read.
 * Off Linux this is the only start time there is; /bin/ps, not PATH's.
 */
function psStart(pid: number, env: NodeJS.ProcessEnv): string | null | undefined {
  let text: string;
  try {
    text = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
  } catch (error) {
    return (error as { status?: number }).status === 1 ? null : undefined;
  }
  return text === "" ? null : text;
}

/**
 * When `pid` started, in epoch ms, off Linux: null when no such process exists, undefined when unreadable.
 * Read in the C locale and in UTC: lstart follows LC_TIME and TZ, so two processes with different
 * locales or time zones would otherwise place one start differently. To the second, rounded down.
 */
export function processStartMs(pid: number): number | null | undefined {
  const text = psStart(pid, { ...process.env, LC_ALL: "C", TZ: "UTC0" });
  if (typeof text !== "string") return text;
  const ms = Date.parse(`${text} GMT`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * A digest naming one process incarnation: null when no such process exists,
 * undefined when its start time cannot be read (then a running PID is trusted).
 * Linux: boot id and start ticks. Elsewhere: the start in epoch seconds, the same for every reader.
 */
export function ownerToken(pid: number): string | null | undefined {
  let start: string;
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
    }
    // Field 22 (starttime, clock ticks since boot); fields restart after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields.length < 20 || !/^[0-9]+$/.test(fields[19]!)) return undefined;
    start = `${boot()}:${fields[19]}`;
  } else {
    const ms = processStartMs(pid);
    if (typeof ms !== "number") return ms;
    start = `start-utc:${Math.floor(ms / 1000)}`;
  }
  return createHash("sha256").update(start).digest("hex").slice(0, 12);
}

/**
 * The token Archer 0.14 and earlier wrote off Linux: lstart's text in the writer's own locale and time
 * zone. Accepted so a 0.14 service or writer still running during the upgrade is not taken for dead.
 */
function legacyOwnerToken(pid: number): string | null | undefined {
  const text = psStart(pid, process.env);
  return typeof text === "string" ? createHash("sha256").update(text).digest("hex").slice(0, 12) : text;
}

/** Whether `owner`, as a claim, lock or registry entry recorded it, names the process now running as `pid`. */
export function ownerMatches(pid: number, owner: string, now: string | null | undefined = ownerToken(pid)): boolean {
  if (now === owner) return true;
  return process.platform !== "linux" && typeof now === "string" && legacyOwnerToken(pid) === owner;
}

let selfToken: string | undefined;
function self(): string {
  // Unreadable for ourselves too: a fixed token, so liveness falls back to the PID.
  return (selfToken ??= ownerToken(process.pid) ?? "0".repeat(12));
}

/** True while the process that wrote a claim (pid + owner token) still runs. */
function living(pid: number, owner: string, seen: Map<number, string | null | undefined>): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  if (pid === process.pid) return owner === self();
  const names = (now: string | null | undefined) =>
    now !== null && (now === undefined || owner === "0".repeat(12) || ownerMatches(pid, owner, now));
  if (!seen.has(pid)) seen.set(pid, ownerToken(pid));
  if (names(seen.get(pid))) return true;
  // What this acquisition remembers of `pid` says another process (or none): read it again before calling the
  // claim stale. Its PID may have gone to a new process since, which then published this claim (PID reuse during
  // an acquisition); judged by the remembered token, its live claim was discarded and both writers entered.
  const now = ownerToken(pid);
  seen.set(pid, now);
  return names(now);
}

function ticketAt(path: string): number | null | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(17);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return count > 16 ? undefined : parseClaimTicket(bytes.subarray(0, count).toString("utf8"));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function claims(
  directory: string,
  seen: Map<number, string | null | undefined>,
): { name: string; ticket: number | null }[] {
  const entries = readdirSync(directory);
  const found: { name: string; ticket: number | null }[] = [];
  for (const name of entries.slice(0, MAX_ENTRIES)) {
    const path = join(directory, name);
    try {
      // Never read, follow or remove a link or directory; nothing of ours is one.
      if (!lstatSync(path).isFile()) continue;
      const inert = TEMPORARY.exec(name);
      if (inert !== null) {
        // an unpublished input or a released claim
        if (!living(Number(inert[1]), inert[2]!, seen)) unlink(path, () => {});
        continue;
      }
      const match = CLAIM.exec(name);
      if (match === null) {
        unlink(path, () => {});
        continue;
      } // private state: not ours to keep
      if (!living(Number(match[1]), match[2]!, seen)) {
        discard(directory, name);
        continue;
      }
      // A live owner's unreadable ticket still excludes, as if choosing.
      found.push({ name, ticket: ticketAt(path) ?? null });
    } catch (error) {
      if (!gone(error)) throw error; // owner exited/released meanwhile
    }
  }
  if (entries.length > MAX_ENTRIES || found.length > MAX_CLAIMS)
    throw new CommentsLockError(`too many writer claims in ${directory}`);
  return found;
}

/**
 * Takes a claim (ours on release, or a stale owner's) out of the contenders'
 * sight by renaming it to an inert temporary name, then removes that file off
 * the caller's path. Unlinking a published claim directly waited for the
 * writeback ext4 starts when a file is renamed over another (auto_da_alloc):
 * p50 281 ms and up to 10.9 s on a congested disk, and every waiter waited
 * with it (seen on CI). The rename does not wait.
 *
 * The emptied claim directory is kept. Removing it raced the next entrant of
 * the same file: on macOS (APFS) a claim created while the rmdir was under way
 * failed EINVAL, and now and then the rmdir succeeded around a just-created
 * claim, so its writer held a claim in a directory no longer at its path, out
 * of every other writer's sight (measured 2026-11-15: four processes each
 * entering 20 000 times, about 0.3% EINVAL and a few lost directories; none
 * with the directory kept). One empty private directory per file ever written.
 */
function discard(directory: string, name: string): void {
  const claim = join(directory, name);
  const inert = join(directory, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    renameSync(claim, inert);
  } catch (error) {
    if (!gone(error)) unlinkSync(claim);
    return;
  }
  unlink(inert, () => {});
}

/** Writes the ticket beside the claim, then renames it over: no partial ticket reads. */
function publish(directory: string, name: string, ticket: number): void {
  const temporary = join(directory, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, String(ticket));
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, join(directory, name)); // claims are runtime state: no fsync
}

let rootReady: string | undefined;
function claimDirectory(project: Project, path: string): string {
  const destination = resolveInFolder(project, path);
  let canonical: string;
  try {
    canonical = realpathSync.native(destination);
  } catch (error) {
    if (!gone(error)) throw error;
    canonical = join(realpathSync.native(dirname(destination)), basename(destination));
  }
  confine(project, canonical);
  const root = writersRoot();
  if (rootReady !== root) {
    privateWriterState(() => ensurePrivateDir(root));
    rootReady = root;
  }
  return join(root, createHash("sha256").update(canonical).digest("hex").slice(0, 32));
}

/**
 * Whether creating a claim failed only because its directory is gone or going: ENOENT once it is gone, EINVAL on
 * macOS (APFS) while an rmdir is under way. This version keeps claim directories (`discard`), but a writer from an
 * earlier Archer still running, or a person tidying private state, may remove one.
 */
const removingDirectory = (error: unknown) => gone(error) || (error as NodeJS.ErrnoException).code === "EINVAL";

/** Creates our choosing claim, recreating a directory that was removed or is being removed. */
function enter(directory: string, name: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = lstatSync(directory, { throwIfNoEntry: false });
    if (info !== undefined && !info.isDirectory())
      throw new CommentsLockError("writer claim directory is not a plain directory");
    try {
      closeSync(
        openSync(
          join(directory, name),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        ),
      );
      return;
    } catch (error) {
      if (!removingDirectory(error) || attempt >= 8) throw error;
      // Past a first immediate retry, a moment for the removal under way to finish.
      if (attempt > 0) Atomics.wait(sleepCell, 0, 0, 1);
    }
  }
}

/** A round whose claim went out of sight before its work began (`withCommentsLock`). */
const LOST = Symbol("claim lost");
/** Rounds one acquisition makes when its claim keeps going out of sight. */
const ROUNDS = 3;

/**
 * Serializes the WHOLE read/change/write/delete operation, not just its write.
 *
 * Work begins only on a scan that shows this writer's own published claim at the directory's path: one that does
 * not (the directory removed, or replaced by an empty one, by an earlier Archer's writer; on APFS an rmdir under
 * way can succeed around a just-created claim) is a round lost, and the acquisition starts over in a fresh claim.
 * Removal during the work itself cannot be seen from here; this version never removes a claim directory.
 */
export function withCommentsLock<T>(
  project: Project,
  path: string,
  work: () => T,
  timeoutMs = COMMENTS_LOCK_TIMEOUT_MS,
): T {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
    throw new CommentsLockError("invalid comment lock deadline");
  lastTiming = null;
  const directory = claimDirectory(project, path);
  for (let round = 1; ; round++) {
    const outcome = acquire(directory, work, timeoutMs);
    if (outcome !== LOST) return outcome.value;
    if (round >= ROUNDS)
      throw new CommentsLockError(
        "this writer's claim kept being removed while it waited (another writer removed its directory); try again",
        lastTiming ?? undefined,
      );
  }
}

/** One round: a fresh claim, its ticket, the wait; the work's value, or LOST when the claim went out of sight first. */
function acquire<T>(directory: string, work: () => T, timeoutMs: number): { value: T } | typeof LOST {
  const start = performance.now();
  const name = `${process.pid}.${self()}.${randomBytes(12).toString("hex")}.claim`;
  const seen = new Map<number, string | null | undefined>();
  privateWriterState(() => enter(directory, name)); // empty = choosing, visible BEFORE selecting a ticket
  const began = performance.now();
  const timing: CommentsLockTiming = {
    setupMs: began - start,
    publishMs: 0,
    waitMs: 0,
    workMs: 0,
    releaseMs: 0,
    contenders: 0,
  };
  lastTiming = timing;
  /** The claims at the directory's path, or LOST when ours (choosing, or with our ticket) is not among them. */
  const scan = (ticket: number | null): { name: string; ticket: number | null }[] | typeof LOST => {
    let found: { name: string; ticket: number | null }[];
    try {
      found = claims(directory, seen);
    } catch (error) {
      if (gone(error)) return LOST;
      throw error;
    }
    return found.some((c) => c.name === name && c.ticket === ticket) ? found : LOST;
  };
  try {
    const choosing = privateWriterState(() => scan(null));
    if (choosing === LOST) return LOST;
    const mine = 1 + Math.max(0, ...choosing.map((c) => c.ticket ?? 0));
    if (!Number.isSafeInteger(mine) || mine >= Number.MAX_SAFE_INTEGER)
      throw new CommentsLockError("comment writer ticket exhausted");
    // The directory gone or going before the ticket is in it (its temporary is created as the claim was, and
    // meets the same ENOENT or APFS EINVAL): this round is lost too.
    const placed = privateWriterState(() => {
      try {
        publish(directory, name, mine);
        return true;
      } catch (error) {
        if (removingDirectory(error)) return false;
        throw error;
      }
    });
    if (!placed) return LOST;
    const published = performance.now();
    timing.publishMs = published - began;
    // The budget is for waiting on others, so it starts once our ticket is
    // visible: a slow publication of our own is not contention.
    const deadline = published + timeoutMs;
    for (;;) {
      const found = privateWriterState(() => scan(mine));
      if (found === LOST) return LOST;
      const ahead = found.filter(
        (c) => c.name !== name && (c.ticket === null || c.ticket < mine || (c.ticket === mine && c.name < name)),
      ).length;
      timing.waitMs = performance.now() - published;
      if (ahead === 0) {
        const entered = performance.now();
        try {
          return { value: work() };
        } finally {
          timing.workMs = performance.now() - entered;
        }
      }
      timing.contenders = Math.max(timing.contenders, ahead);
      // Only after a contender is seen: the deadline bounds WAITING. Checked
      // first, a slow claim publication (an fsync on a loaded disk) was
      // refused as contention with no other writer present (seen on CI).
      if (performance.now() >= deadline)
        throw new CommentsLockError("comments are being changed by another process; try again", timing);
      Atomics.wait(sleepCell, 0, 0, Math.min(5, Math.max(1, deadline - performance.now())));
    }
  } finally {
    const releasing = performance.now();
    privateWriterState(() => discard(directory, name));
    timing.releaseMs = performance.now() - releasing;
  }
}

/** The private claim directory for one project file (tests and diagnostics). */
export function writerClaimDirectory(project: Project, path: string): string {
  return claimDirectory(project, path);
}
/** A claim name this process would publish (tests and diagnostics). */
export function ownClaimName(): string {
  return `${process.pid}.${self()}.${randomBytes(12).toString("hex")}.claim`;
}
