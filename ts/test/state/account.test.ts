import { afterEach, expect, test } from "vitest";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AccountStateStore, parseRecovery, type RecoveryRecord } from "../../src/state/account.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { compileDiagram, compileDiagramBytes, findProject, revisionOf } from "../../src/project/index.ts";
import { cleanUp, project, tempDir } from "../service/support.ts";
afterEach(cleanUp);
const record = (root: string): RecoveryRecord => ({
  version: 1,
  root,
  presentation: null,
  selection: null,
  captions: [],
  lastChange: [],
  emphases: [],
  views: [],
});
test("filesystem and verified byte compilation run the identical production contract", async () => {
  const root = project(),
    p = findProject(root),
    entry = { path: "flow.mmd", view: p.views[0]! },
    disk = await compileDiagram(p, entry),
    bytes = readFileSync(join(root, ".archer/flow.mmd"));
  expect(await compileDiagramBytes(entry, bytes)).toEqual(disk);
  expect(disk.sourceBytes).toEqual(bytes);
  expect(disk.envelope!.revision).toBe(revisionOf(bytes));
});
test("store rejects corrupted records and source blobs without deleting evidence", () => {
  const dir = tempDir(),
    store = new AccountStateStore(dir),
    root = "/project";
  store.save(record(root), []);
  const file = readdirSync(store.directory).find((p) => p !== "index.json" && p.endsWith(".json"))!;
  writeFileSync(join(store.directory, file), "{broken");
  expect(() => store.load(root)).toThrow(/not valid JSON/);
  expect(readFileSync(join(store.directory, file), "utf8")).toBe("{broken");
});
test("mutation persistence failure rolls back context and publishes no half-applied event", async () => {
  const dir = tempDir(),
    store = new AccountStateStore(dir),
    state = await ProjectState.open(
      project(),
      () => "http://localhost/p/",
      () => {},
      { store },
    );
  state.persist();
  const before = state.context(),
    events: string[] = [];
  state.subscribe((name) => events.push(name));
  chmodSync(store.directory, 0o500);
  try {
    expect(() => state.present("flow", "Must not succeed")).toThrow(/could not commit/);
    expect(state.context()).toEqual(before);
    expect(events).toEqual([]);
  } finally {
    chmodSync(store.directory, 0o700);
    state.close();
  }
});
test("incompatible versions and named depth limit are refused", () => {
  expect(() => parseRecovery(JSON.stringify({ ...record("/p"), version: 2 }))).toThrow(/incompatible/);
  const text =
    '{"version":1,"root":"/p","presentation":null,"selection":null,"captions":[],"lastChange":[],"views":[],"emphases":[],"extra":' +
    "[".repeat(66) +
    "0" +
    "]".repeat(66) +
    "}";
  expect(() => parseRecovery(text)).toThrow(/depth 64/);
});
test("account capacity is named and never evicts acknowledged roots", () => {
  const store = new AccountStateStore(tempDir());
  for (let n = 0; n < 256; n++) store.markAttached(`/root-${n}`, false);
  expect(() => store.markAttached("/overflow", true)).toThrow(/no state was evicted/);
  store.markAttached("/root-0", true);
  expect(new AccountStateStore(join(store.directory, "..")).attachedRoots()).toEqual(["/root-0"]);
}, 30_000); // 257 atomic replacements: 0.1 s idle, 8.0 s (timed out) beside a disk writer, 16.7-21.0 s under write throttling
test("source blobs are verified and corruption evidence is retained", () => {
  const store = new AccountStateStore(tempDir()),
    root = "/project",
    bytes = Buffer.from("flowchart LR\n a[A]\n"),
    revision = revisionOf(bytes),
    saved = {
      ...record(root),
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
    };
  store.save(saved, [{ revision, bytes }]);
  expect(store.source(root, revision)).toEqual(bytes);
  const sourceDir = join(store.directory, readdirSync(store.directory).find((p) => p.endsWith(".sources"))!),
    path = join(sourceDir, revision.slice(7));
  writeFileSync(path, "tampered");
  expect(() => store.source(root, revision)).toThrow(/digest differs/);
  expect(readFileSync(path, "utf8")).toBe("tampered");
});
test("malformed saved captions and duplicate source identities fail closed", () => {
  expect(() =>
    parseRecovery(
      JSON.stringify({ ...record("/p"), captions: [["flow", { at: "2026-10-04T10:00:00.000Z", caption: 42 }]] }),
    ),
  ).toThrow(/history metadata/);
  const revision = revisionOf(Buffer.from("flowchart LR\n a[A]\n")),
    view = {
      id: "flow",
      path: "flow.mmd",
      kind: "freeform",
      title: "Flow",
      revision,
      sourceRevision: revision,
      blob: revision,
    };
  expect(() => parseRecovery(JSON.stringify({ ...record("/p"), views: [view, view] }))).toThrow(/source reference/);
});
