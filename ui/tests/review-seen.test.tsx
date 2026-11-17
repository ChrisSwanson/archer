// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES } from "../src/comments/contract";
import { MAX_SEEN_ENTRIES, MAX_SEEN_TARGET_CHARS, parseSeenState, seenStorageKey } from "../src/comments/review-seen";

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

it("refuses an unencodable project identity without throwing", () => {
  expect(() => seenStorageKey("broken\ud800identity")).not.toThrow();
  expect(seenStorageKey("broken\ud800identity")).toBeNull();
});

it("accepts the comments contract's longest note target and 64-character IDs", () => {
  const target = `note:${"x".repeat(MAX_SEEN_TARGET_CHARS - 8)}.md` as const;
  const id = "x".repeat(64);
  const parsed = parseSeenState(JSON.stringify({ version: 1, entries: [{ target, threadId: id, commentId: id }] }));
  expect(parsed.entries).toEqual([{ target, threadId: id, commentId: id }]);
  expect(
    parseSeenState(JSON.stringify({ version: 1, entries: [{ target: `${target}x`, threadId: id, commentId: id }] }))
      .entries,
  ).toEqual([]);
  expect(
    parseSeenState(JSON.stringify({ version: 1, entries: [{ target: "view:x", threadId: `${id}x`, commentId: id }] }))
      .entries,
  ).toEqual([]);
});

it("marks the newest answer read when the bounded store is already full", async () => {
  localStorage.setItem(
    "archer-comments-seen:v1:demo",
    JSON.stringify({
      version: 1,
      entries: Array.from({ length: MAX_SEEN_ENTRIES }, (_, index) => ({
        target: "view:old",
        threadId: `t${index}`,
        commentId: `c${index}`,
      })),
    }),
  );
  const transport = memoryTransport([]);
  const created = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "Question" });
  transport.store.submit();
  transport.store.agentReply(created.id, "Newest answer");
  const { result } = renderHook(() =>
    useReview({
      transport,
      events: createReviewEvents(),
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: "system",
      projectIdentity: "demo",
    }),
  );
  await waitFor(() => expect(result.current.unreadAnswers).toBe(1));
  act(() => result.current.actions.markSeen?.(result.current.threads.get("view:system")![0]!));
  expect(result.current.unreadAnswers).toBe(0);
});

it("unions distinct answers marked by two stale same-project hooks before a storage event", async () => {
  const answered = (target: `view:${string}`, body: string) => {
    const transport = memoryTransport([]);
    const thread = transport.store.create({ target, anchor: { kind: "view" }, body });
    transport.store.submit();
    transport.store.agentReply(thread.id, `Answer to ${body}`);
    return transport;
  };
  const leftTransport = answered("view:left", "Left");
  const rightTransport = answered("view:right", "Right");
  const left = renderHook(() =>
    useReview({
      transport: leftTransport,
      events: createReviewEvents(),
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: "left",
      projectIdentity: "demo",
    }),
  );
  const right = renderHook(() =>
    useReview({
      transport: rightTransport,
      events: createReviewEvents(),
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: "right",
      projectIdentity: "demo",
    }),
  );
  await waitFor(() => expect(left.result.current.unreadAnswers).toBe(1));
  await waitFor(() => expect(right.result.current.unreadAnswers).toBe(1));
  act(() => left.result.current.actions.markSeen?.(left.result.current.threads.get("view:left")![0]!));
  act(() => right.result.current.actions.markSeen?.(right.result.current.threads.get("view:right")![0]!));
  expect(parseSeenState(localStorage.getItem("archer-comments-seen:v1:demo")).entries).toHaveLength(2);
});

it("stays usable when the browser localStorage getter throws", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("disabled", "SecurityError");
    },
  });
  try {
    const transport = memoryTransport([]);
    const created = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "Question" });
    transport.store.submit();
    transport.store.agentReply(created.id, "Answer");
    const hook = renderHook(() =>
      useReview({
        transport,
        events: createReviewEvents(),
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: "system",
        projectIdentity: "demo",
      }),
    );
    await waitFor(() => expect(hook.result.current.unreadAnswers).toBe(1));
    act(() => hook.result.current.actions.markSeen?.(hook.result.current.threads.get("view:system")![0]!));
    expect(hook.result.current.unreadAnswers).toBe(0);
  } finally {
    if (descriptor !== undefined) Object.defineProperty(globalThis, "localStorage", descriptor);
  }
});

it("keeps an answer read when the same project changes from a view URL to its canonical overview", async () => {
  window.history.replaceState(null, "", "/access-token/p/demo/views/system");
  const transport = memoryTransport([]);
  const thread = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "Question" });
  transport.store.submit();
  transport.store.agentReply(thread.id, "Answer");

  const first = renderHook(() =>
    useReview({
      transport,
      events: createReviewEvents(),
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: "system",
      projectIdentity: "demo",
    }),
  );
  await waitFor(() => expect(first.result.current.unreadAnswers).toBe(1));
  act(() => first.result.current.actions.markAllSeen?.(first.result.current.threads.get("view:system") ?? []));
  expect(first.result.current.unreadAnswers).toBe(0);
  first.unmount();

  window.history.replaceState(null, "", "/p/demo/?overview=1");
  const second = renderHook(() =>
    useReview({
      transport,
      events: createReviewEvents(),
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: "system",
      projectIdentity: "demo",
    }),
  );
  await waitFor(() => expect(second.result.current.threads.get("view:system")).toHaveLength(1));
  expect(second.result.current.unreadAnswers).toBe(0);
});

it("does not confuse colliding comment IDs across targets, threads, or projects", async () => {
  const answer = { id: "same-comment", author: "agent" as const, body: "Answer", createdAt: "2026-10-16T00:00:00Z" };
  const person = { id: "question", author: "person" as const, body: "Question", createdAt: "2026-10-16T00:00:00Z" };
  const thread = (id: string, target: `view:${string}`) => ({
    id,
    target,
    anchor: { kind: "view" as const },
    status: "answered" as const,
    revision: 1,
    comments: [person, answer],
  });
  const threads = [thread("one", "view:a"), thread("two", "view:b")];
  const transport = memoryTransport([]);
  transport.listThreads = async (target) => ({
    schemaVersion: 2,
    target,
    threads: threads.filter((candidate) => candidate.target === target),
  });
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useReview({
      transport,
      events,
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: "a",
      targets: ["view:a", "view:b"],
      projectIdentity: "project-a",
    }),
  );
  await waitFor(() => expect(result.current.unreadAnswers).toBe(2));
  act(() => result.current.actions.markSeen?.(threads[0]!));
  expect(result.current.isUnread?.(threads[0]!)).toBe(false);
  expect(result.current.isUnread?.(threads[1]!)).toBe(true);

  cleanup();
  const other = renderHook(() =>
    useReview({
      transport,
      events: createReviewEvents(),
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: "a",
      targets: ["view:a"],
      projectIdentity: "project-b",
    }),
  );
  await waitFor(() => expect(other.result.current.unreadAnswers).toBe(1));
});

it("syncs an external same-project storage write", async () => {
  const transport = memoryTransport([]);
  const thread = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "Question" });
  transport.store.submit();
  transport.store.agentReply(thread.id, "Answer");
  const { result } = renderHook(() =>
    useReview({
      transport,
      events: createReviewEvents(),
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: "system",
      projectIdentity: "demo",
    }),
  );
  await waitFor(() => expect(result.current.unreadAnswers).toBe(1));
  const loaded = result.current.threads.get("view:system")![0]!;
  const answer = loaded.comments.find((comment) => comment.author === "agent")!;
  const key = "archer-comments-seen:v1:demo";
  localStorage.setItem(
    key,
    JSON.stringify({ version: 1, entries: [{ target: loaded.target, threadId: loaded.id, commentId: answer.id }] }),
  );
  act(() => window.dispatchEvent(new StorageEvent("storage", { key })));
  expect(result.current.unreadAnswers).toBe(0);
});

it("switches project identity without leaking read state and stays usable when storage throws", async () => {
  const transport = memoryTransport([]);
  const created = transport.store.create({ target: "view:system", anchor: { kind: "view" }, body: "Question" });
  transport.store.submit();
  transport.store.agentReply(created.id, "Answer");
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  try {
    const events = createReviewEvents();
    const hook = renderHook(
      ({ projectIdentity }: { projectIdentity: string }) =>
        useReview({
          transport,
          events,
          capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
          viewId: "system",
          projectIdentity,
        }),
      { initialProps: { projectIdentity: "one" } },
    );
    await waitFor(() => expect(hook.result.current.unreadAnswers).toBe(1));
    act(() => hook.result.current.actions.markSeen?.(hook.result.current.threads.get("view:system")![0]!));
    expect(hook.result.current.unreadAnswers).toBe(0);
    hook.rerender({ projectIdentity: "two" });
    await waitFor(() => expect(hook.result.current.unreadAnswers).toBe(1));
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});
