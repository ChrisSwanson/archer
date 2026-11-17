// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewEvents } from "../src/comments/events";
import type { NoteEmphasisRead, UpsertNoteEmphasisInput } from "../src/comments/contract";
import type { CommentsTransport } from "../src/comments/transport";
import { highlightSaveResult, useNoteEmphasis } from "../src/comments/useNoteEmphasis";

afterEach(cleanup);
const path = "notes/context.md";
const value = (revision: number): NoteEmphasisRead => ({
  snapshot: { schemaVersion: 1, notePath: path, revision, emphases: [] },
  orphans: [],
});
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function transport(options: Partial<CommentsTransport> = {}): CommentsTransport {
  return {
    listThreads: async (target) => ({ schemaVersion: 2, target, threads: [] }),
    createThreadOnce: async () => {
      throw new Error("unused");
    },
    replyOnce: async () => {
      throw new Error("unused");
    },
    edit: async () => {
      throw new Error("unused");
    },
    remove: async () => {
      throw new Error("unused");
    },
    resolve: async () => {},
    dismiss: async () => {},
    pending: async () => ({ total: 0, targets: [] }),
    submitOnce: async () => {
      throw new Error("unused");
    },
    listNotes: async (viewId) => ({ viewId, notes: [] }),
    noteContent: async () => {
      throw new Error("unused");
    },
    noteEmphasis: async () => {
      throw new Error("unused");
    },
    upsertNoteEmphasis: async () => {
      throw new Error("unused");
    },
    ...options,
  };
}

it("refreshes every opened note through note-emphasis and reconnect events", async () => {
  let revision = 1;
  const read = vi.fn(async () => value(revision));
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({ enabled: true, transport: transport({ noteEmphasis: read }), events }),
  );
  act(() => result.current.open(path));
  await waitFor(() =>
    expect(result.current.states.get(path)).toMatchObject({ status: "ready", read: { snapshot: { revision: 1 } } }),
  );
  revision = 2;
  act(() => events.emit({ type: "note-emphasis", notePath: path }));
  await waitFor(() =>
    expect(result.current.states.get(path)).toMatchObject({ status: "ready", read: { snapshot: { revision: 2 } } }),
  );
  revision = 3;
  act(() => events.emit({ type: "reconnect" }));
  await waitFor(() =>
    expect(result.current.states.get(path)).toMatchObject({ status: "ready", read: { snapshot: { revision: 3 } } }),
  );
  expect(read).toHaveBeenCalledTimes(3);
});

it("reloads the current snapshot after a stale CAS refusal and exposes the conflict", async () => {
  const read = vi.fn(async () => value(8));
  const upsert = vi.fn(async (_input: UpsertNoteEmphasisInput) => {
    throw new Error("revision changed");
  });
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({
      enabled: true,
      transport: transport({ noteEmphasis: read, upsertNoteEmphasis: upsert }),
      events,
    }),
  );
  act(() => result.current.open(path));
  await waitFor(() => expect(result.current.states.get(path)?.status).toBe("ready"));
  let saved: string = "saved";
  await act(async () => {
    saved = await result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 7 });
  });
  expect(saved).toBe("refused");
  expect(result.current.states.get(path)).toMatchObject({
    status: "ready",
    read: { snapshot: { revision: 8 } },
    error: expect.stringContaining("revision changed"),
  });
  expect(read).toHaveBeenCalledTimes(2);
});

it("says a refusal that ends in a full stop with one full stop (O40)", async () => {
  const upsert = vi.fn(async (_input: UpsertNoteEmphasisInput) => {
    throw new Error("note emphasis revision 2 is stale; the current revision is 3. Nothing was written.");
  });
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({
      enabled: true,
      transport: transport({ noteEmphasis: vi.fn(async () => value(3)), upsertNoteEmphasis: upsert }),
      events,
    }),
  );
  act(() => result.current.open(path));
  await waitFor(() => expect(result.current.states.get(path)?.status).toBe("ready"));
  await act(async () => {
    await result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 2 });
  });
  expect(result.current.states.get(path)).toMatchObject({
    error:
      "Could not save highlights: note emphasis revision 2 is stale; the current revision is 3. Nothing was written. The current highlights were reloaded; try again.",
  });
});

it("a save whose answer was lost is not said as 'Could not save': what Archer holds is reloaded and shown (write sweep)", async () => {
  const upsert = vi.fn(async (_input: UpsertNoteEmphasisInput) => {
    throw new TypeError("Failed to fetch");
  });
  const read = vi.fn(async () => value(3));
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({
      enabled: true,
      transport: transport({ noteEmphasis: read, upsertNoteEmphasis: upsert }),
      events,
    }),
  );
  act(() => result.current.open(path));
  await waitFor(() => expect(result.current.states.get(path)?.status).toBe("ready"));
  await act(async () => {
    await result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 3 });
  });
  const state = result.current.states.get(path);
  expect(state).toMatchObject({ status: "ready", error: expect.stringMatching(/may have been saved or not/) });
  expect(state?.status === "ready" ? state.error : "").not.toMatch(/Could not/);
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps a stale-save conflict visible when an SSE refresh overtakes its recovery load", async () => {
  let resolveRecovery!: (read: NoteEmphasisRead) => void;
  const recovery = new Promise<NoteEmphasisRead>((resolve) => {
    resolveRecovery = resolve;
  });
  const read = vi.fn().mockResolvedValueOnce(value(7)).mockReturnValueOnce(recovery).mockResolvedValueOnce(value(8));
  const upsert = vi.fn(async (_input: UpsertNoteEmphasisInput) => {
    throw new Error("revision changed");
  });
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({
      enabled: true,
      transport: transport({ noteEmphasis: read, upsertNoteEmphasis: upsert }),
      events,
    }),
  );
  act(() => result.current.open(path));
  await waitFor(() => expect(result.current.states.get(path)?.status).toBe("ready"));

  let save!: Promise<string>;
  act(() => {
    save = result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 7 });
  });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  act(() => events.emit({ type: "note-emphasis", notePath: path }));
  await waitFor(() =>
    expect(result.current.states.get(path)).toMatchObject({ status: "ready", read: { snapshot: { revision: 8 } } }),
  );
  await act(async () => {
    resolveRecovery(value(8));
    await save;
  });

  expect(result.current.states.get(path)).toMatchObject({
    status: "ready",
    read: { snapshot: { revision: 8 } },
    error: expect.stringContaining("revision changed"),
  });
});

it("does not let an older successful save clear a newer save failure", async () => {
  const older = deferred<NoteEmphasisRead>();
  const read = vi.fn(async () => value(9));
  const upsert = vi.fn().mockReturnValueOnce(older.promise).mockRejectedValueOnce(new Error("revision changed"));
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({
      enabled: true,
      transport: transport({ noteEmphasis: read, upsertNoteEmphasis: upsert }),
      events,
    }),
  );
  act(() => result.current.open(path));
  await waitFor(() => expect(result.current.states.get(path)?.status).toBe("ready"));

  let olderSave!: Promise<string>;
  let newerSave!: Promise<string>;
  act(() => {
    olderSave = result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 7 });
    newerSave = result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 8 });
  });
  await act(async () => {
    await newerSave;
  });
  expect(result.current.states.get(path)).toMatchObject({
    status: "ready",
    error: expect.stringContaining("revision changed"),
  });
  await act(async () => {
    older.resolve(value(8));
    await olderSave;
  });

  expect(result.current.states.get(path)).toMatchObject({
    status: "ready",
    error: expect.stringContaining("revision changed"),
  });
});

it("does not let an older failed save reinstate an error after a newer save succeeds", async () => {
  const older = deferred<NoteEmphasisRead>();
  const read = vi.fn(async () => value(9));
  const upsert = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValueOnce(value(9));
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({
      enabled: true,
      transport: transport({ noteEmphasis: read, upsertNoteEmphasis: upsert }),
      events,
    }),
  );
  act(() => result.current.open(path));
  await waitFor(() => expect(result.current.states.get(path)?.status).toBe("ready"));

  let olderSave!: Promise<string>;
  let newerSave!: Promise<string>;
  act(() => {
    olderSave = result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 7 });
    newerSave = result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 8 });
  });
  await act(async () => {
    await newerSave;
  });
  older.reject(new Error("old revision changed"));
  await act(async () => {
    await olderSave;
  });

  expect(result.current.states.get(path)).toMatchObject({ status: "ready", read: { snapshot: { revision: 9 } } });
  expect(result.current.states.get(path)).not.toHaveProperty("error");
  expect(read).toHaveBeenCalledTimes(1);
});

it("clears a retained save failure after the person's next successful save", async () => {
  const read = vi.fn(async () => value(8));
  const upsert = vi.fn().mockRejectedValueOnce(new Error("revision changed")).mockResolvedValueOnce(value(9));
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({
      enabled: true,
      transport: transport({ noteEmphasis: read, upsertNoteEmphasis: upsert }),
      events,
    }),
  );
  act(() => result.current.open(path));
  await waitFor(() => expect(result.current.states.get(path)?.status).toBe("ready"));
  await act(async () => {
    await result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 7 });
  });
  expect(result.current.states.get(path)).toMatchObject({
    status: "ready",
    error: expect.stringContaining("revision changed"),
  });

  await act(async () => {
    await result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 8 });
  });

  expect(result.current.states.get(path)).toMatchObject({ status: "ready", read: { snapshot: { revision: 9 } } });
  expect(result.current.states.get(path)).not.toHaveProperty("error");
});

it("clears a retained save failure without replacing a newer SSE snapshot", async () => {
  const retry = deferred<NoteEmphasisRead>();
  const read = vi.fn().mockResolvedValueOnce(value(7)).mockResolvedValueOnce(value(8)).mockResolvedValueOnce(value(9));
  const upsert = vi.fn().mockRejectedValueOnce(new Error("revision changed")).mockReturnValueOnce(retry.promise);
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({
      enabled: true,
      transport: transport({ noteEmphasis: read, upsertNoteEmphasis: upsert }),
      events,
    }),
  );
  act(() => result.current.open(path));
  await waitFor(() => expect(result.current.states.get(path)?.status).toBe("ready"));
  await act(async () => {
    await result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 7 });
  });
  expect(result.current.states.get(path)).toMatchObject({
    status: "ready",
    error: expect.stringContaining("revision changed"),
  });

  let retrySave!: Promise<string>;
  act(() => {
    retrySave = result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 8 });
  });
  act(() => events.emit({ type: "note-emphasis", notePath: path }));
  await waitFor(() =>
    expect(result.current.states.get(path)).toMatchObject({ status: "ready", read: { snapshot: { revision: 9 } } }),
  );
  await act(async () => {
    retry.resolve(value(8));
    await retrySave;
  });

  expect(result.current.states.get(path)).toMatchObject({ status: "ready", read: { snapshot: { revision: 9 } } });
  expect(result.current.states.get(path)).not.toHaveProperty("error");
});

it("ignores a pending save after note-emphasis support is disabled", async () => {
  const pending = deferred<NoteEmphasisRead>();
  const read = vi.fn(async () => value(7));
  const upsert = vi.fn(() => pending.promise);
  const events = createReviewEvents();
  const { result, rerender } = renderHook(
    ({ enabled }) =>
      useNoteEmphasis({ enabled, transport: transport({ noteEmphasis: read, upsertNoteEmphasis: upsert }), events }),
    { initialProps: { enabled: true } },
  );
  act(() => result.current.open(path));
  await waitFor(() => expect(result.current.states.get(path)?.status).toBe("ready"));
  let save!: Promise<string>;
  act(() => {
    save = result.current.save({ notePath: path, id: "reader-highlights", groups: [], expectedRevision: 7 });
  });
  rerender({ enabled: false });
  expect(result.current.states.size).toBe(0);

  pending.reject(new Error("late revision changed"));
  await act(async () => {
    await save;
  });

  expect(result.current.states.size).toBe(0);
  expect(read).toHaveBeenCalledTimes(1);
});

it("does not call highlight routes when an older bootstrap lacks the capability", () => {
  const read = vi.fn(async () => value(1));
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({ enabled: false, transport: transport({ noteEmphasis: read }), events }),
  );
  act(() => {
    result.current.open(path);
    events.emit({ type: "note-emphasis", notePath: path });
    events.emit({ type: "reconnect" });
  });
  expect(read).not.toHaveBeenCalled();
  expect(result.current.states.size).toBe(0);
});

it("two opens of one note in the same moment read its highlights once (speed-round duplicate note-emphases)", async () => {
  const read = vi.fn(async () => value(1));
  const events = createReviewEvents();
  const { result } = renderHook(() =>
    useNoteEmphasis({ enabled: true, transport: transport({ noteEmphasis: read }), events }),
  );
  act(() => {
    result.current.open(path);
    result.current.open(path);
  });
  await waitFor(() => expect(result.current.states.get(path)).toMatchObject({ status: "ready" }));
  expect(read).toHaveBeenCalledTimes(1);
});

// codex-402 / claude-406 (O130): a lost answer is read back, and its outcome reaches the form as it is: landed = saved
// (the form closes, no failure said); not there = uncertain (the same words as the legend), never "did not save".
const passage = {
  kind: "passage" as const,
  quote: "creates a payment session",
  prefix: "The Shop API ",
  suffix: " with the payment",
};
const input: UpsertNoteEmphasisInput = {
  notePath: path,
  id: "reader-highlights",
  title: "Reader highlights",
  groups: [{ id: "sweep", label: "Sweep saved highlight", passages: [passage] }],
  expectedRevision: 1,
};
const landed: NoteEmphasisRead = {
  snapshot: {
    schemaVersion: 1,
    notePath: path,
    revision: 2,
    emphases: [
      {
        id: "reader-highlights",
        title: "Reader highlights",
        author: "person",
        groups: [{ id: "sweep", label: "Sweep saved highlight", palette: "a", passages: [passage] }],
      },
    ],
  },
  orphans: [],
} as unknown as NoteEmphasisRead;
it.each([
  ["landed", landed, "saved"],
  ["not there", value(1), "uncertain"],
] as const)("a lost save read back %s: %s", async (_label, after, outcome) => {
  let reads = 0;
  const read = vi.fn(async () => (reads++ === 0 ? value(1) : after));
  const upsert = vi.fn(async (_i: UpsertNoteEmphasisInput) => {
    throw new TypeError("Failed to fetch");
  });
  const { result } = renderHook(() =>
    useNoteEmphasis({
      enabled: true,
      transport: transport({ noteEmphasis: read, upsertNoteEmphasis: upsert }),
      events: createReviewEvents(),
    }),
  );
  act(() => result.current.open(path));
  await waitFor(() => expect(result.current.states.get(path)?.status).toBe("ready"));
  let got = "";
  await act(async () => {
    got = await result.current.save(input);
  });
  expect(got).toBe(outcome);
  const state = result.current.states.get(path);
  const legend = state?.status === "ready" ? state.error : undefined;
  const form = highlightSaveResult(got as "saved" | "refused" | "uncertain");
  if (outcome === "saved") {
    expect(form).toEqual({ ok: true });
    expect(legend).toBeUndefined();
  } else {
    expect(form.ok).toBe(false);
    const said = form.ok ? "" : form.problem;
    expect(said).toMatch(/may have been saved or not/);
    expect(said).not.toMatch(/did not save/);
    expect(legend).toMatch(/may have been saved or not/);
  }
});
