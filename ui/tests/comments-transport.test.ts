// The page's side of the comments and notes routes: the URL, method and body
// of each call the contract names, and what the page makes of each answer.
import { describe, expect, it, vi } from "vitest";
import { httpCommentsTransport, TransportError, UncertainWriteError } from "../src/comments/transport";
import type { Thread } from "../src/comments/contract";

const THREAD: Thread = {
  id: "t1",
  target: "view:alpha",
  anchor: { kind: "node", id: "web", label: "Web" },
  status: "draft",
  revision: 1,
  comments: [{ id: "c1", author: "person", body: "Why?", createdAt: "2026-10-03T10:00:00.000Z" }],
};

type Call = { url: string; method: string; body: unknown };

/** Fixed identities, so each call's envelope can be stated whole. */
const REPLY = {
  id: "1".repeat(32),
  issuedAt: 1_793_000_000_000,
  name: "comment.reply" as const,
  target: "view:alpha" as const,
};
const REPLIED = {
  operation: { id: REPLY.id, issuedAt: REPLY.issuedAt, name: REPLY.name },
  replayed: false,
  committed: { threadId: "t1", commentId: "c1", revision: 1, committedAt: "2026-10-03T10:00:00.000Z" },
  thread: THREAD,
};
const SUBMIT = { id: "2".repeat(32), issuedAt: 1_793_000_000_000, name: "comment.submit" as const };

function fakeFetch(answer: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    };
    calls.push(call);
    const { status = 200, body } = answer(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  });
  return { calls, fetchImpl };
}

describe("httpCommentsTransport", () => {
  it.each([
    [
      "lists a target's threads",
      (t: ReturnType<typeof httpCommentsTransport>) => t.listThreads("view:alpha"),
      { url: "api/comments?target=view%3Aalpha", method: "GET", body: undefined },
      { schemaVersion: 2, target: "view:alpha", threads: [THREAD] },
      { schemaVersion: 2, target: "view:alpha", threads: [THREAD] },
    ],
    [
      "replies",
      (t: ReturnType<typeof httpCommentsTransport>) => t.replyOnce(REPLY, "t 1", "More"),
      { url: "api/comments/t%201/replies", method: "POST", body: { operation: REPLY, payload: { body: "More" } } },
      REPLIED,
      REPLIED,
    ],
    [
      "edits a comment",
      (t: ReturnType<typeof httpCommentsTransport>) => t.edit("t1", "c1", "Why, really?"),
      { url: "api/comments/t1/c1", method: "PATCH", body: { body: "Why, really?" } },
      THREAD,
      THREAD,
    ],
    [
      "edits a comment at the revision the page saw (O124)",
      (t: ReturnType<typeof httpCommentsTransport>) => t.edit("t1", "c1", "Why, really?", 3),
      { url: "api/comments/t1/c1", method: "PATCH", body: { body: "Why, really?", expectedRevision: 3 } },
      THREAD,
      THREAD,
    ],
    [
      "deletes a comment and keeps the thread",
      (t: ReturnType<typeof httpCommentsTransport>) => t.remove("t1", "c2"),
      { url: "api/comments/t1/c2", method: "DELETE", body: {} },
      THREAD,
      { deleted: false, thread: THREAD },
    ],
    [
      "deletes a thread's only comment",
      (t: ReturnType<typeof httpCommentsTransport>) => t.remove("t1", "c1"),
      { url: "api/comments/t1/c1", method: "DELETE", body: {} },
      { deleted: true },
      { deleted: true },
    ],
    [
      "resolves",
      (t: ReturnType<typeof httpCommentsTransport>) => t.resolve("t1"),
      { url: "api/comments/t1/resolve", method: "POST", body: {} },
      { resolved: true },
      undefined,
    ],
    [
      "submits everything pending",
      (t: ReturnType<typeof httpCommentsTransport>) => t.submitOnce(SUBMIT, {}),
      { url: "api/comments/submit", method: "POST", body: { operation: SUBMIT, payload: {} } },
      { operation: SUBMIT, replayed: false, submitted: 3 },
      { operation: SUBMIT, replayed: false, submitted: 3 },
    ],
    [
      "says which comments files the server skipped",
      (t: ReturnType<typeof httpCommentsTransport>) => t.submitOnce(SUBMIT, {}),
      { url: "api/comments/submit", method: "POST", body: { operation: SUBMIT, payload: {} } },
      { operation: SUBMIT, replayed: false, submitted: 1, problems: [".archer/x.comments.json: not JSON"] },
      { operation: SUBMIT, replayed: false, submitted: 1, problems: [".archer/x.comments.json: not JSON"] },
    ],
    [
      "submits one target",
      (t: ReturnType<typeof httpCommentsTransport>) => t.submitOnce(SUBMIT, { target: "note:a.md" }),
      { url: "api/comments/submit", method: "POST", body: { operation: SUBMIT, payload: { target: "note:a.md" } } },
      { operation: SUBMIT, replayed: false, submitted: 1 },
      { operation: SUBMIT, replayed: false, submitted: 1 },
    ],
    [
      "publishes exactly one thread",
      (t: ReturnType<typeof httpCommentsTransport>) => t.submitOnce(SUBMIT, { target: "view:alpha", threadId: "t1" }),
      {
        url: "api/comments/submit",
        method: "POST",
        body: { operation: SUBMIT, payload: { target: "view:alpha", threadId: "t1" } },
      },
      { operation: SUBMIT, replayed: false, submitted: 1 },
      { operation: SUBMIT, replayed: false, submitted: 1 },
    ],
    [
      "lists a view's notes",
      (t: ReturnType<typeof httpCommentsTransport>) => t.listNotes("alpha"),
      { url: "api/notes?viewId=alpha", method: "GET", body: undefined },
      { viewId: "alpha", notes: [{ path: "a.md", title: "A" }] },
      { viewId: "alpha", notes: [{ path: "a.md", title: "A" }] },
    ],
    [
      "reads a note",
      (t: ReturnType<typeof httpCommentsTransport>) => t.noteContent("notes/a b.md"),
      { url: "api/notes/content?path=notes%2Fa+b.md", method: "GET", body: undefined },
      { path: "notes/a b.md", frontMatter: {}, markdown: "# A", revision: "r" },
      { path: "notes/a b.md", frontMatter: {}, markdown: "# A", revision: "r" },
    ],
  ])("%s", async (_name, act, expectedCall, answer, expected) => {
    const { calls, fetchImpl } = fakeFetch(() => ({ body: answer }));
    const result = await act(httpCommentsTransport(fetchImpl));
    expect(calls).toEqual([expectedCall]);
    expect(result).toEqual(expected);
  });

  it("says what the server refused, in the server's words", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 400,
      body: { schemaVersion: 1, error: { code: "too_long", message: "a comment holds at most 4000 characters" } },
    }));
    const failure = httpCommentsTransport(fetchImpl).edit("t1", "c1", "x");
    await expect(failure).rejects.toBeInstanceOf(TransportError);
    await expect(failure).rejects.toThrow("a comment holds at most 4000 characters");
  });

  it("refuses an answer it cannot read rather than holding half of it", async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { id: "t1" } }));
    await expect(httpCommentsTransport(fetchImpl).replyOnce(REPLY, "t1", "x")).rejects.toThrow(/could not read/);
  });

  it("sends JSON with its content type, and asks for nothing cached", async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: REPLIED }));
    await httpCommentsTransport(fetchImpl).replyOnce(REPLY, "t1", "x");
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.cache).toBe("no-store");
  });

  // A remembered-cookie page may write only with a JSON body (ADR 0017): a delete is no exception.
  it("sends every write as JSON, a delete included", async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { deleted: true } }));
    await httpCommentsTransport(fetchImpl).remove("t1", "c1");
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.method).toBe("DELETE");
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });
});

describe("comment operations (ADR 0016)", () => {
  const operation = {
    id: "0".repeat(32),
    issuedAt: 1_793_000_000_000,
    name: "comment.create" as const,
    target: "view:alpha" as const,
  };
  const ack = {
    operation: { id: operation.id, issuedAt: operation.issuedAt, name: operation.name },
    replayed: true,
    committed: { threadId: "t1", commentId: "c1", revision: 1, committedAt: "2026-10-03T10:00:00.000Z" },
    thread: THREAD,
  };

  it("posts the envelope to api/comments and reads the acknowledgement", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ body: ack }));
    const input = { target: "view:alpha" as const, anchor: { kind: "view" as const }, body: "Why?" };
    expect(await httpCommentsTransport(fetchImpl).createThreadOnce!(operation, input)).toEqual(ack);
    expect(calls).toEqual([{ url: "api/comments", method: "POST", body: { operation, payload: input } }]);
  });

  it("no answer, or a failure while answering, is uncertain; a refusal is a refusal with its code; not sent is not uncertain", async () => {
    const lost = httpCommentsTransport(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      lost.createThreadOnce!(operation, { target: "view:alpha", anchor: { kind: "view" }, body: "x" }),
    ).rejects.toBeInstanceOf(UncertainWriteError);
    const failing = httpCommentsTransport(
      fakeFetch(() => ({ status: 500, body: { error: { code: "internal", message: "boom" } } })).fetchImpl,
    );
    await expect(failing.replyOnce!({ ...operation, name: "comment.reply" }, "t1", "x")).rejects.toBeInstanceOf(
      UncertainWriteError,
    );
    const refusing = httpCommentsTransport(
      fakeFetch(() => ({ status: 409, body: { error: { code: "operation_payload_mismatch", message: "used" } } }))
        .fetchImpl,
    );
    const refusal = await refusing.createThreadOnce!(operation, {
      target: "view:alpha",
      anchor: { kind: "view" },
      body: "x",
    }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(TransportError);
    expect(refusal).not.toBeInstanceOf(UncertainWriteError);
    expect((refusal as TransportError).code).toBe("operation_payload_mismatch");
    const offline = httpCommentsTransport(fakeFetch(() => ({ body: ack })).fetchImpl, () => false);
    const held = await offline.createThreadOnce!(operation, {
      target: "view:alpha",
      anchor: { kind: "view" },
      body: "x",
    }).catch((e: unknown) => e);
    expect(held).not.toBeInstanceOf(UncertainWriteError);
  });
});
