// One conversation end to end: the person comments in the page (real HTTP to
// a real service), the agent answers through the MCP tools (a real MCP
// server on the same project), and the files in the Archer folder carry it.
// Every state the page shows is read back over HTTP, and every change the
// agent makes reaches the page as a `comments` event.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Pending, Thread, ThreadList } from "../../src/comments/contract.ts";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { call, connect, refusal, structured } from "../mcp/support.ts";
import { cleanUp, events, json, pageWrites, project, service, write, apiBase } from "../service/support.ts";

afterEach(cleanUp);
const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

test("comment on two targets, send all; the agent reads; the person edits; the stale reply is refused; re-read, answered, resolved, dismissed", async () => {
  const { svc } = await service({}, { comments: "queued" });
  const management = await connectService(svc.socketPath);
  clients.push(management);
  const root = project();
  write(root, ".archer/auth.md", "---\ndiagrams: [flow.mmd]\n---\n# Auth flow\n\nTokens.\n");
  const page = apiBase((await management.call("attach", { root })).url);
  const origin = `http://127.0.0.1:${svc.port}`;
  // As the page sends them: a create, reply or submit as its operation (ADR 0016).
  const writes = pageWrites(page, origin);
  const send = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const reply = await writes(method, path, body);
    expect(reply.status, `${method} ${path}: ${reply.body}`).toBe(200);
    return JSON.parse(reply.body) as unknown;
  };
  const onFlow = async (): Promise<Thread | undefined> =>
    ((await json(`${page}api/comments?target=view:flow`)) as ThreadList).threads[0];
  const agent = await connect({ cwd: root });

  // The person comments on a node of the diagram and on the note.
  const created = (await send("POST", "api/comments", {
    target: "view:flow",
    anchor: { kind: "node", id: "b", label: "API" },
    body: "Is this one service?",
  })) as Thread;
  const first = created.comments[0]?.id ?? "";
  await send("POST", "api/comments", { target: "note:auth.md", anchor: { kind: "view" }, body: "Which tokens?" });
  expect(await json(`${page}api/comments/pending`)).toEqual({
    total: 2,
    targets: expect.arrayContaining([
      { target: "view:flow", title: "The flow", drafts: 1 },
      { target: "note:auth.md", title: "Auth flow", drafts: 1 },
    ]) as unknown,
  } satisfies Record<keyof Pending, unknown>);

  // "Send 2 to agent": one action, every draft in the project.
  expect(await send("POST", "api/comments/submit")).toMatchObject({ replayed: false, submitted: 2 });
  expect(await json(`${page}api/comments/pending`)).toEqual({ total: 0, targets: [] });
  expect((await onFlow())?.status).toBe("sent");

  // The agent fetches. It is not this checkout's listener, so the page still shows them sent (ADR 0035 §7).
  const stream = await events(`${page}api/events`);
  const fetched = structured(await call(agent.client, "get_comments"))["threads"] as Thread[];
  expect(fetched.map((t) => [t.target, t.status, t.revision]).sort()).toEqual([
    ["note:auth.md", "sent", 1],
    ["view:flow", "sent", 1],
  ]);
  expect((await onFlow())?.status).toBe("sent");

  // The person rewords the diagram's comment after the agent read it, and sends it again.
  await send("PATCH", `api/comments/${created.id}/${first}`, { body: "Is the API one service or several?" });
  expect(await onFlow()).toMatchObject({ status: "draft", changedAfterSubmit: true, revision: 2 });
  expect(await send("POST", "api/comments/submit")).toMatchObject({ replayed: false, submitted: 1 });

  // The agent's answer to the old text is refused, with the new text.
  const stale = await refusal(agent.client, "reply_comment", {
    threadId: created.id,
    body: "One service.",
    expectedRevision: 1,
  });
  expect(stale.data).toMatchObject({
    code: "thread_changed",
    revision: 2,
    status: "sent",
    comments: [{ body: "Is the API one service or several?" }],
  });
  expect((await onFlow())?.comments).toHaveLength(1);

  // It re-reads and answers the new text; the page is told and shows the reply.
  const reread = (
    structured(await call(agent.client, "get_comments", { target: "view:flow" }))["threads"] as Thread[]
  )[0];
  expect(reread).toMatchObject({
    id: created.id,
    revision: 2,
    comments: [{ body: "Is the API one service or several?" }],
  });
  await call(agent.client, "reply_comment", {
    threadId: created.id,
    body: "One service; the gateway is separate.",
    expectedRevision: 2,
  });
  await announced(stream, async () => (await onFlow())?.status === "answered");
  expect(await onFlow()).toMatchObject({
    status: "answered",
    comments: [{ author: "person" }, { author: "agent", body: "One service; the gateway is separate." }],
  });

  // It resolves: kept, resolved, with its reply, until the person dismisses it.
  await call(agent.client, "resolve_comment", { threadId: created.id, expectedRevision: 2 });
  await announced(stream, async () => (await onFlow())?.status === "resolved");
  expect(await onFlow()).toMatchObject({ status: "resolved", comments: [{}, { author: "agent" }] });
  expect((structured(await call(agent.client, "get_comments"))["threads"] as Thread[]).map((t) => t.target)).toEqual([
    "note:auth.md",
  ]);

  expect(await send("POST", `api/comments/${created.id}/dismiss`)).toEqual({ dismissed: true });
  const file = join(root, ".archer/flow.comments.json");
  // The thread is gone from the file; the receipts of the operations that made it stay, for a retry (ADR 0016).
  const left = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { threads: Thread[] }).threads : [];
  expect(left.map((thread) => thread.id)).not.toContain(created.id);
  expect(await onFlow()).toBeUndefined();

  stream.close();
  await agent.close();
}, 30_000);

/**
 * Waits for `comments` events on view:flow until the page, reading after one,
 * sees `shown`: the change reached the page through the event stream. Earlier
 * events (the agent's read of both files, the person's own changes) may still
 * be queued, so the check runs after each, not only the first.
 */
async function announced(stream: Awaited<ReturnType<typeof events>>, shown: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const event = (await stream.next("comments")) as { target: string };
    if (event.target === "view:flow" && (await shown())) return;
  }
  throw new Error("the page was never told of the change");
}
