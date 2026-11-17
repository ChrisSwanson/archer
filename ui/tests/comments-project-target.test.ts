// The page's reading of the project conversation (wave 2): the `project:` target, the project anchor and
// a person comment's `context`, through the page's own parser and transport.
import { describe, expect, it } from "vitest";
import { isTargetRef, parseAnchor, parseThread } from "../src/comments/parse";
import { anchorLabel } from "../src/comments/state";
import { httpCommentsTransport } from "../src/comments/transport";
import { newOperation } from "../src/comments/operations";
import type { CommentOperation } from "../src/comments/contract";
import { ackOf } from "./support/comment-writes";

const THREAD = {
  id: "t1",
  target: "project:",
  anchor: { kind: "project" },
  status: "draft",
  revision: 1,
  comments: [
    {
      id: "c1",
      author: "person",
      body: "Hi",
      createdAt: "2026-10-25T00:00:00Z",
      context: { page: "/projects/x/search", document: "notes/a.md" },
    },
  ],
};

describe("the project conversation as the page reads it", () => {
  it("accepts exactly `project:` as a target and a project anchor", () => {
    expect(isTargetRef("project:")).toBe(true);
    expect(isTargetRef("project")).toBe(false);
    expect(parseAnchor({ kind: "project" })).toEqual({ kind: "project" });
    expect(anchorLabel({ kind: "project" }, "view")).toBe("Whole project");
  });

  it("keeps a comment's context, and reads one without it", () => {
    const thread = parseThread(THREAD);
    expect(thread?.comments[0]?.context).toEqual({ page: "/projects/x/search", document: "notes/a.md" });
    const old = parseThread({
      ...THREAD,
      target: "note:a.md",
      anchor: { kind: "view" },
      comments: [{ id: "c1", author: "person", body: "Hi", createdAt: "x" }],
    });
    expect(old?.comments[0]).not.toHaveProperty("context");
  });

  it("sends the context with a reply, and only when there is one", async () => {
    const sent: unknown[] = [];
    const transport = httpCommentsTransport(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { operation: CommentOperation };
      sent.push(body);
      return new Response(JSON.stringify(ackOf(body.operation, parseThread(THREAD)!)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await transport.replyOnce(newOperation("comment.reply", "project:"), "t1", "More", { page: "/projects/x" });
    await transport.replyOnce(newOperation("comment.reply", "project:"), "t1", "Plain");
    expect(sent).toEqual([
      {
        operation: expect.objectContaining({ name: "comment.reply" }),
        payload: { body: "More", context: { page: "/projects/x" } },
      },
      { operation: expect.objectContaining({ name: "comment.reply" }), payload: { body: "Plain" } },
    ]);
  });
});
