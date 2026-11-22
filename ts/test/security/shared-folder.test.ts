// docs/security/known-limits.md §1: on the path anchor (no descriptor filesystem: macOS), a write can be
// redirected only by swapping a folder on its path for a link inside the anchor's check-to-use window, and
// that needs write access to the folder's parent. So the path anchor refuses to change anything under a
// folder another account can change; the descriptor anchor has no window and is unaffected.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  descriptorConfinement,
  ensureConfinedDirectories,
  publishConfined,
  removeConfined,
  usePathAnchorsForTests,
} from "../../src/project/confined-fs.ts";
import { folderOthersCanChange } from "../../src/project/ownership.ts";
import { writeConfined } from "../../src/project/project.ts";
import { removeTempDirs } from "../project/support.ts";
import { INSIDE, type Layout, layout, once, swapParent } from "./seam-support.ts";

const posix = process.getuid !== undefined;
const entries = (dir: string) => fs.readdirSync(dir).sort();

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  removeTempDirs();
});

describe.runIf(posix)("folderOthersCanChange", () => {
  test("a chain of folders this account owns and only it writes: none", () => {
    const { folder } = layout();
    expect(folderOthersCanChange(join(folder, "notes/d"))).toBeUndefined();
  });

  test("a folder others can write is reported, wherever it is on the chain", () => {
    const { folder } = layout();
    fs.chmodSync(join(folder, "notes"), 0o757);
    expect(folderOthersCanChange(join(folder, "notes/d"))).toBe(join(folder, "notes"));
    expect(folderOthersCanChange(join(folder, "notes"))).toBe(join(folder, "notes"));
  });

  test("a sticky folder others can write is fine above a child this account owns, not as the folder changed", () => {
    const { folder } = layout();
    fs.chmodSync(join(folder, "notes"), 0o1777);
    expect(folderOthersCanChange(join(folder, "notes/d"))).toBeUndefined();
    expect(folderOthersCanChange(join(folder, "notes"))).toBe(join(folder, "notes"));
  });

  test("a link on the path is reported, never followed", () => {
    const l = layout();
    const { folder } = l;
    swapParent(l)();
    expect(folderOthersCanChange(join(folder, "notes/d"))).toBe(join(folder, "notes/d"));
  });
});

/** `notes/` writable by every account, as in a folder shared with another account. */
function shared() {
  const l = layout();
  fs.chmodSync(join(l.folder, "notes"), 0o777);
  return l;
}

/** Swaps notes/d for the outside `d` just before the temporary is created: the window the path anchor allows. */
const swapAtTemporary = (l: Layout) => once("openSync", /\.race\.md\.[0-9a-f]+\.tmp$/u, "before", swapParent(l)).fired;

describe.runIf(posix)("path anchor", () => {
  beforeAll(() => usePathAnchorsForTests(true));
  afterAll(() => usePathAnchorsForTests(false));
  const expectShared = (run: () => unknown, folder: string) =>
    expect(run).toThrow(
      expect.objectContaining({
        reason: "shared",
        code: "shared_folder",
        message: expect.stringContaining(`chmod go-w "${join(folder, "notes")}"`),
      }),
    );

  test("a write under a shared folder is refused and creates nothing", () => {
    const l = shared();
    expectShared(() => writeConfined(l.project, "notes/d/race.md", "# changed\n", "notes"), l.folder);
    expect(fs.readFileSync(join(l.folder, "notes/d/race.md"), "utf8")).toBe(INSIDE);
    expect(entries(join(l.folder, "notes/d"))).toEqual(["race.md"]);
  });

  test("a removal and a new folder under a shared folder are refused too", () => {
    const l = shared();
    expectShared(() => removeConfined(l.folder, ["notes", "d"], "race.md", "notes/d/race.md"), l.folder);
    expect(entries(join(l.folder, "notes/d"))).toEqual(["race.md"]);
    const notes = entries(join(l.folder, "notes"));
    expectShared(() => ensureConfinedDirectories(l.folder, ["notes", "e"], () => "notes/e"), l.folder);
    expect(entries(join(l.folder, "notes"))).toEqual(notes);
  });

  test("the swap that wins the window has nothing to win under a shared folder", () => {
    const l = shared();
    const fired = swapAtTemporary(l);
    expectShared(
      () => publishConfined(l.folder, ["notes", "d"], "race.md", "# changed\n", "notes/d/race.md"),
      l.folder,
    );
    expect(fired()).toBe(false);
    expect(entries(join(l.outside, "d"))).toEqual(["race.md"]);
  });

  // The control: the same scheduled swap does fire under folders only this account can change. That is the
  // same-account case known-limits §1 keeps (the swapping process already has this account's access).
  test("the same swap fires when no other account can change the folders", () => {
    const l = layout();
    const fired = swapAtTemporary(l);
    try {
      publishConfined(l.folder, ["notes", "d"], "race.md", "# changed\n", "notes/d/race.md");
    } catch {
      /* refused as moved, or not: the case is whether the window was reached */
    }
    expect(fired()).toBe(true);
  });
});

for (const anchor of ["descriptor", "path"] as const)
  describe.runIf(posix && (anchor === "path" || descriptorConfinement()))(`${anchor} anchor`, () => {
    beforeAll(() => usePathAnchorsForTests(anchor === "path"));
    afterAll(() => usePathAnchorsForTests(false));

    test.runIf(anchor === "descriptor")("a write under a shared folder is made (no window)", () => {
      const l = shared();
      writeConfined(l.project, "notes/d/race.md", "# changed\n", "notes");
      expect(fs.readFileSync(join(l.folder, "notes/d/race.md"), "utf8")).toBe("# changed\n");
    });

    test("a write under folders only this account can change is made as before", () => {
      const l = layout();
      writeConfined(l.project, "notes/d/race.md", "# changed\n", "notes");
      expect(fs.readFileSync(join(l.folder, "notes/d/race.md"), "utf8")).toBe("# changed\n");
    });
  });
