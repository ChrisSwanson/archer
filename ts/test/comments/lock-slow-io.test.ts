// The comments lock under slow I/O, with the slowness injected where it hurts.
// Measured in the CI image under cgroup write throttling, fsync a no-op: one
// acquisition spent 3.6 s before its claim was even visible, and unlinking a
// published claim waited for the writeback ext4 starts when a file is renamed
// over another (auto_da_alloc): p50 281 ms, max 10.9 s.
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { afterEach, expect, test, vi } from "vitest";
import { lastCommentsLockTiming, withCommentsLock, writerClaimDirectory } from "../../src/comments/lock.ts";
import { findProject } from "../../src/project/index.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

const slow = vi.hoisted(() => ({ publishMs: 0, unlinkClaimMs: 0, unlinkInertMs: 0, skewMs: 0 }));
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      // A claim publication (its ticket renamed over the claim) that takes `publishMs` on the clock, without really waiting.
      if (String(to).endsWith(".claim")) slow.skewMs += slow.publishMs;
      return real.renameSync(from, to);
    },
    unlinkSync: (path: string) => {
      if (String(path).endsWith(".claim")) pause(slow.unlinkClaimMs);
      return real.unlinkSync(path);
    },
    // The renamed claim is the same file, so its removal stays slow off the caller's path.
    unlink: (path: string, done: (error: NodeJS.ErrnoException | null) => void) => {
      setTimeout(() => real.unlink(path, done), String(path).endsWith(".tmp") ? slow.unlinkInertMs : 0);
    },
  };
});

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  Object.assign(slow, { publishMs: 0, unlinkClaimMs: 0, unlinkInertMs: 0, skewMs: 0 });
  vi.restoreAllMocks();
  removeTempDirs();
});
const writers = (root: string) => writerClaimDirectory(findProject(root), "flow.comments.json");
const list = (root: string): string[] => {
  try {
    return list(root);
  } catch {
    return [];
  }
};
/** An owner that releases `afterContendedMs` after another writer publishes its ticket. */
function owner(root: string, afterContendedMs: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("./fixtures/lock-owner.ts", import.meta.url)),
      [root, String(afterContendedMs)],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    children.push(child);
    child.on("message", (msg: { holding?: boolean }) => {
      if (msg.holding) resolve(child);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`owner exited ${code}`));
    });
  });
}

// Seen on CI: the person's edit was refused while an agent's reply held the
// lock. The waiting budget had started before the entrant's own claim was
// published, so a slow publication spent it before any waiting began.
test("the deadline bounds only the wait on a contender, timed from the claim's publication", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  await owner(root, 300);
  slow.publishMs = 10_000;
  const real = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => real() + slow.skewMs);
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  expect(lastCommentsLockTiming()?.contenders).toBe(1); // it really waited on the owner
});

test("releasing the lock never waits for the claim file's removal", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  Object.assign(slow, { unlinkClaimMs: 8_000, unlinkInertMs: 500 });
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  expect(lastCommentsLockTiming()!.releaseMs).toBeLessThan(slow.unlinkClaimMs);
  // The claim is out of the contenders' sight at once, and its file goes off the caller's path.
  expect(list(root).filter((name) => name.endsWith(".claim"))).toEqual([]);
  await vi.waitFor(() => expect(list(root)).toEqual([]), { timeout: 12_000 });
}, 20_000); // red, the release alone waits the injected 8 s

// The same wait sat on the path of the next writer after a crash: clearing a
// dead owner's claim unlinked it. Measured: the SIGKILL'd-owner test spent 28 s.
test("clearing a dead owner's claim never waits for the file's removal", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  mkdirSync(writers(root), { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", ""]);
  expect(dead.status).toBe(0);
  writeFileSync(join(writers(root), `${dead.pid}.${"c".repeat(12)}.${"c".repeat(24)}.claim`), "1");
  Object.assign(slow, { unlinkClaimMs: 8_000, unlinkInertMs: 500 });
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  const timing = lastCommentsLockTiming()!; // the dead claim is cleared while publishing and waiting
  expect(timing.publishMs + timing.waitMs).toBeLessThan(slow.unlinkClaimMs);
  expect(list(root).filter((name) => name.endsWith(".claim"))).toEqual([]);
  await vi.waitFor(() => expect(list(root)).toEqual([]), { timeout: 12_000 });
}, 20_000); // as above
