// Comments and notes through the service: a real service on a temp state
// directory, a temp project attached over the management socket, and the
// page's routes called over real HTTP, under the page's own security.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CommentsStore } from "../../src/comments/store.ts";
import type { Thread, ThreadList } from "../../src/comments/contract.ts";
import { findProject } from "../../src/project/index.ts";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import {
  cleanUp,
  commentOperation,
  events,
  exactly,
  FLOW2,
  http,
  pageCommentAnswer,
  pageCommentBody,
  json,
  project,
  service,
  write,
  type Reply,
  apiBase,
} from "../service/support.ts";

afterEach(cleanUp);
const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

const NOTE =
  "---\ntype: decision\nstatus: draft\ndiagrams: [flow.mmd]\n---\n# Auth flow\n\nThe client sends a **token** to the API.\n";
const OTHER = "---\ndiagrams: [chat.mmd]\n---\nNo heading here.\n";

async function attached(files: Readonly<Record<string, string>> = {}) {
  const { svc } = await service({}, { comments: "queued" });
  const c = await connectService(svc.socketPath);
  clients.push(c);
  const root = project();
  write(root, ".archer/auth.md", NOTE);
  write(root, ".archer/other.md", OTHER);
  for (const [path, contents] of Object.entries(files)) write(root, path, contents);
  const page = apiBase((await c.call("attach", { root })).url);
  const origin = `http://127.0.0.1:${svc.port}`;
  // As the page sends them (ui/src/comments/transport.ts): every write is JSON, a body-less one `{}`; a create, a
  // reply and a submit are operations (ADR 0016), and a create or reply is read as its receipt's thread.
  const targets = new Map<string, string>();
  const send = async (
    method: string,
    path: string,
    given?: unknown,
    headers: Record<string, string> = { origin },
  ): Promise<Reply> => {
    const body = pageCommentBody(
      method,
      path,
      given === undefined && method !== "GET" ? {} : given,
      // A thread this test did not make (an unknown id): the flow view's, as good as any for a refusal.
      (threadId) => targets.get(threadId) ?? "view:flow",
    );
    const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    // With its length, as a browser sends it (Node sends a DELETE body unframed otherwise).
    const framing =
      text === undefined
        ? {}
        : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) };
    const reply = pageCommentAnswer(
      method,
      path,
      await http(`${page}${path}`, {
        method,
        headers: { ...headers, ...framing },
        ...(text === undefined ? {} : { body: text }),
      }),
    );
    if (reply.status === 200) {
      const answer = JSON.parse(reply.body) as { id?: unknown; target?: unknown };
      if (typeof answer.id === "string" && typeof answer.target === "string") targets.set(answer.id, answer.target);
    }
    return reply;
  };
  const ok = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const reply = await send(method, path, body);
    if (reply.status !== 200) throw new Error(`${method} ${path}: ${reply.status} ${reply.body}`);
    return JSON.parse(reply.body) as unknown;
  };
  const errorOf = (reply: Reply) => [reply.status, (JSON.parse(reply.body) as { error: { code: string } }).error.code];
  return { svc, c, root, page, origin, send, ok, errorOf };
}

const CAPABILITIES = {
  capabilities: {
    comments: true,
    notes: true,
    noteEmphasis: true,
    instanceSettings: true,
    listeners: true,
    commentOperations: 1,
  },
};

test("bootstrap says the service has comments and notes, presented or not", async () => {
  const { c, root, page } = await attached();
  expect(await json(`${page}api/bootstrap`)).toEqual({ ...CAPABILITIES, project: { name: expect.any(String) } });
  await c.call("present", { root, viewId: "flow" });
  expect(await json(`${page}api/bootstrap`)).toMatchObject({ presentation: { viewId: "flow" }, ...CAPABILITIES });
});

describe("notes", () => {
  test("the notes of a view, with titles from their first heading or their file name", async () => {
    const { page, send, errorOf } = await attached();
    expect(await json(`${page}api/notes?viewId=flow`)).toEqual({
      viewId: "flow",
      notes: [{ path: "auth.md", title: "Auth flow", type: "decision", status: "draft" }],
    });
    expect(await json(`${page}api/notes?viewId=chat`)).toEqual({
      viewId: "chat",
      notes: [{ path: "other.md", title: "other.md" }],
    });
    expect(errorOf(await send("GET", "api/notes?viewId=nope"))).toEqual([404, "diagram_not_found"]);
    expect(errorOf(await send("GET", "api/notes"))).toEqual([422, "invalid_request"]);
  });

  test("every note, including those about no diagram, with the views each is about", async () => {
    const { page, root, svc, send } = await attached();
    // Notes written outside the service are listed once the watcher reports them (inotify reports a write
    // before the next request; FSEvents some milliseconds later, and may also replay the project's own
    // creation): each notes event is a reload, so read again on each until both notes are in.
    const all = async () => ((await json(`${page}api/notes/all`)) as { notes: Record<string, unknown>[] }).notes;
    const stream = await events(`${page}api/events`);
    let listed: Record<string, unknown>[];
    try {
      // No `diagrams` and no diagram beside it: a note about nothing (a note with
      // no `diagrams` is about the diagrams in its own folder).
      write(root, ".archer/notes/ideas.md", "---\ntype: idea\n---\n# Later, maybe\n\nA queue between the two.\n");
      write(root, ".archer/plans/both.md", "---\ndiagrams: [flow.mmd, chat.mmd, gone.mmd]\n---\n# Both\n");
      while ((listed = await all()).length < 4) await stream.next("notes");
    } finally {
      stream.close();
    }
    // Each note's dates and description have their own tests (test/service/front-door.test.ts).
    expect(listed.map(({ createdAt: _c, createdFrom: _f, modifiedAt: _m, ...rest }) => rest)).toEqual([
      {
        path: "auth.md",
        title: "Auth flow",
        type: "decision",
        status: "draft",
        diagrams: ["flow.mmd"],
        viewIds: ["flow"],
        description: "The client sends a token to the API.",
        descriptionFrom: "derived",
      },
      {
        path: "notes/ideas.md",
        title: "Later, maybe",
        type: "idea",
        diagrams: [],
        viewIds: [],
        description: "A queue between the two.",
        descriptionFrom: "derived",
      },
      {
        path: "other.md",
        title: "other.md",
        diagrams: ["chat.mmd"],
        viewIds: ["chat"],
        description: "No heading here.",
        descriptionFrom: "derived",
      },
      // A diagram the note names that is not a registered view is listed, and has no view.
      { path: "plans/both.md", title: "Both", diagrams: ["chat.mmd", "flow.mmd"], viewIds: ["chat", "flow"] },
    ]);
    // The page's security, as every route has it: the token or a bare 404, and reading only.
    const wrong = await http(
      `http://127.0.0.1:${svc.port}/${"0".repeat(svc.token.length)}/${page.split("/").slice(4).join("/")}api/notes/all`,
    );
    expect(wrong.status).toBe(404);
    expect(wrong.body).toBe("");
    expect((await send("POST", "api/notes/all", {})).status).toBe(404);
    expect((await send("GET", "api/notes/all/more")).status).toBe(404);
  });

  test("a note's content: front matter split from its Markdown, at a revision", async () => {
    const { page, send, errorOf } = await attached();
    expect(await json(`${page}api/notes/content?path=auth.md`)).toEqual({
      path: "auth.md",
      frontMatter: { type: "decision", status: "draft", diagrams: ["flow.mmd"] },
      markdown: "# Auth flow\n\nThe client sends a **token** to the API.\n",
      revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      // The temp project is in no repository (test/notes/freshness.test.ts has the rest).
      freshness: { status: "not-in-git" },
    });
    for (const path of ["../archer.toml", "flow.mmd", "missing.md", "/etc/passwd", "%2e%2e/x.md"])
      expect(errorOf(await send("GET", `api/notes/content?path=${encodeURIComponent(path)}`)), path).toEqual([
        404,
        "note_not_found",
      ]);
  });
});

describe("comments over HTTP", () => {
  const node = { kind: "node", id: "a", label: "Client" };

  test("create, list, edit, reply, submit, delete and resolve, each answered as the contract says", async () => {
    const { page, ok, root } = await attached();
    const created = (await ok("POST", "api/comments", {
      target: "view:flow",
      anchor: node,
      body: "Why here?",
    })) as Thread;
    expect(created).toMatchObject({
      target: "view:flow",
      status: "draft",
      anchor: node,
      comments: [{ author: "person", body: "Why here?" }],
    });
    const list = (await json(`${page}api/comments?target=view:flow`)) as ThreadList;
    expect(list).toEqual({ schemaVersion: 2, target: "view:flow", threads: [created] });
    expect(await json(`${page}api/comments?target=${encodeURIComponent("note:auth.md")}`)).toEqual({
      schemaVersion: 2,
      target: "note:auth.md",
      threads: [],
    });

    const first = created.comments[0]?.id ?? "";
    expect(await ok("PATCH", `api/comments/${created.id}/${first}`, { body: "Why is it here?" })).toMatchObject({
      comments: [{ body: "Why is it here?", editedAt: expect.any(String) }],
    });
    const replied = (await ok("POST", `api/comments/${created.id}/replies`, { body: "And there?" })) as Thread;
    expect(await ok("POST", "api/comments/submit", {})).toMatchObject({ replayed: false, submitted: 1 });
    expect(((await json(`${page}api/comments?target=view:flow`)) as ThreadList).threads[0]?.status).toBe("sent");
    expect(await ok("DELETE", `api/comments/${created.id}/${replied.comments[1]?.id ?? ""}`)).toMatchObject({
      status: "draft",
      changedAfterSubmit: true,
    });
    expect(await ok("POST", "api/comments/submit", { target: "view:flow" })).toMatchObject({
      replayed: false,
      submitted: 1,
    });
    expect(await ok("POST", `api/comments/${created.id}/resolve`)).toEqual({ resolved: true });
    // No thread is left; the file keeps only the operations' receipts, so a repeat is still answered (ADR 0016).
    expect(JSON.parse(readFileSync(join(root, ".archer/flow.comments.json"), "utf8"))).toMatchObject({
      threads: [],
      receipts: expect.anything(),
    });

    const lone = (await ok("POST", "api/comments", {
      target: "note:auth.md",
      anchor: { kind: "view" },
      body: "x",
    })) as Thread;
    expect(existsSync(join(root, ".archer/auth.comments.json"))).toBe(true);
    expect(await ok("DELETE", `api/comments/${lone.id}/${lone.comments[0]?.id ?? ""}`)).toEqual({ deleted: true });
  });

  test("refusals carry the store's codes", async () => {
    const { send, errorOf, root } = await attached();
    expect(
      errorOf(await send("POST", "api/comments", { target: "view:nope", anchor: { kind: "view" }, body: "x" })),
    ).toEqual([404, "target_not_found"]);
    expect(
      errorOf(await send("POST", "api/comments", { target: "note:missing.md", anchor: { kind: "view" }, body: "x" })),
    ).toEqual([404, "target_not_found"]);
    expect(
      errorOf(
        await send("POST", "api/comments", {
          target: "view:flow",
          anchor: { kind: "node", id: "zz", label: "" },
          body: "x",
        }),
      ),
    ).toEqual([422, "invalid_comment"]);
    expect(errorOf(await send("POST", "api/comments", "{ not json"))).toEqual([422, "invalid_comment"]);
    expect(errorOf(await send("POST", "api/comments/t-000000000000/replies", { body: "x" }))).toEqual([
      404,
      "thread_not_found",
    ]);
    expect(errorOf(await send("GET", "api/comments?target=nonsense"))).toEqual([422, "invalid_comment"]);
    writeFileSync(join(root, ".archer/flow.comments.json"), "{ broken");
    expect(errorOf(await send("GET", "api/comments?target=view:flow"))).toEqual([409, "malformed_comments_file"]);
    const submitted = await send("POST", "api/comments/submit", {});
    expect(JSON.parse(submitted.body)).toMatchObject({
      replayed: false,
      submitted: 0,
      problems: [expect.stringContaining("flow.comments.json")],
    });
    expect(readFileSync(join(root, ".archer/flow.comments.json"), "utf8")).toBe("{ broken");
  });

  test("same-stem registered diagram and note targets both refuse their shared sidecar without changing it", async () => {
    const sentinel = "existing sidecar must stay byte-for-byte";
    const { send, errorOf, root } = await attached({
      "archer.toml":
        'version = 1\n[[views]]\nid = "auth"\nkind = "freeform"\ntitle = "Auth diagram"\nsource = ".archer/auth.mmd"\n',
      ".archer/auth.mmd": FLOW2,
      ".archer/auth.comments.json": sentinel,
    });
    for (const target of ["note:auth.md", "view:auth"]) {
      expect(
        errorOf(await send("POST", "api/comments", { target, anchor: { kind: "view" }, body: "must not be kept" })),
        target,
      ).toEqual([409, "comments_file_conflict"]);
      expect(readFileSync(join(root, ".archer/auth.comments.json"), "utf8"), target).toBe(sentinel);
    }
  });

  test("every change refuses another origin and an oversized body, and changes nothing", async () => {
    const { send, root } = await attached();
    // The owner's cookie sent from another origin admits no write: the bare 404, before any route.
    const foreign = { origin: "http://evil.example" };
    const body = { target: "view:flow", anchor: { kind: "view" }, body: "x" };
    expect((await send("POST", "api/comments", body, foreign)).status).toBe(404);
    expect((await send("POST", "api/comments/submit", {}, foreign)).status).toBe(404);
    expect((await send("PATCH", "api/comments/t-1/c-1", { body: "x" }, foreign)).status).toBe(404);
    expect((await send("DELETE", "api/comments/t-1/c-1", undefined, foreign)).status).toBe(404);
    expect((await send("POST", "api/comments/t-1/resolve", undefined, foreign)).status).toBe(404);
    expect((await send("POST", "api/comments/t-1/dismiss", undefined, foreign)).status).toBe(404);
    expect((await send("POST", "api/comments", { ...body, body: "x".repeat(70 * 1024) })).status).toBe(413);
    expect(existsSync(join(root, ".archer/flow.comments.json"))).toBe(false);
  });

  test("routes outside the contract are bare 404s, and nothing answers without a credential", async () => {
    const { page, send } = await attached();
    expect((await send("PUT", "api/comments")).status).toBe(404);
    expect((await send("GET", "api/comments/t-1/c-1/more")).status).toBe(404);
    expect((await send("POST", "api/comments/pending")).status).toBe(404);
    expect((await send("GET", "api/comments/t-1/dismiss")).status).toBe(404);
    expect((await exactly(`${page}api/comments?target=view:flow`)).status).toBe(404);
    const unknown = { cookie: `archer-${new URL(page).port}=${"0".repeat(64)}` };
    expect((await exactly(`${page}api/comments?target=view:flow`, { headers: unknown })).status).toBe(404);
  });
});

describe("sending everything, and what is left to send", () => {
  test("pending counts every draft in the project by target, with each target's title; submit with no target sends them all", async () => {
    const { page, ok } = await attached();
    expect(await json(`${page}api/comments/pending`)).toEqual({ total: 0, targets: [] });
    await ok("POST", "api/comments", { target: "view:flow", anchor: { kind: "view" }, body: "one" });
    await ok("POST", "api/comments", {
      target: "view:flow",
      anchor: { kind: "node", id: "a", label: "" },
      body: "two",
    });
    await ok("POST", "api/comments", { target: "view:chat", anchor: { kind: "view" }, body: "three" });
    await ok("POST", "api/comments", { target: "note:auth.md", anchor: { kind: "view" }, body: "four" });
    await ok("POST", "api/comments", { target: "note:other.md", anchor: { kind: "view" }, body: "five" });
    const pending = (await json(`${page}api/comments/pending`)) as {
      total: number;
      targets: { target: string; title: string; drafts: number }[];
    };
    expect(pending.total).toBe(5);
    expect([...pending.targets].sort((x, y) => x.target.localeCompare(y.target))).toEqual([
      { target: "note:auth.md", title: "Auth flow", drafts: 1 },
      { target: "note:other.md", title: "other.md", drafts: 1 },
      { target: "view:chat", title: expect.any(String), drafts: 1 },
      { target: "view:flow", title: "The flow", drafts: 2 },
    ]);

    // One target only, then everything else with no target.
    expect(await ok("POST", "api/comments/submit", { target: "note:auth.md" })).toMatchObject({
      replayed: false,
      submitted: 1,
    });
    expect(((await json(`${page}api/comments/pending`)) as { total: number }).total).toBe(4);
    expect(await ok("POST", "api/comments/submit")).toMatchObject({ replayed: false, submitted: 4 });
    expect(await json(`${page}api/comments/pending`)).toEqual({ total: 0, targets: [] });
    for (const target of ["view:flow", "view:chat", "note:auth.md", "note:other.md"])
      for (const t of ((await json(`${page}api/comments?target=${encodeURIComponent(target)}`)) as ThreadList).threads)
        expect(t.status, target).toBe("sent");
  });

  test("a comments file that cannot be read is left out of pending, and does not stop it", async () => {
    const { page, ok, root } = await attached();
    await ok("POST", "api/comments", { target: "note:auth.md", anchor: { kind: "view" }, body: "x" });
    writeFileSync(join(root, ".archer/flow.comments.json"), "{ broken");
    expect(await json(`${page}api/comments/pending`)).toEqual({
      total: 1,
      targets: [{ target: "note:auth.md", title: "Auth flow", drafts: 1 }],
    });
  });
});

describe("dismissing what the agent resolved", () => {
  test("a resolved thread is dismissed and removed; any other is refused and kept", async () => {
    const { page, ok, send, errorOf, root } = await attached();
    const thread = (await ok("POST", "api/comments", {
      target: "view:flow",
      anchor: { kind: "view" },
      body: "Rename it",
    })) as Thread;
    expect(errorOf(await send("POST", `api/comments/${thread.id}/dismiss`))).toEqual([409, "thread_not_resolved"]);
    await ok("POST", "api/comments/submit");
    const store = new CommentsStore(findProject(root));
    store.fetchForAgent(undefined, { asListener: true });
    store.resolve(thread.id, "agent", 1);
    expect(((await json(`${page}api/comments?target=view:flow`)) as ThreadList).threads[0]?.status).toBe("resolved");
    const stream = await events(`${page}api/events`);
    expect(await ok("POST", `api/comments/${thread.id}/dismiss`)).toEqual({ dismissed: true });
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
    stream.close();
    expect(((await json(`${page}api/comments?target=view:flow`)) as ThreadList).threads).toEqual([]);
    // The file keeps only the operation's receipt (ADR 0016).
    expect(JSON.parse(readFileSync(join(root, ".archer/flow.comments.json"), "utf8"))).toMatchObject({
      threads: [],
      receipts: expect.anything(),
    });
    expect(errorOf(await send("POST", `api/comments/${thread.id}/dismiss`))).toEqual([404, "thread_not_found"]);
  });
});

describe("events", () => {
  test("a change from the page, a change on disk by the agent, a note edit and an orphaning recompile are all announced", async () => {
    const { page, ok, root } = await attached();
    const stream = await events(`${page}api/events`);
    const created = (await ok("POST", "api/comments", {
      target: "view:flow",
      anchor: { kind: "node", id: "b", label: "" },
      body: "?",
    })) as Thread;
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });

    // The agent's side writes the file directly, as the MCP server does:
    // reading, answering and resolving each reach the page.
    await ok("POST", "api/comments/submit", {});
    await stream.next("comments");
    const agent = new CommentsStore(findProject(root));
    const status = async () => ((await json(`${page}api/comments?target=view:flow`)) as ThreadList).threads[0]?.status;
    agent.fetchForAgent(undefined, { asListener: true });
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
    expect(await status()).toBe("read");
    agent.reply(created.id, "Because.", "agent", 1);
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
    expect(await status()).toBe("answered");
    agent.resolve(created.id, "agent", 1);
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
    expect(await status()).toBe("resolved");
    // The person's edit of a resolved thread makes it a draft again, and is announced too.
    await ok("PATCH", `api/comments/${created.id}/${created.comments[0]?.id ?? ""}`, { body: "Actually, why?" });
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
    expect(await status()).toBe("draft");

    write(root, ".archer/auth.md", `${NOTE}\nMore.\n`);
    expect(await stream.next("notes")).toEqual({});

    // `b` leaves the diagram: the thread on it is orphaned, keeping its label.
    write(root, ".archer/flow.mmd", "flowchart LR\n  a[Client] e1@--> c[DB]\n");
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
    expect(((await json(`${page}api/comments?target=view:flow`)) as ThreadList).threads[0]).toMatchObject({
      orphaned: true,
      anchor: { id: "b", label: "API" },
    });
    write(root, ".archer/flow.mmd", FLOW2);
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
    expect(((await json(`${page}api/comments?target=view:flow`)) as ThreadList).threads[0]?.orphaned).toBeUndefined();
    stream.close();
  });
});

test("thread-scoped publication sends only the requested draft, including siblings on its target", async () => {
  const { ok } = await attached();
  const first = (await ok("POST", "api/comments", {
    target: "view:flow",
    anchor: { kind: "view" },
    body: "Publish this",
  })) as Thread;
  const held = (await ok("POST", "api/comments", {
    target: "view:flow",
    anchor: { kind: "view" },
    body: "Still thinking",
  })) as Thread;
  const note = (await ok("POST", "api/comments", {
    target: "note:auth.md",
    anchor: { kind: "view" },
    body: "Another held draft",
  })) as Thread;
  expect(await ok("POST", "api/comments/submit", { target: "view:flow", threadId: first.id })).toMatchObject({
    replayed: false,
    submitted: 1,
  });
  const flow = (await ok("GET", "api/comments?target=view:flow")) as ThreadList;
  expect(flow.threads.map((t) => [t.id, t.status])).toEqual([
    [first.id, "sent"],
    [held.id, "draft"],
  ]);
  const notes = (await ok("GET", "api/comments?target=note:auth.md")) as ThreadList;
  expect(notes.threads).toMatchObject([{ id: note.id, status: "draft" }]);
  expect(await ok("POST", "api/comments/submit", { threadId: first.id })).toMatchObject({
    replayed: false,
    submitted: 0,
  });
  expect(await ok("GET", "api/comments/pending")).toMatchObject({ total: 2 });
});

test("scoped publication refuses mismatched targets and foreign-project thread IDs atomically", async () => {
  const { root, c, svc, ok, send } = await attached();
  const draft = (await ok("POST", "api/comments", {
    target: "view:flow",
    anchor: { kind: "view" },
    body: "Held here",
  })) as Thread;
  const before = readFileSync(join(root, ".archer/flow.comments.json"));
  const mismatch = await send("POST", "api/comments/submit", { target: "note:auth.md", threadId: draft.id });
  expect(mismatch.status).toBe(404);
  expect(JSON.parse(mismatch.body).error.code).toBe("thread_not_found");
  const otherRoot = project();
  const { url } = await c.call("attach", { root: otherRoot });
  const origin = `http://127.0.0.1:${svc.port}`;
  const foreign = await http(`${apiBase(url)}api/comments`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(
      commentOperation.create({ target: "view:flow", anchor: { kind: "view" }, body: "Held elsewhere" }),
    ),
  });
  expect(foreign.status).toBe(200);
  const foreignThread = (JSON.parse(foreign.body) as { thread: Thread }).thread;
  const otherBefore = readFileSync(join(otherRoot, ".archer/flow.comments.json"));
  const denied = await send("POST", "api/comments/submit", { target: "view:flow", threadId: foreignThread.id });
  expect(denied.status).toBe(404);
  expect(JSON.parse(denied.body).error.code).toBe("thread_not_found");
  expect(readFileSync(join(root, ".archer/flow.comments.json"))).toEqual(before);
  expect(readFileSync(join(otherRoot, ".archer/flow.comments.json"))).toEqual(otherBefore);
});

test.each([null, "", "x".repeat(129), 3, [], {}])(
  "invalid publication selector %j refuses without publishing held drafts",
  async (threadId) => {
    const { root, ok, send } = await attached();
    await ok("POST", "api/comments", { target: "view:flow", anchor: { kind: "view" }, body: "Still held" });
    const before = readFileSync(join(root, ".archer/flow.comments.json"));
    const result = await send("POST", "api/comments/submit", { target: "view:flow", threadId });
    expect(result.status).toBe(422);
    expect(JSON.parse(result.body).error.code).toBe("invalid_comment");
    expect(readFileSync(join(root, ".archer/flow.comments.json"))).toEqual(before);
  },
);
