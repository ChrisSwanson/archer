// @vitest-environment jsdom
// flows-r1 claude-206: the header says "Saved · time" only for the person's own save in this browser. The editor
// records the save with the revision the view showed when it was sent; the first revision after it is the save's.
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAuthoring } from "../src/authoring/useAuthoring";
import { claimOwnSave, noteOwnSave, ownSaveOf, savedByYou } from "../src/app/own-saves";
import type { AuthoringClient } from "../src/authoring/client";
import type { AuthoringReceipt, AuthoringRequest } from "../../shared/authoring-contract.mts";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
const R = (n: number) => `sha256:${String(n).repeat(64)}`;
const person = (rev: string, at = "2026-11-02T12:00:05.000Z") => ({
  modelRevision: rev,
  lastChange: { at, by: "person" as const },
});

test("a noted save claims the first revision after the one it started from, and no later one", () => {
  noteOwnSave("p", "flow", R(1), false, Date.parse("2026-11-02T12:00:00.000Z"));
  const mine = ownSaveOf("p", "flow");
  expect(savedByYou(mine, person(R(1)))).toBe(false);
  expect(savedByYou(mine, person(R(2)))).toBe(true);
  claimOwnSave("p", "flow", R(2));
  const claimed = ownSaveOf("p", "flow");
  expect(savedByYou(claimed, person(R(2)))).toBe(true);
  expect(savedByYou(claimed, person(R(3)))).toBe(false);
  expect(
    savedByYou(claimed, { modelRevision: R(2), lastChange: { at: "2026-11-02T12:00:05.000Z", by: "agent" } }),
  ).toBe(false);
  expect(savedByYou(ownSaveOf("p", "other"), person(R(2)))).toBe(false);
});

test("a save answered unchanged is the person's for the revision already shown", () => {
  noteOwnSave("p", "flow", R(1), true);
  expect(savedByYou(ownSaveOf("p", "flow"), person(R(1)))).toBe(true);
});

test("the editor notes its own successful save with the revision the page showed when it was sent", async () => {
  const target = { kind: "view" as const, viewId: "flow" },
    BASE = R(4),
    TARGET = R(5);
  const status = {
    authorized: true as const,
    edit: { enabled: true },
    storeId: "store_" + "a".repeat(32),
    generation: "gen_" + "b".repeat(32),
    drafts: [],
    operations: [],
    nextOffset: null,
  };
  const applied = (request: AuthoringRequest): AuthoringReceipt =>
    ({
      operationId: request.operationId,
      state: "terminal",
      outcome: "applied",
      document: { target, targetRevision: TARGET, path: ".archer/flow.mmd", modelRevision: null, sourceRevision: R(6) },
      review: { mode: "manual", configRevision: R(7), state: "not_queued_manual" },
    }) as AuthoringReceipt;
  const api: AuthoringClient = {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    open: vi.fn(async (t) => ({
      target: t,
      path: ".archer/flow.mmd",
      authoringPath: "flow.mmd",
      blockId: null,
      source: "flowchart LR\n a[A]\n",
      sourceRevision: BASE,
      targetRevision: TARGET,
      writable: true,
    })),
    preview: vi.fn(async () => ({ envelope: null, diagnostics: [] })),
    edit: vi.fn(async (source: string) => ({ ok: false as const, source, code: "x" })),
    snapshot: vi.fn(),
    mutate: vi.fn(async (request: AuthoringRequest) => applied(request)),
    operation: vi.fn(async () => null),
  } as unknown as AuthoringClient;
  const { result } = renderHook(() =>
    useAuthoring("p", { target, draftId: "drf_" + "d".repeat(32) }, api, undefined, true, R(1)),
  );
  await waitFor(() => expect(result.current.data?.opened?.sourceRevision).toBe(BASE));
  expect(ownSaveOf("p", "flow")).toBeNull();
  act(() => result.current.updateSource("flowchart LR\n a[B]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.completed).not.toBeNull());
  expect(ownSaveOf("p", "flow")).toMatchObject({ prior: R(1) });
});

test("a refused save notes nothing", async () => {
  const target = { kind: "view" as const, viewId: "flow" };
  const status = {
    authorized: true as const,
    edit: { enabled: true },
    storeId: "store_" + "a".repeat(32),
    generation: "gen_" + "b".repeat(32),
    drafts: [],
    operations: [],
    nextOffset: null,
  };
  const { AuthoringRefusal } = await import("../src/authoring/client");
  const api = {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    open: vi.fn(async (t: typeof target) => ({
      target: t,
      path: ".archer/flow.mmd",
      authoringPath: "flow.mmd",
      blockId: null,
      source: "flowchart LR\n a[A]\n",
      sourceRevision: R(4),
      targetRevision: R(5),
      writable: true,
    })),
    preview: vi.fn(async () => ({ envelope: null, diagnostics: [] })),
    edit: vi.fn(),
    snapshot: vi.fn(),
    mutate: vi.fn(async () => {
      throw new AuthoringRefusal("changed", "revision_conflict", 409);
    }),
    operation: vi.fn(async () => null),
  } as unknown as AuthoringClient;
  const { result } = renderHook(() =>
    useAuthoring("p", { target, draftId: "drf_" + "d".repeat(32) }, api, undefined, true, R(1)),
  );
  await waitFor(() => expect(result.current.data?.opened).toBeTruthy());
  act(() => result.current.updateSource("flowchart LR\n a[B]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.refusal).not.toBeNull());
  expect(ownSaveOf("p", "flow")).toBeNull();
});

test("the tab closed before its save showed, then a git write: not called the person's save (claude-308)", () => {
  // The save from R(1) wrote the file at bytes revision S(1); this tab never saw the view at that revision.
  const S = (n: number) => `sha256:${"e".repeat(63)}${n}`;
  noteOwnSave("p", "flow", R(1), false, Date.parse("2026-11-02T12:00:00.000Z"), S(1));
  const mine = ownSaveOf("p", "flow");
  // Reopened: the view now shows a later outside write (another model revision, another file revision).
  expect(savedByYou(mine, { ...person(R(3)), sourceRevision: S(2) })).toBe(false);
  // The view at the save's own file revision is the person's, whatever model revision it has.
  expect(savedByYou(mine, { ...person(R(2)), sourceRevision: S(1) })).toBe(true);
  // An older service names no file revision: the earlier rule stands.
  expect(savedByYou(mine, person(R(2)))).toBe(true);
});

test("the editor's noted save keeps the file revision its receipt names", async () => {
  const target = { kind: "view" as const, viewId: "flow" },
    BASE = R(4),
    TARGET = R(5);
  const status = {
    authorized: true as const,
    edit: { enabled: true },
    storeId: "store_" + "a".repeat(32),
    generation: "gen_" + "b".repeat(32),
    drafts: [],
    operations: [],
    nextOffset: null,
  };
  const applied = (request: AuthoringRequest): AuthoringReceipt =>
    ({
      operationId: request.operationId,
      state: "terminal",
      outcome: "applied",
      document: { target, targetRevision: TARGET, path: ".archer/flow.mmd", modelRevision: null, sourceRevision: R(6) },
      review: { mode: "manual", configRevision: R(7), state: "not_queued_manual" },
    }) as AuthoringReceipt;
  const api: AuthoringClient = {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    open: vi.fn(async (t) => ({
      target: t,
      path: ".archer/flow.mmd",
      authoringPath: "flow.mmd",
      blockId: null,
      source: "flowchart LR\n a[A]\n",
      sourceRevision: BASE,
      targetRevision: TARGET,
      writable: true,
    })),
    preview: vi.fn(async () => ({ envelope: null, diagnostics: [] })),
    edit: vi.fn(async (source: string) => ({ ok: false as const, source, code: "x" })),
    snapshot: vi.fn(),
    mutate: vi.fn(async (request: AuthoringRequest) => applied(request)),
    operation: vi.fn(async () => null),
  } as unknown as AuthoringClient;
  const { result } = renderHook(() =>
    useAuthoring("p", { target, draftId: "drf_" + "d".repeat(32) }, api, undefined, true, R(1)),
  );
  await waitFor(() => expect(result.current.data?.opened?.sourceRevision).toBe(BASE));
  act(() => result.current.updateSource("flowchart LR\n a[B]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.completed).not.toBeNull());
  expect(ownSaveOf("p", "flow")).toMatchObject({ prior: R(1), source: R(6) });
});
