// The project conversation (wave 2, agent surfaces ticket 08): a `project:`
// target with a {kind:"project"} anchor, and an optional bounded `context` on a person's comment.
// Store, parsers, the page's routes and the MCP tools, each on real code.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MAX_CONTEXT_DOCUMENT_CHARS, MAX_CONTEXT_PAGE_CHARS, type Thread } from "../../src/comments/contract.ts";
import {
  CommentsError,
  CommentsStore,
  PROJECT_COMMENTS_PATH,
  elementsOf,
  parseTarget,
  readNewThread,
  validateCommentsFile,
  type Place,
} from "../../src/comments/store.ts";
import { TOOLS } from "../../src/mcp/tools.ts";
import { findProject } from "../../src/project/index.ts";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { call, connect, FLOW, refusal, removeTempDirs, structured, tempDir } from "../mcp/support.ts";
import {
  apiBase,
  cleanUp,
  events,
  http,
  pageWrites,
  project as tempProject,
  service,
  write,
} from "../service/support.ts";

afterEach(removeTempDirs);
afterEach(cleanUp);
const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

const PROJECT: Place = { target: "project:", path: PROJECT_COMMENTS_PATH, subject: { kind: "project" } };
const ANCHOR = { kind: "project" } as const;

function setup() {
  const root = tempDir({ ".archer/flow.mmd": FLOW, ".archer/auth.md": "# Auth\n\nTokens.\n" });
  const found = findProject(root);
  const store = new CommentsStore(found);
  const onDisk = () =>
    JSON.parse(readFileSync(join(found.folder, PROJECT_COMMENTS_PATH), "utf8")) as {
      version: number;
      target: string;
      threads: Thread[];
    };
  return { root, project: found, store, onDisk };
}

function refused(run: () => unknown, code: string): CommentsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CommentsError);
    expect((error as CommentsError).code, (error as Error).message).toBe(code);
    return error as CommentsError;
  }
  throw new Error(`expected a ${code} refusal`);
}

describe("the project target", () => {
  test("is exactly `project:`", () => {
    expect(parseTarget("project:")).toBe("project:");
    for (const bad of ["project", "project:x", "project: ", "Project:", "project:/", 7, null])
      expect(parseTarget(bad), String(bad)).toBeNull();
  });

  test("a person's project thread is stored in one file in the Archer folder, as version 4", () => {
    const { store, onDisk, project } = setup();
    const created = store.create(PROJECT, {
      anchor: ANCHOR,
      body: "What is left to do?",
      context: { page: "/projects/demo/search", document: "notes/auth.md" },
    });
    expect(created).toMatchObject({ target: "project:", path: PROJECT_COMMENTS_PATH });
    expect(created.value).toMatchObject({
      target: "project:",
      anchor: { kind: "project" },
      status: "draft",
      revision: 1,
      comments: [
        {
          author: "person",
          body: "What is left to do?",
          context: { page: "/projects/demo/search", document: "notes/auth.md" },
        },
      ],
    });
    expect(onDisk()).toMatchObject({ version: 4, target: "project:" });
    expect(store.files()).toContain(PROJECT_COMMENTS_PATH);
    expect(store.list(PROJECT).threads).toEqual([created.value]);
    expect(existsSync(join(project.folder, PROJECT_COMMENTS_PATH))).toBe(true);
  });

  test("the same lifecycle as a document conversation: send, read, answer, resolve; the next thread is a new one", () => {
    const { store } = setup();
    const first = store.create(PROJECT, { anchor: ANCHOR, body: "One" }).value;
    store.submit("project:");
    const fetched = store.fetchForAgent("project:", { asListener: true });
    expect(fetched.threads.map((t) => [t.id, t.status])).toEqual([[first.id, "read"]]);
    store.reply(first.id, "Done.", "agent", 1);
    store.resolve(first.id, "agent", 1);
    const second = store.create(PROJECT, { anchor: ANCHOR, body: "Two" }).value;
    expect(second.id).not.toBe(first.id);
    expect(store.list(PROJECT).threads.map((t) => t.status)).toEqual(["resolved", "draft"]);
  });

  test("only a project anchor fits the project, and a project anchor fits nothing else", () => {
    const { store } = setup();
    refused(() => store.create(PROJECT, { anchor: { kind: "view" }, body: "x" }), "invalid_comment");
    refused(
      () => store.create(PROJECT, { anchor: { kind: "passage", quote: "a", prefix: "", suffix: "" }, body: "x" }),
      "invalid_comment",
    );
    const view: Place = {
      target: "view:flow",
      path: "flow.comments.json",
      subject: { kind: "view", elements: elementsOf({ type: "freeform-graph", nodes: [], edges: [], groups: [] }) },
    };
    const note: Place = {
      target: "note:auth.md",
      path: "auth.comments.json",
      subject: { kind: "note", text: "# Auth\n" },
    };
    refused(() => store.create(view, { anchor: ANCHOR, body: "x" }), "invalid_comment");
    refused(() => store.create(note, { anchor: ANCHOR, body: "x" }), "invalid_comment");
    refused(() => store.create(PROJECT, { anchor: { kind: "project", extra: 1 }, body: "x" }), "invalid_comment");
  });

  test("its file is not shared with a view or note of the same name", () => {
    const { store } = setup();
    store.create(PROJECT, { anchor: ANCHOR, body: "x" });
    const note: Place = {
      target: "note:_project.md",
      path: PROJECT_COMMENTS_PATH,
      subject: { kind: "note", text: "# Mine\n" },
    };
    refused(() => store.list(note), "comments_file_conflict");
  });
});

describe("a person comment's context", () => {
  test("is optional, kept on the root and on replies, and old comments stay valid", () => {
    const { store, onDisk } = setup();
    const plain = store.create(PROJECT, { anchor: ANCHOR, body: "no context" }).value;
    expect(plain.comments[0]).not.toHaveProperty("context");
    expect(onDisk().version).toBe(4); // the project anchor alone needs version 4 (finding 9: 0.6.x reads 3 and refuses it)
    const reply = store.reply(plain.id, "from a diagram", "person", undefined, {
      page: "/projects/demo/diagrams/flow",
    }).value;
    expect(reply.comments[1]).toMatchObject({ author: "person", context: { page: "/projects/demo/diagrams/flow" } });
    expect(reply.comments[1]?.context).not.toHaveProperty("document");
    const old = {
      version: 2,
      target: "note:auth.md",
      threads: [
        {
          id: "t1",
          target: "note:auth.md",
          anchor: { kind: "view" },
          status: "draft",
          revision: 1,
          comments: [{ id: "c1", author: "person", body: "old", createdAt: "2026-10-01T00:00:00Z" }],
        },
      ],
    };
    expect(validateCommentsFile(old)).toMatchObject({ ok: true, file: { version: 2 } });
  });

  test("a file using context is version 4; one without it, on a document, stays version 2 (finding 9)", () => {
    const { store, project } = setup();
    const note: Place = {
      target: "note:auth.md",
      path: "auth.comments.json",
      subject: { kind: "note", text: "# Auth\n" },
    };
    store.create(note, { anchor: { kind: "view" }, body: "plain" });
    expect(JSON.parse(readFileSync(join(project.folder, "auth.comments.json"), "utf8")).version).toBe(2);
    store.create(note, { anchor: { kind: "view" }, body: "from search", context: { page: "/projects/demo/search" } });
    expect(JSON.parse(readFileSync(join(project.folder, "auth.comments.json"), "utf8")).version).toBe(4);
  });

  test("a walkthrough anchor alone keeps version 3, which 0.6.x reads; versions 1 to 5 are all read", () => {
    const { store, project } = setup();
    const view: Place = {
      target: "view:flow",
      path: "flow.comments.json",
      subject: {
        kind: "view",
        elements: elementsOf({ type: "freeform-graph", nodes: [], edges: [], groups: [] }),
        walkthroughs: new Map([["tour", { title: "Tour", steps: new Map([["one", "One"]]) }]]),
      } as never,
    };
    store.create(view, { anchor: { kind: "walkthrough", walkthrough: "tour", label: "Tour" }, body: "on the tour" });
    expect(JSON.parse(readFileSync(join(project.folder, "flow.comments.json"), "utf8")).version).toBe(3);
    const thread = {
      id: "t1",
      target: "project:",
      anchor: { kind: "project" },
      status: "draft",
      revision: 1,
      comments: [{ id: "c1", author: "person", body: "x", createdAt: "2026-10-01T00:00:00Z", context: { page: "/p" } }],
    };
    for (const version of [3, 4])
      expect(validateCommentsFile({ version, target: "project:", threads: [thread] })).toMatchObject({
        ok: true,
        file: { version: 4 },
      });
    expect(validateCommentsFile({ version: 6, target: "project:", threads: [thread] })).toMatchObject({ ok: false });
  });

  test("is bounded and validated like other comment fields", () => {
    const { store } = setup();
    const bad: unknown[] = [
      "page",
      [],
      { page: "" },
      { page: 7 },
      { page: "x".repeat(MAX_CONTEXT_PAGE_CHARS + 1) },
      { page: "/a\u0000b" },
      { page: "/a", document: 3 },
      { page: "/a", document: "x".repeat(MAX_CONTEXT_DOCUMENT_CHARS + 1) },
      { page: "/a", document: "a\nb" },
      { page: "/a", extra: true },
    ];
    for (const context of bad)
      refused(() => store.create(PROJECT, { anchor: ANCHOR, body: "x", context }), "invalid_comment");
    store.create(PROJECT, {
      anchor: ANCHOR,
      body: "fits",
      context: { page: "x".repeat(MAX_CONTEXT_PAGE_CHARS), document: "d".repeat(MAX_CONTEXT_DOCUMENT_CHARS) },
    });
  });

  test("the agent's comments carry none, in a request or in a file", () => {
    const { store, project } = setup();
    refused(
      () => store.createByAgent(PROJECT, { anchor: ANCHOR, body: "x", context: { page: "/a" } }),
      "invalid_comment",
    );
    const t = store.create(PROJECT, { anchor: ANCHOR, body: "q" }).value;
    store.submit("project:");
    store.fetchForAgent("project:", { asListener: true });
    store.reply(t.id, "a", "agent", 1);
    const file = JSON.parse(readFileSync(join(project.folder, PROJECT_COMMENTS_PATH), "utf8"));
    file.threads[0].comments[1].context = { page: "/a" };
    expect(validateCommentsFile(file)).toMatchObject({ ok: false });
  });

  test("a new-thread request parses its context", () => {
    expect(readNewThread({ target: "project:", anchor: ANCHOR, body: "x", context: { page: "/p" } })).toEqual({
      target: "project:",
      anchor: ANCHOR,
      body: "x",
      context: { page: "/p" },
    });
    expect(() => readNewThread({ target: "project:", anchor: ANCHOR, body: "x", context: { page: "" } })).toThrow(
      CommentsError,
    );
  });
});

describe("through the page's routes", () => {
  async function attached() {
    const { svc } = await service({}, { comments: "queued" });
    const c = await connectService(svc.socketPath);
    clients.push(c);
    const root = tempProject();
    write(root, ".archer/auth.md", "# Auth\n\nTokens.\n");
    const page = apiBase((await c.call("attach", { root })).url);
    const origin = `http://127.0.0.1:${svc.port}`;
    // As the page sends them: a create, reply or submit as its operation (ADR 0016).
    const send = pageWrites(page, origin, "project:");
    return { root, page, send };
  }

  test("create, list, reply with context, submit by threadId, pending names the project", async () => {
    const { root, send } = await attached();
    const created = await send("POST", "api/comments", {
      target: "project:",
      anchor: ANCHOR,
      body: "Hello",
      context: { page: "/projects/x/search" },
    });
    expect(created.status, created.body).toBe(200);
    const thread = JSON.parse(created.body) as Thread;
    expect(thread).toMatchObject({
      target: "project:",
      anchor: { kind: "project" },
      comments: [{ context: { page: "/projects/x/search" } }],
    });
    expect(existsSync(join(root, ".archer", PROJECT_COMMENTS_PATH))).toBe(true);

    const listed = JSON.parse((await send("GET", "api/comments?target=project:")).body);
    expect(listed).toMatchObject({ target: "project:", threads: [{ id: thread.id }] });

    // The page names the document relative to the Archer folder; it is kept relative to the project (finding 8).
    const replied = await send("POST", `api/comments/${thread.id}/replies`, {
      body: "More",
      context: { page: "/projects/x/notes/auth.md", document: "notes/auth.md" },
    });
    expect(replied.status, replied.body).toBe(200);
    expect((JSON.parse(replied.body) as Thread).comments[1]).toMatchObject({
      context: { document: ".archer/notes/auth.md" },
    });

    const pending = JSON.parse((await send("GET", "api/comments/pending")).body);
    expect(pending).toMatchObject({ total: 1, targets: [{ target: "project:", drafts: 1 }] });
    expect(pending.targets[0].title).toEqual(expect.any(String));
    // Activity names the project conversation too; the chat's unread dot reads it.
    expect(Object.keys(JSON.parse((await send("GET", "api/comment-activity")).body).targets)).toContain("project:");

    const submitted = await send("POST", "api/comments/submit", { threadId: thread.id });
    expect(JSON.parse(submitted.body)).toMatchObject({ replayed: false, submitted: 1 });

    const bad = await send("POST", "api/comments", { target: "project:", anchor: { kind: "view" }, body: "x" });
    expect(bad.status).toBe(422);
    const noContext = await send("POST", `api/comments/${thread.id}/replies`, { body: "plain" });
    expect(noContext.status).toBe(200);
    const fromNote = await send("POST", "api/comments", {
      target: "note:auth.md",
      anchor: { kind: "view" },
      body: "On the note",
      context: { page: "/projects/x/notes/auth.md", document: "auth.md" },
    });
    expect(fromNote.status, fromNote.body).toBe(200);
    expect((JSON.parse(fromNote.body) as Thread).comments[0]?.context).toEqual({
      page: "/projects/x/notes/auth.md",
      document: ".archer/auth.md",
    });
  });
  test("a document path the page cannot vouch for is dropped, the page kept", async () => {
    const { send } = await attached();
    const made = JSON.parse(
      (await send("POST", "api/comments", { target: "project:", anchor: ANCHOR, body: "Hi" })).body,
    ) as Thread;
    for (const document of ["/etc/passwd", "../outside.md", "notes/../../up.md"]) {
      const replied = await send("POST", `api/comments/${made.id}/replies`, {
        body: "x",
        context: { page: "/p", document },
      });
      expect(replied.status, replied.body).toBe(200);
      expect((JSON.parse(replied.body) as Thread).comments.at(-1)?.context, document).toEqual({ page: "/p" });
    }
  });
  test("a note named _project.md keeps its own comments beside the project conversation (finding 3)", async () => {
    const { root, page, send } = await attached();
    // A note written outside the service is listed once the watcher reports it (inotify reports it before the
    // next request; FSEvents some milliseconds later, and may also replay the project's own creation): each
    // notes event is a reload, so look again on each until the note is in.
    const listed = async () =>
      (JSON.parse((await send("GET", "api/notes/all")).body) as { notes: { path: string }[] }).notes.some(
        (n) => n.path === "_project.md",
      );
    const stream = await events(`${page}api/events`);
    write(root, ".archer/_project.md", "# Mine\n\nA note that happens to be called _project.\n");
    try {
      while (!(await listed())) await stream.next("notes");
    } finally {
      stream.close();
    }
    const note = await send("POST", "api/comments", {
      target: "note:_project.md",
      anchor: { kind: "view" },
      body: "On the note",
    });
    expect(note.status, note.body).toBe(200);
    const project = await send("POST", "api/comments", { target: "project:", anchor: ANCHOR, body: "On the project" });
    expect(project.status, project.body).toBe(200);
    const noteThreads = JSON.parse((await send("GET", "api/comments?target=note:_project.md")).body) as {
      threads: Thread[];
    };
    expect(noteThreads.threads.map((t) => t.comments[0]?.body)).toEqual(["On the note"]);
    const projectThreads = JSON.parse((await send("GET", "api/comments?target=project:")).body) as {
      threads: Thread[];
    };
    expect(projectThreads.threads.map((t) => t.comments[0]?.body)).toEqual(["On the project"]);
    const activity = await send("GET", "api/comment-activity");
    expect(activity.status, activity.body).toBe(200);
    expect(Object.keys(JSON.parse(activity.body).targets)).toEqual(
      expect.arrayContaining(["note:_project.md", "project:"]),
    );
    const pending = JSON.parse((await send("GET", "api/comments/pending")).body) as {
      targets: { target: string; drafts: number }[];
    };
    expect(pending.targets.map((t) => [t.target, t.drafts]).sort()).toEqual([
      ["note:_project.md", 1],
      ["project:", 1],
    ]);
  });
});

describe("through the MCP tools", () => {
  test("the descriptions and schemas name the project target and the project anchor", () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]));
    for (const name of ["create_comment", "get_comments"])
      expect(JSON.stringify(byName.get(name)), name).toContain("project:");
    expect(JSON.stringify(byName.get("create_comment")?.inputSchema)).toContain('"project"');
  });

  test("get_comments hands over a sent project thread with its context; create_comment opens one", async () => {
    const root = tempDir({ ".archer/flow.mmd": FLOW });
    const store = new CommentsStore(findProject(root));
    const made = store.create(PROJECT, {
      anchor: ANCHOR,
      body: "Where do I start?",
      context: { page: "/projects/demo/search" },
    }).value;
    store.submit("project:");
    const { client, close } = await connect({ cwd: root });
    const got = structured(await call(client, "get_comments", { target: "project:" })) as { threads: Thread[] };
    expect(got.threads).toHaveLength(1);
    expect(got.threads[0]).toMatchObject({
      id: made.id,
      target: "project:",
      comments: [{ context: { page: "/projects/demo/search" } }],
    });
    await call(client, "resolve_comment", { threadId: made.id, expectedRevision: 1 });
    const opened = structured(
      await call(client, "create_comment", { target: "project:", anchor: ANCHOR, body: "Heads up." }),
    );
    expect(opened).toMatchObject({ target: "project:", anchor: { kind: "project" }, status: "answered" });
    const bad = await refusal(client, "create_comment", { target: "project:", anchor: { kind: "view" }, body: "x" });
    expect(String(bad.message)).toMatch(/project/);
    await close();
  });
});
