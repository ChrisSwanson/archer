// @vitest-environment jsdom
// Round 1 (UI/UX) fixes, pass 4, batch F12: the editor. Each test names its row in the fourth fixes list and the
// checkpoint it answers (docs/quality/rubrics/ui-ux-v1.1-lists.md). The node drag (row 4) needs a real pointer: see
// browser-ts/round1-f12.e2e.ts.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AuthoringWorkspace, EDITOR_ENTRY_SELECTOR } from "../src/authoring/AuthoringWorkspace";
import type { AuthoringClient } from "../src/authoring/client";
import { envelopeFor } from "./fixtures";
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
  heldSourceOperations: [],
};
type Node = { id: string; label: string };
type Edge = { id: string; source: string; target: string };
const modelOf = (nodes: readonly Node[], edges: readonly Edge[]) =>
  envelopeFor(
    {
      type: "freeform-graph",
      direction: "lr",
      nodes: nodes.map((n) => ({ ...n, shape: "rectangle" })),
      edges,
      groups: [],
    },
    "x",
  );
const sourceOf = (nodes: readonly Node[], edges: readonly Edge[]) =>
  `flowchart LR\n${nodes.map((n) => `  ${n.id}[${n.label}]\n`).join("")}${edges.map((e) => `  ${e.source} ${e.id}@--> ${e.target}\n`).join("")}`;

/** A flowchart service whose edits really apply: Connect adds the edge, Delete takes the shape or edge away. */
function open(nodes: Node[], edges: Edge[]) {
  const known = new Map<string, { nodes: Node[]; edges: Edge[] }>();
  const remember = (n: Node[], e: Edge[]) => {
    const source = sourceOf(n, e);
    known.set(source, { nodes: n, edges: e });
    return source;
  };
  const first = remember(nodes, edges);
  const edit = vi.fn(async (source: string, change: Record<string, unknown> & { kind: string }) => {
    const now = known.get(source)!;
    let n = now.nodes,
      e = now.edges;
    if (change.kind === "connect")
      e = [...e, { id: String(change.id), source: String(change.source), target: String(change.target) }];
    else if (change.kind === "delete-node") n = n.filter((item) => item.id !== change.id);
    else if (change.kind === "delete-edge") e = e.filter((item) => item.id !== change.id);
    else return { ok: false as const, source, code: "edit_unsupported" };
    const next = remember(n, e);
    return { ok: true as const, source: next, envelope: modelOf(n, e), diagnostics: [] };
  });
  const opened: AuthoringOpen = {
    target: { kind: "view", viewId: "x" },
    targetRevision: "sha256:" + "b".repeat(64),
    path: "diagrams/x.mmd",
    authoringPath: "diagrams/x.mmd",
    blockId: null,
    source: first,
    sourceRevision: "sha256:" + "c".repeat(64),
    writable: true,
  } as AuthoringOpen;
  const api = {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    open: vi.fn(async () => opened),
    snapshot: vi.fn(),
    mutate: vi.fn(),
    operation: vi.fn(),
    preview: vi.fn(async (source: string) => {
      const at = known.get(source) ?? { nodes, edges };
      return { envelope: modelOf(at.nodes, at.edges), diagnostics: [] };
    }),
    edit: edit as never,
  } as AuthoringClient;
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  render(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  return { api, edit };
}
const ready = async () => {
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  await waitFor(() => expect(document.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 10000 });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Process/ })).toBeEnabled(), { timeout: 5000 });
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
};
const nodeEl = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);

test("row 1 (F31, F41): the editor has a named drawing to focus on entry, and App reaches it by EDITOR_ENTRY_SELECTOR", async () => {
  open(
    [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ],
    [{ id: "e1", source: "a", target: "b" }],
  );
  await ready();
  const editor = screen.getByRole("region", { name: "Diagram Editor" });
  const drawing = within(editor).getByRole("group", { name: "Drawing" });
  expect(document.querySelector(EDITOR_ENTRY_SELECTOR)).toBe(drawing);
  expect(drawing.tabIndex).toBe(-1);
  drawing.focus();
  expect(document.activeElement).toBe(drawing);
});

test("row 2 (F33, R3-02): Connect to… keeps focus on its button, still usable, and the new connection is drawn", async () => {
  const { edit } = open(
    [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
      { id: "c", label: "Gamma" },
    ],
    [],
  );
  await ready();
  await waitFor(() => expect(nodeEl("a")).not.toBeNull());
  fireEvent.click(nodeEl("a")!);
  const button = screen.getByRole("button", { name: "Connect to…" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
  await waitFor(() => expect(document.activeElement).toBe(items[0]));
  fireEvent.click(items[0]!);
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "connect", source: "a", target: "b" }),
    ),
  );
  await waitFor(() => expect(document.querySelector(".react-flow__edge")).not.toBeNull(), { timeout: 5000 });
  await waitFor(() => expect(screen.getByText(/Connected Alpha → Beta/u)).toBeTruthy());
  await act(async () => {
    await new Promise((done) => setTimeout(done, 300));
  });
  const after = screen.getByRole("button", { name: "Connect to…" });
  expect(document.activeElement).toBe(after);
  expect(after).toBeEnabled();
});

test("row 3 (F35, R3-02): Delete moves focus to the nearest remaining shape, never the page body", async () => {
  const { edit } = open(
    [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
      { id: "c", label: "Gamma" },
    ],
    [{ id: "e1", source: "a", target: "b" }],
  );
  await ready();
  await waitFor(() => expect(nodeEl("c")).not.toBeNull());
  nodeEl("c")!.focus();
  fireEvent.click(nodeEl("c")!);
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete selected" })).toBeEnabled());
  fireEvent.keyDown(nodeEl("c")!, { key: "Delete" });
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: "delete-node", id: "c" })),
  );
  await waitFor(() => expect(nodeEl("c")).toBeNull(), { timeout: 5000 });
  await waitFor(() => expect(document.activeElement?.closest(".react-flow__node")).not.toBeNull(), { timeout: 3000 });
  expect(document.activeElement).not.toBe(document.body);
  expect(["a", "b"]).toContain((document.activeElement as HTMLElement).dataset.id);
});

test("row 3 (F35): Delete selected from the editing tools also lands on a remaining shape", async () => {
  open(
    [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
      { id: "c", label: "Gamma" },
    ],
    [{ id: "e1", source: "a", target: "b" }],
  );
  await ready();
  await waitFor(() => expect(nodeEl("c")).not.toBeNull());
  fireEvent.click(nodeEl("c")!);
  const del = screen.getByRole("button", { name: "Delete selected" });
  await waitFor(() => expect(del).toBeEnabled());
  del.focus();
  fireEvent.click(del);
  await waitFor(() => expect(nodeEl("c")).toBeNull(), { timeout: 5000 });
  await waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.id).toMatch(/^[ab]$/u), {
    timeout: 3000,
  });
});
