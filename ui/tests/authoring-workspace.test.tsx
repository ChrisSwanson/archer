// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AuthoringWorkspace } from "../src/authoring/AuthoringWorkspace";
import { AuthoringRefusal, type AuthoringClient } from "../src/authoring/client";
import { loadModelEnvelope } from "./fixtures";
import type { AuthoringOpen, AuthoringReceipt } from "../../shared/authoring-contract.mts";
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
// The drawer's plain text area stands in for the CodeMirror editor here (tests/authoring-source-editor.test.tsx mounts the real one).
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
function client(authorized = true, editCode = "edit_source_mapping_ambiguous"): AuthoringClient {
  return {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => (authorized ? status : { authorized: false as const })),
    preview: vi.fn(async () => ({ envelope: loadModelEnvelope("flowchart", "minimal"), diagnostics: [] })),
    open: vi.fn(),
    snapshot: vi.fn(),
    edit: vi.fn(async (source) => ({ ok: false as const, source, code: editCode })),
    mutate: vi.fn(),
    operation: vi.fn(),
  };
}
// Ready: the preview compiled (a structured type shows Delete selected) and the parts are enabled.
const editorReady = async () => {
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  await waitFor(() => expect(document.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 10000 });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Process/ })).toBeEnabled(), { timeout: 5000 });
};
const panel = () => screen.getByRole("complementary", { name: "Structure and properties" });

test("editing turned off in archer.toml offers no editing controls and says where (ADR 0028)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = client();
  api.status = vi.fn(async () => ({ ...status, edit: { enabled: false, reason: "project" as const } }));
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  expect(
    (await screen.findAllByText(/Editing is off for this project \(edit = false in archer.toml\)/))[0],
  ).toBeVisible();
  for (const button of screen.queryAllByRole("button", { name: /^(Save|Publish|Apply)$/ }))
    expect(button).toBeDisabled();
  expect(api.mutate).not.toHaveBeenCalled();
});
test("a reader link offers no editing controls and says why", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  render(<AuthoringWorkspace projectSlug="example" api={client(false)} />);
  expect(await screen.findByText(/Editing is unavailable on this access link/)).toBeVisible();
  expect(screen.queryByRole("button", { name: /^(Save|Publish|Apply)$/ })).toBeNull();
});

test("the structure panel renames through the lossless engine; a refusal is said in words, never as its raw code", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = client();
  const mounted = render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  expect(within(panel()).getByRole("heading", { name: "Structure" })).toBeVisible();
  fireEvent.click(within(panel()).getByRole("button", { name: "Edit Web App label" }));
  const input = within(panel()).getByRole("textbox", { name: "Web App label" });
  fireEvent.change(input, { target: { value: "Browser App" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith(expect.any(String), {
      kind: "relabel-node",
      id: "web",
      label: "Browser App",
    }),
  );
  const alert = await screen.findByRole("alert");
  // The code stays behind the Details disclosure, out of the sentence.
  expect(alert.querySelector("span")?.textContent).not.toContain("edit_source_mapping_ambiguous");
  expect(await within(alert).findByText("Details")).toBeInTheDocument();
  expect(alert.closest(".authoring-preview")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  fireEvent.click(within(panel()).getByText("Draft and proposal tools"));
  expect(within(panel()).getByRole("button", { name: "Save draft privately" })).toBeVisible();
  expect(mounted.container.querySelector(".inspector")).toBeNull();
});

test("Delete works with focus anywhere on the page; a connected shape offers to delete its connections, then deletes them and it", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = client(true, "edit_delete_referenced_node");
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "Web App" }));
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.keyDown(document.body, { key: "Delete" });
  // Known before asking the service: the shape still has connections.
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("“Web App” still has 2 connections");
  expect(api.edit).not.toHaveBeenCalled();
  fireEvent.click(await within(alert).findByRole("button", { name: "Delete it and its connections" }));
  await waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith(expect.any(String), { kind: "delete-edge", id: "browses" }),
  );
});

test("Escape clears the selection; the Structure panel toggles without hiding the parts", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  render(<AuthoringWorkspace projectSlug="example" api={client()} />);
  await editorReady();
  const toggle = screen.getByRole("button", { name: "Structure and properties" });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(document.querySelector(".authoring-body")).not.toHaveClass("authoring-panel-collapsed");
  fireEvent.click(within(panel()).getByRole("button", { name: "Web App" }));
  expect(screen.getByRole("button", { name: "Delete selected" })).toBeEnabled();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Delete selected" })).toBeDisabled();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(document.querySelector(".authoring-body")).toHaveClass("authoring-panel-collapsed");
  expect(screen.getByRole("button", { name: /^Process/ })).toBeVisible();
});

test("a structured type opens canvas-only; Source is a labelled toggle on the drawing, not in the page bar", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  render(<AuthoringWorkspace projectSlug="example" api={client()} />);
  await editorReady();
  expect(document.querySelector("textarea#authoring-source")).toBeNull();
  const source = screen.getByRole("button", { name: "Mermaid source" });
  expect(source).toHaveTextContent("Source");
  expect(source).toBeEnabled();
  expect(source.closest(".authoring-preview")).not.toBeNull();
  expect(source.closest(".authoring-toolbar")).toBeNull();
  expect(document.querySelector(".authoring-toolbar .authoring-editing-tag")).toBeNull();
  fireEvent.click(source);
  expect(document.querySelector("textarea#authoring-source")).not.toBeNull();
});

// In-place editing of an existing diagram.
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
const applied = (operationId: string): AuthoringReceipt =>
  ({
    operationId,
    state: "terminal",
    outcome: "applied",
    document: {
      path: "diagrams/x.mmd",
      target: { kind: "view", viewId: "x" },
      targetRevision: "sha256:" + "d".repeat(64),
      sourceRevision: "sha256:" + "e".repeat(64),
      modelRevision: null,
    },
  }) as unknown as AuthoringReceipt;
function inPlaceClient(extra: Partial<AuthoringClient> = {}, held: AuthoringReceipt[] = []): AuthoringClient {
  const api = client();
  return {
    ...api,
    status: vi.fn(async () => ({ ...status, heldSourceOperations: held })),
    open: vi.fn(async () => OPENED),
    ...extra,
  };
}

test("a clean editor takes an outside change in place and says so (ADR 0028)", async () => {
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  const { resetFileUpdates, subscribeFileUpdates } = await import("../src/app/file-updates");
  resetFileUpdates();
  const seen: unknown[] = [];
  subscribeFileUpdates((state) => seen.push(state));
  const NEWER = SOURCE.replace("[User]", "[Agent user]");
  const open = vi
    .fn(async () => OPENED)
    .mockResolvedValueOnce(OPENED)
    .mockResolvedValue({ ...OPENED, source: NEWER, sourceRevision: "sha256:" + "9".repeat(64) });
  const api = inPlaceClient({ open: open as never });
  const view = render(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      externalRevision={"rev-1"}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await editorReady();
  view.rerender(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      externalRevision={"rev-2"}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await waitFor(() => expect(seen.at(-1)).toMatchObject({ text: "x.mmd updated" }));
  expect(seen.at(-1)).not.toHaveProperty("persistent");
  expect(screen.queryByText(/The original changed outside the editor/)).toBeNull();
});

test("an editor with unsaved work offers a choice that stays until made (ADR 0028)", async () => {
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  const { resetFileUpdates, subscribeFileUpdates } = await import("../src/app/file-updates");
  resetFileUpdates();
  const seen: {
    text?: string;
    persistent?: boolean;
    actions?: readonly { label: string; run: () => boolean | void }[];
  }[] = [];
  subscribeFileUpdates((state) => {
    if (state) seen.push(state);
  });
  const api = inPlaceClient();
  const view = render(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      externalRevision={"rev-1"}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Mermaid source" }));
  const source = await waitFor(() => {
    const box = document.querySelector<HTMLTextAreaElement>(".authoring-source textarea");
    if (!box) throw new Error("no source box");
    return box;
  });
  fireEvent.change(source, { target: { value: SOURCE + "  extra[Extra]\n" } });
  view.rerender(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      externalRevision={"rev-2"}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await waitFor(() =>
    expect(seen.at(-1)).toMatchObject({ text: "x.mmd updated. You have unsaved changes.", persistent: true }),
  );
  expect(seen.at(-1)!.actions!.map((a) => a.label)).toEqual(["Load the new version", "Keep mine"]);
  expect(await screen.findByText(/The original changed outside the editor/)).toBeInTheDocument();
  // claude-310: one change is said once in the editor (the banner with its ways out) beside the ADR 0028 choice, not
  // again in a toast under the drawing.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.getAllByText(/changed outside the editor/)).toHaveLength(1);
  // Cancelling the confirmation keeps the choice; nothing is lost.
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  expect(seen.at(-1)!.actions![0]!.run()).toBe(false);
  confirm.mockRestore();
  expect(source.value).toContain("extra[Extra]");
});

test("the standalone editor learns of outside changes from the files event, and of a removal (ADR 0028)", async () => {
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  const { resetFileUpdates, subscribeFileUpdates, announceFiles, COALESCE_MS } = await import(
    "../src/app/file-updates"
  );
  resetFileUpdates();
  const seen: { text?: string; persistent?: boolean }[] = [];
  subscribeFileUpdates((state) => {
    if (state) seen.push(state);
  });
  const NEWER = SOURCE.replace("[User]", "[Agent user]");
  const open = vi
    .fn(async () => OPENED)
    .mockResolvedValueOnce(OPENED)
    .mockResolvedValue({ ...OPENED, source: NEWER });
  render(
    <AuthoringWorkspace
      projectSlug="example"
      api={inPlaceClient({ open: open as never })}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await editorReady();
  act(() => {
    announceFiles({
      changed: [{ path: "diagrams/x.mmd", kind: "diagram", revision: "sha256:" + "9".repeat(64) }],
      added: [],
      removed: [],
    });
  });
  await waitFor(() => expect(seen.at(-1)).toMatchObject({ text: "x.mmd updated" }), { timeout: COALESCE_MS + 2000 });
  expect(open).toHaveBeenCalledTimes(2);
  act(() => {
    announceFiles({ changed: [], added: [], removed: [{ path: "diagrams/x.mmd", kind: "diagram" }] });
  });
  await waitFor(
    () => expect(seen.at(-1)).toMatchObject({ text: expect.stringContaining("x.mmd was removed"), persistent: true }),
    { timeout: COALESCE_MS + 2000 },
  );
});

test("reopening a diagram whose last Save is a held receipt stays in the editor (codex #2)", async () => {
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  const held = {
    ...applied("f".repeat(32)),
    review: { state: "tracked_held" },
    subject: { path: "diagrams/x.mmd" },
  } as unknown as AuthoringReceipt;
  const onSaved = vi.fn(),
    onExit = vi.fn();
  render(
    <AuthoringWorkspace
      projectSlug="example"
      api={inPlaceClient({}, [held])}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved, onExit }}
    />,
  );
  await editorReady();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Diagram Editor" })).toBeInTheDocument();
});

test("Save leaves editing only after the layout is saved; a failed layout keeps the editor with a way back (codex #7)", async () => {
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  const onSaved = vi.fn();
  const mutate = vi.fn(async (request: { operationId: string }) => applied(request.operationId));
  const presentation = vi.fn(async (request: { op: string }) => {
    if (request.op === "save") throw new Error("conflict");
    return { presentation: null };
  });
  render(
    <AuthoringWorkspace
      projectSlug="example"
      api={inPlaceClient({ mutate: mutate as never, presentation: presentation as never })}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved, onExit: () => {} }}
    />,
  );
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mutate).toHaveBeenCalled());
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("layout not saved");
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.click(await within(alert).findByRole("button", { name: "Back to reading" }));
  expect(onSaved).toHaveBeenCalledTimes(1);
});

test.each([
  ["landed", true],
  ["did not land", false],
] as const)("a layout save whose answer was lost is read back: %s (write sweep)", async (_label, landed) => {
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  const onSaved = vi.fn();
  const mutate = vi.fn(async (request: { operationId: string }) => applied(request.operationId));
  let stored: { revision: string; sourceRevision: string; positions: Record<string, unknown> } | null = null;
  const presentation = vi.fn(
    async (request: { op: string; positions?: Record<string, unknown>; sourceRevision?: string }) => {
      if (request.op === "save") {
        if (landed)
          stored = {
            revision: "sha256:" + "1".repeat(64),
            sourceRevision: request.sourceRevision!,
            positions: request.positions ?? {},
          };
        throw new TypeError("Failed to fetch");
      }
      return { presentation: stored };
    },
  );
  render(
    <AuthoringWorkspace
      projectSlug="example"
      api={inPlaceClient({ mutate: mutate as never, presentation: presentation as never })}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved, onExit: () => {} }}
    />,
  );
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mutate).toHaveBeenCalled());
  if (landed) {
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByText(/layout not saved/)).toBeNull();
  } else expect(await screen.findByRole("alert")).toHaveTextContent("layout not saved");
  expect(presentation.mock.calls.filter(([r]) => r.op === "save")).toHaveLength(1);
});

test("a still-true error stays through canvas clicks; Dismiss hides that message, and an interaction notice over it gives way back to it (G8)", async () => {
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  const mutate = vi.fn(async (request: { operationId: string }) => applied(request.operationId));
  const presentation = vi.fn(async (request: { op: string }) => {
    if (request.op === "save") throw new Error("conflict");
    return { presentation: null };
  });
  const { container } = render(
    <AuthoringWorkspace
      projectSlug="example"
      api={inPlaceClient({ mutate: mutate as never, presentation: presentation as never })}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("layout not saved");
  // A canvas click lets go of passing notices, never of an error that is still true.
  fireEvent.click(container.querySelector<HTMLElement>(".react-flow__node")!);
  expect(screen.getByRole("alert")).toHaveTextContent("layout not saved");
  // A passing notice replaces it while it is newest; letting go of that shows the still-true error again.
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "Web App" }));
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.keyDown(document.body, { key: "Delete" });
  const shown = () => container.querySelector(".authoring-feedback")?.textContent ?? "";
  await waitFor(() => expect(shown()).toContain("still has"));
  fireEvent.click(container.querySelector<HTMLElement>(".react-flow__node")!);
  await waitFor(() => expect(shown()).toContain("layout not saved"));
  // Dismiss hides that exact message.
  fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
  expect(container.querySelector(".authoring-feedback")).toBeNull();
});

test("a dismissed error stays hidden only while it is that message: the same refusal again, or a different one, shows; a source that clears removes it (G8)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const codes = ["edit_source_mapping_ambiguous", "edit_source_mapping_ambiguous", "edit_delete_last_element"];
  const api = {
    ...client(),
    edit: vi.fn(async (source: string) => {
      const code = codes.shift();
      return code
        ? { ok: false as const, source, code }
        : { ok: true as const, source: `${source}%% renamed\n`, envelope: FLOW, diagnostics: [] };
    }),
  } as AuthoringClient;
  const { container } = render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  const rename = async (label: string) => {
    fireEvent.click(within(panel()).getByRole("button", { name: "Edit Web App label" }));
    const input = within(panel()).getByRole("textbox", { name: "Web App label" });
    fireEvent.change(input, { target: { value: label } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(within(panel()).queryByRole("textbox", { name: "Web App label" })).toBeNull());
  };
  const shown = () => container.querySelector(".authoring-feedback span")?.textContent ?? null;
  await rename("One");
  await waitFor(() => expect(shown()).not.toBeNull());
  const first = shown();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
  expect(shown()).toBeNull();
  // The same refusal said again is a new message: it shows, though its words are the ones dismissed.
  await rename("Two");
  await waitFor(() => expect(shown()).toBe(first));
  await rename("Three");
  await waitFor(() => expect(shown()).not.toBe(first));
  expect(shown()).not.toBeNull();
  // The next edit succeeds: the refusal is no longer true, so nothing is shown.
  await rename("Four");
  await waitFor(() => expect(api.edit).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(shown()).toBeNull());
});

test("a Save-as refusal names the path, clears the unresolved state, and editing the path enables Save again (smoke-c High 1)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const mutate = vi.fn(async () => {
    throw new AuthoringRefusal("Archer creates new files only in diagrams/ or notes/", "create_not_allowed", 403);
  });
  const api = { ...client(), mutate: mutate as never };
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  const path = screen.getByLabelText("Save as", { exact: true });
  fireEvent.change(path, { target: { value: "diagrams/sub/x.mmd" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("A new diagram can be at most 8 folders below diagrams/");
  expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
  fireEvent.change(path, { target: { value: "diagrams/x y.mmd" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.change(path, { target: { value: "diagrams/fresh.mmd" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

// Sweep after O207: Save of a new diagram took Name and Save as at the click, and the row went away once it was
// created, so words typed into them while the write waited were dropped without a word. They wait with it now.
test("Name and Save as take no typing while a new diagram's Save waits, and take it again once it is refused", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  let refuse!: () => void;
  const held = new Promise<void>((done) => {
    refuse = done;
  });
  const mutate = vi.fn(async () => {
    await held;
    throw new AuthoringRefusal("Archer creates new files only in diagrams/ or notes/", "create_not_allowed", 403);
  });
  render(<AuthoringWorkspace projectSlug="example" api={{ ...client(), mutate: mutate as never }} />);
  await editorReady();
  const name = screen.getByLabelText("Name", { exact: true }),
    path = screen.getByLabelText("Save as", { exact: true });
  fireEvent.change(path, { target: { value: "diagrams/sub/x.mmd" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mutate).toHaveBeenCalled());
  expect(name).toHaveAttribute("readonly");
  expect(path).toHaveAttribute("readonly");
  await act(async () => {
    refuse();
    await held;
  });
  await screen.findByRole("alert");
  expect(name).not.toHaveAttribute("readonly");
  expect(path).not.toHaveAttribute("readonly");
});

// --- Fix round 2 (batch W) ---
const FLOW = loadModelEnvelope("flowchart", "minimal");
/** An edit service that applies everything: each edit appends a marker line, so the chained sources can be read back. */
function applying(
  extra: (
    source: string,
    change: { kind: string; id?: string },
  ) => Awaited<ReturnType<AuthoringClient["edit"]>> | null = () => null,
): AuthoringClient {
  return {
    ...client(),
    edit: vi.fn(
      async (source: string, change: { kind: string; id?: string }) =>
        extra(source, change) ?? {
          ok: true as const,
          source: `${source}%% ${change.kind} ${change.id ?? ""}\n`,
          envelope: FLOW,
          diagnostics: [],
        },
    ),
  } as AuthoringClient;
}
const sourceText = () => {
  const toggle = screen.getByRole("button", { name: "Mermaid source" });
  if (toggle.getAttribute("aria-pressed") !== "true") fireEvent.click(toggle);
  return (document.querySelector("textarea#authoring-source") as HTMLTextAreaElement).value;
};
const statusLine = () => document.querySelector(".authoring-statusline") as HTMLElement;

test("“Delete its connections” deletes them and the shape as ONE step, says so in the status line, and Undo brings all of it back (refusal-cascade, A11Y-4)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = applying();
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  const before = sourceText();
  fireEvent.click(screen.getByRole("button", { name: "Mermaid source" }));
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "Web App" }));
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.keyDown(document.body, { key: "Delete" });
  fireEvent.click(
    within(await screen.findByRole("alert")).getByRole("button", { name: "Delete it and its connections" }),
  );
  await waitFor(() => expect(statusLine()).toHaveTextContent("Deleted “Web App” and its 2 connections"));
  const calls = (api.edit as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.map((call) => call[1])).toEqual([
    { kind: "delete-edge", id: "browses" },
    { kind: "delete-edge", id: "calls" },
    { kind: "delete-node", id: "web" },
  ]);
  // Each step applies to the one before it.
  expect(calls[1]![0]).toBe(`${before}%% delete-edge browses\n`);
  expect(calls[2]![0]).toContain("%% delete-edge calls");
  expect(statusLine()).toHaveAttribute("aria-live", "polite");
  expect(sourceText()).toBe(`${before}%% delete-edge browses\n%% delete-edge calls\n%% delete-node web\n`);
  fireEvent.click(within(statusLine()).getByRole("button", { name: "Undo" }));
  expect(sourceText()).toBe(before);
  expect(statusLine()).toHaveTextContent("Undone: Deleted “Web App” and its 2 connections");
  expect(within(statusLine()).getByRole("button", { name: "Redo" })).toBeVisible();
});

test("a refusal in the middle of the cascade is shown and the source stays as it was", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = applying((source, change) =>
    change.id === "calls" ? { ok: false as const, source, code: "edit_delete_leaves_undrawn_state" } : null,
  );
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  const before = sourceText();
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "Web App" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  fireEvent.click(
    within(await screen.findByRole("alert")).getByRole("button", { name: "Delete it and its connections" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("would leave a state that appears nowhere");
  expect(api.edit).toHaveBeenCalledTimes(2);
  expect(sourceText()).toBe(before);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

test("a selected flowchart connection gets the From/To panel: reattaching an end without a drag (A11Y-3)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = applying();
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "User → Web App" }));
  const connection = screen.getByRole("region", { name: "Selected connection" });
  expect(within(connection).getByRole("combobox", { name: "From" })).toHaveValue("user");
  fireEvent.change(within(connection).getByRole("combobox", { name: "To" }), { target: { value: "api" } });
  await waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith(expect.any(String), { kind: "retarget-edge", id: "browses", target: "api" }),
  );
  // Keyboard order: the canvas, then its panels, then the editing tools (A11Y-7).
  const order = [
    document.querySelector(".authoring-preview"),
    connection,
    screen.getByRole("toolbar", { name: "Editing tools" }),
  ];
  for (let i = 1; i < order.length; i++)
    expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("Delete pressed while an edit is still running is kept and runs once it settles (monkey m043)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  let finish: () => void = () => {};
  const api = applying();
  const slow = vi.fn((source: string, change: { kind: string }) =>
    change.kind === "relabel-node"
      ? new Promise((resolve) => {
          finish = () => resolve({ ok: true, source: `${source}%% renamed\n`, envelope: FLOW, diagnostics: [] });
        })
      : (api.edit as (s: string, c: unknown) => Promise<unknown>)(source, change),
  );
  render(<AuthoringWorkspace projectSlug="example" api={{ ...api, edit: slow as never }} />);
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "Edit Web App label" }));
  const input = within(panel()).getByRole("textbox", { name: "Web App label" });
  fireEvent.change(input, { target: { value: "Browser" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(slow).toHaveBeenCalledWith(expect.any(String), { kind: "relabel-node", id: "web", label: "Browser" }),
  );
  (document.activeElement as HTMLElement | null)?.blur();
  // Taken (prevented) now, done later: the connected shape's cascade offer appears once the shape change lands.
  expect(fireEvent.keyDown(document.body, { key: "Delete" })).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => {
    finish();
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("“Web App” still has 2 connections");
});

test("a first-use hint per type says the gestures once; Got it is remembered in this browser (ux:F10)", async () => {
  const open = () => {
    window.history.replaceState(null, "", "/p/example/views/x/?edit");
    return render(
      <AuthoringWorkspace
        projectSlug="example"
        api={inPlaceClient()}
        inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
      />,
    );
  };
  const first = open();
  await editorReady();
  const hint = screen.getByRole("note");
  expect(hint).toHaveTextContent("drag from a shape’s edge to another shape to connect them");
  fireEvent.click(within(hint).getByRole("button", { name: "Got it" }));
  expect(screen.queryByRole("note")).toBeNull();
  expect(localStorage.getItem("archer.editor.hint.flowchart")).toBe("1");
  first.unmount();
  open();
  await editorReady();
  expect(screen.queryByRole("note")).toBeNull();
});

test("a new, empty diagram shows its type’s empty-canvas hint and not the first-use hint over it", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  render(<AuthoringWorkspace projectSlug="example" api={client()} />);
  await editorReady();
  expect(document.querySelector(".authoring-empty-hint")).toHaveTextContent(
    "Click a part to add it, then drag from its edge to another shape to connect them.",
  );
  expect(screen.queryByRole("note")).toBeNull();
});

test("a new diagram asks Type, then Name, then Save as; the name gives the file name until the path is edited (ux:F18)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  render(<AuthoringWorkspace projectSlug="example" api={client()} />);
  await editorReady();
  const row = document.querySelector(".authoring-new-row") as HTMLElement;
  expect([...row.querySelectorAll("label")].map((label) => label.firstChild?.textContent)).toEqual([
    "Type",
    "Name",
    "Save as",
  ]);
  fireEvent.change(within(row).getByRole("textbox", { name: "Name" }), { target: { value: "Checkout flow" } });
  const path = screen.getByLabelText("Save as", { exact: true });
  expect(path).toHaveValue("diagrams/checkout-flow.mmd");
  fireEvent.change(path, { target: { value: "diagrams/mine.mmd" } });
  fireEvent.change(within(row).getByRole("textbox", { name: "Name" }), { target: { value: "Other" } });
  expect(path).toHaveValue("diagrams/mine.mmd");
  // Parts that don't exist yet aren't offered (ux:F17).
  expect(screen.queryByRole("button", { name: /^Group/ })).toBeNull();
});

test("a new ER entity takes a readable ID from the name typed for it, in the same Undo step (smoke-b#11:b)", async () => {
  const OPENED_ER = {
    ...OPENED,
    source: "erDiagram\n    CUSTOMER\n    ORDER\n    CUSTOMER ||--o{ ORDER : places\n",
  } as AuthoringOpen;
  const er = loadModelEnvelope("er", "minimal");
  const withEntity = (id: string, label: string) => ({
    ...er,
    model: { ...er.model, entities: [...(er.model.entities as unknown[]), { id, label, attributes: [] }] },
  });
  const edit = vi.fn(async (source: string, change: { kind: string; id?: string; label?: string }) =>
    change.kind === "add-node"
      ? {
          ok: true as const,
          source: `${source}    ${change.id}["${change.label}"]\n`,
          envelope: withEntity(change.id!, change.label!),
          diagnostics: [],
        }
      : { ok: false as const, source, code: "edit_unsupported" },
  );
  const api = inPlaceClient({
    open: vi.fn(async () => OPENED_ER),
    edit: edit as never,
    preview: vi.fn(async () => ({ envelope: er, diagnostics: [] })),
  });
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  render(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  await waitFor(() => expect(document.querySelector(".react-flow__node")).not.toBeNull(), { timeout: 10000 });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Entity/ })).toBeEnabled(), { timeout: 10000 });
  fireEvent.click(screen.getByRole("button", { name: /^Entity/ }));
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith(
      OPENED_ER.source,
      expect.objectContaining({ kind: "add-node", id: "ENTITY_1", label: "Entity" }),
    ),
  );
  const field = await screen.findByRole("textbox", { name: /^ENTITY_1 (name|label)$/ }, { timeout: 10000 });
  fireEvent.change(field, { target: { value: "Order line" } });
  fireEvent.keyDown(field, { key: "Enter" });
  // Re-added from the source before the add, under the typed name: no ENTITY_1 left behind.
  await waitFor(() =>
    expect(edit).toHaveBeenLastCalledWith(
      OPENED_ER.source,
      expect.objectContaining({ kind: "add-node", id: "OrderLine", label: "Order line" }),
    ),
  );
  await waitFor(() => expect(statusLine()).toHaveTextContent("Added “Order line”"));
  expect(sourceText()).toBe(`${OPENED_ER.source}    OrderLine["Order line"]\n`);
  fireEvent.click(within(statusLine()).getByRole("button", { name: "Undo" }));
  expect(sourceText()).toBe(OPENED_ER.source);
});

test("a new state Choice, which opens no name field, takes keyboard focus once drawn: never left on the page body (G14)", async () => {
  const SOURCE_STATE =
    "stateDiagram-v2\n    state Idle\n    state Busy\n    [*] --> Idle\n    Idle --> Busy : start\n    Busy --> [*]\n";
  const state = loadModelEnvelope("state", "minimal");
  const withChoice = {
    ...state,
    model: {
      ...state.model,
      states: [...(state.model.states as unknown[]), { id: "choice1", label: "choice1", kind: "choice" }],
    },
  };
  const edit = vi.fn(async (source: string, change: { kind: string; id?: string }) =>
    change.kind === "add-node"
      ? {
          ok: true as const,
          source: `${source}    state ${change.id} <<choice>>\n`,
          envelope: withChoice,
          diagnostics: [],
        }
      : { ok: false as const, source, code: "edit_unsupported" },
  );
  const api = inPlaceClient({
    open: vi.fn(async () => ({ ...OPENED, source: SOURCE_STATE })),
    edit: edit as never,
    preview: vi.fn(async (source: string) => ({
      envelope: source.includes("choice1") ? withChoice : state,
      diagnostics: [],
    })),
  });
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  render(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="Idle"]')).not.toBeNull(), {
    timeout: 10000,
  });
  const choice = screen.getByRole("button", { name: /^Choice/ });
  await waitFor(() => expect(choice).toBeEnabled(), { timeout: 10000 });
  // The part button is disabled while the add runs, and a disabled button loses focus: the page body is where it starts.
  fireEvent.click(choice);
  (document.activeElement as HTMLElement | null)?.blur();
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith(
      SOURCE_STATE,
      expect.objectContaining({ kind: "add-node", id: "choice1", state: "choice" }),
    ),
  );
  await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="choice1"]')).not.toBeNull(), {
    timeout: 10000,
  });
  await waitFor(
    () => expect(document.activeElement).toBe(document.querySelector('.react-flow__node[data-id="choice1"]')),
    { timeout: 2000 },
  );
});

/** An in-place editor on `source`, previewed as fixture `type/name`, with `edit` as the service's edit. */
async function openFixture(
  type: string,
  name: string,
  source: string,
  edit: AuthoringClient["edit"] = applying().edit,
) {
  const loaded = loadModelEnvelope(type, name),
    envelope = type === "sequence" ? { ...loaded, view: { ...loaded.view, kind: "sequence" } } : loaded;
  const api = inPlaceClient({
    open: vi.fn(async () => ({ ...OPENED, source })),
    preview: vi.fn(async () => ({ envelope, diagnostics: [] })),
    edit: vi.fn(async (s: string, change: Parameters<AuthoringClient["edit"]>[1]) => {
      const result = await edit(s, change);
      return result.ok ? { ...result, envelope } : result;
    }),
  });
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  render(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  await waitFor(() => expect(document.querySelector(".react-flow__node, [data-seq-id]")).not.toBeNull(), {
    timeout: 10000,
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Undo" }).closest("[role=toolbar]")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  return api;
}

test("state Connect to… lists the states in the same scope, never the start or end markers; an end marker connects nowhere (smoke-b#10:c)", async () => {
  await openFixture(
    "state",
    "minimal",
    "stateDiagram-v2\n    state Idle\n    state Busy\n    [*] --> Idle\n    Idle --> Busy : start\n    Busy --> [*]\n",
  );
  fireEvent.click(within(panel()).getByRole("button", { name: "Idle" }));
  const connectTo = screen.getByRole("button", { name: "Connect to…" });
  await waitFor(() => expect(connectTo).toBeEnabled());
  fireEvent.click(connectTo);
  expect(
    within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Busy"]);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  fireEvent.click(within(panel()).getByRole("button", { name: "end" }));
  expect(connectTo).toBeDisabled();
});

test('a single connection kind is headed "Connect"; a choice of kinds keeps "Connect with (stays on)"', async () => {
  await openFixture("state", "minimal", "stateDiagram-v2\n    state Idle\n    state Busy\n    Idle --> Busy : start\n");
  expect(screen.getByRole("group", { name: "Connect" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Connect with (stays on)" })).toBeNull();
});

test("deleting a participant with messages deletes them from the last one back, then it, as one step", async () => {
  const api = await openFixture(
    "sequence",
    "minimal",
    "sequenceDiagram\n    participant A as Alice\n    participant B as Bob\n    A->>B: Hello Bob\n    B-->>A: Hi Alice\n",
  );
  fireEvent.click(within(panel()).getByRole("button", { name: "Alice" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("“Alice” still has 2 connections");
  expect(api.edit).not.toHaveBeenCalled();
  fireEvent.click(await within(alert).findByRole("button", { name: "Delete it and its connections" }));
  await waitFor(() => expect(statusLine()).toHaveTextContent("Deleted “Alice” and its 2 connections"));
  expect((api.edit as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1])).toEqual([
    { kind: "delete-edge", id: "msg-1" },
    { kind: "delete-edge", id: "msg-0" },
    { kind: "delete-node", id: "A" },
  ]);
});

test("the message position field moves once per typed value: Enter, then the blur as the field is disabled, is one move (monkey m056)", async () => {
  let finish: () => void = () => {};
  const api = await openFixture(
    "sequence",
    "minimal",
    "sequenceDiagram\n    participant A as Alice\n    participant B as Bob\n    A->>B: Hello Bob\n    B-->>A: Hi Alice\n",
    (source, change) =>
      new Promise((resolve) => {
        finish = () => resolve({ ok: false, source, code: "edit_activation_dependency" });
        void change;
      }),
  );
  fireEvent.click(within(panel()).getByRole("button", { name: "Alice → Bob: Hello Bob" }));
  const position = within(screen.getByRole("region", { name: "Selected message" })).getByRole("spinbutton", {
    name: "Position in the sequence",
  });
  position.focus();
  fireEvent.change(position, { target: { value: "2" } });
  fireEvent.keyDown(position, { key: "Enter" });
  await waitFor(() => expect(api.edit).toHaveBeenCalledTimes(1));
  fireEvent.blur(position);
  await act(async () => {
    finish();
  });
  expect(api.edit).toHaveBeenCalledTimes(1);
  // Refused: the field shows the message's real place again.
  await waitFor(() => expect(position).toHaveValue(1));
});

test("a panel choice set to what it already shows sends nothing (monkey sequence-5 m024: retarget-edge twice)", async () => {
  const api = await openFixture(
    "sequence",
    "minimal",
    "sequenceDiagram\n    participant A as Alice\n    participant B as Bob\n    A->>B: Hello Bob\n    B-->>A: Hi Alice\n",
  );
  fireEvent.click(within(panel()).getByRole("button", { name: "Alice → Bob: Hello Bob" }));
  const message = screen.getByRole("region", { name: "Selected message" });
  const from = within(message).getByRole("combobox", { name: "From" }),
    to = within(message).getByRole("combobox", { name: "To" }),
    type = within(message).getByRole("combobox", { name: "Type" });
  fireEvent.change(from, { target: { value: (from as HTMLSelectElement).value } });
  fireEvent.change(to, { target: { value: (to as HTMLSelectElement).value } });
  fireEvent.change(type, { target: { value: (type as HTMLSelectElement).value } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(api.edit).not.toHaveBeenCalled();
});

test("a selection the redrawn diagram no longer has is let go (ui.edit.stale-selection after a reattach or Undo, monkey state-4)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  // Reattaching the connection's end gives it a new id: the redrawn diagram has no `browses` any more.
  const moved = structuredClone(FLOW) as typeof FLOW & {
    model: { edges: { id: string; source: string; target: string }[] };
  };
  moved.model.edges = moved.model.edges.map((edge) =>
    edge.id === "browses" ? { ...edge, id: "user--api", target: "api" } : edge,
  );
  const api = applying((source) => ({
    ok: true,
    source: `${source}%% reattached\n`,
    envelope: moved,
    diagnostics: [],
  }));
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "User → Web App" }));
  const connection = screen.getByRole("region", { name: "Selected connection" });
  fireEvent.change(within(connection).getByRole("combobox", { name: "To" }), { target: { value: "api" } });
  await waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith(expect.any(String), { kind: "retarget-edge", id: "browses", target: "api" }),
  );
  await waitFor(() => expect(document.querySelector('.react-flow__edge[data-id="user--api"]')).not.toBeNull(), {
    timeout: 5000,
  });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Selected connection" })).toBeNull());
  expect(screen.getByRole("button", { name: "Delete selected" })).toBeDisabled();
});

test("a rename the service refuses closes the label field at once, with the refusal said (A4: not read-only for 4 s)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = client();
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  fireEvent.doubleClick(document.querySelector('.react-flow__node[data-id="web"]')!);
  const field = await screen.findByRole("textbox", { name: "web label" });
  fireEvent.change(field, { target: { value: "Browser" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith(expect.any(String), { kind: "relabel-node", id: "web", label: "Browser" }),
  );
  expect(await screen.findByRole("alert")).toBeVisible();
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "web label" })).toBeNull(), { timeout: 1000 });
});

test("Shift-click picks several shapes; Delete removes them and their connections as one step", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = applying();
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  const node = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
  fireEvent.click(node("user"));
  fireEvent.click(node("api"), { shiftKey: true });
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node.selected")).toHaveLength(2));
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.keyDown(document.body, { key: "Delete" });
  await waitFor(() => expect(statusLine()).toHaveTextContent("Deleted 2 shapes and 2 connections"));
  const steps = (api.edit as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1]);
  expect(steps).toEqual(
    expect.arrayContaining([
      { kind: "delete-edge", id: "browses" },
      { kind: "delete-edge", id: "calls" },
      { kind: "delete-node", id: "user" },
      { kind: "delete-node", id: "api" },
    ]),
  );
  expect(steps.slice(0, 2).every((step) => step.kind === "delete-edge")).toBe(true);
});

test("a flowchart connection’s Arrow control: Two-way and Reverse are one step each, said in the status line (MU)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = applying();
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "User → Web App" }));
  const arrow = within(screen.getByRole("region", { name: "Selected connection" })).getByRole("group", {
    name: "Arrow",
  });
  expect(within(arrow).getByRole("button", { name: "One-way" })).toHaveAttribute("aria-pressed", "true");
  expect(within(arrow).getByRole("button", { name: "Two-way" })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(within(arrow).getByRole("button", { name: "Two-way" }));
  await waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith(expect.any(String), {
      kind: "change-arrow",
      id: "browses",
      arrow: "two-way",
    }),
  );
  await waitFor(() => expect(statusLine()).toHaveTextContent("Made “User → Web App” two-way"));
  expect(within(statusLine()).getByRole("button", { name: "Undo" })).toBeVisible();
  fireEvent.click(
    within(screen.getByRole("region", { name: "Selected connection" })).getByRole("button", { name: "Reverse" }),
  );
  await waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith(expect.any(String), {
      kind: "change-arrow",
      id: "browses",
      arrow: "reverse",
    }),
  );
  await waitFor(() => expect(statusLine()).toHaveTextContent("Reversed “User → Web App”"));
});

const SEQ_TEXT =
  'sequenceDiagram\n    participant web as Web (EU)\n    participant quoted as "Web (EU)"\n    participant main as Web (EU) - main, v2\n    web->>quoted: GET\n    quoted-->>web: 100% complete\n    web-)main: pure\n    main->>web: POST /refresh\n';
test("a sequence message’s Arrow control: an async message can’t be two-way and says why; Reverse keeps its id (MU)", async () => {
  const api = await openFixture("sequence", "text", SEQ_TEXT);
  fireEvent.click(within(panel()).getAllByRole("button", { name: /^Web \(EU\) → Web \(EU\) - main, v2/ })[0]!);
  const message = screen.getByRole("region", { name: "Selected message" }),
    arrow = within(message).getByRole("group", { name: "Arrow" });
  const twoWay = within(arrow).getByRole("button", { name: "Two-way" });
  expect(twoWay).toBeDisabled();
  expect(twoWay).toHaveAccessibleDescription(/async message has one arrowhead/i);
  fireEvent.click(within(arrow).getByRole("button", { name: "Reverse" }));
  await waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith(expect.any(String), { kind: "change-arrow", id: "msg-2", arrow: "reverse" }),
  );
  fireEvent.click(within(panel()).getByRole("button", { name: /^Web \(EU\) → Web \(EU\): GET/ }));
  const sync = within(
    within(screen.getByRole("region", { name: "Selected message" })).getByRole("group", { name: "Arrow" }),
  ).getByRole("button", { name: "Two-way" });
  await waitFor(() => expect(sync).toBeEnabled());
  fireEvent.click(sync);
  await waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith(expect.any(String), { kind: "change-arrow", id: "msg-0", arrow: "two-way" }),
  );
});

test("pasted Mermaid without edge ids: one Add IDs action fixes every edge, says how many, and is one Undo step (MU)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const missing = (line: number) => ({
    code: "missing_edge_id",
    severity: "error",
    message: "every edge needs a stable ID",
    span: { start: { line, column: 3 }, end: { line, column: 6 } },
    fix: { operation: "add-edge-ids" },
  });
  const pasted = "flowchart LR\n a[One] --> b[Two]\n b --> c[Three]\n";
  const fixed = "flowchart LR\n a[One] a_b@--> b[Two]\n b b_c@--> c[Three]\n";
  const api = {
    ...client(),
    preview: vi.fn(async (source: string) =>
      source === pasted
        ? { envelope: null, diagnostics: [missing(2), missing(3)] }
        : { envelope: FLOW, diagnostics: [] },
    ),
    edit: vi.fn(async (source: string, change: { kind: string }) =>
      change.kind === "add-edge-ids"
        ? { ok: true as const, source: fixed, envelope: FLOW, diagnostics: [] }
        : { ok: false as const, source, code: "edit_target_missing" },
    ),
  } as AuthoringClient;
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  sourceText();
  fireEvent.change(document.querySelector("textarea#authoring-source")!, { target: { value: pasted } });
  const add = await screen.findByRole("button", { name: "Add IDs" }, { timeout: 3000 });
  expect(add.closest("[role=status],[role=alert],.authoring-fix")).toHaveTextContent("2 connections have no ID");
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  await waitFor(() => expect(api.edit).toHaveBeenCalledWith(pasted, { kind: "add-edge-ids" }));
  await waitFor(() => expect(statusLine()).toHaveTextContent("Added IDs to 2 connections"));
  expect((document.querySelector("textarea#authoring-source") as HTMLTextAreaElement).value).toBe(fixed);
  expect(screen.queryByRole("button", { name: "Add IDs" })).toBeNull();
  fireEvent.click(within(statusLine()).getByRole("button", { name: "Undo" }));
  expect((document.querySelector("textarea#authoring-source") as HTMLTextAreaElement).value).toBe(pasted);
});

test("compile warnings are neutral notes with their line, and never block Save (MU)", async () => {
  const warning = {
    code: "duplicate_edge",
    severity: "warning",
    message: "this connection repeats line 3; the repeat is ignored",
    span: { start: { line: 5, column: 1 }, end: { line: 5, column: 9 } },
  };
  const api = inPlaceClient({
    preview: vi.fn(async () => ({ envelope: FLOW, diagnostics: [warning] })),
    edit: applying().edit,
  });
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  render(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  const notes = await screen.findByRole("list", { name: "Mermaid notes" });
  expect(notes).toHaveTextContent("Line 5: this connection repeats line 3");
  expect(screen.queryByRole("list", { name: "Mermaid problems" })).toBeNull();
  expect(notes.closest("details")).not.toHaveClass("authoring-error");
  // Dirty the copy so Save has something to save: it stays enabled despite the warning.
  fireEvent.click(screen.getByRole("button", { name: "Structure and properties" }));
  fireEvent.click(within(panel()).getByRole("button", { name: "User → Web App" }));
  fireEvent.click(
    within(screen.getByRole("region", { name: "Selected connection" })).getByRole("button", { name: "Two-way" }),
  );
  await waitFor(() => expect(statusLine()).toHaveTextContent("two-way"));
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("after renaming a connection, focus comes back to that connection, not the page (smoke-a#1, label-focus)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = applying();
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  const edge = () => document.querySelector('.react-flow__edge[data-id="browses"]') as HTMLElement;
  await waitFor(() => expect(edge()).not.toBeNull());
  await waitFor(() => expect(document.querySelector('[data-edge-id="browses"]')).not.toBeNull());
  fireEvent.doubleClick(document.querySelector('[data-edge-id="browses"]')!);
  const field = await screen.findByRole("textbox", { name: "browses connection label" });
  fireEvent.change(field, { target: { value: "visits" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "relabel-edge", id: "browses" }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "browses connection label" })).toBeNull(), {
    timeout: 5000,
  });
  await waitFor(() => expect(document.activeElement).toBe(edge()), { timeout: 300 });
});

test("double-clicking the label of a transition into an end marker opens its label field (smoke-a#12:e)", async () => {
  const loaded = loadModelEnvelope("state", "minimal") as ReturnType<typeof loadModelEnvelope> & {
    model: { transitions: { id: string; label?: string }[] };
  };
  const envelope = {
    ...loaded,
    model: {
      ...loaded.model,
      transitions: loaded.model.transitions.map((t) => (t.id === "Busy--root_end" ? { ...t, label: "done" } : t)),
    },
  };
  const source =
    "stateDiagram-v2\n    state Idle\n    state Busy\n    [*] --> Idle\n    Idle --> Busy : start\n    Busy --> [*] : done\n";
  const api = inPlaceClient({
    open: vi.fn(async () => ({ ...OPENED, source })),
    preview: vi.fn(async () => ({ envelope, diagnostics: [] })),
    edit: applying().edit,
  });
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  render(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  await waitFor(() => expect(document.querySelector('[data-edge-id="Busy--root_end"]')).not.toBeNull(), {
    timeout: 10000,
  });
  fireEvent.doubleClick(document.querySelector('[data-edge-id="Busy--root_end"]')!);
  expect(await screen.findByRole("textbox", { name: "Busy--root_end connection label" })).toHaveValue("done");
});

test("pasted `a --> b`: the same one action also names the shapes the Mermaid only mentions, and says so (smoke-c#7)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const missing = {
    code: "unsupported_construct",
    severity: "error",
    message: "every edge needs a stable ID",
    span: { start: { line: 2, column: 3 }, end: { line: 2, column: 6 } },
    fix: { operation: "add-edge-ids" },
  };
  const undeclared = (id: string, column: number) => ({
    code: "undeclared_node",
    severity: "error",
    message: `node '${id}' is never given a label`,
    span: { start: { line: 2, column }, end: { line: 2, column: column + 1 } },
    fix: { operation: "add-edge-ids" },
  });
  const pasted = "flowchart LR\n a --> b\n",
    fixed = "flowchart LR\n a[a] a_b@--> b[b]\n";
  const api = {
    ...client(),
    preview: vi.fn(async (source: string) =>
      source === pasted
        ? { envelope: null, diagnostics: [missing, undeclared("a", 2), undeclared("b", 8)] }
        : { envelope: FLOW, diagnostics: [] },
    ),
    edit: vi.fn(async (source: string, change: { kind: string }) =>
      change.kind === "add-edge-ids"
        ? { ok: true as const, source: fixed, envelope: FLOW, diagnostics: [] }
        : { ok: false as const, source, code: "edit_target_missing" },
    ),
  } as AuthoringClient;
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  sourceText();
  fireEvent.change(document.querySelector("textarea#authoring-source")!, { target: { value: pasted } });
  const add = await screen.findByRole("button", { name: "Add IDs" }, { timeout: 3000 });
  expect(add.closest(".authoring-fix")).toHaveTextContent("1 connection has no ID and 2 shapes have no label.");
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  await waitFor(() => expect(statusLine()).toHaveTextContent("Added IDs to 1 connection and labels to 2 shapes"));
  expect((document.querySelector("textarea#authoring-source") as HTMLTextAreaElement).value).toBe(fixed);
});

test("the diagram key the reading page shows stays while editing, and follows the edited drawing (ux:F13:b)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  render(<AuthoringWorkspace projectSlug="example" api={applying()} />);
  await editorReady();
  const key = await screen.findByRole("region", { name: "Diagram Key" });
  expect(key.closest(".authoring-preview")).not.toBeNull();
  expect(key).toHaveTextContent("Person");
});

// O84 (claude-03): the conflict banner's proposal button saves the person's text against the version they opened, and
// the page says what happened: saved (and where), or not saved (and what still holds their text). Never the generic
// "kept as a draft you can compare" when no draft exists.
async function outsideChangeWithWork(api: AuthoringClient) {
  window.history.replaceState(null, "", "/p/example/views/x/?edit");
  const { resetFileUpdates } = await import("../src/app/file-updates");
  resetFileUpdates();
  const view = render(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      externalRevision={"rev-1"}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Mermaid source" }));
  const source = await waitFor(() => {
    const box = document.querySelector<HTMLTextAreaElement>(".authoring-source textarea");
    if (!box) throw new Error("no source box");
    return box;
  });
  fireEvent.change(source, { target: { value: SOURCE + "  extra[Extra]\n" } });
  view.rerender(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      externalRevision={"rev-2"}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await screen.findByText(/The original changed outside the editor/);
}
test("the conflict banner saves a proposal against the opened version and says where it is (O84)", async () => {
  const draftSummary = {
    draftId: "",
    draftRevision: 1,
    state: "open" as const,
    valid: true,
    sourceRevision: "sha256:" + "f".repeat(64),
    savedAt: "2026-11-02T00:00:00Z",
    origin: {
      kind: "document" as const,
      path: "diagrams/x.mmd",
      baseSourceRevision: OPENED.sourceRevision,
      diverged: true,
    },
  };
  let saved = false;
  const mutate = vi.fn(async (request: { operationId: string; draftId: string }) => {
    saved = true;
    draftSummary.draftId = request.draftId;
    return {
      operationId: request.operationId,
      state: "terminal",
      outcome: "saved",
      draft: { draftId: request.draftId, draftRevision: 1 },
      review: { mode: "manual", configRevision: "sha256:" + "1".repeat(64), state: "not_queued_manual" },
    } as unknown as AuthoringReceipt;
  });
  const api = inPlaceClient({
    mutate: mutate as never,
    status: vi.fn(async () => ({ ...status, drafts: saved ? [draftSummary] : [] })) as never,
  });
  await outsideChangeWithWork(api);
  fireEvent.click(screen.getByRole("button", { name: "Save as a proposal privately" }));
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  expect(mutate.mock.calls[0]![0]).toMatchObject({
    op: "draft.save",
    source: SOURCE + "  extra[Extra]\n",
    origin: { kind: "document", expectedSourceRevision: OPENED.sourceRevision, baseSource: SOURCE },
  });
  expect(
    await screen.findByText(
      /^Saved as a private proposal \(revision 1\), based on the version you opened\. The file has changed since and was not touched\. Find it under Draft and proposal tools\.$/,
    ),
  ).toBeInTheDocument();
  expect(screen.getByText(/based on an earlier version of the file/)).toBeInTheDocument();
  expect(screen.queryByText(/kept as a draft you can compare/)).toBeNull();
  expect(screen.queryByText("No saved drafts.")).toBeNull();
  // O155: a success is said as one, politely, in its own colours; never drawn as an error.
  const notice = document.querySelector(".authoring-feedback")!;
  expect(notice).toHaveClass("authoring-feedback-success");
  expect(notice).not.toHaveClass("authoring-error");
  expect(notice).toHaveAttribute("role", "status");
});
// O156: the conflict banner is an alert when the conflict appears (its later words: announcedOnce, below).
test("the conflict banner is an alert when the conflict first appears (O156)", async () => {
  await outsideChangeWithWork(inPlaceClient());
  expect(document.querySelector(".authoring-conflict")).toHaveAttribute("role", "alert");
});
test("a refused proposal says it was not saved and what still holds the person’s text (O84)", async () => {
  const mutate = vi.fn(async () => {
    throw new AuthoringRefusal("proposal base source changed", "revision_conflict", 409);
  });
  const api = inPlaceClient({ mutate: mutate as never });
  await outsideChangeWithWork(api);
  fireEvent.click(screen.getByRole("button", { name: "Save as a proposal privately" }));
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/proposal was not saved/i)).toBeInTheDocument();
  expect(screen.queryByText(/kept as a draft you can compare/)).toBeNull();
});
test("in place, “Reopen the current original” opens the reading page’s own ?edit address, not the legacy views address (claude-10)", async () => {
  const api = inPlaceClient();
  window.history.replaceState(null, "", "/projects/example/diagrams/x.mmd?edit");
  const { resetFileUpdates } = await import("../src/app/file-updates");
  resetFileUpdates();
  const view = render(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      externalRevision={"rev-1"}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  await editorReady();
  fireEvent.click(screen.getByRole("button", { name: "Mermaid source" }));
  const source = await waitFor(() => {
    const box = document.querySelector<HTMLTextAreaElement>(".authoring-source textarea");
    if (!box) throw new Error("no source box");
    return box;
  });
  fireEvent.change(source, { target: { value: SOURCE + "  extra[Extra]\n" } });
  view.rerender(
    <AuthoringWorkspace
      projectSlug="example"
      api={api}
      externalRevision={"rev-2"}
      inPlace={{ target: { kind: "view", viewId: "x" }, onSaved: () => {}, onExit: () => {} }}
    />,
  );
  const link = await screen.findByRole("link", { name: "Reopen the current original" });
  expect(link.getAttribute("href")).toBe("/projects/example/diagrams/x.mmd?edit");
});

test("a new diagram keeps its Name and Save as with its draft: a reload and a new tab of the same address give them back (G1, O112)", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  const api = client();
  const first = render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  const row = () => document.querySelector(".authoring-new-row") as HTMLElement;
  fireEvent.change(within(row()).getByRole("textbox", { name: "Name" }), { target: { value: "Checkout flow" } });
  fireEvent.change(screen.getByLabelText("Save as", { exact: true }), { target: { value: "diagrams/mine.mmd" } });
  const address = window.location.pathname + window.location.search;
  expect(address).toMatch(/draftId=drf_/);
  first.unmount();
  // A new tab of the same address: this tab's session storage is not there.
  sessionStorage.clear();
  window.history.replaceState(null, "", address);
  render(<AuthoringWorkspace projectSlug="example" api={api} />);
  await editorReady();
  await waitFor(() => expect(screen.getByLabelText("Save as", { exact: true })).toHaveValue("diagrams/mine.mmd"));
  expect(within(row()).getByRole("textbox", { name: "Name" })).toHaveValue("Checkout flow");
  // Edited by hand, the path stays the person's when the name changes again.
  fireEvent.change(within(row()).getByRole("textbox", { name: "Name" }), { target: { value: "Other" } });
  expect(screen.getByLabelText("Save as", { exact: true })).toHaveValue("diagrams/mine.mmd");
});
