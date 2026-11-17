import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const boundary = await import(pathToFileURL(process.argv[2]).href);
let seed = 0x51ee91;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
const vocabulary = [
  "{",
  "}",
  "[",
  "]",
  ":",
  ",",
  "null",
  "version",
  "entries",
  "target",
  "threadId",
  "commentId",
  "view:x",
  "note:a.md",
  '"',
  "\ud800",
];
const valid = JSON.stringify({ version: 1, entries: [{ target: "view:x", threadId: "t", commentId: "c" }] });

const check = (raw) => {
  const parsed = boundary.parseSeenState(raw);
  assert.ok(parsed.entries.length <= boundary.MAX_SEEN_ENTRIES);
  for (const entry of parsed.entries) {
    assert.ok(entry.target.length <= boundary.MAX_SEEN_TARGET_CHARS);
    assert.ok(entry.threadId.length <= boundary.MAX_SEEN_THREAD_ID_CHARS);
    assert.ok(entry.commentId.length <= boundary.MAX_SEEN_COMMENT_ID_CHARS);
  }
};

for (let round = 0; round < 20_000; round += 1) {
  let arbitrary = "";
  for (let index = 0; index < random() % 160; index += 1) arbitrary += String.fromCharCode(random() % 65536);
  check(arbitrary);
  check(
    Array.from({ length: random() % 40 }, () => vocabulary[random() % vocabulary.length]).join(
      random() % 2 === 0 ? "" : ",",
    ),
  );
  const at = random() % valid.length;
  check(valid.slice(0, at) + vocabulary[random() % vocabulary.length] + valid.slice(at + (random() % 4)));
  assert.doesNotThrow(() => boundary.seenStorageKey(arbitrary));
}
check("x".repeat(boundary.MAX_SEEN_STORAGE_CHARS + 1));
let stored = "";
const storage = {
  setItem(_key, value) {
    stored = value;
  },
};
const largestTarget = `note:${"x".repeat(boundary.MAX_SEEN_TARGET_CHARS - 8)}.md`;
const entries = Array.from({ length: boundary.MAX_SEEN_ENTRIES }, (_, index) => ({
  target: largestTarget,
  threadId: `t${index}`,
  commentId: `c${index}`,
}));
boundary.storeSeenState("bounded-project", { entries }, storage);
assert.ok(stored.length <= boundary.MAX_SEEN_STORAGE_CHARS);
check(stored);
process.stdout.write("review seen outcomes bounded");
