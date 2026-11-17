// @vitest-environment jsdom
// The product call sites, with the debug switch on. `__ARCHER_DEBUG__` is a build-time constant in a
// bundle; under Vitest it is a global (false by default), so it is set before the modules load.
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { AuthoringClient } from "../src/authoring/client";
import type { AuthoringReceipt, AuthoringRequest } from "../../shared/authoring-contract.mts";
import { setTelemetrySink, type TelemetryReport } from "../src/telemetry/dev";
import { loadModelEnvelope } from "./fixtures";

const globals = globalThis as { __ARCHER_DEBUG__?: boolean };
const was = globals.__ARCHER_DEBUG__;
let reports: TelemetryReport[] = [];
beforeAll(() => {
  globals.__ARCHER_DEBUG__ = true;
  setTelemetrySink((r) => reports.push(r));
});
afterAll(() => {
  globals.__ARCHER_DEBUG__ = was;
  setTelemetrySink(null);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  reports = [];
});

const status = {
  authorized: true as const,
  edit: { enabled: true },
  storeId: "store_" + "a".repeat(32),
  generation: "gen_" + "b".repeat(32),
  drafts: [],
  operations: [],
  nextOffset: null,
};
function client(): AuthoringClient {
  return {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    open: vi.fn(),
    preview: vi.fn(async () => ({ envelope: loadModelEnvelope("flowchart", "minimal"), diagnostics: [] })),
    edit: vi.fn(async (source: string) => ({ ok: false as const, source, code: "edit_source_mapping_ambiguous" })),
    snapshot: vi.fn(),
    mutate: vi.fn(
      async (request: AuthoringRequest): Promise<AuthoringReceipt> =>
        ({
          operationId: request.operationId,
          state: "terminal",
          outcome: "saved",
          draft: { draftId: "drf_" + "d".repeat(32), draftRevision: 1 },
          review: { mode: "manual", configRevision: "sha256:" + "e".repeat(64), state: "not_queued_manual" },
        }) as AuthoringReceipt,
    ),
    operation: vi.fn(async () => null),
  } as unknown as AuthoringClient;
}

test("an edit the service refuses is reported with its code; the same edit again on the same source is answered without a second request", async () => {
  const { useAuthoring } = await import("../src/authoring/useAuthoring");
  const api = client();
  const { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  await act(() => result.current.edit({ kind: "relabel-node", id: "a", label: "B" }));
  expect(reports.map((r) => r.code)).toEqual(["ui.edit.edit-refused"]);
  expect(reports[0]!.data).toMatchObject({ code: "edit_source_mapping_ambiguous" });
  await act(() => result.current.edit({ kind: "relabel-node", id: "a", label: "B" }));
  expect(api.edit).toHaveBeenCalledTimes(1);
  expect(reports.map((r) => r.code)).toEqual(["ui.edit.edit-refused", "ui.edit.edit-refused"]);
  expect(result.current.refusal?.code).toBe("edit_source_mapping_ambiguous");
});

test("the same edit on a different source is a new edit (no double commit); on its own result it sends nothing", async () => {
  const { useAuthoring } = await import("../src/authoring/useAuthoring");
  const api = client();
  // A reorder that lands p1 before s from two different orders (Move right, then Alt+Left later): two real edits.
  vi.mocked(api.edit).mockImplementation(async (source: string) => ({
    ok: true as const,
    source: source + "%% moved\n",
    envelope: null,
    diagnostics: [],
  }));
  const { result } = renderHook(() => useAuthoring("example", { target: null, draftId: "drf_" + "d".repeat(32) }, api));
  await waitFor(() => expect(result.current.data).not.toBeNull());
  const move = { kind: "move-node" as const, id: "p1", before: "s" };
  await act(() => result.current.edit(move));
  await act(() => result.current.edit(move));
  expect(api.edit).toHaveBeenCalledTimes(1);
  await act(() => result.current.edit({ kind: "move-node", id: "p1", before: null }));
  await act(() => result.current.edit(move));
  expect(api.edit).toHaveBeenCalledTimes(3);
  expect(reports.filter((r) => r.code === "ui.edit.double-commit")).toEqual([]);
});

test("the editor renders with its dev checks and profilers on", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const { AuthoringWorkspace } = await import("../src/authoring/AuthoringWorkspace");
  render(<AuthoringWorkspace projectSlug="example" api={client()} />);
  expect(await screen.findByRole("region", { name: "Diagram Editor" })).toBeInTheDocument();
  await waitFor(() => expect(document.querySelector(".authoring-preview .react-flow")).not.toBeNull());
  expect(reports.filter((r) => r.code.startsWith("ui.edit.pointer-hand"))).toEqual([]);
});
