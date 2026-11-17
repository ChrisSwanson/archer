// @vitest-environment jsdom
// flows-r1 claude-501: a closed tab's save held offline, or sent with no answer, is offered on the diagram's plain edit
// address like unsaved edits (it was kept only for the missing-file screen, so a new tab said "no changes yet"), and
// Resume sends it once, under its kept identity. codex-502: every listed copy is checked again when another tab takes
// or discards it, not only the offered one. claude-502: each copy says what it changes.
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { changeSummary, useAuthoring } from "../src/authoring/useAuthoring";
import { readRecovery } from "../src/authoring/recovery";
import { setTabIdForTests } from "../src/comments/draft-tabs";
import type { AuthoringClient } from "../src/authoring/client";
import type { AuthoringReceipt, AuthoringRequest, AuthoringTarget } from "../../shared/authoring-contract.mts";
vi.mock("../src/source-editor/lazy", () => ({ useSourceEditor: () => null, preloadSourceEditor: async () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  setTabIdForTests(null);
  vi.restoreAllMocks();
});
const BASE = "sha256:" + "c".repeat(64),
  TARGET_REV = "sha256:" + "f".repeat(64),
  flow = { kind: "view" as const, viewId: "flow" };
const ORIGINAL = "flowchart LR\n a[Client]\n";
const status = {
  authorized: true as const,
  edit: { enabled: true },
  storeId: "store_" + "a".repeat(32),
  generation: "gen_" + "b".repeat(32),
  drafts: [],
  operations: [],
  nextOffset: null,
};
const A = "aaaaaaaaaaaaaaaa",
  B = "bbbbbbbbbbbbbbbb",
  C = "cccccccccccccccc",
  D = "dddddddddddddddd",
  E = "eeeeeeeeeeeeeeee";
const draft = (c: string) => "drf_" + c.repeat(32);
function fixture(
  mutate: (r: AuthoringRequest) => Promise<AuthoringReceipt> = async (r) =>
    ({ operationId: r.operationId, state: "terminal", outcome: "applied" }) as AuthoringReceipt,
) {
  return {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    open: vi.fn(async (t: AuthoringTarget) => ({
      target: t,
      path: ".archer/diagrams/flow.mmd",
      authoringPath: "diagrams/flow.mmd",
      blockId: null,
      source: ORIGINAL,
      sourceRevision: BASE,
      targetRevision: TARGET_REV,
      writable: true,
    })),
    preview: vi.fn(async () => ({ envelope: null, diagnostics: [] })),
    edit: vi.fn(async (source: string) => ({ ok: false as const, source, code: "x" })),
    snapshot: vi.fn(),
    mutate: vi.fn(mutate),
    operation: vi.fn(async () => null),
  } as unknown as AuthoringClient;
}
/** Tab `owner` edits to `label`; `save`: held offline, or sent with its answer lost; then the tab closes. */
async function closedTab(
  api: AuthoringClient,
  owner: string,
  label: string,
  save: "held" | "unconfirmed" | null,
  savedAt?: number,
) {
  setTabIdForTests(owner);
  const hook = renderHook(
    ({ on }: { on: boolean }) =>
      useAuthoring("journeys", { target: flow, draftId: draft(owner[0]!) }, api, undefined, on),
    { initialProps: { on: save !== "held" } },
  );
  await waitFor(() => expect(hook.result.current.data?.opened?.sourceRevision).toBe(BASE));
  act(() => hook.result.current.updateSource(`flowchart LR\n a[${label}]\n`));
  if (save === "held") {
    act(() => hook.result.current.apply(""));
    await waitFor(() => expect(hook.result.current.held).toBe(true));
  }
  if (save === "unconfirmed") {
    act(() => hook.result.current.apply(""));
    await waitFor(() => expect(hook.result.current.lost).not.toBeNull());
  }
  const key = hook.result.current.data!.key;
  hook.unmount();
  if (savedAt !== undefined) {
    const raw = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
    raw.savedAt = savedAt;
    localStorage.setItem(key, JSON.stringify(raw));
  }
  return key;
}

test("claude-501: a closed tab's held save is offered on the plain edit address, named as a held save, and nothing is sent before Resume", async () => {
  const api = fixture();
  const key = await closedTab(api, A, "HeldX", "held");
  expect(readRecovery(localStorage, key)).toMatchObject({ held: true });
  setTabIdForTests(D);
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(result.current.resumable).not.toBeNull());
  expect(result.current.resumable).toMatchObject({ draftId: draft("a"), key, owner: A, save: "held" });
  expect(result.current.copies[0]).toMatchObject({ save: "held", change: "first change: “a[HeldX]”" });
  await new Promise((r) => setTimeout(r, 30));
  expect(api.mutate).not.toHaveBeenCalled();
});

test("claude-501: Resume of the held save takes it under the lock, and reopened on its draft it is sent once, under its kept identity", async () => {
  const api = fixture();
  const key = await closedTab(api, A, "HeldX", "held");
  const heldId = readRecovery(localStorage, key)!.pending!.operationId;
  setTabIdForTests(D);
  const plain = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(plain.result.current.resumable?.save).toBe("held"));
  let ok = false;
  await act(async () => {
    ok = await plain.result.current.takeResumable();
  });
  expect(ok).toBe(true);
  plain.unmount();
  expect(readRecovery(localStorage, key)?.owner).toBe(D);
  const resumed = renderHook(() =>
    useAuthoring("journeys", { target: flow, draftId: draft("a") }, api, () => null, true),
  );
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.mutate).mock.calls[0]![0]).toMatchObject({
    op: "document.apply",
    operationId: heldId,
    source: "flowchart LR\n a[HeldX]\n",
    expectedSourceRevision: BASE,
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(api.mutate).toHaveBeenCalledTimes(1);
  resumed.unmount();
});

test("claude-603: at the closed tab's own draft address its held save is named as a held save, as on the plain address", async () => {
  const api = fixture();
  const key = await closedTab(api, A, "HeldX", "held");
  setTabIdForTests(D);
  const { result } = renderHook(() =>
    useAuthoring("journeys", { target: flow, draftId: draft("a") }, api, () => null, true),
  );
  await waitFor(() => expect(result.current.resumable).not.toBeNull());
  expect(result.current.resumable).toMatchObject({ key, owner: A, save: "held" });
  const { resumableText } = await import("../src/authoring/AuthoringWorkspace");
  expect(resumableText(result.current.resumable!)).toBe(
    "A save of this diagram from another tab, now closed, is held in this browser, not sent yet.",
  );
});

test("claude-501: a closed tab's save whose answer was lost is offered as not known to have reached Archer", async () => {
  const api = fixture(async () => {
    throw new TypeError("Failed to fetch");
  });
  const key = await closedTab(api, A, "LostY", "unconfirmed");
  expect(readRecovery(localStorage, key)?.pending).not.toBeNull();
  setTabIdForTests(D);
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(result.current.resumable).not.toBeNull());
  expect(result.current.resumable).toMatchObject({ key, save: "unconfirmed" });
});

test("codex-502: a non-primary copy taken by another tab leaves the list at once, the count follows, and that tab is named", async () => {
  const api = fixture();
  const newest = await closedTab(api, A, "Newest", null, 3000),
    middle = await closedTab(api, B, "Middle", null, 2000),
    old = await closedTab(api, C, "Oldest", null, 1000);
  setTabIdForTests(D);
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(result.current.copies).toHaveLength(3));
  expect(result.current.copies.map((c) => c.change)).toEqual([
    "first change: “a[Newest]”",
    "first change: “a[Middle]”",
    "first change: “a[Oldest]”",
  ]);
  // Tab E resumes the middle copy: its record now has E's owner, and this tab gets the storage event.
  const raw = JSON.parse(localStorage.getItem(middle)!) as Record<string, unknown>;
  raw.owner = E;
  localStorage.setItem(middle, JSON.stringify(raw));
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: middle }));
  });
  expect(result.current.copies.map((c) => c.key)).toEqual([newest, old]);
  expect(result.current.resumable?.key).toBe(newest);
  expect(result.current.elsewhere).toBe(true);
  // Another tab discards the oldest: it leaves too; the offered one stays.
  localStorage.removeItem(old);
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: old }));
  });
  expect(result.current.copies.map((c) => c.key)).toEqual([newest]);
  expect(result.current.resumable?.key).toBe(newest);
  // A rewrite by the same closed owner (nothing taken) keeps the copy.
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: newest }));
  });
  expect(result.current.copies.map((c) => c.key)).toEqual([newest]);
});

test("claude-502: a copy's change is its first changed line and the lines added or removed", () => {
  expect(changeSummary("flowchart LR\n a[Client]\n", "flowchart LR\n a[HeldX]\n")).toBe("first change: “a[HeldX]”");
  expect(changeSummary("flowchart LR\n a\n", "flowchart LR\n a\n b\n c\n")).toBe("first change: “b”, +2 lines");
  expect(changeSummary("flowchart LR\n a\n b\n", "flowchart LR\n a\n")).toBe("lines removed at the end, −1 line");
  expect(changeSummary("x", "x")).toBe("layout only");
});

test("claude-502: the copies list names each copy's change and save, and Discard asks before it discards", async () => {
  const { render, screen, fireEvent } = await import("@testing-library/react");
  const { OtherCopies } = await import("../src/authoring/OtherCopies");
  const onDiscard = vi.fn(),
    onResume = vi.fn();
  const copies = [
    {
      draftId: draft("a"),
      key: "k1",
      closed: true,
      savedAt: Date.now(),
      save: "held" as const,
      change: "first change: “a[HeldX]”",
    },
    { draftId: draft("b"), key: "k2", closed: true, change: "first change: “a[Other]”" },
  ];
  render(<OtherCopies copies={copies} busy={false} onResume={onResume} onDiscard={onDiscard} />);
  expect(screen.getByText(/a save held here, not sent yet \(first change: “a\[HeldX\]”\)/)).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[1]!);
  expect(onDiscard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
  expect(onDiscard).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[1]!);
  fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
  expect(onDiscard).toHaveBeenCalledWith(copies[1]);
});
