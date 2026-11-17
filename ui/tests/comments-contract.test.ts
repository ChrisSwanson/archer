// The comments contract (`ts/src/comments/contract.ts`, schema version 2 as
// amended by phase 2, the feedback loop), driven by the page's own transport
// against the TypeScript service over HTTP, and against the in-memory store
// the jsdom unit tests stand on (`support/memory-transport.ts` over
// `support/comments-store.ts`).
//
// This is what holds that store to the contract: every behaviour the page
// relies on is stated here once and run against the real service too, so the
// store cannot drift from it unnoticed (docs/agents/tests.md, "A fake must be
// held to the same contract as the real implementation"). What is HTTP's alone
// (the routes, the reader's credential, the address) is marked `httpIt` and
// runs against the service only.
//
// Both speak schema version 2 (the page reads no other). What only version 2
// has (`read`, `resolved`, revisions, `pending`, `dismiss`) is marked `v2it`,
// which would skip, by name, against a server whose contract says otherwise.
import { commentOperation } from "./support/comment-operations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpCommentsTransport, type CommentsTransport } from "../src/comments/transport";
import { memoryTransport } from "./support/memory-transport";
import { commentWrites } from "./support/comment-writes";
import { startTsProject } from "./support/ts-service";
import type { Anchor, Thread } from "../src/comments/contract";
import { COMMENTS_SCHEMA_VERSION as SERVICE_SCHEMA_VERSION } from "../../ts/src/comments/contract";

const NODE: Anchor = { kind: "node", id: "web", label: "Web app" };

/** What the page reaches over HTTP: absent for the in-memory store, which has no routes. */
type Http = {
  /** The agent's link to the page: opening it signs the browser in. */
  readonly url: string;
  /** An API route (`api/…`) fetched as the signed-in browser sends it. */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** An API route fetched by a reader that may not edit sources (the service: an access grant as Bearer). */
  readonly readerFetch: (path: string) => Promise<Response>;
};

/** The implementation under the contract, and the agent's side, as the MCP tools do it. */
type Server = {
  readonly http?: Http;
  /** The transport the page would use; over `http` when not given. */
  readonly transport?: CommentsTransport;
  /** Whether the server speaks schema version 2. */
  readonly v2: boolean;
  /** `get_comments`: hands over sent and read threads; sent become read. */
  readonly agentRead: () => Promise<readonly Thread[]>;
  readonly agentReply: (threadId: string, body: string, expectedRevision?: number) => Promise<void>;
  readonly agentResolve: (threadId: string, expectedRevision: number, note?: string) => Promise<void>;
  readonly stop: () => Promise<void>;
};

/** Two views and a note on the first. */
const VIEW: "view:system" = "view:system";
const OTHER: "view:other" = "view:other";
const NOTE: "note:notes/a.md" = "note:notes/a.md";

function contractSuite(name: string, v2: boolean, http: boolean, start: () => Promise<Server>): void {
  describe(name, () => {
    let server: Server;
    let transport: CommentsTransport;
    let writes: ReturnType<typeof commentWrites>;
    /** Version 2 only: skipped, by name, against a server still at version 1. */
    const v2it = v2 ? it : it.skip;
    /** HTTP's alone (a route, a credential, the address): skipped, by name, against the in-memory store. */
    const httpIt = http ? it : it.skip;
    /** `server.http`, where `httpIt` has said there is one. */
    const web = (): Http => server.http!;

    beforeAll(async () => {
      server = await start();
      transport =
        server.transport ??
        // Same origin as the page, as a browser would send it.
        httpCommentsTransport((url, init) =>
          web().fetch(url, {
            ...init,
            headers: { ...(init?.headers as Record<string, string>), origin: new URL(web().url).origin },
          }),
        );
      writes = commentWrites(transport);
    });

    afterAll(async () => {
      await server.stop();
    });

    const status = async (target: typeof VIEW | typeof OTHER | typeof NOTE, id: string) =>
      (await transport.listThreads(target)).threads.find((t) => t.id === id);

    httpIt("isolated browser fixtures advertise loopback for certificate and secure-context APIs", () => {
      expect(new URL(web().url).hostname).toBe("127.0.0.1");
    });

    httpIt("reader authoring status is a successful read that grants no source editing", async () => {
      // A reader: an access grant presented as Bearer (a non-browser credential never authors, ADR 0028).
      const response = await web().readerFetch("api/authoring");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toEqual({ authorized: false });
    });

    httpIt("note listing counts follow creation, submission and removal", async () => {
      const counts = async () => {
        const response = await web().fetch("api/notes/all");
        expect(response.status).toBe(200);
        const listing = (await response.json()) as { notes: { path: string; threads?: unknown }[] };
        return listing.notes.find((note) => note.path === "notes/a.md")?.threads;
      };
      expect(await counts()).toBeUndefined();
      const thread = await writes.createThread({
        target: NOTE,
        anchor: { kind: "view" },
        body: "Count this note thread.",
      });
      expect(await counts()).toEqual({ draft: 1, sent: 0, read: 0, answered: 0, resolved: 0 });
      await writes.submit(NOTE);
      expect(await counts()).toEqual({ draft: 0, sent: 1, read: 0, answered: 0, resolved: 0 });
      await transport.resolve(thread.id);
      expect(await counts()).toBeUndefined();
    });

    it("starts a thread as a draft the person wrote", async () => {
      const thread = await writes.createThread({ target: VIEW, anchor: NODE, body: "Why two hops?" });
      expect(thread).toMatchObject({ target: VIEW, anchor: NODE, status: "draft" });
      expect(thread.comments).toMatchObject([{ author: "person", body: "Why two hops?" }]);
      const list = await transport.listThreads(VIEW);
      expect(list.threads.map((t) => t.id)).toContain(thread.id);
    });

    it("lets the person edit and delete their own comments at any time", async () => {
      const thread = await writes.createThread({ target: VIEW, anchor: { kind: "view" }, body: "First" });
      const edited = await transport.edit(thread.id, thread.comments[0]!.id, "First, revised");
      expect(edited.comments[0]).toMatchObject({ body: "First, revised" });
      expect(edited.comments[0]!.editedAt).toEqual(expect.any(String));
      expect(edited.status).toBe("draft");
      expect(edited.changedAfterSubmit).toBeUndefined();
      expect(await transport.remove(thread.id, thread.comments[0]!.id)).toEqual({ deleted: true });
      const list = await transport.listThreads(VIEW);
      expect(list.threads.map((t) => t.id)).not.toContain(thread.id);
    });

    v2it("publishes one thread while sibling and other-target drafts stay held", async () => {
      const selected = await writes.createThread({
        target: VIEW,
        anchor: { kind: "view" },
        body: "Publish this draft",
      });
      const sibling = await writes.createThread({ target: VIEW, anchor: { kind: "view" }, body: "Held sibling" });
      const other = await writes.createThread({ target: NOTE, anchor: { kind: "view" }, body: "Held note" });
      expect(await writes.submitThread(selected.id, VIEW)).toEqual({ submitted: 1 });
      expect(await status(VIEW, selected.id)).toMatchObject({ status: "sent", revision: selected.revision });
      expect(await status(VIEW, sibling.id)).toMatchObject({ status: "draft", revision: sibling.revision });
      expect(await status(NOTE, other.id)).toMatchObject({ status: "draft", revision: other.revision });
      expect(await writes.submitThread(selected.id, VIEW)).toEqual({ submitted: 0 });
    });

    v2it(
      "19 (wave 2 review): the project conversation submits by its target, and a reply keeps where it was sent from, project-relative",
      async () => {
        const PROJECT = "project:" as const;
        const thread = await writes.createThread({
          target: PROJECT,
          anchor: { kind: "project" },
          body: "About the whole project",
          context: { page: "/", document: "notes/a.md" },
        });
        expect(await writes.submitThread(thread.id, PROJECT)).toEqual({ submitted: 1 });
        await writes.reply(thread, "And one more thing", { page: "/notes/a", document: "notes/a.md" });
        expect(await writes.submitThread(thread.id, PROJECT)).toEqual({ submitted: 1 });
        const held = (await transport.listThreads(PROJECT)).threads.find((t) => t.id === thread.id)!;
        expect(held.status).toBe("sent");
        expect(held.comments.map((c) => c.context)).toEqual([
          { page: "/", document: ".archer/notes/a.md" },
          { page: "/notes/a", document: ".archer/notes/a.md" },
        ]);
      },
    );

    v2it(
      "scoped publication refuses a mismatched target or an unknown project thread without side effects",
      async () => {
        const thread = await writes.createThread({ target: VIEW, anchor: { kind: "view" }, body: "Held draft" });
        const before = await transport.listThreads(VIEW);
        await expect(writes.submitThread(thread.id, NOTE)).rejects.toMatchObject({ status: 404 });
        await expect(writes.submitThread("not-in-this-project", VIEW)).rejects.toMatchObject({ status: 404 });
        if (http) {
          // The refusal's own words, as the route answers them.
          const refused = await web().fetch("api/comments/submit", {
            method: "POST",
            headers: { origin: new URL(web().url).origin, "content-type": "application/json" },
            body: JSON.stringify(commentOperation.submit({ target: NOTE, threadId: thread.id })),
          });
          expect(refused.status).toBe(404);
          expect(await refused.json()).toMatchObject({ error: { code: "thread_not_found" } });
        }
        expect(await transport.listThreads(VIEW)).toEqual(before);
      },
    );

    it("sends nothing until submitted, then sends every draft in the project", async () => {
      const a = await writes.createThread({ target: OTHER, anchor: { kind: "view" }, body: "a" });
      const b = await writes.createThread({ target: NOTE, anchor: { kind: "view" }, body: "b" });
      expect(a.status).toBe("draft");
      const result = await writes.submit();
      expect(result.submitted).toBeGreaterThanOrEqual(2);
      expect((await status(OTHER, a.id))?.status).toBe("sent");
      expect((await status(NOTE, b.id))?.status).toBe("sent");
      expect((await writes.submit()).submitted).toBe(0);
    });

    it("submits one target's drafts when named", async () => {
      const a = await writes.createThread({ target: VIEW, anchor: { kind: "view" }, body: "a" });
      const b = await writes.createThread({ target: OTHER, anchor: { kind: "view" }, body: "b" });
      expect((await writes.submit(VIEW)).submitted).toBe(1);
      expect((await status(VIEW, a.id))?.status).toBe("sent");
      expect((await status(OTHER, b.id))?.status).toBe("draft");
      await writes.submit();
    });

    it("puts a sent thread the person edits back in the queue as changed", async () => {
      const thread = await writes.createThread({ target: VIEW, anchor: NODE, body: "Original" });
      await writes.submit(VIEW);
      const edited = await transport.edit(thread.id, thread.comments[0]!.id, "Changed my mind");
      expect(edited).toMatchObject({ status: "draft", changedAfterSubmit: true });
      await writes.submit(VIEW);
      const resent = await status(VIEW, thread.id);
      expect(resent?.status).toBe("sent");
      // Still flagged: the agent is told this is a revision of what it had.
      expect(resent?.changedAfterSubmit).toBe(true);
    });

    it("shows the agent's reply in the thread, and a reply from the person reopens it", async () => {
      const thread = await writes.createThread({ target: VIEW, anchor: NODE, body: "Question" });
      await writes.submit(VIEW);
      await server.agentReply(thread.id, "Because of the cache.", (await status(VIEW, thread.id))?.revision);
      const answered = (await status(VIEW, thread.id))!;
      expect(answered.status).toBe("answered");
      expect(answered.comments.at(-1)).toMatchObject({ author: "agent", body: "Because of the cache." });

      const agentComment = answered.comments.at(-1)!;
      await expect(transport.edit(thread.id, agentComment.id, "mine now")).rejects.toThrow();
      await expect(transport.remove(thread.id, agentComment.id)).rejects.toThrow();

      const reopened = await writes.reply(thread, "Which cache?");
      expect(reopened.status).toBe("draft");
      expect(reopened.comments.map((c) => c.author)).toEqual(["person", "agent", "person"]);
    });

    it("refuses to delete a first comment that has replies, and deleting a reply is an edit", async () => {
      const thread = await writes.createThread({ target: VIEW, anchor: NODE, body: "One" });
      const replied = await writes.reply(thread, "Two");
      await expect(transport.remove(thread.id, thread.comments[0]!.id)).rejects.toMatchObject({ status: 409 });
      await writes.submit(VIEW);
      const result = await transport.remove(thread.id, replied.comments[1]!.id);
      expect(result).toMatchObject({ deleted: false, thread: { status: "draft", changedAfterSubmit: true } });
    });

    it("removes a thread the person resolves, at once", async () => {
      const thread = await writes.createThread({ target: VIEW, anchor: NODE, body: "Done?" });
      await transport.resolve(thread.id);
      expect((await transport.listThreads(VIEW)).threads.map((t) => t.id)).not.toContain(thread.id);
    });

    it("refuses an empty comment, one over the limit, and a control character, in its own words", async () => {
      await expect(writes.createThread({ target: VIEW, anchor: NODE, body: " " })).rejects.toThrow(/empty/);
      await expect(writes.createThread({ target: VIEW, anchor: NODE, body: "x".repeat(4001) })).rejects.toThrow(/4000/);
      await expect(writes.createThread({ target: VIEW, anchor: NODE, body: "a\u0007b" })).rejects.toThrow(/control/);
      // Tabs and line breaks are text.
      const kept = await writes.createThread({ target: VIEW, anchor: NODE, body: "a\tb\nc\r\nd" });
      await transport.resolve(kept.id);
    });

    httpIt("lists every note in the project, with the views each is about", async () => {
      const response = await web().fetch("api/notes/all", { cache: "no-store" });
      expect(response.status).toBe(200);
      const listing = (await response.json()) as { notes: unknown[] };
      expect(listing.notes).toEqual([
        expect.objectContaining({
          path: "notes/a.md",
          title: "Auth",
          diagrams: ["system.mmd"],
          viewIds: ["system"],
          // What it is about and its dates (the projects-and-search design).
          description: "Tokens expire after an hour.",
          descriptionFrom: "derived",
          modifiedAt: expect.any(String),
          ...((listing.notes[0] as { createdAt?: string }).createdAt === undefined
            ? {}
            : { createdAt: expect.any(String), createdFrom: expect.stringMatching(/^(filesystem|git)$/) }),
        }),
      ]);
    });

    it("lists a view's notes and reads one", async () => {
      const notes = await transport.listNotes("system");
      expect(notes.notes).toEqual([expect.objectContaining({ path: "notes/a.md", title: "Auth" })]);
      expect((await transport.noteContent("notes/a.md")).markdown).toContain("Tokens **expire** after an hour.");
    });

    it("anchors a passage by text taken from the rendered note", async () => {
      const thread = await writes.createThread({
        target: NOTE,
        anchor: { kind: "passage", quote: "expire", prefix: "Tokens ", suffix: " after an hour." },
        body: "How long exactly?",
      });
      expect(thread.anchor).toMatchObject({ kind: "passage", quote: "expire" });
      await transport.resolve(thread.id);
    });

    // ---- Schema version 2 ----

    v2it("starts a thread at revision 1, and advances it on every change the person makes", async () => {
      const thread = await writes.createThread({ target: VIEW, anchor: NODE, body: "r1" });
      expect(thread.revision).toBe(1);
      const edited = await transport.edit(thread.id, thread.comments[0]!.id, "r2");
      expect(edited.revision).toBeGreaterThan(thread.revision);
      const replied = await writes.reply(thread, "r3");
      expect(replied.revision).toBeGreaterThan(edited.revision);
      const removed = await transport.remove(thread.id, replied.comments[1]!.id);
      expect(removed.deleted === false && removed.thread.revision).toBeGreaterThan(replied.revision);
      await transport.resolve(thread.id);
    });

    v2it("counts every draft in the project, by target, and sends them all in one action", async () => {
      await writes.submit();
      expect(await transport.pending()).toEqual({ total: 0, targets: [] });
      await writes.createThread({ target: VIEW, anchor: NODE, body: "one" });
      await writes.createThread({ target: VIEW, anchor: { kind: "view" }, body: "two" });
      await writes.createThread({ target: OTHER, anchor: { kind: "view" }, body: "three" });
      await writes.createThread({ target: NOTE, anchor: { kind: "view" }, body: "four" });
      const pending = await transport.pending();
      expect(pending.total).toBe(4);
      expect(pending.targets).toEqual(
        expect.arrayContaining([
          { target: VIEW, title: "The system", drafts: 2 },
          { target: OTHER, title: "Other", drafts: 1 },
          { target: NOTE, title: "Auth", drafts: 1 },
        ]),
      );
      expect(pending.targets).toHaveLength(3);
      expect((await writes.submit()).submitted).toBe(4);
      expect(await transport.pending()).toEqual({ total: 0, targets: [] });
    });

    v2it("moves sent to read when the agent fetches, and to answered when it replies", async () => {
      await writes.submit();
      const thread = await writes.createThread({ target: VIEW, anchor: NODE, body: "Picked up?" });
      await writes.submit();
      expect((await status(VIEW, thread.id))?.status).toBe("sent");
      const handed = await server.agentRead();
      expect(handed.find((t) => t.id === thread.id)).toMatchObject({ status: "read", revision: thread.revision });
      expect((await status(VIEW, thread.id))?.status).toBe("read");
      // Still unanswered, so still handed over on the next fetch.
      expect((await server.agentRead()).map((t) => t.id)).toContain(thread.id);
      await server.agentReply(thread.id, "Yes.", thread.revision);
      expect((await status(VIEW, thread.id))?.status).toBe("answered");
      expect((await server.agentRead()).map((t) => t.id)).not.toContain(thread.id);
      await transport.resolve(thread.id);
    });

    v2it("refuses the agent's reply when the person changed the thread since it read it", async () => {
      const thread = await writes.createThread({ target: VIEW, anchor: NODE, body: "Before" });
      await writes.submit();
      const [read] = (await server.agentRead()).filter((t) => t.id === thread.id);
      const edited = await transport.edit(thread.id, thread.comments[0]!.id, "After");
      expect(edited).toMatchObject({ status: "draft", changedAfterSubmit: true });
      await expect(server.agentReply(thread.id, "To the old text", read!.revision)).rejects.toThrow(
        /changed|draft|submit/i,
      );
      await transport.resolve(thread.id);
    });

    v2it("keeps a thread the agent resolves until the person dismisses it", async () => {
      const thread = await writes.createThread({ target: VIEW, anchor: NODE, body: "Fixed yet?" });
      await writes.submit();
      await server.agentRead();
      await server.agentReply(thread.id, "Fixed in the diagram.", thread.revision);
      await server.agentResolve(thread.id, thread.revision);
      const resolved = await status(VIEW, thread.id);
      expect(resolved?.status).toBe("resolved");
      expect(resolved?.comments.at(-1)).toMatchObject({ author: "agent", body: "Fixed in the diagram." });
      await transport.dismiss(thread.id);
      expect(await status(VIEW, thread.id)).toBeUndefined();
    });

    v2it("refuses to dismiss a thread the agent has not resolved", async () => {
      const thread = await writes.createThread({ target: VIEW, anchor: NODE, body: "Not done" });
      await expect(transport.dismiss(thread.id)).rejects.toMatchObject({ status: 409 });
      await transport.resolve(thread.id);
    });
  });
}

const FLOW = "flowchart LR\n  web[Web app] e1@-->|HTTPS| api[API]\n  api e2@--> db[(Database)]\n";
const NOTE_MD = "---\ndiagrams: [system.mmd]\n---\n# Auth\n\nTokens **expire** after an hour.\n";

const FILES: Record<string, string> = {
  "archer.toml":
    'version = 1\n\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "The system"\nsource = ".archer/system.mmd"\n\n' +
    '[[views]]\nid = "other"\nkind = "freeform"\ntitle = "Other"\nsource = ".archer/other.mmd"\n',
  ".archer/system.mmd": FLOW,
  ".archer/other.mmd": FLOW,
  ".archer/notes/a.md": NOTE_MD.replace("system.mmd", "../system.mmd"),
};

const serviceV2 = (SERVICE_SCHEMA_VERSION as number) >= 2;
if (!serviceV2) {
  console.info("[comments-contract] the service's contract is still schema version 1: its version-2 tests are skipped");
}

contractSuite("the TypeScript service", serviceV2, true, async () => {
  const project = await startTsProject({ files: FILES, commentSubmission: "queued" });
  return {
    http: {
      url: project.url,
      fetch: (path, init) => project.fetch(path, init),
      readerFetch: async (path) =>
        fetch(project.api(path), {
          headers: { authorization: `Bearer ${(await project.issueAccess("contract reader")).token}` },
        }),
    },
    v2: serviceV2,
    agentRead: async () => (await project.agentInbox()) as Thread[],
    agentReply: (id, body, revision) => project.agentReply(id, body, revision),
    agentResolve: (id, revision, note) => project.agentResolve(id, revision, note),
    stop: () => project.stop(),
  };
});

contractSuite("the in-memory store (memory-transport.ts)", true, false, async () => {
  const transport = memoryTransport([
    { path: "notes/a.md", title: "Auth", markdown: "# Auth\n\nTokens **expire** after an hour.\n", views: ["system"] },
  ]);
  const titles: Record<string, string> = { system: "The system", other: "Other" };
  transport.store.viewTitle = (viewId) => titles[viewId] ?? viewId;
  return {
    transport,
    v2: true,
    agentRead: async () => transport.store.agentRead(),
    agentReply: async (id, body, revision) => void transport.store.agentReply(id, body, revision),
    agentResolve: async (id, revision, note) => void transport.store.agentResolve(id, revision, note),
    stop: async () => {},
  };
});

describe("the service's event stream", () => {
  it("announces each change, the agent's included", async () => {
    const project = await startTsProject({ files: FILES, commentSubmission: "queued" });
    try {
      const transport = httpCommentsTransport((url, init) => project.fetch(url, init));
      const writes = commentWrites(transport);
      const controller = new AbortController();
      const stream = await project.fetch("api/events", { signal: controller.signal });
      const reader = stream.body!.getReader();
      // The next `comments` frame's data; every other event the service sends (its standing, the inventory
      // each change also sends with its thread counts, heartbeats) is passed over.
      let buffered = "";
      const nextComments = async (): Promise<unknown> => {
        for (;;) {
          const end = buffered.indexOf("\n\n");
          if (end >= 0) {
            const frame = buffered.slice(0, end + 2);
            buffered = buffered.slice(end + 2);
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (/^event: comments$/m.test(frame) && data !== undefined) return JSON.parse(data) as unknown;
            continue;
          }
          buffered += new TextDecoder().decode((await reader.read()).value);
        }
      };
      const announced = { target: "view:system" };
      const thread = await writes.createThread({ target: VIEW, anchor: { kind: "view" }, body: "x" });
      expect(await nextComments()).toMatchObject(announced);
      await writes.submit();
      expect(await nextComments()).toMatchObject(announced);
      // Status changes the agent causes are announced too.
      await project.agentInbox();
      expect(await nextComments()).toMatchObject(announced);
      await project.agentResolve(thread.id, thread.revision);
      expect(await nextComments()).toMatchObject(announced);
      controller.abort();
      await expect(transport.noteContent("nope.md")).rejects.toThrow(/no note/);
    } finally {
      await project.stop();
    }
  });
});
