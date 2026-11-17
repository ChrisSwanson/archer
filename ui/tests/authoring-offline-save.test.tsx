// @vitest-environment jsdom
// Save while offline (decided 2026-11-02; flows-r1 claude-11, O92): the change is kept in browser recovery as a save that
// has not left this browser, sent once when the connection returns, with its operation identity and the revision the
// person edited from. A save that did leave and got no answer is checked (a read), never resent by itself (ADR 0015/0025).
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAuthoring } from "../src/authoring/useAuthoring";
import { readRecovery } from "../src/authoring/recovery";
import type { AuthoringClient } from "../src/authoring/client";
import type { AuthoringReceipt, AuthoringRequest } from "../../shared/authoring-contract.mts";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
const BASE = "sha256:" + "c".repeat(64),
  TARGET_REV = "sha256:" + "f".repeat(64),
  target = { kind: "view" as const, viewId: "example" },
  draftId = "drf_" + "d".repeat(32);
const applied = (request: AuthoringRequest): AuthoringReceipt =>
  ({
    operationId: request.operationId,
    state: "terminal",
    outcome: "applied",
    document: {
      target,
      targetRevision: TARGET_REV,
      path: ".archer/example.mmd",
      modelRevision: null,
      sourceRevision: "sha256:" + "9".repeat(64),
    },
    review: { mode: "manual", configRevision: "sha256:" + "e".repeat(64), state: "not_queued_manual" },
  }) as AuthoringReceipt;
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
    open: vi.fn(async (t) => ({
      target: t,
      path: ".archer/example.mmd",
      authoringPath: "example.mmd",
      blockId: null,
      source: "flowchart LR\n a[A]\n",
      sourceRevision: BASE,
      targetRevision: TARGET_REV,
      writable: true,
    })),
    preview: vi.fn(async () => ({ envelope: null, diagnostics: [] })),
    edit: vi.fn(async (source: string) => ({ ok: false as const, source, code: "edit_source_mapping_ambiguous" })),
    snapshot: vi.fn(async (id, draftRevision) => ({ draftId: id, draftRevision, source: "saved", valid: true })),
    mutate: vi.fn(async (request: AuthoringRequest) => applied(request)),
    operation: vi.fn(async () => null),
  };
  return api;
}
const address = { target, draftId };
async function opened(api: AuthoringClient, online: boolean) {
  const hook = renderHook(({ on }: { on: boolean }) => useAuthoring("example", address, api, undefined, on), {
    initialProps: { on: online },
  });
  await waitFor(() => expect(hook.result.current.data?.opened?.sourceRevision).toBe(BASE));
  return hook;
}
const stored = (key: string) => readRecovery(localStorage, key);

test("Save while offline sends nothing, keeps the save in browser recovery with its identity and base, and says so", async () => {
  const api = fixture(),
    { result } = await opened(api, false);
  act(() => result.current.updateSource("flowchart LR\n a[Offline]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.held).toBe(true));
  expect(api.mutate).not.toHaveBeenCalled();
  const kept = stored(result.current.data!.key);
  expect(kept?.held).toBe(true);
  expect(kept?.pending).toMatchObject({
    op: "document.apply",
    source: "flowchart LR\n a[Offline]\n",
    expectedSourceRevision: BASE,
    expectedTargetRevision: TARGET_REV,
  });
  expect(kept?.pending?.operationId).toMatch(/^[a-f0-9]{32}$/);
  expect(result.current.error).toBeNull();
});

test("several edits while offline: one held save, the latest text, the same operation identity", async () => {
  const api = fixture(),
    { result, rerender } = await opened(api, false);
  act(() => result.current.updateSource("flowchart LR\n a[One]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.held).toBe(true));
  const id = result.current.data!.pending!.operationId;
  act(() => result.current.updateSource("flowchart LR\n a[Two]\n"));
  act(() => result.current.apply(""));
  act(() => result.current.updateSource("flowchart LR\n a[Three]\n"));
  const kept = stored(result.current.data!.key);
  expect(kept?.pending).toMatchObject({
    operationId: id,
    source: "flowchart LR\n a[Three]\n",
    expectedSourceRevision: BASE,
  });
  expect(api.mutate).not.toHaveBeenCalled();
  rerender({ on: true });
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.mutate).mock.calls[0]![0]).toMatchObject({
    op: "document.apply",
    operationId: id,
    source: "flowchart LR\n a[Three]\n",
    expectedSourceRevision: BASE,
  });
});

test("back online: the held save is sent once, exactly as kept, and acknowledged", async () => {
  const api = fixture(),
    { result, rerender } = await opened(api, false);
  act(() => result.current.updateSource("flowchart LR\n a[Back]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.held).toBe(true));
  const kept = stored(result.current.data!.key)!.pending;
  rerender({ on: true });
  await waitFor(() => expect(result.current.completed).not.toBeNull());
  rerender({ on: false });
  rerender({ on: true });
  window.dispatchEvent(new Event("online"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.mutate).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.mutate).mock.calls[0]![0]).toEqual(kept);
  expect(result.current.held).toBe(false);
  expect(result.current.data?.pending).toBeNull();
});

test("reload while offline: the held save comes back and is sent once when online", async () => {
  const api = fixture(),
    first = await opened(api, false);
  act(() => first.result.current.updateSource("flowchart LR\n a[Reloaded]\n"));
  act(() => first.result.current.apply(""));
  await waitFor(() => expect(first.result.current.held).toBe(true));
  const kept = stored(first.result.current.data!.key)!.pending;
  first.unmount();
  const second = await opened(api, false);
  await waitFor(() => expect(second.result.current.held).toBe(true));
  expect(second.result.current.data?.source).toBe("flowchart LR\n a[Reloaded]\n");
  expect(second.result.current.error).toBeNull();
  expect(api.mutate).not.toHaveBeenCalled();
  second.rerender({ on: true });
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.mutate).mock.calls[0]![0]).toEqual(kept);
});

test("reopened online with a held save: it is sent once on mount", async () => {
  const api = fixture(),
    first = await opened(api, false);
  act(() => first.result.current.updateSource("flowchart LR\n a[Reopened]\n"));
  act(() => first.result.current.apply(""));
  await waitFor(() => expect(first.result.current.held).toBe(true));
  first.unmount();
  const second = renderHook(() => useAuthoring("example", address, api, undefined, true));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(second.result.current.data?.pending).toBeNull());
  expect(api.mutate).toHaveBeenCalledTimes(1);
});

test("the file changed meanwhile: the conflict answer is shown, the person's text is kept, nothing more is sent", async () => {
  const api = fixture();
  vi.mocked(api.mutate).mockImplementation(
    async (request) =>
      ({
        operationId: request.operationId,
        state: "terminal",
        outcome: "conflict",
        conflict: { kind: "source" },
        review: { mode: "manual", configRevision: "sha256:" + "e".repeat(64), state: "not_queued_no_effect" },
      }) as AuthoringReceipt,
  );
  const { result, rerender } = await opened(api, false);
  act(() => result.current.updateSource("flowchart LR\n a[Mine]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.held).toBe(true));
  rerender({ on: true });
  await waitFor(() => expect(result.current.data?.receipt?.outcome).toBe("conflict"));
  expect(result.current.data?.source).toBe("flowchart LR\n a[Mine]\n");
  expect(result.current.data?.pending).toBeNull();
  expect(result.current.completed).toBeNull();
  expect(api.mutate).toHaveBeenCalledTimes(1);
});

test("the browser says offline while the service connection still looks up: the save is held too", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const api = fixture(),
    { result } = await opened(api, true);
  act(() => result.current.updateSource("flowchart LR\n a[NavOffline]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.held).toBe(true));
  expect(api.mutate).not.toHaveBeenCalled();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
});

test("storage full while offline: the page does not claim the change is kept, sends nothing, and the editor stays open", async () => {
  const api = fixture(),
    { result } = await opened(api, false);
  act(() => result.current.updateSource("flowchart LR\n a[Unkept]\n"));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.error).toMatch(/could not keep|not kept/i));
  expect(result.current.held).toBe(false);
  expect(result.current.data?.pending).toBeNull();
  expect(result.current.data?.source).toBe("flowchart LR\n a[Unkept]\n");
  expect(api.mutate).not.toHaveBeenCalled();
});

test("Cancel while a save is held drops it: nothing is sent when the connection returns", async () => {
  const api = fixture(),
    { result, rerender } = await opened(api, false);
  act(() => result.current.updateSource("flowchart LR\n a[Dropped]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.held).toBe(true));
  act(() => result.current.cancel());
  expect(result.current.held).toBe(false);
  expect(result.current.data?.pending).toBeNull();
  rerender({ on: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.mutate).not.toHaveBeenCalled();
});

test('a save that left and got no answer is not resent by itself, and the raw "Failed to fetch" is not shown', async () => {
  const api = fixture();
  vi.mocked(api.mutate).mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const { result, rerender } = await opened(api, true);
  act(() => result.current.updateSource("flowchart LR\n a[Lost]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(api.operation).toHaveBeenCalledTimes(1));
  expect(result.current.error ?? "").not.toMatch(/Failed to fetch/);
  expect(result.current.held).toBe(false);
  rerender({ on: false });
  rerender({ on: true });
  window.dispatchEvent(new Event("online"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.mutate).toHaveBeenCalledTimes(1);
});

test("offline, the Mermaid cannot be checked: that is said as no answer, not as a problem in it, and editing the source goes on", async () => {
  const api = fixture(),
    { result } = await opened(api, false);
  vi.mocked(api.preview).mockRejectedValue(new TypeError("Failed to fetch"));
  vi.mocked(api.edit).mockRejectedValue(new TypeError("Failed to fetch"));
  act(() => result.current.updateSource("flowchart LR\n a[Typed offline]\n"));
  await waitFor(() => expect(result.current.previewUnreachable).toBe(true), { timeout: 2000 });
  expect(result.current.error).toBeNull();
  await act(() => result.current.edit({ kind: "relabel-node", id: "a", label: "Canvas" }));
  expect(result.current.error).not.toMatch(/Failed to fetch/);
  expect(result.current.error).toMatch(/did not answer/);
  expect(result.current.data?.source).toBe("flowchart LR\n a[Typed offline]\n");
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.held).toBe(true));
  expect(result.current.data?.pending).toMatchObject({ source: "flowchart LR\n a[Typed offline]\n" });
});

test("a page being left does not send the held save (Chromium fires online while unloading); a cancelled leave sends it", async () => {
  const api = fixture(),
    { result, rerender } = await opened(api, false);
  act(() => result.current.updateSource("flowchart LR\n a[Leaving]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.held).toBe(true));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    rerender({ on: true });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(api.mutate).not.toHaveBeenCalled();
    expect(result.current.held).toBe(true);
    // Still here a while later: the leave was cancelled, and the held save goes out.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
});
