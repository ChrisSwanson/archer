// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { createReviewEvents } from "../src/comments/events";
import type { NoteContent, NotesForView } from "../src/comments/contract";
import { useReview } from "../src/comments/useReview";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES } from "../src/comments/contract";

it("keeps a directly read note when an older view-note listing finishes later", async () => {
  const transport = memoryTransport([]);
  let releaseListing!: (notes: NotesForView) => void;
  const listing = new Promise<NotesForView>((resolve) => {
    releaseListing = resolve;
  });
  transport.listNotes = () => listing;
  transport.noteContent = async (path): Promise<NoteContent> => ({
    path,
    frontMatter: {},
    markdown: "# Auth design\n\n```mermaid\nflowchart LR\n```",
    revision: "note-revision",
  });

  const { result } = renderHook(() =>
    useReview({
      transport,
      events: createReviewEvents(),
      capabilities: { ...NO_CAPABILITIES, comments: false, notes: true },
      viewId: "notes/auth.md#login-flow",
    }),
  );
  await act(async () => {
    result.current.actions.openNote("notes/auth.md");
  });
  await waitFor(() => expect(result.current.noteContents.get("notes/auth.md")?.status).toBe("ready"));

  await act(async () => {
    releaseListing({ viewId: "notes/auth.md#login-flow", notes: [] });
  });
  expect(result.current.noteContents.get("notes/auth.md")?.status).toBe("ready");
});

it("keeps a direct note whose read finishes before a later inventory response", async () => {
  const transport = memoryTransport([]);
  const listings: Array<(notes: NotesForView) => void> = [];
  transport.listNotes = () =>
    new Promise<NotesForView>((resolve) => {
      listings.push(resolve);
    });
  let releaseContent!: (content: NoteContent) => void;
  transport.noteContent = () =>
    new Promise<NoteContent>((resolve) => {
      releaseContent = resolve;
    });
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useReview({
      transport,
      events,
      capabilities: { ...NO_CAPABILITIES, comments: false, notes: true },
      viewId: "notes/auth.md#login-flow",
    }),
  );

  await waitFor(() => expect(listings).toHaveLength(1));
  await act(async () => {
    listings.shift()!({ viewId: "notes/auth.md#login-flow", notes: [] });
  });
  act(() => {
    result.current.actions.openNote("notes/auth.md");
  });
  act(() => {
    events.emit({ type: "notes", viewId: "notes/auth.md#login-flow" });
  });
  await waitFor(() => expect(listings).toHaveLength(1));
  await act(async () => {
    releaseContent({ path: "notes/auth.md", frontMatter: {}, markdown: "# Auth", revision: "direct-read" });
  });
  await waitFor(() => expect(result.current.noteContents.get("notes/auth.md")?.status).toBe("ready"));

  await act(async () => {
    listings.shift()!({ viewId: "notes/auth.md#login-flow", notes: [] });
  });
  expect(result.current.noteContents.get("notes/auth.md")?.status).toBe("ready");
});

it("keeps cached content explicitly reopened while a new view listing is pending", async () => {
  const transport = memoryTransport([]);
  const listings: Array<(notes: NotesForView) => void> = [];
  transport.listNotes = () =>
    new Promise<NotesForView>((resolve) => {
      listings.push(resolve);
    });
  transport.noteContent = async (path) => ({ path, frontMatter: {}, markdown: "# Auth", revision: "cached" });
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useReview({
      transport,
      events,
      capabilities: { ...NO_CAPABILITIES, comments: false, notes: true },
      viewId: "notes/auth.md#login-flow",
    }),
  );

  await waitFor(() => expect(listings).toHaveLength(1));
  await act(async () => {
    listings.shift()!({ viewId: "notes/auth.md#login-flow", notes: [] });
  });
  await act(async () => {
    result.current.actions.openNote("notes/auth.md");
  });
  await waitFor(() => expect(result.current.noteContents.get("notes/auth.md")?.status).toBe("ready"));

  act(() => {
    events.emit({ type: "notes", viewId: "notes/auth.md#login-flow" });
  });
  await waitFor(() => expect(listings).toHaveLength(1));
  act(() => {
    result.current.actions.openNote("notes/auth.md");
  });
  await act(async () => {
    listings.shift()!({ viewId: "notes/auth.md#login-flow", notes: [] });
  });
  expect(result.current.noteContents.get("notes/auth.md")?.status).toBe("ready");
});

it("does not let an older note-content refresh overwrite a newer one", async () => {
  const transport = memoryTransport([]);
  transport.listNotes = async (viewId) => ({ viewId, notes: [] });
  const reads: Array<(content: NoteContent) => void> = [];
  transport.noteContent = () =>
    new Promise<NoteContent>((resolve) => {
      reads.push(resolve);
    });
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useReview({
      transport,
      events,
      capabilities: { ...NO_CAPABILITIES, comments: false, notes: true },
      viewId: "system",
    }),
  );
  act(() => {
    result.current.actions.openNote("notes/auth.md");
  });
  await waitFor(() => expect(reads).toHaveLength(1));
  await act(async () => {
    reads.shift()!({ path: "notes/auth.md", frontMatter: {}, markdown: "# Initial", revision: "initial" });
  });

  act(() => {
    events.emit({ type: "notes", viewId: "system" });
  });
  act(() => {
    events.emit({ type: "notes", viewId: "system" });
  });
  await waitFor(() => expect(reads).toHaveLength(2));
  const older = reads.shift()!;
  const newer = reads.shift()!;
  await act(async () => {
    newer({ path: "notes/auth.md", frontMatter: {}, markdown: "# Newer", revision: "newer" });
  });
  await act(async () => {
    older({ path: "notes/auth.md", frontMatter: {}, markdown: "# Older", revision: "older" });
  });
  expect(result.current.noteContents.get("notes/auth.md")).toMatchObject({
    status: "ready",
    content: { revision: "newer" },
  });
});

it("does not let an older view-note listing overwrite a newer inventory", async () => {
  const transport = memoryTransport([]);
  const listings: Array<(notes: NotesForView) => void> = [];
  transport.listNotes = () =>
    new Promise<NotesForView>((resolve) => {
      listings.push(resolve);
    });
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useReview({
      transport,
      events,
      capabilities: { ...NO_CAPABILITIES, comments: false, notes: true },
      viewId: "system",
    }),
  );
  await waitFor(() => expect(listings).toHaveLength(1));
  act(() => {
    events.emit({ type: "notes", viewId: "system" });
  });
  await waitFor(() => expect(listings).toHaveLength(2));
  const older = listings.shift()!;
  const newer = listings.shift()!;
  await act(async () => {
    newer({ viewId: "system", notes: [{ path: "new.md", title: "New" }] });
  });
  await act(async () => {
    older({ viewId: "system", notes: [{ path: "old.md", title: "Old" }] });
  });
  expect(result.current.notes.status).toBe("ready");
  expect(result.current.notes.notes.map((note) => note.path)).toEqual(["new.md"]);
});

it("ignores an older note-content failure after a newer refresh succeeds", async () => {
  const transport = memoryTransport([]);
  transport.listNotes = async (viewId) => ({ viewId, notes: [] });
  const reads: Array<{ resolve: (content: NoteContent) => void; reject: (failure: Error) => void }> = [];
  transport.noteContent = () =>
    new Promise<NoteContent>((resolve, reject) => {
      reads.push({ resolve, reject });
    });
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useReview({
      transport,
      events,
      capabilities: { ...NO_CAPABILITIES, comments: false, notes: true },
      viewId: "system",
    }),
  );
  act(() => {
    result.current.actions.openNote("notes/auth.md");
  });
  await waitFor(() => expect(reads).toHaveLength(1));
  await act(async () => {
    reads.shift()!.resolve({ path: "notes/auth.md", frontMatter: {}, markdown: "# Initial", revision: "initial" });
  });
  act(() => {
    events.emit({ type: "notes", viewId: "system" });
  });
  act(() => {
    events.emit({ type: "notes", viewId: "system" });
  });
  await waitFor(() => expect(reads).toHaveLength(2));
  const older = reads.shift()!;
  const newer = reads.shift()!;
  await act(async () => {
    newer.resolve({ path: "notes/auth.md", frontMatter: {}, markdown: "# Newer", revision: "newer" });
  });
  await act(async () => {
    older.reject(new Error("stale failure"));
  });
  expect(result.current.noteContents.get("notes/auth.md")).toMatchObject({
    status: "ready",
    content: { revision: "newer" },
  });
});

it("ignores an older view-note listing failure after a newer inventory succeeds", async () => {
  const transport = memoryTransport([]);
  const listings: Array<{ resolve: (notes: NotesForView) => void; reject: (failure: Error) => void }> = [];
  transport.listNotes = () =>
    new Promise<NotesForView>((resolve, reject) => {
      listings.push({ resolve, reject });
    });
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useReview({
      transport,
      events,
      capabilities: { ...NO_CAPABILITIES, comments: false, notes: true },
      viewId: "system",
    }),
  );
  await waitFor(() => expect(listings).toHaveLength(1));
  act(() => {
    events.emit({ type: "notes", viewId: "system" });
  });
  await waitFor(() => expect(listings).toHaveLength(2));
  const older = listings.shift()!;
  const newer = listings.shift()!;
  await act(async () => {
    newer.resolve({ viewId: "system", notes: [{ path: "new.md", title: "New" }] });
  });
  await act(async () => {
    older.reject(new Error("stale failure"));
  });
  expect(result.current.notes.status).toBe("ready");
  expect(result.current.notes.notes.map((note) => note.path)).toEqual(["new.md"]);
});
