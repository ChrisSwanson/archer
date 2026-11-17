// The per-user registry of running services (ADR 0031). Every service, main or isolated, writes
// one entry to `<Archer home>/instances/<pid>-<owner>.json` once it serves, and removes it on a
// clean stop. The Archer home is `ARCHER_HOME`, else `~/.archer`: one place per person whatever
// the state directory, so copies started with different `ARCHER_STATE_DIR` or `XDG_STATE_HOME`
// values still see each other. A reader prunes entries whose process is gone, or whose pid now
// names another process (the owner token, comments/lock.ts, as the service lock does).
//
// MAIN: the service on the default state directory of the environment that started it.
// ISOLATED: an explicit, different `ARCHER_STATE_DIR` (tests, evals, demos).
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ownerMatches, ownerToken } from "../comments/lock.ts";
import { ensurePrivateDir, privateDirProblem, serviceDirs, type Env } from "./paths.ts";

export type InstanceKind = "main" | "isolated";

export interface InstanceEntry {
  readonly pid: number;
  /** The process's incarnation (boot id and start time digest): a reused pid is not trusted. */
  readonly owner: string;
  readonly version: string;
  readonly protocolVersion: number;
  readonly serviceName: string;
  readonly stateDir: string;
  readonly socketPath: string;
  /** The page's origin, without the token. */
  readonly url: string;
  readonly kind: InstanceKind;
  readonly startedAt: string;
  /** When it last had no client, stream or request; null while it has one. */
  readonly idleSince: string | null;
}

const absolute = (value: string | undefined): string | undefined =>
  value !== undefined && isAbsolute(value) ? value : undefined;

/** The person's Archer home: preferences and the instance registry. */
export function archerHome(env: Env = process.env): string {
  return absolute(env["ARCHER_HOME"]) ?? join(absolute(env["HOME"]) ?? homedir(), ".archer");
}

export const registryDir = (env: Env = process.env): string => join(archerHome(env), "instances");

/** Main when `stateDir` is the default one of `env` (ignoring its ARCHER_STATE_DIR), else isolated. */
export function instanceKind(stateDir: string, env: Env = process.env): InstanceKind {
  const { ARCHER_STATE_DIR: _ignored, ARCHER_SOCKET: _socket, ...rest } = env;
  return resolve(stateDir) === resolve(serviceDirs(rest).stateDir) ? "main" : "isolated";
}

const ENTRY = /^([1-9][0-9]{0,9})-([0-9a-f]{12})\.json$/;
const MAX_ENTRIES = 256;
const MAX_ENTRY_BYTES = 8192;

const fileName = (entry: Pick<InstanceEntry, "pid" | "owner">): string => `${entry.pid}-${entry.owner}.json`;

export interface Registration {
  readonly path: string;
  update(change: Partial<Pick<InstanceEntry, "idleSince">>): void;
  remove(): void;
}

function writeEntry(dir: string, entry: InstanceEntry): string {
  const path = join(dir, fileName(entry));
  const temporary = join(dir, `.${fileName(entry)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

/** Writes `entry` to the registry; the returned handle updates or removes it. */
export function registerInstance(env: Env, entry: InstanceEntry): Registration {
  const dir = registryDir(env);
  ensurePrivateDir(dir);
  let current = entry;
  const path = writeEntry(dir, current);
  let removed = false;
  return {
    path,
    update(change) {
      if (removed) return;
      current = { ...current, ...change };
      try {
        writeEntry(dir, current);
      } catch {
        /* the registry is advisory; the service keeps serving */
      }
    },
    remove() {
      removed = true;
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Whether the process an entry names is still that incarnation (unknowable start time: a running pid is trusted). */
export function entryAlive(entry: Pick<InstanceEntry, "pid" | "owner">): boolean {
  try {
    process.kill(entry.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  const now = ownerToken(entry.pid);
  return now === undefined || ownerMatches(entry.pid, entry.owner, now);
}

/** Whether the entry's process is verified as that Archer incarnation: its start time must be readable and match. */
export function entryVerified(entry: Pick<InstanceEntry, "pid" | "owner">): boolean {
  try {
    process.kill(entry.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  return ownerMatches(entry.pid, entry.owner);
}

/** The running services, oldest first. Dead, reused or unreadable entries of ours are removed; other files are ignored. */
export function listInstances(env: Env = process.env): InstanceEntry[] {
  const dir = registryDir(env);
  let names: string[];
  // Only a private folder of this user's is trusted: an entry names a process `stop --stale` may signal.
  try {
    if (privateDirProblem(dir, "the instance registry") !== undefined) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: InstanceEntry[] = [];
  for (const name of names.slice(0, MAX_ENTRIES)) {
    const match = ENTRY.exec(name);
    if (match === null) continue;
    const path = join(dir, name);
    const entry = readEntry(path);
    const valid = entry !== null && entry.pid === Number(match[1]) && entry.owner === match[2];
    if (!valid || !entryAlive(entry)) {
      try {
        unlinkSync(path);
      } catch {
        /* removed meanwhile */
      }
      continue;
    }
    found.push(entry);
  }
  return found.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function readEntry(path: string): InstanceEntry | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    const uid = process.getuid?.();
    if (
      !stats.isFile() ||
      stats.size > MAX_ENTRY_BYTES ||
      (uid !== undefined && stats.uid !== uid) ||
      (stats.mode & 0o077) !== 0
    )
      return null;
    const buffer = Buffer.alloc(stats.size);
    readSync(fd, buffer, 0, stats.size, 0);
    return parseEntry(JSON.parse(buffer.toString("utf8")));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function parseEntry(value: unknown): InstanceEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof v[key] === "string" && (v[key] as string).length <= 4096 ? (v[key] as string) : null;
  const pid = v["pid"],
    protocolVersion = v["protocolVersion"],
    idleSince = v["idleSince"];
  const owner = text("owner"),
    version = text("version"),
    serviceName = text("serviceName"),
    stateDir = text("stateDir");
  const socketPath = text("socketPath"),
    url = text("url"),
    startedAt = text("startedAt"),
    kind = v["kind"];
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid < 1 ||
    typeof protocolVersion !== "number" ||
    !Number.isInteger(protocolVersion)
  )
    return null;
  if (
    owner === null ||
    version === null ||
    serviceName === null ||
    stateDir === null ||
    socketPath === null ||
    url === null ||
    startedAt === null
  )
    return null;
  if (kind !== "main" && kind !== "isolated") return null;
  if (idleSince !== null && typeof idleSince !== "string") return null;
  if (!isAbsolute(stateDir) || !isAbsolute(socketPath)) return null;
  return { pid, owner, version, protocolVersion, serviceName, stateDir, socketPath, url, kind, startedAt, idleSince };
}

/** Numeric semver order; a pre-release sorts below its release; anything unparseable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number, number, number, string] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(v);
    return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""];
  };
  const x = parse(a),
    y = parse(b);
  if (x === null || y === null) return x === y ? 0 : x === null ? -1 : 1;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  if (x[3] === y[3]) return 0;
  if (x[3] === "") return 1;
  if (y[3] === "") return -1;
  return x[3] < y[3] ? -1 : 1;
}
