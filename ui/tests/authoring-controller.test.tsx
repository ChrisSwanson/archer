// @vitest-environment jsdom
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAuthoring } from "../src/authoring/useAuthoring";
import { editorAddress } from "../src/authoring/address";
import { readRecovery } from "../src/authoring/recovery";
import type { AuthoringClient } from "../src/authoring/client";
import type { AuthoringReceipt, AuthoringRequest } from "../../shared/authoring-contract.mts";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
function fixture() {
  const status = {
    authorized: true as const,
    edit: { enabled: true },
    storeId: "store_" + "a".repeat(32),
    generation: "gen_" + "b".repeat(32),
    drafts: [],
    operations: [],
    nextOffset: null,
  };
  const api: AuthoringClient = {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    open: vi.fn(async (target) => ({
      target,
      path: ".archer/example.mmd",
      authoringPath: "example.mmd",
      blockId: null,
      source: "flowchart LR\n a[A]\n",
      sourceRevision: "sha256:" + "c".repeat(64),
      targetRevision: "sha256:" + "f".repeat(64),
      writable: true,
    })),
    preview: vi.fn(async () => ({ envelope: null, diagnostics: [] })),
    edit: vi.fn(async (source: string) => ({ ok: false as const, source, code: "edit_source_mapping_ambiguous" })),
    snapshot: vi.fn(async (draftId, draftRevision) => ({ draftId, draftRevision, source: "saved", valid: true })),
    mutate: vi.fn(
      async (request: AuthoringRequest): Promise<AuthoringReceipt> => ({
        operationId: request.operationId,
        state: "terminal",
        outcome: "saved",
        draft: { draftId: "drf_" + "d".repeat(32), draftRevision: 1 },
        review: { mode: "manual", configRevision: "sha256:" + "e".repeat(64), state: "not_queued_manual" },
      }),
    ),
    operation: vi.fn(async () => null),
  };
  return api;
}
test("failed response is probed without replay, exact persisted envelope is retried only explicitly", async () => {
  const api = fixture();
  vi.mocked(api.mutate).mockRejectedValueOnce(new Error("network response lost"));
  const { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  act(() => result.current.updateSource("flowchart LR\n a[Changed]\n"));
  await waitFor(() => expect(result.current.data?.source).toContain("Changed"));
  act(() => result.current.save());
  await waitFor(() => expect(api.operation).toHaveBeenCalledTimes(1));
  expect(api.mutate).toHaveBeenCalledTimes(1);
  const first = vi.mocked(api.mutate).mock.calls[0]![0],
    data = result.current.data!;
  expect(readRecovery(localStorage, data.key)?.pending).toEqual(first);
  expect(first.operationId).toMatch(/^[a-f0-9]{32}$/);
  expect(first.journalGeneration).toBe("gen_" + "b".repeat(32));
  // Archer has no such operation (claude-11): Save, pressed again, is that same request, sent once more.
  await waitFor(() => expect(result.current.lost?.state).toBe("not-found"));
  act(() => result.current.save());
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.mutate).mock.calls[1]![0]).toEqual(first);
  await waitFor(() => expect(result.current.data?.draftRevision).toBe(1));
  expect(result.current.data?.pending).toBeNull();
});
test("restoring unresolved recovery never submits a write during mount", async () => {
  const api = fixture(),
    address = { target: null, draftId: "drf_" + "d".repeat(32) };
  const first = renderHook(() => useAuthoring("example", address, api));
  await waitFor(() => expect(first.result.current.data).not.toBeNull());
  vi.mocked(api.mutate).mockRejectedValueOnce(new Error("offline"));
  act(() => first.result.current.save());
  await waitFor(() => expect(api.operation).toHaveBeenCalledTimes(1));
  first.unmount();
  const second = renderHook(() => useAuthoring("example", address, api));
  await waitFor(() => expect(second.result.current.data?.pending).not.toBeNull());
  expect(api.mutate).toHaveBeenCalledTimes(1);
  // Reopened, it is checked at once (a read: claude-11), and Check again reads again; nothing is written.
  await waitFor(() => expect(api.operation).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(second.result.current.isBusy()).toBe(false));
  await act(() => second.result.current.probe());
  expect(api.operation).toHaveBeenCalledTimes(3);
  expect(api.mutate).toHaveBeenCalledTimes(1);
});
test("source edits and undo are quiet; refusal never replaces original source", async () => {
  const api = fixture(),
    { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  const original = result.current.data!.source;
  act(() => result.current.updateSource("flowchart LR\n a[Next]\n"));
  expect(api.mutate).not.toHaveBeenCalled();
  await act(() => result.current.edit({ kind: "relabel-node", id: "a", label: "Else" }));
  expect(result.current.data!.source).toContain("Next");
  expect(result.current.error).toContain("Mermaid source");
  expect(result.current.refusal?.code).toBe("edit_source_mapping_ambiguous");
  expect(result.current.error).not.toContain("edit_source_mapping_ambiguous");
  act(() => result.current.undo());
  expect(result.current.data!.source).toBe(original);
  expect(api.mutate).not.toHaveBeenCalled();
});
test("proposal save and Apply use separate requests and preserve original source CAS", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" };
  const { result } = renderHook(() => useAuthoring("example", { target, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data?.opened?.sourceRevision).toBe("sha256:" + "c".repeat(64)));
  act(() => result.current.updateSource("flowchart LR\n a[Next]\n"));
  act(() => result.current.save());
  await waitFor(() => expect(result.current.data?.draftRevision).toBe(1));
  const saved = vi.mocked(api.mutate).mock.calls[0]![0];
  expect(saved.op).toBe("draft.save");
  if (saved.op !== "draft.save") throw new Error("expected save");
  expect(saved.origin).toEqual({
    kind: "document",
    target,
    expectedSourceRevision: "sha256:" + "c".repeat(64),
    expectedTargetRevision: "sha256:" + "f".repeat(64),
    baseSource: "flowchart LR\n a[A]\n",
  });
  act(() => result.current.apply("ignored.mmd"));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(2));
  const applied = vi.mocked(api.mutate).mock.calls[1]![0];
  expect(applied.op).toBe("document.apply");
  if (applied.op !== "document.apply") throw new Error("expected apply");
  expect(applied.target).toEqual(target);
  expect(applied.expectedTargetRevision).toBe("sha256:" + "f".repeat(64));
  expect(applied.expectedSourceRevision).toBe("sha256:" + "c".repeat(64));
  expect(applied.operationId).not.toBe(saved.operationId);
});

test("presentation positions stay in quiet recovery and never change Mermaid or notify the agent", async () => {
  const api = fixture(),
    { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  const source = result.current.data!.source;
  act(() => result.current.setPositions({ start: { x: 250, y: 180 } }));
  expect(result.current.data!.source).toBe(source);
  expect(readRecovery(localStorage, result.current.data!.key)?.positions).toEqual({ start: { x: 250, y: 180 } });
  expect(api.mutate).not.toHaveBeenCalled();
  act(() => result.current.updateSource(source + "\n"));
  act(() => result.current.undo());
  expect(result.current.data!.positions).toEqual({ start: { x: 250, y: 180 } });
});

test("Publish receipt identity makes the next Save Apply to the server-returned target", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "server-created" };
  vi.mocked(api.mutate).mockImplementation(async (request) => ({
    operationId: request.operationId,
    state: "terminal",
    outcome: "created",
    document: {
      target,
      targetRevision: "sha256:" + "a".repeat(64),
      path: ".archer/new.mmd",
      modelRevision: null,
      sourceRevision: "sha256:" + "b".repeat(64),
    },
    review: { mode: "manual", configRevision: "sha256:" + "e".repeat(64), state: "not_queued_manual" },
  }));
  const { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  act(() => result.current.apply("new.mmd"));
  await waitFor(() => expect(result.current.data?.opened?.target).toEqual(target));
  act(() => result.current.updateSource("flowchart LR\n a[Again]\n"));
  act(() => result.current.apply("unused.mmd"));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.mutate).mock.calls[1]![0]).toMatchObject({
    op: "document.apply",
    target,
    expectedTargetRevision: "sha256:" + "a".repeat(64),
    expectedSourceRevision: "sha256:" + "b".repeat(64),
  });
});

test("resumed proposal without a safely resolved original never enables Apply by reinterpreting URL target", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "replacement" },
    draftId = "drf_" + "d".repeat(32);
  vi.mocked(api.status).mockResolvedValue({
    authorized: true,
    edit: { enabled: true },
    storeId: "store_" + "a".repeat(32),
    generation: "gen_" + "b".repeat(32),
    operations: [],
    nextOffset: null,
    drafts: [
      {
        draftId,
        draftRevision: 1,
        state: "open",
        valid: true,
        sourceRevision: "sha256:" + "1".repeat(64),
        savedAt: "2026-10-18T00:00:00Z",
        origin: { kind: "document", path: ".archer/original.mmd", baseSourceRevision: "sha256:" + "c".repeat(64) },
      },
    ],
  });
  const { result } = renderHook(() => useAuthoring("example", { target, draftId }, api));
  await waitFor(() => expect(result.current.data?.opened?.writable).toBe(false));
});

test("node move undo and redo restore presentation without changing source or posting writes", async () => {
  const api = fixture(),
    { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  act(() => result.current.setPositions({ start: { x: 20, y: 30 } }, false));
  act(() => result.current.setPositions({ start: { x: 200, y: 300 } }));
  act(() => result.current.undo());
  expect(result.current.data?.positions).toEqual({ start: { x: 20, y: 30 } });
  act(() => result.current.redo());
  expect(result.current.data?.positions).toEqual({ start: { x: 200, y: 300 } });
  expect(api.mutate).not.toHaveBeenCalled();
});

test("server layout loads without browser recovery; explicit unchanged source Save persists layout once", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" },
    layoutRevision = "sha256:" + "1".repeat(64);
  vi.mocked(api.presentation).mockResolvedValue({
    presentation: {
      revision: layoutRevision,
      sourceRevision: "sha256:" + "c".repeat(64),
      positions: { a: { x: 42, y: 84 } },
    },
  });
  vi.mocked(api.mutate).mockImplementation(async (request) => ({
    operationId: request.operationId,
    state: "terminal",
    outcome: "unchanged",
    document: {
      target,
      targetRevision: "sha256:" + "f".repeat(64),
      path: ".archer/example.mmd",
      sourceRevision: "sha256:" + "c".repeat(64),
      modelRevision: null,
    },
  }));
  const { result } = renderHook(() => useAuthoring("example", { target, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data?.positions).toEqual({ a: { x: 42, y: 84 } }));
  act(() => result.current.setPositions({ a: { x: 100, y: 200 } }));
  act(() => result.current.apply(""));
  await waitFor(() =>
    expect(api.presentation).toHaveBeenCalledWith({
      op: "save",
      target,
      expectedTargetRevision: "sha256:" + "f".repeat(64),
      sourceRevision: "sha256:" + "c".repeat(64),
      expectedRevision: layoutRevision,
      positions: { a: { x: 100, y: 200 } },
    }),
  );
  expect(api.mutate).toHaveBeenCalledTimes(1);
});
test("layout save failure retains positions and never replays canonical Save", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" };
  vi.mocked(api.presentation).mockImplementation(async (request) => {
    if (request.op === "save") throw Error("layout conflict");
    return { presentation: null };
  });
  vi.mocked(api.mutate).mockImplementation(async (request) => ({
    operationId: request.operationId,
    state: "terminal",
    outcome: "applied",
    document: {
      target,
      targetRevision: "sha256:" + "f".repeat(64),
      path: ".archer/example.mmd",
      sourceRevision: "sha256:" + "c".repeat(64),
      modelRevision: null,
    },
  }));
  const { result } = renderHook(() => useAuthoring("example", { target, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data?.opened?.writable).toBe(true));
  act(() => result.current.setPositions({ a: { x: 123, y: 456 } }));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.presentationError).toContain("Diagram saved; layout not saved"));
  expect(result.current.data?.positionsDirty).toBe(true);
  expect(api.mutate).toHaveBeenCalledTimes(1);
  expect(result.current.data?.positions).toEqual({ a: { x: 123, y: 456 } });
});

test("dirty local layout checkpoint wins over server refresh and retains its layout CAS", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" },
    address = { target, draftId: "drf_" + "d".repeat(32) },
    oldRevision = "sha256:" + "1".repeat(64);
  vi.mocked(api.presentation).mockResolvedValue({
    presentation: {
      revision: oldRevision,
      sourceRevision: "sha256:" + "c".repeat(64),
      positions: { a: { x: 10, y: 20 } },
    },
  });
  const first = renderHook(() => useAuthoring("example", address, api));
  await waitFor(() => expect(first.result.current.data?.positions?.a?.x).toBe(10));
  act(() => first.result.current.setPositions({ a: { x: 300, y: 400 } }));
  first.unmount();
  vi.mocked(api.presentation).mockResolvedValue({
    presentation: {
      revision: "sha256:" + "2".repeat(64),
      sourceRevision: "sha256:" + "c".repeat(64),
      positions: { a: { x: 50, y: 60 } },
    },
  });
  const second = renderHook(() => useAuthoring("example", address, api));
  await waitFor(() => expect(second.result.current.data?.positions?.a?.x).toBe(300));
  expect(second.result.current.data?.presentationRevision).toBe(oldRevision);
  expect(api.mutate).not.toHaveBeenCalled();
});

test("Cancel discards source and manual positions to saved state, clears recovery and stays local", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" };
  vi.mocked(api.presentation).mockResolvedValue({
    presentation: {
      revision: "sha256:" + "1".repeat(64),
      sourceRevision: "sha256:" + "c".repeat(64),
      positions: { a: { x: 10, y: 20 } },
    },
  });
  const { result } = renderHook(() => useAuthoring("example", { target, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data?.positions?.a?.x).toBe(10));
  const source = result.current.data!.source,
    key = result.current.data!.key;
  act(() => result.current.updateSource("flowchart TB\n a[Unsaved]\n"));
  act(() => result.current.setPositions({ a: { x: 500, y: 600 } }));
  act(() => result.current.cancel());
  expect(result.current.data?.source).toBe(source);
  expect(result.current.data?.positions).toEqual({ a: { x: 10, y: 20 } });
  expect(localStorage.getItem(key)).toBeNull();
  expect(result.current.canUndo).toBe(false);
  expect(api.mutate).not.toHaveBeenCalled();
});

test("fresh browser discovers unfinished subject without storage; probing is explicit and resolution never replays source", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" },
    operationId = "9".repeat(32),
    operation = { operationId, state: "uncertain" as const, subject: { path: ".archer/example.mmd" } };
  vi.mocked(api.status).mockResolvedValue({
    authorized: true,
    edit: { enabled: true },
    storeId: "store_" + "a".repeat(32),
    generation: "gen_" + "b".repeat(32),
    drafts: [],
    operations: [],
    unfinishedOperations: [{ ...operation, subject: { path: ".archer/other.mmd" } }, operation],
    nextOffset: null,
  });
  vi.mocked(api.operation).mockResolvedValue({
    ...operation,
    current: {
      observed: "matches_base",
      sourceRevision: "sha256:" + "c".repeat(64),
      contentRevision: "sha256:" + "b".repeat(64),
      inferred: true,
    },
  });
  const { result } = renderHook(() => useAuthoring("example", { target, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.unfinished?.operationId).toBe(operationId));
  expect(result.current.data?.pending).toBeNull();
  expect(api.operation).not.toHaveBeenCalled();
  expect(api.mutate).not.toHaveBeenCalled();
  await act(() => result.current.probe());
  await waitFor(() => expect(result.current.unfinished?.current?.observed).toBe("matches_base"));
  expect(api.mutate).not.toHaveBeenCalled();
  act(() => result.current.resolve("abandon"));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.mutate).mock.calls[0]![0]).toMatchObject({
    op: "operation.resolve_uncertain",
    targetOperationId: operationId,
  });
});
test("successful structured edits reuse returned preview without scheduling another compile", async () => {
  vi.useFakeTimers();
  try {
    const api = fixture(),
      { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
    await act(async () => {
      await Promise.resolve();
    });
    await act(() => vi.advanceTimersByTimeAsync(120));
    expect(api.preview).toHaveBeenCalledTimes(1);
    vi.mocked(api.edit).mockResolvedValue({
      ok: true,
      source: "flowchart LR\n a[Result]\n",
      envelope: null,
      diagnostics: [],
    });
    await act(() => result.current.edit({ kind: "relabel-node", id: "a", label: "Result" }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(api.preview).toHaveBeenCalledTimes(1);
    expect(result.current.previewBusy).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("direct Publish reload reopens canonical target and Cancel retains last source/layout checkpoint without a private draft", async () => {
  const api = fixture(),
    draftId = "drf_" + "d".repeat(32),
    address = { target: null, draftId },
    target = { kind: "view" as const, viewId: "published" },
    published = "flowchart LR\n n1[Published]\n",
    positions = { n1: { x: 240, y: 180 } },
    sourceRevision = "sha256:" + "2".repeat(64),
    targetRevision = "sha256:" + "3".repeat(64);
  vi.mocked(api.open).mockResolvedValue({
    target,
    path: ".archer/published.mmd",
    authoringPath: "published.mmd",
    blockId: null,
    source: published,
    sourceRevision,
    targetRevision,
    writable: true,
  });
  vi.mocked(api.presentation).mockResolvedValue({
    presentation: { revision: "sha256:" + "4".repeat(64), sourceRevision, positions },
  });
  vi.mocked(api.mutate).mockImplementation(async (request) => ({
    operationId: request.operationId,
    state: "terminal",
    outcome: "created",
    document: { target, targetRevision, path: ".archer/published.mmd", sourceRevision, modelRevision: null },
  }));
  const first = renderHook(() => useAuthoring("example", address, api));
  await waitFor(() => expect(first.result.current.data).not.toBeNull());
  act(() => first.result.current.updateSource(published));
  act(() => first.result.current.setPositions(positions));
  act(() => first.result.current.apply("published.mmd"));
  await waitFor(() => expect(first.result.current.busy).toBe(false));
  await waitFor(() => expect(first.result.current.data?.opened?.target).toEqual(target));
  first.unmount();
  const reopened = renderHook(() => useAuthoring("example", address, api));
  await waitFor(() => expect(api.open).toHaveBeenCalledWith(target));
  await waitFor(() => expect(reopened.result.current.data?.savedSource).toBe(published));
  expect(reopened.result.current.dirty).toBe(false);
  expect(reopened.result.current.data?.savedPositions).toEqual(positions);
  act(() => reopened.result.current.updateSource("flowchart LR\n n1[Unsaved]\n"));
  act(() => reopened.result.current.setPositions({ n1: { x: 800, y: 700 } }));
  act(() => reopened.result.current.cancel());
  expect(reopened.result.current.data?.source).toBe(published);
  expect(reopened.result.current.data?.positions).toEqual(positions);
  expect(api.mutate).toHaveBeenCalledTimes(1);
});

test("known terminal no-effect after a failed Apply keeps candidate dirty and Cancel restores old canonical checkpoint", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" };
  vi.mocked(api.mutate).mockRejectedValue(new Error("EACCES before publication"));
  vi.mocked(api.operation).mockImplementation(async (operationId) => ({
    operationId,
    state: "terminal",
    outcome: "no_effect",
  }));
  const { result } = renderHook(() => useAuthoring("example", { target, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data?.opened?.writable).toBe(true));
  const original = result.current.data!.source;
  act(() => result.current.updateSource("flowchart LR\n a[Not saved]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.data?.pending).toBeNull());
  await waitFor(() => expect(api.operation).toHaveBeenCalledTimes(1));
  expect(result.current.dirty).toBe(true);
  expect(result.current.data?.savedSource).toBe(original);
  act(() => result.current.cancel());
  expect(result.current.data?.source).toBe(original);
});
test("explicit uncertain confirmation reopens canonical source CAS before the next Save", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" },
    candidate = "flowchart LR\n a[Confirmed]\n",
    sourceRevision = "sha256:" + "7".repeat(64),
    targetRevision = "sha256:" + "f".repeat(64);
  let attempts = 0;
  vi.mocked(api.mutate).mockImplementation(async (request) => {
    attempts++;
    return attempts === 1
      ? {
          operationId: request.operationId,
          state: "uncertain",
          subject: { path: ".archer/example.mmd" },
          current: {
            observed: "matches_candidate",
            sourceRevision,
            contentRevision: "sha256:" + "8".repeat(64),
            inferred: true,
          },
        }
      : {
          operationId: request.operationId,
          state: "terminal",
          outcome: "resolved",
          evidence: "inferred_confirmed",
          current: {
            observed: "matches_candidate",
            sourceRevision,
            contentRevision: "sha256:" + "8".repeat(64),
            inferred: true,
          },
        };
  });
  const { result } = renderHook(() =>
    useAuthoring("example-12345678", { target, draftId: "drf_" + "d".repeat(32) }, api),
  );
  await waitFor(() => expect(result.current.data?.opened?.writable).toBe(true));
  act(() => result.current.updateSource(candidate));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.data?.receipt?.state).toBe("uncertain"));
  await waitFor(() => expect(result.current.busy).toBe(false));
  vi.mocked(api.open).mockResolvedValue({
    target,
    path: ".archer/example.mmd",
    authoringPath: "example.mmd",
    blockId: null,
    source: candidate,
    sourceRevision,
    targetRevision,
    writable: true,
  });
  act(() => result.current.resolve("confirm_candidate"));
  await waitFor(() => expect(result.current.data?.opened?.sourceRevision).toBe(sourceRevision));
  expect(result.current.data?.savedSource).toBe(candidate);
  expect(editorAddress(location.search).checkpoint).toBe("document");
  act(() => result.current.updateSource("flowchart LR\n a[Next]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(3));
  expect(vi.mocked(api.mutate).mock.calls[2]![0]).toMatchObject({
    op: "document.apply",
    expectedSourceRevision: sourceRevision,
  });
});

test("canonical saves supersede an older private draft checkpoint on reload", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" },
    draftId = "drf_" + "d".repeat(32),
    address = { target, draftId },
    privateSource = "flowchart LR\n a[Private]\n",
    latest = "flowchart LR\n a[Latest]\n";
  let disk = "flowchart LR\n a[A]\n",
    revision = 0;
  vi.mocked(api.open).mockImplementation(async () => ({
    target,
    path: ".archer/example.mmd",
    authoringPath: "example.mmd",
    blockId: null,
    source: disk,
    sourceRevision: "sha256:" + String(revision).repeat(64),
    targetRevision: "sha256:" + "f".repeat(64),
    writable: true,
  }));
  vi.mocked(api.mutate).mockImplementation(async (request) => {
    if (request.op === "draft.save")
      return {
        operationId: request.operationId,
        state: "terminal",
        outcome: "saved",
        draft: { draftId, draftRevision: 1 },
      };
    if (request.op !== "document.apply") throw Error("unexpected operation");
    disk = request.source;
    revision++;
    return {
      operationId: request.operationId,
      state: "terminal",
      outcome: "applied",
      document: {
        target,
        targetRevision: "sha256:" + "f".repeat(64),
        path: ".archer/example.mmd",
        sourceRevision: "sha256:" + String(revision).repeat(64),
        modelRevision: null,
      },
    };
  });
  const first = renderHook(() => useAuthoring("example-12345678", address, api));
  await waitFor(() => expect(first.result.current.data).not.toBeNull());
  act(() => first.result.current.updateSource(privateSource));
  await act(() => first.result.current.save());
  await act(() => first.result.current.apply(""));
  act(() => first.result.current.updateSource(latest));
  await act(() => first.result.current.apply(""));
  first.unmount();
  vi.mocked(api.status).mockResolvedValue({
    authorized: true,
    edit: { enabled: true },
    storeId: "store_" + "a".repeat(32),
    generation: "gen_" + "b".repeat(32),
    operations: [],
    nextOffset: null,
    drafts: [
      {
        draftId,
        draftRevision: 1,
        state: "open",
        valid: true,
        sourceRevision: "sha256:" + "1".repeat(64),
        savedAt: "2026-10-18T00:00:00Z",
        origin: { kind: "document", path: ".archer/example.mmd", baseSourceRevision: "sha256:" + "0".repeat(64) },
      },
    ],
  });
  vi.mocked(api.snapshot).mockResolvedValue({ draftId, draftRevision: 1, source: privateSource, valid: true });
  const second = renderHook(() => useAuthoring("example-12345678", address, api));
  await waitFor(() => expect(second.result.current.data?.savedSource).toBe(latest));
  expect(second.result.current.dirty).toBe(false);
  act(() => second.result.current.updateSource("flowchart LR\n a[Discard]\n"));
  act(() => second.result.current.cancel());
  expect(second.result.current.data?.source).toBe(latest);
  expect(second.result.current.data?.opened?.sourceRevision).toBe("sha256:" + "2".repeat(64));
  second.unmount();
  const third = renderHook(() => useAuthoring("example-12345678", editorAddress(location.search), api));
  await waitFor(() => expect(third.result.current.data?.savedSource).toBe(latest));
  expect(third.result.current.data?.source).toBe(latest);
  expect(third.result.current.dirty).toBe(false);
});

test("dirty recovery preserves old edit CAS while Cancel adopts freshly read canonical source", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" },
    address = { target, draftId: "drf_" + "d".repeat(32) };
  const first = renderHook(() => useAuthoring("example", address, api));
  await waitFor(() => expect(first.result.current.data).not.toBeNull());
  act(() => first.result.current.updateSource("flowchart LR\n a[Local unsaved]\n"));
  first.unmount();
  const current = await api.open(target);
  vi.mocked(api.open).mockResolvedValue({
    ...current,
    source: "flowchart LR\n a[External save]\n",
    sourceRevision: "sha256:" + "9".repeat(64),
  });
  const second = renderHook(() => useAuthoring("example", address, api));
  await waitFor(() => expect(second.result.current.data?.savedSource).toContain("External save"));
  expect(second.result.current.data?.source).toContain("Local unsaved");
  expect(second.result.current.data?.opened?.sourceRevision).toBe("sha256:" + "c".repeat(64));
  act(() => second.result.current.cancel());
  expect(second.result.current.data?.source).toContain("External save");
  expect(second.result.current.data?.opened?.sourceRevision).toBe("sha256:" + "9".repeat(64));
});

test("preview transport failure clears the previous diagram instead of validating the new source with stale geometry", async () => {
  const api = fixture();
  vi.mocked(api.preview)
    .mockResolvedValueOnce({ envelope: { old: true }, diagnostics: [] })
    .mockRejectedValue(new Error("compile unavailable"));
  const { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.preview?.envelope).toEqual({ old: true }));
  act(() => result.current.updateSource("flowchart LR\n n1[New]\n"));
  await waitFor(() => expect(result.current.error).toContain("compile unavailable"));
  expect(result.current.preview).toBeNull();
});

test("reload restores only the current subject held source save for explicit manual Send, independent of paged history", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" },
    operationId = "4".repeat(32),
    receipt = {
      operationId,
      state: "terminal" as const,
      outcome: "applied" as const,
      subject: { path: ".archer/example.mmd" },
      review: {
        mode: "manual" as const,
        state: "tracked_held" as const,
        configRevision: "sha256:" + "1".repeat(64),
        reviewId: "rev_" + "2".repeat(32),
        reviewRevision: 1,
      },
    };
  vi.mocked(api.status).mockResolvedValue({
    authorized: true,
    edit: { enabled: true },
    storeId: "store_" + "a".repeat(32),
    generation: "gen_" + "b".repeat(32),
    drafts: [],
    operations: [],
    nextOffset: null,
    heldSourceOperations: [
      { ...receipt, operationId: "3".repeat(32), subject: { path: ".archer/other.mmd" } },
      { ...receipt, operationId: "5".repeat(32), subject: { path: ".archer/example.mmd", blockId: "other" } },
      receipt,
    ],
  });
  const { result } = renderHook(() => useAuthoring("example", { target, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data?.receipt?.operationId).toBe(operationId));
  expect(api.mutate).not.toHaveBeenCalled();
  act(() => result.current.sendOperation());
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.mutate).mock.calls[0]![0]).toMatchObject({
    op: "operation.send",
    targetOperationId: operationId,
  });
});

test("explicit private draft context resumes its snapshot rather than a newer canonical recovery checkpoint", async () => {
  const api = fixture(),
    target = { kind: "view" as const, viewId: "example" },
    draftId = "drf_" + "d".repeat(32);
  vi.mocked(api.mutate).mockImplementation(async (request) => ({
    operationId: request.operationId,
    state: "terminal",
    outcome: "applied",
    document: {
      target,
      targetRevision: "sha256:" + "f".repeat(64),
      path: ".archer/example.mmd",
      sourceRevision: "sha256:" + "2".repeat(64),
      modelRevision: null,
    },
  }));
  const first = renderHook(() => useAuthoring("example", { target, draftId }, api));
  await waitFor(() => expect(first.result.current.data).not.toBeNull());
  act(() => first.result.current.updateSource("flowchart LR\n a[Canonical]\n"));
  await act(() => first.result.current.apply(""));
  first.unmount();
  vi.mocked(api.status).mockResolvedValue({
    authorized: true,
    edit: { enabled: true },
    storeId: "store_" + "a".repeat(32),
    generation: "gen_" + "b".repeat(32),
    operations: [],
    nextOffset: null,
    drafts: [
      {
        draftId,
        draftRevision: 1,
        state: "open",
        valid: true,
        sourceRevision: "sha256:" + "1".repeat(64),
        savedAt: "2026-10-18T00:00:00Z",
        origin: {
          kind: "document",
          path: ".archer/example.mmd",
          baseSourceRevision: "sha256:" + "c".repeat(64),
          target,
          targetRevision: "sha256:" + "f".repeat(64),
        },
      },
    ],
  });
  vi.mocked(api.snapshot).mockResolvedValue({
    draftId,
    draftRevision: 1,
    source: "flowchart LR\n a[Private snapshot]\n",
    valid: true,
  });
  const second = renderHook(() => useAuthoring("example", { target, draftId, checkpoint: "draft" }, api));
  await waitFor(() => expect(second.result.current.data?.draftRevision).toBe(1));
  expect(second.result.current.data?.source).toContain("Private snapshot");
});
test("Save during an in-flight structured edit is queued, then sends the edited source once instead of being dropped", async () => {
  const api = fixture();
  let finish: (value: Awaited<ReturnType<AuthoringClient["edit"]>>) => void = () => {};
  vi.mocked(api.edit).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  let edited: Promise<unknown> = Promise.resolve();
  act(() => {
    edited = result.current.edit({ kind: "relabel-node", id: "a", label: "Edited" });
  });
  await waitFor(() => expect(result.current.busy).toBe(true));
  act(() => result.current.save());
  expect(api.mutate).not.toHaveBeenCalled();
  expect(result.current.writeQueued).toBe(true);
  await act(async () => {
    finish({ ok: true, source: "flowchart LR\n a[Edited]\n", envelope: null, diagnostics: [] });
    await edited;
  });
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  const request = vi.mocked(api.mutate).mock.calls[0]![0];
  expect(request.op).toBe("draft.save");
  expect("source" in request && request.source).toBe("flowchart LR\n a[Edited]\n");
  await waitFor(() => expect(result.current.data?.draftRevision).toBe(1));
  expect(result.current.writeQueued).toBe(false);
  expect(api.mutate).toHaveBeenCalledTimes(1);
});
test("Save while the preview is still pending submits immediately; the preview is reported as pending synchronously", async () => {
  const api = fixture();
  vi.mocked(api.preview).mockImplementation(() => new Promise(() => {}));
  const { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  act(() => result.current.updateSource("flowchart LR\n a[Pending]\n"));
  expect(result.current.previewBusy).toBe(true);
  act(() => result.current.save());
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  expect((vi.mocked(api.mutate).mock.calls[0]![0] as { source: string }).source).toBe("flowchart LR\n a[Pending]\n");
  await waitFor(() => expect(result.current.data?.draftRevision).toBe(1));
});
test("a write requested while another write is in flight runs after it settles rather than returning silently", async () => {
  const api = fixture();
  let finish: (receipt: AuthoringReceipt) => void = () => {};
  const receipt = (request: AuthoringRequest, draftRevision: number): AuthoringReceipt => ({
    operationId: request.operationId,
    state: "terminal",
    outcome: "saved",
    draft: { draftId: "drf_" + "d".repeat(32), draftRevision },
    review: { mode: "manual", configRevision: "sha256:" + "e".repeat(64), state: "not_queued_manual" },
  });
  vi.mocked(api.mutate)
    .mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          finish = () => resolve(receipt(request, 1));
        }),
    )
    .mockImplementationOnce(async (request) => receipt(request, 2));
  const { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  act(() => result.current.save());
  await waitFor(() => expect(result.current.busy).toBe(true));
  act(() => result.current.updateSource("flowchart LR\n a[Second]\n"));
  act(() => result.current.save());
  expect(api.mutate).toHaveBeenCalledTimes(1);
  expect(result.current.writeQueued).toBe(true);
  await act(async () => {
    finish(undefined as never);
  });
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(2));
  const second = vi.mocked(api.mutate).mock.calls[1]![0] as { source: string; expectedDraftRevision: number | null };
  expect(second.source).toBe("flowchart LR\n a[Second]\n");
  expect(second.expectedDraftRevision).toBe(1);
  await waitFor(() => expect(result.current.data?.draftRevision).toBe(2));
});
