// @vitest-environment jsdom
// flows-r1 claude-602: Edit or Resume pressed with no connection left a blank "Archer did not answer." with no way on,
// and it stayed after the connection came back. The editor now says it is not connected, offers Try again, and opens by
// itself when the connection returns; a held save resumed meanwhile is still sent once.
import { act, renderHook, waitFor, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAuthoring } from "../src/authoring/useAuthoring";
import { AuthoringWorkspace } from "../src/authoring/AuthoringWorkspace";
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
  flow = { kind: "view" as const, viewId: "flow" },
  draftId = "drf_" + "a".repeat(32);
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
/** `down.on`: every request fails at the network, as with no connection. */
function fixture(down: { on: boolean }) {
  const net =
    <T,>(f: () => T) =>
    async () => {
      if (down.on) throw new TypeError("Failed to fetch");
      return f();
    };
  return {
    presentation: vi.fn(net(() => ({ presentation: null }))),
    status: vi.fn(net(() => status)),
    open: vi.fn(async (t: AuthoringTarget) => {
      if (down.on) throw new TypeError("Failed to fetch");
      return {
        target: t,
        path: ".archer/diagrams/flow.mmd",
        authoringPath: "diagrams/flow.mmd",
        blockId: null,
        source: ORIGINAL,
        sourceRevision: BASE,
        targetRevision: TARGET_REV,
        writable: true,
      };
    }),
    preview: vi.fn(async () => ({ envelope: null, diagnostics: [] })),
    edit: vi.fn(async (source: string) => ({ ok: false as const, source, code: "x" })),
    snapshot: vi.fn(),
    mutate: vi.fn(
      async (r: AuthoringRequest) =>
        ({
          operationId: r.operationId,
          state: "terminal",
          outcome: "applied",
          document: {
            target: flow,
            targetRevision: TARGET_REV,
            path: ".archer/diagrams/flow.mmd",
            sourceRevision: "sha256:" + "e".repeat(64),
          },
        }) as AuthoringReceipt,
    ),
    operation: vi.fn(async () => null),
  } as unknown as AuthoringClient;
}

test("claude-602: opened with no connection, the editor says so (not an error) and opens by itself when it returns", async () => {
  const down = { on: true },
    api = fixture(down);
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, true));
  await waitFor(() => expect(result.current.unreachable).toBe(true));
  expect(result.current.error).toBeNull();
  expect(result.current.data).toBeNull();
  down.on = false;
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() => expect(result.current.data?.opened?.source).toBe(ORIGINAL));
  expect(result.current.unreachable).toBe(false);
});

test("claude-602: the page's connection coming back opens it too, and Try again asks again", async () => {
  const down = { on: true },
    api = fixture(down);
  const hook = renderHook(
    ({ on }: { on: boolean }) => useAuthoring("journeys", { target: flow, draftId: null }, api, () => null, on),
    { initialProps: { on: false } },
  );
  await waitFor(() => expect(hook.result.current.unreachable).toBe(true));
  const asked = vi.mocked(api.status).mock.calls.length;
  act(() => hook.result.current.retryOpen());
  await waitFor(() => expect(vi.mocked(api.status).mock.calls.length).toBeGreaterThan(asked));
  expect(hook.result.current.unreachable).toBe(true);
  down.on = false;
  hook.rerender({ on: true });
  await waitFor(() => expect(hook.result.current.data?.opened).toBeTruthy());
});

test("claude-602: a held save resumed with no connection is sent once, when the connection returns", async () => {
  const down = { on: false },
    api = fixture(down);
  setTabIdForTests("aaaaaaaaaaaaaaaa");
  const first = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, undefined, false));
  await waitFor(() => expect(first.result.current.data?.opened).toBeTruthy());
  act(() => first.result.current.updateSource(HELD));
  act(() => first.result.current.apply(""));
  await waitFor(() => expect(first.result.current.held).toBe(true));
  first.unmount();
  down.on = true;
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, undefined, true));
  await waitFor(() => expect(result.current.unreachable).toBe(true));
  expect(api.mutate).not.toHaveBeenCalled();
  down.on = false;
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.mutate).mock.calls[0]![0]).toMatchObject({ op: "document.apply", source: HELD });
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(api.mutate).toHaveBeenCalledTimes(1);
});

test("claude-602: the stage says it is not connected, with Try again and a way back, and nothing in an alert", async () => {
  const down = { on: true },
    api = fixture(down);
  window.history.replaceState(null, "", "/projects/journeys/-/edit/?viewId=flow");
  render(<AuthoringWorkspace projectSlug="journeys" api={api} />);
  expect(await screen.findByText(/Not connected to Archer/)).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Go to the project" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText(/Still not connected/)).toBeVisible();
  down.on = false;
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() => expect(screen.queryByText(/Not connected to Archer/)).toBeNull());
});
