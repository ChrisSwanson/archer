// Watches one project for the changes that matter to its page: anything in
// the Archer folder (recursively), and archer.toml or the folder itself
// appearing in the project root. Every burst of events becomes one call of
// `onChange` after a short quiet period; the caller re-reads and recompiles
// only what changed.
//
// The folder may not exist when the project is attached, may be deleted and
// made again, and archer.toml may move it; `sync` re-aims the folder watcher
// after every reload.
//
// One non-recursive watcher per directory, not one recursive watcher: on
// Linux (Node 24) a recursive fs.watch reported the first temp-file-and-
// rename of a file and then stopped reporting later ones, and every write
// Archer makes is such a rename (writeConfined), so an agent's reply never
// reached the page. Directories are rescanned after every burst, so ones made
// or removed later are picked up.
import {
  existsSync,
  lstatSync,
  opendirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  watch,
  type Dir,
  type FSWatcher,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { activeTelemetry } from "../telemetry/index.ts";

export const QUIET_MS = 60;

/**
 * How long after the process's set of watched directories last changed every watcher rescans (macOS).
 * libuv on macOS serves every directory watcher in a process from one FSEvents stream, and stops and
 * makes it again whenever a watcher is added or closed: a change made while it is remade is never
 * reported, in any project the service watches (measured: 6–13 of 60 writes lost under watcher churn,
 * none without). Linux's inotify has a watch per directory and loses nothing this way.
 */
export const WATCH_SET_SETTLE_MS = 250;

/**
 * The longest a rescan waits once the watch set first changed: steady churn (a directory made and removed
 * every few hundred ms) would otherwise postpone it for ever, and changes missed meanwhile stay missed.
 * It is also the shortest gap between two rescans, so a watcher that keeps failing and re-attaching cannot
 * reload every project several times a second.
 */
export const WATCH_SET_MAX_DELAY_MS = 1_000;

/** The rescans of the live watchers that resync after a change to the watch set. */
const resyncing = new Set<() => void>();
let resyncTimer: NodeJS.Timeout | null = null;
/** When the pending rescan's first change happened, and when the last rescan ran (monotonicMs). */
let resyncPendingSince = 0;
let lastResync = -Infinity;
/** The OS's monotonic clock, in ms: these timers run on real time, whatever a caller does to performance.now. */
const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/** The process's watch set changed: once it has settled, every resyncing watcher rescans (one reload each). */
function watchSetChanged(): void {
  if (resyncing.size === 0) return;
  const now = monotonicMs();
  if (resyncTimer === null) resyncPendingSince = now;
  else clearTimeout(resyncTimer);
  const due = Math.max(
    Math.min(now + WATCH_SET_SETTLE_MS, resyncPendingSince + WATCH_SET_MAX_DELAY_MS),
    lastResync + WATCH_SET_MAX_DELAY_MS,
  );
  resyncTimer = setTimeout(
    () => {
      resyncTimer = null;
      lastResync = monotonicMs();
      for (const rescan of [...resyncing]) rescan();
    },
    Math.max(0, due - now),
  );
  resyncTimer.unref();
}

export interface ProjectWatcherOptions {
  readonly log?: (line: string) => void;
  readonly trace?: (line: string) => void;
  readonly watch?: typeof watch;
  /** Called on every relevant event as it arrives, before the quiet period: what was read may be stale now. */
  readonly onEvent?: () => void;
  /** Rescan after any change to the process's watch set (WATCH_SET_SETTLE_MS); macOS by default. */
  readonly resyncOnWatchSetChange?: boolean;
}

function watchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return `${code === undefined ? "unknown" : code}: ${error.message}`;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

const unavailable = "unavailable";

/** Passive, bounded Linux process evidence. It opens no watchers and never inspects another process. */
function emfileDiagnostics(): Record<string, unknown> {
  const diagnostic: Record<string, unknown> = {
    event: "watch-emfile",
    realUid: typeof process.getuid === "function" ? process.getuid() : unavailable,
    openFdCount: unavailable,
    inotifyFdCount: unavailable,
    softMaxOpenFiles: unavailable,
    uidMap: unavailable,
    maxUserInstances: unavailable,
  };
  if (process.platform !== "linux") return diagnostic;
  let descriptors: Dir | undefined;
  try {
    descriptors = opendirSync("/proc/self/fd");
    let count = 0;
    let inotify = 0;
    let unreadable = 0;
    let complete = false;
    let truncated = false;
    try {
      while (count < 4096) {
        const entry = descriptors.readSync();
        if (entry === null) {
          complete = true;
          break;
        }
        count++;
        try {
          if (readlinkSync(`/proc/self/fd/${entry.name}`) === "anon_inode:inotify") inotify++;
        } catch {
          unreadable++;
        }
      }
      if (!complete) {
        const extra = descriptors.readSync();
        if (extra === null) complete = true;
        else truncated = true;
      }
    } catch {
      /* Retain honest lower bounds from entries already observed. */
    }
    diagnostic.openFdCount = complete
      ? count
      : truncated
        ? `atLeast:${count};truncated`
        : `atLeast:${count};unavailable`;
    diagnostic.inotifyFdCount =
      truncated && unreadable === 0
        ? `atLeast:${inotify};truncated`
        : unreadable === 0 && complete
          ? inotify
          : `atLeast:${inotify};unavailable:${unreadable}${truncated ? ";truncated" : ""}`;
  } catch {
    /* EMFILE itself may prevent opening /proc/self/fd. */
  } finally {
    try {
      descriptors?.closeSync();
    } catch {
      /* Best effort only. */
    }
  }
  try {
    const line = readFileSync("/proc/self/limits", "utf8")
      .split("\n")
      .find((value) => value.startsWith("Max open files"));
    const soft = line?.trim().split(/\s+/)[3];
    if (soft !== undefined) diagnostic.softMaxOpenFiles = /^\d+$/.test(soft) ? Number(soft) : soft;
  } catch {
    /* Best effort only. */
  }
  try {
    const map = readFileSync("/proc/self/uid_map", "utf8").trim();
    diagnostic.uidMap = map.length <= 512 ? map : `${map.slice(0, 512)}[truncated]`;
  } catch {
    /* Best effort only. */
  }
  try {
    const limit = readFileSync("/proc/sys/fs/inotify/max_user_instances", "utf8").trim();
    diagnostic.maxUserInstances = /^\d+$/.test(limit) ? Number(limit) : limit.slice(0, 64) || unavailable;
  } catch {
    /* Best effort only. */
  }
  return diagnostic;
}

export class ProjectWatcher {
  #rootWatcher: FSWatcher | null = null;
  #dirWatchers = new Map<string, FSWatcher>();
  #watchedFolder: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  #emfileReported = false;
  #additionalDirectories: readonly string[] = [];
  readonly #rescan = (): void => this.#poke();
  readonly #resync: boolean;

  constructor(
    private readonly root: string,
    private folder: string,
    private readonly onChange: () => void,
    additionalDirectories: readonly string[] = [],
    private readonly options: ProjectWatcherOptions = {},
  ) {
    this.#resync = options.resyncOnWatchSetChange ?? process.platform === "darwin";
    if (this.#resync) resyncing.add(this.#rescan);
    this.#rootWatcher = this.#watch(
      root,
      () => {},
      (name) => {
        const first = relative(root, this.folder).split(sep)[0];
        if (name === null || name === "archer.toml" || name === first) this.#poke();
      },
    );
    this.sync(folder, additionalDirectories);
  }

  /** Points the folder watchers at `folder` and every directory under it that exists now. */
  sync(folder: string, additionalDirectories: readonly string[] = this.#additionalDirectories): void {
    if (this.#closed) return;
    if (folder !== this.#watchedFolder) this.#closeDirs();
    this.folder = folder;
    this.#additionalDirectories = additionalDirectories.slice(0, 1100);
    const exists = existsSync(folder) && statSync(folder).isDirectory();
    if (!exists && this.#additionalDirectories.length === 0) {
      this.#closeDirs();
      return;
    }
    this.#watchedFolder = folder;
    const wanted = new Set(exists ? directories(folder) : []);
    for (const directory of this.#additionalDirectories) {
      const rel = relative(this.root, directory);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      try {
        let at = this.root;
        let safe = true;
        for (const part of rel.split(sep).filter(Boolean)) {
          at = join(at, part);
          if (lstatSync(at).isSymbolicLink()) {
            safe = false;
            break;
          }
        }
        const actual = relative(this.root, realpathSync(directory));
        if (
          safe &&
          actual !== ".." &&
          !actual.startsWith(`..${sep}`) &&
          !isAbsolute(actual) &&
          lstatSync(directory).isDirectory()
        )
          wanted.add(directory);
      } catch {
        /* Gone or replaced since the admitted traversal. */
      }
    }
    for (const [dir, watcher] of this.#dirWatchers)
      if (!wanted.has(dir)) {
        watcher.close();
        this.#dirWatchers.delete(dir);
        this.#watchSetChanged();
      }
    for (const dir of wanted) {
      if (this.#dirWatchers.has(dir)) continue;
      const watcher = this.#watch(dir, () => {
        this.#dirWatchers.delete(dir);
      });
      if (watcher !== null) this.#dirWatchers.set(dir, watcher);
    }
  }

  #closeDirs(): void {
    for (const watcher of this.#dirWatchers.values()) watcher.close();
    if (this.#dirWatchers.size > 0) this.#watchSetChanged();
    this.#dirWatchers.clear();
    this.#watchedFolder = null;
  }

  /** How many directories are watched now, the project root included. */
  get watching(): number {
    return (this.#rootWatcher === null ? 0 : 1) + this.#dirWatchers.size;
  }

  close(): void {
    this.#closed = true;
    resyncing.delete(this.#rescan);
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (this.#rootWatcher !== null) {
      this.#rootWatcher.close();
      this.#watchSetChanged();
    }
    this.#closeDirs();
  }

  #watch(path: string, onGone: () => void, on: (name: string | null) => void = () => this.#poke()): FSWatcher | null {
    try {
      const watcher = (this.options.watch ?? watch)(path, { persistent: false }, (kind, name) => {
        const text = name === null ? null : String(name);
        activeTelemetry()?.watchEvent(this.root);
        this.options.trace?.(
          `[archer] watcher trace: event path=${JSON.stringify(path)} kind=${JSON.stringify(kind)} name=${JSON.stringify(text)}`,
        );
        on(text);
      });
      watcher.on("error", (error) => {
        this.options.log?.(`[archer] watcher: watch failed for ${path}: ${watchFailure(error)}`);
        this.#reportEmfile(error);
        // The directory went away under the watcher: forget it; the next sync re-aims.
        watcher.close();
        this.#watchSetChanged();
        onGone();
        this.#poke();
      });
      this.options.trace?.(`[archer] watcher trace: registered path=${JSON.stringify(path)}`);
      this.#watchSetChanged();
      return watcher;
    } catch (error) {
      this.options.log?.(`[archer] watcher: could not watch ${path}: ${watchFailure(error)}`);
      this.#reportEmfile(error);
      return null;
    }
  }

  #reportEmfile(error: unknown): void {
    if (this.#emfileReported || this.options.log === undefined || errorCode(error) !== "EMFILE") return;
    this.#emfileReported = true;
    let diagnostic: Record<string, unknown>;
    try {
      diagnostic = emfileDiagnostics();
    } catch {
      diagnostic = { event: "watch-emfile", metrics: unavailable };
    }
    this.options.log(`[archer] watcher diagnostics: ${JSON.stringify(diagnostic)}`);
  }

  #watchSetChanged(): void {
    if (this.#resync) watchSetChanged();
  }

  #poke(): void {
    if (this.#closed) return;
    this.options.onEvent?.();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#closed) return;
      // Pick up directories made or removed in this burst before reporting it.
      this.sync(this.folder);
      this.onChange();
    }, QUIET_MS);
  }
}

/**
 * `folder` and every directory under it, skipping dot-directories and links
 * (as the inventory does), so a link can never widen what is watched.
 */
function directories(folder: string): string[] {
  const out = [folder];
  for (let i = 0; i < out.length && out.length < 1_000; i++) {
    const dir = out[i] as string;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      try {
        if (lstatSync(path).isDirectory()) out.push(path);
      } catch {
        // Gone between the listing and the look.
      }
    }
  }
  return out;
}
