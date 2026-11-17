import { afterEach, expect, test } from "vitest";
import {
  AccountStateStore,
  MAX_INDEX_BYTES,
  MAX_METADATA_BYTES,
  MAX_STATE_DEPTH,
  MAX_STATE_VALUES,
  parseAccountIndex,
  parseRecovery,
  PersistenceError,
} from "../../src/state/account.ts";
import { MAX_SOURCE_BYTES } from "../../src/mermaid/limits.ts";
import { revisionOf } from "../../src/project/index.ts";
import { cleanUp, tempDir } from "../service/support.ts";

afterEach(cleanUp);
const record = {
  version: 1 as const,
  root: "/project",
  presentation: null,
  selection: null,
  captions: [],
  lastChange: [],
  emphases: [],
  views: [],
};

test.each([
  { name: "metadata", parse: parseRecovery, text: JSON.stringify(record), limit: MAX_METADATA_BYTES },
  {
    name: "account index",
    parse: parseAccountIndex,
    text: JSON.stringify({ version: 1, projects: [] }),
    limit: MAX_INDEX_BYTES,
  },
])("$name accepts its exact byte limit and names refusal one byte past it", ({ parse, text, limit }) => {
  const exact = text + " ".repeat(limit - Buffer.byteLength(text));
  expect(() => parse(exact)).not.toThrow();
  expect(() => parse(exact + " ")).toThrow(expect.objectContaining({ code: "saved_state_capacity" }));
});

test("source blobs accept the exact byte limit and refuse one byte past without replacing metadata", () => {
  const store = new AccountStateStore(tempDir());
  const bytes = Buffer.alloc(MAX_SOURCE_BYTES, 32),
    revision = revisionOf(bytes);
  const saved = {
    ...record,
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
  expect(store.source(record.root, revision)).toEqual(bytes);
  const oversized = Buffer.alloc(MAX_SOURCE_BYTES + 1, 32),
    overRevision = revisionOf(oversized);
  expect(() =>
    store.save({ ...saved, views: [{ ...saved.views[0]!, revision: overRevision, blob: overRevision }] }, [
      { revision: overRevision, bytes: oversized },
    ]),
  ).toThrow(PersistenceError);
  expect(store.load(record.root)).toEqual(saved);
});

test("depth budget accepts exactly 64 and refuses 65 by name", () => {
  // Root depth0, presentation depth1, then array values down to the limit.
  const text = (depth: number) =>
    JSON.stringify(record).replace(
      '"presentation":null',
      '"presentation":' + "[".repeat(depth - 1) + "0" + "]".repeat(depth - 1),
    );
  expect(() => parseRecovery(text(MAX_STATE_DEPTH))).not.toThrow();
  expect(() => parseRecovery(text(MAX_STATE_DEPTH + 1))).toThrow(
    expect.objectContaining({ code: "saved_state_depth" }),
  );
});

test("value budget accepts exactly 500000 and refuses the next value before interpretation", () => {
  // Root plus its eight properties plus the values inside presentation.
  const text = (count: number) =>
    JSON.stringify(record).replace('"presentation":null', '"presentation":[' + "0,".repeat(count - 10) + "0]");
  expect(() => parseRecovery(text(MAX_STATE_VALUES))).not.toThrow();
  expect(() => parseRecovery(text(MAX_STATE_VALUES + 1))).toThrow(
    expect.objectContaining({ code: "saved_state_capacity" }),
  );
});
