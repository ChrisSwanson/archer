// The comments store on a real temp project: every status transition, every
// refusal, malformed files kept and reported, the limits, and orphaning.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  MAX_COMMENT_CHARS,
  MAX_THREADS_PER_TARGET,
  type Thread,
  type ThreadStatus,
} from "../../src/comments/contract.ts";
import {
  CommentsError,
  CommentsStore,
  commentsPathFor,
  elementsOf,
  type Place,
  type Subject,
} from "../../src/comments/store.ts";
import { findProject } from "../../src/project/index.ts";
import type { GraphModel, SequenceTrace } from "../../src/model/index.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

const GRAPH: GraphModel = {
  type: "freeform-graph",
  nodes: [
    { id: "a", label: "Client" },
    { id: "b", label: "API" },
  ],
  edges: [{ id: "e1", source: "a", target: "b", label: "calls" }],
  groups: [{ id: "g", label: "Backend" }],
};

const NOTE = "# Auth\n\nThe client sends a **token** to the API, which checks it.\n";

function setup() {
  const root = tempDir({ ".archer/flow.mmd": FLOW, ".archer/notes/auth.md": NOTE });
  const project = findProject(root);
  let clock = 0;
  const store = new CommentsStore(project, { now: () => new Date(Date.UTC(2026, 9, 3, 12, 0, clock++)).toISOString() });
  const view: Place = {
    target: "view:flow",
    path: "flow.comments.json",
    subject: { kind: "view", elements: elementsOf(GRAPH) },
  };
  const note: Place = {
    target: "note:notes/auth.md",
    path: "notes/auth.comments.json",
    subject: { kind: "note", text: NOTE },
  };
  const file = (place: Place) => join(project.folder, place.path);
  const onDisk = (place: Place) =>
    JSON.parse(readFileSync(file(place), "utf8")) as { version: number; target: string; threads: Thread[] };
  return { root, project, store, view, note, file, onDisk };
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

const node = { kind: "node", id: "a", label: "whatever the page says" };
/** The checkout's listener fetching (ADR 0035 §7): only its fetch marks a thread read. */
const AS_LISTENER = { asListener: true } as const;

describe("paths and targets", () => {
  test("a comments file sits beside its diagram or note", () => {
    expect(commentsPathFor("flow.mmd")).toBe("flow.comments.json");
    expect(commentsPathFor("notes/auth.md")).toBe("notes/auth.comments.json");
  });

  test("elements of a graph and a sequence, keyed by kind and id", () => {
    expect([...elementsOf(GRAPH)]).toEqual([
      ["node:a", "Client"],
      ["node:b", "API"],
      ["edge:e1", "calls"],
      ["group:g", "Backend"],
    ]);
    const trace: SequenceTrace = {
      type: "sequence-trace",
      participants: [{ id: "A", label: "Alice" }],
      events: [
        {
          type: "fragment",
          id: "frag-0",
          kind: "loop",
          label: "retry",
          sections: [{ events: [{ type: "message", id: "msg-0", from: "A", to: "A", kind: "sync" }] }],
        },
      ],
    };
    expect(new Map(elementsOf(trace))).toEqual(
      new Map([
        ["node:A", "Alice"],
        ["group:frag-0", "retry"],
        ["edge:msg-0", "A → A"],
      ]),
    );
  });
});

describe("creating a thread", () => {
  test("a draft by the person, ids made by the server, labels from the model, written beside the diagram", () => {
    const { store, view, onDisk } = setup();
    const created = store.create(view, { anchor: node, body: "Why is this here?" });
    const thread = created.value;
    expect(created).toMatchObject({ target: "view:flow", path: "flow.comments.json" });
    expect(thread).toEqual({
      id: expect.stringMatching(/^t-[0-9a-f]{12}$/),
      target: "view:flow",
      anchor: { kind: "node", id: "a", label: "Client" },
      status: "draft",
      revision: 1,
      comments: [
        {
          id: expect.stringMatching(/^c-[0-9a-f]{12}$/),
          author: "person",
          body: "Why is this here?",
          createdAt: "2026-10-03T12:00:00.000Z",
        },
      ],
    });
    expect(onDisk(view)).toEqual({ version: 2, target: "view:flow", threads: [thread] });
    expect(store.list(view)).toEqual({ schemaVersion: 2, target: "view:flow", threads: [thread] });
  });

  test("an agent opens an answered thread with an agent root, without changing the person's create behavior", () => {
    const { store, view, onDisk } = setup();
    const opened = store.createByAgent(view, { anchor: node, body: "I have a question for you." }).value;
    expect(opened).toMatchObject({
      target: "view:flow",
      anchor: { kind: "node", id: "a", label: "Client" },
      status: "answered",
      revision: 1,
      comments: [{ author: "agent", body: "I have a question for you." }],
    });
    expect(onDisk(view).threads).toEqual([opened]);
    expect(store.create(view, { anchor: { kind: "view" }, body: "Person root" }).value).toMatchObject({
      status: "draft",
      comments: [{ author: "person" }],
    });
  });

  test("every anchor kind its target accepts", () => {
    const { store, view, note } = setup();
    expect(store.create(view, { anchor: { kind: "view" }, body: "x" }).value.anchor).toEqual({ kind: "view" });
    expect(store.create(view, { anchor: { kind: "edge", id: "e1", label: "" }, body: "x" }).value.anchor).toEqual({
      kind: "edge",
      id: "e1",
      label: "calls",
    });
    expect(store.create(view, { anchor: { kind: "group", id: "g", label: "" }, body: "x" }).value.anchor).toEqual({
      kind: "group",
      id: "g",
      label: "Backend",
    });
    const selection = {
      kind: "selection",
      nodes: [
        { id: "a", label: "" },
        { id: "b", label: "" },
      ],
      edges: [{ id: "e1", label: "" }],
    };
    expect(store.create(view, { anchor: selection, body: "x" }).value.anchor).toEqual({
      kind: "selection",
      nodes: [
        { id: "a", label: "Client" },
        { id: "b", label: "API" },
      ],
      edges: [{ id: "e1", label: "calls" }],
    });
    expect(store.create(note, { anchor: { kind: "view" }, body: "about the whole note" }).value.target).toBe(
      "note:notes/auth.md",
    );
    // The page quotes rendered text; the note's Markdown has `**token**`.
    const passage = { kind: "passage", quote: "sends a token", prefix: "The client ", suffix: " to the API" };
    expect(store.create(note, { anchor: passage, body: "Which token?" }).value.anchor).toEqual(passage);
  });

  const BAD: [string, unknown, string][] = [
    ["an empty body", { anchor: node, body: "  \n" }, "empty"],
    ["a body over the limit", { anchor: node, body: "x".repeat(MAX_COMMENT_CHARS + 1) }, `${MAX_COMMENT_CHARS}`],
    ["a body that is not text", { anchor: node, body: 7 }, "text"],
    ["a control character", { anchor: node, body: "a\u0000b" }, "control"],
    ["an unknown node", { anchor: { kind: "node", id: "zz", label: "" }, body: "x" }, '"zz"'],
    ["a node id that is an edge", { anchor: { kind: "node", id: "e1", label: "" }, body: "x" }, '"e1"'],
    ["an unknown anchor kind", { anchor: { kind: "region" }, body: "x" }, "kind"],
    ["an anchor with an extra field", { anchor: { kind: "view", extra: 1 }, body: "x" }, "extra"],
    ["an empty selection", { anchor: { kind: "selection", nodes: [], edges: [] }, body: "x" }, "selection"],
    ["a passage on a diagram", { anchor: { kind: "passage", quote: "q", prefix: "", suffix: "" }, body: "x" }, "note"],
  ];
  test.each(BAD)("refuses %s, and writes nothing", (_name, input, says) => {
    const { store, view, file } = setup();
    const error = refused(() => store.create(view, input as { anchor: unknown; body: unknown }), "invalid_comment");
    expect(error.message).toContain(says);
    expect(error.status).toBe(422);
    expect(existsSync(file(view))).toBe(false);
  });

  test("a note takes passages it holds and no diagram anchors", () => {
    const { store, note } = setup();
    refused(() => store.create(note, { anchor: node, body: "x" }), "invalid_comment");
    const missing = refused(
      () =>
        store.create(note, {
          anchor: { kind: "passage", quote: "not in the note", prefix: "", suffix: "" },
          body: "x",
        }),
      "invalid_comment",
    );
    expect(missing.message).toContain("not found");
  });

  test("a diagram that has not compiled takes only whole-view comments", () => {
    const { store, view } = setup();
    const uncompiled: Place = { ...view, subject: { kind: "view", elements: null } };
    expect(store.create(uncompiled, { anchor: { kind: "view" }, body: "x" }).value.status).toBe("draft");
    refused(() => store.create(uncompiled, { anchor: node, body: "x" }), "invalid_comment");
  });

  test(`at most ${MAX_THREADS_PER_TARGET} threads per target`, () => {
    const { store, view, file } = setup();
    const one = store.create(view, { anchor: { kind: "view" }, body: "x" }).value;
    const threads = Array.from({ length: MAX_THREADS_PER_TARGET }, (_, i) => ({ ...one, id: `t-${i}` }));
    writeFileSync(file(view), JSON.stringify({ version: 2, target: "view:flow", threads }));
    const error = refused(() => store.create(view, { anchor: { kind: "view" }, body: "x" }), "too_many_threads");
    expect(error.status).toBe(409);
  });
});

describe("status transitions", () => {
  function draft() {
    const s = setup();
    const thread = s.store.create(s.view, { anchor: node, body: "first" }).value;
    const first = thread.comments[0]?.id ?? "";
    const now = (): Thread | undefined => s.store.list(s.view).threads.find((t) => t.id === thread.id);
    const status = (): { status: ThreadStatus | "gone"; changedAfterSubmit?: boolean } => {
      const t = now();
      return {
        status: t?.status ?? "gone",
        ...(t?.changedAfterSubmit === undefined ? {} : { changedAfterSubmit: t.changedAfterSubmit }),
      };
    };
    const revision = (): number => now()?.revision ?? 0;
    /** Sends it, and the agent reads it: the revision the agent then holds. */
    const sendAndRead = (): number => {
      s.store.submit();
      s.store.fetchForAgent(undefined, AS_LISTENER);
      return revision();
    };
    return { ...s, thread, first, now, status, revision, sendAndRead };
  }
  type Draft = ReturnType<typeof draft>;

  // Every status, and what each action of the person's or the agent's makes
  // of it. "x changed" carries changedAfterSubmit; "-code" is a refusal.
  const STATUSES: ThreadStatus[] = ["draft", "sent", "read", "answered", "resolved"];
  const TABLE: [string, Record<ThreadStatus, string>, (d: Draft) => unknown, boolean][] = [
    [
      "the person edits",
      {
        draft: "draft",
        sent: "draft changed",
        read: "draft changed",
        answered: "draft changed",
        resolved: "draft changed",
      },
      (d) => d.store.edit(d.thread.id, d.first, "reworded"),
      true,
    ],
    [
      "the person replies",
      { draft: "draft", sent: "draft changed", read: "draft changed", answered: "draft", resolved: "draft" },
      (d) => d.store.reply(d.thread.id, "and more", "person"),
      true,
    ],
    [
      "the person sends",
      { draft: "sent", sent: "sent", read: "read", answered: "answered", resolved: "resolved" },
      (d) => d.store.submit(),
      false,
    ],
    [
      "another session fetches",
      { draft: "draft", sent: "sent", read: "read", answered: "answered", resolved: "resolved" },
      (d) => d.store.fetchForAgent(),
      false,
    ],
    [
      "the listener fetches",
      { draft: "draft", sent: "read", read: "read", answered: "answered", resolved: "resolved" },
      (d) => d.store.fetchForAgent(undefined, AS_LISTENER),
      false,
    ],
    [
      "the agent replies",
      {
        draft: "-thread_not_awaiting",
        sent: "answered",
        read: "answered",
        answered: "answered",
        resolved: "-thread_not_awaiting",
      },
      (d) => d.store.reply(d.thread.id, "reply", "agent", d.revision()),
      false,
    ],
    [
      "the agent resolves",
      { draft: "-thread_not_awaiting", sent: "resolved", read: "resolved", answered: "resolved", resolved: "resolved" },
      (d) => d.store.resolve(d.thread.id, "agent", d.revision()),
      false,
    ],
    [
      "the person resolves",
      { draft: "gone", sent: "gone", read: "gone", answered: "gone", resolved: "gone" },
      (d) => d.store.resolve(d.thread.id, "person"),
      false,
    ],
    [
      "the person dismisses",
      {
        draft: "-thread_not_resolved",
        sent: "-thread_not_resolved",
        read: "-thread_not_resolved",
        answered: "-thread_not_resolved",
        resolved: "gone",
      },
      (d) => d.store.dismiss(d.thread.id),
      false,
    ],
  ];

  /** A thread brought to `status` the way the loop brings it there. */
  function at(status: ThreadStatus): Draft {
    const d = draft();
    if (status !== "draft") d.store.submit();
    if (status === "read" || status === "answered" || status === "resolved")
      d.store.fetchForAgent(undefined, AS_LISTENER);
    if (status === "answered") d.store.reply(d.thread.id, "an answer", "agent", d.revision());
    if (status === "resolved") d.store.resolve(d.thread.id, "agent", d.revision());
    expect(d.status().status).toBe(status);
    return d;
  }

  const shown = (d: Draft): string => {
    const s = d.status();
    return s.changedAfterSubmit === true ? `${s.status} changed` : s.status;
  };

  describe.each(TABLE)("%s", (_name, table, run, advances) => {
    test.each(STATUSES)("from %s", (from) => {
      const d = at(from);
      const before = d.revision();
      const expected = table[from];
      if (expected.startsWith("-")) {
        const error = refused(() => run(d), expected.slice(1));
        expect(error.status).toBe(409);
        expect(d.status().status).toBe(from);
        expect(d.revision()).toBe(before);
        return;
      }
      run(d);
      expect(shown(d)).toBe(expected);
      if (expected !== "gone") expect(d.revision()).toBe(advances ? before + 1 : before);
    });
  });

  test("deleting a person reply is a person change: the revision advances and a sent thread is a draft again, changed", () => {
    const { store, thread, status, revision } = draft();
    const second = store.reply(thread.id, "one more thing", "person").value.comments[1]?.id ?? "";
    store.submit();
    const before = revision();
    expect(store.remove(thread.id, second).value).toMatchObject({
      status: "draft",
      changedAfterSubmit: true,
      revision: before + 1,
    });
    expect(status()).toEqual({ status: "draft", changedAfterSubmit: true });
  });

  test("the agent's reply or resolve clears the changed mark", () => {
    const { store, thread, first, status, revision } = draft();
    store.submit();
    store.edit(thread.id, first, "first, changed");
    store.submit();
    expect(status()).toEqual({ status: "sent", changedAfterSubmit: true });
    store.fetchForAgent(undefined, AS_LISTENER);
    expect(status()).toEqual({ status: "read", changedAfterSubmit: true });
    store.reply(thread.id, "seen", "agent", revision());
    expect(status()).toEqual({ status: "answered" });
    store.edit(thread.id, first, "changed again");
    store.submit();
    store.resolve(thread.id, "agent", revision());
    expect(status()).toEqual({ status: "resolved" });
  });

  test("an unchanged edit changes nothing, not even the revision", () => {
    const { store, thread, first, status, revision } = draft();
    store.submit();
    expect(store.edit(thread.id, first, "first").value).toMatchObject({ status: "sent", revision: 1 });
    expect(status()).toEqual({ status: "sent" });
    expect(revision()).toBe(1);
  });

  test("an edit with an expected revision is refused as thread_changed once the thread moved past it (O124)", () => {
    const { store, thread, first, revision, view, onDisk } = draft();
    const seen = revision();
    store.edit(thread.id, first, "changed in another tab");
    const before = JSON.stringify(onDisk(view));
    const error = refused(() => store.edit(thread.id, first, "mine", seen), "thread_changed");
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({
      threadId: thread.id,
      revision: seen + 1,
      comments: [{ id: first, body: "changed in another tab" }],
    });
    expect(JSON.stringify(onDisk(view))).toBe(before);
    // At the revision it now is, the edit is taken; asking for the text it already reads is no change whatever the revision.
    expect(store.edit(thread.id, first, "mine", seen + 1).value).toMatchObject({
      revision: seen + 2,
      comments: [{ body: "mine" }],
    });
    expect(store.edit(thread.id, first, "mine", seen).value).toMatchObject({ revision: seen + 2 });
    // Without one, as an older page sends it, the edit is taken as before.
    expect(store.edit(thread.id, first, "older page").value).toMatchObject({ revision: seen + 3 });
  });

  test("only the person's comments are editable or deletable from the page", () => {
    const { store, thread, status, sendAndRead } = draft();
    const reply = store.reply(thread.id, "agent text", "agent", sendAndRead()).value.comments[1]?.id ?? "";
    expect(refused(() => store.edit(thread.id, reply, "rewritten"), "not_editable").status).toBe(403);
    refused(() => store.remove(thread.id, reply), "not_editable");
    expect(status()).toEqual({ status: "answered" });
  });

  test("deleting the first comment deletes a thread with no replies, and is refused while it has some", () => {
    const { store, thread, first, view, file } = draft();
    store.reply(thread.id, "second", "person");
    refused(() => store.remove(thread.id, first), "has_replies");
    const second = store.list(view).threads[0]?.comments[1]?.id ?? "";
    store.remove(thread.id, second);
    expect(store.remove(thread.id, first).value).toEqual({ deleted: true });
    expect(existsSync(file(view))).toBe(false);
  });

  test("the person resolving removes the thread and keeps the others; the last one removes the file", () => {
    const { store, view, thread, file, onDisk } = draft();
    const other = store.create(view, { anchor: { kind: "view" }, body: "other" }).value;
    expect(store.resolve(thread.id, "person")).toEqual({
      value: { resolved: true },
      target: "view:flow",
      path: "flow.comments.json",
    });
    expect(onDisk(view).threads.map((t) => t.id)).toEqual([other.id]);
    store.resolve(other.id, "person");
    expect(existsSync(file(view))).toBe(false);
  });

  test("the agent resolving keeps the thread, with the agent's last reply, until the person dismisses it", () => {
    const { store, view, thread, file, onDisk, sendAndRead, revision } = draft();
    store.reply(thread.id, "Renamed it.", "agent", sendAndRead());
    expect(store.resolve(thread.id, "agent", revision())).toEqual({
      value: { resolved: true },
      target: "view:flow",
      path: "flow.comments.json",
    });
    expect(onDisk(view).threads[0]).toMatchObject({
      id: thread.id,
      status: "resolved",
      comments: [{ author: "person" }, { author: "agent", body: "Renamed it." }],
    });
    expect(store.dismiss(thread.id)).toEqual({
      value: { dismissed: true },
      target: "view:flow",
      path: "flow.comments.json",
    });
    expect(existsSync(file(view))).toBe(false);
  });

  test("unknown threads and comments are not found", () => {
    const { store, thread } = draft();
    expect(refused(() => store.reply("t-000000000000", "x", "person"), "thread_not_found").status).toBe(404);
    refused(() => store.edit(thread.id, "c-000000000000", "x"), "comment_not_found");
    refused(() => store.resolve("nope", "person"), "thread_not_found");
    refused(() => store.dismiss("nope"), "thread_not_found");
    refused(() => store.reply("nope", "x", "agent", 1), "thread_not_found");
  });

  test("submit without a target sends every target's drafts; with one, only that target's", () => {
    const { store, view, note } = setup();
    store.create(view, { anchor: { kind: "view" }, body: "v" });
    store.create(note, { anchor: { kind: "view" }, body: "n" });
    expect(store.submit("note:notes/auth.md")).toMatchObject({
      submitted: 1,
      changed: [{ target: "note:notes/auth.md", path: "notes/auth.comments.json" }],
    });
    expect(store.list(view).threads[0]?.status).toBe("draft");
    expect(store.submit()).toMatchObject({ submitted: 1, changed: [{ target: "view:flow" }] });
  });
});

describe("the agent reads the revision it answers", () => {
  test("fetching moves sent threads to read and returns them with read ones still unanswered, by target if asked", () => {
    const { store, view, note } = setup();
    const kept = store.create(view, { anchor: { kind: "view" }, body: "sent first" }).value;
    store.submit();
    store.create(view, { anchor: { kind: "view" }, body: "still a draft" });
    const n = store.create(note, { anchor: { kind: "view" }, body: "n" }).value;
    store.submit("note:notes/auth.md");

    const first = store.fetchForAgent("note:notes/auth.md", AS_LISTENER);
    expect(first.threads.map((t) => [t.id, t.status, t.revision])).toEqual([[n.id, "read", 1]]);
    expect(first.changed).toEqual([{ target: "note:notes/auth.md", path: "notes/auth.comments.json" }]);
    expect(store.list(view).threads[0]?.status).toBe("sent");

    const all = store.fetchForAgent(undefined, AS_LISTENER);
    expect(all.threads.map((t) => t.comments[0]?.body).sort()).toEqual(["n", "sent first"]);
    expect(all.threads.every((t) => t.status === "read")).toBe(true);
    expect(all.changed).toEqual([{ target: "view:flow", path: "flow.comments.json" }]);
    // Read and unanswered: still returned, and nothing written.
    expect(store.fetchForAgent(undefined, AS_LISTENER)).toMatchObject({ threads: [{}, {}], changed: [] });

    store.reply(n.id, "done", "agent", 1);
    store.resolve(kept.id, "agent", 1);
    expect(store.fetchForAgent(undefined, AS_LISTENER).threads).toEqual([]);
  });

  test("a fetch by a session that is not the listener returns the same threads and leaves them sent, writing nothing", () => {
    const { store, view } = setup();
    const thread = store.create(view, { anchor: { kind: "view" }, body: "Seen?" }).value;
    store.submit();
    const before = readFileSync(join(store.project.folder, "flow.comments.json"), "utf8");
    const fetched = store.fetchForAgent();
    expect(fetched).toMatchObject({ threads: [{ id: thread.id, status: "sent", revision: 1 }], changed: [] });
    expect(readFileSync(join(store.project.folder, "flow.comments.json"), "utf8")).toBe(before);
    // It can still answer at the revision it read.
    expect(store.reply(thread.id, "Yes.", "agent", 1).value.status).toBe("answered");
  });

  test("what waits for the listener: sent threads only; taking them marks them read, once", () => {
    const { store, view, note } = setup();
    const a = store.create(view, { anchor: { kind: "view" }, body: "a" }).value;
    const b = store.create(note, { anchor: { kind: "view" }, body: "b" }).value;
    store.create(view, { anchor: { kind: "view" }, body: "draft" });
    store.submit("view:flow", a.id);
    store.submit("note:notes/auth.md", b.id);
    expect(
      store
        .waiting({ markRead: false })
        .threads.map((t) => [t.id, t.status])
        .sort(),
    ).toEqual(
      [
        [a.id, "sent"],
        [b.id, "sent"],
      ].sort(),
    );
    expect(store.list(view).threads.find((t) => t.id === a.id)?.status).toBe("sent");
    const taken = store.waiting({ markRead: true });
    expect(taken.threads.map((t) => [t.id, t.status]).sort()).toEqual(
      [
        [a.id, "read"],
        [b.id, "read"],
      ].sort(),
    );
    expect(taken.changed.map((c) => c.target).sort()).toEqual(["note:notes/auth.md", "view:flow"]);
    expect(store.list(view).threads.find((t) => t.id === a.id)?.status).toBe("read");
    expect(store.waiting({ markRead: true })).toEqual({ threads: [], changed: [], problems: [] });
  });

  test("the race: the person edits after the agent read; the reply is refused with the text as it is now; re-read, it is accepted", () => {
    const { store, view } = setup();
    const thread = store.create(view, { anchor: node, body: "Is the API one service?" }).value;
    const first = thread.comments[0]?.id ?? "";
    store.submit();
    expect(store.fetchForAgent(undefined, AS_LISTENER).threads[0]).toMatchObject({
      id: thread.id,
      status: "read",
      revision: 1,
    });

    store.edit(thread.id, first, "Is the API one service, or a gateway and two services?");
    const changed = refused(() => store.reply(thread.id, "One service.", "agent", 1), "thread_changed");
    expect(changed.status).toBe(409);
    expect(changed.message).toContain("gateway and two services");
    expect(changed.details).toMatchObject({
      threadId: thread.id,
      revision: 2,
      status: "draft",
      comments: [{ body: "Is the API one service, or a gateway and two services?" }],
    });
    refused(() => store.resolve(thread.id, "agent", 1), "thread_changed");
    // The refusals wrote nothing.
    expect(store.list(view).threads[0]).toMatchObject({
      status: "draft",
      revision: 2,
      changedAfterSubmit: true,
      comments: [{}],
    });

    // A draft is not the agent's to answer, even at its current revision.
    refused(() => store.reply(thread.id, "One service.", "agent", 2), "thread_not_awaiting");
    store.submit();
    const reread = store.fetchForAgent(undefined, AS_LISTENER).threads[0];
    expect(reread).toMatchObject({ status: "read", revision: 2 });
    expect(store.reply(thread.id, "A gateway and one service.", "agent", reread?.revision ?? 0).value).toMatchObject({
      status: "answered",
      revision: 2,
    });
  });

  test("a person reply on an answered thread is a change the agent must re-read", () => {
    const { store, view } = setup();
    const t = store.create(view, { anchor: { kind: "view" }, body: "Why?" }).value;
    store.submit();
    store.fetchForAgent(undefined, AS_LISTENER);
    store.reply(t.id, "Because.", "agent", 1);
    store.reply(t.id, "But why that?", "person");
    refused(() => store.reply(t.id, "More.", "agent", 1), "thread_changed");
  });
});

describe("pending drafts", () => {
  test("every draft in the project, counted by comments file", () => {
    const { store, view, note } = setup();
    expect(store.pending()).toEqual({ files: [], problems: [] });
    store.create(view, { anchor: { kind: "view" }, body: "a" });
    store.create(view, { anchor: { kind: "view" }, body: "b" });
    store.create(note, { anchor: { kind: "view" }, body: "c" });
    expect(store.pending().files).toEqual([
      { target: "view:flow", path: "flow.comments.json", drafts: 2 },
      { target: "note:notes/auth.md", path: "notes/auth.comments.json", drafts: 1 },
    ]);
    store.submit("view:flow");
    expect(store.pending().files).toEqual([
      { target: "note:notes/auth.md", path: "notes/auth.comments.json", drafts: 1 },
    ]);
  });
});

describe("version 1 files", () => {
  const person = (id: string, body: string) => ({ id, author: "person", body, createdAt: "2026-10-03T12:00:00.000Z" });
  const V1 = {
    version: 1,
    target: "view:flow",
    threads: [
      {
        id: "t-1",
        target: "view:flow",
        anchor: { kind: "view" },
        status: "submitted",
        comments: [person("c-1", "old and sent")],
      },
      {
        id: "t-2",
        target: "view:flow",
        anchor: { kind: "view" },
        status: "answered",
        changedAfterSubmit: true,
        comments: [
          person("c-2", "answered"),
          { id: "c-3", author: "agent", body: "yes", createdAt: "2026-10-03T12:00:01.000Z" },
        ],
      },
      {
        id: "t-3",
        target: "view:flow",
        anchor: { kind: "view" },
        status: "draft",
        comments: [person("c-4", "a draft")],
      },
    ],
  };

  test("a version 1 file is malformed, and so is a version 2 file holding version 1's words", () => {
    const { store, view, file } = setup();
    const t = V1.threads[0];
    for (const bad of [
      V1,
      { ...V1, version: 2, threads: [t] },
      { ...V1, version: 2, threads: [{ ...t, revision: 1 }] },
    ]) {
      writeFileSync(file(view), JSON.stringify(bad));
      refused(() => store.list(view), "malformed_comments_file");
    }
  });
});

describe("malformed files are kept and reported", () => {
  const thread = {
    id: "t-1",
    target: "view:flow",
    anchor: { kind: "view" },
    status: "sent",
    revision: 1,
    comments: [{ id: "c-1", author: "person", body: "hi", createdAt: "2026-10-03T12:00:00.000Z" }],
  };
  const MALFORMED: [string, string][] = [
    ["not JSON", "{ nope"],
    ["another version", JSON.stringify({ version: 6, target: "view:flow", threads: [] })],
    ["an unknown field", JSON.stringify({ version: 2, target: "view:flow", threads: [], extra: true })],
    ["a bad status", JSON.stringify({ version: 2, target: "view:flow", threads: [{ ...thread, status: "open" }] })],
    [
      "a version 1 status",
      JSON.stringify({ version: 2, target: "view:flow", threads: [{ ...thread, status: "submitted" }] }),
    ],
    ["no revision", JSON.stringify({ version: 2, target: "view:flow", threads: [{ ...thread, revision: undefined }] })],
    [
      "a revision that is not a whole number from 1",
      JSON.stringify({ version: 2, target: "view:flow", threads: [{ ...thread, revision: 0.5 }] }),
    ],
    [
      "a thread with no comments",
      JSON.stringify({ version: 2, target: "view:flow", threads: [{ ...thread, comments: [] }] }),
    ],
    [
      "an agent-opened thread marked sent without a person reply",
      JSON.stringify({
        version: 2,
        target: "view:flow",
        threads: [{ ...thread, comments: [{ ...thread.comments[0], author: "agent" }] }],
      }),
    ],
    [
      "an answered thread whose latest comment is from the person",
      JSON.stringify({ version: 2, target: "view:flow", threads: [{ ...thread, status: "answered" }] }),
    ],
    ["duplicate thread ids", JSON.stringify({ version: 2, target: "view:flow", threads: [thread, thread] })],
    [
      "a bad anchor",
      JSON.stringify({ version: 2, target: "view:flow", threads: [{ ...thread, anchor: { kind: "node" } }] }),
    ],
  ];

  test.each(MALFORMED)("%s: listed as a problem, never changed, never dropped", (_name, text) => {
    const { store, view, file } = setup();
    writeFileSync(file(view), text);
    const error = refused(() => store.list(view), "malformed_comments_file");
    expect(error.message).toContain("flow.comments.json");
    expect(error.status).toBe(409);
    refused(() => store.create(view, { anchor: { kind: "view" }, body: "x" }), "malformed_comments_file");
    expect(store.submit().problems).toEqual([expect.stringContaining("flow.comments.json")]);
    expect(store.fetchForAgent(undefined, AS_LISTENER).problems).toEqual([
      expect.stringContaining("flow.comments.json"),
    ]);
    expect(store.pending().problems).toEqual([expect.stringContaining("flow.comments.json")]);
    expect(store.reconcile(view)).toBe(false);
    refused(() => store.reply("t-1", "x", "agent", 1), "thread_not_found");
    expect(readFileSync(file(view), "utf8")).toBe(text);
  });

  test("a file holding another kind of target is a conflict, and is left alone", () => {
    const { store, view, file } = setup();
    const text = JSON.stringify({ version: 2, target: "note:flow.md", threads: [] });
    writeFileSync(file(view), text);
    refused(() => store.list(view), "comments_file_conflict");
    refused(() => store.create(view, { anchor: { kind: "view" }, body: "x" }), "comments_file_conflict");
    expect(readFileSync(file(view), "utf8")).toBe(text);
  });

  test("a file beside a renamed view is the renamed view's", () => {
    const { store, view, file } = setup();
    writeFileSync(
      file(view),
      JSON.stringify({ version: 2, target: "view:old-name", threads: [{ ...thread, target: "view:old-name" }] }),
    );
    expect(store.list(view).threads).toEqual([{ ...thread, target: "view:flow" }]);
  });
});

describe("orphaning", () => {
  test("an element gone from the recompiled view orphans its thread with its last label; its return restores it", () => {
    const { store, view, onDisk } = setup();
    store.create(view, { anchor: node, body: "x" });
    store.create(view, {
      anchor: {
        kind: "selection",
        nodes: [
          { id: "a", label: "" },
          { id: "b", label: "" },
        ],
        edges: [],
      },
      body: "y",
    });
    store.create(view, { anchor: { kind: "view" }, body: "z" });
    const without: Subject = {
      kind: "view",
      elements: elementsOf({ ...GRAPH, nodes: [{ id: "b", label: "Gateway" }], edges: [] }),
    };
    expect(store.reconcile({ ...view, subject: without })).toBe(true);
    const [single, selection, whole] = onDisk(view).threads;
    expect(single).toMatchObject({ orphaned: true, anchor: { id: "a", label: "Client" } });
    expect(selection).toMatchObject({
      orphaned: true,
      anchor: {
        nodes: [
          { id: "a", label: "Client" },
          { id: "b", label: "Gateway" },
        ],
      },
    });
    expect(whole?.orphaned).toBeUndefined();
    expect(store.reconcile({ ...view, subject: without })).toBe(false);

    const back: Subject = {
      kind: "view",
      elements: elementsOf({
        ...GRAPH,
        nodes: [
          { id: "a", label: "Browser" },
          { id: "b", label: "API" },
        ],
      }),
    };
    expect(store.reconcile({ ...view, subject: back })).toBe(true);
    expect(onDisk(view).threads[0]).toEqual(expect.not.objectContaining({ orphaned: expect.anything() }));
    expect(onDisk(view).threads[0]?.anchor).toEqual({ kind: "node", id: "a", label: "Browser" });
  });

  test("a view that does not compile orphans nothing", () => {
    const { store, view, file } = setup();
    store.create(view, { anchor: node, body: "x" });
    const before = readFileSync(file(view), "utf8");
    expect(store.reconcile({ ...view, subject: { kind: "view", elements: null } })).toBe(false);
    expect(readFileSync(file(view), "utf8")).toBe(before);
  });

  test("a passage whose quote is no longer found with its context is orphaned", () => {
    const { store, note, onDisk } = setup();
    store.create(note, {
      anchor: { kind: "passage", quote: "checks it", prefix: "which ", suffix: "." },
      body: "how?",
    });
    expect(store.reconcile({ ...note, subject: { kind: "note", text: `# Auth\n\nIntro.\n\n${NOTE.slice(8)}` } })).toBe(
      false,
    );
    expect(store.reconcile({ ...note, subject: { kind: "note", text: "# Auth\n\nThe API verifies it.\n" } })).toBe(
      true,
    );
    expect(onDisk(note).threads[0]).toMatchObject({ orphaned: true, anchor: { quote: "checks it" } });
  });

  test("no comments file, nothing to reconcile and nothing written", () => {
    const { store, view, file } = setup();
    expect(store.reconcile(view)).toBe(false);
    expect(existsSync(file(view))).toBe(false);
  });
});

// The newer diagram types anchor comments to their own elements too: states
// and transitions, entities and relationships.
test("elements of a state machine and an ER diagram", async () => {
  const { compile } = await import("../../src/mermaid/index.ts");
  const state = await compile(
    'stateDiagram-v2\n  state "Waiting" as Idle\n  state "Working" as Busy\n  Idle --> Busy : start\n',
  );
  expect(state.model).not.toBeNull();
  const els = elementsOf(state.model!);
  expect(els.get("node:Idle")).toBe("Waiting");
  expect([...els.keys()].some((k) => k.startsWith("edge:"))).toBe(true);
});
