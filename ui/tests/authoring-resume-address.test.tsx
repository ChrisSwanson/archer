// @vitest-environment jsdom
// codex-403 (O129): a closed tab's working copy opened from its full draft address. The editor forks a clean copy and
// offers the closed one; Resume them must then show the offered source at once, not only after a reload. The workspace
// was keyed by its first address's draft id, the same id Resume names, so it did not reopen.
import { act, renderHook, waitFor, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAuthoring } from "../src/authoring/useAuthoring";
import { AuthoringWorkspace } from "../src/authoring/AuthoringWorkspace";
import { readRecovery } from "../src/authoring/recovery";
import { setTabIdForTests } from "../src/comments/draft-tabs";
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
  B = "bbbbbbbbbbbbbbbb",
  MINE = "flowchart LR\n a[Direct-address recovery]\n";
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

test("Resume them from the full draft address shows the offered source without a reload", async () => {
  setTabIdForTests(A);
  const h = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, () => null, true));
  await waitFor(() => expect(h.result.current.data?.opened).toBeTruthy());
  act(() => h.result.current.updateSource(MINE));
  const key = h.result.current.data!.key;
  h.unmount();
  setTabIdForTests(B);
  window.history.replaceState(null, "", `/projects/journeys/-/edit/?viewId=flow&draftId=${draftId}`);
  render(<AuthoringWorkspace projectSlug="journeys" api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Resume them" }));
  await waitFor(() =>
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mermaid source"]')?.value).toBe(MINE),
  );
  expect(screen.queryByRole("button", { name: "Resume them" })).toBeNull();
  expect(new URLSearchParams(location.search).get("draftId")).toBe(draftId);
  expect(readRecovery(localStorage, key)?.owner).toBe(B);
  // claude-402: new edits are kept under the draft the address names (so a reload restores this tab's own work).
  const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mermaid source"]')!;
  fireEvent.change(box, { target: { value: MINE + " b[Edited after Resume]\n" } });
  await waitFor(() => expect(readRecovery(localStorage, key)?.source).toBe(MINE + " b[Edited after Resume]\n"));
  expect(readRecovery(localStorage, key)?.owner).toBe(B);
});
