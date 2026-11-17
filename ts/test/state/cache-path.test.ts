import { chmodSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AccountStateStore, PersistenceError } from "../../src/state/account.ts";
import { revisionOf } from "../../src/project/index.ts";
import { cleanUp, tempDir } from "../service/support.ts";

afterEach(cleanUp);

function cachedSource() {
  const store = new AccountStateStore(tempDir());
  const root = "/project",
    bytes = Buffer.from("flowchart LR\n a[A]\n"),
    revision = revisionOf(bytes);
  store.save(
    {
      version: 1,
      root,
      presentation: null,
      selection: null,
      captions: [],
      lastChange: [],
      emphases: [],
      views: [
        {
          id: "flow",
          path: "flow.mmd",
          kind: "freeform",
          title: "Flow",
          revision,
          sourceRevision: revision,
          blob: revision,
        },
      ],
    },
    [{ revision, bytes }],
  );
  const sourceDir = join(store.directory, readdirSync(store.directory).find((name) => name.endsWith(".sources"))!);
  return { store, root, revision, sourceDir };
}

test.each(["linked", "nonprivate"] as const)("saved source directory that is %s is refused before recovery", (kind) => {
  const { store, root, revision, sourceDir } = cachedSource();
  if (kind === "linked") {
    const target = join(tempDir(), "sources");
    renameSync(sourceDir, target);
    symlinkSync(target, sourceDir);
  } else chmodSync(sourceDir, 0o755);
  expect(() => store.source(root, revision)).toThrow(PersistenceError);
});

test("runtime directory linked after store construction is refused for metadata and source reads", () => {
  const { store, root, revision } = cachedSource();
  const target = join(tempDir(), "runtime");
  renameSync(store.directory, target);
  symlinkSync(target, store.directory);
  expect(() => store.load(root)).toThrow(PersistenceError);
  expect(() => store.source(root, revision)).toThrow(PersistenceError);
});

test.each(["sources", "runtime"] as const)("missing %s directory is refused by name without recreation", (kind) => {
  const { store, root, revision, sourceDir } = cachedSource();
  const original = kind === "sources" ? sourceDir : store.directory;
  const target = join(tempDir(), "removed-cache");
  renameSync(original, target);
  expect(() => store.source(root, revision)).toThrow(PersistenceError);
});
