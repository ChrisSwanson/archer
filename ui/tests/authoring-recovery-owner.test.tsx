// @vitest-environment jsdom
// The editor's recovery under the ownership rule (O117, claude-303): two tabs never write one working copy. A tab
// opening a draft another open tab keeps (Resume while it is open, or a duplicated tab) edits its own copy and says
// the other is open; a closed tab's copy is offered, and Resume takes it over; this tab's own comes back as before.
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAuthoring } from "../src/authoring/useAuthoring";
import { readRecovery, takeRecovery } from "../src/authoring/recovery";
import { setTabIdForTests } from "../src/comments/draft-tabs";
import { holdTab } from "./support/fake-locks";
import type { AuthoringClient } from "../src/authoring/client";
import type { AuthoringRequest, AuthoringTarget } from "../../shared/authoring-contract.mts";
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
  flow = { kind: "view" as const, viewId: "flow" },
  draftId = "drf_" + "d".repeat(32);
const A = "aaaaaaaaaaaaaaaa",
  B = "bbbbbbbbbbbbbbbb";
const status = {
  authorized: true as const,
  edit: { enabled: true },
  storeId: "store_" + "a".repeat(32),
  generation: "gen_" + "b".repeat(32),
  drafts: [],
  operations: [],
  nextOffset: null,
};
const api = {
  presentation: vi.fn(async () => ({ presentation: null })),
  status: vi.fn(async () => status),
  open: vi.fn(async (t: AuthoringTarget) => ({
    target: t,
    path: ".archer/diagrams/flow.mmd",
    authoringPath: "diagrams/flow.mmd",
    blockId: null,
    source: "flowchart LR\n a[Client]\n",
    sourceRevision: BASE,
    targetRevision: TARGET_REV,
    writable: true,
  })),
  preview: vi.fn(async () => ({ envelope: null, diagnostics: [] })),
  edit: vi.fn(async (source: string) => ({ ok: false as const, source, code: "x" })),
  snapshot: vi.fn(),
  mutate: vi.fn(async (r: AuthoringRequest) => ({ operationId: r.operationId, state: "terminal", outcome: "applied" })),
  operation: vi.fn(async () => null),
} as unknown as AuthoringClient;
const MINE = "flowchart LR\n a[Alice]\n";
async function work(owner: string) {
  setTabIdForTests(owner);
  const h = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, () => null, true));
  await waitFor(() => expect(h.result.current.data?.opened).toBeTruthy());
  act(() => h.result.current.updateSource(MINE));
  // The working copy is kept by an effect after the render: unmounting before it lands leaves no work to find (O138).
  const key = h.result.current.data!.key;
  await waitFor(() => expect(readRecovery(localStorage, key)?.source).toBe(MINE));
  h.unmount();
  return key;
}

test("a reload of the tab that keeps it: restored, as before", async () => {
  const key = await work(A);
  const h = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, () => null, true));
  await waitFor(() => expect(h.result.current.data?.source).toBe(MINE));
  expect(h.result.current.data?.draftId).toBe(draftId);
  expect(readRecovery(localStorage, key)?.owner).toBe(A);
});

test("its tab still open: another tab is not given it, edits its own copy, and is told; the open one is untouched", async () => {
  const key = await work(A);
  const close = holdTab(A);
  setTabIdForTests(B);
  const h = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, () => null, true));
  await waitFor(() => expect(h.result.current.data?.opened).toBeTruthy());
  expect(h.result.current.data?.draftId).not.toBe(draftId);
  expect(h.result.current.data?.source).not.toBe(MINE);
  expect(h.result.current.elsewhere).toBe(true);
  act(() => h.result.current.updateSource("flowchart LR\n a[Bob]\n"));
  expect(readRecovery(localStorage, key)).toMatchObject({ source: MINE, owner: A });
  await close();
});

test("the same draft offered by Resume while its tab is open (no draft in the address): not offered; said instead", async () => {
  await work(A);
  const close = holdTab(A);
  setTabIdForTests(B);
  const h = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(h.result.current.data?.opened).toBeTruthy());
  expect(h.result.current.resumable).toBeNull();
  expect(h.result.current.elsewhere).toBe(true);
  await close();
});

test("its tab closed: offered, not restored; Resume takes it over, then it is restored as this tab's", async () => {
  const key = await work(A);
  setTabIdForTests(B);
  const h = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, () => null, true));
  await waitFor(() => expect(h.result.current.resumable).not.toBeNull());
  expect(h.result.current.data?.source).not.toBe(MINE);
  expect(h.result.current.resumable).toMatchObject({ draftId, key });
  expect(h.result.current.resumable).toMatchObject({ owner: A });
  expect(await takeRecovery(localStorage, key, A)).toBe(true);
  h.unmount();
  const again = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, () => null, true));
  await waitFor(() => expect(again.result.current.data?.source).toBe(MINE));
  expect(readRecovery(localStorage, key)?.owner).toBe(B);
});

// codex-401 (O127): two tabs offered the same closed tab's copy. The first takes it and edits it while open; the second
// tab's offer is now stale: taking it is refused (the copy is live in the first tab), the first tab's work stays its own.
test("a stale offer is refused: the copy was taken meanwhile by a tab still open, and its work is kept", async () => {
  const key = await work(A);
  const C = "cccccccccccccccc";
  setTabIdForTests(B);
  const b = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, () => null, true));
  await waitFor(() => expect(b.result.current.resumable).not.toBeNull());
  setTabIdForTests(C);
  const c = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, () => null, true));
  await waitFor(() => expect(c.result.current.resumable).not.toBeNull());
  const offered = c.result.current.resumable!;
  // B takes it and keeps working on it, still open.
  setTabIdForTests(B);
  expect(await takeRecovery(localStorage, key, A)).toBe(true);
  const closeB = holdTab(B);
  const bWork = "flowchart LR\n a[B unique work]\n";
  localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)!), source: bWork }));
  // C presses its stale Resume.
  setTabIdForTests(C);
  expect(await takeRecovery(localStorage, key, offered.owner)).toBe(false);
  expect(readRecovery(localStorage, key)).toMatchObject({ source: bWork, owner: B });
  // Through the hook: refused, the offer is withdrawn and the other tab is said to have it.
  let took = true;
  await act(async () => {
    took = await c.result.current.takeResumable();
  });
  expect(took).toBe(false);
  expect(c.result.current.resumable).toBeNull();
  expect(c.result.current.elsewhere).toBe(true);
  expect(readRecovery(localStorage, key)).toMatchObject({ source: bWork, owner: B });
  // B closed again, the owner is not the one offered: still refused (the offer is from before B took it).
  await closeB();
  expect(await takeRecovery(localStorage, key, A)).toBe(false);
  // Offered afresh (owner B, closed), it can be taken.
  expect(await takeRecovery(localStorage, key, B)).toBe(true);
  expect(readRecovery(localStorage, key)).toMatchObject({ source: bWork, owner: C });
  b.unmount();
  c.unmount();
});

// claude-401 (O127): once another tab resumes the copy, every other tab's offer of it is withdrawn at once (the
// browser's storage event), not left to be pressed.
test("an offer is withdrawn in this tab when another tab takes the copy", async () => {
  const key = await work(A);
  setTabIdForTests(B);
  const b = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, () => null, true));
  await waitFor(() => expect(b.result.current.resumable).toMatchObject({ key, owner: A }));
  // Another tab (C) resumes it: the record now names C.
  const taken = { ...JSON.parse(localStorage.getItem(key)!), owner: "cccccccccccccccc" };
  localStorage.setItem(key, JSON.stringify(taken));
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: JSON.stringify(taken), storageArea: localStorage }),
    );
  });
  await waitFor(() => expect(b.result.current.resumable).toBeNull());
  expect(b.result.current.elsewhere).toBe(true);
  b.unmount();
});
