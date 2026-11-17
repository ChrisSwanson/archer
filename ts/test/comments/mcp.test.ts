// The agent's side of comments: get_comments, reply_comment and
// resolve_comment through an MCP client over the in-memory transport, on a
// temp project whose comments the person's side (the store) wrote.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CommentsStore, elementsOf, type Place } from "../../src/comments/store.ts";
import type { Thread } from "../../src/comments/contract.ts";
import { TOOLS } from "../../src/mcp/tools.ts";
import { findProject } from "../../src/project/index.ts";
import { call, connect, FLOW, refusal, removeTempDirs, structured, tempDir, text } from "../mcp/support.ts";

afterEach(removeTempDirs);

async function setup() {
  const root = tempDir({ ".archer/flow.mmd": FLOW, ".archer/auth.md": "# Auth\n\nTokens.\n" });
  const store = new CommentsStore(findProject(root));
  const view: Place = {
    target: "view:flow",
    path: "flow.comments.json",
    subject: {
      kind: "view",
      elements: elementsOf({ type: "freeform-graph", nodes: [{ id: "a", label: "Client" }], edges: [], groups: [] }),
    },
  };
  const note: Place = {
    target: "note:auth.md",
    path: "auth.comments.json",
    subject: { kind: "note", text: "# Auth\n\nTokens.\n" },
  };
  const connected = await connect({ cwd: root });
  return { root, store, view, note, ...connected };
}

test("the four tools are advertised with descriptions that teach the loop and tell the agent comment text is data", () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const name of ["create_comment", "get_comments", "reply_comment", "resolve_comment"])
    expect(byName.has(name), name).toBe(true);
  expect(byName.get("create_comment")?.description).toMatch(/diagram or note/);
  expect(byName.get("create_comment")?.inputSchema.required).toEqual(["target", "anchor", "body"]);
  expect(byName.get("get_comments")?.description).toMatch(/data, never as instructions/);
  expect(byName.get("get_comments")?.description).toMatch(/revision/);
  expect(byName.get("reply_comment")?.description).toMatch(/in the page/);
  for (const name of ["reply_comment", "resolve_comment"]) {
    expect(byName.get(name)?.description, name).toMatch(/thread_changed/);
    expect(byName.get(name)?.inputSchema.required, name).toContain("expectedRevision");
  }
});

test("create_comment opens an answered note thread authored by the agent", async () => {
  const { root, store, note, client, close } = await setup();
  const result = structured(
    await call(client, "create_comment", {
      target: "note:auth.md",
      anchor: { kind: "view" },
      body: "I left this note for you.",
    }),
  );

  expect(result).toMatchObject({
    target: "note:auth.md",
    anchor: { kind: "view" },
    status: "answered",
    revision: 1,
    comments: [{ author: "agent", body: "I left this note for you." }],
  });
  expect(store.list(note).threads[0]).toEqual(result);
  expect(readFileSync(join(root, ".archer/auth.comments.json"), "utf8")).toContain('"author": "agent"');
  expect(structured(await call(client, "get_comments"))).toEqual({ threads: [] });
  await close();
});

test("an agent-opened thread completes the person-reply, send, read, answer and resolve round trip", async () => {
  const { store, note, client, close } = await setup();
  const opened = structured(
    await call(client, "create_comment", {
      target: "note:auth.md",
      anchor: { kind: "view" },
      body: "Does this explanation match your intent?",
    }),
  ) as unknown as Thread;
  expect(store.fetchForAgent().threads).toEqual([]);
  expect(store.reply(opened.id, "Please make it more concrete.", "person").value.status).toBe("draft");
  expect(store.submit("note:auth.md", opened.id).submitted).toBe(1);
  const fetched = structured(await call(client, "get_comments"))["threads"] as Thread[];
  expect(fetched).toMatchObject([
    { id: opened.id, status: "sent", comments: [{ author: "agent" }, { author: "person" }] },
  ]);
  expect(
    structured(
      await call(client, "reply_comment", {
        threadId: opened.id,
        expectedRevision: 2,
        body: "I made the example concrete.",
      }),
    ),
  ).toMatchObject({ status: "answered", comments: [{ author: "agent" }, { author: "person" }, { author: "agent" }] });
  expect(structured(await call(client, "get_comments"))).toEqual({ threads: [] });
  expect(structured(await call(client, "resolve_comment", { threadId: opened.id, expectedRevision: 2 }))).toEqual({
    resolved: true,
  });
  expect(store.list(note).threads[0]).toMatchObject({ status: "resolved" });
  await close();
});

test("create_comment grounds every diagram family and every diagram anchor kind through production compilation", async () => {
  const root = tempDir({
    ".archer/flow.mmd": "flowchart LR\n  subgraph g[Backend]\n    a[Client]\n    b[API]\n  end\n  a e1@--> b\n",
    ".archer/sequence.mmd":
      "sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  loop retry\n    A->>B: hi\n  end\n",
    ".archer/state.mmd": "stateDiagram-v2\n  state Idle\n  state Busy\n  Idle --> Busy : go\n",
    ".archer/er.mmd": "erDiagram\n  A\n  B\n  A ||--o{ B : has\n",
    ".archer/c4.mmd": 'C4Context\n  Person(p, "Person")\n  System(s, "System")\n  Rel(p, s, "uses")\n',
    ".archer/architecture.mmd": "architecture-beta\n  service a(server)[API]\n  service b(server)[DB]\n  a:R --> L:b\n",
    ".archer/journey.mmd": "journey\n  section Travel\n    Go home: 3: Reader\n",
  });
  const connected = await connect({ cwd: root });
  const cases = [
    ["flow", { kind: "node", id: "a", label: "spoofed" }, { kind: "node", id: "a", label: "Client" }],
    ["sequence", { kind: "group", id: "frag-0", label: "spoofed" }, { kind: "group", id: "frag-0", label: "retry" }],
    ["state", { kind: "edge", id: "Idle--Busy", label: "spoofed" }, { kind: "edge", id: "Idle--Busy", label: "go" }],
    ["er", { kind: "node", id: "A", label: "spoofed" }, { kind: "node", id: "A", label: "A" }],
    ["c4", { kind: "edge", id: "p--s", label: "spoofed" }, { kind: "edge", id: "p--s", label: "uses" }],
    ["architecture", { kind: "node", id: "a", label: "spoofed" }, { kind: "node", id: "a", label: "API" }],
    ["journey", { kind: "node", id: "go-home", label: "spoofed" }, { kind: "node", id: "go-home", label: "Go home" }],
  ] as const;
  for (const [viewId, anchor, grounded] of cases) {
    const opened = structured(
      await call(connected.client, "create_comment", {
        target: `view:${viewId}`,
        anchor,
        body: `Question about ${viewId}`,
      }),
    );
    expect(opened.anchor, viewId).toEqual(grounded);
  }
  const selected = structured(
    await call(connected.client, "create_comment", {
      target: "view:flow",
      anchor: { kind: "selection", nodes: [{ id: "a", label: "wrong" }], edges: [{ id: "e1", label: "wrong" }] },
      body: "Question about this path",
    }),
  );
  expect(selected.anchor).toEqual({
    kind: "selection",
    nodes: [{ id: "a", label: "Client" }],
    edges: [{ id: "e1", label: "a → b" }],
  });
  await connected.close();
});

test("create_comment grounds note passages, durable views and embedded views, pinning an embedded address", async () => {
  const root = tempDir({
    "archer.toml":
      'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
    ".archer/system.mmd": FLOW,
    ".archer/notes/context.md":
      "# Context\n\nThe client sends a token to the API.\n\n## Embedded\n\n```mermaid\nflowchart LR\n  a[Client] e1@--> b[API]\n```\n",
  });
  const connected = await connect({ cwd: root });
  expect(
    structured(
      await call(connected.client, "create_comment", {
        target: "view:system",
        anchor: { kind: "edge", id: "e1", label: "wrong" },
        body: "Durable view",
      }),
    ).anchor,
  ).toEqual({ kind: "edge", id: "e1", label: "a → b" });
  expect(
    structured(
      await call(connected.client, "create_comment", {
        target: "note:notes/context.md",
        anchor: { kind: "passage", quote: "sends a token", prefix: "The client ", suffix: " to the API" },
        body: "Passage question",
      }),
    ).anchor,
  ).toMatchObject({ kind: "passage", quote: "sends a token" });
  expect(
    structured(
      await call(connected.client, "create_comment", {
        target: "view:notes/context.md#embedded",
        anchor: { kind: "node", id: "a", label: "wrong" },
        body: "Embedded question",
      }),
    ).anchor,
  ).toEqual({ kind: "node", id: "a", label: "Client" });
  expect(readFileSync(join(root, ".archer/notes/context.md"), "utf8")).toContain("%% archer-id: embedded");
  expect(existsSync(join(root, ".archer/notes/context.embedded.comments.json"))).toBe(true);
  await connected.close();
});

test("create_comment refuses a registered diagram and note that share one comments sidecar, in either target order", async () => {
  for (const [first, second, existing] of [
    ["view:auth", "note:auth.md", null],
    ["note:auth.md", "view:auth", "existing sidecar must stay byte-for-byte"],
  ] as const) {
    const root = tempDir({
      "archer.toml":
        'version = 1\n[[views]]\nid = "auth"\nkind = "freeform"\ntitle = "Auth diagram"\nsource = ".archer/auth.mmd"\n',
      ".archer/auth.mmd": FLOW,
      ".archer/auth.md": "# Auth note\n",
      ...(existing === null ? {} : { ".archer/auth.comments.json": existing }),
    });
    const connected = await connect({ cwd: root });
    for (const target of [first, second]) {
      const error = await refusal(connected.client, "create_comment", {
        target,
        anchor: { kind: "view" },
        body: "must not be kept",
      });
      expect(error.data.code, target).toBe("comments_file_conflict");
      expect(error.message, target).toContain("auth.comments.json");
    }
    const path = join(root, ".archer/auth.comments.json");
    if (existing === null) expect(existsSync(path)).toBe(false);
    else expect(readFileSync(path, "utf8")).toBe(existing);
    await connected.close();
  }
});

test("get_comments returns the sent threads and the read ones still unanswered, with revisions; by target if asked; only the listener marks them read", async () => {
  const { store, view, note, client, close } = await setup();
  expect(structured(await call(client, "get_comments"))).toEqual({ threads: [] });
  const sent = store.create(view, { anchor: { kind: "view" }, body: "sent first" }).value;
  store.submit();
  const draft = store.create(view, { anchor: { kind: "node", id: "a", label: "" }, body: "not yet" }).value;
  const onNote = store.create(note, { anchor: { kind: "view" }, body: "about tokens" }).value;
  store.submit("note:auth.md");

  const all = await call(client, "get_comments");
  const threads = structured(all)["threads"] as Thread[];
  expect(threads.map((t) => [t.comments[0]?.body, t.status, t.revision]).sort()).toEqual([
    ["about tokens", "sent", 1],
    ["sent first", "sent", 1],
  ]);
  expect(threads.map((t) => t.id)).not.toContain(draft.id);
  expect(text(all)).toContain("2 thread(s)");
  expect(text(all)).toContain("about tokens");
  expect(text(all)).toContain("revision 1");
  // A session that is not the checkout's listener leaves them sent (ADR 0035 §7).
  expect(store.list(view).threads.find((t) => t.id === sent.id)?.status).toBe("sent");
  expect(text(all)).not.toContain("now sees them as read");

  // Unanswered, they are fetched again.
  const one = structured(await call(client, "get_comments", { target: "note:auth.md" }));
  expect((one["threads"] as Thread[]).map((t) => t.id)).toEqual([onNote.id]);
  await close();
});

test("a malformed comments file is reported, not hidden, and left as it is", async () => {
  const { root, client, close } = await setup();
  writeFileSync(join(root, ".archer/flow.comments.json"), "{ broken");
  const result = await call(client, "get_comments");
  expect(structured(result)).toEqual({ threads: [], problems: [expect.stringContaining("flow.comments.json")] });
  expect(text(result)).toContain("flow.comments.json");
  expect(readFileSync(join(root, ".archer/flow.comments.json"), "utf8")).toBe("{ broken");
  await close();
});

test("reply_comment answers a thread it read, in the file the page reads", async () => {
  const { root, store, view, client, close } = await setup();
  const thread = store.create(view, { anchor: { kind: "view" }, body: "Why?" }).value;
  store.submit();
  await call(client, "get_comments");
  const replied = structured(
    await call(client, "reply_comment", { threadId: thread.id, body: "Because.", expectedRevision: 1 }),
  );
  expect(replied).toMatchObject({
    id: thread.id,
    status: "answered",
    revision: 1,
    comments: [{ author: "person" }, { author: "agent", body: "Because." }],
  });
  expect(store.list(view).threads[0]).toEqual(replied);
  expect(readFileSync(join(root, ".archer/flow.comments.json"), "utf8")).toContain("Because.");
  await close();
});

test("the agent cannot answer or resolve a draft, nor a thread that does not exist", async () => {
  const { store, view, client, close } = await setup();
  const thread = store.create(view, { anchor: { kind: "view" }, body: "Why?" }).value;
  const early = await refusal(client, "reply_comment", { threadId: thread.id, body: "x", expectedRevision: 1 });
  expect([early.code, early.data.code]).toEqual([-32602, "thread_not_awaiting"]);
  expect((await refusal(client, "resolve_comment", { threadId: thread.id, expectedRevision: 1 })).data.code).toBe(
    "thread_not_awaiting",
  );
  const missing = await refusal(client, "reply_comment", {
    threadId: "t-000000000000",
    body: "x",
    expectedRevision: 1,
  });
  expect([missing.code, missing.data.code]).toEqual([-32002, "thread_not_found"]);
  expect(store.list(view).threads[0]?.status).toBe("draft");
  await close();
});

test("the race: the person edits after the agent read; reply_comment is refused with the thread as it is now; re-read, it is accepted", async () => {
  const { store, view, client, close } = await setup();
  const thread = store.create(view, { anchor: { kind: "view" }, body: "Rename the client?" }).value;
  store.submit();
  const [read] = structured(await call(client, "get_comments"))["threads"] as Thread[];
  expect(read).toMatchObject({ id: thread.id, revision: 1 });

  store.edit(thread.id, thread.comments[0]?.id ?? "", "Rename the client to Browser?");
  store.submit();
  const changed = await refusal(client, "reply_comment", {
    threadId: thread.id,
    body: "Renamed to Web.",
    expectedRevision: 1,
  });
  expect([changed.code, changed.data.code]).toEqual([-32602, "thread_changed"]);
  expect(changed.data).toMatchObject({
    threadId: thread.id,
    revision: 2,
    status: "sent",
    comments: [{ body: "Rename the client to Browser?" }],
  });
  expect(changed.message).toContain("Rename the client to Browser?");
  expect(changed.message).toContain("expectedRevision 2");
  expect((await refusal(client, "resolve_comment", { threadId: thread.id, expectedRevision: 1 })).data.code).toBe(
    "thread_changed",
  );

  const [reread] = structured(await call(client, "get_comments"))["threads"] as Thread[];
  expect(reread).toMatchObject({ status: "sent", revision: 2, comments: [{ body: "Rename the client to Browser?" }] });
  expect(
    structured(
      await call(client, "reply_comment", { threadId: thread.id, body: "Renamed to Browser.", expectedRevision: 2 }),
    ),
  ).toMatchObject({ status: "answered" });
  await close();
});

test("resolve_comment keeps the thread as resolved, with the agent's reply, for the person to dismiss", async () => {
  const { root, store, view, client, close } = await setup();
  const thread = store.create(view, { anchor: { kind: "view" }, body: "Rename it" }).value;
  store.submit();
  await call(client, "get_comments");
  await call(client, "reply_comment", { threadId: thread.id, body: "Renamed in flow.mmd.", expectedRevision: 1 });
  const result = await call(client, "resolve_comment", {
    threadId: thread.id,
    expectedRevision: 1,
    note: "Renamed in flow.mmd",
  });
  expect(structured(result)).toEqual({ resolved: true });
  expect(text(result)).toContain("Renamed in flow.mmd");
  expect(text(result)).toContain("dismiss");
  expect(store.list(view).threads[0]).toMatchObject({
    status: "resolved",
    comments: [{}, { author: "agent", body: "Renamed in flow.mmd." }],
  });
  expect(structured(await call(client, "get_comments"))).toEqual({ threads: [] });
  store.dismiss(thread.id);
  expect(existsSync(join(root, ".archer/flow.comments.json"))).toBe(false);
  await close();
});

test("arguments are checked strictly", async () => {
  const { client, close } = await setup();
  for (const [name, args, problem] of [
    ["create_comment", { target: "note:auth.md", anchor: { kind: "view" }, body: "x", author: "person" }, "author"],
    ["create_comment", { target: "note:../x.md", anchor: { kind: "view" }, body: "x" }, "target"],
    ["create_comment", { target: "note:auth.md", body: "x" }, "anchor: is required"],
    ["create_comment", { target: "note:auth.md", anchor: { kind: "view", id: "a" }, body: "x" }, "view anchor"],
    ["create_comment", { target: "note:auth.md", anchor: { kind: "view" }, body: "" }, "body: must not be empty"],
    ["get_comments", { target: "flow" }, "target"],
    ["get_comments", { target: "note:../x.md" }, "target"],
    ["get_comments", { since: 1 }, "since"],
    [
      "reply_comment",
      { threadId: "t-1", body: "x".repeat(4001), expectedRevision: 1 },
      "body: must be at most 4000 characters",
    ],
    ["reply_comment", { threadId: "t-1", body: "", expectedRevision: 1 }, "body: must not be empty"],
    ["reply_comment", { threadId: "t-1", expectedRevision: 1 }, "body: is required"],
    ["reply_comment", { threadId: "t-1", body: "x" }, "expectedRevision: is required"],
    ["reply_comment", { threadId: "t-1", body: "x", expectedRevision: 0 }, "expectedRevision: must be at least 1"],
    ["reply_comment", { threadId: "t-1", body: "x", expectedRevision: 1.5 }, "expectedRevision: must be an integer"],
    ["reply_comment", { threadId: "t-1", body: "x", expectedRevision: "1" }, "expectedRevision: must be an integer"],
    ["resolve_comment", { threadId: "t-1" }, "expectedRevision: is required"],
    ["resolve_comment", { threadId: "t-1", expectedRevision: 1, reason: "x" }, "reason"],
  ] as const) {
    const error = await refusal(client, name, args);
    expect(error.data.code, `${name} ${JSON.stringify(args)}`).toBe("invalid_arguments");
    expect(error.message, `${name} ${JSON.stringify(args)}`).toContain(problem);
  }
  await close();
});

test("create_comment refuses unknown targets and anchors, and names a broken source when only a whole-view anchor is possible", async () => {
  const root = tempDir({
    ".archer/broken.mmd": "flowchart LR\n  a[Client] --> b[API]\n",
    ".archer/auth.md": "# Auth\n\nTokens.\n",
  });
  const { client, close } = await connect({ cwd: root });
  expect(
    (await refusal(client, "create_comment", { target: "note:missing.md", anchor: { kind: "view" }, body: "x" })).data
      .code,
  ).toBe("invalid_request");
  expect(
    (await refusal(client, "create_comment", { target: "view:missing", anchor: { kind: "view" }, body: "x" })).data
      .code,
  ).toBe("invalid_request");
  const unknown = await refusal(client, "create_comment", {
    target: "view:broken",
    anchor: { kind: "node", id: "a", label: "A" },
    body: "x",
  });
  expect(unknown.data.code).toBe("invalid_arguments");
  expect(unknown.message).toContain("does not have a current compiled model");
  expect(unknown.message).toContain("unsupported_construct");
  expect(
    structured(
      await call(client, "create_comment", {
        target: "view:broken",
        anchor: { kind: "view" },
        body: "The whole broken view",
      }),
    ),
  ).toMatchObject({ status: "answered" });
  const wrong = await refusal(client, "create_comment", {
    target: "note:auth.md",
    anchor: { kind: "node", id: "a", label: "A" },
    body: "x",
  });
  expect(wrong.message).toContain("note takes comments");
  await close();
});
