// @vitest-environment jsdom
//
// The review model's state transitions (`useReview`), against the in-memory
// transport over the contract-held store: what it reads when, what an event
// makes it read again, and that a read older than a write never puts back
// what the write changed.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import type { Capabilities, NoteContent, NotesForView } from "../src/comments/contract";
import type { CommentsTransport } from "../src/comments/transport";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES } from "../src/comments/contract";

const BOTH: Capabilities = { ...NO_CAPABILITIES, comments: true, notes: true };
const NOTES = [{ path: "a.md", title: "A", markdown: "# A\n\nText.", views: ["v"] }];

function mount(transport: CommentsTransport, capabilities: Capabilities = BOTH, viewId: string | null = "v") {
  const events = createReviewEvents();
  const hook = renderHook(
    (props: { viewId: string | null }) => useReview({ transport, capabilities, viewId: props.viewId, events }),
    {
      initialProps: { viewId },
    },
  );
  return { ...hook, events };
}

describe("useReview", () => {
  it("reads nothing at all without the capabilities", async () => {
    const transport = memoryTransport(NOTES);
    mount(transport, { ...NO_CAPABILITIES, comments: false, notes: false });
    await act(async () => {});
    expect(transport.calls).toEqual([]);
  });

  it("reads the view's threads, its notes, and each note's threads", async () => {
    const transport = memoryTransport(NOTES);
    transport.store.create({ target: "note:a.md", anchor: { kind: "view" }, body: "draft on a note" });
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.notes.status).toBe("ready"));
    await waitFor(() => expect(result.current.threads.get("note:a.md")).toHaveLength(1));
    expect(result.current.threads.get("view:v")).toEqual([]);
    // The note's draft is waiting like the view's would be.
    expect(result.current.pending).toBe(1);
  });

  it("counts every draft in the project, by where it is, as the server says", async () => {
    const transport = memoryTransport(NOTES);
    transport.store.viewTitle = (id) => (id === "w" ? "Elsewhere" : id);
    transport.store.create({ target: "view:w", anchor: { kind: "view" }, body: "not on screen" });
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.pending).toBe(1));
    expect(result.current.pendingTargets).toEqual([{ target: "view:w", title: "Elsewhere", drafts: 1 }]);
  });

  it("counts the drafts it holds when the server cannot say (a version-1 service)", async () => {
    const transport = memoryTransport(NOTES);
    transport.pending = () => Promise.reject(new Error("HTTP 404"));
    transport.store.create({ target: "view:w", anchor: { kind: "view" }, body: "not on screen, not counted" });
    transport.store.create({ target: "view:v", anchor: { kind: "view" }, body: "here" });
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.pending).toBe(1));
    expect(result.current.pendingTargets).toEqual([{ target: "view:v", title: "v", drafts: 1 }]);
  });

  it("reads only comments, without notes, when notes are not offered", async () => {
    const transport = memoryTransport(NOTES);
    const { result } = mount(transport, { ...NO_CAPABILITIES, comments: true, notes: false });
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    expect(transport.calls).not.toContain("listNotes");
  });

  it("reads a target again on its event, and ignores a target it does not show", async () => {
    const transport = memoryTransport(NOTES);
    const { result, events } = mount(transport);
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    transport.store.create({ target: "view:v", anchor: { kind: "view" }, body: "from elsewhere" });
    transport.store.create({ target: "view:other", anchor: { kind: "view" }, body: "not here" });
    const before = transport.calls.length;
    act(() => events.emit({ type: "comments", target: "view:other" }));
    // Only what is pending is read again: a draft anywhere is counted.
    expect(transport.calls.slice(before)).toEqual(["pending"]);
    act(() => events.emit({ type: "comments", target: "view:v" }));
    await waitFor(() => expect(result.current.threads.get("view:v")).toHaveLength(1));
  });

  it("drops a read that was in flight when a write landed", async () => {
    const transport = memoryTransport(NOTES);
    const { result, events } = mount(transport, { ...NO_CAPABILITIES, comments: true, notes: false });
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    // A read starts (it sees no thread)...
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const list = transport.listThreads.bind(transport);
    const stale = list("view:v");
    transport.listThreads = async (target) => {
      const answer = await stale;
      await gate;
      return { ...answer, target };
    };
    act(() => events.emit({ type: "comments", target: "view:v" }));
    // ...a write lands and is shown...
    await act(async () => void (await result.current.actions.create("view:v", { kind: "view" }, "new")));
    expect(result.current.threads.get("view:v")).toHaveLength(1);
    // ...and the older read, answering late, does not take it away.
    await act(async () => {
      release();
      await gate;
    });
    expect(result.current.threads.get("view:v")).toHaveLength(1);
  });

  it("forgets the old view's notes on a page turn", async () => {
    const transport = memoryTransport(NOTES);
    const { result, rerender } = mount(transport);
    await waitFor(() => expect(result.current.notes.notes).toHaveLength(1));
    rerender({ viewId: "w" });
    await waitFor(() => expect(result.current.notes.status).toBe("ready"));
    expect(result.current.notes.notes).toEqual([]);
    expect(result.current.viewTarget).toBe("view:w");
  });

  it("says a refused write in the server's words, and clears it on the next success", async () => {
    const transport = memoryTransport(NOTES);
    const { result } = mount(transport, { ...NO_CAPABILITIES, comments: true, notes: false });
    await waitFor(() => expect(result.current.threads.get("view:v")).toEqual([]));
    transport.fail("createThreadOnce", "the comments file is not JSON");
    await act(async () => void (await result.current.actions.create("view:v", { kind: "view" }, "x")));
    expect(result.current.error).toBe("Could not add the comment: the comments file is not JSON");
    await act(async () => void (await result.current.actions.create("view:v", { kind: "view" }, "x")));
    expect(result.current.error).toBeNull();
  });

  it("reads a note once, and again after it failed", async () => {
    const transport = memoryTransport(NOTES);
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.notes.status).toBe("ready"));
    transport.fail("noteContent", "gone");
    act(() => result.current.actions.openNote("a.md"));
    await waitFor(() => expect(result.current.noteContents.get("a.md")?.status).toBe("error"));
    act(() => result.current.actions.openNote("a.md"));
    await waitFor(() => expect(result.current.noteContents.get("a.md")?.status).toBe("ready"));
    const reads = transport.calls.filter((c) => c === "noteContent").length;
    act(() => result.current.actions.openNote("a.md"));
    expect(transport.calls.filter((c) => c === "noteContent").length).toBe(reads);
  });

  it("two opens of one note in the same moment read it once (speed-round duplicate notes/content)", async () => {
    const transport = memoryTransport(NOTES);
    const { result } = mount(transport);
    await waitFor(() => expect(result.current.notes.status).toBe("ready"));
    act(() => {
      result.current.actions.openNote("a.md");
      result.current.actions.openNote("a.md");
    });
    await waitFor(() => expect(result.current.noteContents.get("a.md")?.status).toBe("ready"));
    expect(transport.calls.filter((c) => c === "noteContent")).toHaveLength(1);
  });

  it("does not restore a direct note read from the view left behind", async () => {
    const transport = memoryTransport([]);
    transport.listNotes = async (viewId) => ({ viewId, notes: [] });
    let releaseContent!: (content: NoteContent) => void;
    transport.noteContent = () =>
      new Promise<NoteContent>((resolve) => {
        releaseContent = resolve;
      });
    const { result, rerender } = mount(transport, { ...NO_CAPABILITIES, comments: false, notes: true }, "v");

    act(() => {
      result.current.actions.openNote("a.md");
    });
    await waitFor(() => expect(result.current.noteContents.get("a.md")?.status).toBe("loading"));
    rerender({ viewId: "w" });
    await waitFor(() => expect(result.current.noteContents.has("a.md")).toBe(false));
    await act(async () => {
      releaseContent({ path: "a.md", frontMatter: {}, markdown: "# Old", revision: "old" });
    });

    expect(result.current.noteContents.has("a.md")).toBe(false);
  });

  it("does not restore a note listing after notes are disabled", async () => {
    const transport = memoryTransport([]);
    let releaseListing!: (notes: NotesForView) => void;
    transport.listNotes = () =>
      new Promise<NotesForView>((resolve) => {
        releaseListing = resolve;
      });
    const capabilities: Capabilities = { ...NO_CAPABILITIES, comments: false, notes: true };
    const events = createReviewEvents();
    const { result, rerender } = renderHook(
      (props: { capabilities: Capabilities }) =>
        useReview({ transport, capabilities: props.capabilities, viewId: "v", events }),
      { initialProps: { capabilities } },
    );

    rerender({ capabilities: { ...NO_CAPABILITIES, comments: false, notes: false } });
    await waitFor(() => expect(result.current.notes.status).toBe("idle"));
    await act(async () => {
      releaseListing({ viewId: "v", notes: [{ path: "a.md", title: "A" }] });
    });

    expect(result.current.notes).toEqual({ status: "idle", notes: [] });
  });
});
