// @vitest-environment jsdom
// flows-r1 claude-203: unsaved work, or a save held offline, whose diagram file is deleted or renamed before the tab
// reopens. The person's text stays reachable (shown, with Copy); they save it as a new diagram at the old path, keep
// it as a proposal, or discard it. Nothing is sent to the missing file; nothing is written over another one.
import { act, renderHook, waitFor, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAuthoring } from "../src/authoring/useAuthoring";
import { AuthoringWorkspace } from "../src/authoring/AuthoringWorkspace";
import { readRecovery } from "../src/authoring/recovery";
import { setTabIdForTests } from "../src/comments/draft-tabs";
import { AuthoringRefusal, type AuthoringClient } from "../src/authoring/client";
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
  draftId = "drf_" + "d".repeat(32);
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
const opened = (t: AuthoringTarget, path = "diagrams/flow.mmd") => ({
  target: t,
  path: `.archer/${path}`,
  authoringPath: path,
  blockId: null,
  source: ORIGINAL,
  sourceRevision: BASE,
  targetRevision: TARGET_REV,
  writable: true,
});
const receipt = (request: AuthoringRequest): AuthoringReceipt =>
  request.op === "document.publish"
    ? ({
        operationId: request.operationId,
        state: "terminal",
        outcome: "created",
        document: {
          target: { kind: "view", viewId: "flow" },
          targetRevision: TARGET_REV,
          path: `.archer/${request.path}`,
          modelRevision: null,
          sourceRevision: "sha256:" + "9".repeat(64),
        },
        review: { mode: "manual", configRevision: "sha256:" + "e".repeat(64), state: "not_queued_manual" },
      } as AuthoringReceipt)
    : request.op === "draft.save"
      ? ({
          operationId: request.operationId,
          state: "terminal",
          outcome: "saved",
          draft: { draftId: request.draftId, draftRevision: 1 },
        } as AuthoringReceipt)
      : ({ operationId: request.operationId, state: "terminal", outcome: "applied" } as AuthoringReceipt);
function fixture(present: Set<string> = new Set(["flow"])) {
  const api: AuthoringClient = {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    open: vi.fn(async (t: AuthoringTarget) => {
      const id = t.kind === "view" ? t.viewId : t.address;
      if (!present.has(id)) throw new AuthoringRefusal("the diagram source no longer exists; reload it", "ENOENT", 404);
      return opened(t, id === "flow" ? "diagrams/flow.mmd" : `diagrams/${id}.mmd`);
    }),
    preview: vi.fn(async () => ({ envelope: null, diagnostics: [] })),
    edit: vi.fn(async (source: string) => ({ ok: false as const, source, code: "x" })),
    snapshot: vi.fn(),
    mutate: vi.fn(async (request: AuthoringRequest) => receipt(request)),
    operation: vi.fn(async () => null),
  } as unknown as AuthoringClient;
  return api;
}
/** Edit and keep the change (held offline, or only unsaved), then close the tab. */
async function leaveWork(api: AuthoringClient, { held }: { held: boolean }) {
  const hook = renderHook(
    ({ on }: { on: boolean }) => useAuthoring("journeys", { target: flow, draftId }, api, undefined, on),
    { initialProps: { on: !held } },
  );
  await waitFor(() => expect(hook.result.current.data?.opened?.sourceRevision).toBe(BASE));
  act(() => hook.result.current.updateSource("flowchart LR\n a[Mine]\n"));
  if (held) {
    act(() => hook.result.current.apply(""));
    await waitFor(() => expect(hook.result.current.held).toBe(true));
  }
  const key = hook.result.current.data!.key;
  hook.unmount();
  return key;
}

test("deleted file, held save: reopened, the text is offered, and the held save is never sent to the missing file", async () => {
  const present = new Set(["flow"]),
    api = fixture(present);
  const key = await leaveWork(api, { held: true });
  present.delete("flow");
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, undefined, true));
  await waitFor(() => expect(result.current.missing).not.toBeNull());
  expect(result.current.missing).toMatchObject({
    source: "flowchart LR\n a[Mine]\n",
    path: "diagrams/flow.mmd",
    held: true,
  });
  window.dispatchEvent(new Event("online"));
  await new Promise((r) => setTimeout(r, 30));
  expect(api.mutate).not.toHaveBeenCalled();
  // Nothing is lost by opening: the browser still holds it until the person chooses.
  expect(readRecovery(localStorage, key)?.source).toBe("flowchart LR\n a[Mine]\n");
});

test("Save as a new diagram here publishes a new file at the old path, from the person's text, under a new operation", async () => {
  const present = new Set(["flow"]),
    api = fixture(present);
  await leaveWork(api, { held: true });
  const heldId = JSON.parse(localStorage.getItem(Object.keys(localStorage)[0]!)!).pending.operationId;
  present.delete("flow");
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, undefined, true));
  await waitFor(() => expect(result.current.missing).not.toBeNull());
  act(() => result.current.adoptMissing("new", "diagrams/flow.mmd"));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  const sent = vi.mocked(api.mutate).mock.calls[0]![0];
  expect(sent).toMatchObject({ op: "document.publish", path: "diagrams/flow.mmd", source: "flowchart LR\n a[Mine]\n" });
  expect(sent.operationId).not.toBe(heldId);
  await waitFor(() => expect(result.current.completed).not.toBeNull());
  expect(result.current.missing).toBeNull();
});

test("a file already there: Save as new is refused by the service, nothing is written over it, the text stays", async () => {
  const present = new Set(["flow"]),
    api = fixture(present);
  await leaveWork(api, { held: false });
  present.delete("flow");
  vi.mocked(api.mutate).mockRejectedValueOnce(
    new AuthoringRefusal("a file already exists at that path", "EEXIST", 409),
  );
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, undefined, true));
  await waitFor(() => expect(result.current.missing).not.toBeNull());
  act(() => result.current.adoptMissing("new", "diagrams/flow.mmd"));
  await waitFor(() =>
    expect(result.current.error).toMatch(/A file is at diagrams\/flow\.mmd again, so nothing was written over it/),
  );
  expect(result.current.data?.source).toBe("flowchart LR\n a[Mine]\n");
  expect(result.current.data?.opened).toBeNull();
});

test.each([
  ["refused (EEXIST)", false],
  ["answered conflict", true],
] as const)(
  "the file came back before Save as new (%s): back on the missing-file screen, said so, the text kept (claude-305)",
  async (_label, asReceipt) => {
    const present = new Set(["flow"]),
      api = fixture(present);
    await leaveWork(api, { held: false });
    present.delete("flow");
    if (asReceipt)
      vi.mocked(api.mutate).mockImplementationOnce(
        async (request: AuthoringRequest) =>
          ({ ...receipt(request), outcome: "conflict", document: undefined }) as unknown as AuthoringReceipt,
      );
    else
      vi.mocked(api.mutate).mockRejectedValueOnce(
        new AuthoringRefusal("a file already exists at that path", "EEXIST", 409),
      );
    const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, undefined, true));
    await waitFor(() => expect(result.current.missing).not.toBeNull());
    act(() => result.current.adoptMissing("new", "diagrams/flow.mmd"));
    await waitFor(() => expect(result.current.error).toMatch(/A file is at diagrams\/flow\.mmd again/));
    expect(result.current.missing).toMatchObject({ source: "flowchart LR\n a[Mine]\n", path: "diagrams/flow.mmd" });
    expect(result.current.completed).toBeNull();
    expect(api.mutate).toHaveBeenCalledTimes(1);
  },
);

test("Save as a proposal keeps it privately; Discard removes it explicitly; neither sends anything to the missing file", async () => {
  const present = new Set(["flow"]),
    api = fixture(present);
  await leaveWork(api, { held: true });
  present.delete("flow");
  const first = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, undefined, true));
  await waitFor(() => expect(first.result.current.missing).not.toBeNull());
  act(() => first.result.current.adoptMissing("proposal"));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.mutate).mock.calls[0]![0]).toMatchObject({
    op: "draft.save",
    source: "flowchart LR\n a[Mine]\n",
    origin: { kind: "new" },
  });
  first.unmount();
  localStorage.clear();
  present.add("flow");
  const key = await leaveWork(api, { held: false });
  present.delete("flow");
  const second = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, undefined, true));
  await waitFor(() => expect(second.result.current.missing).not.toBeNull());
  act(() => second.result.current.discardMissing());
  expect(localStorage.getItem(key)).toBeNull();
  expect(second.result.current.missing).toBeNull();
  expect(second.result.current.missingDiscarded).toBe(true);
  expect(api.mutate).toHaveBeenCalledTimes(1);
});

test("held save, file deleted while the tab is open and offline: back online it is not sent; the work is offered", async () => {
  const present = new Set(["flow"]),
    api = fixture(present);
  const { result, rerender } = renderHook(
    ({ on }: { on: boolean }) => useAuthoring("journeys", { target: flow, draftId }, api, undefined, on),
    { initialProps: { on: false } },
  );
  await waitFor(() => expect(result.current.data?.opened).toBeTruthy());
  act(() => result.current.updateSource("flowchart LR\n a[Mine]\n"));
  act(() => result.current.apply(""));
  await waitFor(() => expect(result.current.held).toBe(true));
  present.delete("flow");
  rerender({ on: true });
  await waitFor(() => expect(result.current.missing).not.toBeNull());
  expect(api.mutate).not.toHaveBeenCalled();
});

test("renamed: opening the diagram at its new path offers the work made on the old one, from the same bytes", async () => {
  const present = new Set(["flow"]),
    api = fixture(present);
  const oldKey = await leaveWork(api, { held: false });
  present.delete("flow");
  present.add("flow-renamed");
  const renamed = { kind: "view" as const, viewId: "flow-renamed" };
  const { result } = renderHook(() =>
    useAuthoring("journeys", { target: renamed, draftId: null }, api, undefined, true),
  );
  await waitFor(() => expect(result.current.moved).not.toBeNull());
  expect(result.current.moved).toMatchObject({ fromPath: "diagrams/flow.mmd" });
  act(() => result.current.takeMoved());
  expect(result.current.data?.source).toBe("flowchart LR\n a[Mine]\n");
  expect(result.current.dirty).toBe(true);
  expect(result.current.data?.opened?.target).toEqual(renamed);
  expect(localStorage.getItem(oldKey)).toBeNull();
  expect(api.mutate).not.toHaveBeenCalled();
});

test("the editor shows the text with Copy, Save as a new diagram here, Save as a proposal and Discard", async () => {
  const present = new Set(["flow"]),
    api = fixture(present);
  await leaveWork(api, { held: true });
  present.delete("flow");
  window.history.replaceState(null, "", `/projects/journeys/edit/?viewId=flow&draftId=${draftId}`);
  render(<AuthoringWorkspace projectSlug="journeys" api={api} />);
  expect(await screen.findByRole("heading", { name: "This Diagram’s File Is Gone" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    /diagrams\/flow\.mmd was deleted, renamed or moved.*was not sent, so nothing was written/,
  );
  expect((screen.getByLabelText("Your Mermaid") as HTMLTextAreaElement).value).toBe("flowchart LR\n a[Mine]\n");
  for (const name of ["Save as a new diagram here", "Save as a proposal", "Copy my Mermaid", "Discard"])
    expect(screen.getByRole("button", { name })).toBeEnabled();
  expect(document.body.textContent).not.toMatch(/no longer exists; reload it/);
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Discard your change? It is not saved anywhere else.");
  fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(api.mutate).not.toHaveBeenCalled();
});

test("a file gone with nothing unsaved here: said plainly, with a way back, not the service's errno text", async () => {
  const api = fixture(new Set());
  window.history.replaceState(null, "", `/projects/journeys/edit/?viewId=flow&draftId=${draftId}`);
  render(<AuthoringWorkspace projectSlug="journeys" api={api} />);
  expect(await screen.findByRole("heading", { name: "This Diagram’s File Is Gone" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("You have no unsaved changes to it in this browser.");
  expect(screen.getByRole("link", { name: "Go to the project" })).toHaveAttribute(
    "href",
    expect.stringContaining("/projects/journeys/"),
  );
  expect(document.body.textContent).not.toMatch(/reload it/);
});

// codex-302 (O116): after Save as a new diagram here, the page lands on the saved diagram, at an address that names it.
for (const held of [false, true])
  test(`in place (${held ? "held save" : "unsaved"}): Save as a new diagram here leaves editing onto the saved diagram, its address naming it`, async () => {
    const present = new Set(["flow"]),
      api = fixture(present);
    await leaveWork(api, { held });
    present.delete("flow");
    // The old file had a layout: saving none over it is refused (expected revision null), as the service does.
    vi.mocked(api.presentation).mockImplementation(async (request: { op: string }) => {
      if (request.op === "save") throw new AuthoringRefusal("presentation revision conflict", "revision_conflict", 409);
      return { presentation: null };
    });
    window.history.replaceState(null, "", `/projects/journeys/-/view/flow?edit&draftId=${draftId}`);
    const onSaved = vi.fn();
    render(
      <AuthoringWorkspace projectSlug="journeys" api={api} inPlace={{ target: flow, onSaved, onExit: () => {} }} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save as a new diagram here" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(location.pathname).toBe("/projects/journeys/-/view/flow");
    const q = new URLSearchParams(location.search);
    expect(q.has("edit")).toBe(true);
    expect(q.get("draftId")).toBe(draftId);
    expect(document.body.textContent).not.toMatch(/canonical checkpoint requires a diagram target/);
    expect(document.body.textContent).not.toMatch(/layout not saved/);
  });

test("standalone: Save as a new diagram here leaves an address that names the saved diagram, which reopens", async () => {
  const present = new Set(["flow"]),
    api = fixture(present);
  await leaveWork(api, { held: false });
  present.delete("flow");
  window.history.replaceState(null, "", `/projects/journeys/-/edit/?viewId=flow&draftId=${draftId}`);
  render(<AuthoringWorkspace projectSlug="journeys" api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save as a new diagram here" }));
  await waitFor(() => expect(new URLSearchParams(location.search).get("checkpoint")).toBe("document"));
  const { editorAddress } = await import("../src/authoring/address");
  expect(editorAddress(location.search)).toMatchObject({ target: flow, draftId, checkpoint: "document" });
});

test.each([
  ["changed by someone else meanwhile", true],
  ["unchanged", false],
] as const)("restored unsaved work over a file %s: said at once, before Save (claude-306)", async (_label, changed) => {
  const api = fixture();
  await leaveWork(api, { held: false });
  const NEW = "sha256:" + "7".repeat(64);
  if (changed)
    vi.mocked(api.open).mockImplementation(async (t: AuthoringTarget) => ({
      ...opened(t),
      source: "flowchart LR\n a[Agent]\n",
      sourceRevision: NEW,
    }));
  const { result } = renderHook(() => useAuthoring("journeys", { target: flow, draftId }, api, undefined, true));
  await waitFor(() => expect(result.current.data?.source).toBe("flowchart LR\n a[Mine]\n"));
  expect(result.current.changedSinceKept).toBe(changed);
  expect(api.mutate).not.toHaveBeenCalled();
});

// claude-403 (O131): a NEW tab on a deleted file's edit address, while a closed tab's unsaved change or held offline
// save is kept in this browser. It said "You have no unsaved changes to it in this browser". The closed tab's work is
// offered; Resume takes it (the adoption rule) and the missing-file screen then shows its text with the ways on.
for (const held of [false, true])
  for (const withDraft of [false, true])
    test(`a new tab on a deleted file (${held ? "held save" : "unsaved"}, ${withDraft ? "full draft address" : "plain edit address"}): the closed tab's work is offered, and Resume shows it`, async () => {
      const present = new Set(["flow"]),
        api = fixture(present);
      setTabIdForTests("aaaaaaaaaaaaaaaa");
      const key = await leaveWork(api, { held });
      present.delete("flow");
      setTabIdForTests("bbbbbbbbbbbbbbbb");
      window.history.replaceState(
        null,
        "",
        `/projects/journeys/-/edit/?viewId=flow${withDraft ? `&draftId=${draftId}` : ""}`,
      );
      render(<AuthoringWorkspace projectSlug="journeys" api={api} />);
      expect(await screen.findByRole("heading", { name: "This Diagram’s File Is Gone" })).toBeVisible();
      expect(screen.getByRole("status")).not.toHaveTextContent("You have no unsaved changes");
      expect(screen.getByRole("status")).toHaveTextContent(/from another tab, now closed/);
      // claude-603: a held save is named as one, on either address.
      expect(screen.getByRole("status")).toHaveTextContent(
        held
          ? /A save of it from another tab, now closed, is held in this browser, not sent yet/
          : /Your unsaved changes to it from another tab, now closed/,
      );
      fireEvent.click(screen.getByRole("button", { name: "Resume them" }));
      await waitFor(() =>
        expect((screen.getByLabelText("Your Mermaid") as HTMLTextAreaElement).value).toBe("flowchart LR\n a[Mine]\n"),
      );
      expect(readRecovery(localStorage, key)?.owner).toBe("bbbbbbbbbbbbbbbb");
      expect(api.mutate).not.toHaveBeenCalled();
    });

// claude-409 (O135): the file comes back while the missing-file screen is up: the screen goes, and the editor opens on
// it (the person's kept work, if any, restored as theirs; nothing written).
for (const work of [false, true])
  test(`the file comes back while "File Is Gone" is shown (${work ? "with unsaved work" : "nothing unsaved"}): the editor reopens on it`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const present = new Set(["flow"]),
        api = fixture(present);
      if (work) await leaveWork(api, { held: false });
      present.delete("flow");
      window.history.replaceState(null, "", `/projects/journeys/-/edit/?viewId=flow&draftId=${draftId}`);
      render(<AuthoringWorkspace projectSlug="journeys" api={api} />);
      expect(await screen.findByRole("heading", { name: "This Diagram’s File Is Gone" })).toBeVisible();
      present.add("flow");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_500);
      });
      await waitFor(() => expect(screen.queryByRole("heading", { name: "This Diagram’s File Is Gone" })).toBeNull());
      expect(api.mutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
