// The watcher must report every change, including the temp-file-and-rename
// writes Archer itself makes (writeConfined): on Linux, a recursive fs.watch
// reported the first such rename and then went quiet, so an agent's reply
// never reached the page live.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectWatcher, QUIET_MS, WATCH_SET_MAX_DELAY_MS, WATCH_SET_SETTLE_MS } from "../../src/service/watch.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    opendirSync: vi.fn(actual.opendirSync),
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    readlinkSync: vi.fn(actual.readlinkSync),
  };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const made: string[] = [];
afterEach(() => {
  vi.mocked(fs.opendirSync).mockImplementation(actualFs.opendirSync);
  vi.mocked(fs.readdirSync).mockImplementation(actualFs.readdirSync);
  vi.mocked(fs.readFileSync).mockImplementation(actualFs.readFileSync);
  vi.mocked(fs.readlinkSync).mockImplementation(actualFs.readlinkSync);
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const settle = (ms = QUIET_MS * 4): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
const atomicWrite = (path: string, text: string): void => {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};

test.each([".archer", ".archer/sub"])(
  "every atomic rewrite in %s is reported",
  async (dir) => {
    const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
    made.push(root);
    const folder = join(root, ".archer");
    mkdirSync(join(root, dir), { recursive: true });
    let changes = 0;
    const watcher = new ProjectWatcher(root, folder, () => changes++);
    try {
      await settle(WATCH_SET_SETTLE_MS + QUIET_MS * 4);
      // Count from here: macOS's FSEvents also delivers the folder creation that happened just before the
      // watcher started (an earlier, real change), which Linux's inotify does not, and the watcher rescans once
      // its watch set has settled (WATCH_SET_SETTLE_MS). Each rewrite after it is one report.
      const before = changes;
      for (let i = 1; i <= 4; i++) {
        atomicWrite(join(root, dir, "a.comments.json"), `{"n":${i}}`);
        await settle();
        expect(changes - before, `after write ${i}`).toBe(i);
      }
    } finally {
      watcher.close();
    }
  },
  15_000,
); // waits out the watcher's quiet period after each write: 1.2 s idle; timed out at 5 s on CI

test("a folder made after the watcher started is watched too", async () => {
  const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
  made.push(root);
  const folder = join(root, ".archer");
  mkdirSync(folder);
  let changes = 0;
  const watcher = new ProjectWatcher(root, folder, () => changes++);
  try {
    mkdirSync(join(folder, "later"));
    await settle();
    watcher.sync(folder);
    const before = changes;
    atomicWrite(join(folder, "later", "x.mmd"), "flowchart TB\n");
    await settle();
    expect(changes).toBeGreaterThan(before);
  } finally {
    watcher.close();
  }
});

test("a synchronous watch registration failure logs its path and error code", () => {
  const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
  made.push(root);
  const folder = join(root, ".archer");
  mkdirSync(folder);
  const lines: string[] = [];
  const watch = vi.fn(() => {
    throw Object.assign(new Error("watch quota exhausted"), { code: "ENOSPC" });
  });

  const watcher = new ProjectWatcher(root, folder, () => {}, [], {
    log: (line) => lines.push(line),
    watch: watch as never,
  });
  try {
    expect(lines).toContain(`[archer] watcher: could not watch ${root}: ENOSPC: watch quota exhausted`);
    expect(lines).toContain(`[archer] watcher: could not watch ${folder}: ENOSPC: watch quota exhausted`);
    expect(lines.some((line) => line.includes('"event":"watch-emfile"'))).toBe(false);
  } finally {
    watcher.close();
  }
});

test("the first EMFILE registration failure logs bounded passive process diagnostics once", () => {
  const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
  made.push(root);
  const folder = join(root, ".archer");
  mkdirSync(folder);
  const lines: string[] = [];
  let changes = 0;
  const watch = vi.fn(() => {
    throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
  });

  const watcher = new ProjectWatcher(root, folder, () => changes++, [], {
    log: (line) => lines.push(line),
    watch: watch as never,
  });
  try {
    watcher.sync(folder);
    expect(lines).toContain(`[archer] watcher: could not watch ${root}: EMFILE: too many open files`);
    expect(lines).toContain(`[archer] watcher: could not watch ${folder}: EMFILE: too many open files`);
    const diagnostics = lines.filter((line) => line.startsWith("[archer] watcher diagnostics: "));
    expect(diagnostics).toHaveLength(1);
    const payload = JSON.parse(diagnostics[0]!.slice("[archer] watcher diagnostics: ".length)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual(
      ["event", "inotifyFdCount", "maxUserInstances", "openFdCount", "realUid", "softMaxOpenFiles", "uidMap"].sort(),
    );
    expect(payload.event).toBe("watch-emfile");
    expect(payload.realUid).toBe(typeof process.getuid === "function" ? process.getuid() : "unavailable");
    for (const key of ["openFdCount", "inotifyFdCount", "softMaxOpenFiles", "uidMap", "maxUserInstances"]) {
      expect(["number", "string"], key).toContain(typeof payload[key]);
      if (typeof payload[key] === "string") expect(payload[key].length, key).toBeLessThanOrEqual(524);
    }
    expect(changes).toBe(0);
  } finally {
    watcher.close();
  }
});

test("EMFILE diagnostics survive unavailable process metrics without leaking read failures", () => {
  const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
  made.push(root);
  const folder = join(root, ".archer");
  mkdirSync(folder);
  const lines: string[] = [];
  let changes = 0;
  vi.mocked(fs.opendirSync).mockImplementation(((path: fs.PathLike, options?: unknown) => {
    if (String(path).startsWith("/proc/")) throw new Error("SECRET_OPENDIR_FAILURE");
    return actualFs.opendirSync(path, options as never);
  }) as typeof fs.opendirSync);
  vi.mocked(fs.readFileSync).mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(path).startsWith("/proc/")) throw new Error("SECRET_READ_FAILURE");
    return actualFs.readFileSync(path, options as never);
  }) as typeof fs.readFileSync);
  vi.mocked(fs.readlinkSync).mockImplementation(((path: fs.PathLike, options?: unknown) => {
    if (String(path).startsWith("/proc/")) throw new Error("SECRET_LINK_FAILURE");
    return actualFs.readlinkSync(path, options as never);
  }) as typeof fs.readlinkSync);
  const watch = vi.fn(() => {
    throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
  });

  const watcher = new ProjectWatcher(root, folder, () => changes++, [], {
    log: (line) => lines.push(line),
    watch: watch as never,
  });
  try {
    expect(lines).toContain(`[archer] watcher: could not watch ${root}: EMFILE: too many open files`);
    const diagnostics = lines.filter((line) => line.startsWith("[archer] watcher diagnostics: "));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).not.toContain("SECRET_");
    expect(JSON.parse(diagnostics[0]!.slice("[archer] watcher diagnostics: ".length))).toMatchObject({
      event: "watch-emfile",
      openFdCount: "unavailable",
      inotifyFdCount: "unavailable",
      softMaxOpenFiles: "unavailable",
      uidMap: "unavailable",
      maxUserInstances: "unavailable",
    });
    expect(changes).toBe(0);
  } finally {
    watcher.close();
  }
});

test("process metrics recover after a prior diagnostic read failure", () => {
  if (process.platform !== "linux") return;
  const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
  made.push(root);
  const folder = join(root, ".archer");
  mkdirSync(folder);
  const lines: string[] = [];
  const error = Object.assign(new Error("too many open files"), { code: "EMFILE" });
  const watcher = new ProjectWatcher(root, folder, () => {}, [], {
    log: (line) => lines.push(line),
    watch: (() => {
      throw error;
    }) as never,
  });
  try {
    const line = lines.find((value) => value.startsWith("[archer] watcher diagnostics: "))!;
    const payload = JSON.parse(line.slice("[archer] watcher diagnostics: ".length)) as Record<string, unknown>;
    expect(payload.realUid).toBe(process.getuid?.());
    expect(payload.uidMap).not.toBe("unavailable");
    expect(payload.maxUserInstances).not.toBe("unavailable");
  } finally {
    watcher.close();
  }
});

// The descriptor walk reads Linux's /proc/self/fd and counts inotify instances, which only Linux has; elsewhere
// emfileDiagnostics reports them "unavailable" without reading anything, which the non-Linux branch asserts.
test("EMFILE diagnostics bound FD iteration and close a truncated directory", () => {
  const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
  made.push(root);
  const folder = join(root, ".archer");
  mkdirSync(folder);
  const lines: string[] = [];
  let reads = 0;
  const closeSync = vi.fn();
  vi.mocked(fs.opendirSync).mockImplementation(((path: fs.PathLike, options?: unknown) => {
    if (String(path) !== "/proc/self/fd") return actualFs.opendirSync(path, options as never);
    return { readSync: () => ({ name: String(reads++) }), closeSync } as never;
  }) as typeof fs.opendirSync);
  vi.mocked(fs.readlinkSync).mockImplementation(((path: fs.PathLike, options?: unknown) => {
    if (String(path).startsWith("/proc/self/fd/")) return "anon_inode:inotify" as never;
    return actualFs.readlinkSync(path, options as never);
  }) as typeof fs.readlinkSync);
  const watch = vi.fn(() => {
    throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
  });

  const watcher = new ProjectWatcher(root, folder, () => {}, [], {
    log: (line) => lines.push(line),
    watch: watch as never,
  });
  try {
    const diagnostic = lines.find((line) => line.startsWith("[archer] watcher diagnostics: "))!;
    if (process.platform !== "linux") {
      // No /proc and no inotify: nothing is walked, and the counts say so rather than guess.
      expect(JSON.parse(diagnostic.slice("[archer] watcher diagnostics: ".length))).toMatchObject({
        openFdCount: "unavailable",
        inotifyFdCount: "unavailable",
      });
      expect(reads).toBe(0);
      expect(closeSync).not.toHaveBeenCalled();
      return;
    }
    expect(JSON.parse(diagnostic.slice("[archer] watcher diagnostics: ".length))).toMatchObject({
      openFdCount: "atLeast:4096;truncated",
      inotifyFdCount: "atLeast:4096;truncated",
    });
    expect(reads).toBe(4097);
    expect(closeSync).toHaveBeenCalledOnce();
  } finally {
    watcher.close();
  }
});

test("an asynchronous watcher error logs its path and error code", () => {
  const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
  made.push(root);
  const folder = join(root, ".archer");
  mkdirSync(folder);
  const lines: string[] = [];
  const handles = new Map<string, EventEmitter & { close(): void }>();
  const watch = vi.fn((path: string) => {
    const handle = Object.assign(new EventEmitter(), { close: vi.fn() });
    handles.set(path, handle);
    return handle as unknown as FSWatcher;
  });

  const watcher = new ProjectWatcher(root, folder, () => {}, [], {
    log: (line) => lines.push(line),
    watch: watch as never,
  });
  try {
    handles.get(folder)!.emit("error", Object.assign(new Error("watch descriptor lost"), { code: "EMFILE" }));
    handles.get(root)!.emit("error", Object.assign(new Error("watch descriptor lost again"), { code: "EMFILE" }));
    expect(lines).toContain(`[archer] watcher: watch failed for ${folder}: EMFILE: watch descriptor lost`);
    const diagnostics = lines.filter((line) => line.startsWith("[archer] watcher diagnostics: "));
    expect(diagnostics).toHaveLength(1);
    expect(Object.keys(JSON.parse(diagnostics[0]!.slice("[archer] watcher diagnostics: ".length))).sort()).toEqual(
      ["event", "inotifyFdCount", "maxUserInstances", "openFdCount", "realUid", "softMaxOpenFiles", "uidMap"].sort(),
    );
  } finally {
    watcher.close();
  }
});

test("optional tracing records successful registration and native callback receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
  made.push(root);
  const folder = join(root, ".archer");
  mkdirSync(folder);
  const lines: string[] = [];
  const callbacks = new Map<string, (kind: string, name: string | Buffer | null) => void>();
  const watch = vi.fn(
    (path: string, _options: unknown, callback: (kind: string, name: string | Buffer | null) => void) => {
      callbacks.set(path, callback);
      return Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as FSWatcher;
    },
  );

  const watcher = new ProjectWatcher(root, folder, () => {}, [], {
    trace: (line) => lines.push(line),
    watch: watch as never,
  });
  try {
    expect(lines).toEqual([
      `[archer] watcher trace: registered path=${JSON.stringify(root)}`,
      `[archer] watcher trace: registered path=${JSON.stringify(folder)}`,
    ]);
    callbacks.get(folder)!("rename", 'quoted"name.mmd');
    expect(lines.at(-1)).toBe(
      `[archer] watcher trace: event path=${JSON.stringify(folder)} kind=${JSON.stringify("rename")} name=${JSON.stringify('quoted"name.mmd')}`,
    );
  } finally {
    watcher.close();
  }
});

test("a change to the process's watch set makes every resyncing watcher rescan once it settles", async () => {
  // macOS: libuv remakes its one FSEvents stream whenever a directory watcher is added or closed, and a change
  // made meanwhile is never reported. A fake watch that reports nothing stands in for the lost event.
  const silent = (() => Object.assign(new EventEmitter(), { close: () => {} })) as never;
  const roots = [0, 1].map(() => {
    const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
    made.push(root);
    mkdirSync(join(root, ".archer"));
    return root;
  });
  let changes = 0;
  const first = new ProjectWatcher(roots[0]!, join(roots[0]!, ".archer"), () => changes++, [], {
    watch: silent,
    resyncOnWatchSetChange: true,
  });
  try {
    await settle(WATCH_SET_SETTLE_MS + QUIET_MS * 4);
    const before = changes;
    // Another project's watchers start (as on attach): the first project rescans, with no event of its own.
    const second = new ProjectWatcher(roots[1]!, join(roots[1]!, ".archer"), () => {}, [], {
      watch: silent,
      resyncOnWatchSetChange: true,
    });
    try {
      // The rescan is timers and disk reads: wait for it rather than for a fixed time, which a loaded host overran (O300).
      await expect.poll(() => changes - before, { timeout: 10_000 }).toBe(1);
      // Settled: nothing changes the watch set, so nothing rescans again.
      await settle(WATCH_SET_SETTLE_MS + QUIET_MS * 4);
      expect(changes - before).toBe(1);
    } finally {
      second.close();
    }
    // A watcher that does not resync (Linux's default) is not rescanned.
    let quiet = 0;
    const linux = new ProjectWatcher(roots[1]!, join(roots[1]!, ".archer"), () => quiet++, [], {
      watch: silent,
      resyncOnWatchSetChange: false,
    });
    linux.close();
    await settle(WATCH_SET_SETTLE_MS + QUIET_MS * 4);
    expect(quiet).toBe(0);
  } finally {
    first.close();
  }
});

test("steady watch-set churn neither postpones the rescan for ever nor repeats it more than once a second", async () => {
  const silent = (() => Object.assign(new EventEmitter(), { close: () => {} })) as never;
  const roots = [0, 1].map(() => {
    const root = mkdtempSync(join(tmpdir(), "archer-watch-"));
    made.push(root);
    mkdirSync(join(root, ".archer"));
    return root;
  });
  const rescans: number[] = [];
  const first = new ProjectWatcher(roots[0]!, join(roots[0]!, ".archer"), () => rescans.push(performance.now()), [], {
    watch: silent,
    resyncOnWatchSetChange: true,
  });
  try {
    await settle(WATCH_SET_MAX_DELAY_MS + QUIET_MS * 4);
    rescans.length = 0;
    // A watcher made and closed every 100 ms for 2.5 s: under the settle time each time.
    const began = performance.now();
    while (performance.now() - began < 2_500) {
      new ProjectWatcher(roots[1]!, join(roots[1]!, ".archer"), () => {}, [], {
        watch: silent,
        resyncOnWatchSetChange: true,
      }).close();
      await settle(100);
    }
    expect(rescans.length, "rescanned during the churn").toBeGreaterThanOrEqual(1);
    expect(rescans[0]! - began).toBeLessThanOrEqual(WATCH_SET_MAX_DELAY_MS + QUIET_MS * 4);
    for (let i = 1; i < rescans.length; i++)
      expect(rescans[i]! - rescans[i - 1]!).toBeGreaterThanOrEqual(WATCH_SET_MAX_DELAY_MS - 50);
  } finally {
    first.close();
  }
});
