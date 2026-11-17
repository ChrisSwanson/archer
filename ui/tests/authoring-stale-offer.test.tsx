// @vitest-environment jsdom
// flows-r1 claude-601: a bystander tab's offer of a closed tab's copy follows the record whoever owns it. The closed tab
// reopened (it keeps its owner id) and sent its held save: the offer goes, and so does "open in another tab" once that
// tab's record holds nothing unsaved. A copy whose text the file already holds is not offered as unsaved.
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAuthoring } from "../src/authoring/useAuthoring";
import { readRecovery } from "../src/authoring/recovery";
import { setTabIdForTests } from "../src/comments/draft-tabs";
import { holdTab } from "./support/fake-locks";
import type { AuthoringClient } from "../src/authoring/client";
import type { AuthoringReceipt, AuthoringRequest, AuthoringTarget } from "../../shared/authoring-contract.mts";
vi.mock("../src/source-editor/lazy", () => ({ useSourceEditor: () => null, preloadSourceEditor: async () => null }));
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  setTabIdForTests(null);
  vi.restoreAllMocks();
});
const BASE = "sha256:" + "c".repeat(64),
  NEXT = "sha256:" + "e".repeat(64),
  TARGET_REV = "sha256:" + "f".repeat(64),
  flow = { kind: "view" as const, viewId: "flow" };
const ORIGINAL = "flowchart LR\n a[Client]\n",
  HELD = "flowchart LR\n a[HeldX]\n";
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
  D = "dddddddddddddddd";
const draft = (c: string) => "drf_" + c.repeat(32);
function fixture(file: { source: string; revision: string } = { source: ORIGINAL, revision: BASE }) {
  return {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    open: vi.fn(async (t: AuthoringTarget) => ({
      target: t,
      path: ".archer/diagrams/flow.mmd",
      authoringPath: "diagrams/flow.mmd",
      blockId: null,
      source: file.source,
      sourceRevision: file.revision,
      targetRevision: TARGET_REV,
      writable: true,
    })),
    preview: vi.fn(async () => ({ envelope: null, diagnostics: [] })),
    edit: vi.fn(async (source: string) => ({ ok: false as const, source, code: "x" })),
    snapshot: vi.fn(),
    mutate: vi.fn(
      async (r: AuthoringRequest) =>
        ({ operationId: r.operationId, state: "terminal", outcome: "applied" }) as AuthoringReceipt,
    ),
    operation: vi.fn(async () => null),
  } as unknown as AuthoringClient;
}
/** Tab A edits to HELD, saves with no connection (held), and closes. */
async function heldInClosedTab(api: AuthoringClient) {
  setTabIdForTests(A);
  const hook = renderHook(() => useAuthoring("journeys", { target: flow, draftId: draft("a") }, api, undefined, false));
  await waitFor(() => expect(hook.result.current.data?.opened?.sourceRevision).toBe(BASE));
  act(() => hook.result.current.updateSource(HELD));
  act(() => hook.result.current.apply(""));
  await waitFor(() => expect(hook.result.current.held).toBe(true));
  const key = hook.result.current.data!.key;
  hook.unmount();
  return key;
}
/** What the record holds once its tab sent the held save and Archer answered: nothing pending, the file at HELD. */
function sent(key: string, owner: string) {
  const raw = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown> & { opened: Record<string, unknown> };
  delete raw.held;
  raw.pending = null;
  raw.owner = owner;
  raw.opened = { ...raw.opened, source: HELD, sourceRevision: NEXT };
  localStorage.setItem(key, JSON.stringify(raw));
}

test('claude-601: the closed tab reopens and sends its held save; the bystander\'s offer goes, and no "open in another tab" stays', async () => {
  const api = fixture();
  const key = await heldInClosedTab(api);
  setTabIdForTests(D);
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(result.current.resumable?.save).toBe("held"));
  // A is reopened (same owner id): its tab lock is held again, and it rewrites its record as it restores it.
  closers.push(holdTab(A));
  const raw = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
  raw.savedAt = Date.now();
  localStorage.setItem(key, JSON.stringify(raw));
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });
  // Open there now: not offered here, and said to be open there.
  await waitFor(() => expect(result.current.resumable).toBeNull());
  expect(result.current.copies).toEqual([]);
  expect(result.current.elsewhere).toBe(true);
  // A sends it and Archer answers: the record holds nothing unsaved, so nothing is said about it any more.
  sent(key, A);
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });
  await waitFor(() => expect(result.current.elsewhere).toBe(false));
  expect(result.current.resumable).toBeNull();
  expect(api.mutate).not.toHaveBeenCalled();
});

test("claude-601: a record sent by its own closed owner meanwhile (no change of owner) leaves the list", async () => {
  const api = fixture();
  const key = await heldInClosedTab(api);
  setTabIdForTests(D);
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(result.current.copies).toHaveLength(1));
  sent(key, A);
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });
  await waitFor(() => expect(result.current.copies).toEqual([]));
  expect(result.current.resumable).toBeNull();
  expect(result.current.elsewhere).toBe(false);
});

test("claude-601 (n12 H1-A-reopened): the closed tab reopened at its own address after another tab sent its save: nothing offered", async () => {
  const api = fixture({ source: HELD, revision: NEXT });
  const key = await heldInClosedTab(fixture());
  // Tab D took it, sent it and closed: the record is D's, with nothing pending, and the file holds its text.
  sent(key, D);
  expect(readRecovery(localStorage, key)?.owner).toBe(D);
  setTabIdForTests(A);
  const { result } = renderHook(() =>
    useAuthoring("journeys", { target: flow, draftId: draft("a") }, api, () => null, true),
  );
  await waitFor(() => expect(result.current.data?.opened).toBeTruthy());
  expect(result.current.resumable).toBeNull();
  expect(result.current.elsewhere).toBe(false);
  expect(result.current.data?.source).toBe(HELD);
});

test("claude-601: a closed tab's copy whose text the file already holds is not offered as unsaved", async () => {
  const key = await heldInClosedTab(fixture());
  // Someone else wrote the same text to the file meanwhile: the copy changes nothing.
  const raw = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
  delete raw.held;
  raw.pending = null;
  localStorage.setItem(key, JSON.stringify(raw));
  setTabIdForTests(D);
  const api = fixture({ source: HELD, revision: NEXT });
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(result.current.data?.opened).toBeTruthy());
  await new Promise((r) => setTimeout(r, 20));
  expect(result.current.copies).toEqual([]);
  expect(result.current.resumable).toBeNull();
});

/** Tab A edits to `text` and closes without saving: its copy is kept, nothing pending. */
async function editedInClosedTab(api: AuthoringClient, text: string) {
  setTabIdForTests(A);
  const hook = renderHook(() => useAuthoring("journeys", { target: flow, draftId: draft("a") }, api, undefined, true));
  await waitFor(() => expect(hook.result.current.data?.opened?.sourceRevision).toBe(BASE));
  act(() => hook.result.current.updateSource(text));
  await waitFor(() => expect(readRecovery(localStorage, hook.result.current.data!.key)?.source).toBe(text));
  const key = hook.result.current.data!.key;
  hook.unmount();
  return key;
}

test("codex-701: the file refreshed in place to the offered copy's text: the offer goes; a copy that still differs stays", async () => {
  const OTHER = "flowchart LR\n a[Other]\n";
  const file = { source: ORIGINAL, revision: BASE };
  const api = fixture(file);
  await editedInClosedTab(api, HELD);
  setTabIdForTests(D);
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(result.current.copies).toHaveLength(1));
  await waitFor(() => expect(result.current.resumable).not.toBeNull());
  // An outside writer writes some other text: the copy still differs from the file, so it is still offered.
  file.source = OTHER;
  file.revision = NEXT;
  let outcome: string | undefined;
  await act(async () => {
    outcome = await result.current.refreshClean();
  });
  expect(outcome).toBe("refreshed");
  expect(result.current.data?.source).toBe(OTHER);
  expect(result.current.copies).toHaveLength(1);
  expect(result.current.resumable).not.toBeNull();
  // Then A's exact text: the file holds it, so nothing unsaved is offered any more.
  file.source = HELD;
  file.revision = "sha256:" + "d".repeat(64);
  await act(async () => {
    outcome = await result.current.refreshClean();
  });
  expect(outcome).toBe("refreshed");
  expect(result.current.data?.source).toBe(HELD);
  expect(result.current.copies).toEqual([]);
  expect(result.current.resumable).toBeNull();
  expect(result.current.elsewhere).toBe(false);
});

// codex-801: two closed tabs' copies of one diagram. The file comes to hold the newest one's text: that one goes, and the
// older one, which still differs, is offered and listed (before, its promotion was overridden by the stale offer).
const OLDER = "flowchart LR\n a[Older]\n",
  NEWEST = "flowchart LR\n a[Newest]\n",
  C = "cccccccccccccccc";
/** Tab `tab` edits to `text` and closes; `held`: it saved with no connection first. `savedAt` stamps its record. */
async function closedCopy(api: AuthoringClient, tab: string, text: string, held: boolean, savedAt: number) {
  setTabIdForTests(tab);
  const hook = renderHook(() =>
    useAuthoring("journeys", { target: flow, draftId: draft(tab[0]!) }, api, undefined, !held),
  );
  await waitFor(() => expect(hook.result.current.data?.opened?.sourceRevision).toBe(BASE));
  act(() => hook.result.current.updateSource(text));
  if (held) {
    act(() => hook.result.current.apply(""));
    await waitFor(() => expect(hook.result.current.held).toBe(true));
  }
  await waitFor(() => expect(readRecovery(localStorage, hook.result.current.data!.key)?.source).toBe(text));
  const key = hook.result.current.data!.key;
  hook.unmount();
  const raw = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
  raw.savedAt = savedAt;
  localStorage.setItem(key, JSON.stringify(raw));
  return key;
}
async function twoCopies(api: AuthoringClient, olderHeld: boolean) {
  const now = Date.now();
  const older = await closedCopy(api, A, OLDER, olderHeld, now - 60_000),
    newest = await closedCopy(api, C, NEWEST, false, now);
  return { older, newest, olderDraft: draft("a"), newestDraft: draft("c") };
}
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

for (const olderHeld of [false, true])
  test(`codex-801: the file refreshed to the newest copy's text: the older copy (${olderHeld ? "a held save" : "unsaved edits"}) is still offered and listed`, async () => {
    const file = { source: ORIGINAL, revision: BASE };
    const api = fixture(file);
    const { older, olderDraft, newestDraft } = await twoCopies(api, olderHeld);
    setTabIdForTests(D);
    const { result } = renderHook(() =>
      useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true),
    );
    await waitFor(() => expect(result.current.copies).toHaveLength(2));
    await waitFor(() => expect(result.current.resumable?.draftId).toBe(newestDraft));
    file.source = NEWEST;
    file.revision = NEXT;
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.refreshClean();
    });
    expect(outcome).toBe("refreshed");
    await settle();
    expect(result.current.copies.map((c) => c.key)).toEqual([older]);
    expect(result.current.resumable?.draftId).toBe(olderDraft);
    expect(result.current.resumable?.key).toBe(older);
    if (olderHeld) expect(result.current.resumable?.save).toBe("held");
    expect(api.mutate).not.toHaveBeenCalled();
  });

for (const olderHeld of [false, true])
  test(`codex-801: a fresh plain Edit visit, the file already holding the newest copy's text, offers the older copy (${olderHeld ? "held" : "unsaved"})`, async () => {
    const file = { source: ORIGINAL, revision: BASE };
    const api = fixture(file);
    const { older, olderDraft } = await twoCopies(api, olderHeld);
    file.source = NEWEST;
    file.revision = NEXT;
    // The open answers after the page has rendered the copies found in storage, as it does over a real connection.
    const open = api.open.bind(api);
    api.open = async (t) => {
      await new Promise((r) => setTimeout(r, 30));
      return open(t);
    };
    setTabIdForTests(D);
    const { result } = renderHook(() =>
      useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true),
    );
    await waitFor(() => expect(result.current.data?.opened?.source).toBe(NEWEST), { timeout: 2000 });
    await settle();
    expect(result.current.copies.map((c) => c.key)).toEqual([older]);
    expect(result.current.resumable?.draftId).toBe(olderDraft);
  });

test("codex-801 control: the file refreshed to the older copy's text: the newest stays offered, the older goes", async () => {
  const file = { source: ORIGINAL, revision: BASE };
  const api = fixture(file);
  const { newest, newestDraft } = await twoCopies(api, false);
  setTabIdForTests(D);
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(result.current.copies).toHaveLength(2));
  file.source = OLDER;
  file.revision = NEXT;
  await act(async () => {
    await result.current.refreshClean();
  });
  await settle();
  expect(result.current.copies.map((c) => c.key)).toEqual([newest]);
  expect(result.current.resumable?.draftId).toBe(newestDraft);
});

test("codex-801: Resume of the newest copy, refused because another tab took it, leaves the older copy offered", async () => {
  const api = fixture();
  const { older, newest, olderDraft } = await twoCopies(api, false);
  setTabIdForTests(D);
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(result.current.copies).toHaveLength(2));
  // Tab E took the newest copy meanwhile (its record is E's now), and E is still open.
  const E = "eeeeeeeeeeeeeeee";
  closers.push(holdTab(E));
  const raw = JSON.parse(localStorage.getItem(newest)!) as Record<string, unknown>;
  raw.owner = E;
  localStorage.setItem(newest, JSON.stringify(raw));
  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.takeResumable();
  });
  expect(ok).toBe(false);
  await settle();
  expect(result.current.copies.map((c) => c.key)).toEqual([older]);
  expect(result.current.resumable?.draftId).toBe(olderDraft);
});
