// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalComments } from "../src/playground/comments";
import { httpCommentsTransport } from "../src/comments/transport";
import type { CommentOperation, NewThread } from "../src/comments/contract";

const target = "view:alpha" as const;
const input: NewThread = { target, anchor: { kind: "node", id: "web", label: "Web" }, body: "Why?" };
const operation = (id = "1", name: CommentOperation["name"] = "comment.create"): CommentOperation => ({
  id: id.repeat(32),
  issuedAt: Date.now(),
  name,
  target,
});
function setup(digest = "digest-a", storage: Storage | null = localStorage, projectSlug = "tour") {
  const notify = vi.fn();
  const overlay = createLocalComments({
    digest,
    projectSlug,
    modelRevision: () => `sha256:${"a".repeat(64)}`,
    storage,
    notify,
    validTarget: (value) => value === target || value === "project:" || value === "note:notes/example.md",
    validateAnchor: (_target, anchor) =>
      anchor.kind === "node" && anchor.id === "web"
        ? { ...anchor, label: "Web" }
        : anchor.kind === "project" || anchor.kind === "view"
          ? anchor
          : undefined,
  });
  const transport = httpCommentsTransport(async (path, init) => {
    const response = await overlay.request(path, init);
    if (response === undefined) throw new Error(`Unexpected request ${path}`);
    return response;
  });
  return { overlay, transport, notify };
}
beforeEach(() => localStorage.clear());

describe("static local review through the production comments transport", () => {
  it("refuses what the live store refuses: control characters and empty context fields", async () => {
    const { transport } = setup();
    await expect(
      transport.createThreadOnce(operation("3"), { ...input, body: "Hidden\u0001control" }),
    ).rejects.toMatchObject({
      status: 422,
      code: "invalid_comment",
    });
    for (const [field, context] of [
      ["page", { page: "" }],
      ["document", { page: "/projects/tour/", document: "" }],
      ["page", { page: "/projects/\u0007tour/" }],
    ] as const)
      await expect(
        transport.createThreadOnce(operation(field === "page" ? "4" : "5"), { ...input, context } as NewThread),
        field,
      ).rejects.toMatchObject({ status: 422, code: "invalid_comment" });
    expect((await transport.listThreads(target)).threads).toEqual([]);
  });
  it("creates, replies, edits, deletes and resolves while notifying after commit", async () => {
    const { overlay, transport, notify } = setup();
    const created = await transport.createThreadOnce(operation(), input);
    expect(created.thread).toMatchObject({ target, anchor: input.anchor, status: "draft", revision: 1 });
    expect((await transport.listThreads(target)).threads).toHaveLength(1);
    expect(notify).toHaveBeenLastCalledWith({ target });
    const replied = await transport.replyOnce(operation("2", "comment.reply"), created.committed.threadId, "Because");
    expect(replied.thread?.comments.map((c) => c.body)).toEqual(["Why?", "Because"]);
    expect(replied.thread?.revision).toBe(2);
    const edited = await transport.edit(created.committed.threadId, created.committed.commentId, "Why now?", 2);
    expect(edited.comments[0]?.body).toBe("Why now?");
    expect(edited.revision).toBe(3);
    await expect(
      transport.edit(created.committed.threadId, created.committed.commentId, "stale", 2),
    ).rejects.toMatchObject({ status: 409, code: "thread_changed" });
    expect(await transport.remove(created.committed.threadId, replied.committed.commentId)).toMatchObject({
      deleted: false,
    });
    const activity = await overlay.request("api/comments/activity");
    expect(await activity?.json()).toMatchObject({
      schemaVersion: 1,
      targets: { [target]: { totalThreads: 1, unresolvedThreads: 1 } },
    });
    await transport.resolve(created.committed.threadId);
    expect((await transport.listThreads(target)).threads).toEqual([]);
  });

  it("deduplicates operations across reload and refuses changed payloads", async () => {
    const first = setup();
    const op = operation();
    const created = await first.transport.createThreadOnce(op, input);
    const reload = setup();
    const replay = await reload.transport.createThreadOnce(op, input);
    expect(replay).toMatchObject({ replayed: true, committed: created.committed });
    expect((await reload.transport.listThreads(target)).threads).toHaveLength(1);
    await expect(reload.transport.createThreadOnce(op, { ...input, body: "different" })).rejects.toMatchObject({
      status: 409,
      code: "operation_payload_mismatch",
    });
    await reload.transport.resolve(created.committed.threadId);
    expect((await reload.transport.createThreadOnce(op, input)).thread).toBeNull();
  });

  it("isolates snapshots/projects and resets only demo storage", async () => {
    localStorage.setItem("docs-theme", "dark");
    const first = setup();
    await first.transport.createThreadOnce(operation(), input);
    expect((await setup("digest-b").transport.listThreads(target)).threads).toEqual([]);
    expect((await setup("digest-a", localStorage, "other").transport.listThreads(target)).threads).toEqual([]);
    first.overlay.reset();
    expect((await first.transport.listThreads(target)).threads).toEqual([]);
    expect((await setup().transport.listThreads(target)).threads).toEqual([]);
    expect(localStorage.getItem("docs-theme")).toBe("dark");
  });

  it("continues in memory when storage is denied or full", async () => {
    const denied = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {},
    } as unknown as Storage;
    const { overlay, transport } = setup("digest", denied);
    await transport.createThreadOnce(operation(), input);
    expect((await transport.listThreads(target)).threads).toHaveLength(1);
    expect(overlay.memoryOnly).toBe(true);
  });

  it("rejects bad targets, anchors, unbounded text, delivery, expired operations and aborted writes", async () => {
    const { overlay, transport, notify } = setup();
    await expect(transport.createThreadOnce(operation(), { ...input, target: "view:missing" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      transport.createThreadOnce(operation(), { ...input, anchor: { kind: "node", id: "missing", label: "Fake" } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(transport.createThreadOnce(operation(), { ...input, body: "x".repeat(4001) })).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      transport.createThreadOnce({ ...operation(), issuedAt: Date.UTC(2020, 0, 1) }, input),
    ).rejects.toMatchObject({ status: 409, code: "operation_expired" });
    await expect(
      transport.submitOnce({ id: "a".repeat(32), issuedAt: Date.now(), name: "comment.submit" }, {}),
    ).rejects.toMatchObject({ status: 403 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      overlay.request("api/comments", {
        method: "POST",
        body: JSON.stringify({ operation: operation(), payload: input }),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(notify).not.toHaveBeenCalled();
    expect((await transport.listThreads(target)).threads).toEqual([]);
  });

  it("keeps the diagram revision and rejects stale creation preconditions", async () => {
    const { transport } = setup();
    await expect(
      transport.createThreadOnce(operation(), { ...input, expectedModelRevision: `sha256:${"b".repeat(64)}` }),
    ).rejects.toMatchObject({ status: 409, code: "write_conflict" });
    await expect(
      transport.createThreadOnce(operation(), { ...input, expectedModelRevision: "bad" }),
    ).rejects.toMatchObject({ status: 422, code: "invalid_comment" });
    const created = await transport.createThreadOnce(operation(), input);
    expect(created.thread?.modelRevision).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("drops malformed persisted state and never accepts forged agent content", async () => {
    const { overlay, transport } = setup();
    await transport.createThreadOnce(operation(), input);
    const key = Object.keys(localStorage).find((key) => key.startsWith("archer:playground:"))!;
    expect(key).toBeTruthy();
    const forged = JSON.parse(localStorage.getItem(key)!);
    forged.threads[0].comments[0].author = "agent";
    localStorage.setItem(key, JSON.stringify(forged));
    expect((await setup().transport.listThreads(target)).threads).toEqual([]);
    localStorage.setItem(key, "{");
    expect((await setup().transport.listThreads(target)).threads).toEqual([]);
    expect(await overlay.request("api/notes/all")).toBeUndefined();
  });
  it("refuses deeply nested unknown context fields before canonicalizing operation payloads", async () => {
    const { overlay, transport, notify } = setup();
    const nested = "[".repeat(10000) + "0" + "]".repeat(10000);
    const raw = `{"operation":${JSON.stringify(operation())},"payload":{"target":"view:alpha","anchor":{"kind":"node","id":"web","label":"Web"},"body":"Why?","context":{"page":"p","x":${nested}}}}`;
    expect(raw.length).toBeLessThan(64 * 1024);
    const response = await overlay.request("api/comments", { method: "POST", body: raw });
    expect(response?.status).toBe(422);
    expect((await transport.listThreads(target)).threads).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses malformed addresses and arbitrary payloads without throwing", async () => {
    const { overlay } = setup();
    for (const path of ["api/comments/%", "api/comments/%E0%A4%A", "http://[invalid"]) {
      const answer = await overlay.request(path, { method: "POST", body: "{}" });
      expect(answer?.status).toBe(422);
    }
    for (const payload of [null, [], "text", 12, {}, { operation: {} }, { operation: { target } }]) {
      const answer = await overlay.request("api/comments", { method: "POST", body: JSON.stringify(payload) });
      expect(answer?.status).toBe(422);
    }
  });
});

// One executable contract over the real service and the static runtime; local delivery is deliberately absent.
for (const kind of ["live HTTP", "static overlay"] as const) {
  describe(`shared local-review contract: ${kind}`, () => {
    async function fixture() {
      if (kind === "static overlay") return { ...setup(), stop: async () => {} };
      const { startTsProject } = await import("./support/ts-service");
      const project = await startTsProject({
        files: {
          "archer.toml":
            'version = 1\n\n[[views]]\nid = "alpha"\nkind = "freeform"\ntitle = "Alpha"\nsource = ".archer/alpha.mmd"\n',
          ".archer/alpha.mmd": "flowchart LR\n  web[Web] e1@--> api[API]\n",
          ".archer/notes/example.md": "# Example\n\nA whole note can have a comment.\n",
        },
        commentSubmission: "queued",
      });
      return {
        transport: httpCommentsTransport((path, init) => project.fetch(path, init)),
        overlay: { request: (path: string, init?: RequestInit) => project.fetch(path, init) },
        stop: () => project.stop(),
      };
    }

    it("reads committed changes, replays create/reply exactly once, preserves revision errors and removes resolved threads", async () => {
      const { transport, stop } = await fixture();
      try {
        expect((await transport.listThreads(target)).threads).toEqual([]);
        const op = operation();
        const created = await transport.createThreadOnce(op, input);
        expect(created.thread).toMatchObject({ status: "draft", revision: 1, anchor: input.anchor });
        expect(await transport.createThreadOnce(op, input)).toMatchObject({
          replayed: true,
          committed: created.committed,
        });
        expect((await transport.listThreads(target)).threads).toHaveLength(1);
        const reply = operation("2", "comment.reply");
        const added = await transport.replyOnce(reply, created.committed.threadId, "Local reply");
        expect(await transport.replyOnce(reply, created.committed.threadId, "Local reply")).toMatchObject({
          replayed: true,
          committed: added.committed,
        });
        const listed = (await transport.listThreads(target)).threads[0]!;
        expect(listed.comments.map((c) => c.body)).toEqual(["Why?", "Local reply"]);
        expect(listed.revision).toBe(2);
        const edited = await transport.edit(listed.id, created.committed.commentId, "Edited", listed.revision);
        expect(edited.revision).toBe(3);
        await expect(
          transport.edit(listed.id, created.committed.commentId, "Stale", listed.revision),
        ).rejects.toMatchObject({ status: 409, code: "thread_changed" });
        await expect(transport.createThreadOnce(op, { ...input, body: "Changed retry" })).rejects.toMatchObject({
          status: 409,
          code: "operation_payload_mismatch",
        });
        await transport.resolve(listed.id);
        expect((await transport.listThreads(target)).threads).toEqual([]);
        expect((await transport.createThreadOnce(op, input)).thread).toBeNull();
      } finally {
        await stop();
      }
    });

    it("reads local changes from the canonical comment-activity route", async () => {
      const { transport, overlay, stop } = await fixture();
      try {
        const created = await transport.createThreadOnce(operation(), input);
        const response = await overlay.request("api/comment-activity");
        expect(response?.status).toBe(200);
        expect(await response?.json()).toMatchObject({
          schemaVersion: 1,
          agentCommentsListed: true,
          targets: { [target]: { totalThreads: 1, unresolvedThreads: 1 } },
        });
        await transport.resolve(created.committed.threadId);
        const empty = await overlay.request("api/comment-activity");
        const body = await empty?.json();
        expect(body.targets[target]?.totalThreads ?? 0).toBe(0);
      } finally {
        await stop();
      }
    });

    it("comments on a whole note using the production view anchor", async () => {
      const { transport, stop } = await fixture();
      try {
        const noteTarget = "note:notes/example.md" as const;
        const created = await transport.createThreadOnce(
          { ...operation(), target: noteTarget },
          {
            target: noteTarget,
            anchor: { kind: "view" },
            body: "About the whole note",
          },
        );
        expect(created.thread).toMatchObject({ target: noteTarget, anchor: { kind: "view" }, status: "draft" });
        expect((await transport.listThreads(noteTarget)).threads).toHaveLength(1);
      } finally {
        await stop();
      }
    });

    it("deletes one of two comments and returns the remaining thread through the production parser", async () => {
      const { transport, stop } = await fixture();
      try {
        const created = await transport.createThreadOnce(operation(), input);
        const reply = await transport.replyOnce(
          operation("2", "comment.reply"),
          created.committed.threadId,
          "Retain this reply",
        );
        await expect(transport.remove(created.committed.threadId, created.committed.commentId)).rejects.toMatchObject({
          status: 409,
          code: "has_replies",
        });
        const removed = await transport.remove(created.committed.threadId, reply.committed.commentId);
        expect(removed).toMatchObject({
          deleted: false,
          thread: { revision: 3, comments: [{ id: created.committed.commentId, body: "Why?" }] },
        });
        expect((await transport.listThreads(target)).threads[0]?.comments).toHaveLength(1);
      } finally {
        await stop();
      }
    });

    it("rejects extra route segments without mutating a comment", async () => {
      const { transport, overlay, stop } = await fixture();
      try {
        const created = await transport.createThreadOnce(operation(), input);
        const answer = await overlay.request(
          `api/comments/${created.committed.threadId}/${created.committed.commentId}/extra`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        );
        expect(answer?.status).toBe(404);
        expect((await transport.listThreads(target)).threads).toHaveLength(1);
      } finally {
        await stop();
      }
    });

    it("refuses invalid operations, absent anchors and aborted writes without committing", async () => {
      const { transport, overlay, stop } = await fixture();
      try {
        const response = await overlay.request("api/comments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: operation(), payload: input, extra: true }),
        });
        expect(response?.status).toBe(422);
        const unknownPayloadField = await overlay.request("api/comments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: operation(), payload: { ...input, agent: true } }),
        });
        expect(unknownPayloadField?.status).toBe(422);
        await expect(transport.createThreadOnce({ ...operation(), id: "invalid" }, input)).rejects.toMatchObject({
          status: 422,
          code: "invalid_operation",
        });
        await expect(
          transport.createThreadOnce(operation(), { ...input, anchor: { kind: "node", id: "gone", label: "Gone" } }),
        ).rejects.toMatchObject({ status: 422 });
        const controller = new AbortController();
        controller.abort();
        await expect(
          overlay.request("api/comments", {
            method: "POST",
            body: JSON.stringify({ operation: operation(), payload: input }),
            signal: controller.signal,
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect((await transport.listThreads(target)).threads).toEqual([]);
      } finally {
        await stop();
      }
    });
  });
}
