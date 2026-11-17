// G6 / P5 (docs/quality/rubrics/security.md), hypothesis H4: the one confined read/write seam
// (src/project/confined-fs.ts, through readInFolder / writeConfined in src/project/project.ts).
// path-escape.test.ts drives every operation with free-running races; this file schedules the exact
// interleavings that broke round 1 (C-01/X-01: a link swapped in between the check and the open, the
// temporary or the rename; C-02/X-02: a hard link to a file outside) at the syscall where they bite,
// so each case runs the same way every time. Both anchors are driven: the descriptor anchor
// (/proc/self/fd on Linux) and the portable path anchor (an lstat walk around the open) used where no
// descriptor filesystem is verified.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ConfinedRefusal, descriptorConfinement, usePathAnchorsForTests } from "../../src/project/confined-fs.ts";
import { findProject, readInFolder, writeConfined, type Project } from "../../src/project/project.ts";
import { readNoteBytes } from "../../src/notes/embedded.ts";
import { readProjectManifest } from "../../src/config/project-settings.ts";
import { writeManifest } from "../../src/application/manifest.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

const real = { openSync: fs.openSync, renameSync: fs.renameSync, linkSync: fs.linkSync };
const INSIDE = "# inside\n";
const OUTSIDE = "# OUTSIDE canary\n";
const sha = (path: string) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");

interface Layout {
  readonly project: Project;
  readonly folder: string;
  readonly outside: string;
}
/** A project with notes/d/race.md, and outside it a directory with a file of the same name. */
function layout(): Layout {
  const root = tempDir({
    "archer.toml": "version = 1\n",
    ".archer/notes/d/race.md": INSIDE,
    ".archer/notes/top.md": INSIDE,
  });
  const outside = tempDir({ "d/race.md": OUTSIDE, "canary.md": OUTSIDE });
  return { project: findProject(root), folder: join(root, ".archer"), outside };
}
/** Every file under `dir`, by path, with its hash. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[]) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile()) files.set(path, sha(path));
  }
  return files;
}
/** Replaces `notes/d` with a link to the outside `d` (the real folder kept aside, inside the project). */
const swapParent = (l: Layout) => () => {
  real.renameSync(join(l.folder, "notes/d"), join(l.folder, "notes/d.aside"));
  fs.symlinkSync(join(l.outside, "d"), join(l.folder, "notes/d"));
};
/** Replaces `notes/top.md` with a link to the outside canary. */
const swapFile = (l: Layout) => () => {
  fs.symlinkSync(join(l.outside, "canary.md"), join(l.folder, "notes/top.md.link"));
  real.renameSync(join(l.folder, "notes/top.md.link"), join(l.folder, "notes/top.md"));
};

/** Runs `swap` once, at the first call of `syscall` whose path ends with `suffix`, before or after it runs. */
function once(
  syscall: "openSync" | "renameSync" | "linkSync",
  suffix: RegExp,
  when: "before" | "after",
  swap: () => void,
): { fired: () => boolean } {
  let fired = false;
  const original = real[syscall] as (...args: unknown[]) => unknown;
  vi.spyOn(fs, syscall).mockImplementation(((...args: unknown[]) => {
    const hit = !fired && suffix.test(String(args[syscall === "openSync" ? 0 : 1]));
    if (hit && when === "before") {
      fired = true;
      swap();
    }
    const result = original(...args);
    if (hit && when === "after") {
      fired = true;
      swap();
    }
    return result;
  }) as never);
  syncBuiltinESMExports();
  return { fired: () => fired };
}

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  removeTempDirs();
});

for (const anchor of ["descriptor", "path"] as const)
  describe(`${anchor} anchor`, () => {
    beforeAll(() => usePathAnchorsForTests(anchor === "path"));
    afterAll(() => usePathAnchorsForTests(false));
    // The descriptor anchor exists only where a descriptor filesystem with directory-relative suffixes is
    // verified (/proc/self/fd). macOS's /dev/fd has none (`/dev/fd/<dir fd>/.` is ENOENT), so there this
    // block runs on the path anchor too (ADR 0018 D7, docs/security/known-limits.md §1) and the cases that
    // need a descriptor-opened folder are left to the hosts that have one.
    const descriptorAnchor = anchor === "descriptor" && descriptorConfinement();
    test.runIf(anchor === "path" || descriptorConfinement())("is the anchor in use", () => {
      expect(descriptorConfinement()).toBe(anchor === "descriptor");
    });

    describe("reads never return outside bytes", () => {
      // The descriptor anchor opens every folder on the way; the path anchor lstat-walks them and opens only the file.
      const cases: readonly [
        string,
        "openSync",
        RegExp,
        "before" | "after",
        (l: Layout) => () => void,
        string,
        boolean,
      ][] = [
        [
          "file swapped to a link after the check, before the open",
          "openSync",
          /\/top\.md$/u,
          "before",
          swapFile,
          "notes/top.md",
          true,
        ],
        [
          "file swapped to a link after the open, before the read",
          "openSync",
          /\/top\.md$/u,
          "after",
          swapFile,
          "notes/top.md",
          true,
        ],
        [
          "parent swapped to a link before the folder's open",
          "openSync",
          /\/d$/u,
          "before",
          swapParent,
          "notes/d/race.md",
          false,
        ],
        [
          "parent swapped to a link after the folder's open, before the file's",
          "openSync",
          /\/d$/u,
          "after",
          swapParent,
          "notes/d/race.md",
          false,
        ],
        [
          "parent swapped to a link after the check, just before the file's open",
          "openSync",
          /\/race\.md$/u,
          "before",
          swapParent,
          "notes/d/race.md",
          true,
        ],
        [
          "parent swapped to a link after the file's open",
          "openSync",
          /\/race\.md$/u,
          "after",
          swapParent,
          "notes/d/race.md",
          true,
        ],
      ];
      for (const [name, syscall, suffix, when, swap, path, both] of cases)
        test.runIf(both || descriptorAnchor)(name, () => {
          const l = layout();
          const hook = once(syscall, suffix, when, swap(l));
          let answer: string;
          try {
            answer = readInFolder(l.project, path).toString("utf8");
          } catch (error) {
            answer = `refused: ${(error as Error).message}`;
          }
          expect(hook.fired()).toBe(true);
          expect(answer).not.toContain("OUTSIDE");
          // Either refused, or the bytes of the file that was inside when it was opened.
          expect(answer === INSIDE || answer.startsWith("refused")).toBe(true);
        });
    });

    describe("writes never land outside", () => {
      const cases: readonly [string, "openSync" | "renameSync", RegExp, "before" | "after"][] = [
        ["parent swapped to a link before the parent's open", "openSync", /\/d$/u, "before"],
        ["parent swapped to a link after the parent's open, before the temporary", "openSync", /\/d$/u, "after"],
        [
          "parent swapped to a link after the temporary is created",
          "openSync",
          /\.race\.md\.[0-9a-f]+\.tmp$/u,
          "after",
        ],
        ["parent swapped to a link just before the rename", "renameSync", /\/race\.md$/u, "before"],
      ];
      for (const [name, syscall, suffix, when] of cases)
        test(name, () => {
          const l = layout();
          const before = snapshot(l.outside);
          const hook = once(syscall, suffix, when, swapParent(l));
          let outcome: string;
          try {
            writeConfined(l.project, "notes/d/race.md", "# written by archer\n", "notes");
            outcome = "written";
          } catch (error) {
            outcome = `${(error as Error).name}: ${(error as Error).message}`;
          }
          expect(hook.fired()).toBe(true);
          // Nothing outside changed and nothing appeared there: no temporary, no replaced file.
          expect(snapshot(l.outside)).toEqual(before);
          // A write that went ahead went into the real folder, now kept aside inside the project.
          if (outcome === "written")
            expect(fs.readFileSync(join(l.folder, "notes/d.aside/race.md"), "utf8")).toBe("# written by archer\n");
          else expect(outcome).toMatch(/link|moved|could not be confirmed|ENOENT/u);
        });
    });

    // X-01 residual (re-score 1), kept by decision A2-2: the held parent moved out of the project between the
    // last binding check and the rename. With the descriptor anchor the rename lands in the open directory,
    // now outside; the path anchor renames by name, finds nothing there, and leaves its inert temporary in the
    // moved folder (cleanup only through a bound parent, ADR 0018 amended 2026-11-10). Either way the write
    // answers write_uncertain. Moving it needs write access to the outside destination, so the actor already
    // could write there; nothing outside that was not the project's own folder changes (ADR 0018 amendment).
    test("a parent moved out of the project just before the rename: write_uncertain, only the moved folder holds the write", () => {
      const l = layout();
      const before = snapshot(l.outside);
      const moved = join(l.outside, "moved");
      once("renameSync", /\/race\.md$/u, "before", () => real.renameSync(join(l.folder, "notes/d"), moved));
      let caught: unknown;
      try {
        writeConfined(l.project, "notes/d/race.md", "# written by archer\n", "notes");
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "write_uncertain" });
      // The outside files that were there are as they were; the only new outside entries are in the moved folder itself.
      const after = snapshot(l.outside);
      for (const [path, hash] of before) expect(after.get(path)).toBe(hash);
      const added = [...after.keys()].filter((path) => !before.has(path));
      if (descriptorAnchor) {
        expect(added).toEqual([join(moved, "race.md")]);
        expect(fs.readdirSync(moved)).toEqual(["race.md"]);
      } else {
        const temporary = fs.readdirSync(moved).filter((name) => name !== "race.md");
        expect(temporary).toEqual([expect.stringMatching(/^\.race\.md\.[0-9a-f]+\.tmp$/u)]);
        expect(added.sort()).toEqual([join(moved, temporary[0]!), join(moved, "race.md")].sort());
        expect(fs.readFileSync(join(moved, "race.md"), "utf8")).toBe(INSIDE);
      }
      expect(fs.existsSync(join(l.folder, "notes/d"))).toBe(false);
    });

    describe("hard links", () => {
      test("a hard link inside the Archer folder to a file outside it is refused as a read source", () => {
        const l = layout();
        fs.linkSync(join(l.outside, "canary.md"), join(l.folder, "notes/hard.md"));
        let refusal: unknown;
        try {
          readInFolder(l.project, "notes/hard.md");
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(ConfinedRefusal);
        expect(refusal).toMatchObject({ reason: "hard_link", code: "path_outside_archer_folder" });
        expect((refusal as Error).message).toMatch(/notes\/hard\.md has 2 names \(a hard link\)/u);
        expect(readNoteBytes(l.project, "notes/hard.md")).toBeNull();
      });
      test("a writer replaces a hard-linked entry: the link breaks and the file outside keeps its bytes", () => {
        const l = layout();
        fs.linkSync(join(l.outside, "canary.md"), join(l.folder, "notes/hard.md"));
        writeConfined(l.project, "notes/hard.md", INSIDE, "notes");
        expect(fs.readFileSync(join(l.outside, "canary.md"), "utf8")).toBe(OUTSIDE);
        expect(fs.statSync(join(l.outside, "canary.md")).nlink).toBe(1);
        expect(fs.statSync(join(l.folder, "notes/hard.md")).nlink).toBe(1);
        expect(readInFolder(l.project, "notes/hard.md").toString("utf8")).toBe(INSIDE);
      });
    });

    // X-02/X-01 residual (re-score 1): archer.toml decides where Archer reads and writes, so its bytes come
    // through the same seam: one name only, no link at the open, bound to the project root after the read.
    describe("archer.toml", () => {
      const MANIFEST_IN = 'version = 1\nname = "inside"\n';
      const MANIFEST_OUT = 'version = 1\nname = "OUTSIDE"\n';
      function manifestLayout(): { root: string; outside: string } {
        return {
          root: tempDir({ "archer.toml": MANIFEST_IN, ".archer/notes/top.md": INSIDE }),
          outside: tempDir({ "archer.toml": MANIFEST_OUT }),
        };
      }
      const nameOf = (root: string): string => {
        try {
          return findProject(root).name ?? "(none)";
        } catch (error) {
          return `refused: ${(error as Error).message}`;
        }
      };
      test("a hard-linked archer.toml (another name for a file outside) is refused, and its name never returned", () => {
        const { root, outside } = manifestLayout();
        fs.rmSync(join(root, "archer.toml"));
        fs.linkSync(join(outside, "archer.toml"), join(root, "archer.toml"));
        const answer = nameOf(root);
        expect(answer).not.toContain("OUTSIDE");
        expect(answer).toMatch(/^refused: .*2 names \(a hard link\)/u);
        let manifest: unknown;
        try {
          readProjectManifest({ ...findProject(tempDir()), root, manifest: join(root, "archer.toml") });
        } catch (error) {
          manifest = error;
        }
        expect(manifest).toMatchObject({ code: "manifest_unsafe" });
      });
      test("archer.toml swapped to a link to an outside manifest just before its open is refused or read as it was", () => {
        const { root, outside } = manifestLayout();
        const hook = once("openSync", /\/archer\.toml$/u, "before", () => {
          fs.symlinkSync(join(outside, "archer.toml"), join(root, "archer.toml.link"));
          real.renameSync(join(root, "archer.toml.link"), join(root, "archer.toml"));
        });
        const answer = nameOf(root);
        expect(hook.fired()).toBe(true);
        expect(answer).not.toContain("OUTSIDE");
      });
      test("archer.toml rewritten by register (writeManifest) replaces a hard-linked entry; the outside file keeps its bytes", () => {
        const { root, outside } = manifestLayout();
        const project = findProject(root);
        fs.rmSync(join(root, "archer.toml"));
        fs.linkSync(join(outside, "archer.toml"), join(root, "archer.toml"));
        writeManifest(project, `${MANIFEST_IN}# registered\n`);
        expect(fs.readFileSync(join(outside, "archer.toml"), "utf8")).toBe(MANIFEST_OUT);
        expect(fs.statSync(join(root, "archer.toml")).nlink).toBe(1);
        expect(fs.readFileSync(join(root, "archer.toml"), "utf8")).toBe(`${MANIFEST_IN}# registered\n`);
      });
      test("register never writes through an archer.toml swapped to a link just before the rename", () => {
        const { root, outside } = manifestLayout();
        const project = findProject(root);
        const before = snapshot(outside);
        once("renameSync", /\/archer\.toml$/u, "before", () => {
          fs.symlinkSync(join(outside, "archer.toml"), join(root, "archer.toml.link"));
          real.renameSync(join(root, "archer.toml.link"), join(root, "archer.toml"));
        });
        try {
          writeManifest(project, `${MANIFEST_IN}# registered\n`);
        } catch {
          /* a refusal is fine */
        }
        expect(snapshot(outside)).toEqual(before);
      });
    });

    describe("ordinary use", () => {
      test("reads and writes plain files, and a link inside the folder to a file inside it", () => {
        const l = layout();
        fs.symlinkSync(join(l.folder, "notes/top.md"), join(l.folder, "notes/alias.md"));
        expect(readInFolder(l.project, "notes/top.md").toString("utf8")).toBe(INSIDE);
        expect(readInFolder(l.project, "notes/alias.md").toString("utf8")).toBe(INSIDE);
        writeConfined(l.project, "notes/d/race.md", "# changed\n", "notes");
        expect(readInFolder(l.project, "notes/d/race.md").toString("utf8")).toBe("# changed\n");
        expect(fs.readdirSync(join(l.folder, "notes/d"))).toEqual(["race.md"]);
      });
      test("a FIFO named like a note is refused without blocking", () => {
        const l = layout();
        const fifo = join(l.folder, "notes/pipe.md");
        expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
        expect(() => readInFolder(l.project, "notes/pipe.md")).toThrow(/not a regular file/u);
      });
      test("a folder replaced at the same path is re-anchored", () => {
        const l = layout();
        expect(readInFolder(l.project, "notes/top.md").toString("utf8")).toBe(INSIDE);
        fs.renameSync(l.folder, `${l.folder}.old`);
        fs.mkdirSync(join(l.folder, "notes"), { recursive: true });
        fs.writeFileSync(join(l.folder, "notes/top.md"), "# new folder\n");
        expect(readInFolder(l.project, "notes/top.md").toString("utf8")).toBe("# new folder\n");
      });
    });
  });

describe("a file another process replaces by rename while it is read (O65)", () => {
  // Writers save by writing a temporary file and renaming it over the name. A reader that opened the old
  // file then finds it with no name, or the name on the new one: a newer version, not a move out of the
  // folder. The read is taken again through the whole confined walk instead of being refused as "moved",
  // and a file replaced at every attempt is refused after a bounded number of them.
  const save = (folder: string, text: string) => () => {
    fs.writeFileSync(join(folder, "x.comments.json.tmp"), text);
    real.renameSync(join(folder, "x.comments.json.tmp"), join(folder, "x.comments.json"));
  };

  test("a save between the open and the checks: the newer file is read", () => {
    const root = tempDir({ ".archer/notes/x.comments.json": "old" });
    const swap = once("openSync", /x\.comments\.json$/, "after", save(join(root, ".archer", "notes"), "new"));
    expect(readInFolder(findProject(root), "notes/x.comments.json").toString("utf8")).toBe("new");
    expect(swap.fired()).toBe(true);
  });

  test("a save at every attempt: refused as moved after a bounded number of attempts", () => {
    const root = tempDir({ ".archer/notes/x.comments.json": "v0" });
    const folder = join(root, ".archer", "notes");
    let opens = 0;
    const original = real.openSync as (...args: unknown[]) => unknown;
    vi.spyOn(fs, "openSync").mockImplementation(((...args: unknown[]) => {
      const result = original(...args);
      if (/x\.comments\.json$/.test(String(args[0]))) save(folder, `v${++opens}`)();
      return result;
    }) as never);
    syncBuiltinESMExports();
    expect(() => readInFolder(findProject(root), "notes/x.comments.json")).toThrow(ConfinedRefusal);
    expect(opens).toBe(32);
  });

  test("a real second name is still refused, not retried", () => {
    const root = tempDir({ ".archer/notes/x.comments.json": "v0" });
    real.linkSync(join(root, ".archer", "notes", "x.comments.json"), join(root, "elsewhere.json"));
    expect(() => readInFolder(findProject(root), "notes/x.comments.json")).toThrow(/hard link|names/);
  });
});
