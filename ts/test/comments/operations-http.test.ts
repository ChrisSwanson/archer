// Comment operations over HTTP (ADR 0016, O67): the page's create and reply carry an operation; the same one
// sent again (its answer lost) is acknowledged from its receipt, also by a restarted service, and never makes
// a second thread; in immediate mode the repeat is published and answered `sent`. A receipt is the sign-in's
// that made it: another grant's browser sending the same identity is refused and learns nothing.
import { randomBytes } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import type { OperationAck, SubmitAck, Thread } from "../../src/comments/contract.ts";
import { Delivery } from "../../src/service/listeners.ts";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { apiBase, cleanUp, events, http, project, service, slugOf, type Reply } from "../service/support.ts";

afterEach(cleanUp);
const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

async function attached(extra: { readonly comments?: "queued" } = {}) {
  const { svc, state } = await service({}, extra);
  const c = await connectService(svc.socketPath);
  clients.push(c);
  const root = project();
  const url = (await c.call("attach", { root })).url as string;
  const origin = `http://127.0.0.1:${svc.port}`;
  const page = apiBase(url);
  const send = (path: string, body: unknown, headers: Record<string, string> = {}, base = page): Promise<Reply> =>
    http(`${base}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const threads = async (): Promise<Thread[]> =>
    (JSON.parse((await http(`${page}api/comments?target=view%3Aflow`)).body) as { threads: Thread[] }).threads;
  return { svc, state, c, root, url, origin, page, send, threads };
}

const operation = (name: "comment.create" | "comment.reply" = "comment.create") => ({
  id: randomBytes(16).toString("hex"),
  issuedAt: Date.now(),
  name,
  target: "view:flow",
});
const payload = { target: "view:flow", anchor: { kind: "view" }, body: "Is this the only path?" };
const ack = (reply: Reply): OperationAck => {
  expect(reply.status, reply.body).toBe(200);
  return JSON.parse(reply.body) as OperationAck;
};

test("bootstrap offers comment operations", async () => {
  const { page } = await attached();
  expect(
    (JSON.parse((await http(`${page}api/bootstrap`)).body) as { capabilities: Record<string, unknown> }).capabilities
      .commentOperations,
  ).toBe(1);
});

test("queued: a create sent twice is one draft; the repeat answers the original acknowledgement; a new operation with the same text is a second", async () => {
  const { send, threads } = await attached({ comments: "queued" });
  const create = operation();
  const first = ack(await send("api/comments", { operation: create, payload }));
  expect(first).toMatchObject({ replayed: false, operation: { id: create.id }, thread: { status: "draft" } });
  const again = ack(await send("api/comments", { operation: create, payload }));
  expect(again).toEqual({ ...first, replayed: true });
  expect(await threads()).toHaveLength(1);
  ack(await send("api/comments", { operation: operation(), payload }));
  expect(await threads()).toHaveLength(2);
});

test("immediate: the first answer and the repeat both say sent, and one thread was made", async () => {
  const { send, threads } = await attached();
  const create = operation();
  expect(ack(await send("api/comments", { operation: create, payload })).thread?.status).toBe("sent");
  const again = ack(await send("api/comments", { operation: create, payload }));
  expect(again).toMatchObject({ replayed: true, thread: { status: "sent" } });
  expect((await threads()).map((t) => t.status)).toEqual(["sent"]);
});

// O250: the create and its publish are two writes; the page reads the target once per `comments` event, so a
// draft that no page could ever see was announced as well and cost a second read of the same list.
test("immediate: a create, a reply and an edit, each with its publish, announce their target once", async () => {
  const { send, page, origin } = await attached();
  const stream = await events(`${page}api/events`);
  try {
    const created = ack(await send("api/comments", { operation: operation(), payload })).thread!;
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
    ack(
      await send(`api/comments/${created.id}/replies`, {
        operation: operation("comment.reply"),
        payload: { body: "And the other one?" },
      }),
    );
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
    const edit = await http(`${page}api/comments/${created.id}/${created.comments[0]!.id}`, {
      method: "PATCH",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ body: "Is this the one path?" }),
    });
    expect(edit.status, edit.body).toBe(200);
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
    // Last: a `next` that timed out still takes the next event when it comes.
    await expect(
      stream.next("comments", 400),
      "a fourth comments event for one create, one reply and one edit",
    ).rejects.toThrow(/no comments event/);
  } finally {
    stream.close();
  }
});

test("a reply sent twice is one reply; the operation names its target", async () => {
  const { send, threads } = await attached({ comments: "queued" });
  const thread = ack(await send("api/comments", { operation: operation(), payload })).thread!;
  const reply = operation("comment.reply");
  const body = { operation: reply, payload: { body: "And the other one?" } };
  const first = ack(await send(`api/comments/${thread.id}/replies`, body));
  expect(ack(await send(`api/comments/${thread.id}/replies`, body))).toEqual({ ...first, replayed: true });
  expect((await threads())[0]!.comments).toHaveLength(2);
});

test("the same identity with other content is refused; a malformed envelope is refused; nothing changes", async () => {
  const { send, threads } = await attached({ comments: "queued" });
  const create = operation();
  ack(await send("api/comments", { operation: create, payload }));
  const code = (reply: Reply) => [reply.status, (JSON.parse(reply.body) as { error: { code: string } }).error.code];
  expect(code(await send("api/comments", { operation: create, payload: { ...payload, body: "Other" } }))).toEqual([
    409,
    "operation_payload_mismatch",
  ]);
  expect(code(await send("api/comments", { operation: { ...create, id: "x" }, payload }))).toEqual([
    422,
    "invalid_operation",
  ]);
  expect(code(await send("api/comments", { operation: create, payload, extra: 1 }))).toEqual([
    422,
    "invalid_operation",
  ]);
  expect(await threads()).toHaveLength(1);
});

test("another grant's browser sending the same identity is refused and learns nothing of the receipt", async () => {
  const { c, send, threads, origin, url } = await attached({ comments: "queued" });
  const create = operation();
  ack(await send("api/comments", { operation: create, payload }));
  const grant = (await c.call("issueAccess", { label: "Shared link" })) as { token: string };
  const signIn = await http(`${origin}/projects/${slugOf(url)}/?token=${grant.token}`);
  const cookie = ((signIn.headers["set-cookie"] as string[])[0] ?? "").split(";")[0]!;
  const reply = await send("api/comments", { operation: create, payload }, { cookie }, `${origin}/p/${slugOf(url)}/`);
  expect(reply.status).toBe(409);
  const answer = JSON.parse(reply.body) as Record<string, unknown>;
  expect(answer).not.toHaveProperty("committed");
  expect(answer).not.toHaveProperty("thread");
  expect(reply.body).not.toMatch(/"t-[0-9a-f]+"/);
  expect(await threads()).toHaveLength(1);
}, 15_000);

const submitOperation = () => ({ id: randomBytes(16).toString("hex"), issuedAt: Date.now(), name: "comment.submit" });

test("queued: a submit whose answer was lost, sent again, is answered from its receipts; the delivery order runs once (O83)", {
  timeout: 15_000,
}, async () => {
  const arrived = vi.spyOn(Delivery.prototype, "arrived");
  try {
    const { send, threads } = await attached({ comments: "queued" });
    ack(await send("api/comments", { operation: operation(), payload }));
    ack(await send("api/comments", { operation: operation(), payload: { ...payload, body: "And this one?" } }));
    const submit = submitOperation();
    const answer = (reply: Reply): SubmitAck => {
      expect(reply.status, reply.body).toBe(200);
      return JSON.parse(reply.body) as SubmitAck;
    };
    const first = answer(await send("api/comments/submit", { operation: submit, payload: {} }));
    expect(first).toEqual({ operation: submit, replayed: false, submitted: 2 });
    expect(arrived).toHaveBeenCalledTimes(1);
    const again = answer(await send("api/comments/submit", { operation: submit, payload: {} }));
    expect(again).toEqual({ operation: submit, replayed: true, submitted: 2 });
    expect(arrived).toHaveBeenCalledTimes(1);
    expect((await threads()).map((t) => t.status)).toEqual(["sent", "sent"]);
    // One thread, the same way: the named-thread path does not call the order on a replay either.
    const third = ack(await send("api/comments", { operation: operation(), payload: { ...payload, body: "A third" } }))
      .thread!;
    const one = submitOperation();
    const body = { operation: one, payload: { target: "view:flow", threadId: third.id } };
    expect(answer(await send("api/comments/submit", body))).toMatchObject({ replayed: false, submitted: 1 });
    expect(arrived).toHaveBeenCalledTimes(2);
    expect(answer(await send("api/comments/submit", body))).toMatchObject({ replayed: true, submitted: 1 });
    expect(arrived).toHaveBeenCalledTimes(2);
  } finally {
    arrived.mockRestore();
  }
});

test("queued: a create, reply or submit that is not an operation is refused, and changes nothing", async () => {
  const { send, threads } = await attached({ comments: "queued" });
  const made = ack(await send("api/comments", { operation: operation(), payload }));
  const code = (r: Reply) => [r.status, (JSON.parse(r.body) as { error: { code: string } }).error.code];
  // The bodies pages before 0.15 sent: no `operation`, so no receipt and no answer to a retry (ADR 0016).
  expect(code(await send("api/comments/submit", {}))).toEqual([422, "invalid_operation"]);
  expect(code(await send("api/comments", payload))).toEqual([422, "invalid_operation"]);
  expect(code(await send(`api/comments/${made.thread!.id}/replies`, { body: "plain" }))).toEqual([
    422,
    "invalid_operation",
  ]);
  expect((await threads()).map((t) => [t.status, t.comments.length])).toEqual([["draft", 1]]);
  expect(
    code(await send("api/comments/submit", { operation: { ...submitOperation(), target: "view:flow" }, payload: {} })),
  ).toEqual([422, "invalid_operation"]);
});
