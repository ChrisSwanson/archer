import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CommentsStore } from "../../src/comments/store.ts";
import type { Thread } from "../../src/comments/contract.ts";
import { findProject } from "../../src/project/index.ts";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import {
  cleanUp,
  events,
  FLOW2,
  http,
  json,
  project,
  service,
  write,
  type Reply,
  apiBase,
  pageHttp,
} from "./support.ts";

const clients: ServiceClient[] = [];

// Every directory listing in this process, by path. A count is of one project's folder only: the
// service also lists other directories, and an earlier project's background read-warming (its
// READ_WARM_DELAY_MS timer, late on a loaded event loop) can list that project's folder meanwhile.
const directoryScans = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const counted = ((...args: unknown[]) => {
    directoryScans.paths.push(String(args[0]));
    return Reflect.apply(actual.readdirSync, actual, args);
  }) as typeof actual.readdirSync;
  return { ...actual, readdirSync: counted };
});
const scansOf = (root: string): number =>
  directoryScans.paths.filter((path) => path === root || path.startsWith(`${root}/`)).length;

afterEach(async () => {
  // A failed assertion must not leave a clock spy for the next test to wrap.
  vi.restoreAllMocks();
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

async function attached(files: Readonly<Record<string, string>> = {}) {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const root = project();
  write(root, ".archer/auth.md", "# Auth flow\n\nHow authentication works.\n");
  for (const [path, contents] of Object.entries(files)) write(root, path, contents);
  const { url } = await client.call("attach", { root });
  const origin = `http://127.0.0.1:${svc.port}`;
  // As the page sends them (ui/src/comments/transport.ts): every write is JSON, a body-less one `{}`, with its length.
  const send = (method: string, path: string, given?: unknown): Promise<Reply> => {
    const text = given === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(given);
    return pageHttp(`${apiBase(url)}${path}`, {
      method,
      headers: {
        origin,
        ...(text === undefined
          ? {}
          : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }),
      },
      ...(text === undefined ? {} : { body: text }),
    });
  };
  const ok = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const reply = await send(method, path, body);
    if (reply.status !== 200) throw new Error(`${method} ${path}: ${reply.status} ${reply.body}`);
    return JSON.parse(reply.body) as unknown;
  };
  return { svc, root, url, send, ok };
}

type ActivityPayload = {
  schemaVersion: 1;
  agentCommentsListed: true;
  targets: Record<
    string,
    {
      totalThreads: number;
      unresolvedThreads: number;
      lastCommentedAt: string | null;
      agentComments?: { thread: string; comment: string }[];
    }
  >;
};

test("comment activity lists every registered view and note, including targets with no threads", async () => {
  const { url } = await attached({
    ".archer/auth.md": "# Auth flow\n\n```mermaid\n%% archer-id: login\nflowchart LR\n  user[User]\n```\n",
  });

  expect(await json(`${apiBase(url)}api/comment-activity`)).toEqual({
    schemaVersion: 1,
    agentCommentsListed: true,
    targets: {
      "view:chat": { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null },
      "view:flow": { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null },
      "view:auth.md#login": { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null },
      "note:auth.md": { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null },
      "project:": { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null },
    },
  });
});

test("comment activity scans the note inventory once, independent of its target count", async () => {
  // Past READ_MEMO_MS the state's memoized reads are made again in the background, so each count is of one
  // fresh scan: the read that expires them, then the background one it starts.
  const realNow = performance.now.bind(performance);
  let skew = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + skew);
  try {
    // The background reads take a few turns of the event loop each.
    const revalidated = (): Promise<void> => new Promise((done) => setTimeout(done, 100));
    const fresh = (): void => {
      skew += 60_000;
      directoryScans.paths = [];
    };
    const one = await attached();
    fresh();
    await json(`${apiBase(one.url)}api/comment-activity`);
    await revalidated();
    const oneTargetSet = scansOf(one.root);

    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`.archer/n-${index}.md`, `# Note ${index}\n`]),
    );
    const many = await attached(files);
    fresh();
    await json(`${apiBase(many.url)}api/comment-activity`);
    await revalidated();
    expect(scansOf(many.root)).toBe(oneTargetSet);
    expect(scansOf(many.root)).toBeGreaterThan(0);
    // Read again before anything changed: the memoized scan answers.
    directoryScans.paths = [];
    await json(`${apiBase(many.url)}api/comment-activity`);
    expect(scansOf(many.root)).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

test("comment activity rejects an embedded path collision for the whole response", async () => {
  const { url, send } = await attached({
    "archer.toml": [
      "version = 1",
      "[[views]]",
      'id = "legacy"',
      'kind = "freeform"',
      'title = "Legacy"',
      'source = ".archer/auth.login.mmd"',
      "",
    ].join("\n"),
    ".archer/auth.md": "# Auth\n\n```mermaid\n%% archer-id: login\nflowchart LR\n  user[User]\n```\n",
    ".archer/auth.login.mmd": "flowchart LR\n  legacy[Legacy]\n",
  });

  const reply = await send("GET", "api/comment-activity");
  expect(reply.status).toBe(409);
  expect(JSON.parse(reply.body)).toMatchObject({ error: { code: "comments_file_conflict" } });
});

test("comment activity ignores a valid comments file whose target is no longer current", async () => {
  const orphan = {
    version: 2,
    target: "view:gone",
    threads: [
      {
        id: "t-gone",
        target: "view:gone",
        anchor: { kind: "view" },
        status: "sent",
        revision: 1,
        comments: [{ id: "c-gone", author: "person", body: "Old", createdAt: "2026-01-01T00:00:00.000Z" }],
      },
    ],
  };
  const { url } = await attached({ ".archer/orphan.comments.json": JSON.stringify(orphan) });

  const payload = (await json(`${apiBase(url)}api/comment-activity`)) as ActivityPayload;
  expect(payload.targets["view:gone"]).toBeUndefined();
  expect(Object.keys(payload.targets).sort()).toEqual(["note:auth.md", "project:", "view:chat", "view:flow"]);
});

test("comment activity follows create, reply, resolve and delete through the production store", async () => {
  const { root, url, ok } = await attached();
  const activity = async () =>
    ((await json(`${apiBase(url)}api/comment-activity`)) as ActivityPayload).targets["view:flow"];

  const first = (await ok("POST", "api/comments", {
    target: "view:flow",
    anchor: { kind: "view" },
    body: "First question",
  })) as Thread;
  expect(await activity()).toEqual({
    totalThreads: 1,
    unresolvedThreads: 1,
    lastCommentedAt: first.comments[0]?.createdAt,
  });

  const replied = (await ok("POST", `api/comments/${first.id}/replies`, { body: "More detail" })) as Thread;
  const personReplyAt = replied.comments[1]?.createdAt ?? "";
  expect(await activity()).toMatchObject({ totalThreads: 1, unresolvedThreads: 1, lastCommentedAt: personReplyAt });

  await ok("PATCH", `api/comments/${first.id}/${first.comments[0]?.id ?? ""}`, { body: "Edited question" });
  expect(await activity()).toMatchObject({ lastCommentedAt: personReplyAt });

  await ok("POST", "api/comments/submit", { target: "view:flow", threadId: first.id });
  // The agent writes through its own store, outside the service: the page reads the change once the watcher has
  // reported it, which the stream's comments event says (inotify reports it before the next request; FSEvents
  // some milliseconds later).
  const stream = await events(`${apiBase(url)}api/events`);
  const store = new CommentsStore(findProject(root));
  const read = store.fetchForAgent("view:flow", { asListener: true }).threads[0];
  const answered = store.reply(first.id, "Agent answer", "agent", read?.revision ?? 0).value;
  const agentReplyAt = answered.comments.at(-1)?.createdAt ?? "";
  // The agent's answer is named, so the bell counts it without reading the thread (PF-2).
  const agentComments = [{ thread: first.id, comment: answered.comments.at(-1)?.id ?? "" }];
  store.resolve(first.id, "agent", answered.revision);
  try {
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
  } finally {
    stream.close();
  }
  expect(await activity()).toEqual({
    totalThreads: 1,
    unresolvedThreads: 0,
    lastCommentedAt: agentReplyAt,
    agentComments,
  });
  write(root, ".archer/flow.mmd", FLOW2);
  expect(await activity()).toEqual({
    totalThreads: 1,
    unresolvedThreads: 0,
    lastCommentedAt: agentReplyAt,
    agentComments,
  });

  const deleted = (await ok("POST", "api/comments", {
    target: "view:flow",
    anchor: { kind: "view" },
    body: "Delete this thread",
  })) as Thread;
  expect(await activity()).toMatchObject({
    totalThreads: 2,
    unresolvedThreads: 1,
    lastCommentedAt: deleted.comments[0]?.createdAt,
  });
  await ok("DELETE", `api/comments/${deleted.id}/${deleted.comments[0]?.id ?? ""}`);
  expect(await activity()).toEqual({
    totalThreads: 1,
    unresolvedThreads: 0,
    lastCommentedAt: agentReplyAt,
    agentComments,
  });

  const resolvedByPerson = (await ok("POST", "api/comments", {
    target: "view:flow",
    anchor: { kind: "view" },
    body: "Resolve this thread",
  })) as Thread;
  await ok("POST", `api/comments/${resolvedByPerson.id}/resolve`);
  expect(await activity()).toEqual({
    totalThreads: 1,
    unresolvedThreads: 0,
    lastCommentedAt: agentReplyAt,
    agentComments,
  });
});

test("comment activity keeps the route read-only and reports an unreadable target without inventing zeroes", async () => {
  const { svc, root, url, send } = await attached();
  expect((await send("POST", "api/comment-activity", {})).status).toBe(404);
  expect((await send("GET", "api/comment-activity/extra")).status).toBe(404);
  const wrong = url.replace(svc.token, "0".repeat(svc.token.length));
  expect((await pageHttp(`${wrong}api/comment-activity`)).status).toBe(404);

  // An edit made outside the service is read once the watcher reports it (inotify reports it before the
  // next request; FSEvents some milliseconds later): the stream's comments event says it has.
  const stream = await events(`${apiBase(url)}api/events`);
  writeFileSync(join(root, ".archer/flow.comments.json"), "{ broken");
  try {
    expect(await stream.next("comments")).toEqual({ target: "view:flow" });
  } finally {
    stream.close();
  }
  const malformed = await send("GET", "api/comment-activity");
  expect(malformed.status).toBe(409);
  expect(JSON.parse(malformed.body)).toMatchObject({ error: { code: "malformed_comments_file" } });
});

test("the inventory lists the notes once, independent of its view count", async () => {
  const realNow = performance.now.bind(performance);
  let skew = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + skew);
  try {
    const count = async ({ url, root }: { url: string; root: string }): Promise<number> => {
      skew += 60_000;
      directoryScans.paths = [];
      await json(`${apiBase(url)}api/diagrams`);
      // Expired reads are made again in the background, a few turns later.
      await new Promise((done) => setTimeout(done, 100));
      return scansOf(root);
    };
    const few = await attached();
    const views = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`.archer/v-${index}.mmd`, FLOW2]));
    const many = await attached(views);
    expect(await count(many)).toBe(await count(few));
  } finally {
    clock.mockRestore();
  }
});

test("a reload drops the memoized reads: a note the watcher has not reported yet appears once the state reloads", async () => {
  const { root, url, ok } = await attached();
  const paths = async (): Promise<string[]> =>
    ((await ok("GET", "api/notes/all")) as { notes: { path: string }[] }).notes.map((note) => note.path);
  expect(await paths()).toEqual(["auth.md"]);
  write(root, ".archer/later.md", "# Later\n");
  await clients[clients.length - 1]!.call("getContext", { root });
  expect((await paths()).sort()).toEqual(["auth.md", "later.md"]);
  expect(url).toContain("/projects/");
});
