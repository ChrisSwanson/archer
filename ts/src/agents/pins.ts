// What of the listener registry and delivery outlives the service (ADR 0035 §7, review decision 16):
// the registered agents (id, root, cwd, host, label, host PID), the claims, the person's pins, the
// threads' owners (conversation affinity) and each thread's delivery record (decision 55). A small private
// JSON file in the service state directory, `listeners.json`, written atomically (0600). Writer and reader
// share one byte bound, MAX_LISTENERS_BYTES: the writer drops the oldest records, then the oldest owners (then
// unclaimed agents, claims and pins, which in practice never come to it) to stay under it. A file the
// reader cannot take (over the bound, not JSON, not this format) is set aside under a new name and logged,
// never silently erased, and the service starts with nothing remembered.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { AgentHost, AgentInfo } from "./contract.ts";

export const PINS_FILE = "listeners.json";
/** The one byte bound of `listeners.json`, for the writer and the reader alike. */
export const MAX_LISTENERS_BYTES = 1024 * 1024;
const MAX_PINS = 256;
const MAX_AGENTS = 512;
/** The most thread owners kept in memory: the oldest are dropped first. */
export const MAX_OWNERS = 4096;
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const AGENT_ID = /^ag-[0-9a-f]{12}$/;
const HOSTS: readonly AgentHost[] = ["claude-code", "codex", "other"];
const CONTROL = /[\u0000-\u001f\u007f]/u;
/** The longest agent label, in code points: the registry cuts to it and the reader checks it the same way (decision 26). */
export const MAX_LABEL = 80;

/** The label cut to MAX_LABEL code points, never splitting a surrogate pair. */
export const boundLabel = (label: string): string => [...label].slice(0, MAX_LABEL).join("");

/** Checkout root -> thread id -> the agent that last answered that thread (conversation affinity). */
export type Owners = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** A registered agent as kept: its info, and the host process it runs in when it said. */
export interface StoredAgent extends AgentInfo {
  readonly hostPid?: number;
}

/**
 * One person comment as its thread's recipient received it (decisions 55, 57): its hash then, and the
 * sequence number of the hand-over (an answer, or a pull) that recorded it. Records only move forward: a
 * hand-over writes a comment's entry only when its sequence is newer than the one there.
 */
export interface Delivered {
  readonly hash: string;
  readonly seq: number;
}

/**
 * What one thread's recipient received: comment id -> Delivered. A comment whose hash is not its current
 * one, or that has none, is delivered (again).
 */
export type DeliveryRecord = ReadonlyMap<string, Delivered>;

/** Thread key (threadKey) -> its record, the least recently written first. */
export type DeliveryRecords = ReadonlyMap<string, DeliveryRecord>;

/**
 * Hand-over sequence numbers stay below this (decision 59): far from Number.MAX_SAFE_INTEGER, so a counter
 * read from a file can always advance. At one hand-over a microsecond it takes nine years to reach.
 */
export const MAX_SEQ = 2 ** 48;

/** The most threads with a record, on load as when written (decision 55). */
export const MAX_RECORDS = 5_000;

/** A comment's delivered hash: 12 hex digits of a sha256. */
export const RECORD_HASH = /^[0-9a-f]{12}$/;

export const threadKey = (root: string, threadId: string): string => `${root}\0${threadId}`;

function threadOf(key: string): { root: string; threadId: string } | null {
  const [root, threadId, ...rest] = key.split("\0");
  return root === undefined || threadId === undefined || rest.length > 0 ? null : { root, threadId };
}

/** The most comments remembered as launched for (once per message), in memory and on disk; the oldest go first. */
export const MAX_LAUNCHED_FOR = 1_000;
/** The most projects whose last launch time is kept. */
const MAX_LAUNCHED_ROOTS = 256;

/**
 * What the launch safeguards remember across a restart or hand-over (X-17): every comment a launch carried
 * (`threadKey\0commentId`, oldest first), so none starts another automatic launch, and when each project last
 * launched, for the 30-second window. Ids and times only: no message text, no sender, no credential.
 */
export interface Launches {
  readonly launchedFor: readonly string[];
  readonly launched: ReadonlyMap<string, number>;
}

/** Everything kept. `pins` and `claims` map a checkout root to an agent id among `agents`. */
export interface ListenerSnapshot {
  readonly agents: readonly StoredAgent[];
  readonly claims: ReadonlyMap<string, string>;
  readonly pins: ReadonlyMap<string, string>;
  readonly owners: Owners;
  readonly records: DeliveryRecords;
  /** The highest hand-over sequence number given out, so a restart keeps the order (decision 57). */
  readonly deliverySeq: number;
  /** Absent in a file written before 2026-10-31's fix batch 3: nothing remembered. */
  readonly launches?: Launches;
}

/** Where the snapshot is kept. The registry saves its part, delivery its records; each save writes both. */
export interface ListenerStore {
  load(): ListenerSnapshot;
  save(part: Partial<ListenerSnapshot>): void;
}

const EMPTY: ListenerSnapshot = {
  agents: [],
  claims: new Map(),
  pins: new Map(),
  owners: new Map(),
  records: new Map(),
  deliverySeq: 0,
};

const copyOwners = (owners: Owners): Map<string, Map<string, string>> =>
  new Map([...owners].map(([root, threads]) => [root, new Map(threads)]));

function copy(snapshot: ListenerSnapshot): ListenerSnapshot {
  return {
    agents: [...snapshot.agents],
    claims: new Map(snapshot.claims),
    pins: new Map(snapshot.pins),
    owners: copyOwners(snapshot.owners),
    records: new Map(snapshot.records),
    deliverySeq: snapshot.deliverySeq,
    ...(snapshot.launches === undefined
      ? {}
      : {
          launches: { launchedFor: [...snapshot.launches.launchedFor], launched: new Map(snapshot.launches.launched) },
        }),
  };
}

/** For tests and for a service without a state directory. */
export class MemoryListenerStore implements ListenerStore {
  #snapshot: ListenerSnapshot = EMPTY;
  load(): ListenerSnapshot {
    return copy(this.#snapshot);
  }
  save(part: Partial<ListenerSnapshot>): void {
    this.#snapshot = copy({ ...this.#snapshot, ...part });
  }
}

export class FileListenerStore implements ListenerStore {
  readonly #path: string;
  readonly #log: (line: string) => void;
  /** What the file holds, as last read or written. */
  #snapshot: ListenerSnapshot | undefined;
  constructor(
    readonly stateDir: string,
    log: (line: string) => void = () => {},
  ) {
    this.#path = join(stateDir, PINS_FILE);
    this.#log = log;
  }

  load(): ListenerSnapshot {
    this.#snapshot = this.#read();
    return copy(this.#snapshot);
  }

  save(part: Partial<ListenerSnapshot>): void {
    this.#snapshot = { ...(this.#snapshot ?? this.#read()), ...part };
    writeAtomically(this.#path, serialize(this.#snapshot));
  }

  #read(): ListenerSnapshot {
    const read = readPrivate(this.#path);
    if (read.kind === "absent") return EMPTY;
    if (read.kind === "ok") {
      let value: unknown;
      try {
        value = JSON.parse(read.text) as unknown;
      } catch {
        value = undefined;
      }
      const snapshot = value === undefined ? null : parse(value);
      if (snapshot !== null) return snapshot;
    }
    this.#setAside(
      read.kind === "too_large"
        ? `it is over ${MAX_LISTENERS_BYTES} bytes`
        : read.kind === "unreadable"
          ? "it is not a private regular file of this user"
          : "it is not a listeners file this service reads",
    );
    return EMPTY;
  }

  /** The file is kept under another name for the person to look at, and the service starts afresh. */
  #setAside(why: string): void {
    const aside = `${this.#path}.${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(3).toString("hex")}.set-aside`;
    try {
      renameSync(this.#path, aside);
      this.#log(
        `[archer] listeners: ${PINS_FILE} was set aside as ${aside} because ${why}; listeners, pins and delivery records start empty`,
      );
    } catch (failure) {
      this.#log(
        `[archer] listeners: ${PINS_FILE} cannot be read (${why}) and could not be set aside (${failure instanceof Error ? failure.message : String(failure)}); it is left as it is and will be replaced on the next save`,
      );
    }
  }
}

// ------------------------------------------------------------ writing

interface Wire {
  version: 1;
  /** Root -> the pinned agent's info (one of `agents`). */
  pins: Record<string, StoredAgent>;
  agents: StoredAgent[];
  claims: Record<string, string>;
  owners?: Record<string, Record<string, string>>;
  /**
   * Each thread's record, the least recently written first across every root (decision 50): `roots` once
   * each, and per thread [index in roots, threadId, {commentId: [hash, seq]}], and `seq`, the highest
   * sequence given out.
   */
  records?: { roots: string[]; threads: [number, string, Record<string, [string, number]>][]; seq: number };
  /** Launches (X-17): `roots` once each; `launched` [index, ms since the epoch]; `launchedFor` [index, threadId, commentId], oldest first. */
  launches?: { roots: string[]; launched: [number, number][]; launchedFor: [number, string, string][] };
}

/** The file's text, at most MAX_LISTENERS_BYTES: the oldest records and owners go first past the bound (a dropped record costs a re-send, never a loss). */
export function serialize(snapshot: ListenerSnapshot): string {
  const agents = new Map(snapshot.agents.map((agent) => [agent.agentId, agent]));
  const pins = new Map([...snapshot.pins].filter(([, id]) => agents.has(id)));
  const claims = new Map([...snapshot.claims].filter(([, id]) => agents.has(id)));
  const owners = copyOwners(snapshot.owners);
  const launchedFor = (snapshot.launches?.launchedFor ?? []).slice(-MAX_LAUNCHED_FOR).flatMap((key) => {
    const [root, threadId, commentId, ...rest] = key.split("\0");
    return root === undefined || threadId === undefined || commentId === undefined || rest.length > 0
      ? []
      : [{ root, threadId, commentId }];
  });
  const launched = [...(snapshot.launches?.launched ?? new Map<string, number>())].slice(-MAX_LAUNCHED_ROOTS);
  const held = [...snapshot.records].slice(-MAX_RECORDS).flatMap(([key, record]) => {
    const thread = threadOf(key);
    return thread === null ? [] : [{ ...thread, record }];
  });
  const text = (): string => {
    const roots = new Map<string, number>();
    const listed = held.map(({ root, threadId, record }): [number, string, Record<string, [string, number]>] => {
      let index = roots.get(root);
      if (index === undefined) {
        index = roots.size;
        roots.set(root, index);
      }
      return [index, threadId, Object.fromEntries([...record].map(([id, { hash, seq }]) => [id, [hash, seq]]))];
    });
    const ownersOut = [...owners].filter(([, threads]) => threads.size > 0);
    const launchRoots = new Map<string, number>();
    const at = (root: string): number => {
      let index = launchRoots.get(root);
      if (index === undefined) {
        index = launchRoots.size;
        launchRoots.set(root, index);
      }
      return index;
    };
    const launchesOut = {
      launched: launched.map(([root, ms]): [number, number] => [at(root), ms]),
      launchedFor: launchedFor.map(({ root, threadId, commentId }): [number, string, string] => [
        at(root),
        threadId,
        commentId,
      ]),
    };
    const wire: Wire = {
      version: 1,
      pins: Object.fromEntries([...pins].map(([root, id]) => [root, agents.get(id)!])),
      agents: [...agents.values()],
      claims: Object.fromEntries(claims),
      ...(ownersOut.length === 0
        ? {}
        : { owners: Object.fromEntries(ownersOut.map(([root, threads]) => [root, Object.fromEntries(threads)])) }),
      ...(held.length === 0 && snapshot.deliverySeq === 0
        ? {}
        : { records: { roots: [...roots.keys()], threads: listed, seq: snapshot.deliverySeq } }),
      ...(launched.length === 0 && launchedFor.length === 0
        ? {}
        : { launches: { roots: [...launchRoots.keys()], ...launchesOut } }),
    };
    return `${JSON.stringify(wire)}\n`;
  };
  const quarter = (count: number): number => Math.max(1, Math.ceil(count / 4));
  for (let out = text(); ; out = text()) {
    if (Buffer.byteLength(out) <= MAX_LISTENERS_BYTES) return out;
    const ownerCount = [...owners.values()].reduce((sum, threads) => sum + threads.size, 0);
    if (held.length > 0) held.splice(0, quarter(held.length));
    else if (ownerCount > 0) dropOldestOwners(owners, quarter(ownerCount));
    // A dropped launch marker costs at most one more automatic launch for the owner's own unread message.
    else if (launchedFor.length > 0) launchedFor.splice(0, quarter(launchedFor.length));
    else if (launched.length > 0) launched.splice(0, quarter(launched.length));
    else {
      // Past here only agents, claims and pins are left, which their own bounds keep far below the limit.
      const held = new Set([...claims.values(), ...pins.values()]);
      const loose = [...agents.values()]
        .filter((agent) => !held.has(agent.agentId))
        .sort((a, b) => Date.parse(a.lastActive) - Date.parse(b.lastActive));
      if (loose.length > 0) for (const agent of loose.slice(0, quarter(loose.length))) agents.delete(agent.agentId);
      else {
        const unpinned = [...claims.keys()].filter((root) => !pins.has(root));
        const victim = unpinned[0] ?? [...pins.keys()][0];
        if (victim === undefined) return out;
        const id = claims.get(victim) ?? pins.get(victim)!;
        claims.delete(victim);
        pins.delete(victim);
        if (![...claims.values(), ...pins.values()].includes(id)) agents.delete(id);
      }
    }
  }
}

/** Takes `count` owners, each root's oldest first, a root at a time in turn. */
function dropOldestOwners(owners: Map<string, Map<string, string>>, count: number): void {
  while (count > 0) {
    let dropped = false;
    for (const threads of owners.values()) {
      const oldest = threads.keys().next();
      if (oldest.done === true) continue;
      threads.delete(oldest.value);
      dropped = true;
      if (--count === 0) return;
    }
    if (!dropped) return;
  }
}

function writeAtomically(path: string, text: string): void {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed */
    }
  }
}

// ------------------------------------------------------------ reading

/** The snapshot in a parsed file, or null when it is not one (the file is then set aside). */
export function parse(value: unknown): ListenerSnapshot | null {
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["pins"])) return null;
  const agents = new Map<string, StoredAgent>();
  const listed = value["agents"];
  if (!Array.isArray(listed) || listed.length > MAX_AGENTS) return null;
  for (const entry of listed) {
    const agent = storedAgent(entry);
    if (agent === null) return null;
    agents.set(agent.agentId, agent);
  }
  const pinEntries = Object.entries(value["pins"]);
  if (pinEntries.length > MAX_PINS) return null;
  const pins = new Map<string, string>();
  for (const [root, entry] of pinEntries) {
    const agent = storedAgent(entry);
    if (!rootPath(root) || agent === null || !agents.has(agent.agentId)) return null;
    pins.set(root, agent.agentId);
  }
  const claims = new Map<string, string>();
  const claimed = value["claims"];
  if (!isRecord(claimed) || Object.keys(claimed).length > MAX_AGENTS) return null;
  for (const [root, id] of Object.entries(claimed)) {
    if (!rootPath(root) || typeof id !== "string" || !AGENT_ID.test(id)) return null;
    claims.set(root, id);
  }
  const owners = value["owners"] === undefined ? new Map() : readOwners(value["owners"]);
  if (owners === null) return null;
  return {
    agents: [...agents.values()],
    claims,
    pins,
    owners,
    ...readRecords(value["records"]),
    launches: readLaunches(value["launches"]),
  };
}

/** The launches in file order, tolerantly: an entry that is not one is skipped; past the bounds the oldest go. */
function readLaunches(value: unknown): Launches {
  const launchedFor: string[] = [];
  const launched = new Map<string, number>();
  if (!isRecord(value) || !Array.isArray(value["roots"])) return { launchedFor, launched };
  const roots = value["roots"] as unknown[];
  const rootAt = (index: unknown): string | null => {
    const root = Number.isSafeInteger(index) ? roots[index as number] : undefined;
    return typeof root === "string" && rootPath(root) ? root : null;
  };
  for (const entry of Array.isArray(value["launched"]) ? (value["launched"] as unknown[]) : []) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const root = rootAt(entry[0]),
      ms = entry[1] as unknown;
    if (root === null || !Number.isSafeInteger(ms) || (ms as number) < 0) continue;
    launched.delete(root);
    launched.set(root, ms as number);
  }
  for (const entry of Array.isArray(value["launchedFor"]) ? (value["launchedFor"] as unknown[]) : []) {
    if (!Array.isArray(entry) || entry.length !== 3) continue;
    const root = rootAt(entry[0]),
      [, threadId, commentId] = entry as unknown[];
    if (
      root === null ||
      typeof threadId !== "string" ||
      !THREAD_ID.test(threadId) ||
      typeof commentId !== "string" ||
      !THREAD_ID.test(commentId)
    )
      continue;
    launchedFor.push(`${threadKey(root, threadId)}\0${commentId}`);
  }
  for (const root of [...launched.keys()].slice(0, Math.max(0, launched.size - MAX_LAUNCHED_ROOTS)))
    launched.delete(root);
  return { launchedFor: launchedFor.slice(-MAX_LAUNCHED_FOR), launched };
}

function readOwners(value: unknown): Owners | null {
  if (!isRecord(value)) return null;
  const owners = new Map<string, Map<string, string>>();
  let count = 0;
  for (const [root, threads] of Object.entries(value)) {
    if (!rootPath(root) || !isRecord(threads)) return null;
    const map = new Map<string, string>();
    for (const [threadId, agentId] of Object.entries(threads)) {
      if (!THREAD_ID.test(threadId) || typeof agentId !== "string" || !AGENT_ID.test(agentId) || ++count > MAX_OWNERS)
        return null;
      map.set(threadId, agentId);
    }
    owners.set(root, map);
  }
  return owners;
}

/**
 * The records in file order, tolerantly: an entry that is not one is skipped, never the file; past
 * MAX_RECORDS threads the oldest go (each a re-send at worst, never a loss).
 */
function readRecords(value: unknown): { records: Map<string, DeliveryRecord>; deliverySeq: number } {
  const records = new Map<string, DeliveryRecord>();
  if (!isRecord(value) || !Array.isArray(value["roots"]) || !Array.isArray(value["threads"]))
    return { records, deliverySeq: 0 };
  const roots = value["roots"] as unknown[];
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < MAX_SEQ;
  // The saved high-water mark is taken only when it is a count below MAX_SEQ; else, and whenever it is
  // below a stored record's, the highest stored record sequence stands (decision 59).
  let deliverySeq = count(value["seq"]) ? value["seq"] : 0;
  for (const entry of value["threads"] as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3) continue;
    const [index, threadId, comments] = entry as unknown[];
    const root = Number.isSafeInteger(index) ? roots[index as number] : undefined;
    if (
      typeof root !== "string" ||
      !rootPath(root) ||
      typeof threadId !== "string" ||
      !THREAD_ID.test(threadId) ||
      !isRecord(comments)
    )
      continue;
    const record = new Map<string, Delivered>();
    for (const [commentId, entry] of Object.entries(comments)) {
      if (!THREAD_ID.test(commentId)) continue;
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [hash, seq] = entry as unknown[];
      if (typeof hash !== "string" || !RECORD_HASH.test(hash) || !count(seq)) continue;
      record.set(commentId, { hash, seq });
      deliverySeq = Math.max(deliverySeq, seq);
    }
    const key = threadKey(root, threadId);
    records.delete(key);
    records.set(key, record);
  }
  for (const key of [...records.keys()].slice(0, Math.max(0, records.size - MAX_RECORDS))) records.delete(key);
  return { records, deliverySeq };
}

function storedAgent(value: unknown): StoredAgent | null {
  if (!isRecord(value)) return null;
  const { agentId, root, cwd, host, label, lastActive, hostPid } = value;
  const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !CONTROL.test(v);
  if (
    !text(agentId, 32) ||
    !AGENT_ID.test(agentId) ||
    !text(root, 4096) ||
    !isAbsolute(root) ||
    !text(cwd, 4096) ||
    !isAbsolute(cwd)
  )
    return null;
  if (
    typeof host !== "string" ||
    !HOSTS.includes(host as AgentHost) ||
    typeof label !== "string" ||
    CONTROL.test(label) ||
    [...label].length > MAX_LABEL ||
    !text(lastActive, 64) ||
    !Number.isFinite(Date.parse(lastActive))
  )
    return null;
  if (hostPid !== undefined && (!Number.isSafeInteger(hostPid) || (hostPid as number) <= 0)) return null;
  return {
    agentId,
    root,
    cwd,
    host: host as AgentHost,
    label,
    lastActive,
    ...(hostPid === undefined ? {} : { hostPid: hostPid as number }),
  };
}

const rootPath = (root: string): boolean => isAbsolute(root) && !CONTROL.test(root) && root.length <= 4096;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type Read = { kind: "absent" } | { kind: "ok"; text: string } | { kind: "too_large" } | { kind: "unreadable" };

/** A regular file of this user, not a link, non-blocking and bounded by MAX_LISTENERS_BYTES. */
function readPrivate(path: string): Read {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  } catch (failure) {
    return (failure as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid()))
      return { kind: "unreadable" };
    if (stat.size > MAX_LISTENERS_BYTES) return { kind: "too_large" };
    const buffer = Buffer.alloc(MAX_LISTENERS_BYTES + 1);
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_LISTENERS_BYTES) return { kind: "too_large" };
    }
    return { kind: "ok", text: buffer.subarray(0, total).toString("utf8") };
  } catch {
    return { kind: "unreadable" };
  } finally {
    closeSync(fd);
  }
}
