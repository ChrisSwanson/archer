// The bubble talks about the whole document: which thread it continues (ADR 0034 §10).
import { describe, expect, it } from "vitest";
import { chatTarget, pickThread } from "../src/chat/chat-target";
import type { Anchor, Thread } from "../src/comments/contract";

const thread = (id: string, anchor: Anchor, status: Thread["status"], at: string): Thread => ({
  id,
  target: "view:containers",
  anchor,
  status,
  revision: 1,
  comments: [{ id: `${id}-c`, author: "person", body: id, createdAt: at }],
});
const VIEW: Anchor = { kind: "view" };

describe("chatTarget", () => {
  it("is the view for a diagram of any family", () => {
    expect(chatTarget({ viewId: "containers" }, "walkthrough")).toEqual({ target: "view:containers", anchor: VIEW });
  });
  it("is the walkthrough on its view while one is open, or the diagram when asked", () => {
    const walk = { id: "tour", title: "The tour" };
    expect(chatTarget({ viewId: "containers", walk }, "walkthrough")).toEqual({
      target: "view:containers",
      anchor: { kind: "walkthrough", walkthrough: "tour", label: "The tour" },
    });
    expect(chatTarget({ viewId: "containers", walk }, "diagram")?.anchor).toEqual(VIEW);
  });
  it("is the note with a whole-note anchor", () => {
    expect(chatTarget({ viewId: "containers", notePath: "notes/auth.md" }, "walkthrough")).toEqual({
      target: "note:notes/auth.md",
      anchor: VIEW,
    });
  });
  it("is nothing without a document", () => {
    expect(chatTarget({ viewId: null }, "walkthrough")).toBeNull();
  });
  it("is the project conversation on a page with no document, and when the person asks for it on a document", () => {
    const project = { target: "project:", anchor: { kind: "project" } };
    expect(chatTarget({ viewId: null, projectOnly: true }, "diagram")).toEqual(project);
    expect(chatTarget({ viewId: "containers" }, "project")).toEqual(project);
    expect(chatTarget({ viewId: null, notePath: "notes/auth.md" }, "project")).toEqual(project);
    expect(chatTarget({ viewId: "containers", walk: { id: "tour", title: "The tour" } }, "project")).toEqual(project);
  });
});

describe("the project conversation (ADR 0034 §10, amended)", () => {
  const PROJECT: Anchor = { kind: "project" };
  const project = (id: string, status: Thread["status"], at: string): Thread => ({
    ...thread(id, PROJECT, status, at),
    target: "project:",
  });
  it("continues the latest unresolved project thread, and starts a new one once it is resolved", () => {
    const threads = [
      project("old", "answered", "2026-10-23T09:00:00Z"),
      project("live", "sent", "2026-10-23T10:00:00Z"),
    ];
    expect(pickThread(threads, PROJECT)?.id).toBe("live");
    expect(pickThread([project("done", "resolved", "2026-10-23T10:00:00Z")], PROJECT)).toBeUndefined();
  });
  it("never mixes it with a diagram's conversation", () => {
    expect(pickThread([thread("view", { kind: "view" }, "sent", "2026-10-23T10:00:00Z")], PROJECT)).toBeUndefined();
    expect(pickThread([project("p", "sent", "2026-10-23T10:00:00Z")], { kind: "view" })).toBeUndefined();
  });
});

describe("pickThread", () => {
  it("picks the unresolved view thread over a resolved one, and the latest of several", () => {
    const threads = [
      thread("done", VIEW, "resolved", "2026-10-23T10:00:00Z"),
      thread("old", VIEW, "answered", "2026-10-23T09:00:00Z"),
      thread("live", VIEW, "sent", "2026-10-23T08:00:00Z"),
    ];
    expect(pickThread(threads, VIEW)?.id).toBe("old");
    expect(pickThread(threads.slice(0, 1), VIEW)).toBeUndefined();
  });
  it("ignores threads about parts, and about another walkthrough", () => {
    const walk: Anchor = { kind: "walkthrough", walkthrough: "tour", label: "The tour" };
    const threads = [
      thread("node", { kind: "node", id: "api", label: "API" }, "sent", "2026-10-23T10:00:00Z"),
      thread("step", { kind: "step", walkthrough: "tour", step: "s1", label: "1. A" }, "sent", "2026-10-23T10:00:00Z"),
      thread("other", { kind: "walkthrough", walkthrough: "other", label: "Other" }, "sent", "2026-10-23T10:00:00Z"),
      thread("view", VIEW, "sent", "2026-10-23T09:00:00Z"),
      thread("walk", walk, "read", "2026-10-23T08:00:00Z"),
    ];
    expect(pickThread(threads, VIEW)?.id).toBe("view");
    expect(pickThread(threads, walk)?.id).toBe("walk");
    expect(pickThread(undefined, VIEW)).toBeUndefined();
  });
});
