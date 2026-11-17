// @vitest-environment jsdom
// O137: several closed tabs kept unsaved copies of one diagram. Each record is stamped when kept; the newest is
// offered (an unstamped one counts as the oldest), every copy is listed, and taking or discarding one keeps the rest.
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAuthoring, type ResumableCopy } from "../src/authoring/useAuthoring";
import { newestFirst, readRecovery, saveRecovery } from "../src/authoring/recovery";
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
  flow = { kind: "view" as const, viewId: "flow" };
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
const A = "aaaaaaaaaaaaaaaa",
  B = "bbbbbbbbbbbbbbbb",
  C = "cccccccccccccccc",
  D = "dddddddddddddddd";
const draft = (c: string) => "drf_" + c.repeat(32);
/** Tab `owner` edits its own copy of the diagram to `label` and closes; its record is then stamped `savedAt` (or not). */
async function closedCopy(owner: string, label: string, savedAt: number | null) {
  setTabIdForTests(owner);
  const h = renderHook(() =>
    useAuthoring("journeys", { target: flow, draftId: draft(owner[0]!) }, api, () => null, true),
  );
  await waitFor(() => expect(h.result.current.data?.opened).toBeTruthy());
  const source = `flowchart LR\n a[${label}]\n`;
  act(() => h.result.current.updateSource(source));
  const key = h.result.current.data!.key;
  await waitFor(() => expect(readRecovery(localStorage, key)?.source).toBe(source));
  h.unmount();
  const raw = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
  if (savedAt === null) delete raw.savedAt;
  else raw.savedAt = savedAt;
  localStorage.setItem(key, JSON.stringify(raw));
  return key;
}

test("a kept record is stamped with its tab and when it was kept, and read back with them; one without them is not read", () => {
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  setTabIdForTests(A);
  const key = "archer.authoring.v1:o:s:x:g:" + draft("a");
  expect(
    saveRecovery(localStorage, key, {
      version: 1,
      source: "s",
      intent: "",
      draftId: draft("a"),
      draftRevision: null,
      opened: null,
      pending: null,
    }),
  ).toBe(true);
  expect(readRecovery(localStorage, key)).toMatchObject({ owner: A, savedAt: 1_700_000_000_000 });
  const kept = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
  for (const field of ["owner", "savedAt"]) {
    const { [field]: _, ...without } = kept;
    localStorage.setItem(key, JSON.stringify(without));
    expect(readRecovery(localStorage, key)).toBeNull();
  }
  expect(
    newestFirst([{ savedAt: undefined, n: 1 }, { savedAt: 5, n: 2 }, { savedAt: 9, n: 3 }, { n: 4 }]).map((c) => c.n),
  ).toEqual([3, 2, 1, 4]);
});

test("three closed copies: the newest is offered whatever the storage order, and all three are listed newest first", async () => {
  const old = await closedCopy(A, "Oldest", 1000),
    newest = await closedCopy(B, "Newest", 3000),
    middle = await closedCopy(C, "Middle", 2000);
  setTabIdForTests(D);
  const h = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(h.result.current.resumable).not.toBeNull());
  expect(h.result.current.resumable).toMatchObject({ draftId: draft("b"), key: newest, owner: B });
  expect(h.result.current.copies.map((c) => c.key)).toEqual([newest, middle, old]);
});

test("taking one copy keeps the others; discarding one removes only it, and a copy whose tab came back is not discarded", async () => {
  const old = await closedCopy(A, "Oldest", 1000),
    newest = await closedCopy(B, "Newest", 3000),
    middle = await closedCopy(C, "Middle", 2000);
  setTabIdForTests(D);
  const h = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(h.result.current.copies).toHaveLength(3));
  const pick = (k: string) => h.result.current.copies.find((c) => c.key === k) as ResumableCopy;
  let ok = false;
  await act(async () => {
    ok = await h.result.current.discardCopy(pick(old));
  });
  expect(ok).toBe(true);
  expect(localStorage.getItem(old)).toBeNull();
  expect(h.result.current.copies.map((c) => c.key)).toEqual([newest, middle]);
  // C's tab is open again: its copy is not discarded, and that is said.
  const close = holdTab(C);
  await act(async () => {
    ok = await h.result.current.discardCopy(pick(middle));
  });
  expect(ok).toBe(false);
  expect(readRecovery(localStorage, middle)?.owner).toBe(C);
  expect(h.result.current.elsewhere).toBe(true);
  await close();
  // Taking the newest keeps the middle copy kept in the browser.
  await act(async () => {
    ok = await h.result.current.takeCopy(pick(newest));
  });
  expect(ok).toBe(true);
  expect(readRecovery(localStorage, newest)?.owner).toBe(D);
  expect(readRecovery(localStorage, middle)?.source).toContain("Middle");
});
