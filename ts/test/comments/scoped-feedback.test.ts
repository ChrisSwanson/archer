import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { CommentsStore, type Place } from "../../src/comments/store.ts";
import type { TargetRef, Thread } from "../../src/comments/contract.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

function setup() {
  const cwd = tempDir({
    ".archer/notes/policy.md": "# Policy\n\n```mermaid\n%% archer-id: retention\nflowchart LR\n  a[Audit]\n```\n",
  });
  const store = new CommentsStore(findProject(cwd));
  const app = createApplication({ cwd });
  const seed = (target: TargetRef, path: string, body = "Please correct retention.") => {
    const place: Place = {
      target,
      path,
      subject: target.startsWith("view:") ? { kind: "view", elements: null } : { kind: "note", text: "# Policy" },
    };
    const { value } = store.create(place, { anchor: { kind: "view" }, body });
    store.submit(target, value.id);
    return { place, thread: value, bytes: () => readFileSync(join(cwd, ".archer", path)) };
  };
  return { cwd, app, store, seed };
}

test("note-scoped feedback advertises sent embedded-view feedback without consuming it", async () => {
  const { app, store, seed } = setup();
  const view = seed("view:notes/policy.md#retention", "notes/policy.retention.comments.json");
  const before = view.bytes();
  try {
    const answer = await app.call("get_comments", { target: "note:notes/policy.md" });
    expect(answer.structured).toMatchObject({
      threads: [],
      scope: { target: "note:notes/policy.md", includesEmbeddedDiagrams: false },
      relatedTargets: [{ target: view.place.target, awaitingThreads: 1 }],
      relatedTargetsTruncated: false,
    });
    expect(answer.text).toContain(view.place.target);
    expect(answer.text).toMatch(/omit.*target|without.*target/i);
    expect(view.bytes()).toEqual(before);
    expect(store.list(view.place).threads[0]?.status).toBe("sent");
    const fetched = await app.call("get_comments", { target: view.place.target });
    // Not the checkout's listener: fetched, and still sent (ADR 0035 §7).
    expect(fetched.structured.threads).toMatchObject([
      { target: view.place.target, status: "sent", comments: [{ body: "Please correct retention." }] },
    ]);
    expect(store.list(view.place).threads[0]?.status).toBe("sent");
  } finally {
    app.close();
  }
});

test("note feedback remains target-exact and includes only same-note awaiting embedded targets", async () => {
  const { app, store, seed } = setup();
  const note = seed("note:notes/policy.md", "notes/policy.comments.json", "Note feedback");
  const view = seed("view:notes/policy.md#retention", "notes/policy.retention.comments.json", "View feedback");
  seed(view.place.target, view.place.path, "Second view thread");
  seed("note:notes/other.md", "notes/other.comments.json");
  seed("view:notes/other.md#retention", "notes/other.retention.comments.json");
  seed("view:policy", "policy.comments.json");
  const inactive: Place = {
    target: "view:notes/policy.md#draft",
    path: "notes/policy.draft.comments.json",
    subject: { kind: "view", elements: null },
  };
  store.create(inactive, { anchor: { kind: "view" }, body: "Not submitted" });
  store.createByAgent(
    { ...inactive, target: "view:notes/policy.md#answered", path: "notes/policy.answered.comments.json" },
    { anchor: { kind: "view" }, body: "Already answered" },
  );
  try {
    const answer = await app.call("get_comments", { target: note.place.target });
    expect(answer.structured.threads).toMatchObject([
      { target: note.place.target, comments: [{ body: "Note feedback" }] },
    ]);
    expect(answer.structured.relatedTargets).toEqual([{ target: view.place.target, awaitingThreads: 2 }]);
    expect(store.list(view.place).threads.map((t) => t.status)).toEqual(["sent", "sent"]);
    expect(store.list(note.place).threads[0]?.status).toBe("sent");
  } finally {
    app.close();
  }
});

test("already-fetched embedded feedback is hinted without byte changes; unfiltered and view result shapes remain compatible", async () => {
  const { app, seed } = setup();
  const view = seed("view:notes/policy.md#retention", "notes/policy.retention.comments.json");
  try {
    const explicit = await app.call("get_comments", { target: view.place.target });
    expect(Object.keys(explicit.structured)).toEqual(["threads"]);
    const bytes = view.bytes();
    const note = await app.call("get_comments", { target: "note:notes/policy.md" });
    expect(note.structured.relatedTargets).toEqual([{ target: view.place.target, awaitingThreads: 1 }]);
    expect(view.bytes()).toEqual(bytes);
    const all = await app.call("get_comments");
    expect(Object.keys(all.structured)).toEqual(["threads"]);
    expect(all.structured.threads).toMatchObject([{ target: view.place.target, status: "sent" }]);
  } finally {
    app.close();
  }
});

test("related target hints cap at five, report truncation and leave every related sidecar sent and unchanged", async () => {
  const { app, store, seed } = setup();
  const views = Array.from({ length: 7 }, (_, i) =>
    seed(`view:notes/policy.md#v${i}`, `notes/policy.v${i}.comments.json`),
  );
  const bytes = views.map((view) => view.bytes());
  try {
    const answer = await app.call("get_comments", { target: "note:notes/policy.md" });
    expect(answer.structured.relatedTargets).toEqual(
      views.slice(0, 5).map((view) => ({ target: view.place.target, awaitingThreads: 1 })),
    );
    expect(answer.structured.relatedTargetsTruncated).toBe(true);
    expect(answer.text).toContain("more related targets were omitted");
    for (const [i, view] of views.entries()) {
      expect(view.bytes()).toEqual(bytes[i]);
      expect(store.list(view.place).threads[0]?.status).toBe("sent");
    }
    const all = await app.call("get_comments");
    expect((all.structured.threads as Thread[]).map((t) => t.status)).toEqual(Array(7).fill("sent"));
  } finally {
    app.close();
  }
});

test("note filter with no observed related feedback explicitly describes its limited scope", async () => {
  const { app } = setup();
  try {
    const answer = await app.call("get_comments", { target: "note:notes/policy.md" });
    expect(answer.structured).toEqual({
      threads: [],
      scope: { target: "note:notes/policy.md", includesEmbeddedDiagrams: false },
      relatedTargets: [],
      relatedTargetsTruncated: false,
    });
    expect(answer.text).toContain("not complete project coverage");
  } finally {
    app.close();
  }
});

test("malformed related sidecars are reported without hints or mutation", async () => {
  const { cwd, app, store, seed } = setup();
  const valid = seed("view:notes/policy.md#retention", "notes/policy.retention.comments.json");
  const before = valid.bytes();
  const brokenPath = join(cwd, ".archer/notes/policy.broken.comments.json");
  const broken = '{"version":2,"target":"view:notes/policy.md#broken","threads":[';
  writeFileSync(brokenPath, broken);
  try {
    const answer = await app.call("get_comments", { target: "note:notes/policy.md" });
    expect(answer.structured.relatedTargets).toEqual([{ target: valid.place.target, awaitingThreads: 1 }]);
    expect(answer.structured.problems).toEqual([expect.stringContaining("policy.broken.comments.json")]);
    expect(readFileSync(brokenPath, "utf8")).toBe(broken);
    expect(valid.bytes()).toEqual(before);
    expect(store.list(valid.place).threads[0]?.status).toBe("sent");
  } finally {
    app.close();
  }
});
