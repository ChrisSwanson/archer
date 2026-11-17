// @vitest-environment jsdom
// G1 (PF-1's last read, review evidence performance-2026-11-02-draft, private, not published): a diagram page read the threads of each
// note about the view as soon as the notes list came in, even one the project's comment activity says has none; it
// depended on whether that list or the inbox's activity answered first (3 of 6 flow-diagram loads read
// `comments?target=note:notes/embedded-families.md`). A listed note's threads are read only when the activity says it
// has some, or cannot say.
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invalidateCommentActivity } from "../src/app/comment-activity";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import type { TargetRef } from "../src/comments/contract";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES } from "../src/comments/contract";

const NOTES = [{ path: "a.md", title: "A", markdown: "# A\n\nText.", views: ["v"] }];
afterEach(() => {
  vi.unstubAllGlobals();
  invalidateCommentActivity();
});

function activity(noteThreads: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!String(url).includes("api/comment-activity")) throw new Error(`unexpected ${url}`);
      const quiet = { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null };
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          agentCommentsListed: true,
          targets: {
            "view:v": quiet,
            "note:a.md":
              noteThreads === 0
                ? quiet
                : {
                    totalThreads: noteThreads,
                    unresolvedThreads: noteThreads,
                    lastCommentedAt: "2026-10-03T10:00:00.000Z",
                  },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

function mount() {
  const transport = memoryTransport(NOTES);
  const read: TargetRef[] = [];
  const list = transport.listThreads;
  transport.listThreads = (target) => {
    read.push(target);
    return list(target);
  };
  const hook = renderHook(() =>
    useReview({
      transport,
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: true },
      viewId: "v",
      events: createReviewEvents(),
    }),
  );
  return { ...hook, transport, read };
}

it("does not read the threads of a listed note the comment activity says has none", async () => {
  activity(0);
  const { result, read } = mount();
  await waitFor(() => expect(result.current.notes.status).toBe("ready"));
  await waitFor(() => expect(result.current.threads.get("note:a.md")).toEqual([]));
  expect(read).not.toContain("note:a.md");
});

it("reads them when the activity says it has threads", async () => {
  activity(1);
  const { result, read, transport } = mount();
  transport.store.create({ target: "note:a.md", anchor: { kind: "view" }, body: "on the note" });
  await waitFor(() => expect(result.current.notes.status).toBe("ready"));
  await waitFor(() => expect(result.current.threads.get("note:a.md")).toHaveLength(1));
  expect(read).toContain("note:a.md");
});
