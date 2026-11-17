import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AuthoringStore, type JournalIntent } from "../../src/authoring/store.ts";
import { materializeReview, REVIEW_ARTIFACT_LIMITS } from "../../src/authoring/review-artifacts.ts";
import { discoverAuthoringDocuments } from "../../src/project/discovery.ts";
import { listDiagrams } from "../../src/project/inventory.ts";
import { ProjectWatcher } from "../../src/service/watch.ts";
import { findProject } from "../../src/project/project.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";
afterEach(removeTempDirs);
const revision = "sha256:" + "c".repeat(64);
function setup() {
  const root = tempDir({ ".archer/a.mmd": "C" }),
    stateDir = tempDir();
  chmodSync(stateDir, 0o700);
  const store = new AuthoringStore({ stateDir, serviceName: "main", assertOwner() {} });
  return { root, store, project: findProject(root) };
}
function save(store: AuthoringStore, root: string, n: number, before: string | null, after: string) {
  const request: JournalIntent = {
    operationId: n.toString(16).padStart(32, "0"),
    payloadDigest: revision,
    op: before === null ? "document.publish" : "document.apply",
    projectRoot: root,
    authority: { grantId: "g", entitlementId: "e" },
    feedback: { changes: "on_save", delivery: "next_call", effectiveRevision: revision },
    target: { kind: "document", path: ".archer/a.mmd" },
    expected: { sourceRevision: before === null ? null : revision },
    base: before === null ? null : store.putSnapshot(Buffer.from(before)),
    candidate: store.putSnapshot(Buffer.from(after)),
  };
  store.beginOperation(request);
  store.completeSourceOperation(request.operationId, revision, {
    outcome: before === null ? "created" : "applied",
    document: { path: ".archer/a.mmd", sourceRevision: revision, modelRevision: null },
    evidence: "observed",
    review: { mode: "on_save", configRevision: revision, state: "admission_pending" },
  });
  return store.listReviews(root).at(-1)!;
}
test("materializes cumulative oldest baseline to latest from the private store", () => {
  const f = setup();
  const first = save(f.store, f.root, 1, "A\r\n", "B\r\n");
  save(f.store, f.root, 2, "B\r\n", "C\r\n");
  const result = materializeReview(f.project, f.store, first.reviewId);
  expect(result.status).toBe("written");
  const text = readFileSync(join(f.root, result.path!), "utf8");
  expect(text.split("\n")[0]).toBe("# archer-review v1");
  expect(text).toContain("-A\r\n");
  expect(text).toContain("+C\r\n");
  expect(text).not.toContain("-B\r\n");
  expect(text).toContain('"saveCount":2');
});
test("one file follows A→B→C; tampering with its body cannot change the private authority", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B");
  const first = materializeReview(f.project, f.store, r.reviewId);
  expect(first.status).toBe("written");
  const path = join(f.root, first.path!),
    initial = readFileSync(path, "utf8");
  writeFileSync(path, initial.slice(0, initial.indexOf("# derived:")) + "untrusted altered body");
  expect(f.store.readSnapshot(f.store.getReview(f.root, r.reviewId)!.latest).toString()).toBe("B");
  save(f.store, f.root, 2, "B", "C");
  expect(materializeReview(f.project, f.store, r.reviewId)).toEqual(first);
  expect(readFileSync(path, "utf8")).toContain("+C\n");
  expect(readFileSync(path, "utf8")).not.toContain("altered body");
  expect(readdirSync(join(f.root, ".archer/.review")).sort()).toEqual(
    [".gitignore", first.path!.split("/").at(-1)].sort(),
  );
});
test("clear removes only its full review-id filename; later Save stays separate", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B");
  const first = materializeReview(f.project, f.store, r.reviewId);
  f.store.clearReview(f.root, r.reviewId, 1, "reviewed");
  const next = save(f.store, f.root, 2, "B", "C"),
    second = materializeReview(f.project, f.store, next.reviewId);
  expect(first.path).not.toBe(second.path);
  expect(materializeReview(f.project, f.store, r.reviewId)).toMatchObject({ status: "removed", path: first.path });
  expect(existsSync(join(f.root, first.path!))).toBe(false);
  expect(readFileSync(join(f.root, second.path!), "utf8")).toContain("+C");
  expect(materializeReview(f.project, f.store, r.reviewId).status).toBe("removed");
});
test("A→B→A remains pending with empty complete diff; absent baseline stays distinct from empty", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B");
  save(f.store, f.root, 2, "B", "A");
  const result = materializeReview(f.project, f.store, r.reviewId);
  const text = readFileSync(join(f.root, result.path!), "utf8");
  expect(text).toContain('"netEffect":"none"');
  expect(text.endsWith("# diff complete=true\n")).toBe(true);
  expect(f.store.getReview(f.root, r.reviewId)?.state).toBe("pending");
  const g = setup(),
    created = save(g.store, g.root, 1, null, "");
  const output = materializeReview(g.project, g.store, created.reviewId);
  expect(readFileSync(join(g.root, output.path!), "utf8")).toContain('"baseline":null');
  expect(readFileSync(join(g.root, output.path!), "utf8")).toContain("new file mode");
});
test.each([
  "symlink-directory",
  "symlink-file",
  "foreign-marker",
  "hardlink",
  "not-directory",
  "foreign-store",
  "foreign-subject",
])("%s refuses effects on foreign paths", (kind) => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B"),
    outside = tempDir({ sentinel: "untouched" });
  let result = materializeReview(f.project, f.store, r.reviewId);
  const path = join(f.root, result.path!),
    dir = join(f.root, ".archer/.review");
  if (kind === "symlink-directory") {
    renameSync(dir, join(f.root, "old-review"));
    symlinkSync(outside, dir);
  } else if (kind === "not-directory") {
    renameSync(dir, join(f.root, "old-review"));
    writeFileSync(dir, "foreign");
  } else if (kind === "symlink-file") {
    renameSync(path, path + ".old");
    symlinkSync(join(outside, "sentinel"), path);
  } else if (kind === "hardlink") {
    linkSync(path, join(outside, "linked"));
  } else {
    const text = readFileSync(path, "utf8");
    writeFileSync(
      path,
      kind === "foreign-marker"
        ? "foreign"
        : kind === "foreign-store"
          ? text.replace(/store_[0-9a-f]{32}/u, "store_" + "f".repeat(32))
          : text.replace(".archer/a.mmd", ".archer/else.mmd"),
    );
  }
  save(f.store, f.root, 2, "B", "C");
  result = materializeReview(f.project, f.store, r.reviewId);
  expect(result.status).toBe("blocked");
  expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("untouched");
  expect(readdirSync(outside).sort()).toEqual(kind === "hardlink" ? ["linked", "sentinel"] : ["sentinel"]);
  if (kind === "hardlink") expect(readFileSync(join(outside, "linked"), "utf8")).toContain("+B");
  f.store.clearReview(f.root, r.reviewId, 2, "reviewed");
  expect(materializeReview(f.project, f.store, r.reviewId).status).toBe("blocked");
  expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("untouched");
});
test("folder change and missing subject leave previously derived files untouched", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B");
  const artifact = materializeReview(f.project, f.store, r.reviewId),
    path = join(f.root, artifact.path!),
    before = readFileSync(path);
  mkdirSync(join(f.root, "new"));
  writeFileSync(join(f.root, "archer.toml"), 'version = 1\nfolder = "new"\n');
  expect(materializeReview(f.project, f.store, r.reviewId).status).toBe("unavailable");
  expect(materializeReview(findProject(f.root), f.store, r.reviewId).status).toBe("unavailable");
  expect(readFileSync(path)).toEqual(before);
  expect(readdirSync(join(f.root, "new"))).toEqual([]);
  const g = setup(),
    missing = save(g.store, g.root, 1, "A", "B");
  renameSync(join(g.root, ".archer/a.mmd"), join(g.root, ".archer/moved.mmd"));
  expect(materializeReview(g.project, g.store, missing.reviewId).status).toBe("unavailable");
  expect(existsSync(join(g.root, ".archer/.review"))).toBe(false);
});
test("fault before rename preserves last good file; the next materialisation settles rename uncertainty", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B"),
    first = materializeReview(f.project, f.store, r.reviewId),
    path = join(f.root, first.path!),
    before = readFileSync(path);
  save(f.store, f.root, 2, "B", "C");
  expect(
    materializeReview(f.project, f.store, r.reviewId, {
      onStep(step) {
        if (step === "temporary_synced") throw Error("crash");
      },
    }).status,
  ).toBe("blocked");
  expect(readFileSync(path)).toEqual(before);
  expect(
    materializeReview(f.project, f.store, r.reviewId, {
      onStep(step) {
        if (step === "published") throw Error("sync uncertain");
      },
    }).status,
  ).toBe("stale");
  expect(readFileSync(path, "utf8")).toContain("+C");
  expect(materializeReview(f.project, f.store, r.reviewId)).toEqual({ status: "written", path: first.path });
  expect(readdirSync(join(f.root, ".archer/.review")).sort()).toEqual(
    [".gitignore", first.path!.split("/").at(-1)].sort(),
  );
});
test("directory replacement at publication refuses outside effects and preserves old artifact", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B"),
    first = materializeReview(f.project, f.store, r.reviewId),
    dir = join(f.root, ".archer/.review"),
    outside = tempDir({ sentinel: "untouched" });
  save(f.store, f.root, 2, "B", "C");
  const result = materializeReview(f.project, f.store, r.reviewId, {
    onStep(step) {
      if (step === "before_publish") {
        renameSync(dir, join(f.root, "detached"));
        symlinkSync(outside, dir);
      }
    },
  });
  expect(result.status).toBe("stale");
  expect(readdirSync(outside)).toEqual(["sentinel"]);
  expect(readFileSync(join(f.root, "detached", first.path!.split("/").at(-1)!), "utf8")).toContain("+B");
});
test("fresh review state and current folder are checked again at publication", () => {
  for (const attack of ["clear", "folder"]) {
    const f = setup(),
      r = save(f.store, f.root, 1, "A", "B"),
      first = materializeReview(f.project, f.store, r.reviewId),
      path = join(f.root, first.path!),
      before = readFileSync(path);
    save(f.store, f.root, 2, "B", "C");
    const result = materializeReview(f.project, f.store, r.reviewId, {
      onStep(step) {
        if (step === "before_publish") {
          if (attack === "clear") f.store.clearReview(f.root, r.reviewId, 2, "reviewed");
          else {
            mkdirSync(join(f.root, "new"));
            writeFileSync(join(f.root, "archer.toml"), 'version = 1\nfolder = "new"\n');
          }
        }
      },
    });
    expect(result.status).toBe(attack === "clear" ? "stale" : "unavailable");
    expect(readFileSync(path)).toEqual(before);
    if (attack === "folder") expect(readdirSync(join(f.root, "new"))).toEqual([]);
  }
});
test("a replaced temporary file is not published or cleaned as our own file", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B"),
    first = materializeReview(f.project, f.store, r.reviewId),
    dir = join(f.root, ".archer/.review"),
    path = join(f.root, first.path!),
    before = readFileSync(path),
    outside = tempDir({ sentinel: "untouched" });
  save(f.store, f.root, 2, "B", "C");
  const result = materializeReview(f.project, f.store, r.reviewId, {
    onStep(step) {
      if (step === "before_publish") {
        const name = readdirSync(dir).find((name) => name.endsWith(".tmp"))!;
        renameSync(join(dir, name), join(dir, "unknown-temp"));
        symlinkSync(join(outside, "sentinel"), join(dir, name));
      }
    },
  });
  expect(result.status).toBe("blocked");
  expect(readFileSync(path)).toEqual(before);
  expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("untouched");
  expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(true);
});
test("artifact output is bounded; source parts remain exact and hidden files stay out of inventory/discovery", () => {
  const f = setup(),
    before = "a\n".repeat(120000),
    after = "b\n".repeat(120000),
    r = save(f.store, f.root, 1, before, after),
    result = materializeReview(f.project, f.store, r.reviewId);
  expect(result.status).toBe("written");
  const bytes = readFileSync(join(f.root, result.path!));
  expect(bytes.byteLength).toBeLessThanOrEqual(REVIEW_ARTIFACT_LIMITS.bytes);
  expect(bytes.toString()).toContain("# diff complete=false; body omitted");
  expect(f.store.readSnapshot(r.latest).toString()).toBe(after);
  writeFileSync(join(f.root, ".archer/.review", "hidden.mmd"), "flowchart LR\n a[Hidden]");
  expect(listDiagrams(f.project).map((d) => d.path)).not.toContain(".review/hidden.mmd");
  expect(discoverAuthoringDocuments(f.project).documents.map((d) => d.source.path)).not.toContain(
    ".archer/.review/hidden.mmd",
  );
});
test("the production watcher never subscribes the derived directory, including after resync", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B");
  materializeReview(f.project, f.store, r.reviewId);
  const paths: string[] = [];
  const observedWatch = ((...args: Parameters<typeof watch>) => {
    paths.push(String(args[0]));
    return watch(...args);
  }) as typeof watch;
  const watcher = new ProjectWatcher(f.root, f.project.folder, () => {}, [], { watch: observedWatch });
  try {
    save(f.store, f.root, 2, "B", "C");
    materializeReview(f.project, f.store, r.reviewId);
    watcher.sync(f.project.folder);
    expect(paths).toContain(f.project.folder);
    expect(paths.some((path) => path.includes("/.review"))).toBe(false);
  } finally {
    watcher.close();
  }
});
test("cleared review removes its own artifact even when the source file was deleted", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B"),
    first = materializeReview(f.project, f.store, r.reviewId);
  unlinkSync(join(f.root, ".archer/a.mmd"));
  f.store.clearReview(f.root, r.reviewId, 1, "understood");
  expect(materializeReview(f.project, f.store, r.reviewId)).toMatchObject({ status: "removed", path: first.path });
  expect(existsSync(join(f.root, first.path!))).toBe(false);
});
test("managed Git exclusion is created and an existing user gitignore is tolerated unchanged", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B");
  expect(materializeReview(f.project, f.store, r.reviewId).status).toBe("written");
  const path = join(f.root, ".archer/.review/.gitignore");
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, "utf8")).toContain("\n*\n");
  writeFileSync(path, "# user rules\n*.diff\n");
  expect(materializeReview(f.project, f.store, r.reviewId).status).toBe("written");
  expect(readFileSync(path, "utf8")).toBe("# user rules\n*.diff\n");
});
test("interrupted no-clobber Git exclusion publication leaves its linked pair and refuses later writes", () => {
  const f = setup(),
    r = save(f.store, f.root, 1, "A", "B"),
    dir = join(f.root, ".archer/.review");
  expect(
    materializeReview(f.project, f.store, r.reviewId, {
      onStep(step) {
        if (step === "ignore_linked") throw Error("interrupted");
      },
    }).status,
  ).toBe("blocked");
  expect(readdirSync(dir).some((name) => name.startsWith(".ignore.") && name.endsWith(".tmp"))).toBe(true);
  expect(materializeReview(f.project, f.store, r.reviewId).status).toBe("blocked");
  expect(readdirSync(dir).some((name) => name.startsWith(".ignore.") && name.endsWith(".tmp"))).toBe(true);
});
test.each(["symlink", "hardlink", "directory"])(
  "foreign %s gitignore is refused without touching outside files",
  (kind) => {
    const f = setup(),
      r = save(f.store, f.root, 1, "A", "B"),
      outside = tempDir({ sentinel: "foreign" }),
      dir = join(f.root, ".archer/.review");
    mkdirSync(dir);
    const target = join(dir, ".gitignore");
    if (kind === "symlink") symlinkSync(join(outside, "sentinel"), target);
    else if (kind === "hardlink") linkSync(join(outside, "sentinel"), target);
    else mkdirSync(target);
    expect(materializeReview(f.project, f.store, r.reviewId).status).toBe("blocked");
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("foreign");
    expect(readdirSync(dir)).toEqual([".gitignore"]);
  },
);
