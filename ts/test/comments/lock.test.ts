import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { afterEach, expect, test, vi } from "vitest";
import {
  CommentsLockError,
  ownClaimName,
  ownerMatches,
  ownerToken,
  parseClaimTicket,
  withCommentsLock,
  writerClaimDirectory,
  writersRoot,
} from "../../src/comments/lock.ts";
import { findProject } from "../../src/project/index.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  removeTempDirs();
});
/** The private claim directory of `.archer/flow.comments.json` (never in the repo). */
const writers = (root: string) => writerClaimDirectory(findProject(root), "flow.comments.json");
/** This process's owner token, as its claims carry it. */
const own = () => ownClaimName().split(".")[1]!;
/** Claim directory entries; a released, emptied directory is removed. */
const list = (root: string): string[] => {
  try {
    return readdirSync(writers(root));
  } catch {
    return [];
  }
};
/**
 * What contenders see in the writers directory: everything but inert plain
 * temporaries. A claim is removed by renaming it to one at once and
 * unlinking that off the caller's path (`discard` in lock.ts), which can take
 * seconds on a congested disk; the sweep test holds that those files go.
 */
const INERT = /^\.[1-9][0-9]*\.[a-f0-9]{12}\.[a-f0-9]{24}\.claim\.[a-f0-9]{12}\.tmp$/;
function visible(root: string): string[] {
  return list(root).filter((name) => {
    if (!INERT.test(name)) return true;
    const info = lstatSync(join(writers(root), name), { throwIfNoEntry: false });
    return info !== undefined && !info.isFile(); // gone meanwhile, or inert: not visible
  });
}
function owner(root: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./fixtures/lock-owner.ts", import.meta.url)), [root], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
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

test("live ownership cannot be stolen by elapsed time; waiting has a bounded refusal", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  await owner(root);
  const began = performance.now();
  let entered = false;
  expect(() =>
    withCommentsLock(
      findProject(root),
      "flow.comments.json",
      () => {
        entered = true;
      },
      60,
    ),
  ).toThrow(CommentsLockError);
  expect(entered).toBe(false);
  expect(performance.now() - began).toBeGreaterThanOrEqual(55);
  expect(performance.now() - began).toBeLessThan(1500);
  expect(visible(root)).toHaveLength(1); // only the live owner's claim
});

test("a SIGKILL'd owner's unique claim is recovered and releases after callback failure", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const child = await owner(root);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  expect(list(root)).toHaveLength(1);
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  expect(visible(root)).toEqual([]);
  expect(() =>
    withCommentsLock(findProject(root), "flow.comments.json", () => {
      throw new Error("callback refused");
    }),
  ).toThrow("callback refused");
  expect(visible(root)).toEqual([]);
});

test("a claim link is neither followed nor removed, and does not block", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW, "outside/sentinel": "untouched" });
  mkdirSync(writers(root), { recursive: true });
  const link = `${process.pid}.${own()}.${"a".repeat(24)}.claim`;
  symlinkSync(join(root, "outside/sentinel"), join(writers(root), link));
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  expect(readdirSync(join(root, "outside"))).toEqual(["sentinel"]);
  expect(readdirSync(writers(root))).toContain(link);
});

test.each(["bad ticket", "empty choosing", "overflow"])(
  "a live %s claim refuses within a deadline and is left for its owner",
  (kind) => {
    const root = tempDir({ ".archer/flow.mmd": FLOW });
    mkdirSync(writers(root), { recursive: true });
    const name = `${process.pid}.${own()}.${"b".repeat(24)}.claim`;
    writeFileSync(
      join(writers(root), name),
      kind === "empty choosing" ? "" : kind === "overflow" ? "9999999999999999" : "not a ticket",
    );
    const began = performance.now();
    expect(() => withCommentsLock(findProject(root), "flow.comments.json", () => "unexpected", 30)).toThrow(
      CommentsLockError,
    );
    expect(performance.now() - began).toBeLessThan(1500);
    expect(visible(root)).toEqual([name]);
  },
);

// B2: a claim left by SIGKILL or a reboot whose PID now names another process
// blocked every write forever, because liveness was only kill(pid, 0).
test("a stale claim whose PID was reused by a live process is reclaimed", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  mkdirSync(writers(root), { recursive: true });
  // Live PIDs (ours and our parent's), owned by earlier incarnations.
  const reused = [
    `${process.pid}.${"c".repeat(12)}.${"1".repeat(24)}.claim`,
    `${process.ppid}.${"c".repeat(12)}.${"2".repeat(24)}.claim`,
  ];
  for (const name of reused) writeFileSync(join(writers(root), name), "1");
  const began = performance.now();
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  expect(performance.now() - began).toBeLessThan(500);
  expect(visible(root)).toEqual([]);
});

test.runIf(process.platform === "linux")(
  "a claim from a different boot is reclaimed even when its PID and start time match",
  () => {
    const root = tempDir({ ".archer/flow.mmd": FLOW });
    mkdirSync(writers(root), { recursive: true });
    const stat = readFileSync(`/proc/${process.ppid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const otherBoot = createHash("sha256")
      .update(`00000000-0000-0000-0000-000000000000:${start}`)
      .digest("hex")
      .slice(0, 12);
    expect(ownerToken(process.ppid)).not.toBe(otherBoot);
    writeFileSync(join(writers(root), `${process.ppid}.${otherBoot}.${"3".repeat(24)}.claim`), "1");
    expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
    expect(visible(root)).toEqual([]);
  },
);

test("a process's owner token does not depend on the reader's locale or time zone", () => {
  // Off Linux the token comes from `ps -o lstart=`, whose text follows LC_TIME ("Mi. 11 Nov." in German)
  // and TZ: a reader in another locale or time zone would take a live writer's claim for a dead one and
  // steal it, and a second service would take a running one's lock.
  const saved = { LC_ALL: process.env["LC_ALL"], TZ: process.env["TZ"] };
  try {
    process.env["LC_ALL"] = "C";
    process.env["TZ"] = "UTC";
    const reference = ownerToken(process.ppid);
    for (const [lc, tz] of [
      ["de_DE.UTF-8", "UTC"],
      ["C", "Asia/Tokyo"],
      ["C", "America/Los_Angeles"],
    ] as const) {
      process.env["LC_ALL"] = lc;
      process.env["TZ"] = tz;
      expect(ownerToken(process.ppid), `${lc} ${tz}`).toBe(reference);
    }
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test.runIf(process.platform !== "linux")(
  "a claim written by Archer 0.14 (lstart in the writer's own locale and zone) still names its live writer",
  () => {
    // Upgrading from 0.14: its service or writers may still run, with tokens of the old form.
    const lstart = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.ppid)], {
      encoding: "utf8",
    }).stdout.trim();
    const legacy = createHash("sha256").update(lstart).digest("hex").slice(0, 12);
    expect(legacy).not.toBe(ownerToken(process.ppid));
    expect(ownerMatches(process.ppid, legacy)).toBe(true);
    expect(ownerMatches(process.ppid, "f".repeat(12))).toBe(false);
  },
);

test("claims stay out of the repository", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  expect(withCommentsLock(findProject(root), "flow.mmd", () => "committed")).toBe("committed");
  expect(readdirSync(join(root, ".archer"))).toEqual(["flow.mmd"]);
  expect(writers(root).startsWith(writersRoot())).toBe(true);
});

test("aliases of one file share one claim directory", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  symlinkSync(join(root, ".archer/flow.mmd"), join(root, ".archer/alias.mmd"));
  const project = findProject(root);
  expect(writerClaimDirectory(project, "alias.mmd")).toBe(writerClaimDirectory(project, "flow.mmd"));
  expect(writerClaimDirectory(project, "other.mmd")).not.toBe(writerClaimDirectory(project, "flow.mmd"));
});

test("arbitrary ticket bytes, vocabulary and valid tickets with edits are refused or valid without throwing", () => {
  const began = performance.now();
  const valid = ["", "1", "200", "9007199254740990"];
  const vocabulary = ["claim", "choosing", "ticket", "NaN", "Infinity", "0", "-1", "1.5", "__proto__", "\u0000", "1\n"];
  let seed = 12345;
  for (let i = 0; i < 5000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const raw =
      i % 3 === 0
        ? String.fromCharCode(seed & 65535).repeat(i % 25)
        : i % 3 === 1
          ? vocabulary[i % vocabulary.length]!
          : valid[i % valid.length]! + String.fromCharCode(seed & 255);
    const result = parseClaimTicket(raw);
    expect(result === undefined || result === null || (Number.isSafeInteger(result) && result >= 1)).toBe(true);
  }
  expect(performance.now() - began).toBeLessThan(1500);
});

test("a malformed dead-owner claim and unknown files are cleaned, not obeyed", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  mkdirSync(writers(root), { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", ""]);
  expect(dead.status).toBe(0);
  writeFileSync(join(writers(root), `${dead.pid}.${"d".repeat(12)}.${"d".repeat(24)}.claim`), "bad ticket");
  writeFileSync(join(writers(root), "unknown"), "data");
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  await vi.waitFor(() => expect(list(root)).toEqual([]));
});

// A release unlinks its renamed claim off the caller's path; a process that
// exits first leaves that inert file behind, and it must not accumulate.
test("a dead process's inert temporary is swept, and a live one's is left", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  mkdirSync(writers(root), { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", ""]);
  expect(dead.status).toBe(0);
  const leftover = `.${dead.pid}.${"f".repeat(12)}.${"f".repeat(24)}.claim.${"0".repeat(12)}.tmp`;
  const live = `.${process.pid}.${own()}.${"f".repeat(24)}.claim.${"1".repeat(12)}.tmp`;
  writeFileSync(join(writers(root), leftover), "3");
  writeFileSync(join(writers(root), live), "4");
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  await vi.waitFor(() => expect(list(root)).toEqual([live]));
});

// Released claims wait for their unlink as inert files; a burst of them, or a
// crashed process's leftovers, must not count as contenders and lock everyone
// out before the sweep can reach them.
test("inert temporaries past the claim limit neither refuse an entrant nor stay", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  mkdirSync(writers(root), { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", ""]);
  expect(dead.status).toBe(0);
  for (let i = 0; i < 300; i++)
    writeFileSync(
      join(
        writers(root),
        `.${dead.pid}.${"f".repeat(12)}.${"f".repeat(24)}.claim.${i.toString(16).padStart(12, "0")}.tmp`,
      ),
      "1",
    );
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  await vi.waitFor(() => expect(list(root)).toEqual([]), { timeout: 4_000 });
});

test("more live claims than the bound refuse without entering", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  mkdirSync(writers(root), { recursive: true });
  for (let i = 0; i < 257; i++)
    writeFileSync(join(writers(root), `${process.pid}.${own()}.${i.toString(16).padStart(24, "0")}.claim`), "1");
  expect(() => withCommentsLock(findProject(root), "flow.comments.json", () => "unexpected")).toThrow(/too many/);
});

test("arbitrary bytes, format vocabulary and edited valid boundaries complete on a small stack against a clock", async () => {
  const began = performance.now();
  const completed = await new Promise<number>((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./fixtures/robust.ts", import.meta.url)), [], {
      execArgv: ["--stack-size=512", "--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    children.push(child);
    child.on("message", (msg: { completed?: number }) => {
      if (msg.completed) resolve(msg.completed);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`boundary worker exited ${code}`));
    });
  });
  expect(completed).toBe(3000);
  expect(performance.now() - began).toBeLessThan(5000);
}, 10_000);

test("a dead entrant that crashed while choosing is recovered before ticket publication", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  mkdirSync(writers(root), { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", ""]);
  expect(dead.status).toBe(0);
  // Empty is the exact atomic-publication state before a chosen ticket exists.
  writeFileSync(join(writers(root), `${dead.pid}.${"e".repeat(12)}.${"e".repeat(24)}.claim`), "");
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  expect(visible(root)).toEqual([]);
});

// Seen on CI: an uncontended write was refused as "being changed by another
// process" because the deadline also timed the entrant's own claim publication
// (an fsync, slow on a loaded runner). Here every clock read advances ten
// seconds, so the deadline has passed before the first contention check; with
// no other claim there is nothing to wait for, and the refusal would be a lie.
test("an uncontended writer enters even when its own claim publication outlasts the deadline", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 10_000));
  try {
    expect(withCommentsLock(findProject(root), "flow.comments.json", () => "committed")).toBe("committed");
  } finally {
    now.mockRestore();
  }
  expect(visible(root)).toEqual([]);
});
