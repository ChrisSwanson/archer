import { describe, expect, test } from "vitest";
import { commentActivity } from "../../../shared/comment-activity.mts";
import type { Comment, Thread, ThreadStatus } from "../../src/comments/contract.ts";

const posted = (id: string, createdAt: string, editedAt?: string): Comment => ({
  id,
  author: "person",
  body: id,
  createdAt,
  ...(editedAt === undefined ? {} : { editedAt }),
});

const thread = (id: string, status: ThreadStatus, comments: readonly Comment[]): Thread => ({
  id,
  target: "view:flow",
  anchor: { kind: "view" },
  status,
  revision: 1,
  comments,
});

describe("commentActivity", () => {
  const unresolvedByStatus: Readonly<Record<ThreadStatus, number>> = {
    draft: 1,
    sent: 1,
    read: 1,
    answered: 1,
    resolved: 0,
  };

  test.each(Object.entries(unresolvedByStatus) as [ThreadStatus, number][])(
    "counts a %s thread by its lifecycle state",
    (status, unresolvedThreads) => {
      expect(commentActivity([thread("t-1", status, [posted("c-1", "2026-10-11T18:00:00.000Z")])])).toEqual({
        totalThreads: 1,
        unresolvedThreads,
        lastCommentedAt: "2026-10-11T18:00:00.000Z",
      });
    },
  );

  test("uses the latest retained post, ignoring edits and status-only changes", () => {
    const comments = [
      posted("c-1", "2026-10-11T18:00:00.000Z", "2026-10-11T23:00:00.000Z"),
      { ...posted("c-2", "2026-10-11T19:00:00.000Z"), author: "agent" as const },
    ];
    expect(commentActivity([thread("t-1", "resolved", comments)])).toEqual({
      totalThreads: 1,
      unresolvedThreads: 0,
      lastCommentedAt: "2026-10-11T19:00:00.000Z",
      agentComments: [{ thread: "t-1", comment: "c-2" }],
    });
    expect(commentActivity([thread("t-1", "answered", comments.slice(0, 1))])).toMatchObject({
      lastCommentedAt: "2026-10-11T18:00:00.000Z",
    });
    expect(commentActivity([])).toEqual({ totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null });
  });

  test("normalizes the published timestamp and never forwards an invalid stored value", () => {
    expect(commentActivity([thread("t-1", "draft", [posted("c-1", "2026-10-11T18:00:00-07:00")])])).toMatchObject({
      lastCommentedAt: "2026-10-12T01:00:00.000Z",
    });
    expect(commentActivity([thread("t-1", "draft", [posted("c-1", "x".repeat(10_000))])])).toMatchObject({
      lastCommentedAt: null,
    });
  });

  test("arbitrary stored timestamp text is refused as null or normalized to a bounded ISO value", () => {
    const vocabulary = [
      "",
      "T",
      "Z",
      "+",
      "-",
      ":",
      ".",
      "2026",
      "10",
      "11",
      "not-a-date",
      "\ud800",
      "x".repeat(10_000),
    ];
    const inputs = [
      ...vocabulary,
      ...Array.from(
        { length: 500 },
        (_, index) =>
          `${vocabulary[index % vocabulary.length]}${String.fromCodePoint(32 + ((index * 7919) % 95))}${vocabulary[(index * 7) % vocabulary.length]}`,
      ),
      ...Array.from({ length: 100 }, (_, index) => {
        const valid = "2026-10-11T18:00:00.000Z";
        const at = index % valid.length;
        return `${valid.slice(0, at)}${String.fromCodePoint(32 + (index % 95))}${valid.slice(at + 1)}`;
      }),
    ];
    for (const createdAt of inputs) {
      const value = commentActivity([thread("t-1", "draft", [posted("c-1", createdAt)])]).lastCommentedAt;
      expect(value === null || (value.length <= 27 && Number.isFinite(Date.parse(value))), createdAt.slice(0, 80)).toBe(
        true,
      );
    }
  });

  // PF-2: the bell counts unread agent answers from the activity, so it reads no thread on page load.
  test("names each agent comment by thread and id, and lists none where the agent has not commented", () => {
    const agent = (id: string, createdAt: string): Comment => ({ ...posted(id, createdAt), author: "agent" });
    expect(
      commentActivity([
        thread("t-1", "answered", [
          posted("c-1", "2026-10-11T18:00:00.000Z"),
          agent("c-2", "2026-10-11T19:00:00.000Z"),
        ]),
        thread("t-2", "resolved", [agent("c-3", "2026-10-11T20:00:00.000Z")]),
      ]).agentComments,
    ).toEqual([
      { thread: "t-1", comment: "c-2" },
      { thread: "t-2", comment: "c-3" },
    ]);
    expect(commentActivity([thread("t-1", "sent", [posted("c-1", "2026-10-11T18:00:00.000Z")])])).not.toHaveProperty(
      "agentComments",
    );
  });
});
