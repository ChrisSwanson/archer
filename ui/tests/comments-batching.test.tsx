// @vitest-environment jsdom
//
// How `useReview` hands thread lists to its reducer: many targets read in the same moment make one update, not
// one each (each `loaded` copies the whole map), and what the agent did is still announced once per change.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadsAction } from "../src/comments/state";

const actions: ThreadsAction[] = [];
vi.mock("../src/comments/state", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/comments/state")>();
  return {
    ...original,
    threadsReducer: (state: Parameters<typeof original.threadsReducer>[0], action: ThreadsAction) => {
      actions.push(action);
      return original.threadsReducer(state, action);
    },
  };
});

import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import { resources } from "../src/app/resources";
import type { TargetRef } from "../src/comments/contract";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES } from "../src/comments/contract";

const noteTargets = (count: number): TargetRef[] =>
  Array.from({ length: count }, (_, i) => `note:n${i}.md` as TargetRef);
const count = (type: ThreadsAction["type"]): number => actions.filter((action) => action.type === type).length;
const activityAnswer = (targets: Record<string, unknown>) =>
  vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, targets }), { status: 200 }));

beforeEach(() => {
  actions.length = 0;
});
afterEach(() => {
  resources.forget();
  vi.unstubAllGlobals();
});

function mount(transport: ReturnType<typeof memoryTransport>, targets: readonly TargetRef[]) {
  const events = createReviewEvents();
  const hook = renderHook(() =>
    useReview({
      transport,
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: null,
      events,
      targets,
    }),
  );
  return { ...hook, events };
}

describe("useReview hands lists to the reducer in batches", () => {
  it("records every target the activity says is empty in one update", async () => {
    vi.stubGlobal("fetch", activityAnswer({}));
    const transport = memoryTransport();
    const { result } = mount(transport, noteTargets(300));
    await waitFor(() => expect(result.current.threads.size).toBe(300));
    expect(count("loaded")).toBe(0);
    expect(count("loadedMany")).toBeLessThanOrEqual(2);
    expect(transport.calls).not.toContain("listThreads");
  });

  it("applies 100 reads that finish together as one update", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 500 })),
    );
    const transport = memoryTransport();
    const targets = noteTargets(100);
    for (const target of targets) transport.store.create({ target, anchor: { kind: "view" }, body: `on ${target}` });
    const { result } = mount(transport, targets);
    await waitFor(() => expect(result.current.threads.size).toBe(100));
    expect(transport.calls.filter((call) => call === "listThreads")).toHaveLength(100);
    expect(count("loaded")).toBe(0);
    expect(count("loadedMany")).toBeLessThanOrEqual(2);
    expect(result.current.threads.get("note:n7.md")).toHaveLength(1);
  });

  it("still announces what the agent did, once, when many reads land together", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 500 })),
    );
    const transport = memoryTransport();
    const targets = noteTargets(100);
    for (const target of targets) transport.store.create({ target, anchor: { kind: "view" }, body: `on ${target}` });
    const { result, events } = mount(transport, targets);
    await waitFor(() => expect(result.current.threads.size).toBe(100));
    const asked = transport.store.submitted()[0] ?? undefined;
    expect(asked).toBeUndefined();
    // One thread goes to the agent and is answered; every target is then read again at once.
    transport.store.submit("note:n42.md");
    await act(async () => {
      events.emit({ type: "comments", target: "note:n42.md" });
    });
    await waitFor(() => expect(result.current.threads.get("note:n42.md")?.[0]?.status).toBe("sent"));
    const thread = transport.store.submitted()[0]!;
    transport.store.agentReply(thread.id, "Answer");
    const before = result.current.announcement?.key ?? 0;
    await act(async () => {
      for (const target of targets) events.emit({ type: "comments", target });
    });
    await waitFor(() => expect(result.current.announcement?.text).toBe("The agent replied on Whole note."));
    expect(result.current.announcement?.key).toBe(before + 1);
  });

  const buffered = async (
    transport: ReturnType<typeof memoryTransport>,
    events: ReturnType<typeof createReviewEvents>,
    target: TargetRef,
  ) => {
    // A read of the target starts and is answered (one thread), so its list waits in the buffer.
    events.emit({ type: "comments", target });
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it("applies a buffered list before a write, so the write's thread is not wiped out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 500 })),
    );
    const transport = memoryTransport();
    const target = "note:a.md" as TargetRef;
    transport.store.create({ target, anchor: { kind: "view" }, body: "first" });
    const { result, events } = mount(transport, [target]);
    await waitFor(() => expect(result.current.threads.get(target)).toHaveLength(1));
    await act(async () => {
      await buffered(transport, events, target);
      await result.current.actions.create(target, { kind: "view" }, "second");
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(result.current.threads.get(target)).toHaveLength(2);
  });

  it("applies a buffered list before an ingested thread", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 500 })),
    );
    const transport = memoryTransport();
    const target = "note:a.md" as TargetRef;
    transport.store.create({ target, anchor: { kind: "view" }, body: "first" });
    const { result, events } = mount(transport, [target]);
    await waitFor(() => expect(result.current.threads.get(target)).toHaveLength(1));
    await act(async () => {
      await buffered(transport, events, target);
      const chat = transport.store.create({ target, anchor: { kind: "view" }, body: "from chat" });
      result.current.actions.ingest!(chat);
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(result.current.threads.get(target)).toHaveLength(2);
  });

  it("applies nothing after unmount, and leaves no timer behind", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 500 })),
    );
    const transport = memoryTransport();
    const target = "note:a.md" as TargetRef;
    transport.store.create({ target, anchor: { kind: "view" }, body: "first" });
    const { result, events, unmount } = mount(transport, [target]);
    await waitFor(() => expect(result.current.threads.get(target)).toHaveLength(1));
    const errors = vi.spyOn(console, "error");
    await act(async () => {
      await buffered(transport, events, target);
    });
    unmount();
    actions.length = 0;
    await new Promise((r) => setTimeout(r, 250));
    expect(actions).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});
