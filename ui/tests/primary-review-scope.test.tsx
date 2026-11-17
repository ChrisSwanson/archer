// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useReview } from "../src/comments/useReview";
import { createReviewEvents } from "../src/comments/events";
import { memoryTransport } from "./support/memory-transport";
import type { TargetRef } from "../src/comments/contract";
import { NO_CAPABILITIES } from "../src/comments/contract";
it("loads unvisited project threads and follows their changes/reconnect without an active diagram", async () => {
  const transport = memoryTransport([]),
    events = createReviewEvents();
  const thread = transport.store.create({
    target: "view:unvisited",
    anchor: { kind: "view" },
    body: "Existing durable review",
  });
  const options = {
    transport,
    events,
    capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
    viewId: null,
    targets: ["view:unvisited", "note:standalone.md"] as readonly TargetRef[],
  };
  const { result } = renderHook(() => useReview(options));
  await waitFor(() => expect(result.current.threads.get("view:unvisited")).toHaveLength(1));
  expect(result.current.threads.get("view:unvisited")?.[0].id).toBe(thread.id);
  transport.store.create({ target: "note:standalone.md", anchor: { kind: "view" }, body: "Unrelated note feedback" });
  act(() => events.emit({ type: "comments", target: "note:standalone.md" }));
  await waitFor(() => expect(result.current.threads.get("note:standalone.md")).toHaveLength(1));
  transport.store.create({ target: "view:unvisited", anchor: { kind: "view" }, body: "During disconnected interval" });
  act(() => events.emit({ type: "reconnect" }));
  await waitFor(() => expect(result.current.threads.get("view:unvisited")).toHaveLength(2));
  expect(result.current.pending).toBe(3);
});
it("refreshes an open standalone note on its event with no diagram selected", async () => {
  const notes = [{ path: "standalone.md", title: "Standalone", markdown: "# Before", views: [] }];
  const transport = memoryTransport(notes),
    events = createReviewEvents();
  const { result } = renderHook(() =>
    useReview({ transport, events, capabilities: { ...NO_CAPABILITIES, comments: true, notes: true }, viewId: null }),
  );
  act(() => result.current.actions.openNote("standalone.md"));
  await waitFor(() => expect(result.current.noteContents.get("standalone.md")?.status).toBe("ready"));
  const before = transport.calls.filter((c) => c === "noteContent").length;
  act(() => events.emit({ type: "notes" }));
  await waitFor(() => expect(transport.calls.filter((c) => c === "noteContent")).toHaveLength(before + 1));
});

it("holds a saved comment as a draft and publishes nothing until asked", async () => {
  localStorage.clear();
  const transport = memoryTransport([]),
    events = createReviewEvents();
  const held = transport.store.create({
    target: "view:system",
    anchor: { kind: "view" },
    body: "Keep this sibling held",
  });
  const { result } = renderHook(() =>
    useReview({
      transport,
      events,
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
      viewId: "system",
    }),
  );
  await waitFor(() => expect(result.current.threads.get("view:system")).toHaveLength(1));
  let saved: Awaited<ReturnType<typeof result.current.actions.create>> = null;
  await act(async () => {
    saved = await result.current.actions.create("view:system", { kind: "view" }, "Saved, not published");
  });
  expect(saved).not.toBeNull();
  expect(transport.store.list("view:system").map((thread) => thread.status)).toEqual(["draft", "draft"]);
  expect(transport.store.list("view:system")[0].id).toBe(held.id);
  expect(transport.calls).not.toContain("submit");
  expect(transport.calls).not.toContain("submitOnce");
  expect(result.current.error).toBeNull();
  expect(result.current.pending).toBe(2);
});

it("reads only the targets whose comment activity has threads, each once as it arrives", async () => {
  const { resources } = await import("../src/app/resources");
  resources.forget();
  const transport = memoryTransport([]),
    events = createReviewEvents();
  transport.store.create({ target: "view:busy", anchor: { kind: "view" }, body: "A thread" });
  const activity = {
    schemaVersion: 1,
    targets: {
      "view:busy": { totalThreads: 1, unresolvedThreads: 1, lastCommentedAt: null },
      "view:quiet": { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null },
    },
  };
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => activity }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  try {
    let targets: readonly TargetRef[] = ["view:busy", "view:quiet"];
    const { result, rerender } = renderHook(() =>
      useReview({
        transport,
        events,
        capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
        viewId: null,
        targets,
      }),
    );
    await waitFor(() => expect(result.current.threads.get("view:busy")).toHaveLength(1));
    expect(result.current.threads.get("view:quiet")).toEqual([]);
    const listed = () => transport.calls.filter((call) => call === "listThreads").length;
    expect(listed()).toBe(1);
    targets = ["view:busy", "view:quiet", "view:added"];
    rerender();
    await waitFor(() => expect(result.current.threads.get("view:added")).toEqual([]));
    expect(listed()).toBe(1);
    transport.store.create({ target: "view:quiet", anchor: { kind: "view" }, body: "Now there is one" });
    act(() => events.emit({ type: "comments", target: "view:quiet" }));
    await waitFor(() => expect(result.current.threads.get("view:quiet")).toHaveLength(1));
  } finally {
    vi.unstubAllGlobals();
  }
});
