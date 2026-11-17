// Created and edited dates of the Archer folder's files
// (ts/src/project/file-dates.ts): the file system's birth time where it keeps
// one, else the commit that first added the file, else none.
import { statSync, utimesSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GitRepository } from "../../src/accuracy/git.ts";
import { birthTime, FileDateBook } from "../../src/project/file-dates.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "./support.ts";
import { cleanup, commit, git, repo, write } from "../accuracy/support.ts";

afterEach(cleanup);
afterEach(removeTempDirs);

const FLOW = "flowchart LR\n  a[A]\n";

/** Runs `commit` with Git's committer date set to `date`, so commits a moment apart are told apart. */
function on<T>(date: string, run: () => T): T {
  process.env.GIT_COMMITTER_DATE = date;
  try {
    return run();
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
  }
}

/** `statSync` as a file system without birth times reports it: libuv's fallback to the change time. */
const noBirthTimes = ((path: string, options?: { bigint?: boolean }) => {
  const real = statSync(path, { bigint: true });
  const faked = Object.create(real) as BigIntStats & { birthtimeNs: bigint; birthtimeMs: bigint };
  Object.defineProperty(faked, "birthtimeNs", { value: real.ctimeNs });
  Object.defineProperty(faked, "birthtimeMs", { value: real.ctimeMs });
  return options?.bigint === true ? faked : real;
}) as unknown as typeof statSync;

/** A file system that keeps birth times, reporting 2001-02-03T04:05:06Z. */
const certainBirthTimes = ((path: string, options?: { bigint?: boolean }) => {
  const real = statSync(path, { bigint: true });
  const faked = Object.create(real) as BigIntStats;
  Object.defineProperty(faked, "birthtimeNs", { value: BigInt(Date.parse("2001-02-03T04:05:06Z")) * 1_000_000n });
  return options?.bigint === true ? faked : real;
}) as unknown as typeof statSync;

/** A file system that reports a birth time of 0 (some network and FUSE file systems). */
const zeroBirthTimes = ((path: string, options?: { bigint?: boolean }) => {
  const real = statSync(path, { bigint: true });
  const faked = Object.create(real) as BigIntStats;
  Object.defineProperty(faked, "birthtimeNs", { value: 0n });
  Object.defineProperty(faked, "birthtimeMs", { value: 0n });
  return options?.bigint === true ? faked : real;
}) as unknown as typeof statSync;

describe("birthTime", () => {
  test.each([
    ["zero: the file system keeps none", 0n, 5n, null],
    [
      "equal to the change time: libuv's fallback, or a file written once",
      7_000_000n,
      7_000_000n,
      { at: "1970-01-01T00:00:00.007Z", certain: false },
    ],
    [
      "its own: the birth time",
      1_700_000_000_000_000_000n,
      1_700_000_000_500_000_000n,
      { at: "2023-11-14T22:13:20.000Z", certain: true },
    ],
  ])("%s", (_, birthtimeNs, ctimeNs, expected) => {
    expect(birthTime({ birthtimeNs, ctimeNs })).toEqual(expected);
  });
});

describe("FileDateBook", () => {
  test("EDITED is the modification time, whatever the birth time", () => {
    const root = tempDir({ ".archer/flow.mmd": FLOW });
    const when = new Date("2026-09-01T10:00:00.000Z");
    utimesSync(join(root, ".archer/flow.mmd"), when, when);
    for (const stat of [statSync, noBirthTimes, zeroBirthTimes])
      expect(new FileDateBook(findProject(root), stat).of("flow.mmd").modifiedAt).toBe(when.toISOString());
  });

  test("CREATED is the birth time where the file system keeps one, and Git is not asked", async () => {
    const root = repo({ ".archer/flow.mmd": FLOW });
    commit(root);
    const project = findProject(root);
    const book = new FileDateBook(project, certainBirthTimes);
    await book.refresh(project, ["flow.mmd"]);
    expect(book.inspections).toBe(0);
    expect(book.of("flow.mmd")).toMatchObject({ createdAt: "2001-02-03T04:05:06.000Z", createdFrom: "filesystem" });
  });

  test("a birth time equal to the change time is omitted when Git has no date for the file", async () => {
    const root = repo({ "README.md": "x\n" });
    commit(root);
    write(root, ".archer/new.mmd", FLOW);
    const project = findProject(root);
    const book = new FileDateBook(project, noBirthTimes);
    await book.refresh(project, ["new.mmd"]);
    expect(book.inspections).toBe(1);
    expect(book.of("new.mmd")).toEqual({ modifiedAt: statSync(join(root, ".archer/new.mmd")).mtime.toISOString() });
  });

  test.each([
    ["the change time in its place", noBirthTimes],
    ["0", zeroBirthTimes],
  ])("without a birth time (%s), CREATED is the commit that first added the file", async (_, stat) => {
    const root = repo({ ".archer/flow.mmd": FLOW, ".archer/notes/auth.md": "# Auth\n" });
    commit(root);
    const added = git(root, "log", "-1", "--format=%cI");
    write(root, ".archer/flow.mmd", `${FLOW}  b[B]\n`);
    on("2030-01-01T00:00:00Z", () => git(root, "commit", "-qam", "later"));
    const project = findProject(root);
    const book = new FileDateBook(project, stat);
    expect(book.of("flow.mmd").createdFrom).not.toBe("git"); // before Git is asked
    await book.refresh(project, ["flow.mmd", "notes/auth.md"]);
    expect(book.of("flow.mmd")).toMatchObject({ createdAt: new Date(added).toISOString(), createdFrom: "git" });
    expect(book.of("notes/auth.md")).toMatchObject({ createdAt: new Date(added).toISOString(), createdFrom: "git" });
  });

  test("Git is asked once for the whole folder, and not again within a minute", async () => {
    const root = repo({ ".archer/a.mmd": FLOW, ".archer/b.mmd": FLOW });
    commit(root);
    const project = findProject(root);
    const book = new FileDateBook(project, noBirthTimes);
    await Promise.all([book.refresh(project, ["a.mmd", "b.mmd"]), book.refresh(project, ["a.mmd"])]);
    await book.refresh(project, ["a.mmd", "b.mmd"]);
    expect(book.inspections).toBe(1);
  });

  test("without a birth time, a file never committed and a project outside Git have no CREATED, only EDITED", async () => {
    const root = repo({ "README.md": "x\n" });
    commit(root);
    write(root, ".archer/new.mmd", FLOW);
    const outside = tempDir({ ".archer/flow.mmd": FLOW });
    for (const [dir, path] of [
      [root, "new.mmd"],
      [outside, "flow.mmd"],
    ] as const) {
      const project = findProject(dir);
      const book = new FileDateBook(project, zeroBirthTimes);
      await book.refresh(project, [path]);
      expect(book.of(path)).toEqual({ modifiedAt: expect.any(String) });
    }
  });

  test("Git is asked in the background: a caller is told when its answer changed a date, and only then", async () => {
    const root = repo({ ".archer/a.mmd": FLOW });
    commit(root);
    const project = findProject(root);
    const book = new FileDateBook(project, noBirthTimes);
    const learned = vi.fn();
    const asked = book.refresh(project, ["a.mmd"], learned);
    // Nothing waits on it: the dates the file system gives are there at once.
    expect(book.of("a.mmd")).toEqual({ modifiedAt: expect.any(String) });
    await asked;
    expect(learned).toHaveBeenCalledOnce();
    expect(book.of("a.mmd").createdFrom).toBe("git");
    // Asked again later with the same answer: nothing new to announce.
    const later = new FileDateBook(project, noBirthTimes);
    await later.refresh(project, ["a.mmd"]);
    const again = vi.fn();
    await later.refresh(project, ["a.mmd"], again);
    expect(again).not.toHaveBeenCalled();
  });

  test("refresh never rejects when the learned callback throws", async () => {
    const root = repo({ ".archer/a.mmd": FLOW });
    commit(root);
    const project = findProject(root);
    const book = new FileDateBook(project, noBirthTimes);
    await expect(
      book.refresh(project, ["a.mmd"], () => {
        throw new Error("publication failed");
      }),
    ).resolves.toBeUndefined();
    expect(book.of("a.mmd").createdFrom).toBe("git");
  });

  test("a failed Git inspection is asked again shortly, without a reload, and keeps the last answer", async () => {
    // On a loaded CI host Git once failed to answer within its time limit; the
    // failure was then kept as "no dates" for a minute and the project page
    // showed no CREATED dates (projects-and-search.e2e.ts).
    const root = repo({ ".archer/a.mmd": FLOW });
    commit(root);
    const project = findProject(root);
    const book = new FileDateBook(project, noBirthTimes);
    const learned = vi.fn();
    const failing = vi.spyOn(GitRepository, "workTree").mockResolvedValueOnce(null);
    await book.refresh(project, ["a.mmd"], learned);
    expect(book.of("a.mmd").createdFrom).toBeUndefined();
    // A reload within the minute does not ask again; the retry does.
    await book.refresh(project, ["a.mmd"], learned);
    expect(book.inspections).toBe(1);
    await vi.waitFor(() => expect(book.of("a.mmd").createdFrom).toBe("git"), { timeout: 5_000 });
    expect(book.inspections).toBe(2);
    expect(learned).toHaveBeenCalledOnce();
    failing.mockRestore();
  });

  test("a closed book does not ask Git again after a failure", async () => {
    const root = repo({ ".archer/a.mmd": FLOW });
    commit(root);
    const project = findProject(root);
    const book = new FileDateBook(project, noBirthTimes);
    const failing = vi.spyOn(GitRepository, "workTree").mockResolvedValueOnce(null);
    await book.refresh(project, ["a.mmd"]);
    book.close();
    await new Promise((settle) => setTimeout(settle, 1_500));
    expect(book.inspections).toBe(1);
    failing.mockRestore();
  });

  test("a missing file has no dates", () => {
    expect(new FileDateBook(findProject(tempDir({ ".archer/x.mmd": FLOW }))).of("gone.mmd")).toEqual({});
  });
});

describe("GitRepository.firstAdded", () => {
  test("each path's first add under the folder; a moved file is dated by its move; a path re-added keeps its first add", async () => {
    const root = repo({ ".archer/a.mmd": FLOW, ".archer/old.mmd": FLOW, "src/x.ts": "x\n" });
    on("2020-01-01T00:00:00Z", () => commit(root));
    git(root, "mv", ".archer/old.mmd", ".archer/moved.mmd");
    git(root, "rm", "-q", ".archer/a.mmd");
    on("2021-01-01T00:00:00Z", () => git(root, "commit", "-qm", "second"));
    write(root, ".archer/a.mmd", FLOW);
    on("2022-01-01T00:00:00Z", () => commit(root));
    const added = await (await GitRepository.open(root)).firstAdded(".archer");
    expect([...added.keys()].sort()).toEqual([".archer/a.mmd", ".archer/moved.mmd", ".archer/old.mmd"]);
    expect(added.get(".archer/a.mmd")).toBe("2020-01-01T00:00:00Z");
    expect(added.get(".archer/moved.mmd")).toBe("2021-01-01T00:00:00Z");
  });

  test("a repository with no commits answers with nothing", async () => {
    const root = repo({ ".archer/a.mmd": FLOW });
    expect((await (await GitRepository.open(root)).firstAdded(".archer")).size).toBe(0);
  });
});
