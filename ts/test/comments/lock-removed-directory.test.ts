// The comments lock and the removal of a claim directory.
//
// A release used to remove its emptied claim directory off the caller's path, and the next writer of the same file
// could create its claim while that rmdir was under way. On macOS (APFS) that answered EINVAL, and a browser suite
// run at three workers answered HTTP 500 "the comment could not be read or written" (WriterStateError, EINVAL, at
// `enter`); now and then the rmdir succeeded around the new claim, out of every other writer's sight. Measured
// 2026-11-15: four processes each entering 20 000 times, about 0.3% EINVAL and a few lost directories.
// So a release keeps the directory, and an entrant that still meets one gone or going (an earlier Archer's writer,
// a person tidying private state) makes it again and retries.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { CommentsLockError, withCommentsLock, writerClaimDirectory } from "../../src/comments/lock.ts";
import { findProject } from "../../src/project/index.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

/**
 * `answers`: what the next claim creations answer before the real call, one each. `removals`: every directory
 * removal asked for. `beforeListing`: run before each listing of `directory`, with the listing's number (1 first).
 */
const removing = vi.hoisted(() => ({
  answers: [] as string[],
  /** What the next ticket publications' temporaries answer before the real call, one each. */
  publications: [] as string[],
  /** Claims this process created (a round each). */
  created: 0,
  removals: [] as string[],
  directory: "",
  listings: 0,
  beforeListing: undefined as undefined | ((listing: number) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: (path: string, flags: number, mode?: number) => {
      const creating = (flags & real.constants.O_CREAT) !== 0;
      const claim = creating && String(path).endsWith(".claim");
      const ticket = creating && /\.claim\.[a-f0-9]{12}\.tmp$/.test(String(path));
      const code = claim ? removing.answers.shift() : ticket ? removing.publications.shift() : undefined;
      if (code !== undefined)
        throw Object.assign(new Error(`${code}: claim directory being removed, open '${path}'`), {
          code,
          syscall: "open",
          path,
        });
      const fd = real.openSync(path, flags, mode);
      if (claim) removing.created++;
      return fd;
    },
    // Off the caller's path, a release's unlink answers whenever the disk lets it. Here it answers at once, so
    // whatever a release chains after it is asked for before the release returns, not after a guessed wait.
    unlink: (path: string, done: (error: NodeJS.ErrnoException | null) => void) => {
      let failure: NodeJS.ErrnoException | null = null;
      try {
        real.unlinkSync(path);
      } catch (error) {
        failure = error as NodeJS.ErrnoException;
      }
      done(failure);
    },
    rmdir: (path: string, ...rest: unknown[]) => {
      removing.removals.push(String(path));
      return (real.rmdir as (...args: unknown[]) => unknown)(path, ...rest);
    },
    rmdirSync: (path: string, ...rest: unknown[]) => {
      removing.removals.push(String(path));
      return (real.rmdirSync as (...args: unknown[]) => unknown)(path, ...rest);
    },
    readdirSync: (path: string, ...rest: unknown[]) => {
      if (removing.directory !== "" && String(path) === removing.directory)
        removing.beforeListing?.(++removing.listings);
      return (real.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
});

afterEach(() => {
  Object.assign(removing, {
    answers: [],
    publications: [],
    created: 0,
    removals: [],
    directory: "",
    listings: 0,
    beforeListing: undefined,
  });
  removeTempDirs();
});

test("a claim made while macOS removes its directory (EINVAL) is made again, and the writer enters", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  removing.answers = ["EINVAL"];
  let entered = false;
  withCommentsLock(findProject(root), "flow.comments.json", () => {
    entered = true;
  });
  expect(entered).toBe(true);
  expect(removing.answers).toEqual([]);
});

test("several releasing writers in a row (EINVAL, then ENOENT once gone) still let the writer in", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  removing.answers = ["EINVAL", "ENOENT", "EINVAL", "EINVAL", "ENOENT"];
  expect(withCommentsLock(findProject(root), "flow.comments.json", () => "written")).toBe("written");
});

test("any other refusal to make the claim is still the private state's failure", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  removing.answers = ["EACCES"];
  expect(() => withCommentsLock(findProject(root), "flow.comments.json", () => {})).toThrow(
    /private writer-state directory .*\(EACCES\)/,
  );
});

test("a release keeps its emptied claim directory, so the next writer never races its removal", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const project = findProject(root);
  const directory = writerClaimDirectory(project, "flow.comments.json");
  withCommentsLock(project, "flow.comments.json", () => {});
  expect(removing.removals).toEqual([]);
  expect(existsSync(directory)).toBe(true);
});

/** Whether this process's published claim, holding a ticket, is in `directory` at its path. */
function visible(directory: string): boolean {
  removing.directory = "";
  try {
    return (readdirOf(directory) ?? []).some(
      (name) =>
        name.startsWith(`${process.pid}.`) &&
        name.endsWith(".claim") &&
        readFileSync(`${directory}/${name}`, "utf8") !== "",
    );
  } finally {
    removing.directory = directory;
  }
}
function readdirOf(directory: string): string[] | undefined {
  try {
    return readdirSync(directory);
  } catch {
    return undefined;
  }
}

for (const [what, replace] of [
  ["replaced by an empty one", true],
  ["removed", false],
] as const)
  for (const [when, listing] of [
    ["while it chose its ticket", 1],
    ["after it published its ticket", 2],
  ] as const)
    test(`a claim directory ${what} ${when} is entered on only once this writer's claim is back in sight`, () => {
      const root = tempDir({ ".archer/flow.mmd": FLOW });
      const project = findProject(root);
      const directory = writerClaimDirectory(project, "flow.comments.json");
      removing.directory = directory;
      removing.beforeListing = (number) => {
        // An earlier Archer's writer removes the directory, this writer's claim with it (an APFS rmdir under way
        // succeeds around a just-created file, measured), and another writer makes it again, or not yet.
        if (number !== listing) return;
        renameSync(directory, `${directory}.${number}.gone`);
        if (replace) mkdirSync(directory, { mode: 0o700 });
      };
      const seen: boolean[] = [];
      withCommentsLock(project, "flow.comments.json", () => {
        seen.push(visible(directory));
      });
      expect(seen).toEqual([true]);
      // A lost round starts over in a fresh claim: two claims made, not one put back by its publication.
      expect(removing.created).toBe(2);
    });

test("a claim that keeps going out of sight is refused as contention, its work never run", () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const project = findProject(root);
  const directory = writerClaimDirectory(project, "flow.comments.json");
  removing.directory = directory;
  removing.beforeListing = (number) => {
    renameSync(directory, `${directory}.${number}.gone`);
    mkdirSync(directory, { mode: 0o700 });
  };
  let ran = false;
  expect(() =>
    withCommentsLock(project, "flow.comments.json", () => {
      ran = true;
    }),
  ).toThrow(CommentsLockError);
  expect(ran).toBe(false);
  // Three rounds, each in a fresh claim, then the refusal.
  expect(removing.created).toBe(3);
});

for (const code of ["ENOENT", "EINVAL"])
  test(`a ticket whose publication finds its directory gone or going (${code}) starts over, and the writer enters once`, () => {
    const root = tempDir({ ".archer/flow.mmd": FLOW });
    const project = findProject(root);
    const directory = writerClaimDirectory(project, "flow.comments.json");
    removing.publications = [code];
    const seen: boolean[] = [];
    withCommentsLock(project, "flow.comments.json", () => {
      seen.push(visible(directory));
    });
    expect(seen).toEqual([true]);
    expect(removing.created).toBe(2);
  });
