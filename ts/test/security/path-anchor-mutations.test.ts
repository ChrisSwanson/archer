// Writers on the path anchor (no descriptor filesystem: macOS, Linux without /proc). Each case is one
// permanent folder swap at a chosen step, from the 0.14.1 review (O273): no outside file is written,
// deleted or scanned, and a folder's own filesystem decides its anchor.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { descriptorConfinement, publishConfined, usePathAnchorsForTests } from "../../src/project/confined-fs.js";
import { withChangeStoreIo } from "../../src/changes/io.js";
import { materializeReview } from "../../src/authoring/review-artifacts.js";
import { AuthoringStore } from "../../src/authoring/store.js";
import { findProject } from "../../src/project/project.js";
import { configureWritePolicy } from "../../src/config/write-policy.js";

const real = { openSync: fs.openSync, lstatSync: fs.lstatSync, opendirSync: fs.opendirSync };
let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(join(tmpdir(), "archer-anchor-mutations-"));
});
afterEach(() => {
  Object.assign(fs, real);
  syncBuiltinESMExports();
  usePathAnchorsForTests(false);
  fs.rmSync(base, { recursive: true, force: true });
});
function swap(directory: string, outside: string): void {
  fs.renameSync(directory, `${directory}.saved`);
  fs.symlinkSync(outside, directory);
}

describe("path-anchor writers", () => {
  it.skipIf(!descriptorConfinement())(
    "a folder whose descriptor probe fails after the platform probe writes where it was asked",
    () => {
      const root = join(base, "root");
      fs.mkdirSync(join(root, "nested"), { recursive: true });
      fs.openSync = ((path: fs.PathLike, ...rest: unknown[]) => {
        if (/^\/(proc\/self|dev)\/fd\/\d+\/\.$/u.test(String(path)))
          throw Object.assign(new Error("descriptor filesystem gone"), { code: "ENOENT" });
        return (real.openSync as (...args: unknown[]) => number)(path, ...rest);
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      publishConfined(root, ["nested"], "note.md", "ARCHER", "nested/note.md");
      expect(fs.readFileSync(join(root, "nested/note.md"), "utf8")).toBe("ARCHER");
      expect(fs.existsSync(join(root, "note.md"))).toBe(false);
    },
  );

  it("a failed index publication leaves a same-named file behind a swapped store alone", () => {
    usePathAnchorsForTests(true);
    const state = join(base, "state"),
      outside = join(base, "outside");
    fs.mkdirSync(state, { mode: 0o700 });
    fs.mkdirSync(outside);
    let canary = "";
    expect(() =>
      withChangeStoreIo(state, (io) =>
        io.replaceIndex(Buffer.from("INDEX"), (step) => {
          if (step !== "before_index_publish") return;
          const store = join(state, "runtime/change-review");
          canary = join(outside, fs.readdirSync(store).find((name) => name.startsWith(".index."))!);
          fs.writeFileSync(canary, "OUTSIDE");
          swap(store, outside);
        }),
      ),
    ).toThrow(/binding changed/u);
    expect(fs.readFileSync(canary, "utf8")).toBe("OUTSIDE");
  });

  it("a store swapped for a whole inventory scan is refused, not counted", () => {
    usePathAnchorsForTests(true);
    const state = join(base, "state"),
      outside = join(base, "outside");
    fs.mkdirSync(state, { mode: 0o700 });
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.writeFileSync(join(outside, "index.json"), "X".repeat(100), { mode: 0o600 });
    withChangeStoreIo(state, (io) => {
      io.replaceIndex(Buffer.from("I"));
      const store = join(state, "runtime/change-review");
      fs.opendirSync = ((path: fs.PathLike, ...rest: unknown[]) => {
        if (String(path).replace(/\/$/u, "") !== store)
          return (real.opendirSync as (...args: unknown[]) => fs.Dir)(path, ...rest);
        swap(store, outside);
        const stream = (real.opendirSync as (...args: unknown[]) => fs.Dir)(path, ...rest),
          close = stream.closeSync.bind(stream);
        stream.closeSync = () => {
          close();
          fs.unlinkSync(store);
          fs.renameSync(`${store}.saved`, store);
        };
        return stream;
      }) as typeof fs.opendirSync;
      syncBuiltinESMExports();
      expect(() => io.inventory({ entries: 10, physicalBytes: 1000, snapshotBytes: 1000 })).toThrow(/binding changed/u);
    });
  });

  describe("review artifacts", () => {
    let endPolicy: () => void;
    beforeEach(() => {
      process.env.ARCHER_WRITERS_DIR = join(base, "writers");
      endPolicy = configureWritePolicy({
        env: { XDG_CONFIG_HOME: join(base, "config") },
        systemConfigPath: join(base, "absent-system.toml"),
      });
      usePathAnchorsForTests(true);
    });
    afterEach(() => {
      endPolicy();
      delete process.env.ARCHER_WRITERS_DIR;
    });

    function pendingReview(name: string) {
      const root = join(base, name),
        state = join(base, `${name}-state`),
        outside = join(base, `${name}-outside`);
      fs.mkdirSync(join(root, ".archer"), { recursive: true });
      fs.mkdirSync(state, { mode: 0o700 });
      fs.mkdirSync(outside);
      fs.writeFileSync(join(root, ".archer/a.mmd"), "B");
      const store = new AuthoringStore({ stateDir: state, serviceName: "main", assertOwner() {} });
      const revision = `sha256:${"c".repeat(64)}`;
      const request = {
        operationId: "1".padStart(32, "0"),
        payloadDigest: revision,
        op: "document.apply",
        projectRoot: root,
        authority: { grantId: "g", entitlementId: "e" },
        feedback: { changes: "on_save", delivery: "next_call", effectiveRevision: revision },
        target: { kind: "document", path: ".archer/a.mmd" },
        expected: { sourceRevision: revision },
        base: store.putSnapshot(Buffer.from("A")),
        candidate: store.putSnapshot(Buffer.from("B")),
      } as Parameters<AuthoringStore["beginOperation"]>[0];
      store.beginOperation(request);
      store.completeSourceOperation(request.operationId, revision, {
        outcome: "applied",
        document: { path: ".archer/a.mmd", sourceRevision: revision, modelRevision: null },
        evidence: "observed",
        review: { mode: "on_save", configRevision: revision, state: "admission_pending" },
      } as Parameters<AuthoringStore["completeSourceOperation"]>[2]);
      return {
        project: findProject(root),
        store,
        reviewId: store.listReviews(root).at(-1)!.reviewId,
        directory: join(root, ".archer/.review"),
        outside,
      };
    }

    it("a review folder swapped while the diff renders receives nothing", () => {
      const { project, store, reviewId, directory, outside } = pendingReview("render");
      const read = store.readSnapshot.bind(store);
      let swapped = false;
      store.readSnapshot = ((...args: Parameters<typeof read>) => {
        if (!swapped) {
          swap(directory, outside);
          swapped = true;
        }
        return read(...args);
      }) as typeof read;
      const result = materializeReview(project, store, reviewId);
      expect(swapped).toBe(true);
      expect(result.status).not.toBe("written");
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it("a review folder swapped after its missing .gitignore is seen receives nothing", () => {
      const { project, store, reviewId, directory, outside } = pendingReview("ignore");
      let swapped = false;
      (fs as { lstatSync: typeof fs.lstatSync }).lstatSync = ((path: fs.PathLike, ...rest: unknown[]) => {
        try {
          return (real.lstatSync as (...args: unknown[]) => fs.Stats)(path, ...rest);
        } catch (error) {
          if (
            !swapped &&
            String(path) === join(directory, ".gitignore") &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            swap(directory, outside);
            swapped = true;
          }
          throw error;
        }
      }) as typeof fs.lstatSync;
      syncBuiltinESMExports();
      const result = materializeReview(project, store, reviewId);
      expect(swapped).toBe(true);
      expect(result.status).not.toBe("written");
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });
});
