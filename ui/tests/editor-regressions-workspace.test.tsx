// @vitest-environment jsdom
// Editor fix-round regressions driven through the whole <AuthoringWorkspace>. The fake clients and
// readiness helpers are copied from authoring-workspace.test.tsx (kept apart to avoid merge conflicts).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AuthoringWorkspace } from "../src/authoring/AuthoringWorkspace";
import type { AuthoringClient } from "../src/authoring/client";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { loadModelEnvelope } from "./fixtures";
import type { AuthoringOpen } from "../../shared/authoring-contract.mts";
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
vi.mock("../src/source-editor/lazy", () => ({ useSourceEditor: () => null, preloadSourceEditor: async () => null }));

const status = {
  authorized: true as const,
  edit: { enabled: true },
  storeId: "store_" + "a".repeat(32),
  generation: "gen_" + "b".repeat(32),
  drafts: [],
  operations: [],
  nextOffset: null,
};
const SOURCE = "flowchart LR\n  user[User]\n  web([Web App])\n  user browses@-->|uses| web\n";
const FLOW = loadModelEnvelope("flowchart", "minimal");
function client(): AuthoringClient {
  return {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    preview: vi.fn(async () => ({ envelope: FLOW, diagnostics: [] })),
    open: vi.fn(),
    snapshot: vi.fn(),
    edit: vi.fn(async (source) => ({ ok: false as const, source, code: "edit_source_mapping_ambiguous" })),
    mutate: vi.fn(),
    operation: vi.fn(),
  };
}
/** An edit service that applies everything: each edit appends a marker line. */
function applying(): AuthoringClient {
  return {
    ...client(),
    edit: vi.fn(async (source: string, change: { kind: string; id?: string }) => ({
      ok: true as const,
      source: `${source}%% ${change.kind} ${change.id ?? ""}\n`,
      envelope: FLOW,
      diagnostics: [],
    })),
  } as AuthoringClient;
}
const editorReady = async () => {
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  await waitFor(() => expect(document.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 10000 });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Process/ })).toBeEnabled(), { timeout: 5000 });
};
const panel = () => screen.getByRole("complementary", { name: "Structure and properties" });
const statusLine = () => document.querySelector(".authoring-statusline") as HTMLElement;
const sourceBox = () => {
  const toggle = screen.getByRole("button", { name: "Mermaid source" });
  if (toggle.getAttribute("aria-pressed") !== "true") fireEvent.click(toggle);
  return document.querySelector("textarea#authoring-source") as HTMLTextAreaElement;
};
const blur = () => (document.activeElement as HTMLElement | null)?.blur();
const OPENED: AuthoringOpen = {
  target: { kind: "view", viewId: "x" },
  targetRevision: "sha256:" + "b".repeat(64),
  path: "diagrams/x.mmd",
  authoringPath: "diagrams/x.mmd",
  blockId: null,
  source: SOURCE,
  sourceRevision: "sha256:" + "c".repeat(64),
  writable: true,
} as AuthoringOpen;
const inPlace = { target: { kind: "view" as const, viewId: "x" }, onSaved: () => {}, onExit: () => {} };

/*
 * A small sequence service: the source is generated from a message list and each edit really applies, so the
 * redrawn layout renumbers `msg-N` the way the real compiler does (source order).
 */
type Msg = { from: "A" | "B"; to: "A" | "B"; label: string; kind: "sync" | "reply" };
const SEQ = loadModelEnvelope("sequence", "minimal");
const envelopeOf = (msgs: readonly Msg[]) => ({
  ...SEQ,
  view: { ...SEQ.view, kind: "sequence" },
  model: { ...SEQ.model, events: msgs.map((m, i) => ({ type: "message", id: `msg-${i}`, ...m })) },
});
const sourceOf = (msgs: readonly Msg[]) =>
  "sequenceDiagram\n    participant A as Alice\n    participant B as Bob\n" +
  msgs.map((m) => `    ${m.from}${m.kind === "reply" ? "-->>" : "->>"}${m.to}: ${m.label}\n`).join("");
const idx = (id: string) => Number(id.slice("msg-".length));
async function openSequence(start: readonly Msg[]) {
  const known = new Map<string, readonly Msg[]>();
  const remember = (msgs: readonly Msg[]) => {
    const source = sourceOf(msgs);
    known.set(source, msgs);
    return source;
  };
  const first = remember(start);
  const edit = vi.fn(async (source: string, change: Record<string, unknown> & { kind: string }) => {
    const msgs = [...known.get(source)!];
    if (change.kind === "connect") {
      const after = change.after as string | null | undefined;
      const at = after === undefined ? msgs.length : after === null ? 0 : idx(after) + 1;
      msgs.splice(at, 0, {
        from: change.source as Msg["from"],
        to: change.target as Msg["to"],
        label: String(change.label ?? ""),
        kind: "sync",
      });
    } else if (change.kind === "relabel-edge") {
      const i = idx(change.id as string);
      msgs[i] = { ...msgs[i]!, label: String(change.label) };
    } else if (change.kind === "move-edge") {
      const moving = msgs[idx(change.id as string)]!;
      const before = change.before as string | null;
      const beforeMsg = before === null ? null : msgs[idx(before)]!;
      msgs.splice(msgs.indexOf(moving), 1);
      msgs.splice(beforeMsg === null ? msgs.length : msgs.indexOf(beforeMsg), 0, moving);
    } else return { ok: false as const, source, code: "edit_unsupported" };
    return { ok: true as const, source: remember(msgs), envelope: envelopeOf(msgs), diagnostics: [] };
  });
  const api = {
    ...client(),
    status: vi.fn(async () => ({ ...status, heldSourceOperations: [] })),
    open: vi.fn(async () => ({ ...OPENED, source: first })),
    preview: vi.fn(async (source: string) => ({ envelope: envelopeOf(known.get(source) ?? start), diagnostics: [] })),
    edit: edit as never,
  } as AuthoringClient;
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  render(<AuthoringWorkspace projectSlug="example" api={api} inPlace={inPlace} />);
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  await waitFor(() => expect(document.querySelector("[data-seq-id]")).not.toBeNull(), { timeout: 10000 });
  await waitFor(() => expect(document.querySelector(".archer-seq-lifeline-hit")).not.toBeNull(), { timeout: 10000 });
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  return { api, edit, known };
}
/** Drags on the canvas from A's lifeline to B's at diagram height `y` (null: just under the headers, above every message). */
function drawMessageAt(y: number | null) {
  const canvas = document.querySelector<HTMLElement>(".archer-seq-canvas")!;
  const [a, b] = ["A", "B"].map(
    (id) => document.querySelector<SVGLineElement>(`.archer-seq-lifeline-hit[data-seq-id="${id}"]`)!,
  );
  const t = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(
    document.querySelector(".archer-seq-viewport")!.getAttribute("transform")!,
  )!;
  const [tx, ty, s] = [Number(t[1]), Number(t[2]), Number(t[3])];
  const at = (x: number, yy: number) => ({ clientX: x * s + tx, clientY: yy * s + ty, pointerId: 1 });
  const ax = Number(a!.getAttribute("x1")),
    bx = Number(b!.getAttribute("x1")),
    dy = y ?? Number(a!.getAttribute("y1")) + 2;
  fireEvent.pointerDown(a!, { ...at(ax, dy), button: 0 });
  for (let step = 1; step <= 8; step++) fireEvent.pointerMove(canvas, at(ax + ((bx - ax) * step) / 8, dy));
  fireEvent.pointerUp(canvas, at(bx, dy));
}
const messageYs = (msgs: readonly Msg[]) => {
  const p = projectEnvelope(envelopeOf(msgs));
  if (!p.ok || p.type !== "sequence") throw new Error("not a sequence");
  return computeSequenceLayout(p.view).messages.map((m) => m.y);
};
const TWO: Msg[] = [
  { from: "A", to: "B", label: "Hello Bob", kind: "sync" },
  { from: "B", to: "A", label: "Hi Alice", kind: "reply" },
];

test("a message drawn ABOVE the existing ones takes the label typed for it, not the old first message (codex-arch#1)", async () => {
  const { edit, known } = await openSequence(TWO);
  drawMessageAt(null);
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "connect", source: "A", target: "B", after: null }),
    ),
  );
  // The new message is first: msg-0. Its label field opens (the old msg-0 is now msg-1).
  const field = await screen.findByRole("textbox", { name: "msg-0 message" }, { timeout: 5000 });
  fireEvent.change(field, { target: { value: "Wake up" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(edit).toHaveBeenLastCalledWith(expect.any(String), { kind: "relabel-edge", id: "msg-0", label: "Wake up" }),
  );
  const last = edit.mock.results.at(-1)!.value as Promise<{ source: string }>;
  expect(known.get((await last).source)!.map((m) => m.label)).toEqual(["Wake up", "Hello Bob", "Hi Alice"]);
});

test("a message drawn BETWEEN two messages takes the label typed for it (codex-arch#1)", async () => {
  const { edit, known } = await openSequence(TWO);
  const [y0, y1] = messageYs(TWO);
  drawMessageAt((y0! + y1!) / 2);
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: "connect", after: "msg-0" })),
  );
  const field = await screen.findByRole("textbox", { name: "msg-1 message" }, { timeout: 5000 });
  fireEvent.change(field, { target: { value: "Ping" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(edit).toHaveBeenLastCalledWith(expect.any(String), { kind: "relabel-edge", id: "msg-1", label: "Ping" }),
  );
  const last = edit.mock.results.at(-1)!.value as Promise<{ source: string }>;
  expect(known.get((await last).source)!.map((m) => m.label)).toEqual(["Hello Bob", "Ping", "Hi Alice"]);
});

test("the selection follows a moved message: Alt+↑ twice moves it up twice, not back (codex-arch#4)", async () => {
  const THREE: Msg[] = [...TWO, { from: "A", to: "B", label: "Bye", kind: "sync" }];
  const { edit, known } = await openSequence(THREE);
  fireEvent.click(within(panel()).getByRole("button", { name: "Alice → Bob: Bye" }));
  blur();
  fireEvent.keyDown(document.body, { key: "ArrowUp", altKey: true });
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith(expect.any(String), { kind: "move-edge", id: "msg-2", before: "msg-1" }),
  );
  // The redrawn layout shows the move (Bye is now msg-1) before the second press.
  await waitFor(() => expect(document.querySelector('[data-seq-id="msg-1"]')?.textContent).toContain("Bye"));
  blur();
  fireEvent.keyDown(document.body, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
  expect(edit.mock.calls[1]![1]).toEqual({ kind: "move-edge", id: "msg-1", before: "msg-0" });
  const last = edit.mock.results.at(-1)!.value as Promise<{ source: string }>;
  expect(known.get((await last).source)!.map((m) => m.label)).toEqual(["Bye", "Hello Bob", "Hi Alice"]);
});

test("Ctrl+Z and Ctrl+Y undo and redo with focus on the page body (smoke-a#1)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = applying();
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  const box = sourceBox(),
    before = box.value;
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "User → Web App" }));
  fireEvent.click(
    within(screen.getByRole("region", { name: "Selected connection" })).getByRole("button", { name: "Two-way" }),
  );
  await waitFor(() => expect(statusLine()).toHaveTextContent("two-way"));
  const after = sourceBox().value;
  expect(after).not.toBe(before);
  blur();
  expect(document.activeElement).toBe(document.body);
  expect(fireEvent.keyDown(document.body, { key: "z", ctrlKey: true })).toBe(false);
  await waitFor(() => expect(sourceBox().value).toBe(before));
  blur();
  expect(fireEvent.keyDown(document.body, { key: "y", ctrlKey: true })).toBe(false);
  await waitFor(() => expect(sourceBox().value).toBe(after));
  blur();
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  await waitFor(() => expect(sourceBox().value).toBe(before));
  blur();
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(sourceBox().value).toBe(after));
});

test("closing or reloading the tab is guarded only while there are unsaved changes (smoke-c#2)", async () => {
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  const api = {
    ...applying(),
    status: vi.fn(async () => ({ ...status, heldSourceOperations: [] })),
    open: vi.fn(async () => OPENED),
  } as AuthoringClient;
  render(<AuthoringWorkspace projectSlug="example" api={api} inPlace={inPlace} />);
  await editorReady();
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(unload()).toBe(false);
  fireEvent.change(sourceBox(), { target: { value: SOURCE + "  extra[Extra]\n" } });
  await waitFor(() => expect(unload()).toBe(true));
});

test("Cancel then Discard leaves without the browser asking again", async () => {
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  const api = {
    ...applying(),
    status: vi.fn(async () => ({ ...status, heldSourceOperations: [] })),
    open: vi.fn(async () => OPENED),
  } as AuthoringClient;
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  // The leave (here onExit; for a new diagram, location.assign) runs before React re-renders the editor clean.
  let promptedOnLeave: boolean | null = null;
  // jsdom has no modal dialogs: open and close by the attribute.
  const proto = HTMLDialogElement.prototype as { showModal?: () => void; close?: () => void };
  const { showModal, close } = proto;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  try {
    render(
      <AuthoringWorkspace
        projectSlug="example"
        api={api}
        inPlace={{
          ...inPlace,
          onExit: () => {
            promptedOnLeave = unload();
          },
        }}
      />,
    );
    await editorReady();
    fireEvent.change(sourceBox(), { target: { value: SOURCE + "  extra[Extra]\n" } });
    await waitFor(() => expect(unload()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "Discard your changes?" })).getByRole("button", {
        name: "Discard",
      }),
    );
    expect(promptedOnLeave).toBe(false);
  } finally {
    proto.showModal = showModal;
    proto.close = close;
  }
});

test("Connect to… menu: arrow keys move between items, Escape closes it and gives focus back to the button (smoke-a#9)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  render(<AuthoringWorkspace projectSlug="example" api={applying()} />);
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "User" }));
  const button = screen.getByRole("button", { name: "Connect to…" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  const menu = screen.getByRole("menu"),
    items = within(menu).getAllByRole("menuitem");
  expect(items.length).toBeGreaterThan(1);
  await waitFor(() => expect(document.activeElement).toBe(items[0]));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[1]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(items.at(-1));
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Connect to…" })));
  // Escape closed only the menu: the shape is still selected.
  expect(screen.getByRole("button", { name: "Delete selected" })).toBeEnabled();
  await act(async () => {});
});
