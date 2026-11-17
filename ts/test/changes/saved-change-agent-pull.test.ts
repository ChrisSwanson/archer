import { expect, test } from "vitest";
import { parseChangeCursor, wholeFileDiff } from "../../src/changes/review.ts";
import { parseRequest } from "../../src/service/socket.ts";

test("whole-file replacement diff marks absent before, exact CRLF and missing final newlines", () => {
  const created = wholeFileDiff(null, "\uFEFFnew\r\n", "file.mmd");
  expect(created).toMatchObject({ name: "unified-whole-file-replacement", complete: true });
  expect(created.text).toBe("--- /dev/null\n+++ after/file.mmd\n@@ -0,0 +1,1 @@\n+\uFEFFnew\r\n");
  const replaced = wholeFileDiff("old", "new", "file.mmd");
  expect(replaced.text).toContain("-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n");
  expect(replaced.bytes).toBe(Buffer.byteLength(replaced.text));
  expect(wholeFileDiff("", "new", "file.mmd").text).toContain("--- before/file.mmd");
  const limit = 64 * 1024;
  const overhead = Buffer.byteLength(wholeFileDiff(null, "x", "file.mmd").text) - 1;
  expect(wholeFileDiff(null, "x".repeat(limit - overhead), "file.mmd")).toMatchObject({ complete: true, bytes: limit });
  expect(wholeFileDiff(null, "x".repeat(limit - overhead + 1), "file.mmd")).toMatchObject({
    complete: false,
    text: "",
    bytes: limit + 1,
  });
});

test("strict cursor and IPC shapes reject ambiguous input before reading private state", () => {
  const identity = { root: "/tmp/project", storeId: `store_${"1".repeat(32)}`, generation: `gen_${"2".repeat(32)}` };
  const value = { ...identity, upper: 12, after: 3 },
    encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  expect(parseChangeCursor(encode(value), identity)).toEqual(value);
  for (const invalid of [
    { ...value, after: 13 },
    { ...value, upper: -1 },
    { ...value, root: "/tmp/x/../project" },
    { ...value, extra: false },
    { ...value, upper: 1.5 },
  ])
    expect(() => parseChangeCursor(encode(invalid), identity)).toThrowError(
      expect.objectContaining({ code: "change_cursor_invalid" }),
    );
  const cases = [
    ["pendingChanges", { root: identity.root, limit: 4 }],
    ["listChanges", { root: identity.root, limit: 21 }],
    ["readChange", { root: identity.root, changeId: `chg_${"3".repeat(32)}`, part: "unknown" }],
    [
      "resolveChange",
      { root: identity.root, changeId: `chg_${"3".repeat(32)}`, expectedReviewRevision: 1, disposition: "withdrawn" },
    ],
    [
      "resolveChange",
      { root: identity.root, changeId: `chg_${"3".repeat(32)}`, expectedReviewRevision: 0, disposition: "handled" },
    ],
    ["readChange", { root: identity.root, changeId: `chg_${"3".repeat(32)}`, unexpected: true }],
  ];
  for (const [method, params] of cases)
    expect(() => parseRequest({ id: 1, method, params })).toThrowError(
      expect.objectContaining({ code: "invalid_params" }),
    );
});
