// Sending from the bubble: make the message, then submit that one thread (ADR 0034 §10). The
// requests are asserted, through the real transport.
import { describe, expect, it, vi } from "vitest";
import { alsoSends, retryChat, sendChat } from "../src/chat/chat-send";
import { httpCommentsTransport } from "../src/comments/transport";
import type { Anchor, Thread } from "../src/comments/contract";
import { steppedRetries } from "./support/retry-clock";

const VIEW: Anchor = { kind: "view" };
const thread = (status: Thread["status"], bodies: string[] = ["Hi"]): Thread => ({
  id: "t1",
  target: "view:containers",
  anchor: VIEW,
  status,
  revision: 1,
  comments: bodies.map((body, i) => ({
    id: `c${i}`,
    author: i % 2 === 0 ? "person" : "agent",
    body,
    createdAt: "2026-10-23T10:00:00.000Z",
  })),
});
type Call = { url: string; method: string; body: unknown };

function server(options: { submitFails?: boolean; createFails?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    };
    calls.push(call);
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;
    const { operation } = call.body as { operation: { id: string; issuedAt: number; name: string } };
    if (url === "api/comments/submit")
      return options.submitFails
        ? reply(422, { error: { message: "down" } })
        : reply(200, { operation, replayed: false, submitted: 1 });
    if (url === "api/comments" && options.createFails) return reply(422, { error: { message: "no" } });
    const answered = thread("draft");
    return reply(200, {
      operation,
      replayed: false,
      committed: { threadId: answered.id, commentId: "c0", revision: 1, committedAt: "2026-10-23T10:00:00.000Z" },
      thread: answered,
    });
  });
  return { calls, transport: httpCommentsTransport(fetchImpl) };
}

describe("sendChat", () => {
  it("creates the thread, then submits only that thread", async () => {
    const { calls, transport } = server();
    const out = await sendChat(transport, { target: "view:containers", anchor: VIEW, body: "Hello" });
    expect(out.status).toBe("sent");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "api/comments"],
      ["POST", "api/comments/submit"],
    ]);
    expect(calls[0]!.body).toEqual({
      operation: expect.objectContaining({ name: "comment.create", target: "view:containers" }),
      payload: { target: "view:containers", anchor: VIEW, body: "Hello" },
    });
    expect(calls[1]!.body).toEqual({
      operation: expect.objectContaining({ name: "comment.submit" }),
      payload: { target: "view:containers", threadId: "t1" },
    });
  });
  it("replies to an answered thread, then submits it", async () => {
    const { calls, transport } = server();
    const out = await sendChat(transport, {
      target: "view:containers",
      anchor: VIEW,
      thread: thread("answered", ["Q", "A"]),
      body: "More",
    });
    expect(out.status).toBe("sent");
    expect(calls.map((c) => c.url)).toEqual(["api/comments/t1/replies", "api/comments/submit"]);
    expect(calls[0]!.body).toEqual({
      operation: expect.objectContaining({ name: "comment.reply" }),
      payload: { body: "More" },
    });
  });
  it("touches no other draft: there is no bulk submit and no other thread id", async () => {
    const { calls, transport } = server();
    await sendChat(transport, { target: "view:containers", anchor: VIEW, body: "x" });
    for (const call of calls) expect((call.body as { payload?: unknown }).payload).not.toEqual({});
    expect(
      calls
        .filter((c) => c.url === "api/comments/submit")
        .every((c) => (c.body as { payload: { threadId?: string } }).payload.threadId === "t1"),
    ).toBe(true);
  });
  it("leaves the message a draft when the submit fails, and Retry submits again", async () => {
    const failing = server({ submitFails: true });
    const out = await sendChat(failing.transport, { target: "view:containers", anchor: VIEW, body: "Hello" });
    expect(out).toMatchObject({ status: "failed", reason: "down" });
    expect(out.status === "failed" && out.threadId).toBe("t1");
    const again = server();
    expect((await retryChat(again.transport, "view:containers", "t1")).status).toBe("sent");
    expect(again.calls.map((c) => c.url)).toEqual(["api/comments/submit"]);
  });
  it("keeps the text when nothing was saved at all", async () => {
    const { calls, transport } = server({ createFails: true });
    expect(await sendChat(transport, { target: "view:containers", anchor: VIEW, body: "Hello" })).toEqual({
      status: "unsaved",
      reason: "no",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("where the message was sent from (wave 2)", () => {
  const CONTEXT = { page: "/projects/shop/diagrams/flow", document: ".archer/flow.mmd" };
  it("rides on a new thread and on a reply, and is left out when there is none", async () => {
    const created = server();
    await sendChat(created.transport, {
      target: "project:",
      anchor: { kind: "project" },
      body: "Hello",
      context: CONTEXT,
    });
    expect((created.calls[0]!.body as { payload: unknown }).payload).toEqual({
      target: "project:",
      anchor: { kind: "project" },
      body: "Hello",
      context: CONTEXT,
    });
    const replied = server();
    await sendChat(replied.transport, {
      target: "project:",
      anchor: { kind: "project" },
      thread: { ...thread("answered", ["Q", "A"]), target: "project:", anchor: { kind: "project" } },
      body: "More",
      context: CONTEXT,
    });
    expect(replied.calls[0]).toMatchObject({
      url: "api/comments/t1/replies",
      body: { payload: { body: "More", context: CONTEXT } },
    });
    const bare = server();
    await sendChat(bare.transport, { target: "view:containers", anchor: VIEW, body: "Plain" });
    expect((bare.calls[0]!.body as { payload: unknown }).payload).not.toHaveProperty("context");
  });
});

describe("alsoSends", () => {
  it("counts a draft already on the thread, which goes with the message", () => {
    expect(alsoSends(thread("draft"))).toBe(1);
    for (const status of ["sent", "read", "answered"] as const) expect(alsoSends(thread(status))).toBe(0);
    expect(alsoSends(undefined)).toBe(0);
  });
});

// codex-202 (O100): the chat's writes are ADR 0016 operations, like the review controls'. A service that keeps
// receipts; `lose` drops the next answers of one route after it committed (a fetch that throws, as an aborted
// response does), so the page cannot tell whether it landed.
describe("as operations, with lost answers (codex-202)", () => {
  type Route = "create" | "reply" | "submit";
  function receiptServer(mode: "immediate" | "queued" = "queued") {
    const threads = new Map<string, Thread>();
    const receipts = new Map<string, unknown>();
    const effects = { create: 0, reply: 0, submit: 0 };
    const ids: Record<Route, string[]> = { create: [], reply: [], submit: [] };
    const lose: Record<Route, number> = { create: 0, reply: 0, submit: 0 };
    let n = 0;
    const now = "2026-11-02T10:00:00.000Z";
    const answer = (status: number, body: unknown) =>
      ({ ok: status < 300, status, json: async () => body }) as Response;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const target = new URLSearchParams(url.split("?")[1]).get("target");
        return answer(200, {
          schemaVersion: 2,
          target,
          threads: [...threads.values()].filter((t) => t.target === target),
        });
      }
      const body = JSON.parse(init!.body as string) as {
        operation?: { id: string; issuedAt: number; name: string };
        payload?: Record<string, unknown>;
      };
      const route: Route = url === "api/comments" ? "create" : url === "api/comments/submit" ? "submit" : "reply";
      if (body.operation === undefined) return answer(400, { error: { message: "not an operation" } });
      ids[route].push(body.operation.id);
      let ack = receipts.get(body.operation.id);
      if (ack === undefined) {
        effects[route] += 1;
        if (route === "submit") {
          const t = threads.get(body.payload!["threadId"] as string)!;
          const went = t.status === "draft" ? 1 : 0;
          threads.set(t.id, { ...t, status: "sent" });
          ack = { operation: body.operation, replayed: false, submitted: went };
        } else {
          const id = route === "create" ? `t${++n}` : url.split("/")[2]!;
          const held = threads.get(id);
          const comment = {
            id: `c${++n}`,
            author: "person" as const,
            body: body.payload!["body"] as string,
            createdAt: now,
          };
          const t: Thread =
            held === undefined
              ? {
                  id,
                  target: body.payload!["target"] as Thread["target"],
                  anchor: body.payload!["anchor"] as Anchor,
                  status: mode === "immediate" ? "sent" : "draft",
                  revision: 1,
                  comments: [comment],
                }
              : {
                  ...held,
                  status: mode === "immediate" ? "sent" : "draft",
                  revision: held.revision + 1,
                  comments: [...held.comments, comment],
                };
          threads.set(id, t);
          ack = {
            operation: body.operation,
            replayed: false,
            committed: { threadId: id, commentId: comment.id, revision: t.revision, committedAt: now },
            thread: t,
          };
        }
        receipts.set(body.operation.id, ack);
      } else {
        ack = { ...(ack as object), replayed: true };
      }
      if (lose[route] > 0) {
        lose[route] -= 1;
        throw new TypeError("Failed to fetch");
      }
      return answer(200, ack);
    });
    return { threads, effects, ids, lose, transport: httpCommentsTransport(fetchImpl) };
  }
  const ask = { target: "view:containers" as const, anchor: VIEW, body: "Hello" };

  it("a lost create is resent by the page with the same identity: one comment, then sent", async () => {
    const s = receiptServer();
    s.lose.create = 1;
    const out = await steppedRetries(
      () => sendChat(s.transport, ask),
      () => s.ids.create.length,
      2,
    );
    expect(out.status).toBe("sent");
    expect(new Set(s.ids.create).size).toBe(1);
    expect(s.ids.create.length).toBe(2);
    expect(s.effects.create).toBe(1);
    expect([...s.threads.values()].map((t) => t.status)).toEqual(["sent"]);
  });

  it("a create still unanswered says it may have been sent, keeps the identity, and the next Send is the same comment", async () => {
    const s = receiptServer();
    s.lose.create = 10;
    const first = await steppedRetries(
      () => sendChat(s.transport, ask),
      () => s.ids.create.length,
      3,
    );
    expect(new Set(s.ids.create).size).toBe(1);
    expect(first.status).toBe("unsure");
    if (first.status !== "unsure" || first.stage !== "save") throw new Error("expected an uncertain save");
    expect(first.reason).toMatch(/may have been sent or not/);
    expect(first.reason).toMatch(/never a second copy/);
    expect(s.effects.create).toBe(1);
    s.lose.create = 0;
    // The thread it made is now on screen (the page read it again): the next Send is still the held create, not a reply.
    const drafted = [...s.threads.values()][0]!;
    const again = await sendChat(s.transport, { ...ask, thread: drafted }, { held: first.intent });
    expect(again.status).toBe("sent");
    expect(new Set(s.ids.create).size).toBe(1);
    expect(s.effects.create).toBe(1);
    expect(s.ids.reply).toEqual([]);
    expect(drafted.comments).toHaveLength(1);
    expect([...s.threads.values()][0]!.comments).toHaveLength(1);
  });

  it("a held identity is for its own text: changed text, the earlier one not there, is a new operation", async () => {
    const s = receiptServer();
    s.lose.create = 10;
    const first = await steppedRetries(
      () => sendChat(s.transport, ask),
      () => s.ids.create.length,
      3,
    );
    if (first.status !== "unsure" || first.stage !== "save") throw new Error("expected an uncertain save");
    s.lose.create = 0;
    s.threads.clear(); // it never landed
    const again = await sendChat(s.transport, { ...ask, body: "Hello, again" }, { held: first.intent });
    expect(again.status).toBe("sent");
    expect(new Set(s.ids.create).size).toBe(2);
  });

  it.each(["create", "reply"] as const)(
    "a %s that may have been sent, then corrected: Archer is read first, the earlier one is said, no second message (claude-304)",
    async (kind) => {
      const s = receiptServer();
      const root = kind === "reply" ? await sendChat(s.transport, { ...ask, body: "Root" }) : null;
      const on = root?.status === "sent" ? s.threads.get(root.threadId) : undefined;
      s.lose[kind] = 10;
      const sentBefore = s.ids[kind].length;
      const first = await steppedRetries(
        () => sendChat(s.transport, { ...ask, ...(on ? { thread: on } : {}), body: "Teh typo" }),
        () => s.ids[kind].length,
        3,
      );
      expect(new Set(s.ids[kind].slice(sentBefore)).size).toBe(1);
      if (first.status !== "unsure" || first.stage !== "save") throw new Error("expected an uncertain save");
      s.lose[kind] = 0;
      const before = s.effects[kind];
      const fixed = await sendChat(
        s.transport,
        { ...ask, ...(on ? { thread: s.threads.get(on.id)! } : {}), body: "The typo" },
        { held: first.intent },
      );
      expect(fixed).toMatchObject({ status: "earlier", landed: "Teh typo" });
      expect(fixed.status === "earlier" && fixed.reason).toMatch(
        /An earlier version of this message was sent .*“Teh typo”/,
      );
      expect(s.effects[kind]).toBe(before);
      // Told; the person's next Send (no held identity now) adds it once.
      const second = await sendChat(s.transport, {
        ...ask,
        ...(on ? { thread: s.threads.get(on.id)! } : {}),
        body: "The typo",
      });
      expect(second.status).toBe("sent");
      expect(s.effects[kind]).toBe(before + 1);
    },
  );

  it("a corrected message whose earlier version cannot be checked: nothing is sent, the identity is kept", async () => {
    const s = receiptServer();
    s.lose.create = 10;
    const first = await steppedRetries(
      () => sendChat(s.transport, ask),
      () => s.ids.create.length,
      3,
    );
    if (first.status !== "unsure" || first.stage !== "save") throw new Error("expected an uncertain save");
    const unreadable = {
      ...s.transport,
      listThreads: async () => {
        throw new TypeError("Failed to fetch");
      },
    };
    const before = s.effects.create;
    const fixed = await sendChat(unreadable, { ...ask, body: "Hello, again" }, { held: first.intent });
    expect(fixed).toMatchObject({ status: "earlier", landed: null });
    expect(s.effects.create).toBe(before);
  });

  it("a lost reply is the same reply when sent again: one reply on the thread", async () => {
    const s = receiptServer();
    const opened = await sendChat(s.transport, ask);
    if (opened.status !== "sent") throw new Error("expected sent");
    const t = { ...s.threads.get(opened.threadId)!, status: "answered" as const };
    s.threads.set(t.id, t);
    s.lose.reply = 10;
    const first = await steppedRetries(
      () => sendChat(s.transport, { ...ask, thread: t, body: "More" }),
      () => s.ids.reply.length,
      3,
    );
    if (first.status !== "unsure" || first.stage !== "save") throw new Error("expected an uncertain reply");
    expect(first.intent.kind).toBe("reply");
    expect(s.effects.reply).toBe(1);
    s.lose.reply = 0;
    const again = await sendChat(
      s.transport,
      { ...ask, thread: s.threads.get(t.id)!, body: "More" },
      { held: first.intent },
    );
    expect(again.status).toBe("sent");
    expect(new Set(s.ids.reply).size).toBe(1);
    expect(s.threads.get(t.id)!.comments.map((c) => c.body)).toEqual(["Hello", "More"]);
  });

  it("a lost submit is never said as Not sent when the service holds it sent", async () => {
    const s = receiptServer();
    s.lose.submit = 10;
    const out = await steppedRetries(
      () => sendChat(s.transport, ask),
      () => s.ids.submit.length,
      3,
    );
    expect(s.effects.submit).toBe(1);
    expect(new Set(s.ids.submit).size).toBe(1);
    // Read back: the service holds it sent, so that is what the outcome says.
    expect(out.status).toBe("sent");
  });

  it("a submit with no answer and still a draft on the service is uncertain, and Retry sends the same submit", async () => {
    const s = receiptServer();
    const opened = await sendChat(s.transport, ask);
    if (opened.status !== "sent") throw new Error("expected sent");
    // The next submit never reaches the service: refused by the network before it commits.
    const real = s.transport.submitOnce!;
    const seen: string[] = [];
    s.transport.submitOnce = async (operation, scope) => {
      seen.push(operation.id);
      throw new (await import("../src/comments/transport")).UncertainWriteError("Failed to fetch");
    };
    const t = { ...s.threads.get(opened.threadId)!, status: "answered" as const };
    s.threads.set(t.id, t);
    const out = await steppedRetries(
      () => sendChat(s.transport, { ...ask, thread: t, body: "Next" }),
      () => seen.length,
      3,
    );
    expect(new Set(seen).size).toBe(1);
    expect(out.status).toBe("unsure");
    if (out.status !== "unsure" || out.stage !== "submit") throw new Error("expected an uncertain submit");
    expect(out.reason).toMatch(/may not have been sent/);
    s.transport.submitOnce = (operation, scope) => {
      seen.push(operation.id);
      return real(operation, scope);
    };
    expect((await retryChat(s.transport, "view:containers", out.threadId)).status).toBe("sent");
    expect(new Set(seen).size).toBe(1);
  });

  it("a refused create is Not saved, and its text stays", async () => {
    const s = receiptServer();
    s.transport.createThreadOnce = async () => {
      throw new (await import("../src/comments/transport")).TransportError("too long", 400);
    };
    expect(await sendChat(s.transport, ask)).toMatchObject({ status: "unsaved", reason: "too long" });
  });
});

describe("settleHeld keeps an identity only while it may have landed (O102)", () => {
  it("a refusal of a fresh operation forgets it; one after an unanswered try keeps it", async () => {
    const { settleHeld } = await import("../src/comments/operations");
    const { TransportError, UncertainWriteError } = await import("../src/comments/transport");
    const held = new Map<string, { id: string }>();
    const notSent = new TransportError("Waiting for Archer to reconnect.", undefined, "not_sent");
    await settleHeld(
      held,
      "k",
      () => ({ id: "a" }),
      async () => {
        throw notSent;
      },
    );
    expect(held.has("k")).toBe(false);
    held.set("k", { id: "b" });
    await settleHeld(
      held,
      "k",
      () => ({ id: "c" }),
      async () => {
        throw new TransportError("refused", 403);
      },
    );
    expect(held.get("k")).toEqual({ id: "b" });
    held.clear();
    let n = 0;
    await settleHeld(
      held,
      "k",
      () => ({ id: "d" }),
      async () => {
        if (n++ === 0) throw new UncertainWriteError("Failed to fetch");
        throw new TransportError("refused", 403);
      },
    );
    expect(held.get("k")).toEqual({ id: "d" });
  });
});
