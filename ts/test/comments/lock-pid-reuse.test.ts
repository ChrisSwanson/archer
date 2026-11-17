// The comments lock when a contender's PID is reused while this writer is acquiring.
//
// A claim names its process by PID plus an owner token (its start time): a claim whose PID now belongs to another
// process is stale. One acquisition remembers each PID's token across its scans. When the process behind a PID
// exits and its PID is given to a new process that then publishes a claim, the remembered token is the old one's:
// read from that memory, the new process's live claim looked stale, was discarded, and both entered together.
import { mkdirSync, readdirSync as realReaddirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CommentsLockError, ownerToken, withCommentsLock, writerClaimDirectory } from "../../src/comments/lock.ts";
import { findProject } from "../../src/project/index.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

/** A PID no test process holds; `process.kill(PID, 0)` answers alive while the test says so. */
const PID = 3_999_999;
const reuse = vi.hoisted(() => ({
  /** The start time of the process now holding PID: the second it started, in UTC. */
  started: "Sun Nov 15 10:00:00 2026",
  /** Called before each listing of the claim directory under test, with the listing's number (1 first). */
  beforeListing: undefined as undefined | ((listing: number) => void),
  directory: "",
  listings: 0,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    // `ps -o lstart= -p PID`: the start time of whichever process holds PID now (off Linux).
    execFileSync: ((file: string, args: readonly string[], options: unknown) =>
      file === "/bin/ps" && args.at(-1) === String(PID)
        ? `${reuse.started}\n`
        : real.execFileSync(file, args as string[], options as never)) as typeof real.execFileSync,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    // `/proc/PID/stat` on Linux: field 22, its start in clock ticks, from the same start time.
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (String(path) === `/proc/${PID}/stat`) {
        const ticks = Date.parse(`${reuse.started} GMT`) / 10;
        return `${PID} (node) ${["S", ...Array.from({ length: 18 }, () => "0"), String(ticks)].join(" ")} 0 0\n`;
      }
      return (real.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.readFileSync,
    readdirSync: ((path: unknown, ...rest: unknown[]) => {
      if (reuse.directory !== "" && String(path) === reuse.directory) reuse.beforeListing?.(++reuse.listings);
      return (real.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.readdirSync,
  };
});

afterEach(() => {
  Object.assign(reuse, { started: "Sun Nov 15 10:00:00 2026", beforeListing: undefined, directory: "", listings: 0 });
  vi.restoreAllMocks();
  removeTempDirs();
});

const claimName = (token: string, random: string) => `${PID}.${token}.${random.padEnd(24, "0")}.claim`;

test("a contender whose PID was reused during this acquisition keeps its live claim, and this writer waits", () => {
  const realKill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) =>
    pid === PID ? true : realKill(pid, signal)) as typeof process.kill);
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const project = findProject(root);
  const directory = writerClaimDirectory(project, "flow.comments.json");
  // P, the process first holding PID, has published ticket 1.
  const before = ownerToken(PID)!;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, claimName(before, "a")), "1", { flag: "wx", mode: 0o600 });
  reuse.directory = directory;
  reuse.beforeListing = (listing) => {
    if (listing !== 2) return;
    // Between this writer's choosing scan and its first waiting scan: P exits, its PID goes to Q, and Q publishes
    // ticket 1 (it chose while this writer was still choosing, so it holds the lower ticket).
    rmSync(join(directory, claimName(before, "a")));
    reuse.started = "Sun Nov 15 10:00:07 2026";
    const after = ownerToken(PID)!;
    expect(after).not.toBe(before);
    writeFileSync(join(directory, claimName(after, "b")), "1", { flag: "wx", mode: 0o600 });
  };
  let entered = false;
  expect(() =>
    withCommentsLock(
      project,
      "flow.comments.json",
      () => {
        entered = true;
      },
      50,
    ),
  ).toThrow(CommentsLockError);
  expect(entered).toBe(false);
  // Q's claim is still there: it was not taken for a stale one.
  reuse.directory = "";
  const after = ownerToken(PID)!;
  expect(realReaddirSync(directory)).toContain(claimName(after, "b"));
});
