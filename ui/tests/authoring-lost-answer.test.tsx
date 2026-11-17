// @vitest-environment jsdom
// flows-r1 claude-11 remainder: a Save whose answer is lost while the page believes it is connected. The page asks
// Archer at once whether the save happened (a status read, never a resend: ADR 0015 forbids an automatic retry of a
// mutation), then says plainly "Saved", or "Not known yet" (no record so far; looked for again) with Save again; Save again sends the same operation (ADR 0016).
import { act, renderHook, waitFor, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAuthoring } from "../src/authoring/useAuthoring";
import { AuthoringWorkspace } from "../src/authoring/AuthoringWorkspace";
import type { AuthoringClient } from "../src/authoring/client";
import type { AuthoringReceipt, AuthoringRequest } from "../../shared/authoring-contract.mts";
import { loadModelEnvelope } from "./fixtures";
vi.mock("../src/source-editor/lazy", () => ({ useSourceEditor: () => null, preloadSourceEditor: async () => null }));
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
    snapshot: vi.fn(),
    mutate: vi.fn(async (request: AuthoringRequest) => applied(request)),
    operation: vi.fn(async () => null),
  } as unknown as AuthoringClient;
  return api;
}
async function opened(api: AuthoringClient) {
  const hook = renderHook(() => useAuthoring("example", { target, draftId }, api, undefined, true));
  await waitFor(() => expect(hook.result.current.data?.opened?.sourceRevision).toBe(BASE));
  return hook;
}
const lose = (api: AuthoringClient) => vi.mocked(api.mutate).mockRejectedValueOnce(new TypeError("Failed to fetch"));

test("answer lost, Archer never got it: the page checks at once and says Not saved; Save again sends the same operation", async () => {
  const api = fixture();
  lose(api);
  const { result } = await opened(api);
  act(() => result.current.updateSource("flowchart LR\n a[Lost]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.lost?.state).toBe("not-found"));
  expect(api.operation).toHaveBeenCalledTimes(1);
  expect(api.mutate).toHaveBeenCalledTimes(1);
  const first = vi.mocked(api.mutate).mock.calls[0]![0];
  // Save, pressed again, is that same save: no new identity, no second effect.
  act(() => result.current.apply(""));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.mutate).mock.calls[1]![0]).toEqual(first);
  await waitFor(() => expect(result.current.completed).not.toBeNull());
  expect(result.current.lost).toBeNull();
  expect(result.current.error).toBeNull();
});

test("answer lost, the save did happen: the page checks at once and says it is saved, without sending it again", async () => {
  const api = fixture();
  lose(api);
  vi.mocked(api.operation).mockImplementation(async (id) =>
    applied({ op: "document.apply", operationId: id } as AuthoringRequest),
  );
  const { result } = await opened(api);
  act(() => result.current.updateSource("flowchart LR\n a[Landed]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.completed).not.toBeNull());
  expect(api.mutate).toHaveBeenCalledTimes(1);
  expect(result.current.lost).toBeNull();
  expect(result.current.error).toBeNull();
  expect(result.current.data?.pending).toBeNull();
});

test("answer lost and the check gets no answer either: not known, Check again asks once more, nothing is resent", async () => {
  const api = fixture();
  lose(api);
  vi.mocked(api.operation).mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const { result } = await opened(api);
  act(() => result.current.updateSource("flowchart LR\n a[Unknown]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.lost?.state).toBe("unknown"));
  act(() => result.current.apply(""));
  expect(api.mutate).toHaveBeenCalledTimes(1);
  await act(() => result.current.probe());
  expect(result.current.lost?.state).toBe("not-found");
  expect(api.mutate).toHaveBeenCalledTimes(1);
});

test("reopened with a save whose answer was lost: the page checks it at once, and sends nothing by itself", async () => {
  const api = fixture();
  lose(api);
  const first = await opened(api);
  act(() => first.result.current.updateSource("flowchart LR\n a[Reopened]\n"));
  act(() => first.result.current.apply(""));
  await waitFor(() => expect(first.result.current.lost?.state).toBe("not-found"));
  first.unmount();
  const second = await opened(api);
  await waitFor(() => expect(second.result.current.lost?.state).toBe("not-found"));
  expect(api.operation).toHaveBeenCalledTimes(2);
  expect(api.mutate).toHaveBeenCalledTimes(1);
});

test("the editor says Not saved and offers Save again, in plain words", async () => {
  window.history.replaceState(null, "", `/p/example/edit/?viewId=example&draftId=${draftId}`);
  const api = fixture();
  lose(api);
  api.preview = vi.fn(async () => ({ envelope: loadModelEnvelope("flowchart", "minimal"), diagnostics: [] }));
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  const toggle = await screen.findByRole("button", { name: "Mermaid source" }, { timeout: 5000 });
  if (toggle.getAttribute("aria-pressed") !== "true") fireEvent.click(toggle);
  const text = await waitFor(() => {
    const t = document.querySelector("textarea#authoring-source");
    if (!t) throw new Error("no source yet");
    return t as HTMLTextAreaElement;
  });
  fireEvent.change(text, { target: { value: "flowchart LR\n a[Typed]\n" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(), { timeout: 5000 });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(document.querySelector(".authoring-statusline")?.textContent).toMatch(
      /Not known yet whether your change reached Archer/,
    ),
  );
  expect(screen.getByRole("button", { name: "Save again" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry same request" })).toBeNull();
  expect(document.body.textContent).not.toMatch(/durable operation|Retry explicitly|unresolved/i);
  fireEvent.click(screen.getByRole("button", { name: "Save again" }));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.mutate).mock.calls[1]![0].operationId).toBe(vi.mocked(api.mutate).mock.calls[0]![0].operationId);
});

test("Not saved: Cancel drops that save (it never reached Archer) and sends nothing", async () => {
  const api = fixture();
  lose(api);
  const { result } = await opened(api);
  act(() => result.current.updateSource("flowchart LR\n a[Dropped]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.lost?.state).toBe("not-found"));
  act(() => result.current.cancel());
  expect(result.current.data?.pending).toBeNull();
  expect(result.current.lost).toBeNull();
  expect(result.current.data?.source).toBe("flowchart LR\n a[A]\n");
  expect(api.mutate).toHaveBeenCalledTimes(1);
});

test('no record at first, then the save arrives at Archer a moment later (claude-307): checked again by itself, said as saved, never "Not saved"', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const api = fixture();
    lose(api);
    let landed = false;
    vi.mocked(api.operation).mockImplementation(async (id) =>
      landed ? applied({ op: "document.apply", operationId: id } as AuthoringRequest) : null,
    );
    const { result } = await opened(api);
    act(() => result.current.updateSource("flowchart LR\n a[Late]\n"));
    act(() => result.current.apply(""));
    await waitFor(() => expect(result.current.lost?.state).toBe("not-found"));
    landed = true;
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    await waitFor(() => expect(result.current.completed).not.toBeNull());
    expect(result.current.lost).toBeNull();
    expect(api.mutate).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

// claude-407 (O133): after the last look (15 s) the editor no longer says it "checks again".
test("no record after the last check: the lost save is said as checked, and nothing says it checks again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const api = fixture();
    lose(api);
    const { result } = await opened(api);
    act(() => result.current.updateSource("flowchart LR\n a[Never]\n"));
    act(() => result.current.apply(""));
    await waitFor(() => expect(result.current.lost?.state).toBe("not-found"));
    expect(result.current.lost?.checked).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000 + 6_000 + 15_000 + 500);
    });
    await waitFor(() => expect(result.current.lost?.checked).toBe(true));
    expect(result.current.lost?.state).toBe("not-found");
    expect(api.mutate).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
