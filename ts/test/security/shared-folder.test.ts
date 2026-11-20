// docs/security/known-limits.md §1: on the path anchor (no descriptor filesystem: macOS), a write can be
// redirected only by swapping a folder on its path for a link inside the anchor's check-to-use window, and
// that needs write access to the folder's parent. So the path anchor refuses to change anything under a
// folder another account can change; the descriptor anchor has no window and is unaffected.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  ConfinedRefusal,
  descriptorConfinement,
  ensureConfinedDirectories,
  publishConfined,
  removeConfined,
  usePathAnchorsForTests,
} from "../../src/project/confined-fs.ts";
import { folderOthersCanChange } from "../../src/project/ownership.ts";
import { findProject, writeConfined } from "../../src/project/project.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

const posix = process.getuid !== undefined;
const real = { openSync: fs.openSync, renameSync: fs.renameSync };

/** A project with notes/d/race.md and its real Archer folder. */
function project() {
  const root = tempDir({ "archer.toml": "version = 1\n", ".archer/notes/d/race.md": "# inside\n" });
  return { project: findProject(root), folder: join(root, ".archer") };
}
const entries = (dir: string) => fs.readdirSync(dir).sort();

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  removeTempDirs();
});

describe.runIf(posix)("folderOthersCanChange", () => {
  test("a chain of folders this account owns and only it writes: none", () => {
    const { folder } = project();
    expect(folderOthersCanChange(join(folder, "notes/d"))).toBeUndefined();
  });

  test("a folder others can write is reported, wherever it is on the chain", () => {
    const { folder } = project();
    fs.chmodSync(join(folder, "notes"), 0o757);
    expect(folderOthersCanChange(join(folder, "notes/d"))).toBe(join(folder, "notes"));
    expect(folderOthersCanChange(join(folder, "notes"))).toBe(join(folder, "notes"));
  });

  test("a sticky folder others can write is fine above a child this account owns, not as the folder changed", () => {
    const { folder } = project();
    fs.chmodSync(join(folder, "notes"), 0o1777);
    expect(folderOthersCanChange(join(folder, "notes/d"))).toBeUndefined();
    expect(folderOthersCanChange(join(folder, "notes"))).toBe(join(folder, "notes"));
  });

  test("a link on the path is reported, never followed", () => {
    const { folder } = project();
    const outside = tempDir({ "d/race.md": "# outside\n" });
    fs.renameSync(join(folder, "notes/d"), join(folder, "notes/d.aside"));
    fs.symlinkSync(join(outside, "d"), join(folder, "notes/d"));
    expect(folderOthersCanChange(join(folder, "notes/d"))).toBe(join(folder, "notes/d"));
  });
});

for (const anchor of ["descriptor", "path"] as const)
  describe.runIf(posix && (anchor === "path" || descriptorConfinement()))(`${anchor} anchor`, () => {
    beforeAll(() => usePathAnchorsForTests(anchor === "path"));
    afterAll(() => usePathAnchorsForTests(false));
    const refuses = anchor === "path";

    /** `notes/` writable by every account, as in a folder shared with another account. */
    function shared() {
      const l = project();
      fs.chmodSync(join(l.folder, "notes"), 0o777);
      return l;
    }
    const expectShared = (run: () => unknown, folder: string) => {
      let caught: unknown;
      try {
        run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfinedRefusal);
      expect((caught as ConfinedRefusal).reason).toBe("shared");
      expect((caught as ConfinedRefusal).code).toBe("shared_folder");
      expect((caught as Error).message).toContain(`chmod go-w "${join(folder, "notes")}"`);
    };

    test(
      refuses
        ? "a write under a shared folder is refused and creates nothing"
        : "a write under a shared folder is made (no window)",
      () => {
        const l = shared();
        const write = () => writeConfined(l.project, "notes/d/race.md", "# changed\n", "notes");
        if (refuses) {
          expectShared(write, l.folder);
          expect(fs.readFileSync(join(l.folder, "notes/d/race.md"), "utf8")).toBe("# inside\n");
          expect(entries(join(l.folder, "notes/d"))).toEqual(["race.md"]);
        } else {
          write();
          expect(fs.readFileSync(join(l.folder, "notes/d/race.md"), "utf8")).toBe("# changed\n");
        }
      },
    );

    test.runIf(refuses)("a removal and a new folder under a shared folder are refused too", () => {
      const l = shared();
      expectShared(() => removeConfined(l.folder, ["notes", "d"], "race.md", "notes/d/race.md"), l.folder);
      expect(entries(join(l.folder, "notes/d"))).toEqual(["race.md"]);
      expectShared(() => ensureConfinedDirectories(l.folder, ["notes", "e"], () => "notes/e"), l.folder);
      expect(entries(join(l.folder, "notes"))).toEqual(["d"]);
    });

    /** Swaps notes/d for a link to the outside `d` just before the temporary is created: the window the path anchor allows. */
    function swapAtTemporary(folder: string, outside: string): { fired: () => boolean } {
      let fired = false;
      const original = real.openSync as (...args: unknown[]) => unknown;
      vi.spyOn(fs, "openSync").mockImplementation(((...args: unknown[]) => {
        if (!fired && /\.race\.md\.[0-9a-f]+\.tmp$/u.test(String(args[0]))) {
          fired = true;
          real.renameSync(join(folder, "notes/d"), join(folder, "notes/d.aside"));
          fs.symlinkSync(join(outside, "d"), join(folder, "notes/d"));
        }
        return original(...args);
      }) as never);
      syncBuiltinESMExports();
      return { fired: () => fired };
    }

    test.runIf(refuses)("the swap that wins the window has nothing to win under a shared folder", () => {
      const l = shared();
      const outside = tempDir({ "d/race.md": "# outside\n" });
      const swap = swapAtTemporary(l.folder, outside);
      expectShared(
        () => publishConfined(l.folder, ["notes", "d"], "race.md", "# changed\n", "notes/d/race.md"),
        l.folder,
      );
      expect(swap.fired()).toBe(false);
      expect(entries(join(outside, "d"))).toEqual(["race.md"]);
    });

    // The control: the same scheduled swap does fire under folders only this account can change. That is the
    // same-account case known-limits §1 keeps (the swapping process already has this account's access).
    test.runIf(refuses)("the same swap fires when no other account can change the folders", () => {
      const l = project();
      const outside = tempDir({ "d/race.md": "# outside\n" });
      const swap = swapAtTemporary(l.folder, outside);
      try {
        publishConfined(l.folder, ["notes", "d"], "race.md", "# changed\n", "notes/d/race.md");
      } catch {
        /* refused as moved, or not: the case is whether the window was reached */
      }
      expect(swap.fired()).toBe(true);
    });

    test("a write under folders only this account can change is made as before", () => {
      const l = project();
      writeConfined(l.project, "notes/d/race.md", "# changed\n", "notes");
      expect(fs.readFileSync(join(l.folder, "notes/d/race.md"), "utf8")).toBe("# changed\n");
    });
  });
